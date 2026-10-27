import { SUBSCRIPTION_VENDORS, requireSubscriptionVendor, vendorSupports } from "./catalog.js";
import {
    credentialFromInput,
    credentialIsExpired,
    deleteApiConfig,
    linkVendorCli,
    markVendorVerification,
    resolveVendorCredential,
    saveApiConfig,
    saveManualCredential,
    clearVendorCredential,
    vendorAuthStatus,
    readLastVerifiedVendor,
    withVendorLock,
    writeVendorCredential
} from "./credentials.js";
import { fetchSubscriptionUsage, SubscriptionUsageError } from "./usage.js";
import { startKimiLogin, pollKimiLogin, cancelKimiLogin } from "./kimi-oauth.js";

export const ok = (value) => ({ ok: true, value });
export const badRequest = (message) => ({
    ok: false,
    error: { code: "bad-request", message, details: { issues: [] } }
});

function safeError(error) {
    const message = String(error?.message ?? error ?? "订阅认证失败");
    if (/bearer\s+\S+|cookie\s*:|sk-[a-z0-9_-]{8,}|access[_-]?token/iu.test(message)) {
        return "订阅认证失败，请检查凭据后重试";
    }
    return message.slice(0, 300);
}

async function validateResolved(scope, vendor, resolved) {
    if (resolved === undefined) {
        return { configured: false, authenticated: false, verified: false, vendor: vendor.id };
    }
    if (resolved.needsReconnect === true || resolved.kind === "legacy") {
        throw new Error(`${vendor.name} 旧版凭据需要重新认证`);
    }
    try {
        if (resolved.source === "cli" && credentialIsExpired(resolved)) {
            throw new Error(`${vendor.name} CLI 凭据已过期，请重新运行 ${vendor.cli?.command ?? "官方登录"}`);
        }
        let verifiedRecord = resolved;
        const usage = await fetchSubscriptionUsage(vendor, resolved, {
            writeCredential: (record) => {
                verifiedRecord = record;
                return writeVendorCredential(scope, vendor, record);
            }
        });
        await markVendorVerification(scope, vendor, verifiedRecord, {
            success: true,
            plan: usage.plan,
            verification: usage.verification
        });
        return {
            configured: true,
            authenticated: true,
            verified: true,
            vendor: vendor.id,
            usage
        };
    } catch (error) {
        await markVendorVerification(scope, vendor, resolved, {
            success: false,
            error: safeError(error)
        });
        throw error;
    }
}

const validationInFlight = new Map();

async function validateCurrent(scope, vendor) {
    const existing = validationInFlight.get(vendor.id);
    if (existing !== undefined) return existing;
    const pending = withVendorLock(vendor, async () => {
        const resolved = await resolveVendorCredential(scope, vendor);
        return validateResolved(scope, vendor, resolved);
    });
    validationInFlight.set(vendor.id, pending);
    try {
        return await pending;
    } finally {
        if (validationInFlight.get(vendor.id) === pending) validationInFlight.delete(vendor.id);
    }
}

async function saveAndValidate(scope, vendor, credential) {
    return withVendorLock(vendor, async () => {
        await saveManualCredential(scope, vendor, credential);
        try {
            await validateResolved(scope, vendor, await resolveVendorCredential(scope, vendor));
        } catch {
            // The credential remains saved with a sanitized verification error.
        }
        return vendorAuthStatus(scope, vendor);
    });
}

async function linkAndValidate(scope, vendor) {
    return withVendorLock(vendor, async () => {
        await linkVendorCli(scope, vendor);
        try {
            await validateResolved(scope, vendor, await resolveVendorCredential(scope, vendor));
        } catch {
            // Keep the CLI link so the user can repair the official login and retry.
        }
        return vendorAuthStatus(scope, vendor);
    });
}

async function validateAndReport(scope, vendor) {
    return withVendorLock(vendor, async () => {
        try {
            await validateResolved(scope, vendor, await resolveVendorCredential(scope, vendor));
        } catch {
            // Return the per-vendor state; the row displays the verification error.
        }
        return vendorAuthStatus(scope, vendor);
    });
}

async function automaticVendor(scope) {
    const recent = await readLastVerifiedVendor(scope);
    if (recent !== undefined) {
        const status = await vendorAuthStatus(scope, recent, { includeApiConfig: false });
        if (status.verified) return recent;
    }
    const statuses = await Promise.all(SUBSCRIPTION_VENDORS.map(async (vendor) => ({
        vendor,
        status: await vendorAuthStatus(scope, vendor, { includeApiConfig: false })
    })));
    return statuses.find((entry) => entry.status.verified && entry.status.verification !== "api")?.vendor
        ?? statuses.find((entry) => entry.status.verified)?.vendor
        ?? statuses.find((entry) => entry.status.configured && !entry.status.needsReconnect)?.vendor
        ?? SUBSCRIPTION_VENDORS[0];
}

