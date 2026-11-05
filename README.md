# dsh-cache-probe

在 DSH Web GUI 里打开一个独立的 **渠道测试** 页面，测试任意已配置渠道的提示词缓存命中率、响应速度，并用「鹈鹕测试」检验模型能否画出可用的 SVG。

页面通过插件自己的 Host HTTP 接口运行测试，结果直接画在页面里；不注册 slash 命令，不往对话写命令卡片，也不会产生模型可见的消息。

## 入口

两个入口打开同一个页面：

- 输入框下方统计徽标行末尾的 **「渠道测试」** 按钮；
- 侧边栏的 **渠道测试** 页面图标（像技能中心/插件页一样常驻）。

页面替换中栏会话；点 **「返回会话」** 回到原会话。切换页面再回来，最近一次结果仍在。

## 页面

```text
渠道测试
测试任意已配置渠道的提示词缓存命中率与响应速度

供应商 [ a6中转 ▾ ]   模型 [ deepseek-v4.1-flash-1017 ▾ ]   [返回会话]

[全部运行] [测缓存] [测速] [鹈鹕测试]   就绪

高级设置 ▸
  ┌ 缓存测试 ──────────────────────────────
  │ 载荷字符数  缓存复测次数  缓存等待秒数  单次超时秒数  缓存思考等级
  └
  ┌ 测速 ──────────────────────────────────
  │ 目标输出 tokens  测速轮数  轮间隔秒数  单次超时秒数  测速思考等级
  └
  ┌ 鹈鹕测试 ──────────────────────────────
  │ 单次超时秒数  鹈鹕思考等级
  └

┌ 缓存命中率 ──────────────────────────────────────────────────────┐
│ 复测命中 99.4%                                                    │
│ 缓存生效（最近 99.4%，最好 99.4%）                                │
│ 轮次 prompt 未缓存 缓存读 …                                        │
│ 平均（复测 N 轮）                                                  │
│ 真实流量（不含本次测试）                                           │
│ 文本报告 ▸                                                        │
└──────────────────────────────────────────────────────────────────┘
┌ 响应速度 ──────────────────────────────────────────────────────┐
│ TTFT 402ms · 85.3 tok/s                                        │
│ 首 token 402ms，生成 85.3 tok/s                                 │
│ 轮次 输出 tok TTFT tok/s 总耗时                                 │
│ 平均                                                            │
│ 文本报告 ▸                                                      │
└──────────────────────────────────────────────────────────────────┘
```

- **测缓存**：一次预热 + N 次复测，读取真实 `usage` 计算命中率。
- **测速**：N 轮短提示词，测 TTFT、输出 tok/s、总耗时。
- **鹈鹕测试**：一轮请求让模型画“骑自行车的鹈鹕”SVG，页面提取并渲染预览，同时记录 TTFT、tok/s、总耗时、推理/正文 token 和 SVG 字符数；不判断画得像不像，也不设输出上限。
- **全部运行**：缓存 → 测速 → 鹈鹕，逐项更新卡片；一项失败不会跳过另一项。
- 先选供应商，再选该供应商的模型；每个供应商会记住上次选的模型，切回来时自动恢复。
- 没有可用模型的供应商仍会显示，标注「无可用模型」；选中后模型下拉为空、运行按钮禁用。
- 运行中按钮与三个下拉全部禁用，状态显示「缓存测试中… / 测速中…」。
- **测试过程中**，结果区显示全宽进度面板：当前阶段、已用时间、预热/复测步骤条、等待倒计时、逐轮实时指标，以及「停止测试」按钮。
- 正常完成后进度面板收起，显示结果卡片；取消后保留已完成轮次的进度面板，标记「测试已停止」，不生成不完整的结果卡。
- 结果卡片包含逐轮表格、结论和可复制的文本报告；缓存卡还会显示来源会话的真实流量对照。
- 缓存表和测速表最后一行是平均：token/耗时取算术平均；缓存命中率按「总缓存读 ÷ 总 prompt」加权，且只统计复测轮、不含预热。失败轮不参与平均。
- 三张结果卡（缓存、测速、鹈鹕）纵向排列，每张独占一整行；窄屏同样是一列。
- 鹈鹕预览按宽度自适应并完整显示，预览框内没有滚动条；图片较高时由页面整体滚动。
- 每张结果卡标题下显示「上次检测 HH:mm:ss · 渠道 / 模型」；结果来自旧渠道时再追加「来自 渠道 / 模型」。
- 只保留全局最近一次缓存、测速和鹈鹕结果：刷新页面或重启 DSH 后仍会恢复；再测其中一项只更新该项。

