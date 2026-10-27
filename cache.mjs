/**
 * 极简 JSON 文件缓存：题目指纹 → 答案。
 *
 * 为什么必须有：OCS 对题库请求硬超时 60s（answer.wrapper.handler.ts 的
 * AnswerWrapperHandlerConfig.timeout_seconds + Promise.race）。agent 冷启动很贵，
 * 同一份试卷的题常常在重跑/多线程/姊妹班之间重复出现，命中缓存可把延迟从秒级降到 0。
 *
 * 顺带的好处：积累下来就是你的「私有题库」——可以随时导出给别的场景用。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function sha256(s) {
	return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * 题目指纹：题型 + 题干 + 选项 + 图片内容哈希 + 提示词变体
 *
 * variant 是「模版 + 教材签名」的短哈希：换了模版或改了教材内容，同一个题干可能得到不同答案，
 * 所以必须进 key，否则会给新模版返回旧模版的答案。旧条目不会被清理，切回旧模版仍能命中。
 */
export function cacheKey({ type, title, options, images = [], variant = '' }) {
	const imgPart = images.length ? sha256(images.map((i) => sha256(String(i))).join('|')).slice(0, 16) : '';
	return sha256(
		[type || 'unknown', (title || '').trim(), (options || '').trim(), String(images.length), imgPart, String(variant || '')].join('\u0000')
	);
}

export function createCache(file, { enabled = true, max = 5000 } = {}) {
	let map = new Map();
	let saveTimer = null;
	const stats = { hits: 0, misses: 0, sets: 0 };

	if (enabled && file && fs.existsSync(file)) {
		try {
			const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
			for (const [k, v] of Object.entries(raw.entries || {})) map.set(k, v);
		} catch {
			/* 坏文件直接忽略，重建 */
		}
	}

	function scheduleSave() {
		if (!enabled || !file) return;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(save, 300);
	}

	function save() {
		if (!enabled || !file) return;
		try {
			// 超限时按最后使用时间淘汰
			if (map.size > max) {
				const entries = [...map.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
				const drop = entries.slice(0, map.size - max);
				for (const [k] of drop) map.delete(k);
			}
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = file + '.tmp';
			fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(map) }, null, 0));
			fs.renameSync(tmp, file);
		} catch (err) {
			console.error('[cache] 保存失败:', err.message);
		}
	}

	return {
		get enabled() {
			return enabled;
		},
		get size() {
			return map.size;
		},
		stats,
		get(key) {
			const hit = map.get(key);
			if (!hit) {
				stats.misses++;
				return null;
			}
			stats.hits++;
			hit.hits = (hit.hits || 0) + 1;
			hit.ts = Date.now();
			scheduleSave();
			return hit;
		},
		set(key, value) {
			stats.sets++;
			map.set(key, { ...value, ts: Date.now(), hits: 0 });
			scheduleSave();
		},
		flush() {
			clearTimeout(saveTimer);
			save();
		},
		/** 导出全部缓存（当私有题库用） */
		dump() {
			return [...map.entries()].map(([k, v]) => ({ key: k, ...v }));
		},
		clear() {
			map = new Map();
			save();
		}
	};
}
