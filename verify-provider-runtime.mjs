import assert from "node:assert/strict";
import { installProviderRuntime } from "./host/provider-runtime/index.js";
import { vendorCredentialName } from "./host/subscriptions/credentials.js";

const writes = [];
const adapters = [];
const directories = [];
const usageCalls = { models: 0, usage: 0 };
const resetAt = new Date(Date.now() + 3600_000).toISOString();

globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
        usageCalls.models += 1;
        return new Response(JSON.stringify({
            data: [{
                id: "test-model",
                displayName: "Test Model",
                contextWindow: 1_048_576,
                vision: true,
                reasoningEfforts: ["low", "high"]
            }]
        }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/v1/usage")) {
        usageCalls.usage += 1;
        return new Response(JSON.stringify({
            usage: {
                rolling: { percent: 25, resetsAt: resetAt },
                weekly: { percent: 50, resetsAt: resetAt },
                monthly: { percent: 75, resetsAt: resetAt }
            }
        }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fixture URL: ${url}`);
};

const store = new Map([
    [vendorCredentialName("opencode-go"), JSON.stringify({ version: 1, kind: "api-key", secret: "fixture-go", source: "manual" })],
    [vendorCredentialName("clinepass"), JSON.stringify({ version: 1, kind: "api-key", secret: "fixture-cline", source: "manual" })]
]);
const scope = {
    credentials: {
        async resolve(ref) {
            const value = store.get(String(ref));
            return value === undefined ? undefined : { value };
        }
    }
};
const settings = {
    async mutate(ns, ops) {
        assert.equal(ns, "dsh-subscription-management");
        writes.push(...ops);
    }
};
const ctx = {
    logger: { warn() {} },
    get(key) { return key === "settings" ? settings : undefined; },
    effect(callback) { return callback(); },
    on() { return () => {}; },
    llm: {
        registerConfigurableProviders(entries) {
            directories.push(...entries);
            return () => {};
        },
        registerModelDiscovery() { return () => {}; },
        registerAdapter(routes, adapter) {
            const entry = { routes: [...routes], adapter };
            adapters.push(entry);
            const dispose = () => {};
            dispose.replace = (next) => { entry.routes = [...next]; };
            return dispose;
        }
    }
};

const runtime = installProviderRuntime(ctx, () => ({ enabled: true, providers: {} }));
await runtime.attach(scope);

assert.equal(directories.some((entry) => entry.provider === "opencode-go-sub"), true);
assert.equal(directories.some((entry) => entry.provider === "clinepass"), true);
assert.equal(writes.some((op) => op.path.at(-1) === "enabled" && op.value === true), true);
assert.equal(writes.some((op) => op.path.at(-1) === "contextLengths" && op.value[0] === 1_048_576), true);
assert.equal(writes.some((op) => op.path.includes("visionModels") && op.value === true), true);

const go = adapters.find((entry) => entry.routes.includes("opencode-go-sub"));
assert.ok(go, "OpenCode Go adapter should be registered");
assert.equal(go.adapter.providerRetryPolicy().maxRetries, 0);
const model = await go.adapter.resolveModel("opencode-go-sub", "test-model::ctx@1048576");
assert.deepEqual(model.inputModalities, ["text", "image"]);
assert.deepEqual(model.reasoning.efforts.map((entry) => entry.id), ["low", "high"]);

const first = await runtime.fetchUsage("opencode-go");
assert.equal(first.limits[0].remainingPercent, 75);
const cached = await runtime.fetchUsage("opencode-go");
assert.equal(cached.limits[0].remainingPercent, 75);
assert.equal(usageCalls.usage, 1, "author cache should avoid a duplicate request");
await runtime.fetchUsage("opencode-go", undefined, true);
assert.equal(usageCalls.usage, 2, "force should invalidate the author cache");

// Protocom and Command Code use the author's services without model-discovery
// traffic when the native settings service is unavailable.
const telemetryCalls = new Map();
globalThis.fetch = async (input) => {
    const url = String(input);
    telemetryCalls.set(url, (telemetryCalls.get(url) ?? 0) + 1);
    if (url === "https://relay.protocom.org/v1/usage") {
        return new Response(JSON.stringify({
            planName: "Fixture Protocom",
            quota: { limit: 100, used: 25, remaining: 75 }
        }), { status: 200 });
    }
    if (url === "https://relay.protocom.org/v1/sub2api/billing") {
        return new Response(JSON.stringify({ resolved_rate_multiplier: 1.25 }), { status: 200 });
    }
    if (url === "https://api.commandcode.ai/alpha/billing/credits") {
        return new Response(JSON.stringify({
            credits: { monthlyCredits: 19.5 },
            windowLimits: {
                fiveHour: { used: 2, cap: 14, resetAt: Date.now() + 3600_000 },
                weekly: { used: 10, cap: 35, resetAt: Date.now() + 7200_000 }
            }
        }), { status: 200 });
    }
    if (url === "https://api.commandcode.ai/alpha/usage/summary") {
        return new Response(JSON.stringify({ totalCount: 8, totalCost: 1.5 }), { status: 200 });
    }
    throw new Error(`unexpected author telemetry URL: ${url}`);
};
const telemetryStore = new Map([
    [vendorCredentialName("protocom"), JSON.stringify({
        version: 1,
        kind: "api-key-groups",
        secret: { aggregate: "fixture-protocom" },
        source: "manual"
    })],
    [vendorCredentialName("commandcode"), JSON.stringify({ version: 1, kind: "api-key", secret: "fixture-command", source: "manual" })]
]);
const telemetryScope = {
    credentials: {
        async resolve(ref) {
            const value = telemetryStore.get(String(ref));
            return value === undefined ? undefined : { value };
        }
    }
};
const telemetryCtx = {
    logger: { warn() {} },
    get() { return undefined; },
    effect(callback) { return callback(); },
    on() { return () => {}; },
    llm: {
        registerConfigurableProviders() { return () => {}; },
        registerModelDiscovery() { return () => {}; },
        registerAdapter() {
            const dispose = () => {};
            dispose.replace = () => {};
            return dispose;
        }
    }
};
const telemetryRuntime = installProviderRuntime(telemetryCtx, () => ({ enabled: true, providers: {} }));
await telemetryRuntime.attach(telemetryScope);
const protocom = await telemetryRuntime.fetchUsage("protocom", "aggregate");
assert.equal(protocom.limits[0].remainingPercent, 75);
assert.equal(protocom.plan, "Fixture Protocom");
assert.equal(protocom.extraUsage.rateMultiplier, 1.25);
const command = await telemetryRuntime.fetchUsage("commandcode");
assert.equal(Math.round(command.limits[0].remainingPercent), 86);
assert.equal(command.extraUsage.monthlyCredits, 19.5);
assert.equal(command.extraUsage.periodCost, 1.5);
await telemetryRuntime.fetchUsage("commandcode");
assert.equal(telemetryCalls.get("https://api.commandcode.ai/alpha/billing/credits"), 1);
assert.equal(telemetryCalls.get("https://api.commandcode.ai/alpha/usage/summary"), 1);

console.log("provider runtime checks passed");
