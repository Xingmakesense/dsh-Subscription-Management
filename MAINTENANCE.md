# dsh-Subscription-Management 维护手册

## 模块边界

- `client/quota.js`：窗口选择、布局、按 vendor 隔离的 RPC 状态机。
- `client/balance-card.js`：卡片、模型跟随和轮次结束刷新。
- `client/quota-settings.js`：认证页、拖动排序、API 管理。
- `host/subscriptions/credentials.js`：Host 凭据、CLI 只读链接、验证指纹。
- `host/subscriptions/kimi-oauth.js`：Kimi 设备授权状态机。
- `host/subscriptions/usage.js`：真实只读验证、OAuth 刷新与用量解析（含 Antigravity 的 5 小时/周窗口与 Mistral 的等价月额度）。
- `host/provider-runtime/`：DSH 原生 provider 注册、模型发现、额度服务与遥测投影；`protocom-api.js` 为上游 vendored 文件，作者许可证见同目录 `PROTOCOM-LICENSE`。
- `host/provider-runtime/subscription-oauth.js`：Claude / ChatGPT(Codex) 订阅登录 provider。复用 vendored 的 `serializeMessagesRequest` / `serializeResponsesRequest` / `translateMessages` / `translateResponses`，自带 fetch 以控制 URL 与认证头；模型目录为静态 registry（消费者接口没有可靠的列举端点）。
- `host/accounts.js`：DeepSeek 余额与今日账本；Host RPC 前缀路由（`createAccountRoute`）与信封处理。
- `subscriptions.json`：厂商目录唯一事实源，不得另写一份厂商清单。

`client.js` 由 `scripts/build-client.mjs` 生成，不要直接编辑。修改 `client/*.js` 后必须重新构建并运行 `--check`。修改 provider runtime 后运行 `node verify-provider-runtime.mjs`，它用 fixture 覆盖 provider 注册、模型发现、额度缓存与遥测投影。修改 RPC 通道或 `host/accounts.js` 后运行 `node verify-channel.mjs`。

## 不可破坏的约束

1. 已配置不等于已验证；只有真实只读验证成功才写验证指纹，失败不得伪造认证或额度。
2. 非法 vendor 不得默认落到 Kimi；写操作、删除和登录都必须通过白名单。
3. CLI 只读链接不得改写官方凭据；手动 OAuth 只刷新本插件自己的记录，并按新 Token 计算指纹。
4. 缺失 used/limit/window 不补 0，零 limit 不伪造百分比，缺失 window 不推断为周。
5. 卡片短窗口在内、长窗口在外；两项并排，最外层整行横条。未知模型保留上一个厂商且不刷新。
5.1 厂商只能由 provider 精确匹配（subscriptions.json 的 providerIds）选出：禁止用模型名、模型前缀或子串推断厂商，否则第三方中转商提供的 GLM / Qwen 模型会被误判成官方订阅。
5.2 API Key 类官方订阅（modelSetup manual）在认证后不得写入原生 provider 分组、上下文或视觉设置；只有本插件实际提供模型的厂商（modelSetup auto：四家 relay family 加 Claude/ChatGPT 订阅）可以自动配置，且必须经 vendorAllowsAutoModelSetup 判定。
5.3 vendored 的 `host/provider-runtime/protocom-api.js` 只允许**追加**导出（当前为 `parseSseUntilEof`、`serializeResponsesRequest`、`translateResponses`），不得改动任何语义或函数体；升级 vendored 上游时先确认这三个符号仍存在。
5.4 订阅登录 provider 的凭证只能来自本插件凭据库，必须每次请求现取现刷；不得写入 URL、日志或设置项，也不得把 OAuth token 放进 `x-api-key`（Claude 要求 Bearer，且 system 首块必须是 CLI 身份串）。
6. 初始化只发一次订阅请求；同厂商验证使用 `validationInFlight` 共享。自动刷新只允许卡片里那一个 60 秒 tick 的定时器：满 5 分钟、页面可见、没有请求在途才触发，手动刷新与轮次结束刷新必须重置窗口；不得恢复重复初始化、每厂商独立轮询或隐藏页轮询。
7. 卡片上半部分来自订阅厂商，下半部分始终来自 DeepSeek；今日用量只使用本插件余额差账本。
8. 秘密只由 Host 持久化，API 管理不得恢复 localStorage 明文 Key。
9. 本项目不得重新引入滑条、峰谷、节假日或档位引擎；这些仍由 Utility-Appearance-Kit 维护。
10. 测试只能使用假凭据、临时目录和 HTTP fixture，禁止读取真实账户或调用真实厂商接口。
11. 账户 RPC 只走公开接口：插件在 Host `webServer` 上注册自己的 `/dsh-subscription-management` 前缀路由，鉴权调用 `connection.requestRejection`，不得再读写 Connection 插件的 fiber 内部字段（`store`/`_store`/`inject`/`rpc.handle`）。cordis 4.1.0 已把 `Fiber.store` 改为 `committed`，旧写法会让注册静默失败、整条通道返回 HTTP 405。
12. 鉴权只允许 fail-closed：`connection` 或 `requestRejection` 不可用时直接回 503，不得放行。