function inputCredential(vendor, input) {
    if (input.kind !== undefined) return credentialFromInput(vendor, input.kind, input.token ?? input.apiKey);
    if (vendorSupports(vendor, "oauth")) return credentialFromInput(vendor, "oauth", input.token);
    if (vendorSupports(vendor, "session")) return credentialFromInput(vendor, "session", input.token);
    if (vendorSupports(vendor, "cookie")) return credentialFromInput(vendor, "cookie", input.token);
    if (vendorSupports(vendor, "api-key")) return credentialFromInput(vendor, "api-key", input.token ?? input.apiKey);
    throw new Error(`${vendor.name} 不支持手动凭据`);
}

export function createSubscriptionHandler(scope) {
    return async (endpoint, payload) => {
        try {
            const input = payload !== null && typeof payload === "object" ? payload : {};
            if (endpoint === "usage") {
                const vendor = input.vendor === undefined
                    ? await automaticVendor(scope)
                    : requireSubscriptionVendor(input.vendor);
                const result = await validateCurrent(scope, vendor);
                return ok(result);
            }
            if (endpoint === "auth/status") {
                const entries = await Promise.all(SUBSCRIPTION_VENDORS.map(async (vendor) => [
                    vendor.id,
                    await vendorAuthStatus(scope, vendor)
                ]));
                return ok({ vendors: Object.fromEntries(entries) });
            }
            if (endpoint === "auth/api-key/set") {
                const vendor = requireSubscriptionVendor(input.vendor);
                if (!vendorSupports(vendor, "api-key")) throw new Error(`${vendor.name} 不支持订阅 API Key`);
                return ok(await saveAndValidate(scope, vendor,
                    credentialFromInput(vendor, "api-key", input.apiKey)));
            }
            if (endpoint === "auth/token/set") {
                const vendor = requireSubscriptionVendor(input.vendor);
                return ok(await saveAndValidate(scope, vendor, inputCredential(vendor, input)));
            }
            if (endpoint === "auth/cli/import") {
                const vendor = requireSubscriptionVendor(input.vendor);
                if (vendor.cli === undefined) throw new Error(`${vendor.name} 不支持 CLI 导入`);
                return ok(await linkAndValidate(scope, vendor));
            }
            if (endpoint === "auth/validate") {
                const vendor = requireSubscriptionVendor(input.vendor);
                return ok(await validateAndReport(scope, vendor));
            }
            if (endpoint === "auth/api-config/set") {
                const vendor = requireSubscriptionVendor(input.vendor);
                return withVendorLock(vendor, async () => ok({
                    apiConfig: await saveApiConfig(scope, vendor, input),
                    status: await vendorAuthStatus(scope, vendor)
                }));
            }
            if (endpoint === "auth/api-config/delete") {
                const vendor = requireSubscriptionVendor(input.vendor);
                return withVendorLock(vendor, async () => {
                    await deleteApiConfig(scope, vendor);
                    return ok({ status: await vendorAuthStatus(scope, vendor) });
                });
            }
            if (endpoint === "auth/login/start") {
                const vendor = requireSubscriptionVendor(input.vendor);
                if (!vendorSupports(vendor, "device") || vendor.id !== "kimi") {
                    throw new Error(`${vendor.name} 不支持设备授权登录`);
                }
                return ok(await startKimiLogin());
            }
            if (endpoint === "auth/login/poll") {
                const vendor = requireSubscriptionVendor(input.vendor);
                if (vendor.id !== "kimi") throw new Error(`${vendor.name} 不支持设备授权登录`);
                return withVendorLock(vendor, async () => ok(await pollKimiLogin(scope, input.id)));
            }
            if (endpoint === "auth/login/cancel") {
                const vendor = requireSubscriptionVendor(input.vendor);
                if (vendor.id !== "kimi") throw new Error(`${vendor.name} 不支持设备授权登录`);
                return ok(cancelKimiLogin(input.id));
            }
            if (endpoint === "auth/logout") {
                const vendor = requireSubscriptionVendor(input.vendor);
                return withVendorLock(vendor, async () => {
                    await clearVendorCredential(scope, vendor);
                    return ok({ configured: false, authenticated: false, verified: false, vendor: vendor.id });
                });
            }
            return badRequest("unknown subscription endpoint");
        } catch (error) {
            const message = error instanceof SubscriptionUsageError || error?.code === "AUTH"
                ? safeError(error)
                : safeError(error);
            return badRequest(message);
        }
    };
}

export const subscriptionHandlerTest = Object.freeze({
    automaticVendor,
    validateResolved,
    inputCredential,
    safeError
});
