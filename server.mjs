#!/usr/bin/env node
/**
 * ocs-agent-answerer —— 把 pi / claude code 之类的 agent 变成 OCS 网课助手的「题库后端」（方案 A）
 *
 * OCS 侧唯一的外部接口就是「题库配置」（AnswererWrapper）：
 *   packages/core/src/core/answer-wrapper/answer.wrapper.handler.ts
 * 它会对本服务 POST 一道题，并用配置里的 handler（页面内执行的 JS）把响应解析成 [题目, 答案]。
 * 所以本服务的职责只有三件事：收题 → 让 agent 作答 → 规整成 OCS 匹配器能吃的格式。
 *
 * 用法：
 *   node server.mjs                                   # 默认 runner=pi、模版 default、127.0.0.1:8787
 *   node server.mjs --config answerer.json            # 用配置文件（模版/教材/超时都写在里面）
 *   node server.mjs --template textbook --textbooks ./textbooks
 *   node server.mjs --prompt ./my-template.md         # 全自定义模版
 *   node server.mjs --runner mock                     # 不调模型，冒烟测试
 *   node server.mjs --help
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildPrompt, normalizeAnswer } from './prompt.mjs';
import { makeRunner, RUNNER_NAMES } from './runners.mjs';
import { cacheKey, createCache, sha256 } from './cache.mjs';
import { DEFAULTS, resolveConfig } from './config.mjs';
import { listTemplates, resolveTemplate, TEMPLATES } from './templates.mjs';
import { autoDetectTextbooks, createTextbooks } from './textbooks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ========== 参数 ==========
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log(`ocs-agent-answerer —— OCS 的 agent 题库后端

用法：node server.mjs [选项]   或   node server.mjs --config answerer.json

配置分层：默认值 ← --config 文件 ← 命令行（命令行优先）

基本：
  --config <file>        配置文件（JSON，含注释也行），模板见 config.example.json
  --port <n>             监听端口，默认 8787
  --host <addr>          监听地址，默认 127.0.0.1（改成 0.0.0.0 会暴露到局域网，请配 --token）
  --runner <name>        pi | claude | mock，默认 pi
  --model <name>         传给 runner 的模型（pi 支持 "provider/model"）
  --bin <path>           agent 可执行文件路径，默认同名命令
  --concurrency <n>      同时运行的 agent 数，默认 1（单会话 agent 建议保持 1）

超时（两个都别设太小）：
  --timeout <ms>         单题 agent 超时，默认 45000；0 = 不限制
  --ocs-timeout <ms>     OCS 侧超时，默认 60000。改了 OCS 源码后把这里调成一致（只影响告警与提示）

提示词：
  --template <name>      模版：default（无教材）| textbook（参考教材）| hint（页面提示），默认 default
  --textbooks <path>     参考教材位置：文件或目录，逗号分隔；留空则自动用 ./textbooks
  --textbook-max-chars   默认 0 = 只告诉 agent 教材在哪（推荐）。设成 N>0 才额外注入正文前 N 字符
  --prompt <file>        自定义模版文件（优先级高于 --template），支持 {{title}} {{textbooks}} {{rules}} 等占位符

联网搜索（pi runner）：
  --no-web-search        不给答题 agent 挂联网搜索插件（默认挂）
  --web-search-ext <f>   插件入口文件，默认自动探测 .pi/npm/node_modules/@ssk_dev/pi-web-access-lean/index.ts
  （安装：pi install npm:@ssk_dev/pi-web-access-lean；插件只注册一个 web_access 工具，约 153 token）
  --isolate-pi-config    让答题 agent 用独立 pi 配置目录（.agent/pi-home），连用户级 pi 包也一起隔离
                         默认不用：agent 已经靠 --no-extensions + --tools 白名单只拿到该有的工具

其他：
  --cache <file>         缓存文件，默认 <程序目录>/cache.json
  --no-cache             关闭缓存
  --public-url <url>     /config 里生成的题库地址，默认 http://<host>:<port>
  --token <str>          要求请求带 x-ocs-token 头（题库配置里会自动带上）
  --workdir <dir>        图片落盘目录，默认 <tmp>/ocs-agent-answerer
  --max-body <bytes>     请求体上限，默认 32MB（图片题 base64 可能很大）
  --verbose              打印每题的处理日志

接口：
  POST /ask              接收 { title, options, type, blanks, images } → { ok, answer, ... }
                         （也接受 payload.template / payload.textbooks 单题覆盖）
  GET  /health           健康检查 / 队列 / 缓存 / 模版 / 教材统计
  GET  /config           直接返回可粘贴进 OCS 的题库配置 JSON（?type=fetch 用 fetch 代替 GM）
  GET  /templates        列出内置模版 + 当前生效的模版与教材
  GET  /prompt?title=..  预览渲染后的 prompt（调试模版用；也支持 POST JSON）
  GET  /cache?limit=20   导出缓存（你的私有题库）
  POST /cache/clear      清空缓存
`);
	process.exit(0);
}

let resolved;
try {
	resolved = resolveConfig({ argv, cwd: HERE });
} catch (err) {
	console.error(`❌ ${err.message}`);
	process.exit(1);
}
const { opts, meta } = resolved;

if (meta.unknownKeys.length) {
	console.warn(`⚠️  未识别的配置项（已忽略）：${meta.unknownKeys.join(', ')}`);
}
if (!RUNNER_NAMES.includes(opts.runner)) {
	console.error(`❌ 未知 --runner ${opts.runner}，可选：${RUNNER_NAMES.join(' / ')}`);
	process.exit(1);
}

/** 相对路径都以配置文件所在目录为基准（没配置文件才用进程 cwd），默认值则相对程序目录 */
const CONFIG_DIR = meta.configFile ? path.dirname(meta.configFile) : process.cwd();
const resolvePath = (p) => (path.isAbsolute(p) ? p : path.resolve(CONFIG_DIR, p));
const resolveSpec = (spec) =>
	String(spec || '')
		.split(/[;,]/)
		.map((s) => s.trim())
		.filter(Boolean)
		.map(resolvePath)
		.join(',');

