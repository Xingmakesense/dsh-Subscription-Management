# dsh-Subscription-Management

> 版本 `1.2.0` · 需要 DSH `>= 0.2.1-rc.2`

独立的多厂商订阅管理与模型接入插件：左侧栏显示真实订阅额度与 DeepSeek 余额/今日用量，设置页提供一行一个厂商的订阅认证。

两条硬规则：

1. **订阅按提供商精确匹配。** 侧栏卡片只有在当前模型所属的 provider 完全属于某厂商时，才显示该厂商的额度。第三方中转商提供的 GLM / Qwen / Claude 模型不会被当成官方订阅，也不会切换订阅套餐。
2. **API Key 类订阅不替用户配置模型。** Kimi Code、Mistral、Z.ai / GLM、Qwen、MiniMax、Cerebras、Kilo 等由用户在自己的控制台创建“走订阅的 API Key”，模型也在 DSH 设置 → 模型中由用户添加；插件只负责认证与额度。
3. **订阅登录类由插件直接接下。** Claude Pro/Max 与 ChatGPT Plus/Pro 没有可用 API Key，只有 OAuth 登录，所以本插件把两者直接挂成原生 provider（`claude-subscription` / `codex-subscription`），模型在 DSH 里直接可选。连同 Protocom、OpenCode Go、Command Code、ClinePass（插件自带 provider runtime），这 6 家在认证后会自动写入对应的 provider 分组、上下文档位与图片能力。

## 功能

- 5 小时、周、月及模型专用额度窗口；短窗口在内、长窗口在外，两个额度并排，最外层额度使用整行横条。
- 剩余百分比与横条：超过 10% 为绿色，不超过 10% 为红色，缺失值显示 `—`。
- **等价额度型订阅**：Mistral 只有月度窗口，接口返回的是金额（`initial_budget` + `usage_percentage`）而不是百分比，卡片直接显示剩余等价额度，百分比只作为条形图参考。
- **订阅登录直挂原生 provider**：Claude 与 ChatGPT/Codex 用你的 OAuth 登录直接作为 DSH 的 provider 使用，不需要另装适配插件、也不需要把订阅 token 当成 API Key 填进别处。
- **严格提供商匹配**：`subscriptions.json` 为每个厂商列出精确的 `providerIds`，匹配一律整串相等（大小写无关），不做子串或模型名推断。未匹配时保留上一个厂商或设置页里最近验证成功的厂商，不刷新、不乱切。
- 每轮对话结束自动刷新，也可点击侧栏卡片手动刷新；同厂商验证共享进行中的 Promise，初始化不重复请求。
- 卡片每 5 分钟自动刷新一次：定时器每分钟唤醒并只在满 5 分钟、页面可见且没有请求在途时触发；手动刷新和轮次结束刷新会重置这个窗口，后台标签页不轮询，切回前台后按已过时间补刷。
- 余额与今日用量仍来自 DeepSeek 官方余额接口或 DSH `deepseekAccount`，今日用量由本插件自己的余额差账本计算。
- 设置页“订阅认证”一行一个厂商，常态收起，悬停或点击展开融合账户卡；管理模式提供显示/隐藏两个栏目，保存后生效。
- 每家厂商卡片标注额度来源（官方接口 / 社区逆向 / 作者服务 / 无端点），并提示是否需要自己去控制台创建 Key。
- 订阅页顶部说明原生模型设置入口；官方订阅的模型、上下文、视觉与思考强度全部由用户自己管理。
- RPC 与认证事件使用插件自己的 `/dsh-subscription-management` 和 `dsh-subscription-management:auth` 命名，不占用其他插件的接口。

## 官方订阅：API Key 与控制台

下表说明各厂商“在哪里创建 Key、Key 是否走订阅额度、额度接口是什么”。**创建 Key 与配置模型都由你完成，插件不会替你写入模型设置。**

