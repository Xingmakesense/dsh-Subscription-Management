# dsh-Subscription-Management

> 版本 `1.3.2` · 需要 DSH `>= 0.2.1-rc.2`

DSH 的多厂商订阅插件：左侧栏显示真实订阅额度与 DeepSeek 余额/今日用量，设置页一行一个厂商完成订阅认证；Claude 与 ChatGPT 的订阅登录会直接挂成 DSH 原生 provider，模型选完就能用。

## 三条设计原则

1. **订阅按提供商精确匹配。** 只有当前模型所属的 provider 完全等于该厂商声明的 `providerIds` 时，卡片才显示这家订阅的额度；第三方中转商提供的同名模型不会被当成官方订阅。
2. **API Key 类订阅不替用户写模型设置。** Kimi Code、Mistral、Z.ai / GLM、Qwen、MiniMax、Cerebras、Kilo 等由你在控制台创建“走订阅的 API Key”，模型也在 DSH 设置 → 模型中自己添加；插件只做认证与额度。
3. **登录类订阅由插件接下。** Claude Pro/Max 与 ChatGPT Plus/Pro 没有可用 API Key，只有 OAuth 登录，所以本插件把它们挂成原生 provider（`claude-subscription` / `codex-subscription`）。连同 Protocom、OpenCode Go、Command Code、ClinePass（插件自带 provider runtime），这 6 家在认证后自动写入对应 provider 分组、上下文档位与图片能力。

## 功能

- 5 小时、周、月及模型专用额度窗口；短窗口在内、长窗口在外，两个额度并排，最外层额度使用整行横条。
- 剩余百分比与横条：超过 10% 为绿色，不超过 10% 为红色，缺失值显示 `—`。
- **等价额度型订阅**：Mistral 只有月度窗口，返回的是金额（`initial_budget` + `usage_percentage`），卡片直接显示剩余等价额度，百分比只作为条形图参考。
- **订阅登录直挂原生 provider**：Claude 与 ChatGPT/Codex 用你的 OAuth 登录作为 DSH provider，不需要另装适配插件，也不需要把订阅 token 当 API Key 填进别处。
- 严格提供商匹配，未匹配时保留上一个厂商，不刷新、不乱切；模型选择里能识别出的厂商始终优先于“刚验证成功”的厂商。
- 其他已配置厂商的后台刷新只更新各自缓存的额度，不会改变卡片当前显示的厂商、也不会打断正在进行的请求。
- 每轮对话结束自动刷新，也可点击卡片手动刷新；同厂商验证共享进行中的 Promise，初始化不重复请求。
- 卡片每 5 分钟自动刷新：定时器每分钟唤醒，只在满 5 分钟、页面可见、且没有请求在途时触发；手动刷新与轮次结束刷新会重置窗口，隐藏标签页不轮询。
- 余额与今日用量来自 DeepSeek 官方余额接口或 DSH `deepseekAccount`，今日用量由插件自己的余额差账本计算。
- **卡片布局保持原样**：仍然只显示当前模型对应厂商的三个窗口与横条；其余已配置厂商的额度写在同一张卡片的悬停提示里（“其他订阅：…”）。认证成功后卡片立刻切换到该厂商并刷新额度，不需要等 5 分钟。
- 设置页“订阅认证”一行一个厂商，常态收起，悬停或点击展开账户卡；管理模式可拖动显示/隐藏并保存。
- 认证、额度与 RPC 全部使用插件自己的 `/dsh-subscription-management` 前缀和 `dsh-subscription-management:auth` 事件，不占用其他插件的接口。

## 官方订阅：API Key 与控制台

下表说明各厂商“在哪里创建 Key、Key 是否走订阅额度”。创建 Key 与配置模型都由你完成。

