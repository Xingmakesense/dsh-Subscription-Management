import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHandler } from "./host/accounts.js";
import { subscriptionHandlerTest } from "./host/subscriptions/index.js";
import { SUBSCRIPTION_VENDORS } from "./host/subscriptions/catalog.js";
import {
    credentialFromInput,
    credentialIsExpired,
    fingerprintCredential,
    normalizeStoredRecord,
    parseCliCredential,
    vendorCredentialName
} from "./host/subscriptions/credentials.js";
import {
    parseClaudeUsage,
    parseCodexUsage,
    parseDevinUsage,
    parseGeminiUsage,
    parseGlmUsage,
    parseKiloUsage,
    parseKimiUsage,
    parseKiroUsage,
    parseMiniMaxUsage,
    parseQwenUsage,
    parseTraeUsage
} from "./host/subscriptions/usage.js";

const root = join(process.cwd(), "tmp", "verify-subscriptions");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
process.env.DSH_PROFILE_DIR = join(root, "profile");
process.env.CODEX_HOME = join(root, "codex");
mkdirSync(process.env.CODEX_HOME, { recursive: true });

const store = new Map();
const keyOf = (ref) => String(ref);
const scope = {
    credentials: {
        async resolve(ref) {
            return store.has(keyOf(ref)) ? { value: store.get(keyOf(ref)), source: "test" } : undefined;
        },
        async set(ref, value) { store.set(keyOf(ref), value); },
        async unset(ref) { store.delete(keyOf(ref)); }
    }
};
const ctx = { get: () => undefined };
const handler = createHandler(ctx, scope);
const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A. Parser semantics: remaining percentage, real windows, and no invented values.
{
    const kimi = parseKimiUsage({
        usage: { used: 10, limit: 100 },
        usages: {
            limit_5h: { used_ratio: 0.25, reset_time: "2026-10-27T05:00:00Z" },
            limit_7d: { used_ratio: 0.4, reset_time: "2026-10-30T00:00:00Z" }
        },
        limits: [{ window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { used: 10, limit: 0 } }]
    });
    assert.equal(kimi.summary.window.unit, "week");
    assert.equal(kimi.summary.remainingPercent, 60);
    assert.equal(kimi.limits.find((row) => row.window?.duration === 5 && row.window?.unit === "hour").remainingPercent, 75);
    const zeroLimit = parseKimiUsage({ limits: [{ window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { used: 10, limit: 0 } }] });
    assert.equal(zeroLimit.limits[0].remainingPercent, undefined);
    const noWeekly = parseKimiUsage({ usage: { used: 10, limit: 100 } });
    assert.notEqual(noWeekly.summary?.window?.unit, "week", "missing window must not be invented as a week");

    const codex = parseCodexUsage({
        plan_type: "plus",
        rate_limit: {
            primary_window: { used_percent: 6, limit_window_seconds: 18000, reset_at: 1738300000 },
            secondary_window: { used_percent: 24, limit_window_seconds: 604800, reset_at: 1738900000 }
        }
    });
    assert.deepEqual(codex.limits.map((row) => row.remainingPercent), [94, 76]);
    const claude = parseClaudeUsage({
        five_hour: { utilization: 25, resets_at: "2026-10-27T05:00:00Z" },
        seven_day: { utilization: 40, resets_at: "2026-10-30T00:00:00Z" }
    });
    assert.deepEqual(claude.limits.map((row) => row.remainingPercent), [75, 60]);
    const glm = parseGlmUsage({
        code: 200,
        data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 800, currentValue: 120, percentage: 15, nextResetTime: 1738300000000 }] }
    });
    assert.equal(glm.limits[0].remainingPercent, 85);
    const qwen = parseQwenUsage({
        codingPlanQuotaInfo: {
            per5HourUsedQuota: 10, per5HourTotalQuota: 100,
            perWeekUsedQuota: 20, perWeekTotalQuota: 100,
            perBillMonthUsedQuota: 30, perBillMonthTotalQuota: 100
        }
    });
    assert.deepEqual(qwen.limits.map((row) => row.remainingPercent), [90, 80, 70]);
    const minimax = parseMiniMaxUsage({
        model_remains: [{
            current_interval_total_count: 1000,
            current_interval_usage_count: 250,
            start_time: 1738300000,
            end_time: 1738318000
        }]
    });
    assert.equal(minimax.limits[0].remainingPercent, 25);
    const devin = parseDevinUsage({
        userStatus: {
            planStatus: {
                planInfo: { hideDailyQuota: true, planName: "Max" },
                dailyQuotaRemainingPercent: 100,
                weeklyQuotaResetAtUnix: 1738900000
            }
        }
    });
    assert.equal(devin.limits[0].remainingPercent, 0);
    const gemini = parseGeminiUsage({ buckets: [{ modelId: "gemini-pro", remainingFraction: 0.75, resetTime: "2026-10-28T00:00:00Z" }] });
    assert.equal(gemini.limits[0].remainingPercent, 75);
    assert.equal(gemini.limits[0].window, undefined, "Gemini bucket duration is not invented");
    const kiro = parseKiroUsage({
        nextDateReset: 1738900000,
        usageBreakdownList: [{ resourceType: "CREDIT", currentUsageWithPrecision: 25, usageLimitWithPrecision: 100 }]
    });
    assert.equal(kiro.limits[0].remainingPercent, 75);
    const trae = parseTraeUsage({
        is_credits_billing: true,
        usage_summary: { consumed_amount: 25, total_amount: 100 },
        user_entitlement_pack_list: [{ group_type: 0, status: 1, display_desc: "Pro" }]
    });
    assert.equal(trae.limits[0].remainingPercent, 75);
    assert.equal(trae.plan, "Pro");
    const kilo = parseKiloUsage([
        { result: { data: { json: { creditBlocks: [{ amount_mUsd: 100_000_000, balance_mUsd: 25_000_000 }] } } } },
        { result: { data: { json: null } } }
    ]);
    assert.equal(kilo.limits[0].remainingPercent, 25);
}

