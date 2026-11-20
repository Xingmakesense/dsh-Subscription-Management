/**
 * Subscription OAuth providers: Claude Pro/Max and ChatGPT/Codex.
 *
 * Those two subscriptions are sold as a LOGIN, not as an API key, so nothing in
 * DSH can turn them into models by itself. This plugin already owns the OAuth
 * credential, so it mounts the two routes and reuses the vendored runtime for
 * everything except authentication: the request serializers and the SSE
 * translators are shared, only the URL and the header set are
 * subscription-specific.
 *
 * RISK — read before enabling:
 * - Both routes are what the official CLI clients (Claude Code, Codex CLI) call
 *   with a consumer OAuth token. They are not documented public APIs for third
 *   party clients, may violate the provider's terms, and can change or be
 *   revoked without notice.
 * - The plugin only sends requests the user's own subscription authorizes; it
 *   never proxies, pools or shares a credential.
 * - A failure surfaces as a real error in the model call. Nothing is faked.
 *
 * Security: tokens are read per request from this plugin's credential store.
 * They are never logged, never persisted here, and never placed in a URL.
 */
import { EventSourceParserStream } from "eventsource-parser/stream";
import { LlmError } from "@deepseek-ai/dsh-llm";
import {
    ANTHROPIC_VERSION,
    ProtocomAdapter,
    serializeMessagesRequest,
    serializeResponsesRequest,
    translateMessages,
    translateResponses
} from "./protocom-api.js";

/** Claude Code stamps this exact prefix; the consumer OAuth grant is scoped to it. */
export const CLAUDE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Beta flags the official CLI negotiates for a consumer OAuth token. */
export const CLAUDE_OAUTH_BETAS = Object.freeze(["oauth-2025-04-20"]);
/** The CLI product string the backend fingerprints. */
export const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.280 (external, cli)";

export const CLAUDE_PROVIDER = "claude-subscription";
export const CODEX_PROVIDER = "codex-subscription";

const CLAUDE_CONTEXTS = Object.freeze([200_000, 1_000_000]);
const CODEX_CONTEXTS = Object.freeze([272_000]);

/**
 * Claude Pro/Max over the Messages wire.
 *
 * The base URL is the public Anthropic API root, so `/v1/messages` is already
 * the right path; only the auth headers, the beta flag and the mandatory
 * system-prompt identity block differ from an API-key route.
 */
export const CLAUDE_SUBSCRIPTION = Object.freeze({
    ns: "claude-subscription",
    label: "Claude Subscription",
    sectionKey: "claudeSubscription",
    baseURL: "https://api.anthropic.com",
    origin: "https://api.anthropic.com",
    oauth: true,
    protocol: "messages",
    credentialRef: /^[A-Z][A-Z0-9_]*$/u,
    keys: ["claude"],
    defaults: {
        claude: {
            displayName: "Claude Pro / Max",
            protocol: "messages",
            contextLengths: [...CLAUDE_CONTEXTS]
        }
    },
    providerOf: () => CLAUDE_PROVIDER,
    groupOf: (provider) => provider === CLAUDE_PROVIDER ? "claude" : undefined,
    keyRef: () => "CLAUDE_SUBSCRIPTION_OAUTH",
    recommended: ["claude-opus-5-5", "claude-sonnet-5-5"],
    // The consumer API has no dependable model listing (the CLI ships its own
    // table), so this catalog is the model menu.
    registry: [
        { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", contextWindow: 200_000, vision: true, groups: ["claude"], rank: 1,
            reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "high" } },
        { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", contextWindow: 200_000, vision: true, groups: ["claude"], rank: 2,
            reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "medium" } },
        { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", contextWindow: 200_000, vision: true, groups: ["claude"], rank: 3,
            reasoning: { efforts: ["low", "medium"], defaultEffort: "low" } },
        { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", contextWindow: 200_000, vision: true, groups: ["claude"], rank: 4,
            reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "high" } },
        { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", contextWindow: 200_000, vision: true, groups: ["claude"], rank: 5,
            reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "high" } },
        { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", contextWindow: 200_000, vision: true, groups: ["claude"], rank: 6,
            reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "medium" } },
        { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", contextWindow: 200_000, vision: true, groups: ["claude"], rank: 7 }
    ],
    refused: []
});