| 厂商 | 控制台 | Key 与订阅额度的关系 | 用量接口 |
|---|---|---|---|
| Kimi Code | https://www.kimi.com/code | 订阅后在控制台另发 API Key，走 Kimi Code 额度 | `api.kimi.com/coding/v1/usages` |
| Mistral | https://console.mistral.ai/api-keys | Key 属于 Workspace；额度是 Organization 的 monthly included usage，跨 Studio / API / Vibe 共享 | `GET /v1/billing/budget` + `/v1/billing/subscription` |
| Z.ai / GLM Coding Plan | https://z.ai/manage-apikey/apikey-list | Standard Key 与 Coding Plan Key 分开计费，用 Standard Key 不消耗订阅额度 | `api.z.ai/api/monitor/usage/quota/limit` |
| Qwen Coding Plan | https://modelstudio.console.alibabacloud.com | Coding Plan 单独发 Key（`BAILIAN_CODING_PLAN_API_KEY`） | Model Studio 控制台 RPC |
| MiniMax M Plan | https://platform.minimax.io | 在 Plan Details 领 M Plan Key | `token_plan/remains` |
| Cerebras Code | https://cloud.cerebras.ai | 用 API Key 验证账号可用性 | `/v1/models` |
| Kilo | https://app.kilo.ai | Kilo API Token 走 credits | `app.kilo.ai/api/trpc` |

如果你在第三方中转商或自建网关里使用同名模型：不会被算作官方订阅。请为官方订阅单独建一个 DSH provider，并把该 provider 的 id 写进 `subscriptions.json` 的 `providerIds`（仓库已内置常见 id：`z.ai` / `zai` / `zhipu`、`dashscope`、`moonshot`、`chatgpt` / `codex`、`antigravity`、`mistral`、`protocom-*` 等）。

## 认证与用量支持

| 厂商 | 认证方式 | 用量来源 |
|---|---|---|
| Kimi | 订阅 API Key、设备 OAuth | `api.kimi.com/coding/v1/usages`，支持新旧窗口与 OAuth 刷新 |
| ChatGPT / Codex | Codex CLI 只读导入或 OAuth JSON | 额度 `chatgpt.com/backend-api/wham/usage`；模型由本插件挂载的 `codex-subscription` 服务 |
| Claude | Claude Code 只读导入或 OAuth JSON | 额度 `api.anthropic.com/api/oauth/usage`（需 `user:profile`）；模型由本插件挂载的 `claude-subscription` 服务 |
| GLM | Z.ai / GLM Coding Plan API Key | Z.ai quota 接口，中国区回退 |
| Qwen | Alibaba Coding Plan / DashScope API Key | Alibaba Coding Plan console RPC，国际/中国区回退 |
| Gemini | Gemini CLI OAuth 只读导入 | `v1internal:retrieveUserQuota` |
| Google Antigravity | `agy` 只读导入或粘贴 token JSON | `v1internal:retrieveUserQuotaSummary`：5 小时 + 周窗口 |
| Mistral | Mistral API Key | `GET https://api.mistral.ai/v1/billing/budget`：月度等价额度 |
| Devin | `devin-session-token$` 会话 Token | Codeium `GetUserStatus` |
| Kilo | Kilo API Token 或 CLI 只读导入 | `app.kilo.ai/api/trpc` |
| Kiro | `kiro-auth-token.json` 或 OAuth JSON | `q.<region>.amazonaws.com/getUsageLimits` |
| Cerebras | Cerebras API Key | `/v1/models` 验证 Key |
| MiniMax | MiniMax Subscription Key | `token_plan/remains`，中国区回退 |
| Trae CN | 浏览器 Cookie | Host 内换短期 Token 后读 entitlement，交换 Token 不保存 |
| Protocom | 四个分组各自的 API Key | 作者 `BalanceService` 读取 `/v1/usage` |
| OpenCode Go | Go 订阅 API Key | 作者 `GoUsageService` 读取 `/v1/usage` |
| Command Code | 订阅 API Key | 作者 `CommandCodeAccountService` 读取 credits/usage |
| ClinePass | ClinePass API Key | Host 保存并验证凭据 |

## 订阅登录类 provider（Claude / Codex）

