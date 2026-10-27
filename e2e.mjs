#!/usr/bin/env node
/**
 * 真机 E2E：起一个真 runner 的 server，跑四种题型 + 图片题，验证「说人话」的 agent 输出被规整成 OCS 能吃的形状。
 *
 *   node e2e.mjs                    # 默认 --runner pi
 *   node e2e.mjs --runner claude    # 换成 claude code
 *   node e2e.mjs --port 8891 --keep # 跑完不杀进程
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8891));
const RUNNER = arg('runner', 'pi');
const BASE = `http://127.0.0.1:${PORT}`;
const cacheFile = path.join(os.tmpdir(), `ocs-agent-e2e-${Date.now()}.json`);

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name} —— ${detail}`);
	} else {
		fail++;
		console.log(`  ❌ ${name} —— ${detail}`);
	}
};

const MODEL = arg('model', '');

// 模型的随机性会咬人：同一道题偶尔会回 NONE（「不确定就别猜」是提示词里的硬规则）。
// 这种属于模型抖动而不是服务端问题，记成「跳过」而不是失败——否则 e2e 每次跑都要掷骰子。
const skip = (name, reason) => console.log(`  ⏭  ${name} —— 跳过（${reason}）`);
// 联网题要搜+抓页面，比纯推理慢得多，单题超时给宽松点
const serverArgs = [HERE + '/server.mjs', '--runner', RUNNER, '--port', String(PORT), '--cache', cacheFile, '--timeout', arg('timeout', '150000')];
if (MODEL) serverArgs.push('--model', MODEL);
const child = spawn(process.execPath, serverArgs, {
	stdio: ['ignore', 'pipe', 'pipe'],
	windowsHide: true
});
child.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[server] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function waitReady() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`${BASE}/health`);
			if (r.ok) return;
		} catch {
			/* not up */
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error('server 启动超时');
}

async function ask(payload) {
	const t0 = Date.now();
	const r = await fetch(`${BASE}/ask`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ payload })
	});
	const j = await r.json();
	return { ...j, wallMs: Date.now() - t0 };
}