// ---- 模版 ----
let templateInfo;
try {
	if (opts.prompt) {
		const file = resolvePath(opts.prompt);
		const text = fs.readFileSync(file, 'utf8');
		templateInfo = { id: `file:${path.basename(file)}`, label: `自定义模版（${path.basename(file)}）`, text };
	} else {
		templateInfo = resolveTemplate(opts.template);
	}
} catch (err) {
	console.error(`❌ 模版加载失败：${err.message}`);
	process.exit(1);
}

// ---- 参考教材 ----
let textbookSpec = opts.textbooks ? resolveSpec(opts.textbooks) : '';
let textbookAutoDetected = false;
if (!textbookSpec) {
	const auto = autoDetectTextbooks(HERE) || autoDetectTextbooks(CONFIG_DIR);
	if (auto) {
		textbookSpec = auto;
		textbookAutoDetected = true;
	}
}
const books = createTextbooks(textbookSpec, { excerptChars: opts.textbookMaxChars, cwd: CONFIG_DIR });


// ---- 联网搜索插件（@ssk_dev/pi-web-access-lean，单工具 web_access） ----
// 为什么用 -e 显式挂载而不是靠 .pi 项目包：runner 里带了 --no-extensions（避免加载无关扩展影响确定性），
// 显式 -e 不受它影响；而且只挂这一个插件，别的扩展不会偷偷改 prompt。
const WEB_EXT_REL = path.join('.pi', 'npm', 'node_modules', '@ssk_dev', 'pi-web-access-lean', 'index.ts');
let webSearchExt = '';
if (opts.webSearch) {
	const candidates = opts.webSearchExt
		? [resolvePath(opts.webSearchExt)]
		: [path.join(HERE, WEB_EXT_REL), path.join(CONFIG_DIR, WEB_EXT_REL)];
	webSearchExt = candidates.find((p) => fs.existsSync(p)) || '';
	if (!webSearchExt) {
		console.warn(
			`⚠️  联网搜索已开启，但没找到插件入口：${candidates.join(' / ')}\n` +
				`   装一下：pi install npm:@ssk_dev/pi-web-access-lean\n` +
				`   或用 --web-search-ext <入口文件> 指定路径，或 --no-web-search 关掉。`
		);
	}
}

