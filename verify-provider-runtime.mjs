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
// An unset group receives the family's declared context ladder (the relay
// families keep 1M as one of its rungs); only a family that declares nothing
// falls back to the plain 1M default.
assert.equal(writes.some((op) => op.path.at(-1) === "contextLengths"
    && Array.isArray(op.value) && op.value.length > 0 && op.value.includes(1_048_576)), true);
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

// Subscription-login providers: this plugin mounts Claude and Codex itself,
// speaking their own wires with the user's OAuth token. The fixtures assert the
// URL, the header set, the mandatory Claude system identity block, the Codex
// request flags, and that both streams translate into harness chunks.
{
    const CLAUDE_SSE = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join("");
    const CODEX_SSE = [
        'data: {"type":"response.created","response":{"id":"r1","model":"gpt-6-astra"}}\n\n',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"i1","type":"message","role":"assistant","content":[]}}\n\n',
        'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hel"}\n\n',
        'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"lo"}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"i1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}\n\n',
        'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}\n\n'
    ].join("");

    const oauthRequests = [];
    globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        oauthRequests.push({ url, headers: init.headers ?? {}, body: init.body });
        const body = url.includes("/v1/messages") ? CLAUDE_SSE : CODEX_SSE;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    const oauthStore = new Map([
        [vendorCredentialName("claude"), JSON.stringify({
            version: 1, kind: "oauth", source: "manual",
            secret: { access: "claude-token", refresh: "claude-refresh", expires: Date.now() + 3_600_000 }
        })],
        [vendorCredentialName("chatgpt"), JSON.stringify({
            version: 1, kind: "oauth", source: "manual",
            secret: { access: "codex-token", refresh: "codex-refresh", accountId: "account-fixture", expires: Date.now() + 3_600_000 }
        })]
    ]);
    const oauthScope = {
        credentials: {
            async resolve(ref) {
                const value = oauthStore.get(String(ref));
                return value === undefined ? undefined : { value };
            }
        }
    };
    const oauthWrites = [];
    const oauthDirectories = [];
    const oauthAdapters = [];
    const oauthCtx = {
        logger: { warn() {} },
        get(key) { return key === "settings" ? { async mutate(_ns, ops) { oauthWrites.push(...ops); } } : undefined; },
        effect(callback) { return callback(); },
        on() { return () => {}; },
        llm: {
            registerConfigurableProviders(entries) { oauthDirectories.push(...entries); return () => {}; },
            registerModelDiscovery() { return () => {}; },
            registerAdapter(routes, adapter) {
                const entry = { routes: [...routes], adapter };
                oauthAdapters.push(entry);
                const dispose = () => {};
                dispose.replace = (next) => { entry.routes = [...next]; };
                return dispose;
            }
        }
    };
    const oauthRuntime = installProviderRuntime(oauthCtx, () => ({ enabled: true, providers: {} }));
    await oauthRuntime.attach(oauthScope);

    assert.equal(oauthDirectories.some((entry) => entry.provider === "claude-subscription"), true,
        "the Claude subscription must be a configurable native provider");
    assert.equal(oauthDirectories.some((entry) => entry.provider === "codex-subscription"), true,
        "the Codex subscription must be a configurable native provider");
    assert.equal(oauthWrites.some((op) => op.path.join(".") === "providers.claudeSubscription.groups.claude.enabled" && op.value === true), true);
    assert.deepEqual(
        oauthWrites.find((op) => op.path.join(".") === "providers.claudeSubscription.groups.claude.contextLengths")?.value,
        [200_000, 1_000_000],
        "a subscription login gets its real context ladder, not the relay 1M default"
    );
    assert.deepEqual(
        oauthWrites.find((op) => op.path.join(".") === "providers.codexSubscription.groups.codex.contextLengths")?.value,
        [272_000]
    );

    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const readStream = async (provider, model) => {
        const entry = oauthAdapters.find((candidate) => candidate.routes.includes(provider));
        assert.ok(entry !== undefined, `${provider} adapter must be registered`);
        const types = [];
        let text = "";
        for await (const chunk of entry.adapter.stream({ provider, model, messages, system: "SYS", sessionId: "session-fixture" })) {
            types.push(chunk.type);
            if (typeof chunk.text === "string") text += chunk.text;
        }
        return { types, text, adapter: entry.adapter };
    };

    const claude = await readStream("claude-subscription", "claude-opus-5-5");
    assert.equal(claude.text, "hello");
    assert.deepEqual(claude.types, ["block-start", "text-delta", "text-delta", "block-end", "usage", "finish"]);
    const claudeRequest = oauthRequests.find((request) => request.url.includes("/v1/messages"));
    assert.equal(claudeRequest.url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(claudeRequest.headers.authorization, "Bearer claude-token");
    assert.equal(claudeRequest.headers["anthropic-version"], "2023-06-01");
    assert.equal(claudeRequest.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(claudeRequest.headers["x-api-key"], undefined,
        "a consumer OAuth token must not be sent as x-api-key");
    const claudeBody = JSON.parse(claudeRequest.body);
    assert.equal(Array.isArray(claudeBody.system), true, "the OAuth identity must be a system block array");
    assert.equal(claudeBody.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
    assert.equal(claudeBody.system[1].text, "SYS");
    assert.equal(claudeBody.stream, true);

    const codex = await readStream("codex-subscription", "gpt-6-astra");
    assert.equal(codex.text, "hello");
    assert.deepEqual(codex.types, ["block-start", "text-delta", "text-delta", "block-end", "usage", "finish"]);
    const codexRequest = oauthRequests.find((request) => request.url.includes("/backend-api/codex"));
    assert.equal(codexRequest.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(codexRequest.headers.authorization, "Bearer codex-token");
    assert.equal(codexRequest.headers["chatgpt-account-id"], "account-fixture",
        "the consumer backend identifies the account out of band");
    assert.equal(codexRequest.headers["openai-beta"], "responses=experimental");
    assert.equal(codexRequest.headers.session_id, "session-fixture");
    const codexBody = JSON.parse(codexRequest.body);
    assert.equal(codexBody.store, false);
    assert.equal(codexBody.stream, true);
    assert.equal(codexBody.tool_choice, "auto");
    assert.equal(codexBody.parallel_tool_calls, true);
    assert.deepEqual(codexBody.include, ["reasoning.encrypted_content"]);

    const claudeModels = await claude.adapter.listModels("claude-subscription");
    const codexModels = await codex.adapter.listModels("codex-subscription");
    assert.equal(claudeModels.length > 0, true, "the Claude catalog must offer models without a listing endpoint");
    assert.equal(codexModels.length > 0, true, "the Codex catalog must offer models without a listing endpoint");
    assert.equal(claudeModels.some((model) => model.id.startsWith("claude-opus-5-5")), true);
    assert.equal(codexModels.some((model) => model.id.startsWith("gpt-6-astra")), true);
    assert.equal(codexModels.every((model) => model.id.includes("ctx@undefined") === false), true,
        "no catalog entry may leak an undefined context variant");
}

console.log("provider runtime checks passed");
