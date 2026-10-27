/**
 * 配置解析：默认值 ← 配置文件（--config x.json）← 命令行参数（命令行优先）
 *
 * 为什么要配置文件：模版/教材/超时这些东西通常是「一套环境一套值」，
 * 写进 answerer.json 就不用每次敲一长串参数，也方便给不同课程准备多套配置。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
	host: '127.0.0.1',
	port: 8787,
	runner: 'pi',
	model: '',
	bin: '',
	/** 单题 agent 超时（ms）；OCS 那边超时见 ocsTimeout。0 或不填 <=0 表示不设超时 */
	timeout: 135000,
	/** OCS 侧超时（ms）。OCS 源码里默认 60s，可改，改完把这里跟着调大，告警才准确 */
	ocsTimeout: 1800000,
	concurrency: 1,
	cache: 'cache.json',
	noCache: false,
	publicUrl: '',
	token: '',
	workdir: '',
	maxBody: 32 * 1024 * 1024,
	verbose: false,
	/** 模版：内置名（default / textbook / hint）或一段自定义模版文本 */
	template: 'textbook',
	/** 自定义模版文件（优先级高于 template），内容支持 {{占位符}} */
	prompt: '',
	/** 参考教材：文件或目录，逗号/分号分隔；留空则自动探测 ./textbooks */
	textbooks: '',
	/**
	 * 额外注入 prompt 的教材正文字符数：默认 0 = 不注入正文，只告诉 agent 教材在哪（推荐）；
	 * 设成 N>0 才会把正文前 N 字符塞进 {{textbookExcerpt}}（教材很短、或想省一次工具调用时才需要）。
	 */
	textbookMaxChars: 0,
	/** 给答题 agent 挂联网搜索插件（@ssk_dev/pi-web-access-lean），拿不准的题可以自己搜一次 */
	webSearch: true,
	/**
	 * 联网插件入口文件；留空 = 自动探测
	 * .pi/npm/node_modules/@ssk_dev/pi-web-access-lean/index.ts（相对服务启动目录）
	 */
	webSearchExt: '',
	/**
	 * 让答题 agent 用独立 pi 配置目录（.agent/pi-home），连用户级 pi 包也隔离；只复制认证与模型目录。
	 * 默认 false = 用你现有的 pi 配置（工具仍受 --no-extensions + --tools 白名单约束）。
	 */
	isolatePiConfig: false
};

/** 只用于类型转换的列表 */
const NUMBER_KEYS = new Set(['port', 'timeout', 'ocsTimeout', 'concurrency', 'maxBody', 'textbookMaxChars']);
const BOOL_KEYS = new Set(['noCache', 'verbose', 'webSearch', 'isolatePiConfig']);

/** kebab-case / 别名 → 配置键 */
const ALIASES = {
	'no-cache': 'noCache',
	'public-url': 'publicUrl',
	'max-body': 'maxBody',
	'ocs-timeout': 'ocsTimeout',
	'timeout-ocs': 'ocsTimeout',
	'textbook-max-chars': 'textbookMaxChars',
	'textbooks-max-chars': 'textbookMaxChars',
	'web-search': 'webSearch',
	'web-search-ext': 'webSearchExt',
	'websearch-ext': 'webSearchExt',
	'prompt-file': 'prompt',
	templateFile: 'prompt',
	templatefile: 'prompt',
	config: 'config',
	configs: 'config',
	'config-file': 'config',
	textbook: 'textbooks',
	workdir: 'workdir'
};

export function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		let key = a.slice(2);
		let val = true;
		const eq = key.indexOf('=');
		if (eq !== -1) {
			val = key.slice(eq + 1);
			key = key.slice(0, eq);
		} else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
			val = argv[++i];
		}
		out[key] = val;
	}
	return out;
}

/**
 * 剥掉 JSON 注释（// 与 /* *\/），只在字符串外面动手。
 * 必须支持行尾注释：config.example.json 全是 `"port": 8787, // 端口` 这种写法，
 * 之前只用正则剥「整行 //」，结果示例配置自己就解析不了（启动报「不是合法 JSON」）。
 */
