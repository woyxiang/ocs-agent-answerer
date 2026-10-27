#!/usr/bin/env node
/**
 * 冒烟测试：不依赖任何模型/网络，验证协议、答案规整、提示词模版、教材注入、配置加载是否正确。
 *   node smoke.mjs
 * 覆盖：/health、/config、/templates、/prompt、四种题型规整、NONE 分支、缓存命中、
 *       并发去重、缓存变体（换模版/教材不复用旧答案）、token 鉴权、配置文件、自定义模版文件、教材目录加载。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'smoke-token';
const cacheFile = path.join(os.tmpdir(), `ocs-agent-smoke-${Date.now()}.json`);
const workRoot = path.join(os.tmpdir(), `ocs-agent-smoke-cfg-${Date.now()}`);
fs.mkdirSync(workRoot, { recursive: true });

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name}`);
	} else {
		fail++;
		console.log(`  ❌ ${name}${extra ? ` —— ${extra}` : ''}`);
	}
}

const children = [];

async function waitReady(base, token) {
	for (let i = 0; i < 80; i++) {
		try {
			const r = await fetch(`${base}/health`, { headers: token ? { 'x-ocs-token': token } : {} });
			if (r.ok) return true;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`server ${base} 启动超时`);
}

async function startServer(args, port, token) {
	const child = spawn(process.execPath, [path.join(HERE, 'server.mjs'), ...args], {
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	});
	children.push(child);
	child.stdout.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write(`[srv:${port}] ${d}`));
	child.stderr.on('data', (d) => process.stderr.write(`[srv:${port}] ${d}`));
	const base = `http://127.0.0.1:${port}`;
	await waitReady(base, token);
	return base;
}

/** 模拟 OCS 的题库请求：payload 里装的是 data.payload.handler 的产出 */
function askOn(base, token) {
	return async function ask(payload, opts = {}) {
		const r = await fetch(`${base}/ask`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...(opts.token !== undefined ? { 'x-ocs-token': opts.token } : token ? { 'x-ocs-token': token } : {}) },
			body: JSON.stringify({ payload })
		});
		return r.json();
	};
}

const OPTS4 = ['A. 增加成本', 'B. 降低成本', 'C. 提高效率', 'D. 减少库存'].join('\n');