// B. Credential normalization and CLI document parsing.
{
    const chatgpt = SUBSCRIPTION_VENDORS.find((vendor) => vendor.id === "chatgpt");
    const glm = SUBSCRIPTION_VENDORS.find((vendor) => vendor.id === "glm");
    const legacy = normalizeStoredRecord(chatgpt, "raw-old-secret");
    assert.equal(legacy.needsReconnect, true, "legacy non-OAuth vendors must be re-authenticated");
    assert.equal(normalizeStoredRecord(glm, "raw-key").kind, "api-key");
    assert.throws(() => credentialFromInput(chatgpt, "oauth", "sk-normal-openai-key"), /Codex OAuth|OpenAI API Key/);
    const codex = parseCliCredential(chatgpt, {
        tokens: { access_token: "access", refresh_token: "refresh", account_id: "account" }
    }, "/fixture/auth.json");
    assert.equal(codex.kind, "oauth");
    assert.equal(codex.secret.accountId, "account");
    assert.notEqual(fingerprintCredential(codex), fingerprintCredential({ ...codex, secret: { ...codex.secret, access: "other" } }));
    assert.equal(credentialIsExpired({ secret: { expires: Date.now() - 1 } }), true);
    assert.throws(() => credentialFromInput(SUBSCRIPTION_VENDORS.find((vendor) => vendor.id === "devin"), "session", "wrong-token"), /devin-session-token/);
}

// C. Handler behavior with in-memory credentials and fixture HTTP.
const codexDocument = JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { access_token: "codex-access", refresh_token: "codex-refresh", account_id: "account-1" }
});
writeFileSync(join(process.env.CODEX_HOME, "auth.json"), codexDocument, "utf8");

let kimiUsageCalls = 0;
globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = init.headers ?? {};
    const bearer = headers.authorization ?? headers.Authorization;
    if (url === "https://api.kimi.com/coding/v1/usages") {
        kimiUsageCalls += 1;
        if (bearer !== "Bearer good") return json({ error: "unauthorized" }, 401);
        return json({
            usage: { used: 40, limit: 100 },
            usages: {
                limit_5h: { used_ratio: 0.25, reset_time: "2026-10-27T05:00:00Z" },
                limit_7d: { used_ratio: 0.4, reset_time: "2026-10-30T00:00:00Z" }
            },
            limits: []
        });
    }
    if (url === "https://auth.openai.com/oauth/token") {
        if (!String(init.body).includes("old-refresh")) return json({ error: "invalid_grant" }, 401);
        return json({ access_token: "new-codex-access", refresh_token: "new-codex-refresh", expires_in: 3600 });
    }
    if (url === "https://chatgpt.com/backend-api/wham/usage") {
        if (!["Bearer codex-access", "Bearer new-codex-access"].includes(bearer)) return json({ error: "unauthorized" }, 401);
        return json({
            plan_type: "plus",
            rate_limit: {
                primary_window: { used_percent: 6, limit_window_seconds: 18000, reset_at: 1738300000 },
                secondary_window: { used_percent: 24, limit_window_seconds: 604800, reset_at: 1738900000 }
            }
        });
    }
    throw new Error(`unexpected fixture URL: ${url}`);
};