| provider id | 认证 | 端点 | 关键约束 |
|---|---|---|---|
| `claude-subscription` | Claude OAuth access token（每次请求读取，过期自动刷新；CLI 导入的记录只读不写） | `POST https://api.anthropic.com/v1/messages?beta=true` | 头：`Authorization: Bearer`（不发 `x-api-key`）、`anthropic-version: 2023-06-01`、`anthropic-beta: oauth-2025-04-20`、`user-agent: claude-cli/...`、`x-app: cli`；`system` 必须是块数组，首块精确等于 `You are Claude Code, Anthropic's official CLI for Claude.` |
| `codex-subscription` | ChatGPT OAuth access token + 账号 id（取自 Codex `auth.json` 的 `tokens.account_id`） | `POST https://chatgpt.com/backend-api/codex/responses` | 头：`Authorization: Bearer`、`chatgpt-account-id`、`OpenAI-Beta: responses=experimental`、`originator: codex_cli_rs`、`session_id`；body `store:false`、`tool_choice:auto`、`parallel_tool_calls:true`、`include:["reasoning.encrypted_content"]` |

模型目录写在 `host/provider-runtime/subscription-oauth.js` 的 registry 里：Claude 侧是 Opus / Sonnet / Haiku 5.5 与 4.x 系列（200K，另带 1M 档位），Codex 侧是 GPT-6 Astra 与 GPT-5.6 / 5.5 系列（272K）。厂商上新型号时改这一处即可。

## 开发经验与踩过的坑

这一节记录设计决策和踩过的坑，改代码前值得先读一遍。

**版本演进**：1.0.x 只做订阅认证与额度；1.1.0 把厂商匹配改成严格 provider、加入 Antigravity 与 Mistral、取消 API Key 类订阅的自动模型配置；1.2.0 把 Claude / ChatGPT 订阅直挂成原生 provider。

1. **不要用模型名推断厂商。** 早期实现拿“模型名 + provider”做子串匹配，结果第三方中转商送来的 `glm-4.6` 命中了 `glm`，卡片直接切到 Z.ai 订阅套餐。现在只认 `providerIds` 的**整串相等**（大小写无关）；任何“看起来像”的推断都会在第三方中转 / 自建网关场景翻车。
2. **proto3 会省略 0。** Antigravity 的 `remainingFraction` 缺失时，若当成“未知”就会显示假 100%；规则是：有 `resetTime` 但无 fraction = **已耗尽**。同类问题还有“零 limit 不能算百分比”“缺失 window 不能推断成周”。
3. **消费者 OAuth 的认证头与 API Key 不同。** Claude 只认 `Authorization: Bearer`，同时发 `x-api-key` 会被拒；`system` 也必须是块数组、首块为 CLI 身份串（纯字符串会被拒）。所以这类通道要自己写 fetch，而不是改 vendored 的传输。
4. **Codex 的 URL 不在 `/v1` 下。** vendored 传输固定拼 `${baseURL}/v1/${path}`，`/backend-api/codex/responses` 拼不出来；另外 `chatgpt-account-id` 来自 `auth.json` 的 `tokens.account_id`，不在 token 里。
5. **vendored 文件只允许追加导出。** 为了保住上游可合并性，对 `host/provider-runtime/protocom-api.js` 只追加了 3 个导出（+4 行、零语义改动）；升级上游时先确认这几个符号还在。
6. **OAuth 刷新要分清所有权。** 只刷新自己在凭据库里的记录；官方 CLI 的文件每次重读、绝不写回，否则会破坏用户已登录的 CLI 会话。刷新要留 5 分钟余量，刷新后必须用新 token 重算验证指纹，否则状态会退回“未验证”。
7. **上下文档位不要一律写 1M。** 现在写厂商声明的档位（Claude `[200000,1000000]`、Codex `[272000]`），relay 家族才回落到 1M；分组里已有自定义值时绝不覆盖。
8. **cordis 4.1 不要碰 fiber 内部字段。** `Fiber.store` 已改为 `committed`，旧写法会静默失败，表现为整条 RPC 通道 405；只用 `webServer.register` + `connection.requestRejection`，并且鉴权必须 fail-closed（拿不到校验服务就回 503）。
9. **读 Electron 的 asar 不要假设固定偏移。** 不同版本在 JSON 前的前缀字段数不同；稳妥做法是在 header pickle 里找第一个 `{`，body 偏移用 `8 + headerPickleSize + offset`。
10. **金额型额度与百分比型要分开建模。** Mistral 返回的是等价额度（金额 + 已用百分比）；硬算成百分比再显示会丢信息。额度行带 `unit` / `currency`，卡片直接显示剩余金额。
11. **RPC 与事件名必须自持。** 复用其他插件的通道或事件名会互相抢注册；本插件使用自己的 `/dsh-subscription-management` 与 `dsh-subscription-management:auth`。
12. **刷新节流只保留一个入口。** 卡片用一个 60 秒 tick 的定时器 + 5 分钟窗口，而不是每厂商独立轮询；隐藏页不轮询；手动刷新与轮次结束刷新必须重置窗口。同厂商验证用 single-flight，写操作按厂商串行。
13. **合规是长期的坑。** Antigravity、Claude、Codex 的额度与模型通道都是官方 CLI 使用的消费者接口，不是面向第三方客户端的公开 API；插件只透传用户自己订阅授权范围内的请求，不做代理、不做多账号池、不共享凭据。厂商条款与封禁风险由使用者自行承担。

