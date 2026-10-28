# dsh-Subscription-Management

> 版本 `1.0.3` · 需要 DSH `>= 0.2.1-rc.2`

独立的多厂商订阅管理与模型接入插件：左侧栏显示真实订阅额度与 DeepSeek 余额/今日用量，设置页提供一行一个厂商的订阅认证。模型发现、图片能力、上下文窗口与思考强度通过 DSH 原生模型设置和模型菜单管理；不包含推理滑条、峰谷或节假日功能。

## 功能

- 5 小时、周、月及模型专用额度窗口；短窗口在内、长窗口在外，两个额度并排，最外层额度使用整行横条。
- 剩余百分比与横条：超过 10% 为绿色，不超过 10% 为红色，缺失值显示 `—`。
- 当前模型变化时切换到对应厂商；无法识别的模型保留上一个厂商且不刷新。
- 每轮对话结束自动刷新，也可点击侧栏卡片手动刷新；同厂商验证共享进行中的 Promise，初始化不重复请求。
- 余额与今日用量仍来自 DeepSeek 官方余额接口或 DSH `deepseekAccount`，今日用量由本插件自己的余额差账本计算。
- 设置页“订阅认证”一行一个厂商，常态收起，悬停或点击展开融合账户卡；管理模式提供显示/隐藏两个栏目，保存后生效。
- Protocom、OpenCode Go、Command Code、ClinePass 通过 DSH LLM seam 提供模型；支持图片输入、上下文档位和按模型划分的 Effort，不安装额外的长时断线重试策略。
- 认证完成后自动启用对应原生 provider 分组，为未设置的上下文写入默认 1M，并按模型实际能力配置图片输入；Effort 词表和默认值直接来自各模型元数据。
- 订阅页顶部提供 DSH 原生模型设置入口说明，已有自定义上下文或视觉设置不会被自动配置覆盖。

## 认证与用量支持

| 厂商 | 认证方式 | 用量/验证来源 |
|---|---|---|
| Kimi | 订阅 API Key、设备 OAuth | `api.kimi.com/coding/v1/usages`，支持新旧窗口与 OAuth 刷新 |
| ChatGPT / Codex | Codex CLI 只读导入或 OAuth JSON | `chatgpt.com/backend-api/wham/usage`（社区内部接口） |
| GLM | Z.ai / GLM Coding Plan API Key | Z.ai quota 接口，中国区可回退 |
| Qwen | Alibaba Coding Plan / DashScope API Key | Alibaba Coding Plan console RPC，国际/中国区回退 |
| Claude | Claude Code 只读导入或 OAuth JSON | `api.anthropic.com/api/oauth/usage`，要求 `user:profile` |
| Gemini | Gemini CLI OAuth 只读导入 | `retrieveUserQuota`，不接受 AI Studio/Vertex Key 冒充订阅 |
| Devin | `devin-session-token$` CLI 会话 Token | Codeium `GetUserStatus`（社区路径） |
| Kilo | Kilo API Token 或 Kilo CLI 只读导入 | `app.kilo.ai/api/trpc` |
| Kiro | Kiro `kiro-auth-token.json` 或 OAuth JSON | `q.<region>.amazonaws.com/getUsageLimits`；订阅 API Key 的只读端点未确认，暂不接收 |
| Cerebras | Cerebras API Key | `/v1/models` 仅验证 API；无公开 Code 订阅余量接口，额度显示 `—` |
| MiniMax | MiniMax Subscription Key | `token_plan/remains`，必要时回退中国区 |
| Trae CN | 浏览器 Cookie | Host 内换短期 Token 后读 entitlement，不保存交换 Token |
| Protocom | 四个分组各自的 API Key | 作者 `BalanceService` 读取 `/v1/usage`；余额、限额与套餐按上游实际字段显示 |
| OpenCode Go | Go 订阅 API Key | 作者 `GoUsageService` 读取 `/v1/usage`；5 小时、周、月窗口 |
| Command Code | 订阅 API Key | 作者 `CommandCodeAccountService` 读取 credits/usage，两个半区独立降级 |
| ClinePass | ClinePass API Key | 没有已确认的只读验证或额度端点，显示未验证与 `—`，不伪造数据 |

### 状态与安全