{
    const bad = await handler("auth/api-key/set", { vendor: "kimi", apiKey: "bad" });
    assert.equal(bad.ok, true);
    assert.equal(bad.value.configured, true);
    assert.equal(bad.value.verified, false, "saving a rejected key must not verify it");
    assert.equal(typeof bad.value.error, "string");

    const good = await handler("auth/api-key/set", { vendor: "kimi", apiKey: "good" });
    assert.equal(good.value.verified, true, "a real usage response verifies the key");
    const usage = await handler("usage", { vendor: "kimi" });
    assert.equal(usage.value.verified, true);
    assert.equal(usage.value.usage.summary.remainingPercent, 60);
    kimiUsageCalls = 0;
    await Promise.all([
        handler("usage", { vendor: "kimi" }),
        handler("usage", { vendor: "kimi" })
    ]);
    assert.equal(kimiUsageCalls, 1, "concurrent validation of one vendor must share its upstream request");
    const automatic = await subscriptionHandlerTest.automaticVendor(scope);
    assert.equal(automatic.id, "kimi", "the last verified vendor must be selected through the fast path");

    const missing = await handler("usage", { vendor: "qwen" });
    assert.equal(missing.value.configured, false, "no credential must not produce fake success");
    assert.equal(missing.value.authenticated, false);

    const imported = await handler("auth/cli/import", { vendor: "chatgpt" });
    assert.equal(imported.value.verified, true);
    assert.equal(imported.value.source, "cli");
    assert.equal(readFileSync(join(process.env.CODEX_HOME, "auth.json"), "utf8"), codexDocument,
        "CLI file is never rewritten");
    const link = store.get(vendorCredentialName("chatgpt"));
    assert.equal(JSON.parse(link).kind, "cli-link");
    assert.equal(link.includes("codex-access"), false, "only the CLI link is persisted, not the token");
    const codexUsage = await handler("usage", { vendor: "chatgpt" });
    assert.deepEqual(codexUsage.value.usage.limits.map((row) => row.remainingPercent), [94, 76]);

    // An expired manual OAuth record refreshes before usage. Verification must
    // use the refreshed token fingerprint, otherwise the next status regresses.
    const refreshed = await handler("auth/token/set", {
        vendor: "chatgpt",
        kind: "oauth",
        token: JSON.stringify({ access_token: "old-codex-access", refresh_token: "old-refresh", expires: 1 })
    });
    assert.equal(refreshed.value.verified, true);
    const refreshedRecord = JSON.parse(store.get(vendorCredentialName("chatgpt")));
    assert.equal(refreshedRecord.secret.access, "new-codex-access");
    assert.equal(refreshedRecord.secret.refresh, "new-codex-refresh");
    const afterRefresh = await handler("auth/status");
    assert.equal(afterRefresh.value.vendors.chatgpt.verified, true,
        "verifiedFingerprint must be computed from the refreshed credential");
    refreshedRecord.secret.expires = 1;
    store.set(vendorCredentialName("chatgpt"), JSON.stringify(refreshedRecord));
    const expiredStatus = await handler("auth/status");
    assert.equal(expiredStatus.value.vendors.chatgpt.verified, false,
        "an expired OAuth record must not keep a green verified state");
    assert.equal(expiredStatus.value.vendors.chatgpt.expired, true);

    const invalid = await handler("auth/logout", { vendor: "not-a-vendor" });
    assert.equal(invalid.ok, false);
    const invalidSet = await handler("auth/api-key/set", { vendor: "not-a-vendor", apiKey: "bad" });
    assert.equal(invalidSet.ok, false, "invalid vendor cannot write credentials either");
    const status = await handler("auth/status");
    assert.equal(status.value.vendors.kimi.configured, true, "invalid vendor cannot delete Kimi");
    assert.equal(status.value.vendors.chatgpt.configured, true, "invalid vendor cannot delete Codex");

    const api = await handler("auth/api-config/set", {
        vendor: "chatgpt", label: "Fixture", endpoint: "https://example.com/v1", apiKey: "secret-key"
    });
    assert.equal(api.ok, true);
    assert.equal(api.value.status.apiConfigured, true);
    assert.equal(JSON.stringify(api.value).includes("secret-key"), false, "API secret never reaches Client");
    assert.equal(store.get(`${vendorCredentialName("chatgpt")}_API_CONFIG`).includes("secret-key"), true);
    const deleted = await handler("auth/api-config/delete", { vendor: "chatgpt" });
    assert.equal(deleted.value.status.apiConfigured, false);
}

