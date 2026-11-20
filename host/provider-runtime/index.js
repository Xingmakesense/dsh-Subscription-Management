import { createHash } from "node:crypto";
import { LlmError } from "@deepseek-ai/dsh-llm";
import {
    BalanceService,
    CommandCodeAccountService,
    FAMILIES,
    GoUsageService,
    ProtocomAdapter,
    discoverModels,
    resolveAdapterOptions,
    stripVariantId
} from "./protocom-api.js";
import { commandCodeUsageView, openCodeUsageView, protocomUsageView } from "./telemetry-view.js";
import { subscriptionVendor, vendorAllowsAutoModelSetup } from "../subscriptions/catalog.js";
import { resolveVendorCredential, writeVendorCredential } from "../subscriptions/credentials.js";
import { ensureFreshOAuth } from "../subscriptions/usage.js";
import { OAUTH_ADAPTERS, OAUTH_FAMILIES } from "./subscription-oauth.js";

const SETTINGS_NS = "dsh-subscription-management";
const FAMILY_VENDORS = Object.freeze({
    "protocom-api": "protocom",
    "opencode-go": "opencode-go",
    commandcode: "commandcode",
    clinepass: "clinepass",
    // Subscription-login providers mounted by this plugin (no API key).
    "claude-subscription": "claude",
    "codex-subscription": "chatgpt"
});

/** Every family this plugin mounts: the four relay families plus OAuth subscriptions. */
export const ALL_FAMILIES = Object.freeze([...FAMILIES, ...OAUTH_FAMILIES]);

/** Keep the author's wire adapter but disable retries on these routes. */
class SubscriptionAdapter extends ProtocomAdapter {
    providerRetryPolicy() {
        return {
            mode: "normal",
            maxRetries: 0,
            initialDelayMs: 500,
            maxDelayMs: 500,
            jitterRatio: 0,
            retryableCodes: []
        };
    }
}

function familyForProvider(provider) {
    return FAMILIES.find((family) => family.groupOf(provider) !== undefined);
}

function familyForRequest(request, fallback) {
    const routed = typeof request?.provider === "string" ? familyForProvider(request.provider) : undefined;
    if (routed !== undefined) return routed;
    if (typeof request?.baseURL === "string") {
        try {
            const origin = new URL(request.baseURL).origin;
            const matched = FAMILIES.find((family) => family.origin === origin);
            if (matched !== undefined) return matched;
        } catch {
            // The author's discovery validator reports the malformed URL.
        }
    }
    return fallback;
}

function registryDiscovery(family) {
    const refused = new Set(family.refused ?? []);
    return family.registry
        .filter((entry) => family.keys.some((key) => entry.groups?.includes(key) === true))
        .filter((entry) => !refused.has(entry.id))
        .map((entry) => ({
            id: entry.id,
            name: entry.displayName,
            contextWindow: entry.contextWindow,
            ...(entry.vision === false ? {} : { inputModalities: ["text", "image"] })
        }));
}

function secretFor(record, vendorId, group) {
    if (record === undefined || record === null) return undefined;
    if (vendorId === "protocom") {
        if (record.kind === "api-key-groups") {
            const value = record.secret?.[group];
            return typeof value === "string" && value.length > 0 ? value : undefined;
        }
        // A single early-development Protocom key belongs to Aggregate.
        if (group === "aggregate" && record.kind === "api-key") return record.secret;
        return undefined;
    }
    return record.kind === "api-key" && typeof record.secret === "string" && record.secret.length > 0
        ? record.secret
        : undefined;
}

function sameSecretMap(left, right) {
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
        if (right.get(key) !== value) return false;
    }
    return true;
}

function secretSignature(value) {
    return createHash("sha256").update(value).digest("hex");
}

/**
 * Bridge the author's tested provider runtime to this plugin's credentials and
 * native DSH model settings. No author Client, Fusion, or custom retry is mounted.
 */
