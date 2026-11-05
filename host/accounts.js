/**
 * Host entry for direct DeepSeek balance plus the subscription handler.
 * Subscription credentials, OAuth, and vendor usage live in host/subscriptions/*.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cachePath, log, recordStatus } from "./status.js";
import { requestJson } from "./subscriptions/http.js";
import { createSubscriptionHandler, ok } from "./subscriptions/index.js";
import { SUBSCRIPTION_VENDORS } from "./subscriptions/catalog.js";
import {
    KIMI_CREDENTIAL_NAME,
    credentialTest,
    parseKimiCredential,
    vendorCredentialName
} from "./subscriptions/credentials.js";
import { usageTest } from "./subscriptions/usage.js";
import { subscriptionHandlerTest } from "./subscriptions/index.js";

export const ACCOUNT_CHANNEL = "/dsh-subscription-management";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEEPSEEK_TIMEOUT_MS = 12_000;

let credentialModule;
async function credentialRefFor(name) {
    try {
        credentialModule ??= await import("@deepseek-ai/dsh-credentials");
        return credentialModule.credentialRef(name);
    } catch {
        return name;
    }
}

function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value) {
    if (typeof value !== "number" && typeof value !== "string") return undefined;
    if (typeof value === "string" && value.trim().length === 0) return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

function beijingDayKey(now) {
    return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function deepseekLedgerPath() {
    return join(dirname(cachePath()), "deepseek-usage.json");
}

function readDeepseekLedger() {
    try {
        const parsed = JSON.parse(readFileSync(deepseekLedgerPath(), "utf8"));
        if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
        // missing/corrupt ledger starts a fresh observation window
    }
    return {};
}

function writeDeepseekLedger(ledger) {
    try {
        const path = deepseekLedgerPath();
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(ledger), "utf8");
        renameSync(tmp, path);
    } catch {
        // A failed ledger write must not hide the live balance.
    }
}

function recordTodayUsage(balance, currency, now = Date.now()) {
    const day = beijingDayKey(now);
    const previous = readDeepseekLedger();
    const sameDay = previous.date === day && previous.currency === currency;
    let todayUsage = sameDay && Number.isFinite(previous.todayUsage) ? previous.todayUsage : 0;
    const lastBalance = sameDay && Number.isFinite(previous.lastBalance) ? previous.lastBalance : undefined;
    if (lastBalance !== undefined && Number.isFinite(balance) && balance < lastBalance) {
        todayUsage = Number((todayUsage + (lastBalance - balance)).toFixed(8));
    }
    writeDeepseekLedger({ date: day, currency, lastBalance: balance, todayUsage, updatedAt: now });
    return Number(todayUsage.toFixed(8));
}

async function deepseekApiKeyBalance(scope) {
    const ref = await credentialRefFor("DEEPSEEK_API_KEY");
    const hit = await scope.credentials.resolve(ref);
    if (hit?.value === undefined || hit.value === "") return undefined;
    const { response, payload } = await requestJson(DEEPSEEK_BALANCE_URL, {
        headers: { authorization: `Bearer ${hit.value}`, accept: "application/json" }
    }, DEEPSEEK_TIMEOUT_MS);
    if (!response.ok) throw new Error("DeepSeek account balance is unavailable");
    const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    const numeric = (wallet) => finiteNumber(wallet?.total_balance);
    const chosen = infos.find((wallet) => wallet?.currency === "CNY" && numeric(wallet) > 0)
        ?? infos.find((wallet) => numeric(wallet) > 0)
        ?? infos.find((wallet) => wallet?.currency === "CNY" && Number.isFinite(numeric(wallet)))
        ?? infos.find((wallet) => Number.isFinite(numeric(wallet)));
    if (chosen === undefined || !Number.isFinite(numeric(chosen))) {
        throw new Error("DeepSeek account has no balance wallet");
    }
    return {
        totalBalance: numeric(chosen),
        rechargeBalance: finiteNumber(chosen.topped_up_balance),
        bonusBalance: finiteNumber(chosen.granted_balance),
        currency: nonEmptyString(chosen.currency) ?? "CNY",
        balanceSource: "apikey"
    };
}

function accountBalanceFromWallets(result) {
    if (result === null || typeof result !== "object" || result.status !== "ready") return undefined;
    const normal = (Array.isArray(result.value) ? result.value : [])
        .filter((wallet) => wallet !== null && typeof wallet === "object" && Number.isFinite(finiteNumber(wallet.balance)));
    const bonus = (Array.isArray(result.bonusWallets) ? result.bonusWallets : [])
        .filter((wallet) => wallet !== null && typeof wallet === "object" && Number.isFinite(finiteNumber(wallet.balance)));
    const wallets = [...normal, ...bonus];
    if (wallets.length === 0) return undefined;
    const currencyOf = (wallet) => String(wallet.currency ?? "CNY").toUpperCase();
    const nonzero = wallets.filter((wallet) => Number(wallet.balance) > 0);
    const chosen = nonzero.find((wallet) => currencyOf(wallet) === "CNY")
        ?? nonzero[0]
        ?? wallets.find((wallet) => currencyOf(wallet) === "CNY")
        ?? wallets[0];
    const currency = currencyOf(chosen);
    const sum = (list) => list
        .filter((wallet) => currencyOf(wallet) === currency)
        .reduce((total, wallet) => total + Number(wallet.balance), 0);
    const recharge = sum(normal);
    const bonusTotal = sum(bonus);
    return {
        totalBalance: Number((recharge + bonusTotal).toFixed(8)),
        rechargeBalance: Number(recharge.toFixed(8)),
        bonusBalance: Number(bonusTotal.toFixed(8)),
        currency,
        balanceSource: "account"
    };
}

async function deepseekAccountBalance(ctx) {
    const account = typeof ctx.get === "function" ? ctx.get("deepseekAccount") : undefined;
    if (account === undefined || account === null || typeof account.getBalance !== "function") return undefined;
    let timer;
    try {
        const result = await Promise.race([
            account.getBalance({
                version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || "") || "unknown",
                locale: String(process.env.DSH_LOCALE || "") || "zh_CN",
                timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
            }),
            new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), 8000); })
        ]);
        return accountBalanceFromWallets(result);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function deepseekSnapshot(ctx, scope) {
    try {
        const balance = (await deepseekApiKeyBalance(scope)) ?? (await deepseekAccountBalance(ctx));
        if (balance === undefined) return { ok: false, error: "DeepSeek account is not connected" };
        const todayUsage = recordTodayUsage(balance.totalBalance, balance.currency);
        return {
            ok: true,
            totalBalance: balance.totalBalance,
            todayUsage,
            currency: balance.currency,
            todayUsageCurrency: balance.currency,
            bonusBalance: balance.bonusBalance,
            rechargeBalance: balance.rechargeBalance,
            balanceSource: balance.balanceSource,
            usageLabel: "余额差",
            stale: false
        };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error && /not connected|no balance wallet/iu.test(error.message)
                ? error.message
                : "DeepSeek account balance is unavailable"
        };
    }
}

let deepseekInFlight;
async function sharedDeepseekSnapshot(ctx, scope) {
    if (deepseekInFlight !== undefined) return deepseekInFlight;
    const pending = deepseekSnapshot(ctx, scope).finally(() => {
        if (deepseekInFlight === pending) deepseekInFlight = undefined;
    });
    deepseekInFlight = pending;
    return pending;
}

export function createHandler(ctx, scope, runtime) {
    const subscriptions = createSubscriptionHandler(scope, runtime);
    return async (endpoint, payload) => {
        if (endpoint === "deepseek") return ok(await sharedDeepseekSnapshot(ctx, scope));
        return subscriptions(endpoint, payload);
    };
}

const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/u;
const RPC_BODY_LIMIT = 1024 * 1024;

/** The RPC endpoint inside this plugin's channel, or `undefined` for another path. */
export function endpointOf(channel, pathname) {
    if (typeof pathname !== "string" || !pathname.startsWith(`${channel}/`)) return undefined;
    const endpoint = pathname.slice(channel.length + 1);
    if (endpoint.length === 0) return undefined;
    return endpoint.split("/").every((segment) =>
        segment !== "." && segment !== ".." && ENDPOINT_SEGMENT.test(segment))
        ? endpoint
        : undefined;
}