| 厂商 | 控制台 | Key 与订阅额度的关系 | 额度接口 | 来源 |
|---|---|---|---|---|
| Kimi Code | https://www.kimi.com/code | 订阅后在控制台另发 API Key（有数量上限），走 Kimi Code 额度 | `api.kimi.com/coding/v1/usages` | 官方 |
| Mistral | https://console.mistral.ai/home?profile_dialog=api-keys | Key 属于 Workspace；额度是 Organization 的 included monthly usage，跨 Studio / API / Vibe 共享；没有 plan-scoped key | `GET /v1/billing/budget` + `/v1/billing/subscription` | 官方 |
| Z.ai / GLM Coding Plan | https://z.ai/manage-apikey/apikey-list | **Standard Key 与 Coding Plan Key 分开计费**，用 Standard Key 不会消耗订阅额度 | `api.z.ai/api/monitor/usage/quota/limit` | 社区逆向 |
| Qwen Coding Plan | https://modelstudio.console.alibabacloud.com | Coding Plan 单独发 Key（`BAILIAN_CODING_PLAN_API_KEY`），endpoint 走 `coding-intl.dashscope.aliyuncs.com/v1` | Model Studio 控制台 RPC | 社区逆向 |
| MiniMax M Plan | https://platform.minimax.io | 在 Plan Details 领 M Plan Key | `token_plan/remains` | 社区逆向 |
| Cerebras Code | https://cloud.cerebras.ai | Key 可建，但与 Code 订阅的绑定关系未确认 | `/v1/models`（仅验证 Key） | 社区逆向 |
| Kilo | https://app.kilo.ai | Kilo API Token 走 credits | `app.kilo.ai/api/trpc` | 社区逆向 |
| Google Antigravity | https://antigravity.google | 没有订阅 API Key，只有 Google 账号 OAuth；官方不支持 BYOK | `v1internal:retrieveUserQuotaSummary` | 社区逆向 |
| 其余厂商 | 见设置页“打开官方控制台” | 见下方认证表 | 见下方认证表 | — |

如果你在第三方中转商或自建网关里使用同名模型：**不会**被算作官方订阅。请为官方订阅单独建一个 DSH provider，并把该 provider 的 id 写进 `subscriptions.json` 的 `providerIds`（仓库已内置常见 id：`z.ai` / `zai` / `zhipu`、`dashscope`、`moonshot`、`chatgpt` / `codex`、`antigravity`、`mistral`、`protocom-*` 等）。

## 认证与用量支持

| 厂商 | 认证方式 | 用量/验证来源 | 来源可信度 |
|---|---|---|---|
| Kimi | 订阅 API Key、设备 OAuth | `api.kimi.com/coding/v1/usages`，支持新旧窗口与 OAuth 刷新 | 官方 |
| ChatGPT / Codex | Codex CLI 只读导入或 OAuth JSON | 额度：`chatgpt.com/backend-api/wham/usage`；模型：本插件挂载 `codex-subscription` → `chatgpt.com/backend-api/codex/responses` | 社区逆向 |
| GLM | Z.ai / GLM Coding Plan API Key | Z.ai quota 接口，中国区可回退 | 社区逆向 |
| Qwen | Alibaba Coding Plan / DashScope API Key | Alibaba Coding Plan console RPC，国际/中国区回退 | 社区逆向 |
| Claude | Claude Code 只读导入或 OAuth JSON | 额度：`api.anthropic.com/api/oauth/usage`（要求 `user:profile`）；模型：本插件挂载 `claude-subscription` → `api.anthropic.com/v1/messages?beta=true` | 官方（额度）/ 社区逆向（模型通道） |
| Gemini | Gemini CLI OAuth 只读导入 | `v1internal:retrieveUserQuota`，不接受 AI Studio/Vertex Key 冒充订阅 | 官方 |
| Google Antigravity | `agy` 只读导入（`~/.gemini/antigravity-cli/antigravity-oauth-token`）或粘贴 token JSON | `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`：5 小时 + 周窗口；免费档没有 5 小时汇总时回退 `fetchAvailableModels` 的模型级额度 | 社区逆向 |
| Mistral | Mistral API Key | `GET https://api.mistral.ai/v1/billing/budget`（+ `/v1/billing/subscription` 取套餐名）：只有月度窗口，返回金额型等价额度 | 官方 |
| Devin | `devin-session-token$` CLI 会话 Token | Codeium `GetUserStatus` | 社区逆向 |
| Kilo | Kilo API Token 或 Kilo CLI 只读导入 | `app.kilo.ai/api/trpc` | 社区逆向 |
| Kiro | Kiro `kiro-auth-token.json` 或 OAuth JSON | `q.<region>.amazonaws.com/getUsageLimits`；订阅 API Key 的只读端点未确认，暂不接收 | 社区逆向 |
| Cerebras | Cerebras API Key | `/v1/models` 仅验证 API；无公开 Code 订阅余量接口，额度显示 `—` | 社区逆向 |
| MiniMax | MiniMax Subscription Key | `token_plan/remains`，必要时回退中国区 | 社区逆向 |
| Trae CN | 浏览器 Cookie | Host 内换短期 Token 后读 entitlement，不保存交换 Token | 社区逆向 |
| Protocom | 四个分组各自的 API Key | 作者 `BalanceService` 读取 `/v1/usage` | 作者服务 |
| OpenCode Go | Go 订阅 API Key | 作者 `GoUsageService` 读取 `/v1/usage`；5 小时、周、月窗口 | 作者服务 |
| Command Code | 订阅 API Key | 作者 `CommandCodeAccountService` 读取 credits/usage | 作者服务 |
| ClinePass | ClinePass API Key | 没有已确认的只读验证或额度端点，显示未验证与 `—`，不伪造数据 | 无端点 |