页面内的供应商/模型选择只影响本页测试，**不会切换当前会话的聊天模型**。

## 测试口径

### 思考等级（三个测试各自独立）

「高级设置」里为缓存、测速、鹈鹕各有一个思考等级下拉，选项来自当前模型声明的 `reasoning.efforts`，包含 `无思考（off）` 与 `低 / 高 / 最高` 等模型实际支持的等级。默认都是 `low`，各自写入 localStorage，互不影响。

- 选 `off` 时请求带 `reasoning_effort: "none"`（需要渠道声明 `off` 档位）。
- 选 `low/high/max` 时按对应档位请求，思考过程不进入正文、不展示、不保存；只从 usage 的 `reasoningTokens` 读数量做统计。
- 模型不支持思考时三个下拉都禁用并显示「不支持思考」；切换模型后仍有效的档位会保留，失效的回落到 `low`。
- 档位来自 DSH 的 `llm.resolveModelInfo()`；如果渠道没有声明思考能力，就只能选模型自带的默认行为。

### 缓存

载荷为固定模板 + 随机 nonce 的长前缀（默认 12,000 字符），每轮内容完全相同：

1. 预热一次；
2. 等待 `wait` 秒；
3. 复测 `rounds` 次。

命中率采用与 DSH 内置统计一致的口径：

```text
cacheReadTokens ÷ (未缓存输入 + cacheReadTokens + cacheWriteTokens)
```

报告里的「真实流量」只汇总打开页面时所在会话已结算的 `assistant/message`，按 provider 分组，不包含本次测试。

### 测速

每轮短提示词带唯一 nonce，避免命中提示词缓存把 TTFT 测低。

- **TTFT**：开始流式请求到第一个 token 分片（文本、推理或工具调用参数）。
- **输出 tok**：`usage.outputTokens`，包含思考消耗的部分。
- **思考/正文字符数**：输出列下方显示 `思考 N 字 / 正文 M 字`，由插件自己统计流里的 `reasoning-delta` 与 `text-delta`。之所以不用 token 拆分，是因为 DSH 的 `dsh-llm-pi-ai` 适配器在 `mapUsage()` 里丢弃了渠道返回的 `completion_tokens_details.reasoning_tokens`，插件收不到真实思考 token 数；字符数是这个前提下唯一准确的口径。
- **输出速度**：`usage.outputTokens ÷ (finish 时间 − 首 token 时间)`，也就是（思考 + 正文）的总 token 除以生成时间。
- **总耗时**：开始流式请求到 finish。
- **思考开启时自动加预算**：DSH 的 `outputTokens` 已经包含思考部分，所以「目标输出 tokens」若只按正文估算，就会被思考吃光、正文为 0 字。实测 a6 + `low`：256 / 512 / 1024 全是 0 字，2048 才写出正文。因此思考等级不是 `off` 时，实际发送的上限是 `目标 + 2,048`；高级设置里会显示本轮实际生效的上限。
- 多轮时给出中位数与范围；只有 1 轮时不写「中位」。

## 默认参数