// ---- pi 配置隔离（可选，--isolate-pi-config）----
// 默认不动你的 pi 配置：--no-extensions 已经把项目 .pi/settings.json 里的插件挡住了（实测只注册白名单工具）。
// 打开后 agent 用 .agent/pi-home 这个空配置目录，连「用户级」的 pi 包也一并隔离；
// 只把认证和模型目录复制过去（settings.json 里声明的是插件，绝不复制）。
const AGENT_HOME = opts.isolatePiConfig ? path.join(CONFIG_DIR, '.agent', 'pi-home') : '';
if (AGENT_HOME) {
	fs.mkdirSync(AGENT_HOME, { recursive: true });
	const realHome = path.join(os.homedir(), '.pi', 'agent');
	let copied = 0;
	for (const f of ['auth.json', 'models.json', 'models-store.json', 'web-search.json']) {
		const src = path.join(realHome, f);
		try {
			if (fs.existsSync(src)) {
				fs.copyFileSync(src, path.join(AGENT_HOME, f));
				copied++;
			}
		} catch {
			/* 拷不动就用 pi 的默认值，不致命 */
		}
	}
	if (!copied) {
		console.warn(
			`⚠️  --isolate-pi-config：没能从 ${realHome} 复制到认证/模型配置。\n` +
				`   agent 可能报 "No API key found"：改用环境变量给 key（如 XIAOMI_API_KEY），或去掉这个参数。`
		);
	}
}
const cacheFile = meta.sources.cache ? resolvePath(opts.cache) : path.join(HERE, 'cache.json');

// ---- 告警 ----
if (opts.timeout > 0 && opts.timeout >= opts.ocsTimeout) {
	console.warn(
		`⚠️  --timeout ${opts.timeout}ms ≥ --ocs-timeout ${opts.ocsTimeout}ms：OCS 会先报「题库请求超时」。` +
			`要么把 --timeout 调小，要么把 OCS 侧超时改大（见 README「超时」一节）后再 --ocs-timeout 同步。`
	);
} else if (opts.ocsTimeout > DEFAULTS.ocsTimeout) {
	console.warn(
		`⚠️  --ocs-timeout ${opts.ocsTimeout}ms 大于 OCS 默认的 60s：请确认你已经把 OCS 源码里的 timeout_seconds 改成 ≥ ${Math.ceil(
			opts.ocsTimeout / 1000
		)}，否则还是会在 60s 被判「题库请求超时」（见 README「超时」）。`
	);
}
if (opts.timeout <= 0) {
	console.warn(`⚠️  --timeout 0 = 不限制 agent 耗时；那 OCS 侧超时就是唯一的刹车，慢模型会大量 timedOut。`);
}
// 联网搜索实测：一次 search 2~5s，抓正文/多个来源可能 60s+（见过 74s）。默认 45s 会直接掐断。
if (webSearchExt && opts.runner !== 'mock' && opts.timeout > 0 && opts.timeout < 60000) {
	console.warn(
		`⚠️  联网搜索已开，但 --timeout 只有 ${opts.timeout}ms：一次联网搜索实测 2~5s，抓多个页面可能 60s+。\n` +
			`   建议 --timeout 90000（同时把 OCS 侧超时一起调大，见 README「超时」），或 --no-web-search 关掉联网。`
	);
}
if (templateInfo.text.includes('{{textbooks}}') && !books.get().files.length) {
	console.warn(`⚠️  模版用了 {{textbooks}} 但没找到教材：用 --textbooks <文件或目录> 指定，或跑 --template default。`);
}
if (opts.host !== '127.0.0.1' && opts.host !== 'localhost' && !opts.token) {
	console.warn(`⚠️  监听 ${opts.host} 且未设置 --token：任何能访问该端口的人都能用你的 agent 额度。`);
}

const publicUrl = (opts.publicUrl || `http://${opts.host}:${opts.port}`).replace(/\/+$/, '');
if (opts.publicUrl && /^http:\/\//.test(opts.publicUrl) === false) {
	console.warn(`⚠️  --public-url 建议用 http:// 开头，当前：${opts.publicUrl}`);
}

// ========== 组件 ==========
const runner = makeRunner(opts);
const cache = createCache(cacheFile, { enabled: !opts.noCache });
const startedAt = Date.now();
const metrics = { requests: 0, cacheHits: 0, agentCalls: 0, failures: 0, agentMsTotal: 0, lastMs: 0 };

