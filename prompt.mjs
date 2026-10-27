/**
 * 提示词构造 + agent 输出规整
 *
 * 关键背景：OCS 侧的答案匹配器（packages/core/src/core/worker/resolvers/*.ts）对答案格式有偏好：
 *  - single     : 归一化精确匹配 → 相似度>0.6 → 纯 ABCD 兜底（返回字母最稳）
 *  - multiple   : 「答案 ⊇ 选项」归一化包含匹配 → 相似度 → 纯 ABCD（字母 # 分隔最稳）
 *  - judgement  : 关键词表 是/对/正确/√/true/T/yes/1  vs  否/错/×/false/F/no/0
 *  - completion : 按分隔符切分（默认 ['===','#','---','###','|',';','；']）
 * 所以这里把 agent 的自由文本压成上述形状。
 */

import { resolveTemplate, renderTemplate, RULES } from './templates.mjs';

const TYPE_LABEL = {
	single: '单选题',
	multiple: '多选题',
	judgement: '判断题',
	completion: '填空题',
	unknown: '未知题型'
};

/**
 * 构造 prompt。模版负责「说什么」，这里只负责把 job 摊成占位符上下文。
 *
 * @param {object} job  { title, options, type, blanks, imageFiles, suggestionTitle, suggestionOptions }
 * @param {object} [opt]
 * @param {string|{text:string}} [opt.template] 内置模版名 / 模版对象 / 模版正文，默认 default
 * @param {string} [opt.templateText] 已解析好的模版正文（优先级最高）
 * @param {string} [opt.textbooks] 教材位置描述（对应 {{textbooks}}，是「教材在哪」而不是正文）
 * @param {string} [opt.textbookExcerpt] 可选的教材正文节选（对应 {{textbookExcerpt}}，默认空）
 */
export function buildPrompt(job, opt = {}) {
	const tplText = resolveText(opt);
	const imageFiles = job.imageFiles || [];
	const blanks = Number(job.blanks) || 0;

	return renderTemplate(tplText, {
		title: job.title || '(题干为空)',
		question: job.title || '(题干为空)',
		options: String(job.options || '').trim(),
		type: job.type || 'unknown',
		typeLabel: TYPE_LABEL[job.type] || TYPE_LABEL.unknown,
		blanks,
		blanksLine: blanks > 1 ? `填空数量：${blanks} 个空` : '',
		imageCount: imageFiles.length,
		imageList: imageFiles.map((f, i) => `[图片${i + 1}] ${f}`).join('\n'),
		textbooks: String(opt.textbooks || '').trim(),
		textbookExcerpt: String(opt.textbookExcerpt || '').trim(),
		suggestionTitle: job.suggestionTitle || '',
		suggestionOptions: job.suggestionOptions || '',
		webSearch: opt.webSearch ? '1' : '',
		rules: RULES
	});
}

function resolveText(opt) {
	if (opt.templateText) return opt.templateText;
	const t = opt.template;
	if (t && typeof t === 'object' && typeof t.text === 'string') return t.text;
	return resolveTemplate(t ?? 'default').text;
}

// ========== 答案规整 ==========

const TRUTHY = /^(√|正确|对的|是的|对|是|true|t|yes|y|1)$/i;
const FALSY = /^(×|✗|错误|不对|不正确|错|否|false|f|no|n|0)$/i;