- **已配置不等于已验证**：保存后执行真实只读验证，成功才写验证指纹；过期 OAuth 不显示绿色状态。
- 官方 CLI 只保存文件链接，每次读取最新凭据，不写官方文件，不接管官方 CLI 的 refresh-token 生命周期。
- 手动 OAuth 只刷新本插件自己的记录，按厂商串行保存、刷新、验证和删除；验证使用刷新后的 Token 指纹。
- API Key、OAuth Token、Cookie 只由 Host 持久化；API 管理也使用 Host 凭据服务。
- 本地用户展开 API Key 厂商卡时，Host 才按次返回对应 Key 用于眼睛切换和复制。Key 默认以等长 `*` 遮蔽，只存在当前页面组件内存中，不写入 `localStorage`，折叠或更新凭据后清除。
- 普通 OpenAI API Key 不能冒充 ChatGPT 订阅 OAuth；Claude `setup-token` 不作为额度恢复手段。
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
node scripts/build-client.mjs --check
```

`client.js` 是生成产物，不要直接编辑；修改 `client/*.js` 或 `subscriptions.json` 后运行 `node scripts/build-client.mjs` 重新生成，`--check` 只校验生成结果是否过期。

本项目使用 `@deepseek-ai/schemastery` 与 `eventsource-parser`，并通过 DSH peer 服务接入模型和附件；安装包时由插件管理器处理依赖。

## 兼容性

- DSH `>= 0.2.1-rc.2`，与 `package.json` 的 `engines.dsh` 一致。
- Node.js `>= 18`：验证脚本使用内置 `fetch` / `Response`，不依赖额外 HTTP 库。
- 运行时的 `@deepseek-ai/*` 服务由 DSH profile 提供；`dependencies` 中的 `@deepseek-ai/schemastery` 与 `eventsource-parser` 随插件安装。
- 本仓库不包含 `node_modules`。运行 Host 与 provider runtime 的验证脚本时，需要能解析 `package.json` 中的依赖（在 DSH profile 内运行，或自行安装依赖）。

## 配置

默认 `enabled: true`。在 bundle row 中可写：

```yaml
- id: dsh-subscription-management
  name: dsh-subscription-management
  config:
    enabled: false
```

`enabled: false` 时不注册卡片、设置入口或账户 RPC，也不注入 `connection`。非法配置安全回退为禁用。

## 性能与存储

- 两个插件拆分后，本项目不加载滑条、节假日和档位引擎；原项目也不加载本项目的账户模块。
- 初始化合并为一次订阅请求；同厂商验证 single-flight，避免卡片和设置页同时发起重复请求。
- 新厂商统一经现有 Host RPC 分发；上游获取直接复用作者的额度服务、60 秒缓存和失败退避，没有第二套并行 HTTP 适配器。
- 手动刷新通过作者提供的缓存失效接口读取新值；凭据或原生设置变化才清理模型与额度缓存。
- 原生配置解析结果按配置与凭据版本复用，摘要和 Key 在展开周期内复用，减少重复请求、CPU 和内存占用；不持久化原始响应或 Key。
- 最近验证成功的厂商记录为轻量指针，正常启动先检查该厂商，避免每次扫描全部凭据。
- 原始厂商响应只在请求期间存在，Client 只接收归一化窗口、脱敏状态，以及本地用户主动展开时读取的 API Key。
- 状态与 DeepSeek 账本独立保存在 profile 的 `.dsh-subscription-management/` 下，不与原插件共享缓存。

## 测试

`client.js` 的构建一致性、Client 纯数据逻辑与兼容性检查不依赖外部包；Host 与 provider runtime 的验证脚本需要能解析依赖（在 DSH profile 内运行，或先安装依赖）。

```bash
node scripts/build-client.mjs --check  # client.js 是否与 client/*.js 同步
node verify-host.cjs                   # Host 配置归一化与入口契约
node verify-client.mjs                 # 卡片布局、额度窗口与余额账本
node verify-subscriptions.mjs          # 凭据、OAuth 刷新、用量解析与验证指纹
node verify-provider-runtime.mjs       # provider 注册、模型发现、额度缓存与遥测投影
node verify-compat.mjs                 # 与本机 DSH 版本的槽位/清单兼容性
```

`pnpm test` 依次运行上述构建检查与五个验证脚本。脚本只使用假凭据、临时目录和 HTTP fixture；`verify-provider-runtime.mjs` 通过替换 `globalThis.fetch` 提供 Protocom、OpenCode Go、Command Code 与 ClinePass 的固定响应，验证 provider 注册、模型发现、Effort/视觉能力写入、作者额度缓存与遥测投影，不读取真实账号，也不请求真实厂商接口。

## 已知限制

- 多数订阅用量接口属于客户端内部或社区逆向路径，可能随厂商变化；本插件不承诺所有账号和地区均可验证成功。
- Cerebras 没有公开 Code 订阅余量接口；ClinePass 没有已确认的只读验证或额度端点；Kiro 订阅 API Key 的只读端点尚未确认；Devin 个人浏览器 Bearer 未实现。
- DeepSeek 今日已用是余额差观测口径，首次安装或新的一天从当前余额建立基线，不补算历史消耗。
- 真实页面与真实账号需在安装后另行验收，fixture 通过不代表厂商线上接口未变化。

## 文件结构

- `client/`：卡片、认证页、厂商目录和轮次刷新状态机。
- `host/accounts.js`：DeepSeek 余额/今日账本与 RPC 入口。
- `host/subscriptions/`：凭据、CLI 导入、Kimi 设备 OAuth、HTTP、验证与用量适配器。
- `host/provider-runtime/`：DSH 原生模型注册、作者额度服务接入和统一视图投影，以及源自 `dsh-protocom-api` 的 Host 协议与模型运行时；不包含其 Client/UI、Fusion 或自定义重试挂载。原作者 MIT 许可证保留在同目录。
- `subscriptions.json`：唯一厂商目录，构建时注入 Client。
- `verify-*.mjs` / `verify-host.cjs`：五个独立验证脚本，覆盖 Host、Client、订阅适配与 provider runtime。

## 许可证

[MIT](LICENSE)

`host/provider-runtime/protocom-api.js` 来源于 AIMFllyYS 的 `dsh-protocom-api`（MIT），其许可证见 `host/provider-runtime/PROTOCOM-LICENSE`。