## Antigravity 细节

Antigravity 的额度逆向结果来自 `dsh-agy-link` 的实测（该项目的 `src/domain/quota/parse.ts`、`src/features/quota/http.ts`、`src/host/oauth.ts`），这里只保留查额度必需的最小面：

- 只请求消费级端点 `daily-cloudcode-pa.googleapis.com` 与其 sandbox 备份；**不使用**企业端点 `cloudcode-pa.googleapis.com`。
- 请求头只有三个：`Authorization: Bearer <access token>`、`Content-Type: application/json`、`User-Agent`。
- `User-Agent` 必须是 `antigravity/cli/<版本> (aidev_client; os_type=<os>; arch=<arch>; auth_method=consumer)`，版本低于 `1.3.0` 时回落到 `1.5.10`；`win32 → windows`、`x64 → amd64`。可用环境变量 `ANTIGRAVITY_AGY_VERSION` 覆盖版本号。
- 响应里的 `remainingFraction` 是 0..1 的**剩余**比例；proto3 会省略 0，因此“有 `resetTime` 但没有 `remainingFraction`”必须解读为 **已耗尽**，不能当成未知或 100%。
- 桶按窗口归类：`5h` / `five_hour` / `5-hour` 为 5 小时窗口，`week` / `weekly` 为周窗口；`bucketId` 与 `window` 任一命中即可，不假设字段固定。
- 多分组（Gemini、Claude/GPT、Pro/Ultra 专属 Gemini 4 Argon）各有自己的两个窗口。卡片显示每组窗口里**最紧（剩余最低）**的那个桶，其余分组以明细行列在账户卡里。专属 Argon 池只由组名或桶 id 证明，描述文字不算证据。
- 凭据：优先读 `~/.gemini/antigravity-cli/antigravity-oauth-token`（嵌套 `{"token":{...},"auth_method":"consumer"}` 或扁平结构都支持）。Windows 的活跃凭据通常在“凭据管理器”的 `gemini:antigravity` 条目里，插件**不读取系统凭据库**，需要你手动粘贴该 JSON。
- CLI 导入只保存文件链接、每次重新读取，因此 `agy` 自己的 token 轮换会被自动跟随；只有手动粘贴且带 `refresh_token` 的记录才会由本插件刷新（`https://oauth2.googleapis.com/token`）。
- 仓库**不内置**任何第三方 OAuth client 凭据：手动粘贴的凭据到期需要刷新时，请设置环境变量 `AGY_CLIENT_ID` / `AGY_CLIENT_SECRET`；否则重新用 `agy` 登录后导入文件即可（CLI 导入每次重新读取，会自动跟随 `agy` 的 token 轮换）。

