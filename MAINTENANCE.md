# dsh-Subscription-Management 维护手册

## 模块边界

- `client/quota.js`：窗口选择、布局、按 vendor 隔离的 RPC 状态机。
- `client/balance-card.js`：卡片、模型跟随和轮次结束刷新。
- `client/quota-settings.js`：认证页、拖动排序、API 管理。
- `host/subscriptions/credentials.js`：Host 凭据、CLI 只读链接、验证指纹。
- `host/subscriptions/kimi-oauth.js`：Kimi 设备授权状态机。
- `host/subscriptions/usage.js`：真实只读验证、OAuth 刷新与用量解析。
- `host/accounts.js`：DeepSeek 余额与今日账本。
- `subscriptions.json`：厂商目录唯一事实源，不得另写一份厂商清单。

`client.js` 由 `scripts/build-client.mjs` 生成，不要直接编辑。修改 `client/*.js` 后必须重新构建并运行 `--check`。

## 不可破坏的约束

1. 已配置不等于已验证；只有真实只读验证成功才写验证指纹，失败不得伪造认证或额度。
2. 非法 vendor 不得默认落到 Kimi；写操作、删除和登录都必须通过白名单。
3. CLI 只读链接不得改写官方凭据；手动 OAuth 只刷新本插件自己的记录，并按新 Token 计算指纹。
4. 缺失 used/limit/window 不补 0，零 limit 不伪造百分比，缺失 window 不推断为周。
5. 卡片短窗口在内、长窗口在外；两项并排，最外层整行横条。未知模型保留上一个厂商且不刷新。
6. 初始化只发一次订阅请求；同厂商验证使用 `validationInFlight` 共享，不得恢复重复初始化或定时轮询。
7. 卡片上半部分来自订阅厂商，下半部分始终来自 DeepSeek；今日用量只使用本插件余额差账本。
8. 秘密只由 Host 持久化，API 管理不得恢复 localStorage 明文 Key。
9. 本项目不得重新引入滑条、峰谷、节假日或档位引擎；这些仍由 Utility-Appearance-Kit 维护。
10. 测试只能使用假凭据、临时目录和 HTTP fixture，禁止读取真实账户或调用真实厂商接口。