function stripNoise(input) {
	let t = String(input ?? '').trim();
	// 去代码块围栏
	t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
	// 去常见前缀（容忍 "正确答案是：/答案是/答案为/答案："）
	t = t.replace(/^(?:正确答案是|最终答案|正确答案|参考答案|答案|answer|选项)\s*(?:是|为|有)?\s*[:：]?\s*/i, '').trim();
	// 去「两项 / 3个 / 共两个空」这类计数尾巴
	t = t.replace(/[\s，,。]*[（(]?\s*共?\s*[一二两三四五六七八九十\d]+\s*(?:项|个选项|个空|处|个)\s*[)）]?\s*$/, '').trim();
	// 去包裹引号/括号
	t = t.replace(/^[「『"'“”‘’（(【\[]+/, '').replace(/[」』"'“”‘’）)】\]]+$/, '').trim();
	return t;
}

/** 首个非空行 */
function firstLine(t) {
	return t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
}

/** 纯字母答案（ABC / A,B,C / A#C / A、C）→ 字母数组，否则 null */
function lettersOf(s) {
	const cleaned = s.replace(/[\s,，;；、/|#&+．.()（）\[\]:：\-–—]/g, '');
	if (cleaned.length >= 1 && cleaned.length <= 8 && /^[A-Ha-h]+$/.test(cleaned)) {
		return cleaned.toUpperCase().split('');
	}
	return null;
}

/** 把 "A. 内容" / "A、内容" / "A）内容" 拆成 [字母, 内容] */
function splitOption(part) {
	const m = part.match(/^([A-Ha-h])\s*[.、,，)）:：]\s*(.*)$/);
	return m ? { letter: m[1].toUpperCase(), text: m[2].trim() } : null;
}

/** 判断题：先判伪再判真（"不正确" 含 "正确"，顺序不能反） */
function normalizeJudgement(t, options) {
	const flat = t.replace(/[\s。.!！?？]/g, '');
	// 整句关键词：先判伪再判真（"不正确" / "不是正确" 都含 "正确"，顺序不能反）
	if (/不正确|不对|不是正确|错误|错的|不是的|^非|^false|^no$|^0$/.test(flat)) return '错';
	if (/正确|对的|是的|√|^true|^yes/.test(flat)) return '对';
	// 单字/单词回答
	if (/^(错|否|×|✗|f|n)$/i.test(flat)) return '错';
	if (/^(对|是|真|t|y|1)$/i.test(flat)) return '对';
	// 只回答了字母：按选项原文判定
	const L = lettersOf(firstLine(t).replace(/[。.!！]$/, ''));
	if (L && L.length === 1 && options) {
		const opts = options.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
		const letters = opts.map((o, i) => splitOption(o)?.letter || String.fromCharCode(65 + i));
		const idx = letters.indexOf(L[0]);
		if (idx !== -1) {
			const text = (splitOption(opts[idx])?.text ?? opts[idx]).trim();
			if (FALSY.test(text)) return '错';
			if (TRUTHY.test(text)) return '对';
		}
	}
	return null;
}

/**
 * 规整 agent 输出。
 * @returns {string|null} null = 视为未搜到（NONE / 空）
 */
export function normalizeAnswer(raw, { type = 'unknown', options = '', blanks = 0 } = {}) {
	let t = stripNoise(raw);
	if (!t) return null;
	if (/^(none|n\/a|na|无|无答案|不知道|无法作答|unable)$/i.test(t.replace(/[。.!！]$/, ''))) return null;

	let out;
	switch (type) {
		case 'judgement': {
			const j = normalizeJudgement(t, options);
			out = j ?? firstLine(t);
			break;
		}
		case 'single': {
			const line = firstLine(t);
			const L = lettersOf(line.replace(/[。.!！]$/, ''));
			if (L && L.length) out = L[0];
			else out = splitOption(line)?.letter ?? line;
			break;
		}
		case 'multiple': {
			const flat = t.replace(/\r?\n/g, '#');
			const L = lettersOf(flat);
			if (L) {
				out = [...new Set(L)].sort().join('#');
				break;
			}
			const parts = flat
				.split(/#|\||;|；|,|，|、|\//)
				.map((p) => stripNoise(p))
				.filter(Boolean);
			const letters = parts.map((p) => splitOption(p)?.letter ?? (lettersOf(p)?.[0] ?? null));
			out = letters.length && letters.every(Boolean) ? [...new Set(letters)].sort().join('#') : parts.join('#');
			break;
		}
		case 'completion': {
			const parts = t
				.split(/\r?\n|#/)
				.map((p) => stripNoise(p))
				.filter(Boolean);
			if (blanks > 1) out = parts.slice(0, blanks).join('#');
			else if (parts.length === 1) out = parts[0];
			else out = parts.join(' ');
			break;
		}
		default: {
			out = firstLine(t) || t;
			break;
		}
	}

	out = String(out ?? '').trim();
	if (!out) return null;
	// 防御：agent 抽风输出长文时截断，避免 OCS 相似度匹配被噪声干扰
	if (out.length > 300) out = out.slice(0, 300);
	return out;
}
