# 订阅额度接口资料（dsh-Subscription-Management）

这份文档记录每个厂商的额度来源、请求形状与可信度，供维护时核对。插件实现以 `host/subscriptions/usage.js` 为准；厂商改动接口时先更新这里，再改进配器。

## 可信度分档

| 档位 | 含义 | 目录字段 |
|---|---|---|
| 官方 | 厂商公开文档或官方客户端使用的接口 | `quotaSource: "official"` |
| 社区逆向 | 第三方抓包或社区项目逆向的接口 | `quotaSource: "community"` |
| 作者服务 | 由第三方服务作者提供的额度接口（`host/provider-runtime/`） | `quotaSource: "vendor"` |
| 无端点 | 没有已确认的只读额度接口 | `quotaSource: "none"` |

## Google Antigravity

- 端点：`POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`，失败再试 `https://daily-cloudcode-pa.sandbox.googleapis.com`。禁止使用企业端点 `cloudcode-pa.googleapis.com`。
- 请求体 `{}`；请求头只有 `Authorization: Bearer <access token>`、`Content-Type: application/json`、`User-Agent`。
- `User-Agent`：`antigravity/cli/<版本> (aidev_client; os_type=<os>; arch=<arch>; auth_method=consumer)`；版本 < `1.3.0` 回落 `1.5.10`。低于该版本的旧格式拿不到 Pro/Ultra 的 Argon 分组。
- 响应：

```json
{
  "description": "Antigravity",
  "groups": [
    {
      "displayName": "Gemini Models",
      "buckets": [
        { "bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0.8, "resetTime": "2026-10-27T05:00:00Z" },
        { "bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 0.5, "resetTime": "2026-10-30T00:00:00Z" }
      ]
    }
  ]
}
```

- `remainingFraction` 是 0..1 的**剩余**比例；proto3 省略 0，所以“有 `resetTime` 但无 `remainingFraction`”等于**耗尽**。
- 免费档没有 5 小时汇总窗口，summary 返回 `403 PERMISSION_DENIED`；此时回退 `POST /v1internal:fetchAvailableModels`，用 `models[*].quotaInfo` 按模型家族（Gemini / Claude / GPT / Argon）取最低剩余。
- 没有月度窗口。专属 Argon 池只由组名或 `bucketId` / 桶名证明，`description` 不算证据（agy >= 1.5.12 的共享 Gemini 组会在描述里枚举 Argon）。
- 凭据：`~/.gemini/antigravity-cli/antigravity-oauth-token`（嵌套 `{"token":{...},"auth_method":"consumer"}` 或扁平）。Windows 活跃凭据在凭据管理器 `gemini:antigravity`，插件不读系统凭据库。
- OAuth 刷新：`POST https://oauth2.googleapis.com/token`，`grant_type=refresh_token` + `client_id` + `client_secret`，不带 scope；响应通常不返回新 refresh token，沿用旧值。仓库不内置 client 凭据，需要用户用 `AGY_CLIENT_ID` / `AGY_CLIENT_SECRET` 提供。
- 来源：`antigravity.google/docs/cli/commands/usage`（官方只说明有 5 小时/周窗口）；端点与字段来自 `dsh-agy-link` 的逆向（`src/features/quota/http.ts`、`src/domain/quota/parse.ts`、`src/domain/quota/identity.ts`、`src/host/oauth.ts`）。

## Mistral

- 端点：`GET https://api.mistral.ai/v1/billing/budget`，请求头 `Authorization: Bearer <api key>` + `Accept: application/json`。
- 套餐名（可选）：`GET https://api.mistral.ai/v1/billing/subscription` → `{ "plan_name": "...", "payg_enabled": false, "vibe_payg_enabled": false, "enterprise": false }`。
- 响应：

```json
{
  "api_budget": {
    "usage_percentage": 25,
    "initial_budget": 40,
    "currency": "USD",
    "reset_at": "2026-11-01T00:00:00Z",
    "payg_enabled": false
  },
  "vibe_budget": { "usage_percentage": 10, "initial_budget": 20, "currency": "USD", "reset_at": "2026-11-01T00:00:00Z" }
}
```