## 安装

### 从源码打包

`client.js` 由 `scripts/build-client.mjs` 生成，打包前必须确保它与 `client/*.js` 同步：

```bash
node scripts/build-client.mjs
pnpm pack --pack-destination dist
```

在 DSH **插件管理 → 安装插件** 中选择生成的 `.tgz`，然后刷新页面。升级时提高 `package.json` 的版本号再打包。

### 从源码开发

```bash
git clone <repo-url>
cd dsh-Subscription-Management
pnpm install                                    # 仅为运行 host/provider 验证脚本
node scripts/build-client.mjs --check
```

`client.js` 是生成产物，不要直接编辑；修改 `client/*.js` 或 `subscriptions.json` 后运行 `node scripts/build-client.mjs` 重新生成，`--check` 只校验生成结果是否过期。

## 兼容性

- DSH `>= 0.2.1-rc.2`（本版本在 DSH `0.2.2-rc.3` 上验证），与 `package.json` 的 `engines.dsh` 一致。
- `@deepseek-ai/cordis` 支持 `>= 4.0.4 <5`：Host RPC 只使用 Cordis 与 DSH 的公开接口。
- Node.js `>= 18`：验证脚本使用内置 `fetch` / `Response`，不依赖额外 HTTP 库。
- 运行时的 `@deepseek-ai/*` 服务由 DSH profile 提供；`dependencies` 中的 `@deepseek-ai/schemastery` 与 `eventsource-parser` 随插件安装。
- 本仓库不包含 `node_modules`；跑 Host 与 provider runtime 的验证脚本前先 `pnpm install`。

## 配置

默认 `enabled: true`。在 bundle row 中可写：

```yaml
- id: dsh-subscription-management
  name: dsh-subscription-management
  config:
    enabled: false
```

`enabled: false` 时不注册卡片、设置入口或账户 RPC，也不注册 Host 路由。

账户 RPC 由插件自己在 Host `webServer` 上注册 `/dsh-subscription-management` 前缀路由：只接受 `POST` + `application/json` 的 `client-request` 信封，返回 `server-response`；每次请求先经 `connection.requestRejection` 做 Host/Origin 与浏览器会话校验，校验服务不可用时直接失败关闭（HTTP 503）。

## 性能与存储