let mainChild;
try {
	// ========== 主服务：mock runner，测协议与规整 ==========
	const BASE = await startServer(
		['--runner', 'mock', '--port', '8899', '--token', TOKEN, '--cache', cacheFile, '--timeout', '5000'],
		8899,
		TOKEN
	);
	const ask = askOn(BASE, TOKEN);

	console.log('\n【1】基础接口');

	const health = await (await fetch(`${BASE}/health`, { headers: { 'x-ocs-token': TOKEN } })).json();
	check('GET /health 返回 ok', health.ok === true);
	check('health 暴露两侧超时（可配置）', health.budget.timeoutMs === 5000 && health.budget.ocsTimeoutMs === DEFAULTS.ocsTimeout, JSON.stringify(health.budget));
	check('health 暴露当前模版', health.template && health.template.id === DEFAULTS.template, JSON.stringify(health.template));
	check('health 暴露联网搜索状态（插件已挂载）', health.webSearch?.enabled === true && /pi-web-access-lean/.test(health.webSearch.ext), JSON.stringify(health.webSearch));

	const cfgRes = await fetch(`${BASE}/config?raw=1`, { headers: { 'x-ocs-token': TOKEN } });
	const cfgText = await cfgRes.text();
	const cfg = JSON.parse(cfgText);
	check('/config 可解析为 AnswererWrapper[]', Array.isArray(cfg) && cfg.length === 1);
	check('配置 method=post（图片题必需）', cfg[0].method === 'post');
	check('配置 type=GM_xmlhttpRequest（绕混合内容）', cfg[0].type === 'GM_xmlhttpRequest');
	check('配置 data.payload 用 handler 保留数组', typeof cfg[0].data.payload.handler === 'string' && cfg[0].data.payload.handler.includes('env.images'));
	check('handler 源码含 env.images（触发 OCS 图片题支持判定）', /images/.test(cfg[0].data.payload.handler));

	const tplList = await (await fetch(`${BASE}/templates`, { headers: { 'x-ocs-token': TOKEN } })).json();
	check('/templates 列出内置模版', tplList.ok && tplList.builtin.some((t) => t.id === 'textbook'), JSON.stringify(tplList.builtin?.map((t) => t.id)));

	const bad = await ask({ title: 'x', type: 'single' }, { token: 'wrong' });
	check('错误 token 被拒', bad.ok === false && /token/.test(bad.reason));

	console.log('\n【2】答案规整（agent 说人话 → OCS 能吃的格式）');

	const single = await ask({ title: '下列哪项属于固定成本？', options: OPTS4, type: 'single' });
	check('单选「正确答案是：A。」→ A', single.ok && single.answer === 'A', JSON.stringify(single));

	const multiple = await ask({ title: '以下属于流动资产的有？', options: OPTS4, type: 'multiple' });
	check('多选「答案是 A、C 两项」→ A#C', multiple.ok && multiple.answer === 'A#C', JSON.stringify(multiple));

	const judge = await ask({ title: '会计恒等式为 资产=负债+所有者权益', options: '对\n错', type: 'judgement' });
	check('判断「这句话是正确的。」→ 对', judge.ok && judge.answer === '对', JSON.stringify(judge));

	const judgeNo = await ask({ title: 'NONE-JUDGE-错', options: '对\n错', type: 'judgement' });
	check('判断题 NONE 分支 → ok:false', judgeNo.ok === false, JSON.stringify(judgeNo));

	const fill2 = await ask({ title: '光合作用的场所是（ ），色素存在于（ ）', options: '', type: 'completion', blanks: 2 });
	check('填空 2 空 → 光合作用#叶绿体', fill2.ok && fill2.answer === '光合作用#叶绿体', JSON.stringify(fill2));

	const fill1 = await ask({ title: '光合作用的场所是（ ）', options: '', type: 'completion', blanks: 1 });
	check('填空 1 空 → 单字符串', fill1.ok && fill1.answer === '光合作用', JSON.stringify(fill1));

	const none = await ask({ title: 'NONE 这题我不会', options: OPTS4, type: 'single' });
	check('agent 返回 NONE → ok:false（OCS 视为未搜到）', none.ok === false && /NONE/.test(none.reason), JSON.stringify(none));

	const empty = await ask({ title: '', options: '', type: 'single' });
	check('空题干被拒', empty.ok === false);

	console.log('\n【3】缓存与并发');

	const q1 = await ask({ title: '缓存题：固定成本', options: OPTS4, type: 'single' });
	const q2 = await ask({ title: '缓存题：固定成本', options: OPTS4, type: 'single' });
	check('首次未命中缓存', q1.ok && q1.cached === false);
	check('二次命中缓存', q2.ok && q2.cached === true && q2.source === 'cache');

	const dupTitle = '并发去重题：' + Date.now();
	const [d1, d2, d3] = await Promise.all([
		ask({ title: dupTitle, options: OPTS4, type: 'single' }),
		ask({ title: dupTitle, options: OPTS4, type: 'single' }),
		ask({ title: dupTitle, options: OPTS4, type: 'single' })
	]);
	check('并发同题只调一次 agent（其余复用）', [d1, d2, d3].every((d) => d.ok) && [d2, d3].some((d) => d.deduped || d.cached));

	const cacheDump = await (await fetch(`${BASE}/cache?limit=5`, { headers: { 'x-ocs-token': TOKEN } })).json();
	check('GET /cache 可导出私有题库', cacheDump.ok && cacheDump.total >= 4);

	console.log('\n【4】提示词模版与教材');

	const pDefault = await (await fetch(`${BASE}/prompt?title=测试题干&options=A.%20甲%0AB.%20乙&type=single`, { headers: { 'x-ocs-token': TOKEN } })).json();
	check('/prompt 默认模版不含参考教材', pDefault.ok && !pDefault.prompt.includes('【参考教材】'), pDefault.prompt?.slice(0, 80));
	check('默认模版含题干/选项/输出规则', /测试题干/.test(pDefault.prompt) && /A\. 甲/.test(pDefault.prompt) && /【输出规则】/.test(pDefault.prompt));
	check('条件块生效：无选项时不输出「选项：」', !(await (await fetch(`${BASE}/prompt?title=只有题干&type=single`, { headers: { 'x-ocs-token': TOKEN } })).json()).prompt.includes('选项：'));
	check('default 模版不放开文件工具（省掉工具往返）', DEFAULTS.template === 'textbook' || pDefault.textbooks.needsFileAccess === false);
	check('联网搜索开启时 prompt 提示可用 web_access', pDefault.webSearch === true && /web_access/.test(pDefault.prompt));
	const pNoWeb = await (await fetch(`${BASE}/prompt?title=关掉联网&type=single&webSearch=false`, { headers: { 'x-ocs-token': TOKEN } })).json();
	check('单题 webSearch=false 时不提示联网（也不挂工具）', pNoWeb.webSearch === false && !/web_access/.test(pNoWeb.prompt));

	// 教材：prompt 里只给「教材在哪」，正文交给 agent 自己 grep/read
	const bookDir = path.join(workRoot, 'payload-books');
	fs.mkdirSync(bookDir, { recursive: true });
	fs.writeFileSync(path.join(bookDir, 'a-课程规范.md'), '【A课程】1+1 的结果在 2024 版规范中被定义为 7。'.padEnd(300, '。'), 'utf8');
	fs.writeFileSync(path.join(bookDir, 'b-补充.txt'), '【B补充】1+1 的结果在补充材料里被定义为 8。'.padEnd(300, '。'), 'utf8');
	fs.writeFileSync(path.join(bookDir, 'scan.pdf'), 'x'.repeat(80 * 1024), 'utf8');

	const pBook = await (
		await fetch(`${BASE}/prompt?title=测试题干&type=single&template=textbook&textbooks=${encodeURIComponent(bookDir)}`, {
			headers: { 'x-ocs-token': TOKEN }
		})
	).json();
	check('textbook 模版给出教材位置与文件清单', pBook.ok && pBook.prompt.includes('教材目录：') && pBook.prompt.includes('a-课程规范.md'), pBook.prompt?.slice(0, 120));
	check('教材正文不进 prompt（只提示位置）', !pBook.prompt.includes('定义为 7') && pBook.textbooks.excerptChars === 0, `excerptChars=${pBook.textbooks?.excerptChars}`);
	check('非文本文件被标注（PDF 需先转文本）', /scan\.pdf/.test(pBook.prompt) && /PDF/.test(pBook.prompt));
	check('textbook 模版要求 agent 用工具查教材', /grep/.test(pBook.prompt) && /优先依据/.test(pBook.prompt));
	check('textbook 模版标记 needsFileAccess（runner 放开 read/bash）', pBook.textbooks.needsFileAccess === true);
	check('教材 prompt 体积与教材大小无关（<1500 字符）', pBook.chars < 1500, `${pBook.chars} 字符`);

	const pExcerpt = await (
		await fetch(`${BASE}/prompt`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-ocs-token': TOKEN },
			body: JSON.stringify({ title: '节选测试', template: 'textbook', textbookExcerpt: '【节选】1+1 在本节中定义为 7。' })
		})
	).json();
	check('payload.textbookExcerpt 可显式附正文节选（可选路径）', pExcerpt.prompt.includes('【节选】1+1 在本节中定义为 7。'), pExcerpt.prompt?.slice(0, 100));

	const customText = '自定义模版开始\n题目={{title}}\n{{rules}}\n自定义模版结束';
	const pCustom = await (
		await fetch(`${BASE}/prompt`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-ocs-token': TOKEN },
			body: JSON.stringify({ title: '自定义题干', template: customText })
		})
	).json();
	check('自定义模版文本可用（{{title}}/{{rules}} 生效）', pCustom.ok && pCustom.prompt.includes('自定义模版开始') && pCustom.prompt.includes('自定义题干') && pCustom.prompt.includes('【输出规则】'));
	check('自定义模版 id 记为 custom', pCustom.template.id === 'custom', JSON.stringify(pCustom.template));

	const pUnknown = await (
		await fetch(`${BASE}/prompt`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-ocs-token': TOKEN },
			body: JSON.stringify({ title: 'x', template: '题目={{title}} 未知={{nope}}' })
		})
	).json();
	check('未知占位符原样保留（便于排查拼写）', pUnknown.prompt.includes('{{nope}}'));

	// 缓存变体：教材/模版不同 → 不能复用旧答案
	const variantTitle = '教材变体题：' + Date.now();
	const dirA = path.join(workRoot, 'books-A');
	const dirB = path.join(workRoot, 'books-B');
	fs.mkdirSync(dirA, { recursive: true });
	fs.mkdirSync(dirB, { recursive: true });
	fs.writeFileSync(path.join(dirA, '规范.md'), 'A 版规范', 'utf8');
	fs.writeFileSync(path.join(dirB, '规范.md'), 'B 版规范', 'utf8');
	const vA = await ask({ title: variantTitle, options: OPTS4, type: 'single', template: 'textbook', textbooks: dirA });
	const vB = await ask({ title: variantTitle, options: OPTS4, type: 'single', template: 'textbook', textbooks: dirB });
	const vB2 = await ask({ title: variantTitle, options: OPTS4, type: 'single', template: 'textbook', textbooks: dirB });
	check('换教材不复用缓存（教材指纹入 key）', vA.cached === false && vB.cached === false && vB2.cached === true, `A=${vA.cached} B=${vB.cached} B2=${vB2.cached}`);

	const tplVariant = await ask({ title: variantTitle, options: OPTS4, type: 'single', template: 'default' });
	check('换模版不复用缓存（同教材不同模版）', tplVariant.cached === false || tplVariant.deduped === true, JSON.stringify({ cached: tplVariant.cached }));

	// ========== 配置文件 + 教材目录 ==========
	console.log('\n【5】配置文件 / 教材目录 / 自定义模版文件');

	fs.mkdirSync(path.join(workRoot, 'books'), { recursive: true });
	fs.writeFileSync(path.join(workRoot, 'books', 'a-课程规范.md'), '【A课程】1+1 的结果在 2024 版规范中被定义为 7。'.padEnd(300, '。'), 'utf8');
	fs.writeFileSync(path.join(workRoot, 'books', 'b-补充.txt'), '【B补充】多余的教材内容，用于测试截断行为。'.padEnd(400, '。'), 'utf8');
	// 故意写成「带行尾注释」的 JSON：旧版 stripComments 只剥整行 //，示例配置自己都解析不了
	const cfgWithComments = `{
  // 整行注释
  "host": "127.0.0.1",
  "port": 8898,                 // 行尾注释：端口
  "runner": "mock",
  "timeout": 4000,
  "ocsTimeout": 120000,
  "noCache": true,
  "template": "textbook",
  "textbooks": "./books",
  "textbookMaxChars": 500,
  "webSearch": true,            // 行尾注释：联网开关
  "webSearchExt": ""            /* 块注释：插件入口留空 */
}`;
	fs.writeFileSync(path.join(workRoot, 'answerer.json'), cfgWithComments, 'utf8');

	// 示例配置自己必须能加载：里面有行尾注释和块注释，旧版 stripComments 会直接炸
	const example = (await import('./config.mjs')).resolveConfig({ argv: ['--config', path.join(HERE, 'config.example.json')] });
	check(
		'config.example.json 可解析且无未知键',
		example.meta.unknownKeys.length === 0 && example.opts.webSearch === true && example.opts.port === 8787,
		JSON.stringify(example.meta.unknownKeys)
	);

	const BASE2 = await startServer(['--config', path.join(workRoot, 'answerer.json')], 8898);
	const health2 = await (await fetch(`${BASE2}/health`)).json();
	check('--config 切换模版为 textbook', health2.template.id === 'textbook', JSON.stringify(health2.template));
	check('--config 里的 ocsTimeout 生效（120s，不再限制 60s）', health2.budget.ocsTimeoutMs === 120000, JSON.stringify(health2.budget));
	check('--config 里的 timeout 生效', health2.budget.timeoutMs === 4000);
	check('教材目录加载（2 个文件，超出预算截断）', health2.textbooks.files.length === 2 && health2.textbooks.truncated === true, JSON.stringify(health2.textbooks));

	const prompt2 = await (await fetch(`${BASE2}/prompt?title=配置生效测试&type=single`)).json();
	check('配置文件下 /prompt 带教材位置', prompt2.prompt.includes('a-课程规范.md') && prompt2.prompt.includes('教材目录：'), prompt2.chars + ' 字符');
	check('--textbook-max-chars 500 时才注入正文节选', prompt2.prompt.includes('定义为 7') && prompt2.textbooks.excerptChars > 0 && prompt2.textbooks.excerptChars <= 520, `excerptChars=${prompt2.textbooks.excerptChars}`);
	check('textbook 模版在配置文件下放开工具', prompt2.textbooks.needsFileAccess === true);

	// 自定义模版文件优先级最高
	const tplFile = path.join(workRoot, 'my-template.md');
	fs.writeFileSync(tplFile, '【我的模版】\n{{title}}\n{{rules}}\n结束', 'utf8');
	const BASE3 = await startServer(['--runner', 'mock', '--port', '8897', '--prompt', tplFile, '--no-web-search'], 8897);
	const health3 = await (await fetch(`${BASE3}/health`)).json();
	check('--prompt 自定义模版文件生效', String(health3.template.id).startsWith('file:my-template.md'), JSON.stringify(health3.template));
	check('--no-web-search 关掉插件（health 显示未挂载）', health3.webSearch.enabled === false && health3.webSearch.requested === false, JSON.stringify(health3.webSearch));
	const prompt3 = await (await fetch(`${BASE3}/prompt?title=文件模版题干&type=single`)).json();
	check('自定义模版文件渲染正确', prompt3.prompt.includes('【我的模版】') && prompt3.prompt.includes('文件模版题干'));
} catch (err) {
	console.error('\n💥 测试异常:', err);
	fail++;
} finally {
	for (const c of children) c.kill();
	fs.existsSync(cacheFile) && fs.unlinkSync(cacheFile);
	fs.rmSync(workRoot, { recursive: true, force: true });
	console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
	process.exit(fail ? 1 : 0);
}
