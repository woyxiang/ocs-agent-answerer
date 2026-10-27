/**
 * 提示词模版
 *
 * 模版 = 一段字符串 + 占位符。内置两套（无教材 / 参考教材），也可以 --prompt <文件> 全自定义。
 *
 * 可用占位符：
 *   {{title}} {{options}} {{type}} {{typeLabel}} {{blanks}}
 *   {{blanksLine}} {{imageCount}} {{imageList}}
 *   {{textbooks}}          教材在哪（路径清单，不是正文）
 *   {{textbookExcerpt}}    教材正文节选（仅当 --textbook-max-chars > 0，默认空）
 *   {{suggestionTitle}} {{suggestionOptions}} {{rules}}
 *
 * 条件块（不支持同类嵌套，够用就行）：
 *   {{#if key}}...{{/if}}         key 非空才保留
 *   {{#unless key}}...{{/unless}} key 为空才保留
 *
 * 自定义模版的好处：不用改代码就能调语气/加学科约束/塞本校题库片段；
 * 记得保留 {{rules}} 或自己写一份等价的输出规则，否则答案格式会漂，OCS 匹配不上。
 */

/** 输出规则是所有模版共用的部分，自定义模版里写 {{rules}} 即可复用 */
export const RULES = [
	'【输出规则】只输出答案本身，一行，不要 Markdown、不要代码块、不要标点解释：',
	'- 单选题：只输出正确选项的字母（如 A）；选项没有字母前缀时输出选项原文。',
	'- 多选题：输出全部正确选项字母，用 # 分隔（如 A#C）。',
	'- 判断题：只输出 对 或 错。',
	'- 填空题：按空白顺序输出各空答案，用 # 分隔（如 光合作用#叶绿体）。',
	'- 若信息不足、完全无法作答（含纯图片题看不清）：只输出 NONE。',
	'{{#if webSearch}}拿不准时可用 web_access 工具联网搜一次再答（能直接答就别搜）。{{/if}}'
].join('\n');

/** 模版一：无教材模式（纯通用知识，最快最省 token） */
const DEFAULT_TEXT = `你是一台自动答题后端。每次只会收到一道题，请作答，不要提问、不要解释、不要寒暄。

题型：{{typeLabel}}（{{type}}）
题目：{{title}}
{{#if options}}
选项：
{{options}}
{{/if}}{{#if blanksLine}}{{blanksLine}}
{{/if}}{{#if imageList}}
本题含 {{imageCount}} 张图片，已保存到本地，请用 read 工具读取后再作答：
{{imageList}}
{{/if}}
{{rules}}`;

/**
 * 模版二：参考教材模式
 *
 * 注意这里**不塞教材正文**，只给出教材位置，让 agent 自己 grep/read 相关章节：
 * 一本教材几十万字，塞进 prompt 每章十几万 token，而按预算截断只会截到封面和目录 —— 花钱买垃圾。
 * agent 本来就有工具，按题去查才是对的。
 */
const TEXTBOOK_TEXT = `你是一台自动答题后端。每次只会收到一道题，请作答，不要提问、不要解释、不要寒暄。

本题提供了参考教材，它们存放在本地：
{{textbooks}}

作答要求：
1. 需要教材依据时，自己动手去查上面这些文件的相关章节（用 read 读片段、用 bash 里的 grep / findstr / Select-String 定位关键词），不要整本通读。
2. 优先依据教材的表述作答；教材与你的记忆冲突时，以教材为准，不要解释原因。
3. 教材里确实查不到依据时，用你的通用知识作答 —— 不要仅仅因为没找到就回答 NONE。
{{#if textbookExcerpt}}
【参考教材正文节选】
{{textbookExcerpt}}
{{/if}}
题型：{{typeLabel}}（{{type}}）
题目：{{title}}
{{#if options}}
选项：
{{options}}
{{/if}}{{#if blanksLine}}{{blanksLine}}
{{/if}}{{#if imageList}}
本题含 {{imageCount}} 张图片，已保存到本地，请用 read 工具读取后再作答：
{{imageList}}
{{/if}}
{{rules}}`;