/**
 * ChatGPT Plus/Pro over the Codex Responses wire.
 *
 * The consumer backend answers `/backend-api/codex/responses`, which is not
 * `/v1/responses`, so this transport builds its URL from `family.chatURL`
 * instead of the vendored `baseURL/v1/path` rule.
 */
export const CODEX_SUBSCRIPTION = Object.freeze({
    ns: "codex-subscription",
    label: "Codex Subscription",
    sectionKey: "codexSubscription",
    baseURL: "https://chatgpt.com/backend-api/codex",
    origin: "https://chatgpt.com",
    oauth: true,
    protocol: "responses",
    chatURL: "https://chatgpt.com/backend-api/codex/responses",
    credentialRef: /^[A-Z][A-Z0-9_]*$/u,
    keys: ["codex"],
    defaults: {
        codex: {
            displayName: "ChatGPT Plus / Pro",
            protocol: "responses",
            contextLengths: [...CODEX_CONTEXTS]
        }
    },
    providerOf: () => CODEX_PROVIDER,
    groupOf: (provider) => provider === CODEX_PROVIDER ? "codex" : undefined,
    keyRef: () => "CODEX_SUBSCRIPTION_OAUTH",
    recommended: ["gpt-6-astra", "gpt-5.6-sol"],
    // The backend lists models behind `GET /models?client_version=`, which this
    // route cannot call; the catalog is the model menu.
    registry: [
        { id: "gpt-6-astra", displayName: "GPT-6 Astra", contextWindow: 272_000, vision: true, groups: ["codex"], rank: 1,
            reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "high" } },
        { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", contextWindow: 272_000, vision: true, groups: ["codex"], rank: 2,
            reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "medium" } },
        { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", contextWindow: 272_000, vision: true, groups: ["codex"], rank: 3 },
        { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", contextWindow: 272_000, vision: true, groups: ["codex"], rank: 4 },
        { id: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 272_000, vision: true, groups: ["codex"], rank: 5 },
        { id: "gpt-reserve", displayName: "GPT Reserve", contextWindow: 272_000, groups: ["codex"], rank: 6 }
    ],
    refused: []
});

/** Every subscription-OAuth family this plugin mounts. */
export const OAUTH_FAMILIES = Object.freeze([CLAUDE_SUBSCRIPTION, CODEX_SUBSCRIPTION]);

/** Read the SSE body with the streaming parser the client bundle already uses. */
async function* sseData(response) {
    if (response.body === null) throw new LlmError("subscription stream carried no body", "TRANSPORT");
    const events = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream({ maxBufferSize: 8 * 1024 * 1024 }));
    for await (const event of events) {
        if (event.data === "[DONE]") return;
        yield event.data;
    }
}

function failureFor(label, response, bodyText) {
    const detail = bodyText === undefined || bodyText.length === 0 ? "" : ` ${bodyText.slice(0, 200)}`;
    if (response.status === 401 || response.status === 403) {
        return new LlmError(`${label}: subscription login rejected (${response.status}); reconnect the vendor in Subscription Management.${detail}`,
            "AUTH", { status: response.status });
    }
    if (response.status === 429) {
        return new LlmError(`${label}: subscription quota or rate limit reached (${response.status}).${detail}`,
            "RATE_LIMIT", { status: response.status });
    }
    return new LlmError(`${label}: upstream rejected the request (${response.status}).${detail}`,
        "INVALID_REQUEST", { status: response.status });
}

/** POST one subscription request and stream its SSE body as harness chunks. */
async function* postSubscriptionStream(input) {
    let response;
    try {
        response = await fetch(input.url, {
            method: "POST",
            headers: input.headers,
            body: JSON.stringify(input.body),
            redirect: "error",
            ...(input.signal === undefined ? {} : { signal: input.signal })
        });
    } catch (error) {
        throw new LlmError(`${input.label}: network request failed`, "TRANSPORT", { cause: error });
    }
    if (!response.ok) {
        let detail;
        try {
            detail = (await response.text()).slice(0, 400);
        } catch {
            detail = undefined;
        }
        throw failureFor(input.label, response, detail);
    }
    yield* input.translate(sseData(response));
}