| 项目 | 参数 | 默认 | 范围 |
|---|---|---:|---:|
| 缓存测试 | 思考等级 | 低（low） | 模型声明的档位（含 off） |
| 缓存测试 | 载荷字符数 | 12,000 | 2,000–200,000 |
| 缓存测试 | 复测次数 | 2 | ≥1（无上限） |
| 缓存测试 | 等待秒数 | 10 | 0–120 |
| 缓存测试 | 单次超时 | 120s | 10–300 |
| 测速 | 思考等级 | 低（low） | 模型声明的档位（含 off） |
| 测速 | 目标输出 tokens | 256（思考关闭时即上限；开启时自动 +2,048） | 32–2,048 |
| 测速 | 轮数 | 3 | ≥1（无上限） |
| 测速 | 轮间隔 | 1s | 0–30 |
| 测速 | 单次超时 | 120s | 10–300 |
| 鹈鹕测试 | 思考等级 | 低（low） | 模型声明的档位（含 off） |
| 鹈鹕测试 | 单次超时 | 120s | 10–300 |

参数在页面「高级设置」里改，分成「缓存测试 / 测速 / 鹈鹕测试」三块，每块只放自己那个测试的参数，思考等级和单次超时也各归各块、互不影响。都写入 localStorage，下次打开继续使用。缓存复测次数和测速轮数不设上限；轮次越多，耗时和费用越高，每轮都是真实请求。

## 成本

- 三个测试都会发送**真实计费请求**。
- 默认缓存：3 次请求（预热 + 2 次复测），每次约 3,000 prompt token + 32 output token。
- 默认测速：3 轮 × 256 output token，prompt 约 30 token/轮。
- 默认鹈鹕：1 轮，不设输出上限（DSH 落到模型配置上限；a6 实测约 1.2 万 output token），prompt 约 50 token。
- 页面不会读取或打印 API Key；凭据由 DSH 的 provider 配置提供。
- 同一时间只允许一个测试；第二个请求返回 409「已有渠道测试正在进行」。

## Host 接口

页面使用两条同源 HTTP 路由，不经过命令系统：

```text
GET  api/dsh-cache-probe/models?sessionId=...
POST api/dsh-cache-probe/run
```

`models` 返回 active providers、各自模型、模型的 `reasoning.efforts` 和默认路由；`run` 接收：

```json
{
  "kind": "cache",
  "provider": "a6",
  "model": "deepseek-v4.1-flash-1017",
  "sessionId": "可选",
  "reasoning": { "cache": "low", "speed": "low", "pelican": "off" },
  "cache": { "size": 12000, "rounds": 2, "wait": 10, "timeout": 120 },
  "speed": { "tokens": 256, "rounds": 3, "gap": 1, "timeout": 120 },
  "pelican": { "timeout": 120 }
}
```

`reasoning` 也接受 0.5.0 的单个字符串形式，此时三个测试共用同一个档位。

`kind` 支持 `cache`、`speed`、`pelican`；鹈鹕返回 `pelican.attempt`、`text`、`svg`、`svgSource`、`svgLength`、`report`、`summary`。

返回结构化 `attempts`、`summary`、`report`；缓存还带 `sessionChannels`。单次只接受 `cache`、`speed` 或 `pelican`，「全部运行」由页面顺序发三次请求。

请求头带 `x-dsh-cache-probe-stream: 1` 时，`run` 改为返回 `application/x-ndjson` 流，逐行推送：

```text
start → attempt-start → attempt → wait → wait-done → done
```

- `attempt` 每完成一轮就到达，页面实时填表；
- `wait` 用于缓存等待/测速间隔倒计时；
- `done` 携带与普通 JSON 响应相同的最终结果；
- 旧 Host 忽略该头并返回 JSON，新客户端会自动回退，只是没有逐轮实时过程。

### 安全围栏