/** 模版三：无教材 + 页面提示（OCS 会把页面上的「建议答案」一起传过来时可用） */
const HINT_TEXT = `你是一台自动答题后端。每次只会收到一道题，请作答，不要提问、不要解释、不要寒暄。

题型：{{typeLabel}}（{{type}}）
题目：{{title}}
{{#if options}}
选项：
{{options}}
{{/if}}{{#if suggestionTitle}}
页面已给出的建议答案（仅作参考，若明显错误请给出你认为正确的答案）：
{{suggestionTitle}}
{{suggestionOptions}}
{{/if}}{{#if blanksLine}}{{blanksLine}}
{{/if}}{{#if imageList}}
本题含 {{imageCount}} 张图片，已保存到本地，请用 read 工具读取后再作答：
{{imageList}}
{{/if}}
{{rules}}`;

export const TEMPLATES = {
	default: {
		id: 'default',
		label: '无教材模式',
		description: '只用模型通用知识作答，prompt 最短、延迟最低',
		text: DEFAULT_TEXT
	},
	textbook: {
		id: 'textbook',
		label: '参考教材模式',
		description: '告诉 agent 教材在本地哪个目录，要求它按需 grep/read 相关章节并优先按教材作答',
		text: TEXTBOOK_TEXT
	},
	hint: {
		id: 'hint',
		label: '页面提示模式',
		description: '附带 OCS 传上来的页面建议答案作为参考',
		text: HINT_TEXT
	}
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

export function listTemplates() {
	return TEMPLATE_NAMES.map((id) => ({
		id,
		label: TEMPLATES[id].label,
		description: TEMPLATES[id].description
	}));
}

/**
 * 解析模版：传名字取内置模版，传一段多行文本当成自定义模版。
 * @returns {{ id: string, label: string, text: string }}
 */
export function resolveTemplate(nameOrText) {
	const input = String(nameOrText ?? '').trim();
	if (!input) return { ...TEMPLATES.default };
	if (TEMPLATES[input]) return { ...TEMPLATES[input] };
	// 看起来像模版正文（含占位符或多行）就当成自定义模版
	if (input.includes('{{') || input.includes('\n')) {
		return { id: 'custom', label: '自定义模版', text: input };
	}
	throw new Error(`未知模版 "${input}"，内置可选：${TEMPLATE_NAMES.join(' / ')}（或传一段含 {{placeholders}} 的文本当自定义模版）`);
}

function isTruthy(v) {
	if (Array.isArray(v)) return v.length > 0;
	return v !== undefined && v !== null && String(v).trim() !== '';
}

/** 处理 {{#if x}}...{{/if}} / {{#unless x}}...{{/unless}} */
function renderBlocks(tpl, ctx) {
	const re = /\{\{#(if|unless)\s+(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
	let out = tpl;
	let guard = 0;
	while (re.test(out) && guard++ < 20) {
		re.lastIndex = 0;
		out = out.replace(re, (_m, kind, key, body) => {
			const ok = isTruthy(ctx[key]);
			return kind === 'if' ? (ok ? body : '') : ok ? '' : body;
		});
	}
	return out;
}

/** 渲染模版；未知占位符原样保留（方便你看出来自己写错了） */
export function renderTemplate(text, ctx) {
	let out = renderBlocks(String(text ?? ''), ctx);
	out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in ctx ? String(ctx[key] ?? '') : m));
	// 占位符的值里也可能含条件块（{{rules}} 会按 webSearch 开关一段），替换后再过一遍
	if (out.includes('{{#')) out = renderBlocks(out, ctx);
	// 清理条件块留下的空行，避免 prompt 里出现 3 个以上连续换行
	out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
	return out;
}