function stripComments(text) {
	const s = text.replace(/^\uFEFF/, '');
	let out = '';
	let inStr = false;
	let esc = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		const n = s[i + 1];
		if (inLine) {
			if (c === '\n') {
				inLine = false;
				out += c;
			}
			continue;
		}
		if (inBlock) {
			if (c === '*' && n === '/') {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inStr) {
			out += c;
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') {
			inStr = true;
			out += c;
			continue;
		}
		if (c === '/' && n === '/') {
			inLine = true;
			i++;
			continue;
		}
		if (c === '/' && n === '*') {
			inBlock = true;
			i++;
			continue;
		}
		out += c;
	}
	return out;
}

export function loadConfigFile(file) {
	const abs = path.resolve(file);
	const raw = fs.readFileSync(abs, 'utf8');
	let parsed;
	try {
		parsed = JSON.parse(stripComments(raw));
	} catch (err) {
		throw new Error(`配置文件 ${abs} 不是合法 JSON：${err.message}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`配置文件 ${abs} 必须是一个 JSON 对象`);
	}
	return { abs, data: parsed };
}

function normalizeKey(key) {
	if (ALIASES[key]) return ALIASES[key];
	// 没写别名的 kebab-case 自动转 camelCase，这样 --isolate-pi-config 这类新参数不用一个个补别名
	if (key.includes('-')) {
		const camel = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
		if (camel in DEFAULTS) return camel;
	}
	return key;
}

function coerce(key, value) {
	if (value === undefined || value === null) return undefined;
	if (NUMBER_KEYS.has(key)) {
		const n = Number(value);
		if (Number.isNaN(n)) throw new Error(`配置项 ${key} 需要数字，收到 ${JSON.stringify(value)}`);
		return n;
	}
	if (BOOL_KEYS.has(key)) {
		if (typeof value === 'boolean') return value;
		const s = String(value).trim().toLowerCase();
		if (['1', 'true', 'yes', 'on'].includes(s)) return true;
		if (['0', 'false', 'no', 'off', ''].includes(s)) return false;
		throw new Error(`配置项 ${key} 需要 true/false，收到 ${JSON.stringify(value)}`);
	}
	return String(value);
}

/**
 * @param {{argv?: string[], cwd?: string}} input
 * @returns {{opts: object, meta: {configFile: string, unknownKeys: string[], sources: object}}}
 */
export function resolveConfig({ argv = [], cwd = process.cwd() } = {}) {
	const args = parseArgs(argv);
	const unknownKeys = [];
	const opts = { ...DEFAULTS };
	const sources = {};

	// 1) 配置文件
	let configFile = '';
	if (args.config || args['config-file']) {
		const loaded = loadConfigFile(String(args.config || args['config-file']));
		configFile = loaded.abs;
		for (const [k, v] of Object.entries(loaded.data)) {
			if (k === 'config') continue;
			const key = normalizeKey(k);
			if (!(key in DEFAULTS)) {
				unknownKeys.push(`config:${k}`);
				continue;
			}
			const cv = coerce(key, v);
			if (cv !== undefined) {
				opts[key] = cv;
				sources[key] = `config:${path.basename(configFile)}`;
			}
		}
	}

	// 2) 命令行（优先级最高）
	for (const [rawKey, rawVal] of Object.entries(args)) {
		if (rawKey === 'help' || rawKey === 'config' || rawKey === 'config-file') continue;
		let key = normalizeKey(rawKey);
		let value = rawVal;
		// --no-web-search / --no-verbose 这类：布尔项自动取反，省得为每个布尔项写别名
		if (!(key in DEFAULTS) && rawKey.startsWith('no-')) {
			const positive = normalizeKey(rawKey.slice(3));
			if (BOOL_KEYS.has(positive)) {
				key = positive;
				value = false;
			}
		}
		if (!(key in DEFAULTS)) {
			unknownKeys.push(`cli:--${rawKey}`);
			continue;
		}
		const cv = coerce(key, value);
		if (cv !== undefined) {
			opts[key] = cv;
			sources[key] = 'cli';
		}
	}

	// 3) 归一化
	opts.timeout = Number(opts.timeout) === 0 ? 0 : Math.max(0, Math.round(Number(opts.timeout) || 0));
	opts.ocsTimeout = Math.max(1000, Math.round(Number(opts.ocsTimeout) || 0));
	opts.concurrency = Math.max(1, Math.round(Number(opts.concurrency) || 1));
	opts.port = Math.max(1, Math.round(Number(opts.port) || 8787));
	if (!opts.workdir) opts.workdir = path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'ocs-agent-answerer');

	return { opts, meta: { configFile, unknownKeys, sources } };
}