- 只允许 loopback socket + loopback Host，拒绝 `cf-connecting-ip` / `x-forwarded-for` 代理跳；
- 拒绝 `sec-fetch-site: cross-site`，`Origin` 必须与 Host 同源；
- 有 `remoteWebUiPairing` 时，已配对设备 cookie 作为第二条放行路径；
- `POST` 额外要求 `x-dsh-cache-probe: 1` 请求头；
- 请求体上限 64 KiB；失败统一返回 `{ ok:false, error:{ code, message } }`。

## 安装

需要带 Web GUI 的 DSH profile（`web` 或 `desktop`）；CLI/headless profile 不显示页面。

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-cache-probe
```

`desktop` profile 把 `web` 换成 `desktop`。npm 包是预构建版本，安装时不需要 `allowBuilds` 授权。

### 从 GitHub 安装

npm 不可用时，也可以直接指向仓库：

```sh
dsh plugin --profile web add https://github.com/xymy666/dsh-cache-probe
```

安装后重启 DSH 一次，让 Host 路由加载；之后刷新页面即可。

本地开发时用 `link:` 指向 checkout：

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-cache-probe"
```

然后确认：

1. 输入框下方只有一个「渠道测试」按钮；
2. 侧边栏出现「渠道测试」图标；
3. 点击任一入口打开页面，供应商下拉能列出已启用渠道，模型下拉只显示所选供应商的模型。

## 开发

```powershell
git clone https://github.com/xymy666/dsh-cache-probe.git
cd dsh-cache-probe
node scripts/build.mjs     # 生成 lib/client.js（内联 options/stats/client）
node --test                # 98 个单测
node scripts/verify.mjs    # 包结构 + bundle + profile 安装状态
```

目录：

```text
lib/index.js          Host 路由入口
lib/client.js         构建产物（不要手改）
src/http.mjs          loopback/配对围栏、JSON body、响应
src/routes.mjs        models / run 两条 Host 路由
src/options.mjs       默认值、范围、参数校验
src/probe.mjs         缓存探测执行、摘要、报告
src/speed.mjs         测速执行、摘要、报告
src/pelican.mjs       鹈鹕 SVG 提示词、提取/清理、摘要、报告
src/payload.mjs       缓存探测长前缀
src/stats.mjs         usage/计时汇总与格式化（Host 与页面共用）
src/errors.mjs        失败码文案
src/client.mjs        controller、页面、侧边栏图标与输入框按钮
scripts/              构建与校验
test/                 单测
```

## 已知限制

- 页面只在有 `webServer` 与 Web GUI 的 profile 加载；CLI/headless 不显示页面。
- 实时逐轮进度与「停止测试」需要新版 Host；旧 Host 会自动回退到一次性 JSON 结果，停止只释放本页等待，Host 请求可能继续到超时。升级后必须重启 DSH 才能启用流式进度。
- 结果保存在 localStorage：只保留全局最近一次缓存、测速和鹈鹕结果，刷新页面或重启 DSH 后恢复；切换供应商/模型或修改参数不会清空当前显示。
- 鹈鹕 SVG 只做提取和基础清理（去脚本、事件属性、外链、foreignObject）；清理后仍不安全的 SVG 不渲染，只显示原始文本。
- 鹈鹕测试不判断画得像不像，也不重试；模型不返回 SVG 时卡片显示「无 SVG」并保留原始回复。
- 供应商下拉只列当前 active 的 provider；未启用或缺凭据的渠道不会显示。没有模型的供应商会标注「无可用模型」。
- 测试页面内的供应商/模型选择不改变聊天模型；需要切换聊天模型请回会话操作。
- 测速只测流式 token 时间，不测网络 ping/首字节；长上下文 prefill 由缓存测试的长前缀覆盖。
- 渠道不返回 usage 时，TTFT/总耗时仍可显示，但 tok/s 与命中率无法计算。
- 缓存测试默认等待 10 秒，实际耗时可能超过半分钟；这是为了给上游缓存生效留时间。

## License

MIT