/** 串行队列：单 agent 会话扛不住并发，OCS 多线程打过来时在这里排队 */
function createQueue(concurrency) {
	const waiting = [];
	const stats = { pending: 0, active: 0, done: 0 };
	const pump = () => {
		while (stats.active < concurrency && waiting.length) {
			const task = waiting.shift();
			stats.active++;
			stats.pending = waiting.length;
			Promise.resolve()
				.then(task.fn)
				.then(task.resolve, task.reject)
				.finally(() => {
					stats.active--;
					stats.done++;
					pump();
				});
		}
	};
	return {
		stats,
		push(fn) {
			return new Promise((resolve, reject) => {
				waiting.push({ fn, resolve, reject });
				stats.pending = waiting.length;
				pump();
			});
		}
	};
}
const queue = createQueue(opts.concurrency);

/** data URL 图片落盘，供 agent 用 read 工具查看 */
function writeImages(images) {
	if (!images.length) return [];
	const dir = path.join(opts.workdir, 'images');
	fs.mkdirSync(dir, { recursive: true });
	const files = [];
	images.slice(0, 8).forEach((img, i) => {
		const m = /^data:([^;,]+)(;charset=[^;,]+)?;base64,(.+)$/s.exec(String(img));
		if (!m) return;
		const mime = m[1];
		const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('svg') ? 'svg' : mime.split('/')[1] || 'png';
		const file = path.join(dir, `q-${Date.now()}-${process.pid}-${i}.${ext}`);
		fs.writeFileSync(file, Buffer.from(m[3], 'base64'));
		files.push(file);
	});
	return files;
}

/** 单题开关解析：true/1/yes/on 为真，false/0/no/off 为假，其它按「取默认」处理 */
function parseFlag(v, fallback) {
	if (v === undefined || v === null || v === '') return fallback;
	if (typeof v === 'boolean') return v;
	const s = String(v).trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(s)) return true;
	if (['0', 'false', 'no', 'off'].includes(s)) return false;
	return fallback;
}
/**
 * 单题上下文：模版 + 教材 + 缓存变体。
 * payload.template / payload.textbooks 可以单题覆盖（curl 调试和按章节切教材时好用）。
 */
function requestContext(payload) {
	const bookState = books.get();
	const override = payload.template ? resolveTemplate(String(payload.template)) : null;
	const templateText = override ? override.text : templateInfo.text;
	const templateId = override ? override.id : templateInfo.id;
	const overrideBooks = typeof payload.textbooks === 'string' && payload.textbooks.trim() ? payload.textbooks.trim() : '';
	// payload.textbooks = 单题换一套教材「位置」（按课程/章节切教材用），不是正文
	const extra = overrideBooks
		? createTextbooks(resolveSpec(overrideBooks), { excerptChars: opts.textbookMaxChars, cwd: CONFIG_DIR }).get()
		: null;
	// payload.textbookExcerpt = 单题附一段正文（可选，默认不用）
	const inlineExcerpt = typeof payload.textbookExcerpt === 'string' ? payload.textbookExcerpt.trim() : '';
	const textbookDesc = extra ? extra.desc : bookState.desc;
	const textbookExcerpt = inlineExcerpt || (extra ? extra.excerpt : bookState.excerpt);
	const bookSig = inlineExcerpt ? sha256(inlineExcerpt).slice(0, 16) : extra ? extra.signature : bookState.signature;
	return {
		templateText,
		templateId,
		textbookDesc,
		textbookExcerpt,
		bookSig,
		// 单题可关：payload.webSearch = false（进 prompt 提示 + runner 工具列表，不进缓存 key）
		webSearch: parseFlag(payload.webSearch, !!webSearchExt),
		variant: sha256(`${templateId}\u0000${bookSig}`).slice(0, 16)
	};
}

const inflight = new Map(); // 同题并发去重：多线程/重试打同一题时只调一次 agent

