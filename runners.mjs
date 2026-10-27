/**
 * agent runner 适配层：把「题目 → agent 输出文本」这一步抽象出来，
 * 方便在 pi / claude code / mock 之间切换，也方便你接别的 CLI（如 ollama、gemini-cli）。
 *
 * 约定：所有 runner 都通过 **stdin** 传 prompt（避免 Windows 上 .cmd shim / argv 引号 / 32k 长度限制的坑），
 * 返回 { text, meta }。
 */
import { spawn } from 'node:child_process';

/** Windows 下 token 需要引号时加引号（配合 windowsVerbatimArguments 使用） */
function quoteWin(token) {
	const s = String(token);
	if (s === '') return '""';
	if (!/[\s"&|<>^]/.test(s)) return s;
	return `"${s.replace(/"/g, '""')}"`;
}

/**
 * 执行子进程，prompt 走 stdin，带硬超时。
 * @returns {Promise<{stdout:string, stderr:string, code:number|null, ms:number, timedOut:boolean}>}
 */
export function exec(cmd, args, { input = '', timeoutMs = 45000, cwd = process.cwd(), env = process.env } = {}) {
	return new Promise((resolve) => {
		const started = Date.now();
		const isWin = process.platform === 'win32';
		const realCmd = isWin ? process.env.ComSpec || 'cmd.exe' : cmd;
		const realArgs = isWin ? ['/d', '/s', '/c', [quoteWin(cmd), ...args.map(quoteWin)].join(' ')] : args;

		let child;
		try {
			child = spawn(realCmd, realArgs, {
				cwd,
				env,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
				windowsVerbatimArguments: isWin
			});
		} catch (err) {
			resolve({ stdout: '', stderr: String(err), code: -1, ms: 0, timedOut: false });
			return;
		}

		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let settled = false;

		let timer = null;
		const finish = (code) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ stdout, stderr, code, ms: Date.now() - started, timedOut });
		};

		// timeoutMs <= 0 表示不设超时（OCS 侧超时调大后可以用）
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				try {
					// Windows 下 cmd 包了一层，直接杀进程树
					if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
					else child.kill('SIGKILL');
				} catch {
					/* ignore */
				}
				finish(null);
			}, timeoutMs);
		}

		child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
		child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
		child.on('error', (err) => {
			stderr += String(err);
			finish(-1);
		});
		child.on('close', (code) => finish(code));

		child.stdin.on('error', () => {
			/* EPIPE 忽略 */
		});
		child.stdin.end(input);
	});
}

/** 从 pi --mode json 的 JSONL 事件流里取最后一条 assistant 文本 */
function parsePiJsonl(stdout) {
	let text = '';
	let model = '';
	let usage = null;
	let durationMs = null;
	const tools = [];
	// toolsAdded = pi 真正注册给模型的工具（首条 system message 里带全量）。
	// 这是唯一可信的「agent 到底拿到哪些工具」证据 —— 模型说它有 xxx 不算，得看这里。
	const registered = new Set();
	for (const line of stdout.split(/\r?\n/)) {
		const s = line.trim();
		if (!s || s[0] !== '{') continue;
		let ev;
		try {
			ev = JSON.parse(s);
		} catch {
			continue;
		}
		for (const t of ev?.message?.toolsAdded ?? []) if (t?.name) registered.add(t.name);
		for (const t of ev?.toolsAdded ?? []) if (t?.name) registered.add(t.name);
		const msg = ev.message;
		if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
			const texts = msg.content.filter((c) => c && c.type === 'text').map((c) => c.text);
			if (texts.length) text = texts.join('\n');
			if (msg.model) model = msg.model;
			if (msg.usage) usage = msg.usage;
			for (const c of msg.content) if (c && c.type === 'toolCall' && c.name) tools.push(c.name);
			if (msg.durationMs) durationMs = msg.durationMs;
		}
	}
	return { text, model, usage, durationMs, tools: [...new Set(tools)], registered: [...registered] };
}

/** 从 claude -p --output-format json 的输出里取 result */
function parseClaudeJson(stdout) {
	const s = stdout.trim();
	const start = s.indexOf('{');
	const end = s.lastIndexOf('}');
	if (start === -1 || end === -1) return { text: s, meta: {} };
	try {
		const j = JSON.parse(s.slice(start, end + 1));
		return {
			text: String(j.result ?? j.text ?? ''),
			meta: { model: j.model, usage: j.usage, costUsd: j.total_cost_usd, durationMs: j.duration_ms }
		};
	} catch {
		return { text: s, meta: {} };
	}
}

// ========== runners ==========

/**
 * 把 pi 的配置目录指到一个空目录：用户级的 pi 包（pi-context-view、noheadroom、
 * pi-deepseek-usage…）就一个都装不进来。--no-extensions 挡的是「发现」，这个是挡「用户级设置」。
 * pi 认证靠环境变量里的 key，不依赖这个目录，所以隔离后照样能跑。
 */
function piEnv(base, home) {
	if (!home) return base;
	return { ...base, PI_CODING_AGENT_DIR: home };
}

