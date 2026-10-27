# ocs-agent-answerer

把 **pi / claude code / 任意 CLI agent** 变成 [OCS 网课助手（ocsjs）](https://github.com/ocsjs/ocsjs) 的题库后端。

零 npm 依赖（只用 Node 内置模块）、不写油猴脚本、不改 OCS 源码 —— 只用 OCS 本来就有的「题库配置」扩展点。

- **提示词模版化**：内置「无教材」「参考教材」两套模版，任意切换，也可以用自己的模版文件全自定义。教材模式**只把「教材在哪」写进 prompt**，正文由 agent 自己 `grep`/`read` —— 35 万字的教材也不会撑爆上下文。
- **超时两端都可配**：本服务 `--timeout`（等 agent 多久）和 `--ocs-timeout`（OCS 侧上限）都能改；OCS 默认的 60 秒天花板也有一行改法（见 [§4](#四超时两端都能改)）。
- **一份 JSON 配置**：命令行参数全部可以在 `answerer.json` 里写，也能单题覆盖。

---

## 一、为什么能这么做（协议事实）

OCS 的「题库」不是插件，而是一段**普通 HTTP 请求 + 两个在页面里执行的 JS handler**：

`packages/core/src/core/answer-wrapper/interface.ts` 的 `AnswererWrapper` 就是全部契约：

| 字段 | 说明 |
| --- | --- |
| `url` / `method` | 你自己的服务地址，`post` 或 `get` |
| `data` | 请求体。**值可以是 `{ handler: "源码" }`** —— OCS 会 `new Function(源码)()` 得到函数，再用 `env` 调它 |
| `handler` | 响应解析器：`new Function(源码)()` 得到函数，入参是响应，必须返回 `[[题目, 答案, extra?]]` |
| `type` | `fetch` 或 `GM_xmlhttpRequest`（后者走油猴特权请求，绕过 CORS 与混合内容） |
| `responseType` | `json` 时响应已被 JSON.parse |

`answer.wrapper.handler.ts` 里的两个约束：

- **默认 60 秒超时**（`AnswerWrapperHandlerConfig.timeout_seconds = 60`，`Promise.race([request, sleep(60s)])`）。这是默认值，不是物理定律 —— 想放开就改这一行，见 [§4](#四超时两端都能改)。
- 给 handler 的 `env` 只有 `{ title, options, type, images, suggestion_title, suggestion_options }`，**没有 DOM**。所以「这道题有几个填空框」这种信息，必须在 `data.payload` 的 handler 里现场读出来（本项目的做法）。
- `handler` / `data.payload.handler` 都是 `new Function` 执行，**没有沙箱**。所以 OCS 5.x 已经移除了「从链接加载题库配置」——也所以本项目的 `/config` 只返回 JSON 让你自己粘贴。

OCS 侧没有内置 AI 解题。所以「让 agent 当后端」= 写一个 HTTP 服务，把它伪装成一个题库。这就是本项目的全部内容。

### 答案格式为什么必须规整

OCS 拿到答案后会跑 `packages/core/src/core/worker/resolvers/*.ts` 去和 DOM 里的选项匹配：

| 题型 | 最终匹配方式 | 对 agent 输出的要求 |
| --- | --- | --- |
| `single` | 归一化精确 → 相似度>0.6 → 纯 ABCD 兜底 | 输出 `A` 最稳 |
| `multiple` | 「答案 ⊇ 选项」归一化包含 → 相似度 → 纯 ABCD | 输出 `A#C` 最稳 |
| `judgement` | 关键词表：是/对/正确/√/true/T/yes/1 ↔ 否/错/×/false/F/no/0 | 输出 `对` 或 `错` |
| `completion` | `splitAnswer` 按 `=== # --- ### \| ; ；` 切分，数量要和填空框一致 | 输出 `甲#乙` |

所以 `prompt.mjs` 里做了两件事：给 agent 一个严格的输出契约（`RULES`），再把它的自由文本（"正确答案是：A。"、"答案是 A、C 两项"）压成上表形状。**这一步是准确率的关键**，不是可选项。

---

## 二、提示词模版与参考教材

### 2.1 三套内置模版

| id | 名称 | 用途 |
| --- | --- | --- |
| `default` | 无教材模式 | 只用模型自己的知识作答，prompt 最短、延迟最低、token 最省。题库混杂的课程用这个。 |
| `textbook` | 参考教材模式 | prompt 里给出**教材位置**（目录 + 文件清单），要求「先用工具查教材、优先依据教材、教材与记忆冲突时以教材为准、查不到再用通用知识」。同时自动放开 `read`/`bash` 工具。教材原文题 / 学校自编题用这个。 |
| `hint` | 页面提示模式 | 附加 OCS 传上来的页面「建议答案」作为参考。 |

切换方式（越靠后的优先级越高）：

```bash
# 1) 配置文件
node server.mjs --config answerer.json      # 里面写 "template": "textbook"
# 2) 命令行
node server.mjs --template textbook
# 3) 单题覆盖（curl 调试、或按课程/章节临时切）
curl -X POST http://127.0.0.1:8787/ask -d '{"payload":{"title":"…","type":"single","template":"textbook"}}'
```

`GET /templates` 能看到当前生效的模版和可用模版；`GET /prompt?title=…&type=single` 能预览渲染结果（调模版必备）。

### 2.2 参考教材（textbooks）

教材是**本地纯文本**：把 `.md` / `.markdown` / `.txt` 扔进 `./textbooks/`（或 `--textbooks <文件或目录>`，逗号分隔多个）。

关键设计：**prompt 里不给正文，只给位置**。`{{textbooks}}` 渲染出来是这样一小段：

```
教材目录：textbooks
- 化工原理 第5版.md（681 KB）
- 附录A-规范条文.md（12 KB）
（未纳入：化工原理 第5版.pdf（57.3 MB）—— 只认 .md/.txt，PDF 需先转成文本）
```

然后 agent 拿着题目去 `grep`/`read` 相关章节，自己找答案。原因很直接：

- 一本教材 35 万字 ≈ 20 万 tokens，塞进 prompt 既昂贵又会把题干的权重稀释掉；截断到前 N 字符基本只能拿到封面和目录（实测《化工原理 第5版》正文 1.1 节在第 22501 字符处，整本 353386 字符）。
- agent 本来就有工具。一次 `grep` 通常 1~2 秒，换来的是「定位到真正相关的那几页」而不是「随机截断的一段」。
- prompt 体积从此与教材大小无关（实测教材模式下 prompt 仅 681 字符，答案照样能定位到 300 行文件的第 281 条）。

```bash
node server.mjs --template textbook                       # 自动用 ./textbooks
node server.mjs --template textbook --textbooks ./书/第3章.md,./书/附录.txt
node server.mjs --textbook-max-chars 3000                 # 可选：额外附正文前 3000 字符（默认 0 = 不附）
```

细节：

- **工具会自动放开**：`textbook` 模版（或任何含 `{{textbooks}}` 的自定义模版）会让 runner 加 `--tools read,bash`；`default` 模版则保持 `--no-tools`，省掉一次工具往返。claude 侧对应 `--allowedTools Read,Grep,Bash`。
- **改了教材不用重启**：`textbooks.mjs` 每 5 秒比一次文件的 size/mtime，变了就重载。
- **PDF 不会被自动读**：只认 md/txt。教材 PDF 先转文本（`pdftotext -layout x.pdf x.txt` 或 marker/pymupdf 之类），再放进来；启动日志会把被跳过的 PDF 列出来提醒你。
- **教材变了，旧缓存自动失效**：缓存键里带了「模版 + 教材指纹（路径/size/mtime 的 sha256）」，换教材/换模版不会复用上一套提示词算出来的答案。
- **想「整段正文直接进 prompt」也可以**：`--textbook-max-chars N`（N>0）会把正文前 N 字符放进 `{{textbookExcerpt}}`，模版里的 `{{#if textbookExcerpt}}` 块才生效。教材很短、或想省掉一次工具调用时才值得开。
- **单题换教材**：`payload.textbooks` 传另一套教材的路径（按课程/章节切），`payload.textbookExcerpt` 传一段现成正文。

### 2.3 全自定义模版

`--prompt <文件>` 指一个模版文件，优先级高于 `--template`：

```markdown
你是《化工原理》课程的答题后端。

{{#if textbooks}}
【参考教材（节选）】
{{textbooks}}
{{/if}}

题型：{{typeLabel}}（{{type}}）
题目：{{title}}
{{#if options}}
选项：
{{options}}
{{/if}}{{#if blanksLine}}{{blanksLine}}
{{/if}}

补充要求：涉及国家标准编号时，只输出编号本身，不要带「GB」前缀以外的文字。

{{rules}}
```

占位符：

| 占位符 | 含义 |
| --- | --- |
| `{{title}}` / `{{question}}` | 题干 |
| `{{options}}` | 选项原文（多行，`A. xxx` 形状） |
| `{{type}}` / `{{typeLabel}}` | 题型 id（`single`…）/ 中文名（单选题…） |
| `{{blanks}}` / `{{blanksLine}}` | 填空框数量 / 「填空数量：2 个空」（≤1 时为空） |
| `{{imageCount}}` / `{{imageList}}` | 图片数量 / 落盘后的图片路径列表 |
| `{{textbooks}}` | 教材在哪（目录 + 文件清单，**不是正文**） |
| `{{textbookExcerpt}}` | 教材正文节选（仅当 `--textbook-max-chars > 0`，默认空） |
| `{{suggestionTitle}}` / `{{suggestionOptions}}` | 页面建议答案 |
| `{{rules}}` | 内置输出规则（**建议保留**，否则答案格式会漂，OCS 匹配不上） |

条件块：`{{#if key}}…{{/if}}`、`{{#unless key}}…{{/unless}}`（不支持同类嵌套）。拼错的占位符会原样留在 prompt 里，方便你一眼看出来。

---

## 三、联网搜索（web_access）

答题 agent 默认带一个联网搜索工具：`@ssk_dev/pi-web-access-lean`。它只注册一个 `web_access` 工具（schema 约 **153 token**，是上游 `pi-web-access` 四工具 2853 token 的 5.4%），题库里「教材没写、记忆也不牢」的题，agent 可以自己查一次再答。

**为什么选这个插件**：一个工具 + `op` 参数（`search` / `check` / `fetch` / `get` / `help`）就覆盖了搜、验、抓、续读四种能力。工具 schema 是每道题都要付的上下文税——153 而不是 2853，几十道题的作业里差别是实打实的。

```bash
pi install npm:@ssk_dev/pi-web-access-lean      # 装到项目 .pi/npm/node_modules/
node server.mjs    # 启动日志会打一行：联网搜索 : 已挂载 web_access（.pi/npm/node_modules/@ssk_dev/pi-web-access-lean/index.ts）
```

开关：

```bash
node server.mjs --no-web-search                 # 不挂工具（最快、最省）
node server.mjs --web-search-ext ./my-ext.ts    # 换插件入口
# 单题关：payload 里 "webSearch": false
```

### 3.1 挂载方式（踩过的坑）

runner 里带着 `--no-extensions`（防止用户机器上一堆无关扩展改行为、加 latency），所以插件**不能**靠 `.pi/settings.json` 自动加载——实测带 `--no-extensions` 时 `web_access` 直接消失。改成显式挂载：

```bash
pi -p --mode json … --no-extensions -e <插件入口 index.ts> --tools web_access,read,bash
```

显式 `-e` 不受 `--no-extensions` 影响，而且只挂这一个插件。工具白名单仍由 `--tools` 收口：

| 场景 | 工具 |
| --- | --- |
| `default` 模版 | `--tools web_access` |
| `textbook` 模版（要 grep 教材） | `--tools read,bash,web_access` |
| 图片题 | `--tools read,web_access` |
| `--no-web-search` 且不需要文件/图片 | `--no-tools` |

prompt 里对应的那行提示由 `{{#if webSearch}}` 控制，模版里只有一句：「拿不准时可用 web_access 工具联网搜一次再答（能直接答就别搜）」。

### 3.2 代价与实测

- 一次 `search` **2~5 s**，`fetch` 抓正文更久；多来源反复搜能到 **74 s**（e2e 实测最慢一次）。e2e 里最常见的是 **4~12 s** 答出「153」。
- 所以 `--timeout` 默认 45 s 时**建议把联网关掉或调大超时**：启动日志会检查这件事（`--timeout < 60000` 且开了联网就告警）。
- 所以提示词写的是「能直接答就别搜」，而不是「先搜再答」——每题都搜会把 45 s 预算吃干。
- 不放心就 `--no-web-search` 关掉，或给单个题 `"webSearch": false`。

### 3.3 怎么确认它真的联网了

`/ask` 的响应多了一个 `tools` 字段：

```json
{"ok":true,"answer":"153","tools":["web_access"],"webSearch":true,"promptChars":389,"ms":5360}
```

`tools: ["web_access"]` = 这次真的调了工具；`[]` = 模型凭记忆答的。`/health` 的 `webSearch.enabled/requested/ext` 反映服务级状态。

### 3.4 答题 agent 到底拿到了哪些工具（别让它偷偷多装）

`tools` 是「模型真调用过哪些」，不足以证明它**手里**有哪些。`/ask` 另给一个 `agentTools`，直接来自 pi 的 JSONL 事件（首条 system message 的 `toolsAdded`）：

```json
{"ok":true,"answer":"153","tools":["web_access"],"agentTools":["read","bash","web_access"],"webSearch":true,"ms":6566}
```

这是「有没有多给工具」的唯一可信证据 —— 模型自己说「我有 compress/todo」不算数，得看这里。`--verbose` 也会在每题下面打印：

```
   ↳ pi -p --mode json --no-extensions --no-context-files --no-skills --no-mcp -e <ext> --tools read,bash,web_access
     工具: read, bash, web_access
```

为什么不会多：runner 带 `--no-extensions`，项目 `.pi/settings.json` 里装的开发插件（`rpiv-todo-lean`、`pi-hashline-edit-pro-lean`、`billion-context-pi`、`rpiv-ask-user-question-lean`…）和用户级 pi 包都不会被加载 —— 实测把 `--no-extensions` 去掉，同一个问题立刻从 3 个工具变成 17 个（多出 `compress`/`todo`/`replace`/`acp_delegate`/`ask_user_question`）。工具再用 `--tools` 白名单收口，`-e` 只挂 `web_access` 那一个插件。

想连「你自己的 pi 配置」也彻底隔离（连认证、模型目录都另用一份拷贝）：

```bash
node server.mjs --isolate-pi-config    # agent 用 .agent/pi-home，只复制 auth.json/models*.json
```

默认不开：多数情况下 `--no-extensions` + `--tools` 已经够了，而隔离会让你自己 `~/.pi/agent` 里的默认模型/设置失效（OAuth 用户尤其别开）。

---

## 四、超时（两端都能改）

两段超时，互不相干：

| 位置 | 默认 | 改法 |
| --- | --- | --- |
| 本服务等 agent | 45 s | `--timeout 50000`（`0` = 不限制） |
| OCS 等本服务 | 60 s | **改 OCS 源码一行** + `--ocs-timeout` 保持同步 |

OCS 侧的 60 秒在 `packages/core/src/core/answer-wrapper/answer.wrapper.handler.ts`：

```ts
export const AnswerWrapperHandlerConfig = {
  timeout_seconds: 60,   // ← 5.2.3 里的默认值，改成 120 就是 120 秒
  // …
};
```

改完 `pnpm build`（或你装 OCS 用的那种打包方式）再装回扩展，然后：

```bash
node server.mjs --timeout 110000 --ocs-timeout 120000
```

`--ocs-timeout` 本身**不会改变任何东西**，它只做两件事：让 `/health` 的 `budget.ocsTimeoutMs` 反映真实上限、以及在 `--timeout ≥ --ocs-timeout` 时告警（这种配置下 OCS 一定先超时，等于白等）。所以：

- 没改 OCS 源码 → 保持默认 60000，`--timeout` 别超过 50000~55000；
- 改了 OCS 源码 → 两个数字一起调大，别只调一个。

启动日志会打出一行 `超时 : agent 45000ms / OCS 60000ms`，改 OCS 侧之后从 `/health` 能核对到实际生效值。

---

## 五、快速开始

```bash
cd D:/Programs/04_Workspaces/ocs-agent-answerer

# 1) 冒烟自测（不需要模型、不需要网络，52 项断言）
node smoke.mjs

# 2) 起服务（默认 runner=pi，监听 127.0.0.1:8787）
node server.mjs --verbose
node server.mjs --template textbook --model xiaomi/mimo-v2.6-flash     # 参考教材模式

# 3) 浏览器打开 http://127.0.0.1:8787/config ，把 JSON 复制进
#    OCS → 设置 → 题库配置（粘贴整段数组）
```

`/config` 返回的就是可直接粘贴的 `AnswererWrapper[]`，`type` 默认给 `GM_xmlhttpRequest` —— 因为网课页是 **https**，页面里直接 `fetch('http://127.0.0.1')` 会被浏览器按混合内容拦掉，只有油猴特权请求能通。

**务必显式给 `--model`**：不指定时用的是 agent 自己的默认模型，pi 的默认可能是个本地小模型（本机是 `lmstudio/minicpm5-2b`），简单题能答、图片题直接 NONE。

## 六、配置与接口

### 6.1 配置文件

命令行能写的一切都能写进 JSON（`--config answerer.json`，允许 `//` 注释）。优先级：**默认值 ← 配置文件 ← 命令行**。

```json
{
  "port": 8787,
  "runner": "pi",
  "model": "xiaomi/mimo-v2.6-flash",
  "timeout": 45000,
  "ocsTimeout": 60000,
  "template": "textbook",
  "textbooks": "./textbooks",
  "textbookMaxChars": 0,
  "webSearch": true
}
```

完整带注释的模板见 `config.example.json`（含所有键、别名与默认值）。键名既支持驼峰 `noCache` 也支持短横线 `no-cache`；写错的键会在启动时被点名列出来，不会静默忽略。

### 6.2 参数表

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--config` | — | 配置文件路径 |
| `--port` / `--host` | `8787` / `127.0.0.1` | 监听地址；改 `0.0.0.0` 请务必配 `--token` |
| `--runner` | `pi` | `pi` \| `claude` \| `mock` |
| `--model` / `--bin` | — | 传给 runner 的模型 / 可执行文件路径 |
| `--timeout` | `45000` | 单题 agent 超时，`0` = 不限制 |
| `--ocs-timeout` | `60000` | OCS 侧超时（只影响告警与 `/health` 显示） |
| `--concurrency` | `1` | 同时跑的 agent 数，单会话 agent 建议保持 1 |
| `--template` | `default` | `default` \| `textbook` \| `hint` |
| `--textbooks` | `./textbooks` | 教材文件/目录，逗号分隔 |
| `--textbook-max-chars` | `0` | `0` = 只告诉 agent 教材在哪；N>0 才额外附正文前 N 字符 |
| `--prompt` | — | 自定义模版文件（优先于 `--template`） |
| `--no-web-search` | 挂载 | 不给答题 agent 联网搜索工具（`--tools` 里去掉 `web_access`） |
| `--web-search-ext` | 自动探测 | 联网插件入口，默认 `.pi/npm/node_modules/@ssk_dev/pi-web-access-lean/index.ts` |
| `--cache` / `--no-cache` | `./cache.json` | 题库缓存（你攒出来的私有题库，可导出） |
| `--token` | — | 要求 `x-ocs-token` 头，`/config` 会自动带上 |
| `--public-url` | `http://<host>:<port>` | 局域网/反代场景下配置里的地址 |
| `--workdir` | `<tmp>/ocs-agent-answerer` | 图片落盘目录 |
| `--max-body` | `33554432` | 请求体上限（图片题 base64 很大） |
| `--verbose` | — | 打印每题的处理日志 |

### 6.3 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/ask` | OCS 调这个。收 `{title, options, type, blanks, images, template?, textbooks?}`，回 `{ok, answer, source, cached, template, promptChars, ms}` |
| `GET` | `/health` | 队列 / 缓存 / 延迟统计 / 当前模版 / 教材统计 / 超时预算 |
| `GET` | `/config` | 生成可粘贴的题库配置（`?type=fetch`、`?raw=1`） |
| `GET` | `/templates` | 内置模版列表 + 当前生效模版与教材 |
| `GET`/`POST` | `/prompt` | 预览渲染后的 prompt（调模版用），支持 `template`/`textbooks` 覆盖 |
| `GET` | `/cache?limit=20` | 导出缓存 = 你的私有题库 |
| `POST` | `/cache/clear` | 清缓存 |

`curl` 调试（`/ask` 同时接受平铺字段和 OCS 的 `{payload:{…}}` 两种形态）：

```bash
curl -s -X POST http://127.0.0.1:8787/ask -H 'Content-Type: application/json' \
  -d '{"payload":{"title":"下列哪项属于固定成本？","options":"A. 厂房租金\nB. 原材料\nC. 销售提成\nD. 包装材料","type":"single"}}'
# {"ok":true,"answer":"A","source":"agent","cached":false,"template":"default","promptChars":258,"ms":1399,...}
```

---

## 七、实测结果

`node e2e.mjs --model xiaomi/mimo-v2.6-flash` —— 真模型真链路，**13/13 通过**（Windows / Node v24.22.1）：

| 用例 | 结果 | 耗时（含进程启动） |
| --- | --- | --- |
| 单选 → `A` | ✅ | 1363 ms |
| 多选 → `A#C` | ✅ | 1699 ms |
| 判断(真) → `对` | ✅ | 1828 ms |
| 判断(假) → `错` | ✅ | 1673 ms |
| 填空 2 空 → `叶绿体#类囊体薄膜` | ✅ | 2168 ms |
| **无教材模式**按常识答「水的沸点」→ `100` | ✅ | 4794 ms |
| **教材模式**同一题，教材文件第 281 条规定 90℃ → `90摄氏度`（prompt 仅 681 字） | ✅ | 5053 ms |
| **教材模式的 prompt 不含教材正文**（`promptChars=681`，证明真去查了文件） | ✅ | — |
| **图片题**（PNG 里画 `2+3=?`）→ `B` | ✅ | 3455 ms |
| 重复题命中缓存 | ✅ | 3 ms |
| **联网搜索**：问「pi-web-access-lean 的 lean 版工具定义占多少 token」→ `153`，且 `tools` 里真有 `web_access` | ✅ | 11830 ms |
| metrics 记录 | ✅ | agentCalls=9 avg=3759ms |

中间那两行是教材模式的对照实验：同一道题，只是把教材目录换成一本 300 行的课程规范（关键条款埋在第 281 条），答案就从 `100` 变成 `90摄氏度`，而 prompt 只有 681 字符 —— 证明 agent 真的自己 `grep` 到了那一行，而不是靠截断碰运气。多出来的 2 秒就是查教材的开销。

`node smoke.mjs` —— 零模型、零网络，**52 项断言**覆盖：协议字段、四种题型规整、NONE 分支、缓存命中/并发去重、模版渲染与条件块、联网搜索插件挂载/单题关闭、教材「只给位置不给正文」、PDF 跳过提示、`needsFileAccess` 工具开关、`textbookExcerpt` 可选注入、模版/教材变更后的缓存隔离、配置文件加载（行尾/块注释）、示例配置自检、自定义模版文件、token 鉴权。

单题成本约 **$0.00004**（256 in / 12 out tokens，flash 级模型）。教材模式因为不塞正文，输入基本不变（681 字符的 prompt ≈ 400 tokens），代价从「token」换成了「多一次工具往返的 1~2 秒」。跑满一门课（约 200 题）仍是几分钱。

### 用 OCS 官方管线验证过，不是自说自话

在 ocsjs 仓库里跑了两层：

1. `tests/answerer.test.ts`（官方题库调试脚本）→ `✅ 测试通过`，能正常拿到 `答案: A`。
2. `ocs-e2e/agent-resolver.check.ts`（本项目补充：官方 test 只验「题库返回了什么」，**不验「OCS 能不能匹配上」**）→ 把 `defaultAnswerWrapperHandler` 的真实返回喂进官方 `resolveSingle / resolveMultiple / resolveJudgement / resolveCompletion`，**6/6 通过**，包括「NONE 分支不会乱选」。

复现方法（在 ocsjs 仓库根目录）：

```bash
corepack pnpm install --ignore-scripts
corepack pnpm add -w node-fetch@2     # 上游漏声明：request.ts 在 node 分支 require('node-fetch')
node_modules/.bin/tsx --import ./tests/setup-browser-env.ts tests/answerer.test.ts --config ./e2e-agent.config.json
node_modules/.bin/tsx --import ./tests/setup-browser-env.ts agent-resolver.check.ts
```

---

## 八、设计上的几个关键决定

1. **`data.payload` 用 handler 而不是 `${title}` 占位符**
   OCS 的占位符是字符串 `replace`：`${images}`（数组）会被拼成逗号串，base64 直接毁掉。用 handler 则能原样传数组，还能顺手带上 DOM 里的填空框数量。
   另外，`isAnswererWrapperSupportImageOptimize` 是靠**正则扫描 handler 源码**里有没有 `images` / `suggestion_title` / `suggestion_options` 来判定题库是否支持图片题的 —— 所以 payload handler 里显式写了 `env.images || []`。

2. **一律返回 HTTP 200 + `ok` 字段**
   OCS 对非 200 会走错误分支，页面显示「题库连接失败」，可读性差。语义失败（NONE / 超时 / 空题干）用 `{ok:false, reason}`，handler 返回 `undefined` → OCS 当成「这个题库没搜到」，继续用别的题库（如果你还配了别的）。

3. **prompt 走 stdin，不走 argv**
   Windows 下 `.cmd` shim + 引号 + 命令行长度限制会随机炸。`runners.mjs` 统一 `spawn(cmd.exe /d /s /c "...")` + `stdin.write(prompt)`。

4. **串行队列 + 同题 in-flight 去重 + 落盘缓存**
   单 agent 会话扛不住并发，OCS 多线程刷题时在这里排队。同一题被多线程/重试同时打到，只调一次 agent。OCS 自己也有搜题缓存（`searchAnswerInCaches`），两层缓存叠加后重复题基本都是个位数毫秒。

5. **模版 + 教材进缓存键**
   `cacheKey = f(type, title, options, images, variant)`，`variant = hash(模版 id + 教材指纹)`。所以换模版、换教材不会命中上一套提示词算出来的答案 —— 否则「切成教材模式」会立刻被旧缓存吃掉，你会以为功能没生效。代价是升级后旧 `cache.json` 全部失配（键结构变了），这在正确性上是划算的。

6. **教材只给位置，正文交给 agent 自己查**
   第一版是把教材正文拼进 prompt，实测立刻暴露问题：整本 35 万字，30000 字符预算只够封面 + 前言（正文 1.1 节在 22501 字符处）。改成「prompt 里只写目录和文件清单、agent 自己 `grep`/`read`」后：prompt 681 字符、与教材体量无关，答案定位到 300 行文件的第 281 条也没问题。
   代价是每题多一次工具往返（约 2 秒），并且必须给 runner 放开 `read` + `bash`（`--tools read,bash`）—— 所以 `textbook` 模版会置 `needsFileAccess`，`default` 模版保持 `--no-tools`，不让「无教材」的题无端付这笔钱。图片题本来就要 `read` 看图，两者合并成同一个工具列表。

7. **联网搜索用显式 `-e` 挂载，而不是靠 `.pi` 自动加载**
   runner 带 `--no-extensions`（用户机器上的无关扩展会改行为、加 latency、甚至改 prompt），所以项目里 `pi install` 的插件默认不加载 —— 实测这时 `web_access` 直接消失。显式 `-e <入口>` 不受 `--no-extensions` 影响，而且只挂这一个插件；工具再用 `--tools` 白名单收口，不会因为装了插件就多出一堆工具进上下文。
   另一个选择是让模型用 provider 自带的联网（`--tools web_search`），但那是**云端服务商**的实现：模型换一家就得改配置，还常要求单独开权限。插件是本地的，换模型不影响。

---

## 九、已知限制（别指望它完美）

- **60 秒不是物理极限，但要改源码**：默认 60 s 会让「慢模型 + 长题干 + 多图/大教材」够呛。改法见 [§4](#四超时两端都能改)——两边一起调，别只调一边。
- **教材模式每题多 1~2 秒**：agent 要真的去 `grep`/`read`。教材目录里文件极多（>20 个）或全是 PDF（未转文本）时，它可能找不到相关章节而退回通用知识 —— 启动日志会列出被跳过的非文本文件，建议一次只挂当前课程/章节的教材。
- **PDF 不解析**：把教材 PDF 转成 md/txt 再放进来。
- **图片题需要视觉模型**：本地小模型/纯文本模型会直接答 NONE（本项目会把这种情况记为 `ok:false`，不会瞎填）。
- **填空题的空数靠 DOM 猜**（`textarea:not([disabled]), input[type=text]…`）。页面上有搜索框之类的输入框时会多算，导致 `A#B#C` 对不上。可以在题库配置里把 payload handler 的 `blanks` 写死成 `0`（走「一空合并」分支）。
- **`claude` runner 未实测**：本机没装 `claude`，只验证了 `pi`。命令形态按 `claude -p --output-format json` 写的，若你的版本参数不同，改 `runners.mjs` 里 `claudeRunner` 一行即可。
- **检索靠 agent 的 grep，不是向量检索**：关键词能对上就没问题，同义词/别称多的教材可能搜不到（比如教材写「水力计算」而题目说「管路阻力」）。真要做 RAG 得在服务端建索引，那是另一个量级的工作。
- **联网搜索会吃掉超时预算**：一次搜索 2~5 秒、抓正文可能 30 秒以上，默认 45 s 的单题预算经常只够搜一次。所以提示词写的是「能直接答就别搜」。赶时间就 `--no-web-search`，或给单题 `"webSearch": false`。
- **联网搜索不保证搜到**：检索源由插件决定（默认零配置的 Exa MCP），冷门中文教材/校内资料可能搜不到；它只负责「多一条路」，不是万能钥匙。
- **成本不是零**：每题一次 agent 调用。便宜模型够用，别接贵模型刷整门课。
- agent 会犯知识性错误。这是「AI 答题」的固有风险，本服务只保证了**格式**正确、**不瞎填**（NONE 分支）。

---

## 十、文件

```
server.mjs            HTTP 服务（路由 / 队列 / 缓存 / 图片落盘 / /config 生成 / 告警）
config.mjs            配置分层：默认值 ← --config 文件 ← 命令行（含别名、未知键检查、注释剥除）
templates.mjs         提示词模版（default / textbook / hint）+ 条件块渲染 + {{rules}}
textbooks.mjs         教材定位（目录展开 / mtime 热加载 / 位置描述 / 可选正文节选 / 指纹）
prompt.mjs            buildPrompt（把 job 摊成占位符） + normalizeAnswer（答案规整）
runners.mjs           pi / claude / mock 三个 runner + exec（stdin 传 prompt、可配超时、Windows 兼容）
cache.mjs             落盘缓存（FNV 哈希键 + 模版/教材变体 + 原子写 + 统计）
smoke.mjs             52 项零模型冒烟测试
e2e.mjs               13 项真机 E2E（四种题型 / 教材自行检索 / 图片题 / 联网搜索 / 缓存 / metrics）
package.json          只有 scripts 和 pi 插件声明（无 npm 依赖）
.pi/settings.json     把 @ssk_dev/pi-web-access-lean 声明成项目插件（供手动 pi 调试；服务端用 -e 显式挂）
answerer.config.json  给 OCS 官方 test:answerer 用的调试配置
config.example.json   带注释的完整配置模板
textbooks/            参考教材目录（.md/.txt，丢进去即可）
ocs-e2e/agent-resolver.check.ts
                      喂 OCS 官方解析器的端到端校验（拷到 ocsjs 仓库根目录跑）
cache.json            运行时生成的题库缓存（可当私有题库导出）
```