async function ask(payload) {
	const started = Date.now();
	metrics.requests++;

	const title = String(payload.title ?? '').trim();
	const options = String(payload.options ?? '');
	const type = String(payload.type ?? 'unknown');
	const images = Array.isArray(payload.images) ? payload.images.filter(Boolean) : [];
	const blanks = Math.max(0, Number(payload.blanks) || 0);

	if (!title && !images.length) return { ok: false, reason: '题干与图片均为空', ms: 0 };

	const ctx = requestContext(payload);
	const key = cacheKey({ type, title, options, images, variant: ctx.variant });
	const hit = cache.get(key);
	if (hit) {
		metrics.cacheHits++;
		return { ok: true, question: title, answer: hit.answer, source: 'cache', cached: true, template: hit.template || ctx.templateId, ms: 0 };
	}
	if (inflight.has(key)) {
		const shared = await inflight.get(key);
		return { ...shared, cached: true, deduped: true };
	}

	const task = (async () => {
		const job = {
			title,
			options,
			type,
			blanks,
			images,
			imageFiles: writeImages(images),
			suggestionTitle: String(payload.suggestionTitle ?? payload.suggestion_title ?? ''),
			suggestionOptions: String(payload.suggestionOptions ?? payload.suggestion_options ?? '')
		};
		job.webSearchExt = ctx.webSearch ? webSearchExt : '';
		job.prompt = buildPrompt(job, {
			templateText: ctx.templateText,
			textbooks: ctx.textbookDesc,
			textbookExcerpt: ctx.textbookExcerpt,
			webSearch: ctx.webSearch
		});
		// 模版让 agent 自己去查教材 → 必须放开 read + bash（grep），否则它在无工具的沙盒里只能瞎猜
		job.needsFileAccess = ctx.templateText.includes('{{textbooks}}') && !!ctx.textbookDesc;

		metrics.agentCalls++;
		const agentStarted = Date.now();
		let raw = '';
		let agentMeta = {};
		try {
			const r = await queue.push(() =>
				runner(job, { timeoutMs: opts.timeout, verbose: opts.verbose, piHome: AGENT_HOME })
			);
			if (opts.verbose && r.meta?.registered) {
				console.log(`     工具: ${r.meta.registered.join(', ') || '(无)'}`);
			}
			raw = r.text;
			agentMeta = r.meta || {};
		} catch (err) {
			metrics.failures++;
			return { ok: false, reason: `agent 调用失败: ${err.message}`, ms: Date.now() - started };
		}
		metrics.agentMsTotal += Date.now() - agentStarted;

		if (agentMeta.timedOut) {
			metrics.failures++;
			return {
				ok: false,
				reason: `agent 超时（>${opts.timeout}ms），OCS 侧超时 ${opts.ocsTimeout}ms`,
				ms: Date.now() - started,
				meta: agentMeta
			};
		}

		const answer = normalizeAnswer(raw, { type, options, blanks });
		if (!answer) {
			metrics.failures++;
			return { ok: false, question: title, reason: 'agent 表示无法作答（NONE）或输出为空', ms: Date.now() - started, raw, meta: agentMeta };
		}

		cache.set(key, { answer, type, title: title.slice(0, 200), runner: opts.runner, template: ctx.templateId });
		return {
			ok: true,
			question: title,
			answer,
			source: 'agent',
			cached: false,
			template: ctx.templateId,
			promptChars: job.prompt.length,
			// 这次答题用到了哪些工具（web_access / read / bash），排查「到底联没联网」时看这个
			// tools = 模型真调用过哪些；agentTools = pi 真注册给模型哪些（后者才是「有没有多给工具」的证据）
			tools: agentMeta.tools,
			agentTools: agentMeta.registered,
			webSearch: ctx.webSearch,
			ms: Date.now() - started,
			meta: agentMeta
		};
	})();

	inflight.set(key, task);
	try {
		return await task;
	} finally {
		inflight.delete(key);
	}
}

// ========== 浏览器侧题库配置（就是 OCS 会执行的那两个 handler） ==========

/**
 * data.payload 的字段解析器（在网课页面的作用域里跑，所以能读 document）。
 * 用它而不是 ${title} 占位符的原因：
 *   1. 占位符是字符串 replace，${images}（数组）会被拼成逗号串，毁掉 base64；
 *   2. 顺便能把 DOM 里的填空框数量带上（OCS 的 env 里没有这个信息）。
 *   3. handler 源码里出现 env.images，OCS 的 isAnswererWrapperSupportImageOptimize 才会认为该题库支持图片题。
 */
