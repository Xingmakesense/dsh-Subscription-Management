/**
 * Host entry for direct DeepSeek balance plus the subscription handler.
 * Subscription credentials, OAuth, and vendor usage live in host/subscriptions/*.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cachePath, log } from "./status.js";
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

export const ACCOUNT_CHANNEL = "/utility-appearance-kit";
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

function bindConnectionWebServer(ctx, webServer) {
    try {
        const entry = [...ctx.loader.entries()].find((item) =>
            item.options?.id === "connection"
            && item.options?.name === "@deepseek-ai/dsh-client-connection");
        if (entry === undefined) return true;
        const fiber = entry.fiber;
        if (!fiber?.inject || !fiber.store) return false;
        if (fiber.store.webServer) return true;
        if (!("webServer" in fiber.inject)) fiber.inject.webServer = null;
        if (typeof fiber._checkImpl === "function") fiber._checkImpl("webServer");
        if (fiber._store?.webServer) {
            fiber.store.webServer = fiber._store.webServer;
            return true;
        }
        const impl = { name: "webServer", value: webServer, fiber };
        fiber.store.webServer = impl;
        if (fiber._store) fiber._store.webServer = impl;
        return true;
    } catch {
        return false;
    }
}

export const accountTest = Object.freeze({
    parseKimiCredential,
    recordTodayUsage,
    accountBalanceFromWallets,
    KIMI_CREDENTIAL_NAME,
    SUBSCRIPTION_VENDORS,
    vendorCredentialName,
    createHandler,
    ...usageTest,
    ...credentialTest,
    ...subscriptionHandlerTest
});

export function installAccountData(ctx, runtime) {
    try {
        ctx.inject(["webServer", "connection", "credentials", "loader"], (scope) => {
            try {
                scope.effect(() => {
                    if (!bindConnectionWebServer(scope, scope.webServer)) {
                        throw new Error("Connection fiber could not bind webServer");
                    }
                    const attached = runtime?.attach(scope);
                    attached?.catch((error) => log(ctx, "warn", `provider runtime unavailable: ${error?.message ?? String(error)}`));
                    return scope.connection.rpc.handle(
                        ACCOUNT_CHANNEL,
                        createHandler(ctx, scope, runtime),
                        { authority: "loopback" }
                    );
                });
            } catch (error) {
                log(ctx, "warn", `account data route unavailable: ${error?.message ?? String(error)}`);
            }
        });
    } catch (error) {
        log(ctx, "warn", `account data disabled: ${error?.message ?? String(error)}`);
    }
}
