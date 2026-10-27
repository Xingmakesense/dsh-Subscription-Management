# dsh-Subscription-Management

> 版本 `1.0.0` · 需要 DSH `>= 0.2.1-rc.2`

独立的多厂商订阅管理插件：左侧栏显示真实订阅额度与 DeepSeek 余额/今日用量，设置页提供一行一个厂商的订阅认证。它不包含推理滑条、峰谷、节假日或档位声明；这些功能由 `Utility-Appearance-Kit` 独立提供。

## 功能

- 5 小时、周、月及模型专用额度窗口；短窗口在内、长窗口在外，两个额度并排，最外层额度使用整行横条。
- 剩余百分比与横条：超过 10% 为绿色，不超过 10% 为红色，缺失值显示 `—`。
- 当前模型变化时切换到对应厂商；无法识别的模型保留上一个厂商且不刷新。
- 每轮对话结束自动刷新，也可手动刷新；同厂商验证共享进行中的 Promise，初始化不重复请求。
- 余额与今日用量仍来自 DeepSeek 官方余额接口或 DSH `deepseekAccount`，今日用量由本插件自己的余额差账本计算。
- 设置页“订阅认证”一行一个厂商，行内展开，没有第三级页面；支持拖动排序、删除和恢复默认。

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

### 状态与安全

- **已配置不等于已验证**：保存后执行真实只读验证，成功才写验证指纹；过期 OAuth 不显示绿色状态。
- 官方 CLI 只保存文件链接，每次读取最新凭据，不写官方文件，不接管官方 CLI 的 refresh-token 生命周期。
- 手动 OAuth 只刷新本插件自己的记录，按厂商串行保存、刷新、验证和删除；验证使用刷新后的 Token 指纹。
- API Key、OAuth Token、Cookie 只由 Host 持久化，不由 Host 回传；API 管理也使用 Host 凭据服务。
- 普通 OpenAI API Key 不能冒充 ChatGPT 订阅 OAuth；Claude `setup-token` 不作为额度恢复手段。
- 社区内部接口可能变化，失败时显示真实错误，不伪造认证或额度。

## 安装

### 从 tgz 安装

```bash
pnpm pack --pack-destination dist
```

在 DSH **插件管理 → 安装插件** 中选择生成的 `.tgz`，然后刷新页面。升级时提高 `package.json` 的版本号再打包。

### 从源码开发

```bash
git clone <repo-url>
cd dsh-Subscription-Management
node scripts/build-client.mjs
pnpm pack --pack-destination dist
```

本项目无第三方 npm 依赖，不需要 `pnpm install`。

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
- 最近验证成功的厂商记录为轻量指针，正常启动先检查该厂商，避免每次扫描全部凭据。
- 原始厂商响应只在请求期间存在，Client 只接收归一化窗口和脱敏状态。
- 状态与 DeepSeek 账本独立保存在 profile 的 `.dsh-subscription-management/` 下，不与原插件共享缓存。

## 测试

```bash
node scripts/build-client.mjs --check
node verify-host.cjs
node verify-client.mjs
node verify-subscriptions.mjs
node verify-compat.mjs
```

四个脚本全部使用假凭据、临时目录和 HTTP fixture，不读取真实账号，也不请求真实厂商接口。

## 已知限制

- 多数订阅用量接口属于客户端内部或社区逆向路径，可能随厂商变化；本插件不承诺所有账号和地区均可验证成功。
- Cerebras 没有公开 Code 订阅余量接口；Kiro 订阅 API Key 的只读端点尚未确认；Devin 个人浏览器 Bearer 未实现。
- DeepSeek 今日已用是余额差观测口径，首次安装或新的一天从当前余额建立基线，不补算历史消耗。
- 真实页面与真实账号需在安装后另行验收，fixture 通过不代表厂商线上接口未变化。

## 文件结构

- `client/`：卡片、认证页、厂商目录和轮次刷新状态机。
- `host/accounts.js`：DeepSeek 余额/今日账本与 RPC 入口。
- `host/subscriptions/`：凭据、CLI 导入、Kimi 设备 OAuth、HTTP、验证与用量适配器。
- `subscriptions.json`：唯一厂商目录，构建时注入 Client。
- `verify-*.mjs`：四个独立验证脚本。

## 许可证

[MIT](LICENSE)