export function installProviderRuntime(ctx, readConfig) {
    const states = new Map();
    const secrets = new Map();
    const recentGroups = new Map();
    const configuredSignatures = new Map();
    let credentialScope;
    let syncPromise;

    /** Codex routes need the account id from the credential on every request. */
    const oauthAccountIds = new Map();

    for (const family of ALL_FAMILIES) {
        const vendorId = FAMILY_VENDORS[family.ns];
        secrets.set(family.ns, new Map());

        const rawSection = () => {
            const unwrap = (value) => typeof value?.get === "function" ? value.get() : value;
            const root = unwrap(readConfig()) ?? {};
            const providers = unwrap(root.providers) ?? {};
            return unwrap(providers[family.sectionKey]) ?? {};
        };
        let cachedSection;
        let cachedSecrets;
        let cachedOptions;
        const options = () => {
            const section = rawSection();
            const configured = secrets.get(family.ns) ?? new Map();
            if (section === cachedSection && configured === cachedSecrets && cachedOptions !== undefined) {
                return cachedOptions;
            }
            const groups = {};
            for (const key of family.keys) {
                const native = section.groups?.[key] ?? {};
                const hasKey = configured.has(key);
                groups[key] = {
                    ...native,
                    enabled: hasKey && native.enabled !== false,
                    apiKey: hasKey ? family.keyRef(key) : undefined,
                    apiKeys: []
                };
            }
            cachedOptions = resolveAdapterOptions({ ...section, groups }, family);
            cachedSection = section;
            cachedSecrets = configured;
            return cachedOptions;
        };
        /**
         * One live access token for a subscription login, refreshed when stale.
         *
         * A relay family reads the secret cached by `refreshCredentials`; an OAuth
         * subscription re-reads its record on every request, because an access
         * token expires silently between model calls.
         */
        const liveOAuthAccess = async () => {
            const vendor = subscriptionVendor(vendorId);
            if (vendor === undefined || credentialScope === undefined) {
                throw new LlmError(`${family.label}: no subscription login is configured`, "MISSING_CREDENTIAL");
            }
            let record;
            try {
                record = await resolveVendorCredential(credentialScope, vendor);
            } catch (error) {
                throw new LlmError(`${family.label}: ${error?.message ?? "credential unavailable"}`, "MISSING_CREDENTIAL");
            }
            if (record === undefined || record.needsReconnect === true) {
                throw new LlmError(`${family.label}: reconnect the subscription in Subscription Management`, "MISSING_CREDENTIAL");
            }
            try {
                const fresh = await ensureFreshOAuth(vendor, record, {
                    writeCredential: (next) => writeVendorCredential(credentialScope, vendor, next)
                });
                return fresh.access;
            } catch (error) {
                throw new LlmError(`${family.label}: ${error?.message ?? "OAuth token unavailable"}`, "MISSING_CREDENTIAL");
            }
        };
        const resolveApiKey = async (group) => {
            if (family.oauth === true) {
                const access = await liveOAuthAccess();
                recentGroups.set(vendorId, group.key);
                return access;
            }
            const value = secrets.get(family.ns)?.get(group.key);
            if (value === undefined) {
                throw new LlmError(
                    `${family.label}: no API key is configured for ${group.displayName}; save it in Subscription Management`,
                    "MISSING_CREDENTIAL"
                );
            }
            recentGroups.set(vendorId, group.key);
            return value;
        };
        const AdapterClass = OAUTH_ADAPTERS.get(family.ns) ?? SubscriptionAdapter;
        const adapter = new AdapterClass({
            options,
            resolveApiKey,
            resolveAttachments: () => ctx.get("attachments"),
            log: (message) => ctx.logger?.warn?.(message),
            // The Codex consumer backend identifies the account out of band; the
            // bearer token alone is not enough there.
            requestHeadersFor: () => {
                const accountId = oauthAccountIds.get(vendorId);
                return accountId === undefined ? {} : { "chatgpt-account-id": accountId };
            }
        });
        const telemetryHooks = {
            options,
            resolveApiKey,
            log: (message) => ctx.logger?.warn?.(message)
        };
        const telemetry = family.ns === "protocom-api"
            ? new BalanceService(telemetryHooks)
            : family.ns === "opencode-go"
                ? new GoUsageService(telemetryHooks)
                : family.ns === "commandcode"
                    ? new CommandCodeAccountService(telemetryHooks)
                    : undefined;
        states.set(family.ns, { family, vendorId, rawSection, options, adapter, telemetry, registration: undefined });
    }

    /** Marks an OAuth family as configured; the real token is read per request. */
    const OAUTH_SENTINEL = "oauth-login";

    const refreshCredentials = async () => {
        if (credentialScope === undefined) return;
        await Promise.all([...states.values()].map(async (state) => {
            const vendor = subscriptionVendor(state.vendorId);
            let record;
            try {
                record = vendor === undefined ? undefined : await resolveVendorCredential(credentialScope, vendor);
            } catch {
                // A CLI-linked file that moved must not break the whole sync.
                record = undefined;
            }
            if (state.family.oauth === true) {
                const accountId = record?.kind === "oauth" ? record.secret?.accountId : undefined;
                if (typeof accountId === "string" && accountId.length > 0) oauthAccountIds.set(state.vendorId, accountId);
                else oauthAccountIds.delete(state.vendorId);
            }
            const next = new Map();
            for (const key of state.family.keys) {
                const value = state.family.oauth === true
                    ? (record !== undefined && record.needsReconnect !== true && record.kind === "oauth" ? OAUTH_SENTINEL : undefined)
                    : secretFor(record, state.vendorId, key);
                if (value !== undefined) next.set(key, value);
            }
            const previous = secrets.get(state.family.ns) ?? new Map();
            if (sameSecretMap(previous, next)) return;
            secrets.set(state.family.ns, next);
            for (const key of state.family.keys) {
                if (!next.has(key)) configuredSignatures.delete(`${state.family.ns}:${key}`);
            }
            state.adapter.invalidateListings();
            state.telemetry?.invalidate();
        }));
    };

    const invalidateModels = () => {
        for (const state of states.values()) {
            state.adapter.invalidateListings();
            state.telemetry?.invalidate();
        }
    };

    const syncRoutes = () => {
        for (const state of states.values()) {
            let options;
            try {
                options = state.options();
            } catch (error) {
                ctx.logger?.warn?.(`dsh-subscription-management: ${state.family.ns} settings rejected: ${error?.message ?? error}`);
                continue;
            }
            const routes = [...options.groups.values()]
                .filter((group) => group.enabled)
                .map((group) => group.provider);
            if (state.registration === undefined) {
                if (routes.length > 0) state.registration = ctx.llm.registerAdapter(routes, state.adapter);
            } else {
                state.registration.replace(routes);
            }
        }
    };

    const sync = () => {
        if (syncPromise !== undefined) return syncPromise;
        const pending = (async () => {
            await refreshCredentials();
            syncRoutes();
        })().finally(() => {
            if (syncPromise === pending) syncPromise = undefined;
        });
        syncPromise = pending;
        return pending;
    };

    const fetchAuthorUsage = async (vendorId, requestedGroup, force = false) => {
        const state = [...states.values()].find((entry) => entry.vendorId === vendorId);
        if (state?.telemetry === undefined) throw new Error(`${vendorId} 没有作者提供的额度服务`);
        if (force) state.telemetry.invalidate();
        const options = state.options();
        const enabled = [...options.groups.values()].filter((group) => group.enabled);
        const group = enabled.find((entry) => entry.key === requestedGroup)
            ?? enabled.find((entry) => entry.key === recentGroups.get(vendorId))
            ?? enabled[0];
        if (group === undefined) throw new Error(`${state.family.label} 尚未配置可用分组`);
        const vendor = subscriptionVendor(vendorId);
        if (state.family.ns === "protocom-api") {
            return protocomUsageView(await state.telemetry.balance(group.key, true), vendor.groups?.find((entry) => entry.id === group.key), vendor);
        }
        if (state.family.ns === "opencode-go") {
            return openCodeUsageView(await state.telemetry.usage(), vendor);
        }
        return commandCodeUsageView(await state.telemetry.readCached(group), vendor);
    };

    const configureGroup = async (state, key) => {
        const secret = secrets.get(state.family.ns)?.get(key);
        if (secret === undefined) return;
        const signatureKey = `${state.family.ns}:${key}`;
        const signature = secretSignature(secret);
        if (configuredSignatures.get(signatureKey) === signature) return;
        const settings = ctx.get("settings");
        if (settings === undefined || typeof settings.mutate !== "function") return;
        const provider = state.family.providerOf(key);
        const models = await state.adapter.listModels(provider);
        const section = state.rawSection();
        const nativeGroup = section.groups?.[key] ?? {};
        const ops = [{ op: "set", path: ["providers", state.family.sectionKey, "groups", key, "enabled"], value: true }];
        if (!Array.isArray(nativeGroup.contextLengths) || nativeGroup.contextLengths.length === 0) {
            // Use the family's real ladder (a subscription login is not a 1M
            // relay); the relay families keep their original 1M default.
            const declared = state.family.defaults?.[key]?.contextLengths;
            ops.push({
                op: "set",
                path: ["providers", state.family.sectionKey, "groups", key, "contextLengths"],
                value: Array.isArray(declared) && declared.length > 0 ? [...declared] : [1_048_576]
            });
        }
        const existingVision = section.visionModels ?? {};
        const seen = new Set();
        for (const model of models) {
            const upstreamId = stripVariantId(model.id);
            if (seen.has(upstreamId)) continue;
            seen.add(upstreamId);
            if (model.inputModalities?.includes("image") && !Object.hasOwn(existingVision, upstreamId)) {
                ops.push({
                    op: "set",
                    path: ["providers", state.family.sectionKey, "visionModels", upstreamId],
                    value: true
                });
            }
        }
        // Reasoning efforts and their defaults are exposed by the author's
        // adapter per model; no invalid global effort is forced onto every model.
        await settings.mutate(SETTINGS_NS, ops);
        configuredSignatures.set(signatureKey, signature);
    };

    const configureAll = async (vendorId, requestedGroup) => {
        for (const state of states.values()) {
            if (vendorId !== undefined && state.vendorId !== vendorId) continue;
            // Only the provider runtime mounted by this plugin writes native
            // settings; official subscriptions keep their model setup manual.
            if (!vendorAllowsAutoModelSetup(subscriptionVendor(state.vendorId))) continue;
            for (const key of state.family.keys) {
                if (requestedGroup !== undefined && key !== requestedGroup) continue;
                try {
                    await configureGroup(state, key);
                } catch (error) {
                    ctx.logger?.warn?.(`dsh-subscription-management: native model setup failed for ${state.family.ns}/${key}: ${error?.message ?? error}`);
                }
            }
        }
    };

    ctx.effect(() => {
        const directory = ctx.llm.registerConfigurableProviders([...states.values()].flatMap((state) =>
            state.family.keys.map((key) => ({
                provider: state.family.providerOf(key),
                displayName: state.family.defaults[key]?.displayName ?? key,
                settingsNs: SETTINGS_NS,
                settingsPath: ["providers", state.family.sectionKey, "groups", key],
                defaultBaseURL: state.family.baseURL
            }))
        ));
        const discovery = ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request, signal) => {
            const state = states.get(familyForRequest(request, FAMILIES[0]).ns);
            if (state.family.listingIsMembership === false) return registryDiscovery(state.family);
            return discoverModels(request, signal, {
                baseURL: () => state.options().baseURL,
                resolveApiKey: async (provider) => {
                    const key = state.family.groupOf(provider);
                    return key === undefined ? undefined : secrets.get(state.family.ns)?.get(key);
                }
            });
        });
        const offVolatile = ctx.on("loader/volatile-update", () => {
            invalidateModels();
            void sync().catch((error) => ctx.logger?.warn?.(`dsh-subscription-management: route sync failed: ${error?.message ?? error}`));
        });
        return () => {
            offVolatile?.();
            discovery();
            directory();
            for (const state of states.values()) state.registration?.();
        };
    });

    return Object.freeze({
        async attach(scope) {
            credentialScope = scope;
            await sync();
            await configureAll();
        },
        sync,
        async completeAuthentication(vendorId, group) {
            await sync();
            await configureAll(vendorId, group);
        },
        /** True when this plugin is allowed to write native model settings. */
        allowsAutoModelSetup(vendorId) {
            return vendorAllowsAutoModelSetup(subscriptionVendor(vendorId));
        },
        fetchUsage: fetchAuthorUsage,
        currentGroup(vendorId) {
            return recentGroups.get(vendorId);
        },
        familyForProvider
    });
}