/** pi（https://github.com/badlogic/pi-mono 系列 CLI） */
function piRunner(opts) {
	return async (job, ctx) => {
		const args = [
			'-p',
			'--mode',
			'json',
			// '--no-session',
			'--no-extensions', // 不发现 .pi/settings.json 里的项目管理插件（hashline/todo/acp…）
			'--no-context-files',
			'--no-skills',
			'--no-mcp'
		];
		// 工具按需开：图像题要 read 看图片，教材模式要 read + bash（grep 定位章节）；
		// 都不需要时给 --no-tools（更快更省，也避免模型乱翻文件）
		const tools = [];
		if (job.imageFiles.length) tools.push('read');
		if (job.needsFileAccess) tools.push('read', 'bash');
		// 联网搜索：插件用 -e 显式挂载（--no-extensions 挡不住显式 -e，工具仍受 --tools 白名单约束）
		if (opts.webSearch && job.webSearchExt) {
			args.push('-e', job.webSearchExt);
			tools.push('web_access');
		}
		const toolList = [...new Set(tools)];
		if (toolList.length) args.push('--tools', toolList.join(','));
		else args.push('--no-tools');
		if (opts.model) args.push('--model', opts.model);
		// --verbose 时把真实命令行打出来：这类「工具比我以为的多」的问题，只能看实跑的命令行
		if (ctx.verbose) {
			const shown = args.map((a) => (a === job.webSearchExt ? '<ext>' : a)).join(' ');
			console.log(`   ↳ ${opts.bin || 'pi'} ${shown}`);
			if (ctx.piHome) console.log(`   ↳ PI_CODING_AGENT_DIR=${ctx.piHome}`);
		}
		const r = await exec(opts.bin || 'pi', args, {
			input: job.prompt,
			timeoutMs: ctx.timeoutMs,
			env: piEnv(process.env, ctx.piHome)
		});
		const parsed = parsePiJsonl(r.stdout);
		return {
			text: parsed.text,
			meta: {
				runner: 'pi',
				model: parsed.model || opts.model || '',
				exitCode: r.code,
				timedOut: r.timedOut,
				durationMs: parsed.durationMs ?? r.ms,
				usage: parsed.usage,
				tools: parsed.tools,
				registered: parsed.registered,
				allowed: toolList,
				stderr: r.stderr.trim().slice(-400) || undefined
			}
		};
	};
}

/** claude code 无头模式：claude -p --output-format json（prompt 从 stdin 读） */
function claudeRunner(opts) {
	return async (job, ctx) => {
		const args = ['-p', '--output-format', 'json'];
		const allowed = [];
		if (job.imageFiles.length) allowed.push('Read');
		if (job.needsFileAccess) allowed.push('Read', 'Grep', 'Bash');
		if (allowed.length) args.push('--allowedTools', [...new Set(allowed)].join(','));
		if (opts.model) args.push('--model', opts.model);
		const r = await exec(opts.bin || 'claude', args, { input: job.prompt, timeoutMs: ctx.timeoutMs });
		const parsed = parseClaudeJson(r.stdout);
		return {
			text: parsed.text,
			meta: {
				runner: 'claude',
				model: parsed.meta.model || opts.model || '',
				exitCode: r.code,
				timedOut: r.timedOut,
				durationMs: parsed.meta.durationMs ?? r.ms,
				usage: parsed.meta.usage,
				costUsd: parsed.meta.costUsd,
				stderr: r.stderr.trim().slice(-400) || undefined
			}
		};
	};
}

/**
 * mock：不调任何模型，专用于打通管线 / 冒烟测试。
 * - 题干含 NONE 时返回 NONE（用来测「搜不到」分支）
 * - 故意用「人话」包装答案，顺便验证规整逻辑
 */
function mockRunner() {
	return async (job) => {
		await new Promise((r) => setTimeout(r, 5));
		const title = (job.title || '').toUpperCase();
		if (title.includes('NONE')) return { text: 'NONE', meta: { runner: 'mock' } };
		let text;
		switch (job.type) {
			case 'single':
				text = '正确答案是：A。';
				break;
			case 'multiple':
				text = '答案是 A、C 两项';
				break;
			case 'judgement':
				text = '这句话是正确的。';
				break;
			case 'completion':
				text = job.blanks > 1 ? '光合作用#叶绿体' : '光合作用';
				break;
			default:
				text = 'MOCK-ANSWER';
		}
		// 多个选项时让单选答案落在已有选项上（A 一定存在）
		return { text, meta: { runner: 'mock' } };
	};
}

export const RUNNER_NAMES = ['pi', 'claude', 'mock'];

export function makeRunner(opts) {
	switch (opts.runner) {
		case 'mock':
			return mockRunner(opts);
		case 'claude':
			return claudeRunner(opts);
		case 'pi':
			return piRunner(opts);
		default:
			throw new Error(`未知 runner: ${opts.runner}（可选 ${RUNNER_NAMES.join(' / ')}）`);
	}
}