- 初始化只发一次订阅请求；同厂商验证 single-flight，避免卡片与设置页重复请求。
- 自动刷新只有一个 60 秒 tick 的 `setInterval`，满足窗口条件才真正发起，隐藏标签页不轮询。
- 新厂商统一经现有 Host RPC 分发；厂商额度服务复用作者的 60 秒缓存与失败退避，没有第二套并行 HTTP 适配器。
- 原生配置解析结果按配置与凭据版本复用；摘要与 Key 在展开周期内复用；不持久化原始响应或 Key。
- 最近验证成功的厂商记录为轻量指针，启动时先检查它，避免扫描全部凭据。
- 状态与 DeepSeek 账本独立保存在 profile 的 `.dsh-subscription-management/` 下。

## 测试

```bash
node scripts/build-client.mjs --check  # client.js 是否与 client/*.js 同步
node verify-host.cjs                   # Host 配置归一化与入口契约
node verify-client.mjs                 # 卡片布局、严格提供商匹配、等价额度、面板渲染与余额账本
node verify-subscriptions.mjs          # 凭据、OAuth 刷新、用量解析（含 Antigravity / Mistral）与验证指纹
node verify-provider-runtime.mjs       # provider 注册、模型发现、订阅登录 provider 的请求形状与流翻译、额度缓存与遥测投影
node verify-channel.mjs                # Host RPC 前缀路由、信封契约与失败关闭
node verify-compat.mjs                 # 与本机 DSH 版本的槽位/清单兼容性
```

`pnpm test` 依次运行上述构建检查与六个验证脚本。脚本只使用假凭据、临时目录与 HTTP fixture；`verify-subscriptions.mjs` 覆盖 Antigravity 的双窗口与 proto3 省略 0 的耗尽语义、Argon 只由组名/桶 id 判定、Mistral 的金额型月额度，以及目录约束（只有插件实际提供模型的厂商允许自动配置）。`verify-provider-runtime.mjs` 另外断言两条订阅登录 provider 的 URL、请求头、Claude 的 system 身份块、Codex 的请求标志与 SSE → chunk 翻译。

## 文件结构

- `client/`：卡片、认证页、厂商目录与轮次刷新状态机。
- `host/accounts.js`：DeepSeek 余额/今日账本、Host RPC 前缀路由与请求信封处理。
- `host/subscriptions/`：凭据、CLI 导入、Kimi 设备 OAuth、HTTP、验证与用量适配器。
- `host/provider-runtime/`：DSH 原生模型注册、作者额度服务接入与统一视图投影，以及源自 `dsh-protocom-api` 的 Host 协议与模型运行时。
- `host/provider-runtime/subscription-oauth.js`：Claude 与 ChatGPT/Codex 订阅登录 provider，复用 vendored 的请求序列化与 SSE 翻译，只替换 URL、认证头与 Claude 的 system 身份块。
- `subscriptions.json`：唯一厂商目录（`providerIds`、`modelSetup`、`quotaKind`、`quotaSource`），构建时注入 Client。
- `docs/QUOTA-SOURCES.md`：各厂商额度接口的字段与来源汇总。
- `verify-*.mjs` / `verify-host.cjs`：六个独立验证脚本。

## 参考资料

- 各厂商额度接口的字段汇总：[docs/QUOTA-SOURCES.md](docs/QUOTA-SOURCES.md)
- Mistral 计费与额度：https://docs.mistral.ai/admin/billing-usage/subscriptions 、 https://docs.mistral.ai/admin/billing-usage/usage-limits
- Mistral 控制台 API Key：https://docs.mistral.ai/admin/identity-access/api-keys
- Antigravity 官方计划与 `/usage`：https://antigravity.google/docs/plans 、 https://antigravity.google/docs/cli/commands/usage
- Z.ai Coding Plan Key 说明：https://docs.z.ai/devpack/notice/api-key-management
- Claude / Codex 通道的字段与实测记录见 `tmp/claude-codex-wire.md`（本地调研资料，不入库）

## 许可证

[MIT](LICENSE)

`host/provider-runtime/protocom-api.js` 来源于 AIMFllyYS 的 `dsh-protocom-api`（MIT），其许可证见 `host/provider-runtime/PROTOCOM-LICENSE`。

