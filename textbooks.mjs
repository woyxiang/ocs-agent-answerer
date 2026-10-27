/**
 * 参考教材（textbooks）定位器
 *
 * 设计取向：**只告诉 agent 教材在哪，不把教材正文塞进 prompt**。
 *   - 教材动辄几十万字，塞进 prompt 既贵（每章十几万 token）又没用（预算内只能装下封面和目录）；
 *   - agent 本来就有 read / bash 工具，让它按题去 grep/read 相关章节，又快又准；
 *   - 教材改了不用重启服务，也不用重建缓存之外的任何东西（缓存键里带文件指纹）。
 *
 * 所以这里只负责两件事：
 *   1. 把 --textbooks 的值（文件/目录，逗号或分号分隔）展开成文件清单；
 *   2. 生成一段「教材在哪」的描述塞进 {{textbooks}}（含相对路径、大小、被跳过的 PDF 等）。
 *
 * 需要「整段正文直接进 prompt」的场合（教材很短，或想省掉一次工具调用），
 * 显式给 --textbook-max-chars N（N>0）即可，正文会进 {{textbookExcerpt}}，默认关闭。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TEXT_EXT = /\.(md|markdown|txt|text)$/i;
const MAX_LISTED = 20;

/** 把 spec（文件/目录，逗号或分号分隔）展开成「文本文件清单 + 被跳过的文件清单」 */
export function scanTextbooks(spec, { cwd = process.cwd() } = {}) {
	const files = [];
	const skipped = [];
	const roots = [];

	for (const part of String(spec || '')
		.split(/[;,]/)
		.map((s) => s.trim())
		.filter(Boolean)) {
		const p = path.resolve(cwd, part);
		let st;
		try {
			st = fs.statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			roots.push({ path: p, kind: 'dir' });
			for (const name of fs.readdirSync(p).sort()) {
				const fp = path.join(p, name);
				try {
					const s = fs.statSync(fp);
					if (!s.isFile()) continue;
					const item = { name, path: fp, size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
					if (TEXT_EXT.test(name)) files.push(item);
					else if (s.size > 64 * 1024) skipped.push(item);
				} catch {
					/* 坏文件跳过 */
				}
			}
		} else if (st.isFile()) {
			roots.push({ path: p, kind: 'file' });
			const item = { name: path.basename(p), path: p, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
			if (TEXT_EXT.test(p)) files.push(item);
			else skipped.push(item);
		}
	}

	return { roots, files, skipped };
}

/** 教材指纹：路径 + 大小 + mtime。改了教材，缓存键就变，旧答案不再命中 */
function signatureOf(files) {
	if (!files.length) return 'empty';
	const raw = files.map((f) => `${f.path}|${f.size}|${f.mtimeMs}`).join('\n');
	return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function humanSize(bytes) {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/** 单行路径：在工作目录内就给相对路径（agent 的 cwd 就是这个目录，相对路径最好用） */
function displayPath(p, cwd) {
	const rel = path.relative(cwd, p);
	if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
	return p;
}

/** 生成给 agent 看的「教材在哪」描述 */
function describe({ files, skipped, roots }, cwd) {
	if (!files.length && !skipped.length) return '';
	const lines = [];

	if (roots.length === 1 && roots[0].kind === 'dir') {
		lines.push(`教材目录：${displayPath(roots[0].path, cwd)}`);
	} else if (roots.length) {
		lines.push(`教材位置：${roots.map((r) => displayPath(r.path, cwd)).join('、')}`);
	}

	const shown = files.slice(0, MAX_LISTED);
	for (const f of shown) {
		lines.push(`- ${displayPath(f.path, cwd)}（${humanSize(f.size)}）`);
	}
	if (files.length > MAX_LISTED) lines.push(`- …等共 ${files.length} 个文本文件`);

	if (skipped.length) {
		const names = skipped.slice(0, 5).map((f) => `${displayPath(f.path, cwd)}（${humanSize(f.size)}）`);
		lines.push(`（未纳入：${names.join('、')}${skipped.length > 5 ? ' 等' : ''} —— 只认 .md/.txt，PDF 需先转成文本）`);
	}
	return lines.join('\n');
}

/**
 * @param {string} spec 教材位置（文件/目录，逗号分隔）
 * @param {object} [opts]
 * @param {string} [opts.cwd] 解析相对路径的基准目录
 * @param {number} [opts.excerptChars] >0 时才把正文前 N 字符放进 {{textbookExcerpt}}（默认 0 = 不注入正文）
 * @param {number} [opts.recheckMs] mtime 检查间隔
 */
export function createTextbooks(spec, { cwd = process.cwd(), excerptChars = 0, recheckMs = 5000 } = {}) {
	let state = null;
	let lastCheck = 0;

	function buildExcerpt(files) {
		if (!excerptChars || excerptChars <= 0 || !files.length) return { excerpt: '', truncated: false };
		let total = 0;
		let truncated = false;
		const chunks = [];
		for (const f of files) {
			const header = `### 《${f.name}》\n`;
			const budget = excerptChars - total - header.length;
			if (budget <= 0) {
				truncated = true;
				break;
			}
			let body = '';
			try {
				body = fs.readFileSync(f.path, 'utf8');
			} catch {
				continue;
			}
			if (body.length > budget) {
				body = body.slice(0, budget);
				truncated = true;
			}
			const chunk = header + body.trim();
			total += chunk.length;
			chunks.push(chunk);
		}
		return { excerpt: chunks.join('\n\n'), truncated };
	}

	function load() {
		const scanned = scanTextbooks(spec, { cwd });
		const { excerpt, truncated } = buildExcerpt(scanned.files);
		return {
			spec: String(spec || ''),
			roots: scanned.roots,
			files: scanned.files,
			skipped: scanned.skipped,
			desc: describe(scanned, cwd),
			excerpt,
			excerptChars: excerpt.length,
			truncated,
			signature: signatureOf(scanned.files),
			loadedAt: Date.now()
		};
	}

	return {
		get spec() {
			return String(spec || '');
		},
		/** 带 mtime 检查的热加载：改了教材不用重启 */
		get() {
			const now = Date.now();
			if (!state || now - lastCheck > recheckMs) {
				lastCheck = now;
				const next = load();
				if (!state || next.signature !== state.signature || next.spec !== state.spec) state = next;
			}
			return state;
		},
		reload() {
			state = load();
			lastCheck = Date.now();
			return state;
		}
	};
}

/** 默认教材目录 ./textbooks 存在就用它 */
export function autoDetectTextbooks(cwd = process.cwd()) {
	try {
		return fs.statSync(path.join(cwd, 'textbooks')).isDirectory() ? './textbooks' : '';
	} catch {
		return '';
	}
}