const PAYLOAD_HANDLER = [
	'return (env) => ({',
	"  title: env.title || '',",
	"  options: env.options || '',",
	"  type: env.type || 'unknown',",
	'  images: env.images || [],',
	"  suggestionTitle: env.suggestion_title || '',",
	"  suggestionOptions: env.suggestion_options || '',",
	"  blanks: (typeof document !== 'undefined') ? document.querySelectorAll('textarea:not([disabled]), input[type=text]:not([disabled]), input:not([type]):not([disabled])').length : 0,",
	"  page: (typeof location !== 'undefined') ? location.href : ''",
	'})'
].join('\n');

/** 响应解析器：只有 ok 且拿到答案才返回结果，否则 undefined（OCS 会当成「没搜到」继续用别的题库） */
const RESPONSE_HANDLER =
	'return (res) => (res && res.ok && res.answer) ? [[res.question, res.answer, { source: res.source, cached: !!res.cached, ms: res.ms }]] : undefined';

function buildWrapperConfig({ type = 'GM_xmlhttpRequest' } = {}) {
	const headers = { 'Content-Type': 'application/json' };
	if (opts.token) headers['x-ocs-token'] = opts.token;
	return [
		{
			name: `本地 Agent（${opts.runner}${opts.model ? `/${opts.model}` : ''}·${templateInfo.label}）`,
			homepage: publicUrl,
			url: `${publicUrl}/ask`,
			method: 'post',
			type,
			responseType: 'json',
			headers,
			data: { payload: { handler: PAYLOAD_HANDLER } },
			handler: RESPONSE_HANDLER,
			v: 2
		}
	];
}

// ========== HTTP ==========
const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, x-ocs-token',
	'Access-Control-Max-Age': '86400'
};