## 订阅登录类 provider（Claude / Codex）

这张表说明插件挂载的两个 provider 用什么凭证、打到哪个端点、以及为什么：

| provider id | 认证 | 端点 | 说明 |
|---|---|---|---|
| `claude-subscription` | 你的 Claude OAuth access token（每次请求读取，过期自动刷新；CLI 导入的记录只读不写） | `POST https://api.anthropic.com/v1/messages?beta=true` | 头：`Authorization: Bearer`（**不发** `x-api-key`）、`anthropic-version: 2023-06-01`、`anthropic-beta: oauth-2025-04-20`、`user-agent: claude-cli/...`、`x-app: cli`。`system` 必须是块数组，**首块精确等于** `You are Claude Code, Anthropic's official CLI for Claude.`，否则 Sonnet/Opus 会返回 400。 |
| `codex-subscription` | 你的 ChatGPT OAuth access token + 账号 id（取自 Codex `auth.json` 的 `tokens.account_id`） | `POST https://chatgpt.com/backend-api/codex/responses` | 头：`Authorization: Bearer`、`chatgpt-account-id`、`OpenAI-Beta: responses=experimental`、`originator: codex_cli_rs`、`session_id`。请求体 `store:false`、`tool_choice:auto`、`parallel_tool_calls:true`、`include:["reasoning.encrypted_content"]`。 |

两个 provider 的模型目录写在目录文件里（不是网络发现）：Claude 侧是 Opus/Sonnet/Haiku 5.5 与 4.x 系列（200K，可选 1M 档位），Codex 侧是 GPT-6 Astra 与 GPT-5.6/5.5 系列（272K）。厂商改型号时更新 `host/provider-runtime/subscription-oauth.js` 的 registry 即可。

**风险与边界**：这两条通道是官方 CLI 客户端使用的消费者接口，不是面向第三方客户端的公开 API，可能违反厂商条款，也可能随时变更或封禁。插件只发送你自己订阅授权范围内的请求，不做代理、不做多账号轮询、不共享凭据；失败时把上游真实错误抛给 DSH，不伪造结果。

## 状态与安全

- **已配置不等于已验证**：保存后执行真实只读验证，成功才写验证指纹；过期 OAuth 不显示绿色状态。
- 官方 CLI 只保存文件链接，每次读取最新凭据，不写官方文件，不接管官方 CLI 的 refresh-token 生命周期。
- 手动 OAuth 只刷新本插件自己的记录，按厂商串行保存、刷新、验证和删除；验证使用刷新后的 Token 指纹。
- API Key、OAuth Token、Cookie 只由 Host 持久化；API 管理也使用 Host 凭据服务。
- 本地用户展开 API Key 厂商卡时，Host 才按次返回对应 Key 用于眼睛切换和复制。Key 默认以等长 `*` 遮蔽，只存在当前页面组件内存中，不写入 `localStorage`，折叠或更新凭据后清除。
- 普通 OpenAI API Key 不能冒充 ChatGPT 订阅 OAuth；Claude `setup-token` 不作为额度恢复手段；Antigravity 不接受裸 refresh token，需要含 access token 的完整 JSON。
- 社区内部接口可能变化，失败时显示真实错误，不伪造认证或额度。

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

本项目使用 `@deepseek-ai/schemastery` 与 `eventsource-parser`，并通过 DSH peer 服务接入模型和附件；安装包时由插件管理器处理依赖。

## 兼容性

- DSH `>= 0.2.1-rc.2`（本版本在 DSH `0.2.2-rc.3` 上验证），与 `package.json` 的 `engines.dsh` 一致。
- `@deepseek-ai/cordis` 支持 `>= 4.0.4 <5`：Host RPC 通道只使用 Cordis 与 DSH 的公开接口（`webServer.register` + `connection.requestRejection`），不读取 Connection 插件的 fiber 内部字段。
- Node.js `>= 18`：验证脚本使用内置 `fetch` / `Response`，不依赖额外 HTTP 库。
- 运行时的 `@deepseek-ai/*` 服务由 DSH profile 提供；`dependencies` 中的 `@deepseek-ai/schemastery` 与 `eventsource-parser` 随插件安装。
- 本仓库不包含 `node_modules`。运行 Host 与 provider runtime 的验证脚本时，需要能解析 `package.json` 中的依赖（`pnpm install` 即可）。