// D. Kimi device flow: complete pending DTO, slow_down backoff, and cancel race.
{
    await handler("auth/logout", { vendor: "kimi" });
    let releaseToken;
    globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url === "https://api.kimi.com/coding/v1/usages") {
            if (init.headers?.authorization !== "Bearer new-access") return json({ error: "unauthorized" }, 401);
            return json({ usages: { limit_5h: { used_ratio: 0.2 }, limit_7d: { used_ratio: 0.4 } }, limits: [] });
        }
        if (url === "https://auth.kimi.com/api/oauth/device_authorization") {
            return json({
                device_code: "device-secret",
                user_code: "ABCD",
                verification_uri_complete: "https://www.kimi.com/code/device?code=ABCD",
                expires_in: 60,
                interval: 1
            });
        }
        if (url === "https://auth.kimi.com/api/oauth/token") {
            if (!releaseToken) {
                releaseToken = { phase: "pending" };
                return json({ error: "authorization_pending" }, 400);
            }
            if (releaseToken.phase === "pending") {
                releaseToken.phase = "slow";
                return json({ error: "slow_down" }, 400);
            }
            if (releaseToken.phase === "slow") {
                releaseToken.phase = "wait";
                return new Promise((resolve) => {
                    releaseToken.resolve = () => resolve(json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
                });
            }
            return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
        }
        throw new Error(`unexpected device fixture URL: ${url}`);
    };

    const started = await handler("auth/login/start", { vendor: "kimi" });
    const id = started.value.id;
    const pending = await handler("auth/login/poll", { vendor: "kimi", id });
    assert.equal(pending.value.phase, "waiting_device");
    assert.equal(pending.value.vendor, "kimi");
    assert.equal(pending.value.deviceCode.userCode, "ABCD");
    const slowed = await handler("auth/login/poll", { vendor: "kimi", id });
    assert.equal(slowed.value.phase, "waiting_device");
    assert.equal(slowed.value.intervalSeconds, 6, "slow_down increases the client interval");
    assert.equal(slowed.value.deviceCode.userCode, "ABCD");

    const inFlight = handler("auth/login/poll", { vendor: "kimi", id });
    await tick();
    const cancelled = await handler("auth/login/cancel", { vendor: "kimi", id });
    assert.equal(cancelled.value.phase, "cancelled");
    releaseToken.resolve();
    const completed = await inFlight;
    assert.equal(completed.value.phase, "cancelled", "a late token response cannot win over cancel");
    const status = await handler("auth/status");
    assert.equal(status.value.vendors.kimi.configured, false, "cancelled login must not store OAuth credentials");

    const successStart = await handler("auth/login/start", { vendor: "kimi" });
    const succeeded = await handler("auth/login/poll", { vendor: "kimi", id: successStart.value.id });
    assert.equal(succeeded.value.phase, "authenticated");
    const validated = await handler("auth/validate", { vendor: "kimi" });
    assert.equal(validated.value.verified, true, "device OAuth must pass a real usage validation");
    const expired = await handler("auth/login/poll", { vendor: "kimi", id: "missing-flow" });
    assert.equal(expired.value.phase, "expired");
}

rmSync(root, { recursive: true, force: true });
console.log("subscription authentication and usage checks passed");