- 这是**等价额度**：`initial_budget` 是货币额度，`usage_percentage` 是已用百分比；剩余金额 = `initial_budget * (1 - usage_percentage/100)`。只有月度窗口，没有 5 小时或周窗口。
- `api_budget` 在部分套餐缺省；`vibe_budget` 是 Vibe Code 额度。两者货币不一致时应视为异常，不要合并。
- 403 表示账号缺少 `see_org_inference_usage` 权限（Key 本身有效），插件会明确提示权限问题。
- 官方 Admin API `GET /v1/admin/usage?month=&year=`（`x-api-key`）仅 Enterprise 可用且为 Preview，未接入。
- 来源：`docs.mistral.ai/admin/billing-usage/subscriptions`、`docs.mistral.ai/admin/billing-usage/usage-limits`、`docs.mistral.ai/admin/admin-api/usage-metrics`；`/v1/billing/budget` 的字段与官方 `mistral-vibe` CLI 用法一致。

## 其他厂商（摘要）

| 厂商 | 端点 | 关键字段 | 可信度 |
|---|---|---|---|
| Kimi | `GET https://api.kimi.com/coding/v1/usages` | `usages.limit_5h/limit_7d.used_ratio`、`reset_time` | 官方 |
| ChatGPT / Codex | `GET https://chatgpt.com/backend-api/wham/usage` | `rate_limit.primary_window/secondary_window.used_percent` + `limit_window_seconds` | 社区逆向 |
| Claude | `GET https://api.anthropic.com/api/oauth/usage` | `five_hour/seven_day.utilization`、`resets_at`；需要 `user:profile` | 官方 |
| Gemini | `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | `buckets[].remainingFraction`、`resetTime` | 官方 |
| GLM | `GET https://api.z.ai/api/monitor/usage/quota/limit` | `data.limits[].percentage/currentValue/usage/nextResetTime`；中国区回退 `open.bigmodel.cn` | 社区逆向 |
| Qwen | 控制台 RPC（国际/中国区） | `per5Hour/perWeek/perBillMonth` used/total | 社区逆向 |
| MiniMax | `GET https://www.minimax.io/v1/token_plan/remains` | `model_remains[].current_interval_*_count` | 社区逆向 |
| Kilo | `POST https://app.kilo.ai/api/trpc` | `creditBlocks[].amount_mUsd/balance_mUsd` | 社区逆向 |
| Kiro | `q.<region>.amazonaws.com/getUsageLimits` | `usageBreakdownList[].currentUsageWithPrecision/usageLimitWithPrecision` | 社区逆向 |
| Devin | Codeium `GetUserStatus` | `planStatus.dailyQuotaRemainingPercent` | 社区逆向 |
| Trae CN | `api.trae.cn` entitlement | `usage_summary.consumed_amount/total_amount` | 社区逆向 |
| Cerebras | `GET https://api.cerebras.ai/v1/models` | 仅验证 Key，无额度 | 社区逆向 |

## 订阅登录 provider（模型通道，不是额度）

这两条不是额度接口，而是本插件挂载的模型 provider；列在这里是因为它们同样属于厂商未公开的消费者接口。

| provider | 请求 | 必需头 | 关键约束 |
|---|---|---|---|
| `claude-subscription` | `POST https://api.anthropic.com/v1/messages?beta=true` | `Authorization: Bearer`、`anthropic-version: 2023-06-01`、`anthropic-beta: oauth-2025-04-20`、`user-agent: claude-cli/...`、`x-app: cli` | `system` 必须是块数组，且首块精确等于 `You are Claude Code, Anthropic's official CLI for Claude.`（Sonnet/Opus 强制、Haiku 豁免）；不得同时发 `x-api-key` |
| `codex-subscription` | `POST https://chatgpt.com/backend-api/codex/responses` | `Authorization: Bearer`、`chatgpt-account-id`、`OpenAI-Beta: responses=experimental`、`originator: codex_cli_rs`、`session_id` | body 需要 `store:false`、`stream:true`、`tool_choice:auto`、`parallel_tool_calls:true`、`include:["reasoning.encrypted_content"]`；模型由后端下发，本插件用静态 registry 兜底 |

模型目录（registry）与上下文档位见 `host/provider-runtime/subscription-oauth.js`；额度查询仍走各自原有的 usage 接口。

## 待评估的候选厂商

以下接口来自社区逆向，尚未接入（缺少可验证的请求流程或凭据获取方式）：

- GitHub Copilot：`GET https://api.github.com/copilot_internal/user` → `quota_snapshots.*.percent_remaining` + `quota_reset_date`，需要 Copilot 内部 token（classic PAT 被拒）。
- Cursor：`api2.cursor.sh` 的 Connect RPC（`DashboardService`），金额单位为 cents。
- Windsurf：官方只给出 credits 说明，无 API。