## 配置

默认 `enabled: true`。在 bundle row 中可写：

```yaml
- id: dsh-subscription-management
  name: dsh-subscription-management
  config:
    enabled: false
```

`enabled: false` 时不注册卡片、设置入口或账户 RPC，也不注册 Host 路由。非法配置安全回退为禁用。

账户 RPC 由插件自己在 Host `webServer` 上注册 `/dsh-subscription-management` 前缀路由：只接受 `POST` + `application/json` 的 `client-request` 信封，返回 `server-response`；每次请求先经 `connection.requestRejection` 做 Host/Origin 与浏览器会话校验，校验服务不可用时直接失败关闭（HTTP 503），不会放开 loopback 路由。

## 性能与存储

- 两个插件拆分后，本项目不加载滑条、节假日和档位引擎；原项目也不加载本项目的账户模块。
- 初始化合并为一次订阅请求；同厂商验证 single-flight，避免卡片和设置页同时发起重复请求。
- 自动刷新是一个 60 秒 tick 的 `setInterval`，不是每 5 分钟一次的裸定时器：只有满 5 分钟、页面可见、且没有请求在途才真正发起，隐藏标签页不轮询，卸载时随 effect 清理。
- 新厂商统一经现有 Host RPC 分发；上游获取直接复用作者的额度服务、60 秒缓存和失败退避，没有第二套并行 HTTP 适配器。
- 原生配置解析结果按配置与凭据版本复用，摘要和 Key 在展开周期内复用；不持久化原始响应或 Key。
- 最近验证成功的厂商记录为轻量指针，正常启动先检查该厂商，避免每次扫描全部凭据。
- 原始厂商响应只在请求期间存在，Client 只接收归一化窗口、脱敏状态，以及本地用户主动展开时读取的 API Key。
- 状态与 DeepSeek 账本独立保存在 profile 的 `.dsh-subscription-management/` 下，不与原插件共享缓存。

## 测试

`client.js` 的构建一致性、Client 纯数据逻辑与兼容性检查不依赖外部包；Host 与 provider runtime 的验证脚本需要能解析依赖（`pnpm install` 后在仓库内运行）。

```bash
node scripts/build-client.mjs --check  # client.js 是否与 client/*.js 同步
node verify-host.cjs                   # Host 配置归一化与入口契约
node verify-client.mjs                 # 卡片布局、严格提供商匹配、等价额度、面板渲染与余额账本
node verify-subscriptions.mjs          # 凭据、OAuth 刷新、用量解析（含 Antigravity / Mistral）与验证指纹
node verify-provider-runtime.mjs       # provider 注册、模型发现、订阅登录 provider 的请求形状与流翻译、额度缓存与遥测投影
node verify-channel.mjs                # Host RPC 前缀路由、信封契约与失败关闭
node verify-compat.mjs                 # 与本机 DSH 版本的槽位/清单兼容性
```

`pnpm test` 依次运行上述构建检查与六个验证脚本。脚本只使用假凭据、临时目录和 HTTP fixture；`verify-subscriptions.mjs` 覆盖 Antigravity 的 5 小时/周桶与 proto3 省略 0 的耗尽语义、Argon 只由组名/桶 id 判定、Mistral 的金额型月额度，以及“只有四家 provider runtime 厂商允许自动模型配置”的目录约束。

## 已知限制

