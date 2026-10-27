/**
 * 端到端校验：agent 答案 → OCS 官方解析器 → 最终选中的选项/答案
 *
 * 说明：answerer.test.ts 只验证「题库返回了什么」，不验证「OCS 能不能匹配上」。
 * 本脚本跑完整链路：defaultAnswerWrapperHandler（真实 HTTP → agent）→ resolveSingle/resolveMultiple/
 * resolveJudgement/resolveCompletion，因此能证明 agent 的自由文本真的被 OCS 吃进去了。
 *
 * 用法（在 ocsjs 仓库根目录）：
 *   node_modules/.bin/tsx --import ./tests/setup-browser-env.ts agent-resolver.check.ts
 */
import fs from 'fs';
import { AnswerWrapperParser } from './packages/core/src/core/answer-wrapper/answer.wrapper.parser';
import { defaultAnswerWrapperHandler } from './packages/core/src/core/answer-wrapper/answer.wrapper.handler';
import { buildAnswererEnv } from './packages/scripts/src/utils/answerer-env';
import { splitAnswer } from './packages/core/src/core/worker/utils';
import { resolveSingle } from './packages/core/src/core/worker/resolvers/single';
import { resolveMultiple } from './packages/core/src/core/worker/resolvers/multiple';
import { resolveJudgement } from './packages/core/src/core/worker/resolvers/judgement';
import { resolveCompletion } from './packages/core/src/core/worker/resolvers/completion';
import { $ } from './packages/core/src/utils/common';

const SEP = ['===', '#', '---', '###', '|', ';', '；'];
const wrappers = AnswerWrapperParser.from(JSON.parse(fs.readFileSync('./e2e-agent.config.json', 'utf8')).wrappers);

async function askOnce({ type, title, options }: { type: string; title: string; options: string[] }) {
	const { env } = await buildAnswererEnv({ type, title, options });
	const infos = await defaultAnswerWrapperHandler(wrappers, env);
	const answers = infos.flatMap((i) => (i.results || []).map((r: any) => r.answer)).filter(Boolean) as string[];
	const errors = infos.map((i) => i.error).filter(Boolean);
	return { answers, errors, env };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail: string) {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name} —— ${detail}`);
	} else {
		fail++;
		console.log(`  ❌ ${name} —— ${detail}`);
	}
}

async function main() {
	// 与 tests/answerer.test.ts 一致：强制 Node 环境，GM_xmlhttpRequest 类型会自动降级为 node-fetch
	$.isInBrowser = () => false;
console.log('\n=== agent → OCS 解析器 端到端校验 ===\n');

// 1. 单选
{
	const options = ['A. 厂房租金', 'B. 原材料', 'C. 销售提成', 'D. 包装材料'];
	const { answers, errors } = await askOnce({ type: 'single', title: '下列哪项属于固定成本？', options });
	const r = resolveSingle(answers, options, SEP);
	check('单选 resolveSingle', r.finish && r.option === 'A. 厂房租金', `agent答案=${JSON.stringify(answers)} → option=${r.option} ratings=${JSON.stringify(r.ratings)} ${errors.join('|')}`);
}

// 2. 多选
{
	const options = ['A. 库存现金', 'B. 固定资产', 'C. 应收账款', 'D. 无形资产'];
	const { answers, errors } = await askOnce({ type: 'multiple', title: '以下属于流动资产的有？', options });
	const r = resolveMultiple(answers, options, SEP);
	// 纯 ABCD 答案走 plainOptions 兜底（与 question.resolver.ts 的 multiple 处理器一致）
	const got = (r.finish ? r.options ?? r.plainOptions : undefined) || [];
	check('多选 resolveMultiple', r.finish && got.join('|') === 'A. 库存现金|C. 应收账款', `agent答案=${JSON.stringify(answers)} → options=${got.join('|')} ${errors.join('|')}`);
}

// 3. 判断题（真）
{
	const options = ['对', '错'];
	const { answers, errors } = await askOnce({ type: 'judgement', title: '会计恒等式为：资产 = 负债 + 所有者权益。', options });
	const r = resolveJudgement(answers.map((a) => splitAnswer(a, SEP)), options);
	check('判断 resolveJudgement(真)', r.finish && r.option === '对', `agent答案=${JSON.stringify(answers)} → option=${r.option} ${errors.join('|')}`);
}

// 4. 判断题（假）
{
	const options = ['对', '错'];
	const { answers, errors } = await askOnce({ type: 'judgement', title: '企业发生亏损时，所有者权益会增加。', options });
	const r = resolveJudgement(answers.map((a) => splitAnswer(a, SEP)), options);
	check('判断 resolveJudgement(假)', r.finish && r.option === '错', `agent答案=${JSON.stringify(answers)} → option=${r.option} ${errors.join('|')}`);
}

// 5. 填空 2 空
{
	const { answers, errors } = await askOnce({ type: 'completion', title: '光合作用的场所是（ ），色素主要存在于（ ）', options: [] });
	const r = resolveCompletion(answers.map((a) => splitAnswer(a, SEP)), 2);
	const got = (r.answers || []).join('|');
	check('填空 resolveCompletion(2空)', r.finish && got === '叶绿体|类囊体薄膜', `agent答案=${JSON.stringify(answers)} → answers=${got} ${errors.join('|')}`);
}

// 6. 无法作答 → OCS 视为未搜到（不会乱填）
{
	const { answers } = await askOnce({ type: 'single', title: 'zzz-这道题的正确答案是无法确定-请只输出NONE', options: ['A. 甲', 'B. 乙'] });
	const r = resolveSingle(answers, ['A. 甲', 'B. 乙'], SEP);
	check('NONE 分支不会乱选', answers.length === 0 || !r.finish, `agent答案=${JSON.stringify(answers)} → finish=${r.finish} option=${r.option}`);
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
}

main();