try {
	await waitReady();
	console.log(`\n=== 真机 E2E（runner=${RUNNER}）===\n`);

	const single = await ask({ title: '下列哪项属于固定成本？', options: 'A. 厂房租金\nB. 原材料\nC. 销售提成\nD. 包装材料', type: 'single' });
	check('单选 → 字母', single.ok && single.answer === 'A', `${single.answer} (${single.wallMs}ms, model=${single.meta?.model ?? '-'})`);

	const multiple = await ask({ title: '以下属于流动资产的有？', options: 'A. 库存现金\nB. 固定资产\nC. 应收账款\nD. 无形资产', type: 'multiple' });
	check('多选 → A#C', multiple.ok && multiple.answer === 'A#C', `${multiple.answer} (${multiple.wallMs}ms)`);

	const judgeT = await ask({ title: '会计恒等式为：资产 = 负债 + 所有者权益。', options: '对\n错', type: 'judgement' });
	check('判断(真) → 对', judgeT.ok && judgeT.answer === '对', `${judgeT.answer} (${judgeT.wallMs}ms)`);

	const judgeF = await ask({ title: '企业发生亏损时，所有者权益会增加。', options: '对\n错', type: 'judgement' });
	check('判断(假) → 错', judgeF.ok && judgeF.answer === '错', `${judgeF.answer} (${judgeF.wallMs}ms)`);

	const fill = await ask({ title: '光合作用的场所是（ ），色素主要存在于（ ）', options: '', type: 'completion', blanks: 2 });
	check('填空 2 空 → # 分隔', fill.ok && (fill.answer || '').split('#').length === 2, `${fill.answer} (${fill.wallMs}ms)`);

	// 教材模版：prompt 只给「教材在哪」，答案藏在教材深处 → 验证 agent 真的用工具读了教材
	const bookDir = path.join(os.tmpdir(), `ocs-e2e-books-${Date.now()}`);
	fs.mkdirSync(bookDir, { recursive: true });
	const filler = Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 条：与本课程无关的条文，用于把关键条款挤到文件深处。`);
	filler.splice(280, 0, '第 281 条：按本课程标准，水的标准沸点被规定为 90 摄氏度，考试一律答 90 摄氏度，不得使用其他来源数据。');
	fs.writeFileSync(path.join(bookDir, 'XX课程规范.md'), ['# XX 课程规范（节选）', ...filler].join('\n'), 'utf8');
	const qBook = { title: '按本课程标准，水的沸点是多少摄氏度？', options: '', type: 'completion', blanks: 1 };
	const noBook = await ask(qBook);
	const withBook = await ask({ ...qBook, template: 'textbook', textbooks: bookDir });
	if (noBook.ok) check('无教材模式按常识作答（≈100℃）', /100/.test(noBook.answer), `${noBook.answer} (${noBook.wallMs}ms)`);
	else skip('无教材模式按常识作答（≈100℃）', `模型拒答：${noBook.reason || 'ok:false'}（${noBook.wallMs}ms），对照组少一半，不影响教材模式结论`);
	check('教材模式自己查教材后按教材作答（90℃）', withBook.ok && /90/.test(withBook.answer) && !/100/.test(withBook.answer), `${withBook.answer} (${withBook.wallMs}ms, template=${withBook.template}, prompt=${withBook.promptChars}字)`);
	check('教材模式的 prompt 不含教材正文（只给位置）', withBook.promptChars < 1500, `promptChars=${withBook.promptChars}`);
	fs.rmSync(bookDir, { recursive: true, force: true });

	// 图片题：给一张带算式的 PNG，看 agent 会不会用 read 工具看图
	const png = path.join(os.tmpdir(), `ocs-e2e-img-${Date.now()}.png`);
	const { execSync } = await import('node:child_process');
	try {
		execSync(
			`python -c "from PIL import Image,ImageDraw;import base64;im=Image.new('RGB',(260,70),'white');ImageDraw.Draw(im).text((10,22),'2 + 3 = ?',fill='black');im.save(r'${png}')"`,
			{ stdio: 'ignore' }
		);
		const b64 = fs.readFileSync(png).toString('base64');
		const img = await ask({ title: '计算图片中的算式结果', options: 'A. 4\nB. 5\nC. 6\nD. 7', type: 'single', images: [`data:image/png;base64,${b64}`] });
		check('图片题 → 看图作答', img.ok && img.answer === 'B', `${img.answer} (${img.wallMs}ms)${img.ok ? '' : ` reason=${img.reason}（图片题需要能看图的模型，小模型/本地模型会答 NONE；用 --model 指一个视觉模型）`}`);
		fs.unlinkSync(png);
	} catch (e) {
		console.log(`  ⏭  图片题跳过（生成测试图失败：${e.message}）`);
	}

	const cached = await ask({ title: '下列哪项属于固定成本？', options: 'A. 厂房租金\nB. 原材料\nC. 销售提成\nD. 包装材料', type: 'single' });
	check('重复题命中缓存', cached.cached === true, `${cached.answer} (${cached.wallMs}ms)`);

	// 联网搜索：答案只在网上（README 里的 token benchmark 数字），模型必须真的调 web_access 才可能答对
	const web = await ask({
		title: '查一下 GitHub 上的 pi-web-access-lean 项目：它的 token benchmark 里，lean 版工具定义占多少 token（纯数字）？',
		type: 'completion',
		blanks: 1
	});
	check('联网搜索：agent 真的调用了 web_access（tools 里能看到）', Array.isArray(web.tools) && web.tools.includes('web_access'), JSON.stringify(web.tools) + ` (${web.wallMs}ms)`);
	// 回归守卫：pi 只该把 --tools 白名单里的工具注册给模型。项目 .pi/settings.json 里的开发插件
	// （compress/todo/replace/ask_user_question…）一个都不该漏进来。
	const leaked = (web.agentTools ?? []).filter((t) => !['read', 'bash', 'web_access'].includes(t));
	check('agent 没有多拿工具（无项目插件泄漏）', Array.isArray(web.agentTools) && leaked.length === 0, JSON.stringify(web.agentTools));
	check('联网搜索：按格式给出纯数字答案（内容准不准取决于模型与检索结果）', web.ok && /^[0-9]+$/.test(String(web.answer).trim()), `${web.answer} (${web.wallMs}ms, promptChars=${web.promptChars})`);

	const health = await (await fetch(`${BASE}/health`)).json();
	check('metrics 记录了调用', health.metrics.agentCalls >= 5, `agentCalls=${health.metrics.agentCalls} avg=${health.metrics.avgAgentMs}ms cacheSize=${health.cache.size}`);
} catch (err) {
	console.error('\n💥 异常:', err);
	fail++;
} finally {
	if (!process.argv.includes('--keep')) child.kill();
	if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
	console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
	process.exit(fail ? 1 : 0);
}