- 多数订阅用量接口属于客户端内部或社区逆向路径，可能随厂商变化；本插件不承诺所有账号和地区均可验证成功。
- **Google Antigravity**：额度接口与 `User-Agent` 指纹均为社区逆向，且使用 Antigravity 桌面客户端内置的 Google OAuth client；这属于访问厂商未公开的内部接口，可能违反其服务条款并随时失效。插件只做只读额度查询，不代理推理请求、不使用企业端点。
- **Claude / Codex 订阅 provider**：两条模型通道同样是官方 CLI 使用的消费者接口（Claude Code 的 messages 通道、Codex 的 `backend-api/codex`），不是公开 API，可能随厂商策略变化或封禁；插件只做透传，不做多账号池、不做代理。Claude 的 `system` 身份前缀与 beta 头、Codex 的账号头与请求标志都按官方 CLI 现状固定，厂商变更时需要更新 `host/provider-runtime/subscription-oauth.js`。
- **模型目录是静态清单**：两个订阅 provider 的模型列表来自插件内 registry（消费者接口没有可靠的列举端点），厂商上新模型后要更新目录才能选到；`contextLengths` 会按厂商声明的档位写入，不写死的 1M。
- **Mistral**：`/v1/billing/budget` 需要账号具备 `see_org_inference_usage` 权限，缺失时返回 403（插件会明确提示“权限不足”而不是“Key 无效”）；官方 Admin API `/v1/admin/usage` 仅 Enterprise 可用且为 Preview，因此未接入。
- Cerebras 没有公开 Code 订阅余量接口；ClinePass 没有已确认的只读验证或额度端点；Kiro 订阅 API Key 的只读端点尚未确认；Devin 个人浏览器 Bearer 未实现。
- DeepSeek 今日已用是余额差观测口径，首次安装或新的一天从当前余额建立基线，不补算历史消耗。
- 真实页面与真实账号需在安装后另行验收，fixture 通过不代表厂商线上接口未变化。

## 文件结构

- `client/`：卡片、认证页、厂商目录和轮次刷新状态机。
- `host/accounts.js`：DeepSeek 余额/今日账本、Host RPC 前缀路由与请求信封处理。
- `host/subscriptions/`：凭据、CLI 导入、Kimi 设备 OAuth、HTTP、验证与用量适配器。
- `host/provider-runtime/`：DSH 原生模型注册、作者额度服务接入和统一视图投影，以及源自 `dsh-protocom-api` 的 Host 协议与模型运行时；不包含其 Client/UI、Fusion 或自定义重试挂载。原作者 MIT 许可证保留在同目录。
- `host/provider-runtime/subscription-oauth.js`：Claude 与 ChatGPT/Codex 订阅登录 provider，复用 vendored 的请求序列化与 SSE 翻译，只替换 URL、认证头与（Claude）system 身份块。对 vendored 文件唯一的改动是在其 export 列表末尾**追加**三个符号，不改任何语义。
- `subscriptions.json`：唯一厂商目录（`providerIds`、`modelSetup`、`quotaKind`、`quotaSource`），构建时注入 Client。
- `verify-*.mjs` / `verify-host.cjs`：六个独立验证脚本，覆盖 Host、Client、订阅适配、provider runtime 与 RPC 通道。

## 参考资料

- 各厂商额度接口的字段与可信度汇总：[docs/QUOTA-SOURCES.md](docs/QUOTA-SOURCES.md)
- Mistral 计费与额度：https://docs.mistral.ai/admin/billing-usage/subscriptions 、 https://docs.mistral.ai/admin/billing-usage/usage-limits 、 https://docs.mistral.ai/admin/admin-api/usage-metrics
- Mistral 控制台 API Key：https://docs.mistral.ai/admin/identity-access/api-keys
- Antigravity 官方计划与 `/usage`：https://antigravity.google/docs/plans 、 https://antigravity.google/docs/cli/commands/usage
- Antigravity 逆向实现参考：`dsh-agy-link`（`src/domain/quota/parse.ts`、`src/features/quota/http.ts`、`src/domain/quota/identity.ts`、`src/host/oauth.ts`）
- Z.ai Coding Plan Key 说明：https://docs.z.ai/devpack/notice/api-key-management

## 许可证

[MIT](LICENSE)

`host/provider-runtime/protocom-api.js` 来源于 AIMFllyYS 的 `dsh-protocom-api`（MIT），其许可证见 `host/provider-runtime/PROTOCOM-LICENSE`。