/**
 * The OAuth-enforced system prompt: a block array whose FIRST block is exactly
 * the Claude Code identity string. A plain string is refused since 2026-03, so
 * the serializer output is rewritten here rather than upstream.
 */
export function claudeSystemBlocks(serializedSystem) {
    const blocks = [{ type: "text", text: CLAUDE_SYSTEM_PREFIX, cache_control: { type: "ephemeral" } }];
    if (typeof serializedSystem === "string" && serializedSystem.trim().length > 0) {
        blocks.push({ type: "text", text: serializedSystem, cache_control: { type: "ephemeral" } });
    }
    return blocks;
}

/** Claude subscription transport: Messages wire with a consumer OAuth token. */
export class ClaudeSubscriptionAdapter extends ProtocomAdapter {
    /**
     * The consumer API has no dependable model listing for an OAuth grant (the
     * CLI ships its own table), so the catalog above is the model menu and no
     * listing request is made.
     */
    async upstreamModels() {
        return [];
    }

    async protocolCall(connection, options, group, model) {
        const { images, messages } = await this.resolveRequestImages(options, model);
        const projected = messages === options.messages ? options : { ...options, messages: [...messages] };
        const body = serializeMessagesRequest(projected, model, images);
        const { system: serializedSystem, ...rest } = body;
        const headers = {
            ...(connection.headers ?? {}),
            ...(this.config.requestHeadersFor?.(group) ?? {}),
            authorization: `Bearer ${connection.apiKey}`,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-beta": CLAUDE_OAUTH_BETAS.join(","),
            "user-agent": CLAUDE_CLI_USER_AGENT,
            "x-app": "cli",
            "content-type": "application/json",
            accept: "text/event-stream"
        };
        return postSubscriptionStream({
            label: this.family().label,
            // The official CLI reaches this wire through ?beta=true; the OAuth
            // grant is only honoured on that entry point.
            url: `${connection.baseURL.replace(/\/+$/u, "")}/v1/messages?beta=true`,
            headers,
            body: { ...rest, system: claudeSystemBlocks(serializedSystem) },
            signal: options.signal,
            translate: translateMessages
        });
    }
}

/**
 * Codex subscription transport: the Responses wire on the consumer backend.
 *
 * Same body shape as `/v1/responses`; the differences are the base URL, the
 * account header and the Codex-only request flags.
 */
export class CodexSubscriptionAdapter extends ProtocomAdapter {
    /** The consumer backend has no `/v1/models`; `registry` is authoritative. */
    async upstreamModels() {
        return [];
    }

    async protocolCall(connection, options, group, model) {
        const { images, messages } = await this.resolveRequestImages(options, model);
        const projected = messages === options.messages ? options : { ...options, messages: [...messages] };
        const body = serializeResponsesRequest(projected, model, images);
        const session = options.sessionId === undefined ? undefined : String(options.sessionId);
        const headers = {
            ...(connection.headers ?? {}),
            ...(this.config.requestHeadersFor?.(group) ?? {}),
            authorization: `Bearer ${connection.apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream",
            originator: "codex_cli_rs",
            "openai-beta": "responses=experimental",
            ...(session === undefined ? {} : { "session_id": session })
        };
        return postSubscriptionStream({
            label: this.family().label,
            url: this.family().chatURL,
            headers,
            body: {
                ...body,
                tool_choice: "auto",
                parallel_tool_calls: true,
                include: ["reasoning.encrypted_content"],
                ...(body.reasoning === undefined ? {} : { reasoning: { ...body.reasoning, summary: "auto" } })
            },
            signal: options.signal,
            translate: translateResponses
        });
    }
}

/** Family -> adapter class, so the runtime picks the right transport. */
export const OAUTH_ADAPTERS = Object.freeze(new Map([
    [CLAUDE_SUBSCRIPTION.ns, ClaudeSubscriptionAdapter],
    [CODEX_SUBSCRIPTION.ns, CodexSubscriptionAdapter]
]));

export const subscriptionOAuthTest = Object.freeze({
    CLAUDE_SYSTEM_PREFIX,
    CLAUDE_OAUTH_BETAS,
    CLAUDE_SUBSCRIPTION,
    CODEX_SUBSCRIPTION,
    OAUTH_FAMILIES,
    claudeSystemBlocks
});