function send(res, status, body, type = 'application/json') {
	const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
	res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, ...CORS });
	res.end(payload);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > opts.maxBody) {
				reject(Object.assign(new Error(`请求体超过 ${opts.maxBody} 字节`), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/** /prompt 预览：把 query/body 当一道题来渲染 prompt，只看不发模型 */
async function previewPrompt(input) {
	const payload = {
		title: String(input.title ?? ''),
		options: String(input.options ?? ''),
		type: String(input.type ?? 'single'),
		blanks: Number(input.blanks) || 0,
		suggestionTitle: String(input.suggestionTitle ?? input.suggestion_title ?? ''),
		suggestionOptions: String(input.suggestionOptions ?? input.suggestion_options ?? ''),
		...(input.template ? { template: String(input.template) } : {}),
		...(input.textbooks ? { textbooks: String(input.textbooks) } : {}),
		...(input.textbookExcerpt ? { textbookExcerpt: String(input.textbookExcerpt) } : {}),
		...(input.webSearch !== undefined ? { webSearch: input.webSearch } : {})
	};
	const ctx = requestContext(payload);
	const job = { ...payload, imageFiles: [] };
	const prompt = buildPrompt(job, {
		templateText: ctx.templateText,
		textbooks: ctx.textbookDesc,
		textbookExcerpt: ctx.textbookExcerpt,
		webSearch: ctx.webSearch
	});
	return {
		ok: true,
		prompt,
		chars: prompt.length,
		webSearch: ctx.webSearch,
		template: { id: ctx.templateId, label: ctx.templateId in TEMPLATES ? TEMPLATES[ctx.templateId].label : ctx.templateId },
		textbooks: {
			override: !!payload.textbooks,
			desc: ctx.textbookDesc,
			excerptChars: ctx.textbookExcerpt.length,
			// 模版让 agent 自己去查教材时，runner 会放开 read/bash 工具
			needsFileAccess: ctx.templateText.includes('{{textbooks}}') && !!ctx.textbookDesc
		}
	};
}

function healthBody() {
	const avg = metrics.agentCalls ? Math.round(metrics.agentMsTotal / metrics.agentCalls) : 0;
	const bookState = books.get();
	return {
		ok: true,
		runner: opts.runner,
		model: opts.model || '(default)',
		uptimeSec: Math.round((Date.now() - startedAt) / 1000),
		template: { id: templateInfo.id, label: templateInfo.label, chars: templateInfo.text.length },
		textbooks: {
			spec: textbookSpec || '(none)',
			autoDetected: textbookAutoDetected,
			files: bookState.files.map((f) => path.basename(f.path)),
			skipped: bookState.skipped.map((f) => path.basename(f.path)),
			excerptChars: bookState.excerptChars,
			excerptLimit: opts.textbookMaxChars,
			truncated: bookState.truncated
		},
		webSearch: {
			enabled: !!webSearchExt,
			requested: !!opts.webSearch,
			ext: webSearchExt ? path.relative(HERE, webSearchExt).split(path.sep).join('/') : ''
		},
		budget: { timeoutMs: opts.timeout, ocsTimeoutMs: opts.ocsTimeout, unlimited: opts.timeout <= 0 },
		queue: { concurrency: opts.concurrency, ...queue.stats },
		cache: { enabled: cache.enabled, size: cache.size, ...cache.stats },
		metrics: { ...metrics, avgAgentMs: avg },
		configFile: meta.configFile || '(none)',
		configEndpoint: `${publicUrl}/config`
	};
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

	if (req.method === 'OPTIONS') {
		res.writeHead(204, CORS);
		res.end();
		return;
	}

	if (opts.token) {
		const got = req.headers['x-ocs-token'];
		if (got !== opts.token) {
			send(res, 401, { ok: false, reason: 'token 不匹配' });
			return;
		}
	}

	try {
		if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
			send(res, 200, healthBody());
			return;
		}

		if (req.method === 'GET' && url.pathname === '/templates') {
			send(res, 200, {
				ok: true,
				current: { id: templateInfo.id, label: templateInfo.label, source: opts.prompt ? 'file' : 'builtin' },
				builtin: listTemplates(),
				textbooks: { spec: textbookSpec || '(none)', excerptLimit: opts.textbookMaxChars }
			});
			return;
		}

		if (url.pathname === '/prompt' && (req.method === 'GET' || req.method === 'POST')) {
			let input = {};
			if (req.method === 'POST') {
				const raw = await readBody(req);
				input = raw ? JSON.parse(raw) : {};
			} else {
				input = Object.fromEntries(url.searchParams.entries());
			}
			send(res, 200, await previewPrompt(input.payload && typeof input.payload === 'object' ? input.payload : input));
			return;
		}

		if (req.method === 'GET' && url.pathname === '/config') {
			const type = url.searchParams.get('type') === 'fetch' ? 'fetch' : 'GM_xmlhttpRequest';
			const config = buildWrapperConfig({ type });
			if (url.searchParams.get('raw') === '1') {
				send(res, 200, JSON.stringify(config), 'text/plain');
			} else {
				send(res, 200, config);
			}
			return;
		}

		if (req.method === 'GET' && url.pathname === '/cache') {
			const limit = Number(url.searchParams.get('limit') || 500);
			send(res, 200, { ok: true, total: cache.size, entries: cache.dump().slice(-limit) });
			return;
		}

		if (req.method === 'POST' && url.pathname === '/cache/clear') {
			cache.clear();
			send(res, 200, { ok: true, cleared: true });
			return;
		}

		if (req.method === 'POST' && url.pathname === '/ask') {
			const raw = await readBody(req);
			let body;
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {
				send(res, 400, { ok: false, reason: '请求体不是合法 JSON' });
				return;
			}
			// 题库配置把整包放在 payload 里；也兼容平铺字段，方便 curl 调试
			const payload = body.payload && typeof body.payload === 'object' ? body.payload : body;
			const result = await ask(payload);
			metrics.lastMs = result.ms || 0;
			if (opts.verbose) {
				const tag = result.ok ? (result.cached ? 'cache' : 'agent') : 'fail';
				console.log(
					`[ask] ${String(payload.type || '?').padEnd(10)} ${String(result.ms ?? 0).padStart(6)}ms ${tag.padEnd(5)} ` +
						`${String(result.template || '').padEnd(12)} ${String(payload.title || '').slice(0, 40)} → ${result.ok ? result.answer : result.reason}`
				);
			}
			// 一律 200：handler 靠 ok 字段判断，避免 OCS 侧显示成「题库连接失败」
			send(res, 200, opts.verbose ? result : { ...result, meta: undefined, raw: undefined });
			return;
		}

		send(res, 404, { ok: false, reason: `未知路径 ${req.method} ${url.pathname}` });
	} catch (err) {
		send(res, err.status || 500, { ok: false, reason: err.message || String(err) });
	}
});

// 端口被占用/被系统保留时给一句人话（Windows 上有大段 excludedportrange，8901 这类端口会 EACCES）
server.on('error', (err) => {
	const port = `${opts.host}:${opts.port}`;
	if (err.code === 'EADDRINUSE') {
		console.error(`❌ 端口 ${port} 已被占用：换 --port，或先关掉占用的进程。`);
	} else if (err.code === 'EACCES') {
		console.error(
			`❌ 端口 ${port} 不允许监听（Windows 保留端口段，或没有权限）。\n` +
				`   换一个端口，例如 --port 8787；查保留段：netsh interface ipv4 show excludedportrange protocol=tcp`
		);
	} else {
		console.error(`❌ 监听 ${port} 失败：${err.message}`);
	}
	process.exit(1);
});

server.listen(opts.port, opts.host, () => {
	const bookState = books.get();
	const fmtTimeout = (ms) => (ms > 0 ? `${ms}ms` : '不限制');
	console.log(`\n🎓 ocs-agent-answerer`);
	console.log(`   runner   : ${opts.runner}${opts.model ? ` (${opts.model})` : ''}`);
	console.log(`   listen   : http://${opts.host}:${opts.port}`);
	console.log(`   题库配置 : ${publicUrl}/config   ← 浏览器里打开，复制 JSON 粘到 OCS「题库配置」`);
	console.log(`   模版     : ${templateInfo.label}（${templateInfo.id}，${templateInfo.text.length} 字符）`);
	console.log(
		`   教材     : ${
			bookState.files.length
				? `${bookState.files.length} 个文件（${bookState.desc.split(/\r?\n/)[0]}）${textbookAutoDetected ? ' ← 自动探测 ./textbooks' : ''}`
				: '未启用'
		}`
	);
	if (bookState.files.length) {
		console.log(`              只把「教材在哪」写进 prompt，agent 按题自己 grep/read（read+bash 工具已放开）`);
	}
	if (bookState.excerptChars) {
		console.log(`              额外注入正文节选 ${bookState.excerptChars} 字符（--textbook-max-chars ${opts.textbookMaxChars}）`);
	}
	console.log(`   缓存     : ${opts.noCache ? '关闭' : `${cacheFile} (${cache.size} 条)`}`);
	console.log(`   超时     : agent ${fmtTimeout(opts.timeout)} / OCS ${fmtTimeout(opts.ocsTimeout)}`);
	console.log(
		`   联网搜索 : ${
			webSearchExt
				? `已挂载 web_access（${path.relative(HERE, webSearchExt).split(path.sep).join('/')}）${opts.runner === 'pi' ? '' : ' ← 仅 pi runner 生效'}`
				: opts.webSearch
					? '未启用（找不到插件入口，见上方警告）'
					: '关闭（--no-web-search）'
		}`
	);
	if (bookState.skipped.length) {
	console.log(
		`   工具限制 : ${
			opts.runner !== 'pi'
				? '不适用（只有 pi runner 会加载 pi 插件）'
				: `--no-extensions + --tools 白名单${
						AGENT_HOME ? `，且配置目录隔离到 ${path.relative(HERE, AGENT_HOME).split(path.sep).join('/')}` : '（用你现有的 pi 配置）'
					}`
		}`
	);
		console.log(`   跳过     : ${bookState.skipped.map((f) => path.basename(f.path)).join('、')}（只认 .md/.txt，PDF 先转文本）`);
	}
	if (meta.configFile) console.log(`   配置文件 : ${meta.configFile}`);
	if (opts.host === '127.0.0.1') {
		console.log(`\n   提示：网课页是 https，浏览器直接 fetch http://127.0.0.1 会被混合内容拦。`);
		console.log(`        所以题库配置里 type 用 GM_xmlhttpRequest（油猴特权请求）才能通。\n`);
	} else {
		console.log('');
	}
});

for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => {
		cache.flush();
		server.close(() => process.exit(0));
	});
}
