import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { optionalSubscriptionVendor, requireSubscriptionVendor, subscriptionVendor, vendorSupports } from "./catalog.js";

export const KIMI_CREDENTIAL_NAME = "UTILITY_APPEARANCE_KIT_KIMI_CREDENTIAL";

let credentialModule;
async function credentialRefFor(name) {
    try {
        credentialModule ??= await import("@deepseek-ai/dsh-credentials");
        return credentialModule.credentialRef(name);
    } catch {
        return name;
    }
}

export class SubscriptionCredentialError extends Error {
    constructor(message, code = "AUTH") {
        super(message);
        this.name = "SubscriptionCredentialError";
        this.code = code;
    }
}

export function vendorCredentialName(vendor) {
    const id = typeof vendor === "string" ? vendor : vendor?.id;
    requireSubscriptionVendor(id);
    return id === "kimi" ? KIMI_CREDENTIAL_NAME : `${KIMI_CREDENTIAL_NAME}_${id.toUpperCase()}`;
}

function apiConfigCredentialName(vendor) {
    return `${vendorCredentialName(vendor)}_API_CONFIG`;
}

function nonEmpty(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function expiryMs(value) {
    if (Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
    if (typeof value === "string" && value.length > 0) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return expiryMs(numeric);
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function jwtExpiry(token) {
    if (typeof token !== "string") return undefined;
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    try {
        const payload = JSON.parse(Buffer.from(parts[1].replaceAll("-", "+").replaceAll("_", "/"), "base64url").toString("utf8"));
        return expiryMs(payload.exp);
    } catch {
        return undefined;
    }
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function fingerprintCredential(record) {
    if (record === undefined || record === null) return undefined;
    return createHash("sha256").update(stableJson({ kind: record.kind, secret: record.secret })).digest("hex");
}

function oauthSecret({ access, refresh, expires, ...rest }) {
    const token = nonEmpty(access);
    if (token === undefined) throw new SubscriptionCredentialError("OAuth access token 缺失");
    return {
        access: token,
        ...(nonEmpty(refresh) ? { refresh: refresh.trim() } : {}),
        ...(expiryMs(expires) !== undefined ? { expires: expiryMs(expires) } : {}),
        ...rest
    };
}

export function normalizeStoredRecord(vendor, value) {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "string" && !value.trimStart().startsWith("{")) {
        if (vendorSupports(vendor, "api-key")) {
            return { version: 1, kind: "api-key", secret: value, source: "manual" };
        }
        return { version: 1, kind: "legacy", secret: value, source: "manual", needsReconnect: true };
    }
    let parsed;
    try {
        parsed = typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        return { version: 1, kind: "legacy", secret: String(value), source: "manual", needsReconnect: true };
    }
    if (parsed?.type === "api_key" && nonEmpty(parsed.key) !== undefined) {
        return { version: 1, kind: "api-key", secret: parsed.key.trim(), source: "manual" };
    }
    if (parsed?.type === "oauth" && nonEmpty(parsed.access) !== undefined) {
        return {
            version: 1,
            kind: "oauth",
            secret: oauthSecret({
                access: parsed.access,
                refresh: parsed.refresh,
                expires: parsed.expires
            }),
            source: "manual"
        };
    }
    if (parsed?.kind === "cli-link" && nonEmpty(parsed.path) !== undefined) {
        return { ...parsed, version: 1, source: "cli" };
    }
    if (parsed?.version === 1 && ["api-key", "api-key-groups", "oauth", "session", "cookie", "api-config"].includes(parsed.kind)) {
        return { ...parsed, source: parsed.source === "cli" ? "cli" : "manual" };
    }
    return { version: 1, kind: "legacy", secret: String(value), source: "manual", needsReconnect: true };
}

async function readStoredRecord(scope, vendor) {
    const ref = await credentialRefFor(vendorCredentialName(vendor));
    const hit = await scope.credentials.resolve(ref);
    return normalizeStoredRecord(vendor, hit?.value);
}

async function writeStoredRecord(scope, vendor, record) {
    const ref = await credentialRefFor(vendorCredentialName(vendor));
    await scope.credentials.set(ref, JSON.stringify(record));
}

export async function writeVendorCredential(scope, vendor, record) {
    requireSubscriptionVendor(vendor.id);
    const stored = { ...record, version: 1 };
    if (stored.kind !== "cli-link") stored.fingerprint = fingerprintCredential(stored);
    await writeStoredRecord(scope, vendor, stored);
    return stored;
}

export async function clearVendorCredential(scope, vendor) {
    const ref = await credentialRefFor(vendorCredentialName(vendor));
    await scope.credentials.unset(ref);
    await clearLastVerifiedVendor(scope, vendor);
}

const ACTIVE_VENDOR_REF = "DSH_SUBSCRIPTION_MANAGEMENT_ACTIVE_VENDOR";

export async function readLastVerifiedVendor(scope) {
    const ref = await credentialRefFor(ACTIVE_VENDOR_REF);
    const hit = await scope.credentials.resolve(ref);
    return optionalSubscriptionVendor(hit?.value);
}

async function writeLastVerifiedVendor(scope, vendor) {
    const ref = await credentialRefFor(ACTIVE_VENDOR_REF);
    await scope.credentials.set(ref, vendor.id);
}

async function clearLastVerifiedVendor(scope, vendor) {
    const active = await readLastVerifiedVendor(scope);
    if (active?.id !== vendor.id) return;
    const ref = await credentialRefFor(ACTIVE_VENDOR_REF);
    await scope.credentials.unset(ref);
}

export function cliCredentialCandidates(vendor, env = process.env, home = homedir()) {
    const kind = vendor?.cli?.kind;
    switch (kind) {
        case "codex": {
            const candidates = [];
            if (nonEmpty(env.CODEX_HOME)) candidates.push(join(env.CODEX_HOME, "auth.json"));
            candidates.push(join(home, ".config", "codex", "auth.json"), join(home, ".codex", "auth.json"));
            return candidates;
        }
        case "claude":
            return nonEmpty(env.CLAUDE_CONFIG_DIR)
                ? [join(env.CLAUDE_CONFIG_DIR, ".credentials.json"), join(home, ".claude", ".credentials.json")]
                : [join(home, ".claude", ".credentials.json")];
        case "gemini":
            return [nonEmpty(env.GEMINI_OAUTH_CREDS_PATH) ?? join(home, ".gemini", "oauth_creds.json")];
        case "kilo":
            return [nonEmpty(env.KILO_AUTH_FILE) ?? join(home, ".local", "share", "kilo", "auth.json")];
        case "kiro":
            return [nonEmpty(env.KIRO_AUTH_TOKEN_FILE) ?? join(home, ".aws", "sso", "cache", "kiro-auth-token.json")];
        default:
            return [];
    }
}

export function parseCliCredential(vendor, document, path = "") {
    const kind = vendor?.cli?.kind;
    if (document === null || typeof document !== "object") {
        throw new SubscriptionCredentialError(`${vendor?.name ?? "厂商"} CLI 凭据格式无效`);
    }
    if (kind === "codex") {
        const tokens = document.tokens;
        return {
            version: 1,
            kind: "oauth",
            source: "cli",
            path,
            secret: oauthSecret({
                access: tokens?.access_token,
                refresh: tokens?.refresh_token,
                expires: jwtExpiry(tokens?.access_token),
                accountId: nonEmpty(tokens?.account_id)
            })
        };
    }
    if (kind === "claude") {
        const oauth = document.claudeAiOauth;
        return {
            version: 1,
            kind: "oauth",
            source: "cli",
            path,
            secret: oauthSecret({
                access: oauth?.accessToken,
                refresh: oauth?.refreshToken,
                expires: oauth?.expiresAt,
                scopes: Array.isArray(oauth?.scopes) ? oauth.scopes : undefined,
                subscriptionType: nonEmpty(oauth?.subscriptionType)
            })
        };
    }
    if (kind === "gemini") {
        return {
            version: 1,
            kind: "oauth",
            source: "cli",
            path,
            secret: oauthSecret({
                access: document.access_token,
                refresh: document.refresh_token,
                expires: document.expiry_date,
                projectId: nonEmpty(document.project_id ?? document.cloudaicompanionProject)
            })
        };
    }
    if (kind === "kilo") {
        const token = nonEmpty(document.kilo?.access ?? document.access);
        if (token === undefined) throw new SubscriptionCredentialError("Kilo CLI 会话缺少 kilo.access");
        return { version: 1, kind: "api-key", secret: token, source: "cli", path };
    }
    if (kind === "kiro") {
        return {
            version: 1,
            kind: "oauth",
            source: "cli",
            path,
            secret: oauthSecret({
                access: document.accessToken,
                refresh: document.refreshToken,
                expires: document.expiresAt,
                profileArn: nonEmpty(document.profileArn),
                authMethod: nonEmpty(document.authMethod)
            })
        };
    }
    throw new SubscriptionCredentialError(`${vendor?.name ?? "厂商"} 不支持 CLI 导入`, "UNSUPPORTED");
}

function readCliCredential(vendor, path) {
    try {
        return parseCliCredential(vendor, JSON.parse(readFileSync(path, "utf8")), path);
    } catch (error) {
        if (error instanceof SubscriptionCredentialError) throw error;
        throw new SubscriptionCredentialError(`${vendor.name} CLI 凭据不可读，请重新运行 ${vendor.cli?.command ?? "官方登录"}`);
    }
}

export async function resolveVendorCredential(scope, vendor) {
    const stored = await readStoredRecord(scope, vendor);
    if (stored === undefined) return undefined;
    if (stored.kind === "cli-link") {
        const resolved = readCliCredential(vendor, stored.path);
        return {
            ...resolved,
            verifiedFingerprint: stored.verifiedFingerprint,
            verifiedAt: stored.verifiedAt,
            plan: stored.plan,
            lastError: stored.lastError
        };
    }
    return stored;
}

export async function linkVendorCli(scope, vendor) {
    if (vendor?.cli === undefined) {
        throw new SubscriptionCredentialError(`${vendor?.name ?? "厂商"} 不支持 CLI 导入`, "UNSUPPORTED");
    }
    const candidates = cliCredentialCandidates(vendor);
    const path = candidates.find((candidate) => existsSync(candidate));
    if (path === undefined) {
        throw new SubscriptionCredentialError(`未找到 ${vendor.cli.label} 凭据，请先运行 ${vendor.cli.command}`);
    }
    readCliCredential(vendor, path);
    await writeVendorCredential(scope, vendor, { kind: "cli-link", source: "cli", path });
    return vendorAuthStatus(scope, vendor);
}

export async function saveManualCredential(scope, vendor, credential) {
    if (!vendorSupports(vendor, credential.kind) && !(vendor.id === "kimi" && credential.kind === "oauth")) {
        throw new SubscriptionCredentialError(`${vendor.name} 不支持 ${credential.kind} 认证`, "UNSUPPORTED");
    }
    await writeVendorCredential(scope, vendor, {
        kind: credential.kind,
        secret: credential.secret,
        source: "manual",
        label: nonEmpty(credential.label),
        endpoint: nonEmpty(credential.endpoint),
        region: nonEmpty(credential.region)
    });
    return vendorAuthStatus(scope, vendor);
}

function requireProtocomGroup(vendor, group) {
    if (vendor.id !== "protocom" || !vendor.groups?.some((entry) => entry.id === group)) {
        throw new SubscriptionCredentialError("未知 Protocom 分组", "UNSUPPORTED");
    }
    return group;
}

/** Save one Protocom group without replacing the other group keys. */
export async function saveGroupCredential(scope, vendor, group, credential) {
    requireProtocomGroup(vendor, group);
    if (credential.kind !== "api-key") {
        throw new SubscriptionCredentialError("Protocom 分组仅支持 API Key", "UNSUPPORTED");
    }
    const previous = await readStoredRecord(scope, vendor);
    const secrets = previous?.kind === "api-key-groups" && previous.secret !== null && typeof previous.secret === "object"
        ? { ...previous.secret }
        : previous?.kind === "api-key" && typeof previous.secret === "string"
            ? { aggregate: previous.secret }
            : {};
    secrets[group] = credential.secret;
    await writeVendorCredential(scope, vendor, {
        ...(previous?.kind === "api-key-groups" ? previous : {}),
        kind: "api-key-groups",
        secret: secrets,
        source: "manual",
        groupStates: {
            ...(previous?.kind === "api-key-groups" ? previous.groupStates : {}),
            [group]: { configured: true, verified: false }
        }
    });
    return vendorAuthStatus(scope, vendor);
}

/** Read a key only after the local user explicitly opens the credential card. */
export async function readApiKeyCredential(scope, vendor, group) {
    const resolved = await resolveVendorCredential(scope, vendor);
    if (resolved?.kind === "api-key") return resolved.secret;
    if (resolved?.kind === "api-key-groups") {
        requireProtocomGroup(vendor, group);
        const value = resolved.secret?.[group];
        if (typeof value === "string" && value.length > 0) return value;
    }
    throw new SubscriptionCredentialError(`${vendor.name} 没有可读取的 API Key`);
}

export function credentialFromInput(vendor, kind, input) {
    if (kind === "oauth") {
        let parsed = input;
        if (typeof input === "string") {
            const text = input.trim();
            if (text.length === 0) throw new SubscriptionCredentialError("OAuth 凭据不能为空");
            try {
                parsed = JSON.parse(text);
            } catch {
                if (vendor.id === "kiro") throw new SubscriptionCredentialError("Kiro 需要包含 profileArn 的 OAuth JSON");
                parsed = { access_token: text };
            }
        }
        if (vendor.id === "chatgpt") {
            const tokens = parsed?.tokens ?? parsed;
            const secret = oauthSecret({
                access: tokens?.access_token,
                refresh: tokens?.refresh_token,
                expires: jwtExpiry(tokens?.access_token),
                accountId: nonEmpty(tokens?.account_id)
            });
            if (/^sk-/iu.test(secret.access)) {
                throw new SubscriptionCredentialError("ChatGPT 订阅需要 Codex OAuth，不能使用普通 OpenAI API Key");
            }
            return { kind: "oauth", secret };
        }
        if (vendor.id === "claude") {
            const oauth = parsed?.claudeAiOauth ?? parsed;
            return { kind: "oauth", secret: oauthSecret({
                access: oauth?.accessToken ?? oauth?.access_token,
                refresh: oauth?.refreshToken ?? oauth?.refresh_token,
                expires: oauth?.expiresAt ?? oauth?.expiry_date,
                scopes: Array.isArray(oauth?.scopes) ? oauth.scopes : undefined,
                subscriptionType: nonEmpty(oauth?.subscriptionType)
            }) };
        }
        if (vendor.id === "kiro") {
            return { kind: "oauth", secret: oauthSecret({
                access: parsed?.accessToken ?? parsed?.access_token,
                refresh: parsed?.refreshToken ?? parsed?.refresh_token,
                expires: parsed?.expiresAt ?? parsed?.expiry_date,
                profileArn: nonEmpty(parsed?.profileArn),
                authMethod: nonEmpty(parsed?.authMethod)
            }) };
        }
        throw new SubscriptionCredentialError(`${vendor.name} 不支持手动 OAuth`, "UNSUPPORTED");
    }
    if (!["api-key", "session", "cookie"].includes(kind)) {
        throw new SubscriptionCredentialError("不支持的凭据类型", "UNSUPPORTED");
    }
    if (!vendorSupports(vendor, kind)) {
        throw new SubscriptionCredentialError(`${vendor.name} 不支持 ${kind} 认证`, "UNSUPPORTED");
    }
    const value = typeof input === "string" ? input.trim() : "";
    if (value.length === 0 || /[\r\n\0]/u.test(value)) {
        throw new SubscriptionCredentialError("凭据为空或包含非法换行");
    }
    if (kind !== "cookie" && !/^[\x21-\x7E]+$/u.test(value)) {
        throw new SubscriptionCredentialError("凭据只能包含可打印 ASCII 字符");
    }
    if (vendor.id === "devin" && !value.startsWith("devin-session-token$")) {
        throw new SubscriptionCredentialError("Devin 需要 devin-session-token$ 开头的会话 Token");
    }
    return { kind, secret: value };
}

export async function markVendorVerification(scope, vendor, resolved, { success, plan, error, verification }) {
    const stored = await readStoredRecord(scope, vendor);
    if (stored === undefined) return;
    const next = {
        ...stored,
        verifiedFingerprint: success === true ? fingerprintCredential(resolved) : undefined,
        verifiedAt: success === true ? Date.now() : undefined,
        plan: success === true ? nonEmpty(plan) : stored.plan,
        verification: success === true ? nonEmpty(verification) ?? "subscription" : stored.verification,
        lastError: success === true ? undefined : nonEmpty(error) ?? "认证验证失败"
    };
    await writeStoredRecord(scope, vendor, next);
    if (success === true) await writeLastVerifiedVendor(scope, vendor);
}

export async function markGroupVerification(scope, vendor, group, secret, { success, plan, accountName, error, verification }) {
    requireProtocomGroup(vendor, group);
    const stored = await readStoredRecord(scope, vendor);
    if (stored?.kind !== "api-key-groups") return;
    const fingerprint = fingerprintCredential({ kind: "api-key", secret });
    const previous = stored.groupStates?.[group] ?? {};
    const state = {
        configured: true,
        verified: success === true,
        verifiedFingerprint: success === true ? fingerprint : undefined,
        verifiedAt: success === true ? Date.now() : undefined,
        plan: success === true ? nonEmpty(plan) : previous.plan,
        accountName: success === true ? nonEmpty(accountName) : previous.accountName,
        verification: success === true ? nonEmpty(verification) ?? "subscription" : previous.verification,
        error: success === true ? undefined : nonEmpty(error) ?? "认证验证失败"
    };
    await writeStoredRecord(scope, vendor, {
        ...stored,
        lastGroup: group,
        plan: success === true ? nonEmpty(plan) : stored.plan,
        groupStates: { ...stored.groupStates, [group]: state }
    });
    if (success === true) await writeLastVerifiedVendor(scope, vendor);
}

function groupedAuthStatus(vendor, stored) {
    const groups = {};
    let verifiedCount = 0;
    for (const definition of vendor.groups ?? []) {
        const secret = stored.secret?.[definition.id];
        const configured = typeof secret === "string" && secret.length > 0;
        const state = stored.groupStates?.[definition.id] ?? {};
        const fingerprint = configured ? fingerprintCredential({ kind: "api-key", secret }) : undefined;
        const verified = configured && state.verifiedFingerprint === fingerprint;
        if (verified) verifiedCount += 1;
        groups[definition.id] = {
            configured,
            authenticated: verified,
            verified,
            plan: state.plan,
            accountName: state.accountName,
            verification: state.verification,
            verifiedAt: verified ? state.verifiedAt : undefined,
            error: state.error
        };
    }
    const configured = Object.values(groups).some((entry) => entry.configured);
    const verified = verifiedCount > 0;
    return {
        configured,
        authenticated: verified,
        verified,
        method: "api-key-groups",
        source: stored.source,
        group: stored.lastGroup,
        plan: stored.plan,
        groups
    };
}

export async function vendorAuthStatus(scope, vendor, { includeApiConfig = true } = {}) {
    const stored = await readStoredRecord(scope, vendor);
    if (stored === undefined) {
        return { configured: false, authenticated: false, verified: false };
    }
    if (stored.needsReconnect === true || stored.kind === "legacy") {
        return {
            configured: true,
            authenticated: false,
            verified: false,
            needsReconnect: true,
            error: "旧版凭据需要重新认证"
        };
    }
    if (stored.kind === "api-key-groups") return groupedAuthStatus(vendor, stored);
    let resolved;
    try {
        resolved = await resolveVendorCredential(scope, vendor);
    } catch (error) {
        return {
            configured: true,
            authenticated: false,
            verified: false,
            source: stored.source,
            error: error.message
        };
    }
    const fingerprint = fingerprintCredential(resolved);
    const expired = credentialIsExpired(resolved);
    const verified = !expired && stored.verifiedFingerprint !== undefined && stored.verifiedFingerprint === fingerprint;
    const apiConfig = includeApiConfig ? await apiConfigStatus(scope, vendor) : undefined;
    return {
        configured: true,
        authenticated: verified,
        verified,
        method: resolved.kind,
        source: resolved.source,
        expiresAt: resolved.secret?.expires,
        expired,
        verifiedAt: verified ? stored.verifiedAt : undefined,
        plan: stored.plan,
        verification: stored.verification,
        error: expired ? "凭据已过期，请重新验证" : stored.lastError,
        apiConfigured: includeApiConfig && apiConfig !== undefined,
        apiConfig
    };
}

export async function apiConfigStatus(scope, vendor) {
    const ref = await credentialRefFor(apiConfigCredentialName(vendor));
    const hit = await scope.credentials.resolve(ref);
    if (hit?.value === undefined || hit.value === "") return undefined;
    try {
        const parsed = JSON.parse(hit.value);
        if (parsed?.kind !== "api-config") return undefined;
        return {
            label: nonEmpty(parsed.label),
            endpoint: nonEmpty(parsed.endpoint),
            configured: nonEmpty(parsed.secret?.apiKey) !== undefined || nonEmpty(parsed.endpoint) !== undefined
        };
    } catch {
        return undefined;
    }
}

export async function saveApiConfig(scope, vendor, input) {
    if (vendor.api !== "closed") {
        throw new SubscriptionCredentialError(`${vendor.name} 已提供官方 API 管理，无需此功能`, "UNSUPPORTED");
    }
    const label = nonEmpty(input?.label) ?? "";
    const endpoint = nonEmpty(input?.endpoint) ?? "";
    const apiKey = nonEmpty(input?.apiKey) ?? "";
    if (label.length === 0 && endpoint.length === 0 && apiKey.length === 0) {
        throw new SubscriptionCredentialError("API 名称、地址和 Key 不能全部为空");
    }
    if (endpoint.length > 0) {
        let url;
        try { url = new URL(endpoint); } catch { throw new SubscriptionCredentialError("API 地址无效"); }
        if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
            throw new SubscriptionCredentialError("API 地址必须是无用户信息的 HTTPS URL");
        }
    }
    const ref = await credentialRefFor(apiConfigCredentialName(vendor));
    let previous;
    try {
        const hit = await scope.credentials.resolve(ref);
        previous = hit?.value === undefined ? undefined : JSON.parse(hit.value);
    } catch {
        previous = undefined;
    }
    const retainedKey = apiKey.length > 0 ? apiKey : nonEmpty(previous?.secret?.apiKey) ?? "";
    await scope.credentials.set(ref, JSON.stringify({
        version: 1,
        kind: "api-config",
        label,
        endpoint,
        secret: { apiKey: retainedKey }
    }));
    return apiConfigStatus(scope, vendor);
}

export async function deleteApiConfig(scope, vendor) {
    const ref = await credentialRefFor(apiConfigCredentialName(vendor));
    await scope.credentials.unset(ref);
}

const vendorLocks = new Map();

/** Serialize save/refresh/validate/logout for one vendor. */
export function withVendorLock(vendor, operation) {
    const id = typeof vendor === "string" ? vendor : vendor.id;
    const previous = vendorLocks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.catch(() => undefined);
    vendorLocks.set(id, tail);
    tail.finally(() => {
        if (vendorLocks.get(id) === tail) vendorLocks.delete(id);
    });
    return current;
}

export function credentialIsExpired(record, now = Date.now(), leewayMs = 60_000) {
    const expires = record?.secret?.expires;
    return Number.isFinite(expires) && expires - leewayMs <= now;
}

export function parseKimiCredential(value) {
    if (typeof value !== "string" || !value.trimStart().startsWith("{")) return undefined;
    const record = normalizeStoredRecord(subscriptionVendor("kimi"), value);
    if (record?.kind === "api-key") return { type: "api_key", key: record.secret };
    if (record?.kind === "oauth") {
        return {
            type: "oauth",
            access: record.secret.access,
            refresh: record.secret.refresh,
            expires: record.secret.expires
        };
    }
    return undefined;
}

export const credentialTest = Object.freeze({
    normalizeStoredRecord,
    parseCliCredential,
    credentialFromInput,
    cliCredentialCandidates,
    fingerprintCredential,
    credentialIsExpired,
    apiConfigCredentialName
});