function sendJson(response, status, body, headers = {}) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...headers
    });
    response.end(text);
}

async function readBody(request, limit = RPC_BODY_LIMIT) {
    if (request === null || typeof request !== "object") return undefined;
    const declared = Number(request.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit) return undefined;
    const chunks = [];
    let received = 0;
    for await (const chunk of request) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        received += buffer.byteLength;
        if (received > limit) return undefined;
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * Build this plugin's Connection-compatible RPC route.
 *
 * The plugin owns its prefix on the Host `webServer` instead of borrowing
 * Connection internals; `reject` keeps the Host/Origin and browser-session
 * fence by returning a status code (403/401) or `undefined` to admit.
 *
 * @param {{ handler: (endpoint: string, payload: unknown) => Promise<unknown>, reject: (request: object) => number | undefined, channel?: string }} options
 * @returns {(request: object, response: object) => Promise<void>} HTTP handler.
 */
export function createAccountRoute(options) {
    const channel = options.channel ?? ACCOUNT_CHANNEL;
    const handler = options.handler;
    const reject = options.reject;
    return async function accountRoute(request, response) {
        // Admit first: an unauthenticated caller must not learn which endpoints
        // exist, and the Connection fence is never bypassed by method probing.
        const rejection = reject === undefined ? undefined : reject(request);
        if (rejection !== undefined && rejection !== null) {
            sendJson(response, Number.isFinite(rejection) ? rejection : 503, {
                ok: false,
                error: { code: "unauthorized", message: "request rejected", details: {} }
            });
            return;
        }
        if (request.method !== "POST") {
            sendJson(response, 405, { ok: false, error: { code: "method-not-allowed", message: "POST required", details: {} } }, { allow: "POST" });
            return;
        }
        const contentType = request.headers?.["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "application/json") {
            sendJson(response, 415, { ok: false, error: { code: "unsupported-media-type", message: "content type must be application/json", details: {} } });
            return;
        }
        let pathname;
        try {
            pathname = new URL(request.url ?? "/", "http://dsh.internal").pathname;
        } catch {
            sendJson(response, 400, { ok: false, error: { code: "bad-request", message: "invalid request URL", details: {} } });
            return;
        }
        const endpoint = endpointOf(channel, pathname);
        if (endpoint === undefined) {
            sendJson(response, 404, { ok: false, error: { code: "not-found", message: "unknown subscription endpoint", details: {} } });
            return;
        }
        const raw = await readBody(request);
        if (raw === undefined) {
            sendJson(response, 413, { ok: false, error: { code: "payload-too-large", message: "request body exceeds the subscription RPC limit", details: {} } });
            return;
        }
        let envelope;
        try {
            envelope = JSON.parse(raw);
        } catch {
            sendJson(response, 400, { ok: false, error: { code: "bad-request", message: "body is not JSON", details: {} } });
            return;
        }
        if (envelope === null || typeof envelope !== "object" || typeof envelope.rpcId !== "string") {
            sendJson(response, 400, { ok: false, error: { code: "bad-request", message: "invalid client-request message", details: {} } });
            return;
        }
        if (envelope.method !== endpoint) {
            sendJson(response, 200, {
                type: "server-response",
                rpcId: envelope.rpcId,
                result: {
                    ok: false,
                    error: {
                        code: "gateway/bad-request",
                        message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
                        details: { issues: [] }
                    }
                }
            });
            return;
        }
        try {
            const result = await handler(endpoint, envelope.payload);
            sendJson(response, 200, { type: "server-response", rpcId: envelope.rpcId, result });
        } catch (error) {
            log(options.ctx, "warn", `account RPC handler failed: ${error?.message ?? String(error)}`);
            sendJson(response, 500, { ok: false, error: { code: "internal", message: "subscription handler failure", details: {} } });
        }
    };
}

function connectionRejection(scope) {
    return (request) => {
        const connection = typeof scope?.get === "function" ? scope.get("connection") : scope?.connection;
        if (connection === null || connection === undefined || typeof connection.requestRejection !== "function") {
            // Fail closed: without the Connection fence a loopback route would
            // answer any web page that can reach this port.
            return 503;
        }
        try {
            return connection.requestRejection(request);
        } catch {
            return 503;
        }
    };
}

export const accountTest = Object.freeze({
    parseKimiCredential,
    recordTodayUsage,
    accountBalanceFromWallets,
    KIMI_CREDENTIAL_NAME,
    SUBSCRIPTION_VENDORS,
    vendorCredentialName,
    createHandler,
    createAccountRoute,
    endpointOf,
    ...usageTest,
    ...credentialTest,
    ...subscriptionHandlerTest
});

export function installAccountData(ctx, runtime) {
    try {
        ctx.inject(["webServer", "credentials"], (scope) => {
            try {
                scope.effect(() => {
                    const attached = runtime?.attach(scope);
                    attached?.catch((error) => log(ctx, "warn", `provider runtime unavailable: ${error?.message ?? String(error)}`));
                    const route = createAccountRoute({
                        handler: createHandler(ctx, scope, runtime),
                        reject: connectionRejection(scope)
                    });
                    const dispose = scope.webServer.register({
                        kind: "prefix",
                        path: ACCOUNT_CHANNEL,
                        handler: route
                    });
                    recordStatus("plugin", { phase: "route-registered", channel: ACCOUNT_CHANNEL });
                    return dispose;
                });
            } catch (error) {
                recordStatus("plugin", { phase: "route-error", error: String(error?.message ?? error) });
                log(ctx, "warn", `account data route unavailable: ${error?.message ?? String(error)}`);
            }
        });
    } catch (error) {
        log(ctx, "warn", `account data disabled: ${error?.message ?? String(error)}`);
    }
}
