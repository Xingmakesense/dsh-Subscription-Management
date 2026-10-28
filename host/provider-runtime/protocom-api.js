import { EMPTY_RESPONSE_CODE, IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, ToolCallId, assertUsableApiKey, attributionHeaders, contentHasImage, offloadedImageText, projectOffloadedImages, requiredImageOffload } from "@deepseek-ai/dsh-llm";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { requestImageDimensions } from "@deepseek-ai/dsh-attachment";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { EventSourceParserStream, ParseError } from "eventsource-parser/stream";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
//#region src/groups.ts
/** Protocom official API endpoint base. */
const DEFAULT_BASE_URL = "https://relay.protocom.org";
/** 1M-token context, the ceiling most current flagships publish. */
const CONTEXT_1M = 1048576;
/** 400K-token context. */
const CONTEXT_400K = 409600;
/** 256K-token context. */
const CONTEXT_256K = 262144;
/** 200K-token context: the floor every model this plugin serves clears. */
const CONTEXT_200K = 204800;
/**
* 100K-token context: the cheap-tier boundary Claude Haiku 5.5 is billed on,
* and the only rung in this file that exists for a PRICE rather than for a
* capacity.
*
* Haiku 5.5 costs 0.10 in / 0.50 out per MTok while a single request's input
* stays at or below 100,000 tokens — cache reads and writes included, output
* excluded — and 5x that (0.50 / 2.50) once it goes above. The threshold is
* per request and does not pro-rate, so a conversation that drifts over it
* silently changes what every later request costs.
*
* The number is deliberately the DECIMAL 100,000 rather than 102,400: the
* threshold is a token count in the vendor's own documentation, and a budget of
* 102,400 would sit 2.4% ABOVE the line it is meant to stay under.
*/
const CONTEXT_100K = 1e5;
/**
* The context ladder the picker offers, smallest first: 200K is the floor every
* model clears, then the two common steps, then the 1M ceiling. A model is only
* ever offered the steps at or below its own window, so the choice a user makes
* is always one the model can actually honour.
*/
const CONTEXT_LADDER = [
	CONTEXT_200K,
	CONTEXT_256K,
	CONTEXT_400K,
	CONTEXT_1M
];
/**
* Origin of {@link DEFAULT_BASE_URL}: the only origin a stored API key is sent
* to unless the deployment explicitly confirms a custom endpoint. Lives here,
* beside the group metadata, so the browser half can read it without pulling in
* the Host config's dependencies.
*/
const DEFAULT_BASE_URL_ORIGIN = new URL(DEFAULT_BASE_URL).origin;
/** The four groups this plugin serves; the config dict key IS the group. */
const GROUP_KEYS = [
	"aggregate",
	"codex",
	"stepfun",
	"grok"
];
/** Per-group shipped defaults. */
const GROUP_DEFAULTS = {
	aggregate: {
		displayName: "Protocom Aggregate",
		protocol: "chat-completions"
	},
	codex: {
		displayName: "Protocom Codex",
		protocol: "responses",
		reasoning: {
			efforts: [
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "medium"
		}
	},
	stepfun: {
		displayName: "Protocom StepFun",
		protocol: "responses",
		contextLengths: CONTEXT_LADDER,
		reasoning: {
			efforts: [
				"minimal",
				"low",
				"medium",
				"high"
			],
			defaultEffort: "medium"
		}
	},
	grok: {
		displayName: "Protocom Grok",
		protocol: "chat-completions",
		reasoning: {
			efforts: ["low", "high"],
			defaultEffort: "high"
		}
	}
};
/** The provider route one group registers under. */
function providerOf(key) {
	return `protocom-${key}`;
}
/** The group behind one provider route, or `undefined` for a foreign route. */
function groupOf(provider) {
	if (!provider.startsWith("protocom-")) return void 0;
	const key = provider.slice(9);
	return GROUP_KEYS.includes(key) ? key : void 0;
}
/** The conventional credential reference one group's API key is stored under. */
function defaultKeyRef(key) {
	return `PROTOCOM_${key.toUpperCase()}_API_KEY`;
}
//#endregion
//#region src/context-variants.ts
/**
* Context-variant id codec. A variant entry's model id is
* `<upstreamId>::ctx@<tokens>`; the suffix rides through the harness as an
* opaque model id and is stripped back to the upstream id at dispatch.
*
* @module dsh-protocom-api/context-variants
*/
const MARKER = "::ctx@";
/** Encode one upstream id and context length into a variant model id. */
function encodeVariantId(upstreamId, tokens) {
	return `${upstreamId}${MARKER}${tokens}`;
}
/**
* Split one model id into its upstream id and variant length. An absent or
* malformed suffix (non-numeric, non-positive) means "no variant": the whole
* id is the upstream id, so a literal marker inside an upstream id cannot
* corrupt dispatch.
*/
function decodeVariantId(id) {
	const at = id.lastIndexOf(MARKER);
	if (at === -1) return { upstreamId: id };
	const tokens = Number(id.slice(at + 6));
	if (!Number.isSafeInteger(tokens) || tokens <= 0) return { upstreamId: id };
	return {
		upstreamId: id.slice(0, at),
		contextWindow: tokens
	};
}
/** The upstream id a request must name, whatever variant suffix arrived. */
function stripVariantId(id) {
	return decodeVariantId(id).upstreamId;
}
/**
* How far apart two lengths may be and still name the same budget.
*
* Providers publish the same capacity in two bases -- 200K is 204800 binary or
* 200000 decimal, 1M is 1048576 or 1000000 -- and the gap grows with the
* square of the radix ratio: 1024/1000 = 2.4% at the K scale, (1024/1000)^2 =
* 4.86% at the M scale. Eight percent covers both with margin.
*
* The band is unambiguous because every shipped ladder spaces its rungs far
* wider: 200K to 256K is 28%, 256K to 400K is 56%, 400K to 1M is 156%. There is
* no value that could match two rungs.
*/
const SAME_BUDGET_TOLERANCE = .08;
/**
* Whether a model's capacity falls within the ceiling a ladder sets.
*
* The ladder's top rung is the deployment's ceiling for that group. A model may
* always be used at its own capacity while that capacity is at or below the
* ceiling; a ladder that deliberately stops BELOW a model's window is how a
* deployment caps a group, and is not overridden.
*
* This is what separates the two cases that look alike. A group offering up to
* 1M must be able to use a 1M model at 1M, whatever base the model states it
* in. A group offering only 256K has said so on purpose, and a 1M model there
* stays at 256K.
* @param contextWindow - the model's own declared capacity.
* @param configured - the group's ladder.
* @returns whether the window is within what the ladder allows.
*/
function withinLadderCeiling(contextWindow, configured) {
	if (configured === void 0 || configured.length === 0) return true;
	return contextWindow <= Math.max(...configured) * 1.08;
}
/** Whether two lengths name the same budget, allowing for the two bases. */
function sameBudget(left, right) {
	const smaller = Math.min(left, right);
	if (smaller <= 0) return left === right;
	return Math.abs(left - right) / smaller <= SAME_BUDGET_TOLERANCE;
}
/**
* The variant lengths to advertise for one model, or `undefined` for the
* single default entry with a bare id. Configuration is the switch: without
* `contextLengths` the model lists exactly as before variants existed. With
* it, registry-known models are matched against the configured rungs (an empty
* match degrades to the default entry rather than hiding the model); unknown
* models take the configured lengths directly.
*
* Two things about the matching are deliberate:
*
*  - **By budget, not by exact integer.** Matching `configured.includes(length)`
*    meant a model declaring 1,000,000 could never match a 1,048,576 rung, so
*    its own window was silently dropped and it was offered only the rungs
*    below it. Every OpenCode Go model with a decimal window was capped that
*    way while the binary ones -- Kimi K3 at 1,048,576 -- kept their 1M, which
*    is precisely how the menu looked broken for some models and not others.
*
*  - **The MODEL's figure is emitted, not the configured one.** They can differ
*    by up to the tolerance, and the model's own number is the only one it can
*    actually honour. Advertising the rung instead is how a model ends up
*    promised a window it does not have.
*/
function variantLengths(contextOptions, configured) {
	if (configured === void 0 || configured.length === 0) return void 0;
	if (contextOptions === void 0) return [...new Set(configured)].sort((a, b) => a - b);
	const matched = contextOptions.filter((option) => configured.some((rung) => sameBudget(rung, option)));
	return matched.length === 0 ? void 0 : [...new Set(matched)].sort((a, b) => a - b);
}
//#endregion
//#region src/model-registry.ts
/**
* The hand-maintained model registry: display names, context capacities,
* vision support, and reasoning vocabularies for the models the Protocom
* official API serves, keyed by upstream model id. The registry — not the
* endpoint's listing — is the catalog of record: every entry is offered even
* while the listing omits it, so a shrinking or flaky listing cannot silently
* empty the model menu. Ids the registry does not know still ride along from
* the listing, with the endpoint's own display name and the fallback context
* window.
*
* The endpoint discloses only `id`, `object`, `created`, `owned_by`, `type`,
* and `display_name` — no context, modality, or reasoning metadata exists on
* the wire — so every fact below is hand-maintained from the serving model's
* own published specification and verified against the endpoint.
*
* @module dsh-protocom-api/model-registry
*/
/**
* The wire protocol a gateway-declared endpoint list implies, or undefined when
* the list names none this plugin can speak.
*
* Preference order is chat-completions, then responses, then messages: a model
* offered on several surfaces is served on the first one this plugin has the
* richest, best-tested support for, and only a model that declares NO OpenAI
* surface falls through to the Anthropic wire.
* @param endpoints - the gateway's own `supported_endpoints` list.
* @returns the protocol to use, or undefined when nothing here can serve it.
*/
function protocolForEndpoints(endpoints) {
	if (endpoints === void 0 || endpoints.length === 0) return void 0;
	if (endpoints.includes("/chat/completions")) return "chat-completions";
	if (endpoints.includes("/responses")) return "responses";
	if (endpoints.includes("/messages")) return "messages";
}
/**
* Whether a model is servable at all on the endpoint's own declared surfaces.
*
* This is the honesty gate for a family whose gateway publishes
* `supported_endpoints`: a model advertising only a wire this plugin does not
* implement is EXCLUDED rather than listed. Listing it would be worse than
* useless — every call fails with a 400 that looks like a plugin bug rather
* than a missing capability.
*
* All three wires a gateway can declare are implemented, so the gate is now
* exactly "does any declared surface map to a protocol". `messages` used to be
* excluded here because the adapter refused it at dispatch; the Anthropic wire
* is implemented, and excluding it now would hide the models that need it —
* every Claude id on Command Code and `claude-haiku-5-5` on OpenCode Go declare
* `/messages` and nothing else.
* @param model - the upstream row, endpoints included.
* @returns whether at least one declared endpoint maps to a supported wire.
*/
function servesDeclaredEndpoints(model) {
	if (model.endpoints === void 0 || model.endpoints.length === 0) return true;
	return protocolForEndpoints(model.endpoints) !== void 0;
}
/**
* Context capacity assumed for a model neither the registry nor the endpoint
* sizes. It is the ladder floor, not a smaller "safe" number: assuming less
* than the floor produced a single 128K entry for every unknown model — a
* choice no model served by this endpoint can honour, and a residue of the
* registry's original global-catalog design.
*/
const FALLBACK_CONTEXT_WINDOW = CONTEXT_200K;
/**
* The reasoning vocabulary shared by the GLM-5.2/5.3 generation. GLM refuses
* `thinking: {type: "disabled"}`, so `off` is deliberately absent: every
* effort here keeps thinking enabled and varies its budget.
*/
const GLM_REASONING = {
	efforts: [
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	defaultEffort: "high"
};
/** The reasoning vocabulary shared by the GPT-5.6 generation. */
const GPT_REASONING = {
	efforts: [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	defaultEffort: "medium"
};
/**
* The relay's full seven-level vocabulary, for a model PROBED against all of
* them (2026-10-01) rather than assumed to have them.
*
* Eight registry entries carried no vocabulary at all, and that is exactly what
* removed the Effort submenu from them: with nothing declared the picker has no
* levels to offer, so the models had no thinking control. Each was probed level
* by level, and every model using this constant answered 200 across the set.
* The relay's own error text enumerates the same seven when handed a bad value.
*
* Relay-scoped, like GLM_REASONING and GPT_REASONING above, and deliberately
* not shared with GO_FULL_REASONING: the relay spells the disabling word
* `none` and answers 400 to `off`, while the Go gateway is the exact reverse.
*/
const FULL_REASONING = {
	efforts: [
		"none",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	defaultEffort: "high"
};
/**
* The ladder steps one model can offer.
*
* A rung is offered when it is no larger than the model's window, and the
* model's OWN window is always offered as a final rung. Both halves matter:
*
*  - Without the second, a model whose window falls between two rungs loses
*    its ceiling. The ladder is binary (1,048,576) while providers publish
*    decimal figures, so a 1,000,000-token model used to top out at 400K --
*    24 of the 41 Go entries could never be offered their own window, and a
*    500,000-token model could never be offered more than 400K either.
*
*  - The window is added once and sorted, so a model that IS a rung does not
*    list it twice.
* @param contextWindow - the model's declared capacity.
* @returns the offered lengths, smallest first.
*/
function contextChoicesFor(contextWindow) {
	return [...CONTEXT_LADDER.filter((length) => length < contextWindow), contextWindow].sort((left, right) => left - right);
}
/**
* The initial registry. Order is presentation order, but the adapter re-sorts
* by {@link RegistryEntry.rank} so the recommended models lead the menu.
*/
const REGISTRY = [
	{
		id: "kimi-k3",
		displayName: "Kimi K3",
		family: "kimi",
		contextWindow: CONTEXT_256K,
		reasoning: {
			efforts: [
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "high"
		},
		vision: true,
		rank: 1
	},
	{
		id: "glm-5.2",
		displayName: "GLM-5.2",
		family: "glm",
		contextWindow: CONTEXT_1M,
		reasoning: GLM_REASONING,
		vision: false,
		rank: 2
	},
	{
		id: "mimo-v2.5",
		displayName: "MiMo V2.5",
		family: "mimo",
		contextWindow: CONTEXT_1M,
		reasoning: {
			efforts: [
				"none",
				"low",
				"medium",
				"high"
			],
			defaultEffort: "high"
		},
		vision: true,
		rank: 3
	},
	{
		id: "deepseek/deepseek-v4.1-flash",
		displayName: "DeepSeek V4.1 Flash",
		family: "deepseek",
		contextWindow: CONTEXT_1M,
		reasoning: {
			efforts: [
				"none",
				"low",
				"high",
				"max"
			],
			defaultEffort: "none"
		},
		vision: true
	},
	{
		id: "deepseek-v4.1-flash",
		displayName: "DeepSeek V4.1 Flash",
		family: "deepseek",
		contextWindow: CONTEXT_1M,
		reasoning: {
			efforts: [
				"none",
				"low",
				"high",
				"max"
			],
			defaultEffort: "none"
		},
		vision: true
	},
	{
		id: "moonshotai/Kimi-K2.7-Code",
		displayName: "Kimi K2.7 Code",
		family: "kimi",
		contextWindow: CONTEXT_256K,
		reasoning: {
			efforts: [
				"none",
				"minimal",
				"low",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "low"
		},
		vision: true
	},
	{
		id: "zai-org/GLM-5.2",
		displayName: "GLM-5.2",
		family: "glm",
		contextWindow: CONTEXT_1M,
		reasoning: GLM_REASONING,
		vision: false,
		identity: "zai-org/GLM-5.2"
	},
	{
		id: "glm-5.3",
		displayName: "GLM-5.3",
		family: "glm",
		contextWindow: CONTEXT_1M,
		reasoning: GLM_REASONING,
		vision: false
	},
	{
		id: "z-ai/glm-5.3-flash",
		displayName: "GLM-5.3 Flash",
		family: "glm",
		contextWindow: CONTEXT_1M,
		reasoning: GLM_REASONING,
		vision: true
	},
	{
		id: "z-ai/glm-5.3-flashx",
		displayName: "GLM-5.3 FlashX",
		family: "glm",
		contextWindow: CONTEXT_1M,
		reasoning: GLM_REASONING,
		vision: true
	},
	{
		id: "Qwen/Qwen3.8-27B",
		displayName: "Qwen3.8 27B",
		family: "qwen",
		contextWindow: CONTEXT_1M,
		reasoning: FULL_REASONING,
		vision: true
	},
	{
		id: "qwen3.8-max",
		displayName: "Qwen3.8 Max",
		family: "qwen",
		contextWindow: CONTEXT_1M
	},
	{
		id: "Qwen/Qwen3.7-Flash",
		displayName: "Qwen3.7 Flash",
		family: "qwen",
		contextWindow: CONTEXT_256K,
		reasoning: FULL_REASONING,
		vision: true
	},
	{
		id: "Qwen/Qwen3.8-Omni-Flash",
		displayName: "Qwen3.8 Omni Flash",
		family: "qwen",
		contextWindow: CONTEXT_1M,
		reasoning: FULL_REASONING,
		vision: true
	},
	{
		id: "MiniMaxAI/MiniMax-M3",
		displayName: "MiniMax M3",
		family: "minimax",
		contextWindow: CONTEXT_1M,
		reasoning: {
			efforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "high"
		},
		vision: true
	},
	{
		id: "mimo-v2.5-pro",
		displayName: "MiMo V2.5 Pro",
		family: "mimo",
		contextWindow: CONTEXT_1M,
		reasoning: {
			efforts: [
				"none",
				"low",
				"medium",
				"high"
			],
			defaultEffort: "high"
		},
		vision: false
	},
	{
		id: "google/gemini-3.8-flash",
		displayName: "Gemini 3.8 Flash",
		family: "gemini",
		contextWindow: CONTEXT_1M,
		reasoning: FULL_REASONING,
		vision: true
	},
	{
		id: "gpt-5.6-sol",
		displayName: "GPT-5.6 Sol",
		family: "gpt",
		contextWindow: CONTEXT_1M,
		reasoning: GPT_REASONING,
		vision: true,
		groups: ["codex"]
	},
	{
		id: "gpt-5.6-luna",
		displayName: "GPT-5.6 Luna",
		family: "gpt",
		contextWindow: CONTEXT_1M,
		reasoning: GPT_REASONING,
		vision: true,
		groups: ["codex"]
	},
	{
		id: "step-5-preview",
		displayName: "Step 5 Preview",
		family: "step",
		contextWindow: CONTEXT_1M,
		vision: true,
		groups: ["stepfun"]
	},
	{
		id: "google/gemini-3.7-flash",
		displayName: "Gemini 3.7 Flash",
		family: "gemini",
		contextWindow: CONTEXT_1M,
		vision: true
	},
	{
		id: "tencent/hy4-preview",
		displayName: "HY-4 Preview",
		family: "hunyuan",
		contextWindow: CONTEXT_256K
	},
	{
		id: "inclusionai/ling-3.0-flash-sante:free",
		displayName: "Ling 3.0 Flash Sante",
		family: "inclusionai",
		contextWindow: CONTEXT_256K
	},
	{
		id: "Qwen/Qwen3.8-Flash",
		displayName: "Qwen3.8 Flash",
		family: "qwen",
		contextWindow: CONTEXT_1M,
		vision: true
	},
	{
		id: "tencent/hy3-paid",
		displayName: "HY-3",
		family: "hunyuan",
		contextWindow: CONTEXT_256K,
		reasoning: FULL_REASONING
	},
	{
		id: "meituan/LongCat-2.0:free",
		displayName: "LongCat 2.0",
		family: "longcat",
		contextWindow: CONTEXT_256K
	},
	{
		id: "poolside/laguna-s-2.1-free",
		displayName: "Laguna S 2.1 Free",
		family: "poolside",
		contextWindow: CONTEXT_256K,
		reasoning: FULL_REASONING
	},
	{
		id: "meta/muse-spark-1.3-contributor",
		displayName: "Muse Spark 1.3 Contributor",
		family: "meta",
		contextWindow: CONTEXT_1M,
		reasoning: FULL_REASONING,
		vision: true
	},
	{
		id: "mimo-v2.6-flash",
		displayName: "MiMo V2.6 Flash",
		family: "mimo",
		contextWindow: CONTEXT_1M,
		reasoning: FULL_REASONING,
		vision: true
	},
	{
		id: "mimo-v2.6-pro",
		displayName: "MiMo V2.6 Pro",
		family: "mimo",
		contextWindow: CONTEXT_1M,
		reasoning: FULL_REASONING,
		vision: true
	},
	{
		id: "xiaomi/mimo-v2.6-flash",
		displayName: "MiMo V2.6 Flash",
		family: "mimo",
		contextWindow: CONTEXT_1M,
		reasoning: FULL_REASONING,
		vision: true
	},
	{
		id: "xiaomi/mimo-v2.6-pro-ultraspeed",
		displayName: "MiMo V2.6 Pro Ultraspeed",
		family: "mimo",
		contextWindow: CONTEXT_1M,
		reasoning: FULL_REASONING,
		vision: true
	},
	{
		id: "gpt-6-luna",
		displayName: "GPT-6 Luna",
		family: "gpt",
		contextWindow: 105e4,
		reasoning: FULL_REASONING,
		vision: true,
		protocol: "responses"
	}
];
/** Find the registry entry for one upstream id. */
function matchRegistry(id, registry = REGISTRY) {
	return registry.find((entry) => entry.id === id);
}
/** Whether one registry entry is a membership source for a group. */
function servesGroup(entry, key) {
	return entry.groups?.includes(key) === true;
}
/**
* Ids a listing advertises but the endpoint cannot serve a chat turn for,
* verified by request. Two kinds live here, because both produce the same
* defect -- a menu entry whose every use ends in an error:
*
* - **Refused on this route only.** StepFun's audio and image-editing models
*   answer 404 "the model ... does not exist or you do not have access to it",
*   and the two Step-3.5 snapshots answer 400 "this model is not enabled for
*   the Responses API". Verified with the StepFun credential against both
*   /v1/chat/completions and /v1/responses.
* - **Refused on every route.** Four aggregate ids answer 400 "Model X is not
*   available on this endpoint. Call it on /provider/v1/chat/completions
*   instead." on both routes. That named path is not a usable API on this
*   relay -- it answers a Cloudflare 525 SSL-handshake-failed HTML page, or
*   HTML with HTTP 200 -- so there is nothing the adapter could route to.
*
* A listing is an advertisement, not a promise: eight of the eleven ids one
* StepFun key lists and four of the twenty-six an aggregate key lists cannot
* serve a turn at all, and a menu entry whose every use ends in an error is
* the defect this catalog exists to remove. They are listed here rather than
* dropped silently -- the settings panel names them "endpoint does not serve"
* -- and a model the endpoint starts serving again is one line away from the
* menu.
*
* Every id below was re-verified by live request on the release that added it;
* no entry is inferred from documentation.
*/
const REFUSED_CHAT_MODEL_IDS = [
	"step-3.5-flash",
	"step-3.5-flash-2603",
	"step-explore",
	"step-image-edit-2",
	"stepaudio-2.5-asr",
	"stepaudio-2.5-chat",
	"stepaudio-2.5-realtime",
	"stepaudio-2.5-tts",
	"Qwen/Qwen3.8-Flash",
	"google/gemini-3.7-flash",
	"tencent/hy4-preview",
	"inclusionai/ling-3.0-flash-sante:free",
	"meituan/LongCat-2.0",
	"mimo-v2.5",
	"mimo-v2.5-pro",
	"meituan/LongCat-2.0:free"
];
/** Whether the endpoint's chat route answers for one upstream id. */
function servesChat(id, refused = REFUSED_CHAT_MODEL_IDS) {
	return !refused.includes(id);
}
/**
* Whether one model accepts image input, after the deployment's own choice.
*
* Resolution order is explicit setting, then the registry's verified verdict,
* then permissive: the endpoint — not this registry — is the authority on a
* model's modality and discloses none, so the registry can only ever be
* incomplete. A wrong "no" makes a documented capability unreachable for every
* deployment at once; a wrong "yes" costs one upstream error that names the
* model. `vision: false` stays the way to say "verified text-only".
* @param id - upstream model id, alias resolved through {@link identityKey}.
* @param declared - the deployment's per-model choices.
*/
function acceptsImages(id, declared, registry = REGISTRY) {
	const chosen = declared?.get(identityKey(id, registry));
	if (chosen !== void 0) return chosen;
	return matchRegistry(id, registry)?.vision !== false;
}
/**
* The models the plugin recommends out of the box: the ones whose reasoning
* content actually streams from this endpoint, in preference order. A
* deployment overrides the list through the `recommendedModels` setting; it
* only ever orders the menu, so a model left off it stays fully selectable.
*/
const DEFAULT_RECOMMENDED = REGISTRY.filter((entry) => entry.rank !== void 0 && servesChat(entry.id)).slice().sort((left, right) => left.rank - right.rank).map((entry) => entry.id);
/**
* The identity key of one upstream id: the first registry id of the model it
* belongs to. Aliases of one model share a key, so a recommendation or a
* visibility choice made against either id applies to both.
*
* An entry that declares its own {@link RegistryEntry.identity} opts out of the
* name join entirely, and no name group may absorb it either -- otherwise the
* opt-out would only work in one direction, and a choice made on the OTHER id
* would still land on both.
*/
function identityKey(id, registry = REGISTRY) {
	const entry = matchRegistry(id, registry);
	if (entry === void 0) return id;
	if (entry.identity !== void 0) return entry.identity;
	return registry.find((candidate) => candidate.displayName === entry.displayName && candidate.identity === void 0)?.id ?? id;
}
/**
* Collapse the registry into one row per identity, in registry order.
*
* Keyed by {@link identityKey} rather than by display name, so an entry that
* opts out of the name join stays its own row. Grouping by name here would
* re-merge exactly the pair an opt-out exists to separate, and every count
* derived from this list would disagree with the menu it describes.
*/
function modelIdentities(registry = REGISTRY) {
	const byIdentity = /* @__PURE__ */ new Map();
	for (const entry of registry) {
		const identity = identityKey(entry.id, registry);
		const hit = byIdentity.get(identity);
		if (hit === void 0) byIdentity.set(identity, {
			entry,
			ids: [entry.id]
		});
		else hit.ids.push(entry.id);
	}
	return [...byIdentity.values()].map(({ entry, ids }) => ({
		displayName: entry.displayName,
		ids,
		entry
	}));
}
/** Short capacity label: 128K, 256K, 512K, 1M. */
function contextLabel(tokens) {
	if (tokens === 1e5) return "100K (dec)";
	if (tokens === 1e6) return "1M (dec)";
	if (tokens % 1048576 === 0) return `${tokens / 1048576}M`;
	return `${Math.round(tokens / 1024)}K`;
}
/** Selector name for one entry at one context length: `{displayName} [{label}]`. */
function displayNameWithContext(displayName, tokens) {
	return `${displayName} [${contextLabel(tokens)}]`;
}
/**
* Project one discovered upstream model into catalog form. Registry entries
* win on every field they declare; unknown ids keep the endpoint's own
* display name when it adds information over the raw id. Reasoning metadata
* resolves registry first, then endpoint-disclosed effort lists, then the
* group's own default vocabulary.
* @param upstream - one listing row, or a hand-built row for a registry entry.
* @param groupReasoning - the group's own vocabulary, used when nothing else declares one.
* @param declaredVision - the deployment's per-model image capability.
* @returns the model as the menu presents it.
*/
function catalogEntry(upstream, groupReasoning, declaredVision, registry = REGISTRY) {
	const entry = matchRegistry(upstream.id, registry);
	const disclosed = upstream.reasoningEfforts !== void 0 && upstream.reasoningEfforts.length > 0 ? {
		efforts: upstream.reasoningEfforts,
		defaultEffort: upstream.reasoningEfforts.includes("high") ? "high" : upstream.reasoningEfforts[0]
	} : void 0;
	const reasoning = entry?.reasoning ?? disclosed ?? groupReasoning;
	if (entry === void 0) return {
		upstreamId: upstream.id,
		displayName: upstream.displayName !== void 0 && upstream.displayName !== upstream.id ? upstream.displayName : upstream.id,
		contextWindow: upstream.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
		...upstream.contextWindow === void 0 ? {} : { contextWindowDisclosed: true },
		...reasoning === void 0 ? {} : { reasoning },
		vision: declaredVision?.get(identityKey(upstream.id, registry)) ?? upstream.vision ?? acceptsImages(upstream.id, void 0, registry),
		rank: Number.MAX_SAFE_INTEGER
	};
	return {
		upstreamId: upstream.id,
		displayName: entry.displayName,
		contextWindow: entry.contextWindow,
		contextOptions: contextChoicesFor(entry.contextWindow),
		...entry.contextLengths === void 0 ? {} : { contextLengths: entry.contextLengths },
		...reasoning === void 0 ? {} : { reasoning },
		vision: declaredVision?.get(identityKey(upstream.id, registry)) ?? upstream.vision ?? acceptsImages(upstream.id, void 0, registry),
		rank: entry.rank ?? Number.MAX_SAFE_INTEGER
	};
}
/**
* The context variants one model should be offered, under a group's ladder.
*
* One expression evaluated by the adapter that mints a group's menu entries AND
* by the settings row that draws the chips, so the two cannot disagree — the
* defect that made a row show a single pressed chip which refused every click.
*
* Three inputs, in order of authority:
*
*  1. a per-model choice the deployment stored, when this model has one,
*  2. the group's ladder, when it has one,
*  3. nothing at all — which offers the model once under its bare id — EXCEPT
*     for a model declaring its own rungs, see below.
*
* The group ladder is the switch, not merely a filter: with no `contextLengths`
* configured a model lists once under its bare id, which is the shape most
* deployments run and the historical one. A model whose entry declares
* {@link RegistryEntry.contextLengths} is the one exception, and it exists
* because those rungs are not interchangeable cap sizes but different PRICES
* (Haiku 5.5's 100K): offering only the bare id there would hide the choice the
* entry exists to expose.
*
* A declared rung is screened by the group's CEILING rather than by rung
* matching, which is what keeps a deployment's deliberate cap authoritative
* while sparing every operator from having to name a model's price boundary in
* their own ladder.
* @param model - the projected row.
* @param ladder - the group's effective ladder.
* @param chosen - the deployment's stored per-model choice for this identity.
* @returns the lengths to offer, or undefined for a single bare-id entry.
*/
function contextVariantsFor(model, ladder, chosen) {
	if (chosen !== void 0 && chosen.length > 0) {
		const allowed = chosen.filter((length) => length <= model.contextWindow);
		return allowed.length > 0 ? [...new Set(allowed)].sort((left, right) => left - right) : void 0;
	}
	const declared = (model.contextLengths ?? []).filter((length) => withinLadderCeiling(length, ladder));
	if (ladder === void 0 || ladder.length === 0) return declared.length === 0 ? void 0 : [...new Set(declared)].sort((left, right) => left - right);
	const offered = contextStepsFor(model, ladder);
	return [.../* @__PURE__ */ new Set([...offered, ...declared])].sort((left, right) => left - right);
}
/**
* The context steps one model may be offered.
*
* One expression, evaluated by both the adapter that mints menu entries and the
* settings row that draws the chips, so the two cannot disagree -- the defect
* that made a row show a single pressed chip which refused every click.
*
* Three inputs, in order of authority:
*
*  1. the registry's own options for a model it sizes,
*  2. the endpoint's DISCLOSED length, when it publishes one per row,
*  3. the group ladder unfiltered, when nothing but this plugin's assumption
*     bounds the model.
*
* The distinction in (2) and (3) is load-bearing rather than pedantic. Command
* Code publishes `context_length` on every row, so a step above it is an entry
* the model cannot honour: a 256K model was offered 400K and 1M. StepFun
* publishes nothing, and its uncurated ids carry only a floor guess, so the same
* filtering there would hide steps those models serve.
* @param model - the projected row.
* @param ladder - the group's effective ladder.
* @returns the steps to offer, never empty.
*/
function contextStepsFor(model, ladder) {
	if (model.contextOptions !== void 0) {
		const matched = variantLengths(model.contextOptions, ladder) ?? [];
		const steps = withinLadderCeiling(model.contextWindow, ladder) ? [.../* @__PURE__ */ new Set([...matched, model.contextWindow])] : [...new Set(matched)];
		return steps.length > 0 ? steps.sort((left, right) => left - right) : [model.contextWindow];
	}
	if (ladder === void 0 || ladder.length === 0) return [model.contextWindow];
	const allowed = model.contextWindowDisclosed === true ? ladder.filter((length) => length <= model.contextWindow) : [...ladder];
	return allowed.length > 0 ? allowed : [model.contextWindow];
}
/**
* One group's own model menu: the models that group's menu offers, in the
* order the menu renders them. Membership is the group's live listing — the
* credential scopes what the route serves — plus the registry entries tagged
* for that group, so a group's menu holds its own models instead of every
* group's and a model the endpoint starts listing appears without a plugin
* release. Ids the endpoint refuses on its chat route never appear
* ({`link servesChat}). A missing or empty listing falls back to the whole
* registry, so a degraded endpoint cannot empty the menu.
*
* The adapter's `listModels` and the settings panel's per-group model editor
* both project through here, so the list a user configures cannot drift from
* the list the picker shows.
* `param key - the group whose catalog is projected.
* `param listing - that group's live listing, or `undefined` when unreachable.
* `param options - the deployment's visibility, ordering, and modality choices.
* `returns one row per model identity, in menu order.
*/
function groupCatalog(key, listing, options = {}) {
	const registry = options.family?.registry ?? REGISTRY;
	const refused = options.family?.refused ?? REFUSED_CHAT_MODEL_IDS;
	const groupReasoning = options.family === void 0 ? GROUP_DEFAULTS[key].reasoning : options.family.defaults[key]?.reasoning;
	const rows = listing === void 0 ? [] : [...listing];
	for (const entry of registry) {
		if (!servesGroup(entry, key)) continue;
		if (!rows.some((row) => row.id === entry.id)) rows.push({ id: entry.id });
	}
	if (rows.length === 0 && options.registryFallback !== false) for (const entry of registry) rows.push({ id: entry.id });
	const rankOf = (id) => {
		const at = options.recommended?.indexOf(identityKey(id, registry)) ?? -1;
		return at === -1 ? Number.MAX_SAFE_INTEGER : at;
	};
	const ranked = rows.filter((row) => servesChat(row.id, refused) && servesDeclaredEndpoints(row) && row.outOfPlan !== true && options.hidden?.has(row.id) !== true).map((row, index) => ({
		index,
		row,
		rank: rankOf(row.id)
	})).sort((left, right) => left.rank - right.rank || left.index - right.index);
	const byIdentity = /* @__PURE__ */ new Map();
	for (const { row } of ranked) {
		const model = catalogEntry(row, groupReasoning, options.vision, registry);
		const identity = identityKey(row.id, registry);
		const hit = byIdentity.get(identity);
		if (hit === void 0) {
			byIdentity.set(identity, {
				upstreamId: row.id,
				ids: [row.id],
				displayName: model.displayName,
				contextWindow: model.contextWindow,
				...model.contextWindowDisclosed === true ? { contextWindowDisclosed: true } : {},
				...model.contextOptions === void 0 ? {} : { contextOptions: [...model.contextOptions] },
				...model.contextLengths === void 0 ? {} : { contextLengths: [...model.contextLengths] },
				...model.reasoning === void 0 ? {} : { reasoning: model.reasoning },
				vision: model.vision,
				rank: model.rank
			});
			continue;
		}
		hit.ids.push(row.id);
	}
	return [...byIdentity.values()];
}
/** Go vocabulary shared by the deepseek/glm-5.3-flash/kimi-k3/longcat/mimo-v2.5/minimax-m3/qwen3.8 generation. */
const GO_FULL_REASONING = {
	efforts: [
		"none",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	defaultEffort: "high"
};
/** GLM-5.1/5.2/5.3 on Go: thinking cannot be disabled; `minimal`, `none` and `off` all answer 400. */
/**
* The narrower Go vocabulary the MiMo v2.x routes accept: a disabling word and
* three depths, with no `minimal`, `xhigh` or `max`. Probed 2026-10-01 against
* mimo-v2.5, mimo-v2.6-flash and mimo-v2.6-pro -- each answered 200 on exactly
* these four and 400 on the three it omits, so this is a measured ceiling
* rather than a tidier-looking subset.
*/
const GO_TIGHT_REASONING = {
	efforts: [
		"none",
		"low",
		"medium",
		"high"
	],
	defaultEffort: "high"
};
const GO_GLM_REASONING = {
	efforts: [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	defaultEffort: "high"
};
/** muses/grok on the Go responses surface: `none` and `max` answer 400. */
const GO_RESPONSES_REASONING = {
	efforts: [
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh"
	],
	defaultEffort: "medium"
};
/** Qwen3.7 generation on Go: `max`, `minimum` and `off` answer 400. */
const GO_QWEN37_REASONING = {
	efforts: [
		"none",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh"
	],
	defaultEffort: "medium"
};
/**
* The three-depth Go vocabulary the newer free tiers publish: `low`, `medium`
* and `high` with no toggle and no disabling word, as models.dev lists for
* `step-5-preview-free` and `gemini-4-argon-contributor`.
*
* Kept separate from {@link GO_RESPONSES_REASONING} even though the two are
* close: that one is a probed accept set on the `/responses` surface and
* includes `minimal`/`xhigh`, and borrowing it here would offer two depths these
* routes do not publish.
*/
const GO_SHALLOW_REASONING = {
	efforts: [
		"low",
		"medium",
		"high"
	],
	defaultEffort: "medium"
};
/**
* Claude Haiku 5.5's effort vocabulary on the Anthropic wire: the same five
* depths Anthropic publishes for it (`low`, `medium`, `high`, `xhigh`, `max`)
* and the same set the vendor CLI catalog lists for the Command Code ids beside
* them. The disabling word is absent because this wire spells "off" as
* `thinking: {type: 'disabled'}` rather than as an effort, which
* {@link resolveMessagesThinking} handles.
*/
const HAIKU_MESSAGES_REASONING = {
	efforts: [
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	],
	defaultEffort: "medium"
};
/**
* The OpenCode Go registry. Every entry is a membership source for the single
* `go` group, so the menu holds the whole catalog even while the live listing
* is unreachable. `contextWindow` follows the model's published window
* (models.dev); reasoning vocabularies are the live-verified accept sets.
*/
const GO_REGISTRY = [
	{
		id: "deepseek-v4.1-flash",
		displayName: "DeepSeek V4.1 Flash",
		family: "deepseek",
		contextWindow: 1e6,
		reasoning: GO_FULL_REASONING,
		vision: true,
		groups: ["go"],
		rank: 1
	},
	{
		id: "glm-5.3",
		displayName: "GLM-5.3",
		family: "glm",
		contextWindow: 1e6,
		reasoning: GO_GLM_REASONING,
		vision: false,
		groups: ["go"],
		rank: 2
	},
	{
		id: "kimi-k3",
		displayName: "Kimi K3",
		family: "kimi",
		contextWindow: CONTEXT_1M,
		reasoning: GO_FULL_REASONING,
		vision: true,
		groups: ["go"],
		rank: 3
	},
	{
		id: "deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		family: "deepseek",
		contextWindow: 1e6,
		reasoning: GO_FULL_REASONING,
		vision: false,
		groups: ["go"],
		rank: 4
	},
	{
		id: "qwen3.8-max",
		displayName: "Qwen3.8 Max",
		family: "qwen",
		contextWindow: 1e6,
		reasoning: GO_FULL_REASONING,
		vision: true,
		groups: ["go"],
		rank: 5
	},
	{
		id: "grok-4.6",
		displayName: "Grok 4.6",
		family: "grok",
		contextWindow: 5e5,
		reasoning: GO_RESPONSES_REASONING,
		vision: true,
		protocol: "responses",
		groups: ["go"],
		rank: 6
	},
	{
		id: "grok-4.7",
		displayName: "Grok 4.7",
		family: "grok",
		contextWindow: 5e5,
		reasoning: GO_RESPONSES_REASONING,
		vision: true,
		protocol: "responses",
		groups: ["go"],
		rank: 7
	},
	{
		id: "deepseek-v4-flash",
		displayName: "DeepSeek V4 Flash",
		family: "deepseek",
		contextWindow: 1e6,
		reasoning: GO_FULL_REASONING,
		vision: false,
		groups: ["go"]
	},
	{
		id: "deepseek-v4-flash-vision-exp",
		displayName: "DeepSeek V4 Flash Vision",
		family: "deepseek",
		contextWindow: 1e6,
		reasoning: GO_FULL_REASONING,
		vision: true,
		groups: ["go"]
	},
	{
		id: "deepseek-flash",
		displayName: "DeepSeek Flash",
		family: "deepseek",
		contextWindow: FALLBACK_CONTEXT_WINDOW,
		reasoning: GO_FULL_REASONING,
		groups: ["go"]
	},
	{
		id: "glm-5.1",
		displayName: "GLM-5.1",
		family: "glm",
		contextWindow: 202752,
		reasoning: GO_GLM_REASONING,
		vision: false,
		groups: ["go"]
	},
	{
		id: "glm-5.2",
		displayName: "GLM-5.2",
		family: "glm",
		contextWindow: 1e6,
		reasoning: GO_GLM_REASONING,
		vision: false,
		groups: ["go"]
	},
	{
		id: "glm-5.3-flash",
		displayName: "GLM-5.3 Flash",
		family: "glm",
		contextWindow: 1e6,
		reasoning: GO_FULL_REASONING,
		vision: true,
		groups: ["go"]
	},
	{
		id: "gpt-5.6-luna",
		displayName: "GPT-5.6 Luna",
		family: "gpt",
		contextWindow: 105e4,
		reasoning: {
			efforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium"
		},
		vision: true,
		protocol: "responses",
		groups: ["go"]
	},
	{
		id: "hy3",
		displayName: "HY-3",
		family: "hunyuan",
		contextWindow: 256e3,
		reasoning: GO_FULL_REASONING,
		vision: false,
		groups: ["go"]
	},
	{
		id: "hy4-preview",
		displayName: "HY-4 Preview",
		family: "hunyuan",
		contextWindow: 1024e3,
		reasoning: GO_FULL_REASONING,
		vision: false,
		groups: ["go"]
	},
	{
		id: "kimi-k2.6",
		displayName: "Kimi K2.6",
		family: "kimi",
		contextWindow: CONTEXT_256K,
		vision: true,
		groups: ["go"]
	},
	{
		id: "kimi-k2.7-code",
		displayName: "Kimi K2.7 Code",
		family: "kimi",
		contextWindow: CONTEXT_256K,
		reasoning: {
			efforts: [
				"off",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium"
		},
		vision: true,
		groups: ["go"]
	},
	{
		id: "longcat-2.0",
		displayName: "LongCat 2.0",
		family: "longcat",
		contextWindow: 1e6,
		reasoning: GO_FULL_REASONING,
		vision: false,
		groups: ["go"]
	},
	{
		id: "mimo-v2.5",
		displayName: "MiMo V2.5",
		family: "mimo",
		contextWindow: 1e6,
		reasoning: GO_TIGHT_REASONING,
		vision: true,
		groups: ["go"]
	},
	{
		id: "mimo-v2.5-pro",
		displayName: "MiMo V2.5 Pro",
		family: "mimo",
		contextWindow: CONTEXT_1M,
		reasoning: {
			efforts: [
				"none",
				"low",
				"medium",
				"high"
			],
			defaultEffort: "medium"
		},
		vision: false,
		groups: ["go"]
	},
	{
		id: "minimax-m2.5",
		displayName: "MiniMax M2.5",
		family: "minimax",
		contextWindow: CONTEXT_200K,
		reasoning: {
			efforts: [
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium"
		},
		vision: false,
		groups: ["go"]
	},
	{
		id: "minimax-m3",
		displayName: "MiniMax M3",
		family: "minimax",
		contextWindow: 1e6,
		reasoning: GO_FULL_REASONING,
		vision: true,
		inlineReasoning: true,
		groups: ["go"]
	},
	{
		id: "muse-spark-1.2-contributor",
		displayName: "Muse Spark 1.2 Contributor",
		family: "meta",
		contextWindow: CONTEXT_1M,
		reasoning: GO_RESPONSES_REASONING,
		vision: true,
		protocol: "responses",
		groups: ["go"]
	},
	{
		id: "muse-spark-1.3-contributor",
		displayName: "Muse Spark 1.3 Contributor",
		family: "meta",
		contextWindow: CONTEXT_1M,
		reasoning: GO_RESPONSES_REASONING,
		vision: true,
		protocol: "responses",
		groups: ["go"]
	},
	{
		id: "omen-alpha",
		displayName: "Omen Alpha",
		family: "omen",
		contextWindow: 5e5,
		reasoning: {
			efforts: [
				"none",
				"minimal",
				"low",
				"medium",
				"high",
				"max"
			],
			defaultEffort: "medium"
		},
		vision: true,
		groups: ["go"]
	},
	{
		id: "qwen3.6-plus",
		displayName: "Qwen3.6 Plus",
		family: "qwen",
		contextWindow: 1e6,
		reasoning: {
			efforts: [
				"none",
				"minimum",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "medium"
		},
		vision: true,
		groups: ["go"]
	},
	{
		id: "qwen3.7-max",
		displayName: "Qwen3.7 Max",
		family: "qwen",
		contextWindow: 1e6,
		reasoning: GO_QWEN37_REASONING,
		vision: false,
		groups: ["go"]
	},
	{
		id: "qwen3.7-plus",
		displayName: "Qwen3.7 Plus",
		family: "qwen",
		contextWindow: 1e6,
		reasoning: GO_QWEN37_REASONING,
		vision: true,
		groups: ["go"]
	},
	{
		id: "qwen3.8-flash",
		displayName: "Qwen3.8 Flash",
		family: "qwen",
		contextWindow: 1e6,
		reasoning: GO_FULL_REASONING,
		vision: true,
		groups: ["go"]
	},
	{
		id: "kimi-k2.5",
		displayName: "Kimi K2.5",
		family: "kimi",
		contextWindow: CONTEXT_256K,
		vision: true,
		groups: ["go"]
	},
	{
		id: "glm-5",
		displayName: "GLM-5",
		family: "glm",
		contextWindow: 202752,
		vision: false,
		groups: ["go"]
	},
	{
		id: "mimo-v2-pro",
		displayName: "MiMo V2 Pro",
		family: "mimo",
		contextWindow: CONTEXT_1M,
		vision: false,
		groups: ["go"]
	},
	{
		id: "mimo-v2-omni",
		displayName: "MiMo V2 Omni",
		family: "mimo",
		contextWindow: CONTEXT_256K,
		vision: true,
		groups: ["go"]
	},
	{
		id: "mimo-v2.6-pro",
		displayName: "MiMo V2.6 Pro",
		family: "mimo",
		contextWindow: CONTEXT_1M,
		reasoning: GO_TIGHT_REASONING,
		vision: true,
		groups: ["go"]
	},
	{
		id: "mimo-v2.6-flash",
		displayName: "MiMo V2.6 Flash",
		family: "mimo",
		contextWindow: CONTEXT_1M,
		reasoning: GO_TIGHT_REASONING,
		vision: true,
		groups: ["go"]
	},
	{
		id: "longcat-2.5-preview-free",
		displayName: "LongCat 2.5 Preview",
		family: "longcat",
		contextWindow: 1e6,
		reasoning: GO_FULL_REASONING,
		vision: true,
		groups: ["go"]
	},
	{
		id: "qwen3.5-plus",
		displayName: "Qwen3.5 Plus",
		family: "qwen",
		contextWindow: CONTEXT_256K,
		vision: true,
		groups: ["go"]
	},
	{
		id: "space-bunny",
		displayName: "Space Bunny",
		family: "stealth",
		contextWindow: CONTEXT_1M,
		reasoning: HAIKU_MESSAGES_REASONING,
		vision: true,
		groups: ["go"]
	},
	{
		id: "cat-jam-free",
		displayName: "Cat Jam Free",
		family: "stealth",
		contextWindow: CONTEXT_256K,
		reasoning: HAIKU_MESSAGES_REASONING,
		vision: false,
		groups: ["go"]
	},
	{
		id: "step-5-preview-free",
		displayName: "Step 5 Preview Free",
		family: "step",
		contextWindow: 1e6,
		reasoning: GO_SHALLOW_REASONING,
		vision: true,
		groups: ["go"]
	},
	{
		id: "grok-4.5",
		displayName: "Grok 4.5",
		family: "grok",
		contextWindow: 5e5,
		reasoning: {
			efforts: [
				"low",
				"medium",
				"high"
			],
			defaultEffort: "medium"
		},
		vision: true,
		groups: ["go"]
	},
	{
		id: "gpt-6-luna",
		displayName: "GPT-6 Luna",
		family: "gpt",
		contextWindow: 105e4,
		reasoning: {
			efforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium"
		},
		vision: true,
		protocol: "responses",
		groups: ["go"]
	},
	{
		id: "claude-haiku-5-5",
		displayName: "Claude Haiku 5.5",
		family: "claude",
		contextWindow: 1e6,
		reasoning: HAIKU_MESSAGES_REASONING,
		vision: true,
		protocol: "messages",
		contextLengths: [CONTEXT_100K],
		groups: ["go"]
	}
];
/**
* Ids this endpoint cannot serve a chat turn for on any wire protocol.
*
* Two ways an id lands here, both verified by request rather than inferred:
*
*  - **Listed but unservable.** `minimax-m2.7` answers 503 on both
*    chat-completions and responses; `hy3-preview` answers 400 "Model is
*    unavailable". They stay listed (the probe table names them) but never
*    reach the menu.
*
*  - **Declared here but no longer served.** These six were added when the
*    endpoint's catalog listed them, and the catalog has since shrunk from 43
*    ids to 36 (stable across three fetches, 2026-09-27). A registry entry
*    tagged for this group is a menu MEMBERSHIP SOURCE, so it is offered even
*    when the live listing no longer carries it -- which made every one of
*    these a row whose every use answered 400 "Model is unavailable". That is
*    the reported "sometimes it works, sometimes it errors": the row was
*    selectable and always failed. Removing an id from this list is what puts
*    it back the moment the endpoint serves it again.
*/
const GO_REFUSED_MODEL_IDS = [
	"hy3-preview",
	"minimax-m2.7",
	"glm-5",
	"grok-4.5",
	"kimi-k2.5",
	"kimi-k2.6",
	"mimo-v2-omni",
	"mimo-v2-pro",
	"qwen3.5-plus",
	"space-bunny-free",
	"gemini-4-argon-contributor"
];
/** Go menu leads: the models whose thinking actually streams, in preference order. */
const GO_DEFAULT_RECOMMENDED = GO_REGISTRY.filter((entry) => entry.rank !== void 0 && !GO_REFUSED_MODEL_IDS.includes(entry.id)).slice().sort((left, right) => left.rank - right.rank).map((entry) => entry.id);
//#endregion
//#region src/commandcode-tiers.ts
/** Models sharing one vocabulary, keyed by the comma-joined efforts. */
const SETS = {
	"none": [
		"MiniMaxAI/MiniMax-M2.5",
		"MiniMaxAI/MiniMax-M2.7",
		"Qwen/Qwen3.6-Max-Preview",
		"Qwen/Qwen3.6-Plus",
		"Qwen/Qwen3.7-Flash",
		"Qwen/Qwen3.7-Max",
		"Qwen/Qwen3.7-Plus",
		"claude-haiku-4-5-20251001",
		"inclusionai/ling-3.0-flash-sante:free",
		"meituan/LongCat-2.0",
		"moonshotai/Kimi-K2.5",
		"moonshotai/Kimi-K2.6",
		"moonshotai/Kimi-K2.7-Code",
		"moonshotai/Kimi-K2.7-Code-Highspeed",
		"nvidia/nemotron-3-ultra-550b-a55b",
		"poolside/laguna-s-2.1-free",
		"stepfun/Step-3.5-Flash",
		"stepfun/Step-3.7-Flash",
		"tencent/hy3-paid",
		"thinkingmachines/inkling",
		"thinkingmachines/inkling-small",
		"xiaomi/mimo-v2.5",
		"xiaomi/mimo-v2.5-pro",
		"xiaomi/mimo-v2.6-flash",
		"xiaomi/mimo-v2.6-pro",
		"xiaomi/mimo-v2.6-pro-ultraspeed",
		"zai-org/GLM-5",
		"zai-org/GLM-5.1",
		"zai-org/GLM-5.2-Fast"
	],
	"low,medium,high,xhigh,max": [
		"claude-fable-5",
		"claude-fable-5-1",
		"claude-haiku-5-5",
		"claude-opus-4-7",
		"claude-opus-4-8",
		"claude-opus-5",
		"claude-opus-5-5",
		"claude-sonnet-4-6",
		"claude-sonnet-5",
		"gpt-5.6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-6-astra",
		"gpt-6-luna",
		"gpt-6-sol",
		"meta/muse-spark-1.3"
	],
	"low,medium,high": [
		"MiniMaxAI/MiniMax-M3",
		"google/gemini-3.1-flash-lite",
		"google/gemini-3.5-flash",
		"google/gemini-3.5-flash-lite",
		"google/gemini-3.6-flash",
		"google/gemini-3.7-flash",
		"google/gemini-3.8-flash",
		"gpt-5.4-mini",
		"stealth/space-bunny-alpha",
		"stepfun/Step-5-Preview",
		"tencent/hy4-preview",
		"xai/grok-4.5"
	],
	"low,medium,high,xhigh": [
		"gpt-5.3-codex",
		"gpt-5.4",
		"gpt-5.5",
		"meta/muse-spark-1.1",
		"meta/muse-spark-1.2",
		"meta/muse-spark-1.2-contributor",
		"meta/muse-spark-1.3-contributor",
		"xai/grok-4.6",
		"xai/grok-4.7"
	],
	"low,high,max": [
		"deepseek/deepseek-v4-flash-fast",
		"deepseek/deepseek-v4.1-flash",
		"moonshotai/Kimi-K3",
		"z-ai/glm-5.3-flash",
		"z-ai/glm-5.3-flashx",
		"zai-org/GLM-5.3"
	],
	"low,medium,xhigh": [
		"Qwen/Qwen3.8-27B",
		"Qwen/Qwen3.8-Flash",
		"Qwen/Qwen3.8-Max",
		"Qwen/Qwen3.8-Max-0902",
		"Qwen/Qwen3.8-Omni-Flash",
		"stealth/pixel-canary"
	],
	"high,max": [
		"deepseek/deepseek-v4-flash",
		"deepseek/deepseek-v4-flash-vision-exp",
		"deepseek/deepseek-v4-pro",
		"zai-org/GLM-5.2"
	],
	"high,xhigh": ["sakana/fugu-ultra"]
};
/** Upstream id -> its effort vocabulary. */
const BY_ID = /* @__PURE__ */ new Map();
for (const [key, ids] of Object.entries(SETS)) {
	if (key === "none") continue;
	const efforts = key.split(",");
	const defaultEffort = efforts.includes("high") ? "high" : efforts[0];
	for (const id of ids) BY_ID.set(id, {
		efforts,
		defaultEffort
	});
}
/**
* The effort vocabulary this gateway accepts for one upstream id.
* @param upstreamId - the model id as the endpoints listing reports it.
* @returns its efforts, or undefined when it takes none or is unknown.
*/
function commandCodeReasoning(upstreamId) {
	return BY_ID.get(upstreamId);
}
//#endregion
//#region src/commandcode-catalog.ts
/**
* The Command Code capability catalog: what the models in the endpoints listing
* can actually do.
*
* The endpoints listing (`/provider/v1/models`) is the ROUTING truth — it alone
* declares which wire serves each model — but it discloses no capability at all.
* The marketing page `/docs/plans/goat` is the CAPABILITY truth: it embeds a
* structured catalog in its Next.js streaming payload carrying `reasoning`,
* `vision`, `contextWindow`, pricing, and a plan gate per model.
*
* This module owns the join and the parsing. It is deliberately tolerant: the
* page is a SCRAPED, undocumented surface, so every failure degrades to "no
* capability claims" rather than to an empty menu. A model with no catalog row
* keeps the permissive vision default and simply offers no Effort submenu —
* exactly the behavior this plugin had before the catalog existed.
*
* Verified live 2026-09-23 (83 rows; snapshots under `.agents/`).
*
* @module dsh-protocom-api/commandcode-catalog
*/
/**
* Subscription tiers, weakest first.
*
* The page states a model's gate as a NAME (`Go`, `GOAT`, `Pro`, `Max`). The
* tiers are CUMULATIVE — which was confirmed by request: an account on
* `individual-goat` got HTTP 200 for a Go-tier model and a GOAT-tier model, and
* HTTP 403 `MODEL_NOT_IN_PLAN` for Pro- and Max-tier models. So a model is
* usable when its gate is at or below the account's own tier.
*
* The names are matched case-insensitively because the page spells the cheapest
* tier `Go` while the plan id uses `goat`; both appear in live data.
*/
const COMMANDCODE_TIERS = [
	"go",
	"goat",
	"pro",
	"max"
];
/**
* Rank one plan name, or undefined when it is not a tier this plugin knows.
* @param name - the plan name from the page or a plan id.
* @returns the zero-based rank, weakest first.
*/
function tierRank(name) {
	if (name === void 0) return void 0;
	const at = COMMANDCODE_TIERS.indexOf(name.trim().toLowerCase());
	return at === -1 ? void 0 : at;
}
/**
* Extract the tier from a subscription plan id such as `individual-goat`.
* @param planId - the plan id, if any.
* @returns the tier name in canonical lower case, or undefined.
*/
function tierFromPlanId(planId) {
	if (planId === void 0) return void 0;
	for (const tier of COMMANDCODE_TIERS) if (new RegExp(`(^|[^a-z])${tier}([^a-z]|$)`).test(planId.toLowerCase())) return tier;
}
/**
* Whether a model's own gate is included in the account's tier.
*
* An unknown gate on EITHER side means the question cannot be answered, and the
* model is kept: hiding a model the account can use is worse than showing one
* that fails with a clear provider message, and an unrecognized tier name is a
* catalog change rather than evidence of exclusion.
* @param modelGate - the model's `minPlanName`.
* @param accountTier - the account's own tier, lower case.
* @returns whether to offer the model.
*/
function withinTier(modelGate, accountTier) {
	const gate = tierRank(modelGate);
	const have = tierRank(accountTier);
	if (gate === void 0 || have === void 0) return true;
	return gate <= have;
}
/**
* Longest model id kept from the page. Mirrors the discovery parser's bound so
* a hostile page cannot push a large string into the catalog.
*/
const MAX_ID_LENGTH = 256;
/** Upper bound on rows accepted; the live page carries 83. */
const MAX_CATALOG_ROWS = 1e3;
/**
* Reassemble the Next.js RSC payload a page streams through
* `self.__next_f.push([1, "..."]) ` fragments.
*
* Each fragment argument is a JSON string whose concatenation forms the payload,
* so reassembly is exactly "parse each fragment as a JSON string, then join".
* A malformed fragment is skipped rather than failing the whole page.
* @param html - the page body.
* @returns the concatenated payload.
*/
function reassembleFlightPayload(html) {
	const fragments = [];
	for (const match of html.matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g)) try {
		fragments.push(JSON.parse(match[1]));
	} catch {}
	return fragments.join("");
}
/**
* Pull every balanced top-level JSON array that follows a `"models":` key.
* Brace/bracket counting is done on the raw text rather than by a regex because
* the array is large and nested; scanning for balance is exact and linear.
* @param payload - the reassembled payload.
* @returns the candidate arrays as raw JSON text, largest first.
*/
function modelsArrays(payload) {
	const marker = "\"models\":[";
	const found = [];
	let at = payload.indexOf(marker);
	let scanned = 0;
	while (at !== -1) {
		const start = at + 10 - 1;
		let depth = 0;
		let end = -1;
		let inString = false;
		let escaped = false;
		for (let index = Math.max(start, scanned); index < payload.length; index += 1) {
			const char = payload[index];
			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === "\"") inString = false;
				continue;
			}
			if (char === "\"") inString = true;
			else if (char === "[") depth += 1;
			else if (char === "]") {
				depth -= 1;
				if (depth === 0) {
					end = index;
					break;
				}
			}
		}
		if (end !== -1) {
			found.push(payload.slice(start, end + 1));
			scanned = end + 1;
		} else scanned = payload.length;
		at = payload.indexOf(marker, at + 1);
	}
	return found.sort((left, right) => right.length - left.length);
}
/** A finite, non-negative number, or undefined. */
function nonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
/**
* Parse one catalog array into capabilities by model id.
*
* `reasoning` and `vision` are read from the flat fields first and fall back to
* `caps`; a row stating neither is skipped rather than guessed at, because a
* guessed capability is exactly the defect this catalog exists to remove.
* @param rows - the parsed JSON array.
* @returns capabilities by id, plus the ids that were discarded.
*/
function parseCatalogRows(rows) {
	const byId = /* @__PURE__ */ new Map();
	if (!Array.isArray(rows)) return {
		byId,
		skipped: 0
	};
	let skipped = 0;
	for (const raw of rows.slice(0, MAX_CATALOG_ROWS)) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			skipped += 1;
			continue;
		}
		const row = raw;
		const id = typeof row.id === "string" && row.id.length > 0 && row.id.length <= MAX_ID_LENGTH ? row.id : void 0;
		const reasoning = typeof row.reasoning === "boolean" ? row.reasoning : row.caps?.reasoning;
		const vision = typeof row.vision === "boolean" ? row.vision : row.caps?.vision;
		if (id === void 0 || typeof reasoning !== "boolean" || typeof vision !== "boolean") {
			skipped += 1;
			continue;
		}
		const contextWindow = nonNegative(row.contextWindow);
		const inputCost = nonNegative(row.inputCost);
		const outputCost = nonNegative(row.outputCost);
		const cacheReadCost = nonNegative(row.cacheReadCost);
		const minPlan = typeof row.minPlanName === "string" && row.minPlanName.length > 0 ? row.minPlanName : void 0;
		byId.set(id, {
			reasoning,
			vision,
			...contextWindow === void 0 || contextWindow === 0 ? {} : { contextWindow },
			...inputCost === void 0 ? {} : { inputCost },
			...outputCost === void 0 ? {} : { outputCost },
			...cacheReadCost === void 0 ? {} : { cacheReadCost },
			...minPlan === void 0 ? {} : { minPlan }
		});
	}
	return {
		byId,
		skipped
	};
}
/**
* Resolve one listing id against the catalog, tolerating the page's habit of
* vendor-prefixing an otherwise identical id (`stealth/space-bunny-alpha` for a
* listing's `space-bunny-alpha`).
*
* The fallback is a suffix match on the last path segment, which is what the
* live data needs: 81 of 82 listing rows join this way, and the single miss is a
* dated snapshot id the page does not carry.
* @param byId - the parsed catalog.
* @param id - the listing id to resolve.
* @returns that model's capabilities, or undefined when the page omitted it.
*/
function catalogFor(byId, id) {
	const exact = byId.get(id);
	if (exact !== void 0) return exact;
	const tail = (value) => {
		const slash = value.lastIndexOf("/");
		return slash === -1 ? value : value.slice(slash + 1);
	};
	const wanted = tail(id);
	for (const [key, value] of byId) if (tail(key) === wanted) return value;
	const undated = /^(.*?)-\d{8}$/.exec(wanted)?.[1];
	if (undated !== void 0) {
		for (const [key, value] of byId) if (tail(key) === undated) return value;
	}
}
/**
* Read the capability catalog out of a fetched page.
* @param html - the page body, or undefined when the fetch failed.
* @param failure - why the page could not be read, when it could not.
* @returns capabilities by id, with a problem note when the scrape degraded.
*/
function scrapeCatalog(html, failure) {
	if (html === void 0) return {
		byId: /* @__PURE__ */ new Map(),
		problem: failure ?? "the capability page could not be read"
	};
	const payload = reassembleFlightPayload(html);
	if (payload.length === 0) return {
		byId: /* @__PURE__ */ new Map(),
		problem: "the capability page carried no readable payload"
	};
	const candidates = modelsArrays(payload);
	if (candidates.length === 0) return {
		byId: /* @__PURE__ */ new Map(),
		problem: "the capability page carried no model catalog"
	};
	for (const candidate of candidates) {
		let parsed;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		const { byId } = parseCatalogRows(parsed);
		if (byId.size > 0) return { byId };
	}
	return {
		byId: /* @__PURE__ */ new Map(),
		problem: "the capability catalog did not parse"
	};
}
/** The page carrying the catalog. */
const COMMANDCODE_CATALOG_URL = "https://commandcode.ai/docs/plans/goat";
/**
* Largest page body accepted, in bytes.
*
* The live page is ~765 KB. The bound matters twice over: it caps memory, and it
* caps how long the catalog scan can run, since the scan's cost is a function of
* the payload it is handed. Both are attacker-influenced -- the fetch is
* unauthenticated, so a DNS hijack or a compromised vendor host decides what
* arrives.
*/
const MAX_CATALOG_BYTES = 8388608;
/** Largest subscription reply accepted, in bytes. A planId document is tiny. */
const MAX_PLAN_BYTES = 65536;
//#endregion
//#region src/commandcode.ts
/** Endpoint base. `/v1/models` is appended for discovery; any endpoint-root
* normalization that strips a trailing `/v1` must leave `/provider/v1` intact. */
const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/provider";
/** The origin a stored key may be sent to without explicit confirmation. */
const COMMANDCODE_BASE_URL_ORIGIN = new URL(COMMANDCODE_BASE_URL).origin;
/** The one provider route this family registers. */
const COMMANDCODE_PROVIDER = "commandcode";
/** Credential references this family resolves, mirroring the other families'
* namespacing bound: the reference is what the environment fallback reads. */
const COMMANDCODE_CREDENTIAL_REF = /^COMMANDCODE_[A-Z0-9_]+$/;
/**
* Context lengths this family offers as picker variants.
*
* The live listing publishes a wider and less regular set than any other
* endpoint this plugin serves (200000, 256000, 262000, 262144, 400000,
* 500000, 1000000, 1048576, 1050000), including several that differ by a few
* hundred tokens. Offering all nine would be noise in the menu; the ladder
* below keeps the four steps that actually distinguish a choice, and a model
* is still only offered the steps at or below its own window.
*/
const COMMANDCODE_CONTEXT_LADDER = [
	2e5,
	256e3,
	4e5,
	1e6
];
/**
* Ids the endpoint lists but cannot serve. Empty: every row in the live
* listing was servable on at least one wire this plugin implements, except the
* nine Anthropic-only Claude models, which are excluded by their declared
* endpoints rather than by an id blocklist. Kept as an explicit empty list so
* the family shape matches its siblings and a future refusal has one home.
*/
const COMMANDCODE_REFUSED_MODEL_IDS = [];
/**
* Models that lead this family's menu when the deployment chooses none.
*
* Empty on purpose. Which models are worth naming first depends on the account's
* plan, and the listing is already filtered to what that plan includes, so a
* shipped order would be a guess that ages badly. The menu keeps the endpoint's
* own order instead.
*/
const COMMANDCODE_RECOMMENDED = [];
/**
* The Command Code family. One group (`cc`), one route, no session header:
* unlike OpenCode Go this endpoint accepts requests without session scoping,
* which was confirmed by the public listing answering without one.
*/
const COMMANDCODE = {
	ns: "commandcode",
	sectionKey: "commandcode",
	label: "Command Code",
	baseURL: COMMANDCODE_BASE_URL,
	origin: COMMANDCODE_BASE_URL_ORIGIN,
	credentialRef: COMMANDCODE_CREDENTIAL_REF,
	keys: ["cc"],
	defaults: { cc: {
		displayName: "Command Code",
		protocol: "chat-completions",
		contextLengths: COMMANDCODE_CONTEXT_LADDER
	} },
	providerOf: () => COMMANDCODE_PROVIDER,
	groupOf: (provider) => provider === "commandcode" ? "cc" : void 0,
	keyRef: () => "COMMANDCODE_API_KEY",
	recommended: [],
	registry: [],
	refused: COMMANDCODE_REFUSED_MODEL_IDS,
	capabilityCatalogUrl: COMMANDCODE_CATALOG_URL,
	reasoningFor: commandCodeReasoning,
	chatThinking: "effort-only",
	planIdPath: "/alpha/billing/subscriptions",
	creditsPath: "/alpha/billing/credits",
	usagePath: "/alpha/usage/summary",
	telemetryPath: "/api/commandcode/account",
	telemetryKind: "account"
};
//#endregion
//#region src/clinepass.ts
/** Endpoint root. `/chat/completions` is appended for a turn. */
const CLINEPASS_BASE_URL = "https://api.cline.bot/api/v1";
/** The origin a stored key may be sent to without explicit confirmation. */
const CLINEPASS_BASE_URL_ORIGIN = new URL(CLINEPASS_BASE_URL).origin;
/** The one provider route this family registers. */
const CLINEPASS_PROVIDER = "clinepass";
/**
* Credential references this family resolves.
*
* Cline issues plain API keys from Settings > API Keys, so the pool is a
* first-class fit: every distinct reference is an independent subscription,
* and `CLINE_API_KEY_2` pools a second one exactly as it does for the other
* families. The namespace bound keeps the environment fallback from reading
* an arbitrary variable.
*/
const CLINEPASS_CREDENTIAL_REF = /^CLINE_[A-Z0-9_]+$/;
/** The conventional credential reference a stored key lives under. */
const CLINEPASS_KEY_REF = "CLINE_API_KEY";
/**
* Context lengths offered as picker variants.
*
* The same four steps the other subscription families offer, so a budget means
* the same thing whichever subscription serves it. The ladder is a CEILING,
* never an override: a model is only offered steps within its own window, and
* its own window is always the last step it can reach.
*/
const CLINEPASS_CONTEXT_LADDER = [
	2e5,
	256e3,
	4e5,
	1e6
];
/**
* Ids Cline documents as retired from ClinePass.
*
* "Due to capacity constraints and model upgrades, GLM-5.2, Kimi K2.6, Kimi
* K2.7 Code, and DeepSeek V4 Flash are no longer available on ClinePass."
* Named rather than merely omitted, so a deployment that had one selected
* reads "the endpoint does not serve this" instead of an unexplained 400, and
* restoring one is a single line.
*/
const CLINEPASS_REFUSED_MODEL_IDS = [
	"cline-pass/glm-5.2",
	"cline-pass/kimi-k2.6",
	"cline-pass/kimi-k2.7-code",
	"cline-pass/deepseek-v4-flash"
];
/**
* The vocabulary of a model whose catalog entry declares a reasoning TOGGLE
* rather than effort levels.
*
* Cline's own normalizer maps a bare `enabled: true` to `medium`, so `medium`
* is the on-state spelled as a level and `none` is the off-state. Offering the
* two is what makes the switch reachable; inventing low/high for a model that
* has no such setting would be a menu the gateway cannot honour.
*/
const CLINE_TOGGLE_REASONING = {
	efforts: ["none", "medium"],
	defaultEffort: "medium"
};
/** Effort levels, for a model whose catalog declares them explicitly. */
const efforts = (values, defaultEffort) => ({
	efforts: values,
	defaultEffort
});
/**
* The fourteen models ClinePass includes.
*
* Ids are Cline's own, cross-checked against the live `recommended-models`
* endpoint. Every entry is tagged for the group, because the endpoint's
* `/models` listing is NOT a membership source for this family -- see
* ProviderFamily.listingIsMembership -- so this registry IS the menu.
*
* Context windows, image support and reasoning vocabularies are taken verbatim
* from Cline's own bundled model catalog, which is the only source that states
* them. They are NOT from models.dev: that consensus disagrees with Cline on
* several of these models, and most sharply on qwen3.8-max, where it reports
* 1,000,000 tokens and image support for a model Cline serves at 128,000 with
* neither. Where a vendor publishes its own numbers, those win.
*/
const CLINEPASS_REGISTRY = [
	{
		id: "cline-pass/mimo-v2.6-flash",
		displayName: "MiMo V2.6 Flash",
		family: "mimo",
		contextWindow: 1048576,
		reasoning: CLINE_TOGGLE_REASONING,
		vision: true,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/mimo-v2.6-pro",
		displayName: "MiMo V2.6 Pro",
		family: "mimo",
		contextWindow: 1048576,
		reasoning: CLINE_TOGGLE_REASONING,
		vision: true,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/glm-5.3",
		displayName: "GLM-5.3",
		family: "glm",
		contextWindow: 1310720,
		reasoning: efforts([
			"low",
			"high",
			"max"
		], "high"),
		vision: false,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/glm-5.3-flash",
		displayName: "GLM-5.3 Flash",
		family: "glm",
		contextWindow: 1310720,
		reasoning: efforts([
			"low",
			"high",
			"max"
		], "high"),
		vision: true,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/kimi-k3",
		displayName: "Kimi K3",
		family: "kimi",
		contextWindow: 1048576,
		reasoning: efforts([
			"none",
			"low",
			"high",
			"max"
		], "high"),
		vision: true,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		family: "deepseek",
		contextWindow: 1048576,
		reasoning: efforts([
			"none",
			"high",
			"xhigh"
		], "high"),
		vision: false,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/deepseek-v4.1-flash",
		displayName: "DeepSeek V4.1 Flash",
		family: "deepseek",
		contextWindow: 1048576,
		reasoning: efforts([
			"none",
			"low",
			"high",
			"max"
		], "high"),
		vision: true,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/mimo-v2.5",
		displayName: "MiMo V2.5",
		family: "mimo",
		contextWindow: 105e4,
		reasoning: CLINE_TOGGLE_REASONING,
		vision: true,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/mimo-v2.5-pro",
		displayName: "MiMo V2.5 Pro",
		family: "mimo",
		contextWindow: 105e4,
		reasoning: CLINE_TOGGLE_REASONING,
		vision: false,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/minimax-m3",
		displayName: "MiniMax M3",
		family: "minimax",
		contextWindow: 1048576,
		reasoning: CLINE_TOGGLE_REASONING,
		vision: true,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/muse-spark-1.3-contributor",
		displayName: "Muse Spark 1.3 Contributor",
		family: "meta",
		contextWindow: 1048576,
		reasoning: efforts([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		], "medium"),
		vision: true,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/qwen3.8-max",
		displayName: "Qwen3.8 Max",
		family: "qwen",
		contextWindow: 128e3,
		vision: false,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/qwen3.7-max",
		displayName: "Qwen3.7 Max",
		family: "qwen",
		contextWindow: 1e6,
		reasoning: CLINE_TOGGLE_REASONING,
		vision: false,
		groups: ["clinepass"]
	},
	{
		id: "cline-pass/qwen3.7-plus",
		displayName: "Qwen3.7 Plus",
		family: "qwen",
		contextWindow: 1e6,
		reasoning: CLINE_TOGGLE_REASONING,
		vision: true,
		groups: ["clinepass"]
	}
];
/**
* Models that lead this family's menu when the deployment chooses none.
*
* Empty on purpose, like Command Code's: the fourteen are all curated by Cline
* for agent work, and any order this plugin invented would be a preference the
* vendor never expressed.
*/
const CLINEPASS_RECOMMENDED = [];
/**
* The ClinePass family. One group, one route, no session header.
*
* `listingIsMembership: false` is the load-bearing difference from its
* siblings: Cline's `/api/v1/models` is a different catalog entirely, so this
* registry is the menu rather than a supplement to a listing.
*
* `chatThinking: 'reasoning-object'` sends `reasoning: {enabled, effort}` with
* no `thinking` block and no bare `reasoning_effort`. The two third-party
* implementations disagree and neither Cline's docs nor its SDK names the
* field for these ids, so this follows the only one that OBSERVED it on the
* wire, which also recorded that `reasoning_effort` was NOT what it sent. That
* is the weakest evidence in this file and it is recorded, not hidden: if live
* testing shows otherwise, this one word is the change.
*/
const CLINEPASS = {
	ns: "clinepass",
	sectionKey: "clinepass",
	label: "ClinePass",
	baseURL: CLINEPASS_BASE_URL,
	origin: CLINEPASS_BASE_URL_ORIGIN,
	credentialRef: CLINEPASS_CREDENTIAL_REF,
	keys: ["clinepass"],
	defaults: { clinepass: {
		displayName: "ClinePass",
		protocol: "chat-completions",
		contextLengths: CLINEPASS_CONTEXT_LADDER
	} },
	providerOf: () => CLINEPASS_PROVIDER,
	groupOf: (provider) => provider === "clinepass" ? "clinepass" : void 0,
	keyRef: () => CLINEPASS_KEY_REF,
	recommended: CLINEPASS_RECOMMENDED,
	registry: CLINEPASS_REGISTRY,
	refused: CLINEPASS_REFUSED_MODEL_IDS,
	listingIsMembership: false,
	chatThinking: "reasoning-object"
};
//#endregion
//#region src/family.ts
/**
* Provider families: the fixed description of one upstream API surface this
* plugin serves. A family owns a settings namespace, an endpoint origin pin,
* a credential-reference namespace, a set of group routes, a model registry,
* and the wire-level quirks that surface differs in (session headers, the
* thinking spelling, per-model protocol overrides). Pure metadata with no
* Node imports: the browser client reads the same descriptors as the Host.
*
* @module dsh-protocom-api/family
*/
/** The Protocom official API family: the four original group routes. */
const PROTOCOM = {
	ns: "protocom-api",
	sectionKey: "protocom",
	label: "Protocom",
	baseURL: DEFAULT_BASE_URL,
	origin: DEFAULT_BASE_URL_ORIGIN,
	credentialRef: /^PROTOCOM_[A-Z0-9_]+$/,
	keys: GROUP_KEYS,
	defaults: GROUP_DEFAULTS,
	providerOf,
	groupOf,
	keyRef: defaultKeyRef,
	recommended: DEFAULT_RECOMMENDED,
	registry: REGISTRY,
	refused: REFUSED_CHAT_MODEL_IDS,
	telemetryPath: "/api/protocom-api/balance",
	telemetryKind: "balance"
};
/** OpenCode Go endpoint base; `/v1` is appended per request. */
const GO_DEFAULT_BASE_URL = "https://opencode.ai/zen/go";
/** Origin of {@link GO_DEFAULT_BASE_URL}: the pin for stored Go keys. */
const GO_DEFAULT_BASE_URL_ORIGIN = new URL(GO_DEFAULT_BASE_URL).origin;
/** Credential references the Go family resolves. */
const GO_CREDENTIAL_REF = /^OPENCODE_[A-Z0-9_]+$/;
/**
* The provider route the Go group registers under. `opencode-go` itself is
* taken in DSH 1.5: the shipped `dsh-llm-pi-ai` plugin declares every pi-ai
* catalog route unconditionally, and `opencode-go` is one of them, so a
* second registration under that name is a DUPLICATE_DIRECTORY boot failure.
* `-sub` distinguishes this plugin's subscription route from the built-in.
*/
const GO_PROVIDER = "opencode-go-sub";
/**
* The OpenCode Go subscription family: one group, one provider route
* (`opencode-go-sub`). The endpoint serves roughly thirty models over
* chat-completions except a per-model set that only answers on the Responses
* surface — those carry `protocol: 'responses'` in the registry. Session
* scoping is contractual: every request sends `x-opencode-session`.
*/
const OPENCODE_GO = {
	ns: "opencode-go",
	sectionKey: "opencodeGo",
	label: "OpenCode Go",
	baseURL: GO_DEFAULT_BASE_URL,
	origin: GO_DEFAULT_BASE_URL_ORIGIN,
	credentialRef: GO_CREDENTIAL_REF,
	keys: ["go"],
	defaults: { go: {
		displayName: "OpenCode Go",
		protocol: "chat-completions",
		contextLengths: [
			204800,
			262144,
			409600,
			1048576
		]
	} },
	providerOf: () => GO_PROVIDER,
	groupOf: (provider) => provider === "opencode-go-sub" ? "go" : void 0,
	keyRef: () => "OPENCODE_GO_API_KEY",
	recommended: GO_DEFAULT_RECOMMENDED,
	registry: GO_REGISTRY,
	refused: GO_REFUSED_MODEL_IDS,
	sessionHeader: "x-opencode-session",
	chatThinking: "effort-only",
	telemetryPath: "/api/opencode-go/usage",
	telemetryKind: "quota"
};
/** Every family this plugin mounts. */
const FAMILIES = [
	PROTOCOM,
	OPENCODE_GO,
	COMMANDCODE,
	CLINEPASS
];
//#endregion
//#region src/retry.ts
/**
* Ceiling for one locally scheduled backoff delay, in milliseconds (default one
* hour). The delay doubles from {@link RETRY_INITIAL_DELAY_MS} until it reaches
* this ceiling, then stays there for the remaining attempts.
*/
const DEFAULT_RETRY_MAX_DELAY_MS = 36e5;
/**
* First locally scheduled backoff delay, in milliseconds.
*
* Not configurable on purpose: the early rungs exist to absorb a transient blip
* quickly, and the ceiling above is what bounds a long outage. Exposing it would
* only add a way to make the first retry slower than the ones after it.
*/
const RETRY_INITIAL_DELAY_MS = 500;
/** Symmetric jitter around each scheduled delay, matching the harness default. */
const RETRY_JITTER_RATIO = .1;
/**
* Largest retry budget a setting may name. The harness itself allows far more,
* but every retry is a billed provider request, and a budget past a hundred
* attempts stops describing an outage and starts describing a runaway. A
* deployment that genuinely needs more raises this in code, deliberately.
*/
const MAX_RETRY_ATTEMPTS = 100;
/**
* Largest delay the harness timer layer accepts, mirrored here so a browser
* editor can bound its own input without importing the timeout package.
* Kept equal to `MAX_TIMER_DELAY_MS` from `@deepseek-ai/dsh-timeout`; the
* Host-side resolver asserts the two still agree, so this cannot drift silently.
*/
const MAX_RETRY_DELAY_MS = 2147483647;
/**
* Failure codes a retry may absorb.
*
* These are what an unstable relay produces: a dropped connection, a stalled
* stream, a 5xx, a rate limit, an answer the model ended without content.
* Deliberately absent are the permanent ones — a bad key (`AUTH`), a malformed
* request (`INVALID_REQUEST`), a protocol violation, an unusable context.
* Retrying those would burn the budget and delay the diagnosis without ever
* succeeding, so they fail on the first attempt and say why.
*/
const RETRYABLE_FAILURE_CODES = Object.freeze([
	"EMPTY_RESPONSE",
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT"
]);
/**
* Build the retry policy for one route from its live budget.
*
* Derived per call rather than pinned in a constant because the harness captures
* a route's policy when that route is REGISTERED — and this plugin re-registers
* on every committed settings change — so reading the current facts here is
* exactly what makes both settings reach the next request without a restart.
*
* `maxDelayMs` and the transport's Retry-After clamp are the same number on
* purpose: the executor cancels a retry when a forwarded provider delay exceeds
* `maxDelayMs` in normal mode, so deriving both from one value is what keeps
* them from ever disagreeing.
* @param budget - the resolved attempt count and delay ceiling.
* @returns the immutable policy for that route.
*/
function retryPolicyFor(budget) {
	return Object.freeze({
		mode: "normal",
		retryableCodes: RETRYABLE_FAILURE_CODES,
		maxRetries: budget.retryMaxAttempts,
		initialDelayMs: 500,
		maxDelayMs: budget.retryMaxDelayMs,
		jitterRatio: RETRY_JITTER_RATIO
	});
}
/**
* The worst-case span one budget covers, in milliseconds: the sum of every
* scheduled delay from the first rung up to the ceiling.
* @param budget - the resolved attempt count and delay ceiling.
* @returns the total time the budget can spend waiting, jitter excluded.
*/
function retryBudgetSpanMs(budget) {
	let total = 0;
	for (let attempt = 0; attempt < budget.retryMaxAttempts; attempt += 1) total += Math.min(500 * 2 ** attempt, budget.retryMaxDelayMs);
	return total;
}
//#endregion
//#region src/bounded-read.ts
/**
* Read a response body under a byte bound, cancelling the moment it is passed.
*
* `response.text()` buffers the WHOLE body before any caller can check its
* size, so a cap applied afterwards bounds nothing: memory is then limited
* only by the upstream's willingness to keep sending. It also measures UTF-16
* units rather than bytes, which under-counts non-ASCII payloads. The declared
* content-length is a cheap early rejection but is attacker-supplied and
* absent on a chunked reply, so the streaming count below is the real bound.
*
* @param response - an in-flight response whose body has not been read.
* @param limit - the largest body to accept, in bytes.
* @returns the decoded body.
* @throws when the body exceeds the limit, or carries no body at all.
*/
async function readBoundedBytes(response, limit) {
	const declared = Number(response.headers.get("content-length") ?? NaN);
	if (Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel();
		throw new Error(`the reply declared ${declared} bytes, over the ${limit}-byte limit`);
	}
	const reader = response.body?.getReader();
	if (reader === void 0) throw new Error("the reply carried no body");
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === void 0) continue;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new Error(`the reply exceeded the ${limit}-byte limit`);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks, total));
}
//#endregion
//#region src/key-pool.ts
/**
* How long a key that failed admission is skipped, in milliseconds.
*
* Long enough to step over a transiently rejected key for the rest of a run,
* short enough that a key recovered by topping up the account comes back
* without restarting anything. Deliberately not configurable: it is a
* safety net for the pool, not a policy an operator tunes.
*/
const KEY_COOLDOWN_MS = 6e4;
/**
* Bookkeeping key for traffic with no Session: a model listing, a probe, a
* title generated before any conversation exists. Those requests share one
* attribution slot because they share the property that no prefix cache
* depends on which key served them.
*/
const NON_SESSION = "\0no-session";
/**
* Deterministic hash of a Session id, used to spread sessions across a pool in
* sticky mode instead of piling every conversation onto the first key.
* @param value - the Session id.
* @returns a non-negative integer.
*/
function hashSession(value) {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) hash = hash * 31 + value.charCodeAt(index) | 0;
	return Math.abs(hash);
}
/**
* The pool's selection state: one affinity per Session, plus per-key cooldowns.
* Kept as a class so a caller owns exactly one and can dispose it.
*/
var KeyPool = class {
	keyCount;
	policy;
	now;
	/** Session id to key index. Insertion order is the eviction order. */
	affinity = /* @__PURE__ */ new Map();
	/** Key index to the instant its cooldown ends, in epoch milliseconds. */
	cooldownUntil = /* @__PURE__ */ new Map();
	/**
	* The key each traffic stream most recently received. Sticky mode already
	* knows this through {@link affinity}; recording it for every mode is what
	* lets a failure report name the key that actually failed, without the
	* adapter having to know anything about pools or credentials.
	*/
	lastPicked = /* @__PURE__ */ new Map();
	/**
	* Record which key a stream received, evicting the oldest past the cap.
	*
	* Insertion order is the recency order, so re-inserting refreshes a stream's
	* position exactly as the affinity map already does. Without the cap this grew
	* once per (session, group) for the life of the Host: measured 5000 distinct
	* session ids leaving 5000 entries, against an affinity map correctly held at
	* 512. A long-lived process would leak one small entry per conversation.
	* @param stream - the Session id, or the non-session sentinel.
	* @param index - the key it was served.
	*/
	remember(stream, index) {
		this.lastPicked.delete(stream);
		this.lastPicked.set(stream, index);
		while (this.lastPicked.size > 512) {
			const oldest = this.lastPicked.keys().next();
			if (oldest.done === true) break;
			this.lastPicked.delete(oldest.value);
		}
	}
	/**
	* @param keyCount - how many keys this pool holds.
	* @param policy - how to choose among them.
	* @param now - clock, injectable so cooldown behaviour is testable.
	*/
	constructor(keyCount, policy, now = () => Date.now()) {
		this.keyCount = keyCount;
		this.policy = policy;
		this.now = now;
	}
	/** Resize after a settings change, dropping affinities the new size cannot address. */
	reconfigure(keyCount, policy) {
		this.keyCount = keyCount;
		this.policy = policy;
		for (const [session, index] of this.affinity) if (index >= keyCount) this.affinity.delete(session);
		for (const index of [...this.cooldownUntil.keys()]) if (index >= keyCount) this.cooldownUntil.delete(index);
		for (const [stream, index] of this.lastPicked) if (index >= keyCount) this.lastPicked.delete(stream);
	}
	/** Whether one key is currently parked after a failure. */
	isCoolingDown(index) {
		const until = this.cooldownUntil.get(index);
		if (until === void 0) return false;
		if (until <= this.now()) {
			this.cooldownUntil.delete(index);
			return false;
		}
		return true;
	}
	/** Park one key so later selections step over it. */
	markFailed(index) {
		this.cooldownUntil.set(index, this.now() + KEY_COOLDOWN_MS);
	}
	/** Clear one key's cooldown, after it served a request successfully. */
	markServed(index) {
		this.cooldownUntil.delete(index);
	}
	/**
	* The key a given traffic stream last received, for failure attribution.
	* @param sessionId - the conversation, or undefined for non-Session traffic.
	* @returns the last selected index, or undefined when this stream is new.
	*/
	lastIndexFor(sessionId) {
		const index = this.lastPicked.get(sessionId ?? NON_SESSION);
		return index !== void 0 && index < this.keyCount ? index : void 0;
	}
	/**
	* Choose one key index for a request.
	*
	* Sticky mode reuses the Session's affinity; round-robin advances with the
	* ordinal. Both skip keys in cooldown, and a Session whose pinned key is
	* parked is re-pinned to the replacement so the rest of its run stays warm.
	* @param request - the Session (when any) and the request ordinal.
	* @returns the chosen index, or undefined when every key is parked.
	*/
	select(request) {
		if (this.keyCount === 0) return void 0;
		const start = this.policy === "sticky" ? this.anchor(request) : request.ordinal;
		for (let step = 0; step < this.keyCount; step += 1) {
			const index = (start + step) % this.keyCount;
			if (this.isCoolingDown(index)) continue;
			if (this.policy === "sticky" && request.sessionId !== void 0) this.pin(request.sessionId, index);
			this.remember(request.sessionId ?? NON_SESSION, index);
			return index;
		}
		const fallback = this.soonestRecovering();
		this.remember(request.sessionId ?? NON_SESSION, fallback);
		return fallback;
	}
	/** The parked key whose cooldown ends first, or 0 when none is on record. */
	soonestRecovering() {
		let best;
		let bestUntil = Number.POSITIVE_INFINITY;
		for (const [index, until] of this.cooldownUntil) {
			if (index >= this.keyCount) continue;
			if (until < bestUntil) {
				best = index;
				bestUntil = until;
			}
		}
		return best ?? 0;
	}
	/** The index a sticky selection should start from. */
	anchor(request) {
		if (request.sessionId !== void 0) {
			const pinned = this.affinity.get(request.sessionId);
			if (pinned !== void 0 && pinned < this.keyCount) return pinned;
			if (pinned === void 0) return hashSession(request.sessionId) % this.keyCount;
		}
		return request.ordinal;
	}
	/** Record one Session's affinity, evicting the oldest entry past the cap. */
	pin(sessionId, index) {
		this.affinity.delete(sessionId);
		this.affinity.set(sessionId, index);
		while (this.affinity.size > 512) {
			const oldest = this.affinity.keys().next();
			if (oldest.done === true) break;
			this.affinity.delete(oldest.value);
		}
	}
};
//#endregion
//#region src/credential-shape.ts
/**
* Shape checks for a credential VALUE, shared by both sides of a write.
*
* Dependency-free on purpose. The Host resolves a stored key while building a
* request, and the settings panel validates one as it is saved; the panel's
* bundle is forbidden from pulling in the Host's schema or credential
* machinery, so anything both sides need has to live in a module that imports
* nothing.
*/
/**
* Whether a credential value is plainly a filesystem path rather than a key.
*
* The mistake is easy to make and cost a real user an evening. Explorer's
* "Copy as path" puts exactly this shape on the clipboard, and a browser's
* duplicate-download suffix appends ` (1)` to it, so what lands in the key
* field reads as `C:\\Users\\...\\cline-key.txt (1)`.
*
* The Host's generic guard would refuse that value anyway -- a space and a
* backslash are not what a key looks like -- but its message is about HTTP
* headers, which describes the SYMPTOM and never the mistake. Naming the
* mistake is the whole point of this check.
*
* Deliberately narrow. Only shapes that cannot be a key are caught here, so a
* legitimately odd key is left to the generic guard rather than being told it
* is a path: a drive letter, a UNC prefix, or a drive-relative separator.
* @param value - the credential value.
* @returns the matching description, or undefined when it is not path-shaped.
*/
function describePathShapedSecret(value) {
	const inner = value.length >= 2 && value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
	if (/^[A-Za-z]:[\\/]/.test(inner)) return "a drive path";
	if (inner.startsWith("\\\\")) return "a UNC path";
	if (/^[A-Za-z]:[^\\/]/.test(inner)) return "a drive-relative path";
	if (/ \(\d+\)$/.test(value) && /[\\/]/.test(inner)) return "a path with a duplicate-download suffix";
}
//#endregion
//#region src/config.ts
/**
* Plugin config, validated by the same-named schemastery schema and doubling
* as the `protocom-api` settings-section shape. The `groups` dict is keyed by
* the four fixed group keys; each group becomes one provider route
* (`protocom-<key>`) when enabled, with its own credential reference.
*
* @module dsh-protocom-api/config
*/
/**
* Idle interval after which one provider stream is aborted. Mirrors the
* first-party adapters' watchdog default so a stalled endpoint cannot pin a
* request — and its socket and agent step — open forever.
*/
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
if (2147483647 !== MAX_TIMER_DELAY_MS) throw new Error("dsh-protocom-api: retry.ts MAX_RETRY_DELAY_MS must equal the harness MAX_TIMER_DELAY_MS");
/**
* The only credential references the Protocom family resolves: its own
* namespaced environment-variable names. An open shape let a rewritten
* `baseURL` pair any `process.env` name with an arbitrary endpoint, turning
* the environment fallback into an exfiltration primitive. The Go family's
* own namespace is `OPENCODE_` (see `family.ts`).
*/
const PROTOCOM_CREDENTIAL_REF = /^PROTOCOM_[A-Z0-9_]+$/;
const group = z.object({
	enabled: z.boolean().default(false),
	apiKey: z.string().role("credential-ref"),
	protocol: z.union([
		"chat-completions",
		"responses",
		"messages"
	]),
	contextLengths: z.array(z.number().step(1).min(1)),
	showBalance: z.boolean().default(true),
	replayReasoning: z.boolean().default(false),
	assistantTextReplay: z.union([
		"keep",
		"drop",
		"user"
	]).default("keep"),
	apiKeys: z.array(z.string().role("credential-ref")),
	keyPolicy: z.union(["sticky", "round-robin"]).default("sticky")
});
/**
* The settings-section schema for one family: every field shares its shape
* across families, while `baseURL` and `recommendedModels` default to the
* family's own shipped values.
*/
function sectionSchema(baseURL, recommended) {
	return z.object({
		baseURL: z.string().default(baseURL),
		allowCustomBaseURL: z.boolean(),
		streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
		retryMaxAttempts: z.number().step(1).min(0).max(100).default(20),
		retryMaxDelayMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_MAX_DELAY_MS),
		groups: z.dict(group).default({}),
		hiddenModels: z.array(z.string()).default([]),
		recommendedModels: z.array(z.string()).default([...recommended]),
		modelContexts: z.dict(z.array(z.number().step(1).min(1))).default({}),
		visionModels: z.dict(z.boolean()).default({})
	});
}
/** Settings-section schema for the `protocom-api` namespace. */
const ProtocomSection = sectionSchema(DEFAULT_BASE_URL, DEFAULT_RECOMMENDED);
/** Settings-section schema for the `opencode-go` namespace. */
const GoSection = sectionSchema(GO_DEFAULT_BASE_URL, GO_DEFAULT_RECOMMENDED);
/** Settings-section schema for the `commandcode` namespace. */
const CommandCodeSection = sectionSchema(COMMANDCODE_BASE_URL, COMMANDCODE_RECOMMENDED);
/** Settings-section schema for the `clinepass` namespace. */
const ClinePassSection = sectionSchema(CLINEPASS_BASE_URL, CLINEPASS_RECOMMENDED);
/**
* One Fusion seat. No field carries a schema default: Schemastery normalizes
* an absent seat to an empty object, and `resolveFusionSeat` reads that empty
* object as "this seat is unset" — a defaulted `provider: ''` would make the
* two indistinguishable.
*/
const fusionSeat = z.object({
	provider: z.string(),
	model: z.string(),
	reasoningEffort: z.string()
});
/**
* Settings-section schema for the `model-fusion` namespace, and the shape of
* the plugin's own `fusion` config slice. Only `enabled` defaults here; the
* seat-required-when-enabled rule is a cross-field constraint Schemastery
* cannot express, so `resolveFusion` is the authority and runs on every write.
*/
const FusionSection = z.object({
	enabled: z.boolean().default(false),
	leader: fusionSeat,
	coder: fusionSeat,
	includeForks: z.boolean().default(true),
	applyLeader: z.boolean().default(true)
});
/**
* Runtime schema for the plugin's configuration.
*
* Every section is `.volatile()`, which is what makes it appear in the
* settings form and what makes a user edit apply without remounting the plugin.
* A section left unmarked would both vanish from the form and refuse writes.
*/
const Config = z.object({
	protocom: ProtocomSection.volatile(),
	opencodeGo: GoSection.volatile(),
	commandcode: CommandCodeSection.volatile(),
	clinepass: ClinePassSection.volatile(),
	fusion: FusionSection.volatile()
});
/**
* The one explicit resolve step from raw config to validated connection
* facts. Programmatic construction may bypass Schemastery normalization, so
* every bound is re-judged here.
* @param config - raw plugin config or resolved settings snapshot.
* @returns validated connection facts for all four groups.
*/
function resolveAdapterOptions(config, family = PROTOCOM) {
	const baseURL = resolveBaseURL((config.baseURL ?? family.baseURL).replace(/\/+$/, "").replace(/\/v1$/, ""));
	if (config.allowCustomBaseURL !== true && new URL(baseURL).origin !== family.origin) throw new Error(`${family.ns}: baseURL "${baseURL}" points away from the shipped endpoint (${family.origin}); set allowCustomBaseURL: true to confirm this deployment really sends its API key there`);
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`${family.ns}: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const retryMaxAttempts = config.retryMaxAttempts ?? 20;
	if (!Number.isSafeInteger(retryMaxAttempts) || retryMaxAttempts < 0 || retryMaxAttempts > 100) throw new Error(`${family.ns}: retryMaxAttempts must be an integer between 0 and 100`);
	const retryMaxDelayMs = config.retryMaxDelayMs ?? 36e5;
	if (!Number.isFinite(retryMaxDelayMs) || retryMaxDelayMs < 500 || retryMaxDelayMs > MAX_TIMER_DELAY_MS) throw new Error(`${family.ns}: retryMaxDelayMs must be at least 500 and no greater than ${MAX_TIMER_DELAY_MS}`);
	const supplied = config.groups ?? {};
	for (const key of Object.keys(supplied)) if (!family.keys.includes(key)) throw new Error(`${family.ns}: unknown group "${key}"; expected one of ${family.keys.join(", ")}`);
	const groups = /* @__PURE__ */ new Map();
	for (const key of family.keys) {
		const source = supplied[key] ?? {};
		const defaults = family.defaults[key] ?? {
			displayName: key,
			protocol: "chat-completions"
		};
		if (source.contextLengths !== void 0) {
			if (source.contextLengths.some((length) => !Number.isSafeInteger(length) || length <= 0)) throw new Error(`${family.ns}: group "${key}" contextLengths must be positive integers`);
			if (new Set(source.contextLengths).size !== source.contextLengths.length) throw new Error(`${family.ns}: group "${key}" contextLengths must not contain duplicates`);
		}
		const effectiveLengths = source.contextLengths?.length ? source.contextLengths : defaults.contextLengths;
		const prospective = [...source.apiKey === void 0 ? [] : [source.apiKey], ...source.apiKeys ?? []];
		if (prospective.length > 17) throw new Error(`${family.ns}: group "${key}" configures more than 16 API keys`);
		const apiKeyRefs = [];
		for (const candidate of prospective) {
			if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`${family.ns}: group "${key}" apiKeys entries must be non-empty credential references`);
			if (!family.credentialRef.test(candidate)) throw new Error(`${family.ns}: group "${key}" apiKey "${describeRejectedRef(candidate)}" must match ${String(family.credentialRef)}`);
			try {
				const ref = credentialRef(candidate);
				if (apiKeyRefs.includes(ref)) throw new Error(`${family.ns}: group "${key}" repeats the credential reference "${candidate}"`);
				apiKeyRefs.push(ref);
			} catch (error) {
				if (error instanceof Error && error.message.includes("repeats the credential reference")) throw error;
				throw new Error(`${family.ns}: group "${key}" apiKey "${candidate}" is not a valid credential reference`, { cause: error });
			}
		}
		const apiKeyRef = apiKeyRefs[0];
		const keyPolicy = source.keyPolicy ?? "sticky";
		if (keyPolicy !== "sticky" && keyPolicy !== "round-robin") throw new Error(`${family.ns}: group "${key}" keyPolicy must be "sticky" or "round-robin"`);
		groups.set(key, {
			key,
			provider: family.providerOf(key),
			displayName: defaults.displayName,
			enabled: source.enabled ?? false,
			protocol: source.protocol ?? defaults.protocol,
			...apiKeyRef === void 0 ? {} : { apiKeyRef },
			apiKeyRefs,
			keyPolicy,
			...effectiveLengths === void 0 ? {} : { contextLengths: [...effectiveLengths] },
			showBalance: source.showBalance ?? true,
			replayReasoning: source.replayReasoning ?? false,
			assistantTextReplay: source.assistantTextReplay ?? "keep"
		});
	}
	const hidden = config.hiddenModels ?? [];
	for (const id of hidden) if (typeof id !== "string" || id.length === 0) throw new Error(`${family.ns}: hiddenModels entries must be non-empty model ids`);
	const recommended = config.recommendedModels ?? family.recommended;
	for (const id of recommended) if (typeof id !== "string" || id.length === 0) throw new Error(`${family.ns}: recommendedModels entries must be non-empty model ids`);
	const contexts = /* @__PURE__ */ new Map();
	for (const [id, lengths] of Object.entries(config.modelContexts ?? {})) {
		if (id.length === 0) throw new Error(`${family.ns}: modelContexts keys must be non-empty model ids`);
		if (lengths.length === 0) throw new Error(`${family.ns}: modelContexts["${id}"] must list at least one length`);
		if (lengths.some((length) => !Number.isSafeInteger(length) || length <= 0)) throw new Error(`${family.ns}: modelContexts["${id}"] lengths must be positive integers`);
		if (new Set(lengths).size !== lengths.length) throw new Error(`${family.ns}: modelContexts["${id}"] lengths must not repeat`);
		contexts.set(identityKey(id, family.registry), [...lengths].sort((left, right) => left - right));
	}
	const vision = /* @__PURE__ */ new Map();
	for (const [id, accepts] of Object.entries(config.visionModels ?? {})) {
		if (id.length === 0) throw new Error(`${family.ns}: visionModels keys must be non-empty model ids`);
		if (typeof accepts !== "boolean") throw new Error(`${family.ns}: visionModels["${id}"] must be a boolean`);
		vision.set(identityKey(id, family.registry), accepts);
	}
	return {
		family,
		baseURL,
		streamIdleTimeoutMs,
		retryMaxAttempts,
		retryMaxDelayMs,
		groups,
		modelContexts: contexts,
		visionModels: vision,
		hiddenModels: new Set(hidden),
		recommendedModels: [...new Set(recommended.map((id) => identityKey(id, family.registry)))]
	};
}
/**
* Whether a WHATWG-normalized hostname names the local loopback authority.
* The harness keeps its own copy package-internal, so this mirrors it: the
* judgement must run on the parsed hostname (WHATWG rewrites `2130706433` and
* `0x7f000001` to `127.0.0.1`), never on the raw string.
*/
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/**
* Name a rejected value without echoing the whole thing.
*
* These messages exist to tell an operator WHICH value is wrong, and the value
* is normally a credential reference like `PROTOCOM_AGGREGATE_API_KEY`. The case
* this bound exists for is a literal API key pasted into the reference field: it
* fails the same test, and an unbounded echo then carries the secret into the
* error, the log line, and any screenshot of the settings page. A short prefix
* still identifies which field to fix.
* @param value - the rejected value as configured.
* @returns a bounded excerpt, marked when it was cut.
*/
function describeRejectedRef(value) {
	const LIMIT = 32;
	return value.length <= LIMIT ? value : `${value.slice(0, LIMIT)}… (truncated)`;
}
/**
* Validate one endpoint root. Plain http is allowed only for a loopback host,
* so the stored bearer token can never be sent in the clear to a remote
* endpoint; userinfo, query strings, and fragments are refused because they
* let a value that reads as one endpoint actually resolve to another.
* @param raw - endpoint root, already stripped of trailing slashes and `/v1`.
* @returns the same string once every bound passes.
*/
function resolveBaseURL(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("protocom-api: baseURL must be an absolute http(s) URL");
	}
	if (url.username !== "" || url.password !== "") throw new Error("protocom-api: baseURL must not carry userinfo");
	if (url.search !== "" || url.hash !== "") throw new Error("protocom-api: baseURL must not carry a query string or fragment");
	if (url.protocol === "http:" ? !isLoopbackHostname(url.hostname) : url.protocol !== "https:") throw new Error("protocom-api: baseURL must use https; plain http is allowed only for a loopback host");
	return raw;
}
//#endregion
//#region src/discovery.ts
/**
* Interrogate the Protocom official API's model listing. The parser is
* tolerant on purpose: the standard OpenAI `data` array is the expected
* shape, but entries may carry an Anthropic-style `display_name`, and some
* groups disclose reasoning capabilities (`supportsReasoningEffort` /
* `reasoningEfforts`). Nothing here is stored — the registered discovery
* answers drafts a configuration surface is still editing.
*
* @module dsh-protocom-api/discovery
*/
/** Largest listing reply accepted; a truncated listing is not parseable. */
const MAX_RESPONSE_BYTES$1 = 4194304;
/**
* Longest accepted model id or label. A hostile listing can otherwise carry a
* multi-megabyte `display_name` (measured at 2.4M characters) straight into the
* model catalog and the settings UI.
*/
const MAX_TEXT_LENGTH = 256;
/** One string bound to {@link MAX_TEXT_LENGTH}. */
function bounded(value) {
	return value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value;
}
function label(...candidates) {
	for (const candidate of candidates) if (typeof candidate === "string" && candidate.length > 0) return bounded(candidate);
}
function capacity(...candidates) {
	for (const candidate of candidates) if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
}
function strings(candidate) {
	if (!Array.isArray(candidate)) return void 0;
	const values = candidate.filter((value) => typeof value === "string" && value.length > 0).map(bounded);
	return values.length === 0 ? void 0 : values;
}
/**
* Read one model-listing body. The `data` array is canonical; a top-level
* `models` array is accepted for gateway variants. Entries without a usable
* id are skipped rather than failing the whole interrogation.
*/
function parseModelsListing(body) {
	const listing = body;
	const rows = Array.isArray(listing?.data) ? listing.data : Array.isArray(listing?.models) ? listing.models : void 0;
	if (rows === void 0) throw new LlmError("the endpoint's model listing has neither a \"data\" nor a \"models\" array; enter this provider's models by hand", "DISCOVERY_FAILED");
	const models = [];
	for (const raw of rows) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const entry = raw;
		const id = label(entry.id);
		if (id === void 0) continue;
		const displayName = label(entry.display_name, entry.displayName, entry.name);
		const contextWindow = capacity(entry.context_window, entry.context_length, entry.contextWindow, entry.max_input_tokens);
		const maxTokens = capacity(entry.max_output_tokens, entry.max_tokens);
		const reasoningEfforts = strings(entry.reasoningEfforts) ?? strings(entry.reasoning_efforts);
		const supports = entry.supportsReasoningEffort === true || entry.supports_reasoning_effort === true;
		const endpoints = strings(entry.supported_endpoints) ?? strings(entry.supportedEndpoints);
		models.push({
			id,
			...displayName === void 0 ? {} : { displayName },
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens },
			...supports ? { supportsReasoningEffort: true } : {},
			...reasoningEfforts === void 0 ? {} : { reasoningEfforts },
			...endpoints === void 0 ? {} : { endpoints }
		});
	}
	return models;
}
/**
* GET the endpoint's model listing with one credential.
* @param baseURL - endpoint root; `/v1/models` is appended.
* @param apiKey - bearer token; omitted for an unauthenticated probe.
* @param signal - caller cancellation.
*/
async function fetchUpstreamModels(baseURL, apiKey, signal) {
	const url = `${baseURL}/v1/models`;
	let response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: {
				"accept": "application/json",
				...apiKey === void 0 ? {} : { "authorization": `Bearer ${apiKey}` },
				...attributionHeaders()
			},
			...signal === void 0 ? {} : { signal }
		});
	} catch (error) {
		if (signal?.aborted) throw new LlmError("model discovery aborted by caller", "ABORTED", { cause: error });
		throw new LlmError(`could not reach ${url}`, "DISCOVERY_FAILED", { cause: error });
	}
	if (!response.ok) throw new LlmError(`${url} answered ${response.status}${response.status === 401 || response.status === 403 ? "; check the API key" : ""}`, "DISCOVERY_FAILED");
	const declared = Number(response.headers.get("content-length") ?? NaN);
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES$1) {
		await response.body?.cancel();
		throw new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES$1} bytes`, "DISCOVERY_FAILED");
	}
	const reader = response.body?.getReader();
	if (reader === void 0) throw new LlmError(`${url} answered with no body`, "DISCOVERY_FAILED");
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done: finished, value } = await reader.read();
		if (finished) break;
		if (value === void 0) continue;
		total += value.byteLength;
		if (total > MAX_RESPONSE_BYTES$1) {
			await reader.cancel();
			throw new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES$1} bytes`, "DISCOVERY_FAILED");
		}
		chunks.push(value);
	}
	const text = new TextDecoder().decode(Buffer.concat(chunks, total));
	let body;
	try {
		body = JSON.parse(text);
	} catch (error) {
		throw new LlmError(`${url} did not answer with JSON`, "DISCOVERY_FAILED", { cause: error });
	}
	return parseModelsListing(body);
}
/**
* Canonical origin of an endpoint root, or `undefined` when it is not a usable
* http(s) origin. WHATWG parsing is what makes two spellings of one endpoint
* compare equal (case, punycode, default ports, IPv6 brackets) and a decorated
* one (`user@host`, `host?x`, `relay.protocom.org.evil.test`) disagree, so the
* comparison never runs on raw strings.
*/
function endpointOrigin(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		return;
	}
	if (url.username !== "" || url.password !== "") return void 0;
	if (url.protocol !== "https:" && url.protocol !== "http:") return void 0;
	return url.origin;
}
/**
* The registered model-discovery callback: interrogate the endpoint named by
* the draft (or the configured endpoint for one of this plugin's routes) and
* project the reply into harness discovery metadata. A key typed into the
* form wins over the stored one.
*/
async function discoverModels(request, signal, hooks) {
	const configured = hooks.baseURL();
	try {
		resolveBaseURL(configured);
	} catch (error) {
		throw new LlmError(`protocom-api: the configured baseURL is not usable (${error instanceof Error ? error.message : String(error)})`, "DISCOVERY_FAILED", { cause: error });
	}
	const configuredOrigin = endpointOrigin(configured);
	if (configuredOrigin === void 0) throw new LlmError("protocom-api: the configured baseURL is not a usable http(s) origin", "DISCOVERY_FAILED");
	const askedRaw = request.baseURL !== void 0 && request.baseURL.length > 0 ? request.baseURL : void 0;
	const asked = askedRaw === void 0 ? void 0 : askedRaw.replace(/\/+$/, "").replace(/\/v1$/, "");
	if (asked !== void 0) try {
		resolveBaseURL(asked);
	} catch (error) {
		throw new LlmError(`protocom-api: the probe endpoint is not usable (${error instanceof Error ? error.message : String(error)})`, "DISCOVERY_FAILED", { cause: error });
	}
	const baseURL = asked ?? configured;
	const explicit = request.apiKey !== void 0 && request.apiKey.length > 0 ? request.apiKey : void 0;
	if (explicit === void 0 && request.provider !== void 0 && asked !== void 0 && endpointOrigin(baseURL) !== configuredOrigin) throw new LlmError("protocom-api: this endpoint differs from the configured baseURL, so the stored credential is not sent; supply an apiKey for this probe, or interrogate the configured endpoint", "DISCOVERY_FAILED");
	return (await fetchUpstreamModels(baseURL, explicit ?? (request.provider === void 0 ? void 0 : await hooks.resolveApiKey(request.provider)), signal)).map((model) => ({
		id: model.id,
		...model.displayName === void 0 ? {} : { name: model.displayName },
		...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
		...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
	}));
}
/**
* Largest single event the parser will buffer, in characters. The library's
* default is unbounded, so one upstream that opens a `data:` line and never
* terminates it grows the buffer for as long as it keeps sending — the memory
* half of F6 that no transport timeout covers. The bound is generous on
* purpose: the responses protocol restates a tool call's *complete* arguments
* in a single event, so a tight cap would reject large-but-legitimate calls.
*/
const MAX_SSE_EVENT_CHARS = 8388608;
async function* read(stream) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ maxBufferSize: MAX_SSE_EVENT_CHARS }));
	try {
		for await (const { data } of events) yield data;
	} catch (error) {
		if (error instanceof ParseError && error.type === "max-buffer-size-exceeded") throw new LlmError(`SSE event exceeded ${MAX_SSE_EVENT_CHARS} characters`, "MALFORMED_RESPONSE", { cause: error });
		throw error;
	}
}
/**
* Parse a chat-completions SSE stream into data payloads. Yields `[DONE]` as
* the final value and returns; throws `LlmError('STREAM_CLOSED')` when the
* stream ends without it (a truncated response cannot be trusted).
*/
async function* parseSse(stream) {
	for await (const data of read(stream)) {
		yield data;
		if (data === "[DONE]") return;
	}
	throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}
/**
* Parse an SSE stream whose protocol may end by closing (responses): yields
* payloads through `[DONE]` or EOF, whichever comes first. Reaching EOF is not
* itself a successful end: the responses translator decides whether a terminal
* event arrived and refuses to treat a bare close as completion.
*/
async function* parseSseUntilEof(stream) {
	for await (const data of read(stream)) {
		yield data;
		if (data === "[DONE]") return;
	}
}
//#endregion
//#region src/capture.ts
/**
* Opt-in wire capture for diagnosing an upstream rejection. Nothing is written
* unless DSH_PROTOCOM_CAPTURE_DIR names a directory, so a normal deployment has
* no extra I/O and no extra on-disk copies of anything.
*
* Request *bodies* and upstream *error* bodies are captured; headers are never
* written, so no credential can reach the files. Bodies do contain the
* conversation (including tool results), which is why the switch is explicit
* and per-process rather than a stored setting.
*
* @module dsh-protocom-api/capture
*/
/** Largest body written; a capture that size is already unusable for diagnosis. */
const MAX_CAPTURE_BYTES = 8388608;
/** The configured capture directory, or undefined when capture is off. */
function captureDir() {
	const dir = process.env["DSH_PROTOCOM_CAPTURE_DIR"];
	return dir !== void 0 && dir.trim().length > 0 ? dir.trim() : void 0;
}
/**
* Write one exchange into the capture directory. Never throws: a diagnostic
* must not turn a provider error into a different provider error.
* @param capture - the exchange to record.
*/
async function captureWire(capture) {
	const dir = captureDir();
	if (dir === void 0) return;
	try {
		await mkdir(dir, { recursive: true });
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const body = JSON.stringify({
			capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
			url: capture.url,
			status: capture.status,
			request: capture.request.length > MAX_CAPTURE_BYTES ? "<request body omitted: too large>" : JSON.parse(capture.request),
			response: capture.response.slice(0, MAX_CAPTURE_BYTES)
		}, null, 2);
		await writeFile(join(dir, `${stamp}-${capture.status}.json`), body, "utf8");
	} catch {}
}
//#endregion
//#region src/protocol/http.ts
/**
* Shared transport for the two wire protocols: one POST with a JSON body
* answered by an SSE stream. Every provider request carries the harness
* attribution headers; HTTP failures map to the provider-neutral LlmError
* code taxonomy.
*
* @module dsh-protocom-api/protocol/http
*/
/** Map an HTTP status to a stable LlmError code. */
function httpErrorCode(status) {
	if (status === 401 || status === 403) return "AUTH";
	if (status === 413) return "INVALID_REQUEST";
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) return "INVALID_REQUEST";
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
/**
* Clamp one provider-supplied `Retry-After` into the policy that will consume
* it.
*
* The harness retry layer treats `providerRetryAfterMs > maxDelayMs` as
* "cancel this retry" in normal mode, so an unbounded upstream value silently
* removes the client's retry chance. The ceiling is therefore the SAME number
* the declared policy uses as its own `maxDelayMs`: forwarding the provider's
* instruction up to the deployment's configured ceiling respects it, and
* clamping at that ceiling keeps the executor's comparison unable to cancel.
* @param value - the raw `Retry-After` header, or null when absent.
* @param ceilingMs - the consuming policy's `maxDelayMs`.
* @returns the delay to forward, or undefined when there is nothing usable.
*/
function providerRetryAfterMs(value, ceilingMs) {
	if (value === null) return void 0;
	const seconds = /^\d+$/.test(value) ? Number(value) * 1e3 : NaN;
	const delay = Number.isFinite(seconds) ? seconds : Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? Math.min(delay, ceilingMs) : void 0;
}
/**
* POST one JSON body and return the SSE response. Transport and HTTP
* failures throw coded LlmErrors; the caller owns stream decoding.
*/
async function postSse(connection, path, body, signal) {
	const url = `${connection.baseURL}/v1/${path}`;
	const serialized = JSON.stringify(body);
	const label = connection.label ?? "Protocom";
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${connection.apiKey}`,
				"content-type": "application/json",
				"accept": "text/event-stream",
				...attributionHeaders(),
				...connection.headers
			},
			body: serialized,
			...signal === void 0 ? {} : { signal }
		});
	} catch (error) {
		if (signal?.aborted) throw new LlmError(`${label} request aborted by caller`, "ABORTED", { cause: error });
		throw new LlmError(`${label} API request to ${url} failed`, "TRANSPORT", { cause: error });
	}
	if (response.ok) {
		if (!response.body) throw new LlmError(`${label} API returned no response body`, "EMPTY_RESPONSE");
		return response;
	}
	let message = `${label} API error (HTTP ${response.status})`;
	const rawResponse = await response.text();
	try {
		const parsed = JSON.parse(rawResponse);
		const providerError = parsed.error;
		if (typeof providerError === "object" && providerError?.message) message = providerError.message;
		else if (typeof providerError === "string" && providerError.length > 0) message = providerError;
		else if (typeof parsed.message === "string" && parsed.message.length > 0) message = parsed.message;
		else if (rawResponse.trim().length > 0) message += `: ${rawResponse.trim().slice(0, 300)}`;
	} catch {
		if (rawResponse.trim().length > 0) message += `: ${rawResponse.trim().slice(0, 300)}`;
	}
	await captureWire({
		url,
		status: response.status,
		request: serialized,
		response: rawResponse
	});
	const delay = providerRetryAfterMs(response.headers.get("retry-after"), connection.retryAfterCeilingMs ?? 1e4);
	const id = response.headers.get("x-request-id");
	throw new LlmError(message, httpErrorCode(response.status), {
		cause: new Error(rawResponse.length > 0 ? rawResponse : `${label} HTTP ${response.status}`),
		status: response.status,
		...delay === void 0 ? {} : { providerRetryAfterMs: delay },
		...id === null || id.length === 0 ? {} : { requestId: ProviderRequestId(id) }
	});
}
//#endregion
//#region src/protocol/chat-completions.ts
/**
* OpenAI chat-completions wire protocol: request serialization (thinking
* fields ported from llm-deepseek's serialize.ts) and SSE translation into
* harness StreamChunks (after llm-deepseek's translate.ts). Three upstream
* quirks drive the differences: intermediate chunks may carry an empty-string
* `finish_reason` that means "not finished", thinking models stream
* `delta.reasoning_content`, and images ride as inline base64 `image_url`
* parts (the endpoint accepts data URLs and rejects no image input of its
* own, so the model's declared modality is the only gate).
*
* @module dsh-protocom-api/protocol/chat-completions
*/
/**
* Resolve the wire thinking fields for one request.
*
* The default `toggle` spelling sends `thinking: {type}` plus
* `reasoning_effort`: `off` disables thinking explicitly; any other effort
* enables it and rides as `reasoning_effort`; an absent effort leaves the
* provider's own default alone.
*
* `effort-only` (OpenCode Go) sends `reasoning_effort` verbatim — the gateway
* parses it without a `thinking` block, which GLM routes refuse outright — and
* the disabling word (`none`, `off`) is part of the model's advertised effort
* vocabulary rather than a special case here.
*
* `reasoning-object` (ClinePass) sends `reasoning: {enabled, effort}` and
* neither of the other two fields. Cline's reference documents no request-side
* thinking parameter at all, and the two implementations that exercised the
* surface disagree: the one that observed it on the wire reports this object
* and records that `reasoning_effort` was not what it sent. The disabling word
* is spelled `none` or `off`, matching the other modes, and an absent effort
* still leaves the provider's own default alone.
*/
function resolveThinking(effort, mode = "toggle") {
	if (mode === "effort-only") return effort === void 0 ? {} : { reasoning_effort: effort };
	if (mode === "reasoning-object") {
		if (effort === void 0) return {};
		if (effort === "none" || effort === "off") return { reasoning: { enabled: false } };
		return { reasoning: {
			enabled: true,
			effort
		} };
	}
	if (effort === "off") return { thinking: { type: "disabled" } };
	if (effort !== void 0) return {
		thinking: { type: "enabled" },
		reasoning_effort: effort
	};
	return {};
}
/**
* Map wire usage fields to the harness's DISJOINT counts: the endpoint folds
* cache hits into `prompt_tokens`, so cached reads are subtracted out of
* `inputTokens` and reported separately.
*/
function mapUsage(usage) {
	const cacheRead = usage.prompt_tokens_details?.cached_tokens;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens;
	const combined = usage.prompt_tokens + usage.completion_tokens;
	const hasExactTotal = Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0 && Number.isSafeInteger(combined) && (usage.total_tokens === void 0 || usage.total_tokens === combined);
	return {
		inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
		outputTokens: usage.completion_tokens,
		...hasExactTotal ? { totalTokens: combined } : {},
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/**
* Map the wire finish_reason vocabulary to the harness FinishReason.
* Unrecognized values become `{kind: 'error'}` with the uppercased value as
* `code`.
*/
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
function flattenText$2(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The chat-completions adapter does not support image content here.", "UNSUPPORTED_CONTENT");
}
/**
* The image parts one message's blocks resolve to, in order.
*
* An image this request did not retain contributes nothing, leaving the text
* around it to carry the turn. That is the same degradation the budget path
* already produces, rather than a second failure mode.
*/
function imageParts(blocks, images) {
	const parts = [];
	if (images === void 0 || images.size === 0) return parts;
	for (const block of blocks) {
		if (block.type !== "image") continue;
		const url = images.get(String(block.attachment.attachmentId));
		if (url !== void 0) parts.push({
			type: "image_url",
			image_url: { url }
		});
	}
	return parts;
}
/**
* The user-message content: a plain string while no image survives, otherwise
* the multimodal part list. Text parts keep their order ahead of the images,
* matching how the composer presents them.
*/
function userContent(blocks, images) {
	const text = flattenText$2(blocks);
	const retained = imageParts(blocks, images);
	if (retained.length === 0) return text;
	return [...text.length > 0 ? [{
		type: "text",
		text
	}] : [], ...retained];
}
/**
* The words that carry a tool's image across to the user item that delivers it.
*
* The image cannot stay in the tool message (see {@link wireMessage}), so it
* arrives on its own user item and needs to be attributed to the tool call that
* produced it. Without this the model sees an unexplained picture in the middle
* of a tool exchange.
*/
const TOOL_IMAGE_BRIDGE$1 = "The image returned by the tool call above:";
/**
* The wire messages one harness message becomes.
*
* An image in a TOOL RESULT is deliberately not sent on the tool message, even
* though the field accepts a part list. Verified against the live endpoints
* (2026-09-27), the two routes disagree about what that shape means, and one of
* them loses the image without saying so:
*
*  - This relay answers **200 and silently discards the image.** Asked to name
*    the colour of a red image returned by a tool, the model answered "White",
*    and "Yellow" for a green one -- it was guessing, with no error anywhere.
*    The native Responses path delivers the same image correctly, so the loss is
*    in this relay's chat-to-Responses translation rather than in the model.
*  - OpenCode Go honours it, and answers correctly.
*
* A silent wrong answer is worse than a loud failure, and no client can detect
* it: there is no status code to fall back on. So the image is moved to the
* user item that follows instead, which both routes deliver correctly --
* verified on both, on a tool result whose text was empty, and on a turn with
* two tool results where only the second carried the image.
*
* Where exactly that user item lands is {@link serializeChatRequest}'s call:
* it holds every bridge back until its whole tool run has landed, because an
* item wedged between two results of one parallel call list breaks the
* tool_call adjacency strict gateways enforce with HTTP 400.
*
* The tool message itself keeps the string form, which is what the OpenAI schema
* actually allows there (its content parts are text-only). Nothing about the
* common, image-free path changes.
*/
function wireMessage$1(message, images) {
	if (message.role === "system") return [{
		role: "system",
		content: flattenText$2(message.content)
	}];
	if (message.role === "tool") {
		const tool = {
			role: "tool",
			tool_call_id: String(message.toolCallId),
			content: flattenText$2(message.content)
		};
		const retained = imageParts(message.content, images);
		if (retained.length === 0) return [tool];
		return [tool, {
			role: "user",
			content: [{
				type: "text",
				text: TOOL_IMAGE_BRIDGE$1
			}, ...retained]
		}];
	}
	if (message.role === "user") return [{
		role: "user",
		content: userContent(message.content, images)
	}];
	throw new LlmError("assistant messages are serialized by assistantMessages()", "INVALID_REQUEST");
}
/**
* The wire messages one assistant turn becomes. An image is a caller bug here
* (assistant output is declared text-only), and the text may be dropped or
* re-attributed when the route cannot carry it.
*/
function assistantMessages(message, replayReasoning, assistantTextReplay) {
	assertTextOnly(message.content);
	const text = flattenText$2(message.content);
	const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
	const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
		id: String(block.id),
		type: "function",
		function: {
			name: block.name,
			arguments: block.arguments
		}
	}));
	const body = {
		role: "assistant",
		content: text,
		...replayReasoning && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
		...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
	};
	if (text.length === 0 || assistantTextReplay === "keep") return [body];
	if (assistantTextReplay === "drop") return [{
		...body,
		content: ""
	}];
	return [{
		role: "user",
		name: "assistant",
		content: text
	}, {
		...body,
		content: ""
	}];
}
/** The wire messages one harness message becomes, under the route's modes. */
function wireMessages(message, images, replayReasoning, assistantTextReplay) {
	if (message.role === "assistant") return assistantMessages(message, replayReasoning, assistantTextReplay);
	return wireMessage$1(message, images);
}
/** Serialize one request into the chat-completions wire body. */
function serializeChatRequest(options, model, images, replayReasoning = false, assistantTextReplay = "keep", thinking = "toggle") {
	const messages = [];
	if (options.system !== void 0) messages.push({
		role: "system",
		content: options.system
	});
	const pendingBridges = [];
	for (const message of options.messages) {
		const wire = wireMessages(message, images, replayReasoning, assistantTextReplay);
		if (message.role !== "tool") {
			messages.push(...pendingBridges.splice(0), ...wire);
			continue;
		}
		const tool = wire[0];
		if (tool !== void 0) messages.push(tool);
		pendingBridges.push(...wire.slice(1));
	}
	messages.push(...pendingBridges);
	return {
		model,
		messages,
		stream: true,
		...options.temperature === void 0 ? {} : { temperature: options.temperature },
		...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
		...options.stop === void 0 || options.stop.length === 0 ? {} : { stop: options.stop },
		...options.tools === void 0 || options.tools.length === 0 ? {} : { tools: options.tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters
			}
		})) },
		...resolveThinking(options.reasoningEffort, thinking)
	};
}
function closeBlock$2(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: ToolCallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/** `id` and `name` are identity: the wire sends each once, on the call's first delta. */
function acceptIdentity$1(current, incoming) {
	return typeof incoming === "string" && incoming.length > 0 ? incoming : current;
}
const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
/**
* Lift an inline `<think>…</think>` segment out of a streamed `content`
* string. Some routes (MiniMax M3 on OpenCode Go) emit thinking inside the
* content stream rather than on a reasoning field; keeping the tag split-safe
* across chunk boundaries is the whole job — a suffix that is a proper prefix
* of the boundary tag is buffered until the next chunk resolves it, and a
* buffered suffix that turns out not to be a tag flows through as text.
*/
var ThinkTagExtractor = class {
	pending = "";
	state = "text";
	/** Consume one content delta; emit the segments it completes. */
	feed(input) {
		this.pending += input;
		const out = [];
		for (;;) {
			const tag = this.state === "text" ? OPEN_TAG : CLOSE_TAG;
			const at = this.pending.indexOf(tag);
			if (at === -1) {
				let keep = 0;
				for (let length = Math.min(tag.length - 1, this.pending.length); length > 0; length--) if (tag.startsWith(this.pending.slice(this.pending.length - length))) {
					keep = length;
					break;
				}
				const emit = this.pending.slice(0, this.pending.length - keep);
				if (emit.length > 0) out.push({
					kind: this.state,
					text: emit
				});
				this.pending = this.pending.slice(this.pending.length - keep);
				return out;
			}
			if (at > 0) out.push({
				kind: this.state,
				text: this.pending.slice(0, at)
			});
			this.state = this.state === "text" ? "reasoning" : "text";
			this.pending = this.pending.slice(at + tag.length);
		}
	}
	/** Emit whatever remains when the stream ends; an unclosed think stays reasoning. */
	flush() {
		const out = this.pending.length > 0 ? [{
			kind: this.state,
			text: this.pending
		}] : [];
		this.pending = "";
		return out;
	}
};
/**
* Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
* `block-end`s, `usage`, and `finish` are deferred to the `[DONE]` sentinel
* so no chunk follows `finish`. A `stop` (or absent) finish with no opened
* blocks maps to an `EMPTY_RESPONSE` error finish instead of a successful
* empty message.
*/
async function* translateChatCompletions(payloads, behavior = {}) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	const think = behavior.inlineReasoning === true ? new ThinkTagExtractor() : void 0;
	function* emitReasoning(text) {
		if (text.length === 0) return;
		if (!reasoningBlock) {
			reasoningBlock = open("reasoning");
			yield {
				type: "block-start",
				index: reasoningBlock.index,
				blockType: "reasoning"
			};
		}
		reasoningBlock.text += text;
		yield {
			type: "reasoning-delta",
			index: reasoningBlock.index,
			text
		};
	}
	function* emitText(text) {
		if (text.length === 0) return;
		if (!textBlock) {
			textBlock = open("text");
			yield {
				type: "block-start",
				index: textBlock.index,
				blockType: "text"
			};
		}
		textBlock.text += text;
		yield {
			type: "text-delta",
			index: textBlock.index,
			text
		};
	}
	function* emitSegment(segment) {
		yield* segment.kind === "reasoning" ? emitReasoning(segment.text) : emitText(segment.text);
	}
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	function* closeOut() {
		if (think !== void 0) for (const segment of think.flush()) yield* emitSegment(segment);
		for (const block of order) yield {
			type: "block-end",
			index: block.index,
			block: closeBlock$2(block)
		};
		if (pendingUsage) yield {
			type: "usage",
			usage: pendingUsage
		};
		yield {
			type: "finish",
			reason: closeOutReason()
		};
	}
	/**
	* The terminal reason for a stream that ended. A `stop` (or absent) finish
	* is degenerate when the turn produced nothing model-visible: an empty
	* stream, or one whose only blocks are reasoning.
	*
	* Reasoning is the model's own scratch work, never the turn's answer, and
	* GLM-5.3 Flash on OpenCode Go intermittently ends a turn exactly there —
	* `finish_reason: "stop"` with a full `reasoning_content` and an empty
	* content delta (measured on the same prompt: 5 of 16 requests). Counting
	* the reasoning block as output reported that as a successful turn, so the
	* agent loop closed the turn with no reply and no tool call to run: from the
	* outside it is indistinguishable from a hang, and nothing retries it.
	* EMPTY_RESPONSE is on the retryable-code list the harness re-requests, so a
	* stochastic stall costs one backoff instead of the turn.
	*/
	function closeOutReason() {
		const reason = pendingFinish ?? { kind: "stop" };
		if (reason.kind !== "stop" || order.some((block) => block.kind !== "reasoning")) return reason;
		return {
			kind: "error",
			failure: {
				message: order.length === 0 ? "model returned a completed response with no content" : "model ended the turn after reasoning without a reply or a tool call",
				code: EMPTY_RESPONSE_CODE
			}
		};
	}
	for await (const payload of payloads) {
		if (payload === "[DONE]") {
			yield* closeOut();
			return;
		}
		let chunk;
		try {
			chunk = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			const reasoning = delta?.reasoning_content ?? (typeof delta?.reasoning === "string" ? delta.reasoning : void 0) ?? delta?.reasoning_details?.map((detail) => detail.text ?? "").join("");
			if (typeof reasoning === "string" && reasoning.length > 0) yield* emitReasoning(reasoning);
			const content = delta?.content;
			if (typeof content === "string" && content.length > 0) {
				if (think === void 0) yield* emitText(content);
				else for (const segment of think.feed(content)) yield* emitSegment(segment);
			}
			for (const call of delta?.tool_calls ?? []) {
				let block = toolBlocks.get(call.index);
				if (!block) {
					block = open("tool-call");
					toolBlocks.set(call.index, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				block.callId = acceptIdentity$1(block.callId, call.id);
				block.name = acceptIdentity$1(block.name, call.function?.name);
				const fragment = call.function?.arguments ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: ToolCallId(block.callId ?? ""),
					...block.name !== void 0 ? { name: block.name } : {},
					argumentsDelta: fragment
				};
			}
			if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) pendingFinish = mapFinishReason(choice.finish_reason);
		}
		if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
	}
	if (pendingFinish !== void 0) {
		yield* closeOut();
		return;
	}
	throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}
/** Stream one chat-completions call as harness chunks. */
async function* streamChatCompletions(connection, options, model, images, behavior = {}) {
	const response = await postSse(connection, "chat/completions", serializeChatRequest(options, model, images, behavior.replayReasoning ?? false, behavior.assistantTextReplay ?? "keep", behavior.thinking ?? "toggle"), options.signal);
	yield* translateChatCompletions(behavior.inlineReasoning === true ? parseSseUntilEof(response.body) : parseSse(response.body), behavior.inlineReasoning === true ? { inlineReasoning: true } : {});
}
//#endregion
//#region src/protocol/messages.ts
/**
* Anthropic Messages wire protocol (`POST /v1/messages`): request serialization
* and SSE translation into harness StreamChunks, beside the two OpenAI
* protocols this plugin already speaks.
*
* This wire is not optional decoration. Two families serve models on it and
* NOWHERE else, so before it existed those models were hidden from the menu
* entirely rather than listed and failing:
*
*  - **Command Code.** Of the 89 rows the live listing returned (2026-10-08),
*    every Claude id declares `supported_endpoints: ["/messages"]` and answers
*    400 on any OpenAI wire.
*  - **OpenCode Go.** The vendor's own endpoints table maps `claude-haiku-5-5`
*    to `https://opencode.ai/inference/go/v1/messages` with `@ai-sdk/anthropic`;
*    the same call on the chat surface fails as an unsupported model protocol.
*
* Four wire facts drive the differences from the OpenAI protocols, each of them
* load-bearing rather than stylistic:
*
*  1. `max_tokens` is REQUIRED. The OpenAI surfaces treat it as optional, so a
*     request assembled without one must still be made valid here.
*  2. The system prompt is a TOP-LEVEL parameter, not a message, and the message
*     list must not start with an assistant turn.
*  3. A tool call's arguments are a JSON OBJECT on the wire, not the string the
*     harness carries, and a tool result is a `tool_result` content block on a
*     USER message rather than its own role.
*  4. Usage is already DISJOINT: `input_tokens` excludes cache reads and cache
*     writes, which arrive as their own two counters. The OpenAI surfaces fold
*     cache hits into a prompt total and this plugin subtracts them back out;
*     nothing is subtracted here.
*
* @module dsh-protocom-api/protocol/messages
*/
/**
* The Anthropic API version this plugin speaks.
*
* The header is REQUIRED by the Messages wire; a request without it is refused
* before the model is ever reached. `2023-06-01` is the version every Anthropic
* -compatible gateway accepts, including the two this plugin routes to, and the
* header is a compatibility negotiation rather than a dated snapshot of the
* schema: later additions (extended thinking, effort) ride the same value.
*/
const ANTHROPIC_VERSION = "2023-06-01";
/**
* Wire ceiling used when the caller named none.
*
* `max_tokens` has no default on this wire — the request is rejected without
* it — while the harness leaves the field optional. 8192 is a value every model
* this plugin routes to accepts, and it is a CEILING rather than a request: a
* turn that finishes early costs nothing for the headroom.
*/
const DEFAULT_MAX_TOKENS = 8192;
/**
* The connection this wire must use.
*
* Anthropic-compatible routes authenticate with `x-api-key`, which the shared
* transport does not send. The bearer header is kept BESIDE it rather than
* replaced, because the two gateways this plugin reaches disagree about which
* one they read — Command Code accepts either, while OpenCode Go's Anthropic
* routes read the api-key header and silently ignore a bearer — and sending both
* is what makes one code path work on both without a per-family switch.
* A provider that rejected the extra header would be the only reason to split
* this, and neither of the two does.
* @param connection - the frozen connection facts for this request.
* @returns a connection with the Messages-wire headers merged in.
*/
function messagesConnection(connection) {
	return {
		...connection,
		headers: {
			...connection.headers,
			"x-api-key": connection.apiKey,
			"anthropic-version": ANTHROPIC_VERSION
		}
	};
}
/**
* Map wire usage onto the harness's disjoint counts.
*
* Nothing is subtracted: this wire already reports cache reads and cache writes
* as their own counters, disjoint from `input_tokens` — the opposite of the
* OpenAI surfaces, whose prompt total folds them in. `totalTokens` is therefore
* the exact full-call sum, and it is the number the 100K billing tier is
* measured against.
*/
function mapMessageUsage(usage) {
	const input = usage.input_tokens ?? 0;
	const output = usage.output_tokens ?? 0;
	const read = usage.cache_read_input_tokens;
	const write = usage.cache_creation_input_tokens;
	const combined = input + output + (read ?? 0) + (write ?? 0);
	return {
		inputTokens: input,
		outputTokens: output,
		...[
			input,
			output,
			read ?? 0,
			write ?? 0
		].every((count) => Number.isSafeInteger(count) && count >= 0) && Number.isSafeInteger(combined) ? { totalTokens: combined } : {},
		...read === void 0 ? {} : { cacheReadTokens: read },
		...write === void 0 ? {} : { cacheWriteTokens: write }
	};
}
/**
* Map the wire `stop_reason` onto the harness FinishReason.
*
* `end_turn` and `stop_sequence` are both a clean stop. `pause_turn` is NOT:
* it means the model suspended a long-running turn and expects the caller to
* continue it, so reporting it as a successful stop would silently truncate the
* answer. It becomes an error that names itself, exactly as an unrecognised
* value does.
*/
function mapStopReason(reason) {
	switch (reason) {
		case "end_turn": return { kind: "stop" };
		case "stop_sequence": return { kind: "stop" };
		case "tool_use": return { kind: "tool-calls" };
		case "max_tokens": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
function flattenText$1(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/**
* The source object one retained image resolves to.
*
* The adapter hands every retained image over as the inline `data:` URL the
* OpenAI surfaces accept verbatim, so the common path parses that URL into the
* base64 pair this wire wants. A plain `https:` reference is carried as a URL
* source instead, which the wire also accepts: neither gateway this plugin
* reaches was observed producing one, but dropping an image the caller supplied
* would be worse than sending a form the wire defines.
*/
function imageSource(url) {
	const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
	if (data !== null && data[1] !== void 0 && data[2] !== void 0) return {
		type: "base64",
		media_type: data[1],
		data: data[2]
	};
	if (/^https?:\/\//.test(url)) return {
		type: "url",
		url
	};
}
/** The image blocks one message's content resolves to, in order. */
function imageBlocks(blocks, images) {
	const out = [];
	if (images === void 0 || images.size === 0) return out;
	for (const block of blocks) {
		if (block.type !== "image") continue;
		const url = images.get(String(block.attachment.attachmentId));
		if (url === void 0) continue;
		const source = imageSource(url);
		if (source !== void 0) out.push({
			type: "image",
			source
		});
	}
	return out;
}
/**
* The words that carry a tool result's image across to the user turn that
* delivers it, mirroring the chat-completions bridge for the same reason.
*
* A `tool_result` block accepts only text and image content, so an image COULD
* ride inside it — but the two blocks of one parallel run must stay adjacent,
* and the safest shape is the one the chat path already had to adopt after
* measuring both routes: the image travels on the user turn that follows the
* whole tool run. Keeping the two protocols consistent also means one defect
* report describes both.
*/
const TOOL_IMAGE_BRIDGE = "The image returned by the tool call above:";
/**
* One harness message as the wire messages it becomes.
*
* `system` and `developer` are handled by the caller, which hoists system text
* into the top-level parameter and replays a developer update at its own
* position: a mid-conversation instruction has no `system` slot on this wire,
* and re-attributing it as model output (which a naive else-branch would do)
* would put words in the model's mouth.
*/
function wireMessage(message, images) {
	if (message.role === "developer") return [{
		role: "user",
		content: [{
			type: "text",
			text: flattenText$1(message.content)
		}]
	}];
	if (message.role === "user") return [{
		role: "user",
		content: userBlocks(message.content, images)
	}];
	if (message.role === "tool") {
		const text = flattenText$1(message.content);
		const block = {
			type: "tool_result",
			tool_use_id: String(message.toolCallId),
			content: text,
			...message.isError === true ? { is_error: true } : {}
		};
		const retained = imageBlocks(message.content, images);
		if (retained.length === 0) return [{
			role: "user",
			content: [block]
		}];
		return [{
			role: "user",
			content: [block]
		}, {
			role: "user",
			content: [{
				type: "text",
				text: TOOL_IMAGE_BRIDGE
			}, ...retained]
		}];
	}
	throw new LlmError("assistant messages are serialized by assistantTurns()", "INVALID_REQUEST");
}
/** One user message's content: its text, then every image this request retained. */
function userBlocks(blocks, images) {
	const text = flattenText$1(blocks);
	const parts = text.length > 0 ? [{
		type: "text",
		text
	}] : [];
	parts.push(...imageBlocks(blocks, images));
	return parts.length === 0 ? [{
		type: "text",
		text
	}] : parts;
}
/**
* A tool call's arguments as the OBJECT this wire requires.
*
* The harness carries arguments as the JSON string the model streamed, and the
* wire wants the parsed value. A string that does not parse — a truncated
* stream, a model that emitted prose — becomes an empty object rather than
* failing the whole request: the tool call is still real, its name and id are
* still correct, and one malformed call must not cost the turn.
*/
function toolInput(argumentsJson) {
	if (argumentsJson.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(argumentsJson);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
/**
* The wire messages one assistant turn becomes.
*
* Reasoning blocks are NOT replayed. Extended thinking comes back to the
* provider as a signed block, and a stateless client cannot reconstruct the
* signature, so the wire refuses one that arrives without it. The harness
* supplies reasoning blocks for display; they stay on this side of the wire.
*/
function assistantTurns(message) {
	if (contentHasImage(message.content)) throw new LlmError("The protocom-api messages adapter does not support image content on an assistant message.", "UNSUPPORTED_CONTENT");
	const blocks = [];
	const text = flattenText$1(message.content);
	if (text.length > 0) blocks.push({
		type: "text",
		text
	});
	for (const block of message.content) {
		if (block.type !== "tool-call") continue;
		blocks.push({
			type: "tool_use",
			id: String(block.id),
			name: block.name,
			input: toolInput(block.arguments)
		});
	}
	return [{
		role: "assistant",
		content: blocks
	}];
}
/**
* Merge any run of same-role wire messages into one.
*
* The wire requires the roles to alternate and a tool result to answer the
* `tool_use` block in the immediately preceding assistant turn. A parallel tool
* run produces several user messages in a row, and a bridged image adds one
* more; coalescing keeps the exchange valid without moving the blocks, which is
* what preserves the call/result adjacency.
*
* A leading assistant turn is impossible for a request the harness assembles
* (the derived history opens with the system prompt) but IS possible for a
* trimmed conversation, and the wire refuses it outright. It is dropped rather
* than reordered: a leading assistant turn carries no context the model needs.
*/
function coalesce(messages) {
	const out = [];
	for (const message of messages) {
		const last = out[out.length - 1];
		if (last !== void 0 && last.role === message.role) {
			last.content.push(...message.content);
			continue;
		}
		if (out.length === 0 && message.role === "assistant") continue;
		out.push({
			role: message.role,
			content: [...message.content]
		});
	}
	return out;
}
/**
* The thinking-control fields one request spells.
*
* Effort is the knob these models actually publish (models.dev lists
* `{type:'effort', values:['low','medium','high','xhigh','max']}` for
* `claude-haiku-5-5`), and on the current Messages wire it rides
* `output_config.effort`. The disabling words the plugin's vocabularies already
* use for the other surfaces (`none`, `off`) map to the wire's own
* `thinking: {type:'disabled'}`.
*
* This is the one detail of this module that a live request has not confirmed
* from this plugin, because no credential for either family was available when
* it was written. It is isolated here, one expression wide, precisely so that a
* deployment which measures something else changes one line instead of
* unpicking the protocol — the same treatment `CLINEPASS.chatThinking` records
* for its own unverified spelling.
*/
function resolveMessagesThinking(effort) {
	if (effort === void 0) return {};
	if (effort === "none" || effort === "off") return { thinking: { type: "disabled" } };
	return { output_config: { effort } };
}
/**
* Serialize one request into the Messages wire body.
* @param options - the assembled request.
* @param model - the upstream model id.
* @param images - provider-ready image URLs, keyed by attachment id.
* @returns the wire body.
*/
function serializeMessagesRequest(options, model, images) {
	const system = [];
	if (options.system !== void 0 && options.system.length > 0) system.push(options.system);
	const messages = [];
	const pendingBridges = [];
	for (const message of options.messages) {
		if (message.role === "system") {
			const text = flattenText$1(message.content);
			if (text.length > 0) system.push(text);
			continue;
		}
		const wire = message.role === "assistant" ? assistantTurns(message) : wireMessage(message, images);
		if (message.role !== "tool") {
			messages.push(...pendingBridges.splice(0), ...wire);
			continue;
		}
		const first = wire[0];
		if (first !== void 0) messages.push(first);
		pendingBridges.push(...wire.slice(1));
	}
	messages.push(...pendingBridges);
	return {
		model,
		messages: coalesce(messages),
		max_tokens: options.maxTokens ?? 8192,
		stream: true,
		...system.length === 0 ? {} : { system: system.join("\n\n") },
		...options.temperature === void 0 ? {} : { temperature: options.temperature },
		...options.stop === void 0 || options.stop.length === 0 ? {} : { stop_sequences: [...options.stop] },
		...options.tools === void 0 || options.tools.length === 0 ? {} : { tools: options.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters
		})) },
		...resolveMessagesThinking(options.reasoningEffort)
	};
}
/**
* A later counter, unless it is a zero the earlier event already answered.
*
* Zero is not evidence: an unset optional struct field serializes as 0, so a
* `message_delta` reporting `cache_read_input_tokens: 0` cannot mean "this turn
* read nothing from cache" when the prompt event reported 900. See `mergeUsage`.
*/
function positiveOr(later, earlier) {
	if (later !== void 0 && later > 0) return later;
	return earlier;
}
function closeBlock$1(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: ToolCallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Consume Messages SSE payloads and yield StreamChunks.
*
* Completion is the wire's own `message_stop` event, and the stream is read
* until EOF rather than to a `[DONE]` sentinel: this wire never sends one.
* Reaching EOF without a terminal event is a truncated response, EXCEPT when a
* `stop_reason` already arrived — some gateways close right after the
* `message_delta` that carries it, and that reason is the upstream's own
* completion signal (the same tolerance the chat translator extends to a Go
* route that closes without its sentinel).
*
* A `stop` with nothing model-visible to show — no text and no tool call — is
* reported as `EMPTY_RESPONSE` rather than success, for the reason the chat
* translator documents: a turn that ends after reasoning alone is indistinguish-
* able from a hang, and that code is on the retryable list.
*/
async function* translateMessages(payloads) {
	let nextIndex = 0;
	const open = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	let stopped = false;
	function openBlock(index, kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: "",
			complete: false
		};
		open.set(index, block);
		order.push(block);
		return block;
	}
	/**
	* The finish a truncated stream reports, in place of the settled one.
	*
	* A tool call the wire never closed is dropped and the finish becomes an
	* error, so the retry layer sees a cut stream instead of `tool-calls` reaching
	* the tool executor with a partial command. A reason that is ALREADY an error
	* stands: it is more specific than the truncation and must not be masked.
	*/
	function truncationReason(settled) {
		if (settled.kind === "error") return settled;
		return {
			kind: "error",
			failure: {
				message: "messages stream carried a tool call whose arguments never completed",
				code: "STREAM_CLOSED"
			}
		};
	}
	/**
	* Usage arrives split across two events — `message_start` carries the prompt
	* counters and `message_delta` the final output count — so the later event
	* refines the earlier one rather than replacing it. A counter the later event
	* omits is kept.
	*
	* A reported ZERO is treated like an omitted counter, for the cache fields as
	* well as the token counts, because neither event can assert "this turn used
	* none of X" from a zero that may just be an unset struct field. A Go-struct
	* relay that zero-fills its optional cache counters on `message_delta` would
	* otherwise erase the real count `message_start` reported, taking the total
	* that the 100K billing tier is measured on with it.
	*
	* The total is REBUILT from the merged counters and re-validated here rather
	* than carried over, so it can neither disagree with the fields beside it nor
	* escape the safety check `mapMessageUsage` applies to a single report.
	*/
	function mergeUsage(usage) {
		const next = mapMessageUsage(usage);
		const previous = pendingUsage;
		if (previous === void 0) {
			pendingUsage = next;
			return;
		}
		const inputTokens = next.inputTokens > 0 ? next.inputTokens : previous.inputTokens;
		const outputTokens = next.outputTokens > 0 ? next.outputTokens : previous.outputTokens;
		const cacheReadTokens = positiveOr(next.cacheReadTokens, previous.cacheReadTokens);
		const cacheWriteTokens = positiveOr(next.cacheWriteTokens, previous.cacheWriteTokens);
		const combined = inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
		pendingUsage = {
			inputTokens,
			outputTokens,
			...[
				inputTokens,
				outputTokens,
				cacheReadTokens ?? 0,
				cacheWriteTokens ?? 0
			].every((count) => Number.isSafeInteger(count) && count >= 0) && Number.isSafeInteger(combined) ? { totalTokens: combined } : {},
			...cacheReadTokens === void 0 ? {} : { cacheReadTokens },
			...cacheWriteTokens === void 0 ? {} : { cacheWriteTokens }
		};
	}
	function* closeOut() {
		let truncated = false;
		for (const block of order) {
			if (block.kind === "tool-call" && !block.complete) {
				truncated = true;
				continue;
			}
			yield {
				type: "block-end",
				index: block.index,
				block: closeBlock$1(block)
			};
		}
		if (pendingUsage) yield {
			type: "usage",
			usage: pendingUsage
		};
		yield {
			type: "finish",
			reason: closeOutReason(truncated)
		};
	}
	function closeOutReason(truncated) {
		const reason = pendingFinish ?? { kind: "stop" };
		if (truncated) return truncationReason(reason);
		const visible = order.some((block) => block.kind !== "reasoning" && block.text.length > 0);
		if (reason.kind !== "stop" || visible) return reason;
		return {
			kind: "error",
			failure: {
				message: order.some((block) => block.kind === "reasoning" && block.text.length > 0) ? "model ended the turn after reasoning without a reply or a tool call" : "model returned a completed response with no content",
				code: EMPTY_RESPONSE_CODE
			}
		};
	}
	for await (const payload of payloads) {
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		switch (event.type) {
			case "ping":
			case void 0: break;
			case "message_start":
				if (event.message?.usage) mergeUsage(event.message.usage);
				break;
			case "content_block_start": {
				const index = event.index ?? 0;
				const type = event.content_block?.type;
				if (type !== "text" && type !== "thinking" && type !== "tool_use") break;
				if (open.has(index)) break;
				const kind = type === "thinking" ? "reasoning" : type === "tool_use" ? "tool-call" : "text";
				const block = openBlock(index, kind);
				block.callId = event.content_block?.id;
				block.name = event.content_block?.name;
				yield {
					type: "block-start",
					index: block.index,
					blockType: kind
				};
				break;
			}
			case "content_block_delta": {
				const block = open.get(event.index ?? 0);
				if (block === void 0) break;
				const delta = event.delta;
				if (delta?.type === "text_delta" && block.kind === "text" && typeof delta.text === "string") {
					block.text += delta.text;
					yield {
						type: "text-delta",
						index: block.index,
						text: delta.text
					};
					break;
				}
				if (delta?.type === "thinking_delta" && block.kind === "reasoning" && typeof delta.thinking === "string") {
					block.text += delta.thinking;
					yield {
						type: "reasoning-delta",
						index: block.index,
						text: delta.thinking
					};
					break;
				}
				if (delta?.type === "input_json_delta" && block.kind === "tool-call" && typeof delta.partial_json === "string") {
					block.text += delta.partial_json;
					yield {
						type: "tool-call-delta",
						index: block.index,
						id: ToolCallId(block.callId ?? ""),
						...block.name === void 0 ? {} : { name: block.name },
						argumentsDelta: delta.partial_json
					};
					break;
				}
				break;
			}
			case "content_block_stop": {
				const block = open.get(event.index ?? 0);
				if (block !== void 0) block.complete = true;
				break;
			}
			case "message_delta": {
				if (event.usage) mergeUsage(event.usage);
				const stop = event.delta?.stop_reason;
				if (typeof stop === "string" && stop.length > 0) pendingFinish = mapStopReason(stop);
				break;
			}
			case "message_stop":
				stopped = true;
				break;
			case "error": {
				const message = event.error?.message ?? "upstream reported an error";
				throw new LlmError(message, "SERVER", { cause: new Error(event.error?.type ?? "messages_error") });
			}
		}
		if (stopped) {
			yield* closeOut();
			return;
		}
	}
	if (pendingFinish !== void 0) {
		yield* closeOut();
		return;
	}
	throw new LlmError("messages stream ended without a terminal event", "STREAM_CLOSED");
}
/** Stream one Messages call as harness chunks. */
async function* streamMessages(connection, options, model, images) {
	yield* translateMessages(parseSseUntilEof((await postSse(messagesConnection(connection), "messages", serializeMessagesRequest(options, model, images), options.signal)).body));
}
//#endregion
//#region src/protocol/responses.ts
/**
* OpenAI responses wire protocol (the Codex group). Minimal hand-rolled SSE
* handling: requests map messages to `input` items and the reasoning effort
* to `reasoning.effort`; stream events resolve through their payload `type`
* field, terminating at `response.completed` / `response.failed` rather than
* relying on a `[DONE]` sentinel. Images ride as inline base64
* `input_image` parts, so a multimodal model is reachable on either wire
* protocol. Tool calls stream twice on this protocol —
* identity on `response.output_item.added`, arguments on
* `response.function_call_arguments.delta`, and the complete item once more on
* `response.output_item.done` — so the terminal item only ever contributes the
* part the deltas have not already carried. Reasoning streams under three
* vocabularies (`response.reasoning.delta`, `response.reasoning_summary_text.delta`,
* and one complete restatement on the `...done` events) and all three fold
* into a single reasoning block by the same remainder rule.
*
* @module dsh-protocom-api/protocol/responses
*/
/**
* Map wire usage fields to the harness's DISJOINT counts: cached input is
* folded into `input_tokens`, so it is subtracted out and reported
* separately.
*/
function mapResponseUsage(usage) {
	const cacheRead = usage.input_tokens_details?.cached_tokens;
	const reasoning = usage.output_tokens_details?.reasoning_tokens;
	const combined = usage.input_tokens + usage.output_tokens;
	const hasExactTotal = Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0 && Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0 && Number.isSafeInteger(combined) && (usage.total_tokens === void 0 || usage.total_tokens === combined);
	return {
		inputTokens: usage.input_tokens - (cacheRead ?? 0),
		outputTokens: usage.output_tokens,
		...hasExactTotal ? { totalTokens: combined } : {},
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function inputTextItem(role, text) {
	return {
		type: "message",
		role,
		content: [{
			type: "input_text",
			text
		}]
	};
}
/**
* The content parts of one input item: the block's text first, then every image
* this request retained as the inline data URL the endpoint accepts. An item
* whose parts all failed to resolve still carries its text, because an empty
* content array is a wire error and the text is what keeps the replayed turn
* faithful.
*/
function inputParts(blocks, images) {
	const text = flattenText(blocks);
	const parts = text.length > 0 ? [{
		type: "input_text",
		text
	}] : [];
	for (const block of blocks) {
		if (block.type !== "image") continue;
		const url = images?.get(String(block.attachment.attachmentId));
		if (url !== void 0) parts.push({
			type: "input_image",
			image_url: url
		});
	}
	return parts.length === 0 ? [{
		type: "input_text",
		text
	}] : parts;
}
function wireInput(message, images) {
	if (message.role === "system") return [inputTextItem("system", flattenText(message.content))];
	if (message.role === "tool") {
		const parts = inputParts(message.content, images);
		return [{
			type: "function_call_output",
			call_id: String(message.toolCallId),
			output: parts.length === 1 && parts[0]?.type === "input_text" ? parts[0].text : parts
		}];
	}
	if (message.role === "user") return [{
		type: "message",
		role: "user",
		content: inputParts(message.content, images)
	}];
	if (contentHasImage(message.content)) throw new LlmError("The protocom-api responses adapter does not support image content on an assistant message.", "UNSUPPORTED_CONTENT");
	const items = [];
	const text = flattenText(message.content);
	if (text.length > 0) items.push({
		type: "message",
		role: "assistant",
		content: [{
			type: "output_text",
			text
		}]
	});
	for (const block of message.content) {
		if (block.type !== "tool-call") continue;
		items.push({
			type: "function_call",
			call_id: String(block.id),
			name: block.name,
			arguments: block.arguments
		});
	}
	return items;
}
/**
* Serialize one request into the responses wire body. Any effort but `off`
* maps to `reasoning.effort`; `off` and an absent effort both omit the field
* (the protocol has no explicit disabled spelling).
*/
function serializeResponsesRequest(options, model, images) {
	const input = [];
	for (const message of options.messages) input.push(...wireInput(message, images));
	const effort = options.reasoningEffort;
	return {
		model,
		input,
		stream: true,
		store: false,
		...options.system === void 0 ? {} : { instructions: options.system },
		...effort === void 0 || effort === "off" ? {} : { reasoning: { effort } },
		...options.temperature === void 0 ? {} : { temperature: options.temperature },
		...options.maxTokens === void 0 ? {} : { max_output_tokens: options.maxTokens },
		...options.tools === void 0 || options.tools.length === 0 ? {} : { tools: options.tools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		})) }
	};
}
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: ToolCallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/** `id` and `name` are identity: the wire sends each once, on the call's first event. */
function acceptIdentity(current, incoming) {
	return typeof incoming === "string" && incoming.length > 0 ? incoming : current;
}
/**
* The part of a complete text the deltas have not carried yet. Providers
* resend the complete value on the `...done` events — tool-call arguments and
* reasoning alike — so only what extends the streamed prefix is new; text that
* does not extend it is dropped rather than replayed as duplicate content.
*/
function streamedRemainder(streamed, complete) {
	if (complete === void 0 || complete.length === 0) return void 0;
	if (!complete.startsWith(streamed)) return void 0;
	return complete.slice(streamed.length);
}
/**
* Adopt one completing event's authoritative argument text, or leave the block
* unconfirmed. The event's *existence* proves nothing — the endpoint controls
* its payload too — so the text must be present and must be exactly what the
* block now holds (the streamed prefix extended by the event's remainder).
* Anything else fails closed: the flush drops the block and forces an error.
*/
function acceptComplete(block, complete) {
	if (complete === void 0 || complete.length === 0) return;
	if (block.text !== complete) return;
	block.complete = true;
}
/**
* The reasoning text one complete reasoning item carries, when it carries any.
* Providers spell the same content as `reasoning_text` parts, as summary
* parts, or as both; a provider that streams nothing and only restates the
* finished item still delivers its thinking through here.
*/
function itemReasoningText(item) {
	const parts = [...(item.content ?? []).filter((part) => part.type === "reasoning_text").map((part) => part.text ?? ""), ...(item.summary ?? []).map((part) => part.text ?? "")].filter((text) => text.length > 0);
	return parts.length === 0 ? void 0 : parts.join("");
}
/**
* Consume responses-protocol SSE payloads and yield StreamChunks. The
* terminal state must arrive as a `response.completed` / `response.incomplete`
* / `response.failed` / `error` event, or the `[DONE]` sentinel; `block-end`s,
* `usage`, and `finish` are emitted only then, so no chunk follows `finish`.
* A bare EOF is a truncated stream, not a completed turn.
*/
async function* translateResponses(payloads) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const order = [];
	let pendingFinish;
	let pendingUsage;
	let sawToolCall = false;
	/** Whether the peer explicitly ended the stream, as opposed to closing it. */
	let sawTerminal = false;
	/** One streamed call per wire identity, so its deltas and its terminal item share one block. */
	const toolBlocks = /* @__PURE__ */ new Map();
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	/** The open call block for one wire identity, created on first sight. */
	function toolBlockFor(identity) {
		let block = toolBlocks.get(identity);
		if (!block) {
			block = open("tool-call");
			toolBlocks.set(identity, block);
		}
		return block;
	}
	/** One wire identity per call: the item id when sent, else its output index. */
	function identityOf(itemId, outputIndex) {
		if (typeof itemId === "string" && itemId.length > 0) return itemId;
		if (typeof outputIndex === "number" && Number.isSafeInteger(outputIndex)) return `#${outputIndex}`;
	}
	/**
	* Adopt whatever identity this event discloses and, on the first one, open
	* the block. Identity is re-read on every event because the wire may not
	* disclose `call_id`/`name` until the item completes, and the opening
	* `block-start` must precede every delta whether or not it ever does.
	*/
	function* announce(block, id, name) {
		block.callId = acceptIdentity(block.callId, id);
		block.name = acceptIdentity(block.name, name);
		if (block.announced !== true) {
			block.announced = true;
			sawToolCall = true;
			yield {
				type: "block-start",
				index: block.index,
				blockType: "tool-call"
			};
		}
	}
	/** Append argument text and yield the delta carrying it. A confirmed block is frozen. */
	function* emitArguments(block, fragment) {
		if (block.complete === true || fragment.length === 0) return;
		block.text += fragment;
		yield {
			type: "tool-call-delta",
			index: block.index,
			id: ToolCallId(block.callId ?? ""),
			...block.name === void 0 ? {} : { name: block.name },
			argumentsDelta: fragment
		};
	}
	/**
	* Append reasoning text and yield the delta carrying it. The endpoint
	* streams reasoning under three vocabularies — a plain `delta` on
	* `response.reasoning.delta`, a summary `delta` on
	* `response.reasoning_summary_text.delta`, and a complete restatement on the
	* `...done` events — so every spelling funnels through here and the block
	* opens on whichever one carries the first text.
	*/
	function* emitReasoning(fragment) {
		if (fragment === void 0 || fragment.length === 0) return;
		if (reasoningBlock === void 0) {
			reasoningBlock = open("reasoning");
			yield {
				type: "block-start",
				index: reasoningBlock.index,
				blockType: "reasoning"
			};
		}
		reasoningBlock.text += fragment;
		yield {
			type: "reasoning-delta",
			index: reasoningBlock.index,
			text: fragment
		};
	}
	for await (const payload of payloads) {
		if (payload === "[DONE]") {
			sawTerminal = true;
			break;
		}
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		switch (event.type) {
			case "response.output_text.delta":
				if (typeof event.delta !== "string" || event.delta.length === 0) break;
				if (!textBlock) {
					textBlock = open("text");
					yield {
						type: "block-start",
						index: textBlock.index,
						blockType: "text"
					};
				}
				textBlock.text += event.delta;
				yield {
					type: "text-delta",
					index: textBlock.index,
					text: event.delta
				};
				break;
			case "response.reasoning.delta":
			case "response.reasoning_text.delta":
			case "response.reasoning_summary_text.delta":
				yield* emitReasoning(typeof event.delta === "string" ? event.delta : void 0);
				break;
			case "response.reasoning.done":
			case "response.reasoning_text.done":
			case "response.reasoning_summary_text.done":
				yield* emitReasoning(streamedRemainder(reasoningBlock?.text ?? "", typeof event.text === "string" ? event.text : void 0));
				break;
			case "response.reasoning_part.done":
			case "response.reasoning_summary_part.done":
				yield* emitReasoning(streamedRemainder(reasoningBlock?.text ?? "", typeof event.part?.text === "string" ? event.part.text : void 0));
				break;
			case "response.output_item.added": {
				const item = event.item;
				if (item?.type === "reasoning") {
					yield* emitReasoning(streamedRemainder(reasoningBlock?.text ?? "", itemReasoningText(item)));
					break;
				}
				if (item?.type !== "function_call") break;
				const identity = identityOf(item.id ?? event.item_id, event.output_index);
				if (identity === void 0) break;
				const block = toolBlockFor(identity);
				yield* announce(block, item.call_id, item.name);
				yield* emitArguments(block, item.arguments ?? "");
				break;
			}
			case "response.function_call_arguments.delta": {
				const identity = identityOf(event.item_id, event.output_index);
				if (identity === void 0 || typeof event.delta !== "string") break;
				const deltaBlock = toolBlockFor(identity);
				yield* announce(deltaBlock, void 0, void 0);
				yield* emitArguments(deltaBlock, event.delta);
				break;
			}
			case "response.function_call_arguments.done": {
				const identity = identityOf(event.item_id, event.output_index);
				if (identity === void 0) break;
				const block = toolBlockFor(identity);
				yield* announce(block, void 0, void 0);
				yield* emitArguments(block, streamedRemainder(block.text, event.arguments) ?? "");
				acceptComplete(block, event.arguments);
				break;
			}
			case "response.output_item.done": {
				const item = event.item;
				if (item?.type === "reasoning") {
					yield* emitReasoning(streamedRemainder(reasoningBlock?.text ?? "", itemReasoningText(item)));
					break;
				}
				if (item?.type !== "function_call") break;
				const identity = identityOf(item.id ?? event.item_id, event.output_index);
				const block = identity === void 0 ? open("tool-call") : toolBlockFor(identity);
				yield* announce(block, item.call_id, item.name);
				yield* emitArguments(block, streamedRemainder(block.text, item.arguments) ?? "");
				acceptComplete(block, item.arguments);
				break;
			}
			case "response.completed":
			case "response.incomplete": {
				sawTerminal = true;
				if (event.response?.usage) pendingUsage = mapResponseUsage(event.response.usage);
				const reason = event.response?.incomplete_details?.reason;
				const incomplete = event.type === "response.incomplete" || event.response?.status === "incomplete";
				pendingFinish = sawToolCall ? { kind: "tool-calls" } : reason === "max_output_tokens" || reason === "max_tokens" || incomplete && reason === void 0 ? { kind: "max-tokens" } : { kind: "stop" };
				break;
			}
			case "response.failed":
				sawTerminal = true;
				pendingFinish = {
					kind: "error",
					failure: {
						message: event.response?.error?.message ?? "the model call failed",
						code: event.response?.error?.code ?? "PROVIDER_ERROR"
					}
				};
				break;
			case "error":
				sawTerminal = true;
				pendingFinish = {
					kind: "error",
					failure: {
						message: event.message ?? "the model call failed",
						code: event.code ?? "PROVIDER_ERROR"
					}
				};
		}
	}
	if (!sawTerminal) throw new LlmError("Protocom responses stream ended before a terminal event", "STREAM_CLOSED");
	let truncated = false;
	for (const block of order) {
		if (block.kind === "tool-call" && block.complete !== true) {
			truncated = true;
			continue;
		}
		yield {
			type: "block-end",
			index: block.index,
			block: closeBlock(block)
		};
	}
	if (pendingUsage) yield {
		type: "usage",
		usage: pendingUsage
	};
	const settled = pendingFinish ?? (sawToolCall ? { kind: "tool-calls" } : { kind: "stop" });
	const reason = truncated && settled.kind !== "error" ? {
		kind: "error",
		failure: {
			message: "Protocom responses stream carried a tool call whose arguments never completed",
			code: "STREAM_CLOSED"
		}
	} : settled;
	yield {
		type: "finish",
		reason: reason.kind === "stop" && order.every((block) => block.kind === "reasoning") ? {
			kind: "error",
			failure: {
				message: order.length === 0 ? "model returned a completed response with no content" : "model ended the turn after reasoning without a reply or a tool call",
				code: EMPTY_RESPONSE_CODE
			}
		} : reason
	};
}
/** Stream one responses-protocol call as harness chunks. */
async function* streamResponses(connection, options, model, images) {
	yield* translateResponses(parseSseUntilEof((await postSse(connection, "responses", serializeResponsesRequest(options, model, images), options.signal)).body));
}
/**
* Widest total-pixel budget this plugin asks the attachment service to encode
* an image within. Since 1.7 the request image target is per OCCURRENCE
* (dimensions plus a byte target) rather than one route-wide policy, so the
* budget is applied through {@link requestImageTargetFor}.
*/
const REQUEST_IMAGE_MAX_PIXELS = 64e4;
/**
* Encoded-byte target for one request image. The attachment service keeps the
* smallest quality-ladder output when no quality fits, so this is a target
* rather than a hard refusal.
*/
const REQUEST_IMAGE_TARGET_BYTES = 1048576;
/**
* The request-image target for one attachment on this family's routes.
*
* 1.7 replaced the route-wide policy object with a per-occurrence target that
* the caller derives, which is what lets each route project an image
* differently while sharing one stored normalized copy. The projection itself
* (aspect-preserving integer dimensions inside a pixel budget) is the
* harness's own helper, so this plugin cannot drift from the first-party
* adapters' geometry.
* @param ref - the durable normalized attachment.
* @returns that occurrence's width, height, and encoded-byte target.
*/
function requestImageTargetFor(ref) {
	return {
		...requestImageDimensions(ref.width, ref.height, REQUEST_IMAGE_MAX_PIXELS),
		maxBytes: REQUEST_IMAGE_TARGET_BYTES
	};
}
/**
* Whole-request image budget: total represented bytes and image count. The
* single-image policy above bounds each image but not their sum, so a history
* that repeats images would materialize unbounded base64 on every turn. These
* mirror the first-party adapters' bounds (20 MiB, 600 images).
*/
const REQUEST_IMAGE_TOTAL_BYTES = 20971520;
/** Stable code stamped onto the stream idle watchdog's abort reason. */
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/** How long a non-exhausted stream's teardown may hold the caller after an abort. */
const TEARDOWN_GRACE_MS = 1e3;
/** One-shot async iterator over one promise, for demanding a non-stream step through the watchdog. */
function oneShot(promise, signal) {
	let consumed = false;
	return { next: async () => {
		if (consumed) return {
			done: true,
			value: void 0
		};
		consumed = true;
		return {
			done: false,
			value: await abortable(promise, signal)
		};
	} };
}
/**
* Await one promise, rejecting as soon as the signal aborts. The idle watchdog
* only *notifies* through its signal, so a pre-stream step that ignores that
* signal (a store or transport that does not observe cancellation) would
* otherwise hang the demand — and the request — forever.
*/
function abortable(promise, signal) {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}
/** Resolve after {@link TEARDOWN_GRACE_MS} without holding a Node process open. */
function teardownGrace() {
	return new Promise((resolve) => {
		setTimeout(resolve, TEARDOWN_GRACE_MS).unref?.();
	});
}
/**
* Collect every image reference one message's content carries.
*
* No recursion: since 1.7 a tool result is a first-class message of role
* `tool` whose content holds its blocks directly, so an image inside a tool
* result is already at the top level of that message and a nested walk would
* look for a block type that no longer exists.
*/
function collectImageRefs(content, refs) {
	for (const block of content) if (block.type === "image") refs.set(String(block.attachment.attachmentId), block.attachment);
}
/** The inline `data:` URL one resolved request image is transmitted as. */
function toDataUrl(image) {
	return `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}
function reasoningInfo(reasoning) {
	return {
		efforts: reasoning.efforts.map((effort) => ({
			id: ReasoningEffortId(effort),
			name: effort.charAt(0).toUpperCase() + effort.slice(1)
		})),
		...reasoning.defaultEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(reasoning.defaultEffort) }
	};
}
/** One adapter serving every enabled route of one provider family. */
var ProtocomAdapter = class extends LlmAdapter {
	config;
	listings = /* @__PURE__ */ new Map();
	/**
	* The last successfully resolved listing per group. Dispatch reads it to see
	* which endpoints the gateway declared for a model, so protocol selection
	* costs no network round trip; {@link invalidateListings} drops it with the
	* promise cache so the two can never disagree.
	*/
	resolved = /* @__PURE__ */ new Map();
	/**
	* Scraped capability catalogs, keyed by page URL. Cached because the page is
	* large (~765 KB) and changes at most daily, while the menu is built on every
	* discovery and settings read.
	*/
	capabilityCache = /* @__PURE__ */ new Map();
	/**
	* The account's subscription tier per family. Cached for the same reason the
	* catalog is: it changes at most once a billing period while the menu is
	* rebuilt on every discovery and settings read.
	*/
	tierCache = /* @__PURE__ */ new Map();
	/**
	* Stable per-adapter session id for calls that arrive without
	* `GenerateOptions.sessionId`. The OpenCode Go endpoint answers 400
	* `MissingSessionID` without one, so non-conversational traffic (title
	* generation, probes) rides this value: stable per adapter, never invented
	* per request, which keeps the gateway's session accounting honest.
	*/
	fallbackSession = `dsh-${globalThis.crypto.randomUUID()}`;
	constructor(config) {
		super();
		this.config = config;
	}
	/** The family this adapter instance serves (Protocom for hand-built options). */
	family() {
		return this.config.options().family ?? PROTOCOM;
	}
	providerInfo(provider) {
		const family = this.family();
		const key = family.groupOf(provider);
		return {
			id: provider,
			name: key === void 0 ? provider : family.defaults[key]?.displayName ?? provider
		};
	}
	providerRetryPolicy(_provider) {
		return retryPolicyFor(this.config.options());
	}
	/** The enabled group behind one route; every dispatch path starts here. */
	groupFor(provider) {
		const family = this.family();
		const key = family.groupOf(provider);
		const group = key === void 0 ? void 0 : this.config.options().groups.get(key);
		if (group === void 0 || !group.enabled) throw new LlmError(`${family.ns}: provider route "${provider}" is not an enabled group`, "NO_PROVIDER");
		return group;
	}
	/**
	* The endpoints the gateway itself declared for one model, when the last
	* listing is still cached. Serving from the cache keeps dispatch free of a
	* network round trip on the hot path; a cold cache simply falls back to the
	* group's protocol, which is what every family did before this existed.
	*/
	declaredEndpoints(group, model) {
		const cached = this.resolved.get(group.key);
		if (cached === void 0) return void 0;
		return cached.find((row) => row.id === model)?.endpoints;
	}
	/** One group's live model listing, cached briefly; failures are not cached. */
	upstreamModels(group, signal) {
		const hit = this.listings.get(group.key);
		if (hit !== void 0 && Date.now() - hit.at < 6e4) return hit.value;
		const { baseURL } = this.config.options();
		const family = this.family();
		const value = this.config.resolveApiKey(group).then((apiKey) => fetchUpstreamModels(baseURL, apiKey, signal)).then(async (rows) => {
			if (family.capabilityCatalogUrl === void 0) return rows;
			const { byId } = await this.capabilities(family);
			if (byId.size === 0) return rows;
			const tier = await this.accountTier(family, group);
			return rows.map((row) => {
				const found = catalogFor(byId, row.id);
				if (found === void 0) return row;
				if (!withinTier(found.minPlan, tier)) return {
					...row,
					outOfPlan: true
				};
				return {
					...row,
					...found.contextWindow === void 0 || row.contextWindow !== void 0 ? {} : { contextWindow: found.contextWindow },
					...found.inputCost === void 0 ? {} : { inputCost: found.inputCost },
					...found.outputCost === void 0 ? {} : { outputCost: found.outputCost },
					...found.cacheReadCost === void 0 ? {} : { cacheReadCost: found.cacheReadCost },
					...row.vision === void 0 ? { vision: found.vision } : {},
					...found.reasoning ? {} : { reasoning: false }
				};
			});
		});
		value.then((rows) => {
			if (this.listings.get(group.key)?.value === value) this.resolved.set(group.key, rows);
		}).catch(() => {
			if (this.listings.get(group.key)?.value === value) {
				this.listings.delete(group.key);
				this.resolved.delete(group.key);
			}
		});
		this.listings.set(group.key, {
			at: Date.now(),
			value
		});
		return value;
	}
	/** Forget cached listings so a configuration change re-interrogates. */
	invalidateListings() {
		this.listings.clear();
		this.resolved.clear();
	}
	/**
	* The input modalities one route advertises for one model. Image input is
	* declared wherever the model accepts it — the deployment's own choice, then
	* the registry's verified verdict, then permissive — and both wire protocols
	* carry one, so no protocol-shaped hole is left for a capability to fall
	* into.
	*/
	inputModalitiesFor(upstreamId) {
		return acceptsImages(upstreamId, this.config.options().visionModels, this.family().registry) ? ["text", "image"] : ["text"];
	}
	/**
	* The context lengths one model should be offered at, delegating to the one
	* shared expression the settings row also evaluates so the menu entries and
	* the chips cannot describe different sets.
	*/
	contextLengthsFor(group, model) {
		return contextVariantsFor(model, group.contextLengths, this.config.options().modelContexts.get(identityKey(model.upstreamId, this.family().registry)));
	}
	/** The catalog entries one model advertises, one per variant. */
	modelEntries(provider, group, model) {
		const inputModalities = this.inputModalitiesFor(model.upstreamId);
		const lengths = this.contextLengthsFor(group, model);
		if (lengths === void 0) return [{
			provider,
			id: model.upstreamId,
			name: displayNameWithContext(model.displayName, model.contextWindow),
			inputModalities
		}];
		return lengths.map((length) => ({
			provider,
			id: encodeVariantId(model.upstreamId, length),
			name: displayNameWithContext(model.displayName, length),
			inputModalities
		}));
	}
	/**
	* The capability catalog for one family, scraped from its own page and cached.
	*
	* Absent when the family names no page. A failed scrape returns an empty map
	* with the reason recorded, so callers degrade to "no capability claims"
	* rather than failing: the listing is still enough to serve models, and the
	* menu must not empty because a marketing page changed its markup.
	* @param family - the family whose page to read.
	* @returns capabilities by id, and the reason when the scrape degraded.
	*/
	async capabilities(family) {
		const url = family.capabilityCatalogUrl;
		if (url === void 0) return { byId: /* @__PURE__ */ new Map() };
		const hit = this.capabilityCache.get(url);
		if (hit !== void 0 && Date.now() - hit.at < 216e5) return hit.value;
		let value;
		try {
			const response = await fetch(url, {
				headers: { accept: "text/html" },
				redirect: "error"
			});
			if (!response.ok) value = scrapeCatalog(void 0, `the capability page answered HTTP ${response.status}`);
			else value = scrapeCatalog(await readBoundedBytes(response, MAX_CATALOG_BYTES));
		} catch (error) {
			value = scrapeCatalog(void 0, `the capability page could not be reached: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (value.problem !== void 0) this.config.log?.(family.ns + ": " + value.problem + "; models will be offered without capability claims");
		this.capabilityCache.set(url, {
			at: Date.now(),
			value
		});
		return value;
	}
	/**
	* The subscription tier this account is on, read from the family's own
	* subscription endpoint and cached.
	*
	* Needed because an endpoints listing is NOT plan-filtered: the live Command
	* Code listing advertised 82 models, but an account on `individual-goat` got
	* HTTP 403 MODEL_NOT_IN_PLAN for every Pro- and Max-tier one. Offering those
	* would put models in the menu whose every call fails.
	*
	* Any failure yields undefined, which the caller reads as "tier unknown" and
	* therefore "do not filter": hiding models on a network blip would be a worse
	* failure than showing one the account cannot use.
	* @param family - the family whose account surface to read.
	* @param group - the group whose credential authorizes the read.
	* @returns the tier name, lower case, or undefined when it could not be read.
	*/
	async accountTier(family, group) {
		const path = family.planIdPath;
		if (path === void 0) return void 0;
		const cached = this.tierCache.get(family.ns);
		if (cached !== void 0 && Date.now() - cached.at < 9e5) return cached.value;
		let value;
		try {
			const { baseURL } = this.config.options();
			const apiKey = await this.config.resolveApiKey(group);
			const response = await fetch(new URL(path, new URL(baseURL).origin).toString(), {
				headers: {
					authorization: `Bearer ${apiKey}`,
					accept: "application/json"
				},
				redirect: "error"
			});
			if (response.ok) {
				const body = JSON.parse(await readBoundedBytes(response, MAX_PLAN_BYTES));
				const planId = body.data?.planId ?? body.planId;
				value = tierFromPlanId(typeof planId === "string" ? planId : void 0);
			}
		} catch {
			value = void 0;
		}
		this.tierCache.set(family.ns, {
			at: Date.now(),
			value
		});
		return value;
	}
	/**
	* The catalog offered for one route, projected by the same function the
	* settings panel reads (model-registry's `groupCatalog`), so the models a
	* user configures for a group are exactly the models that group's menu
	* offers. Membership is that route's own listing — the credential scopes
	* what the route serves — plus the registry entries tagged for this group,
	* minus the ids the endpoint refuses on its chat route. The picker renders
	* this order verbatim and the harness calls it "adapter-preferred", so the
	* deployment's recommendation decides the head of the list.
	*/
	async listModels(provider) {
		const group = this.groupFor(provider);
		const { hiddenModels, recommendedModels, visionModels } = this.config.options();
		let listing;
		try {
			listing = await this.upstreamModels(group);
		} catch {
			listing = void 0;
		}
		if (this.family().listingIsMembership === false) listing = void 0;
		return groupCatalog(group.key, listing, {
			hidden: hiddenModels,
			recommended: recommendedModels,
			vision: visionModels,
			family: this.family()
		}).flatMap((model) => this.modelEntries(provider, group, model));
	}
	/**
	* Whether a capability source stated that this model cannot reason at all.
	* @param group - the group whose listing is consulted.
	* @param upstreamId - the upstream model id.
	* @returns true only for a definite negative verdict; false when unstated.
	*/
	async modelCannotReason(group, upstreamId) {
		try {
			return (await this.upstreamModels(group)).find((model) => model.id === upstreamId)?.reasoning === false;
		} catch {
			return false;
		}
	}
	/** Endpoint-disclosed reasoning vocabulary for one model, when the listing says any. */
	async disclosedReasoning(group, upstreamId) {
		try {
			const row = (await this.upstreamModels(group)).find((model) => model.id === upstreamId);
			if (row?.reasoningEfforts === void 0 || row.reasoningEfforts.length === 0) return void 0;
			return {
				efforts: row.reasoningEfforts,
				defaultEffort: row.reasoningEfforts.includes("high") ? "high" : row.reasoningEfforts[0]
			};
		} catch {
			return;
		}
	}
	async modelInfoFor(group, provider, model) {
		const { upstreamId, contextWindow: variant } = decodeVariantId(model);
		const family = this.family();
		const entry = matchRegistry(upstreamId, family.registry);
		const contextWindow = variant ?? entry?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
		let displayName = entry?.displayName;
		if (displayName === void 0) try {
			const row = (await this.upstreamModels(group)).find((candidate) => candidate.id === upstreamId);
			displayName = row?.displayName !== void 0 && row.displayName !== upstreamId ? row.displayName : upstreamId;
		} catch {
			displayName = upstreamId;
		}
		const reasoning = await this.modelCannotReason(group, upstreamId) ? void 0 : entry?.reasoning ?? await this.disclosedReasoning(group, upstreamId) ?? family.reasoningFor?.(upstreamId) ?? family.defaults[group.key]?.reasoning;
		return {
			provider,
			id: model,
			name: displayNameWithContext(displayName, contextWindow),
			inputModalities: this.inputModalitiesFor(upstreamId),
			context: { contextWindow },
			...reasoning === void 0 ? {} : { reasoning: reasoningInfo(reasoning) }
		};
	}
	resolveModel(provider, model, _signal) {
		return this.modelInfoFor(this.groupFor(provider), provider, model);
	}
	async prepareCall(provider, model, _signal) {
		const group = this.groupFor(provider);
		return {
			model: await this.modelInfoFor(group, provider, model),
			stream: (options) => this.streamWithGroup(options, group)
		};
	}
	stream(options) {
		return this.streamWithGroup(options, this.groupFor(options.provider));
	}
	async *streamWithGroup(options, group) {
		const { baseURL, streamIdleTimeoutMs } = this.config.options();
		const family = this.family();
		const sessionId = options.sessionId === void 0 ? void 0 : String(options.sessionId);
		const apiKey = await this.config.resolveApiKey(group, sessionId);
		const headers = family.sessionHeader === void 0 ? void 0 : (() => {
			const session = options.sessionId === void 0 ? this.fallbackSession : String(options.sessionId);
			return {
				[family.sessionHeader]: session,
				"x-deepseek-harness-session-id": session
			};
		})();
		const connection = {
			baseURL,
			apiKey,
			label: family.label,
			retryAfterCeilingMs: this.config.options().retryMaxDelayMs,
			...headers === void 0 ? {} : { headers }
		};
		const model = stripVariantId(options.model);
		const consumer = new AbortController();
		const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
		const watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE);
		const callOptions = {
			...options,
			signal: watchdog.signal
		};
		let iterator;
		let exhausted = false;
		try {
			const pending = this.protocolCall(connection, callOptions, group, model);
			const started = await watchdog.next(oneShot(pending, watchdog.signal));
			if (started.done === true) throw new LlmError("Protocom adapter produced no stream", "TRANSPORT");
			iterator = started.value[Symbol.asyncIterator]();
			for (;;) {
				const result = await watchdog.next(iterator);
				if (result.done) {
					exhausted = true;
					return;
				}
				yield result.value;
			}
		} catch (error) {
			if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError(`${family.label} stream idle for ${streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
			if (options.signal?.aborted) throw new LlmError(`${family.label} request aborted by caller`, "ABORTED", { cause: error });
			const code = error.code;
			if (code === "AUTH" || code === "RATE_LIMIT") this.config.reportKeyFailure?.(group, sessionId);
			throw error;
		} finally {
			consumer.abort(`${family.label} stream consumer stopped`);
			watchdog[Symbol.dispose]();
			if (!exhausted && iterator !== void 0 && iterator.return !== void 0) {
				const pendingReturn = iterator.return();
				try {
					await Promise.race([pendingReturn, teardownGrace()]);
				} catch {}
			}
		}
	}
	/**
	* The wire call for this request's protocol, with this request's image
	* budget applied first. Both protocols carry images: an image resolves to an
	* inline data URL either way, so a group's protocol can no longer decide
	* whether a multimodal model is reachable with one.
	*/
	async protocolCall(connection, options, group, model) {
		const { images, messages } = await this.resolveRequestImages(options, model);
		const projected = messages === options.messages ? options : {
			...options,
			messages: [...messages]
		};
		const family = this.family();
		const entry = matchRegistry(model, family.registry);
		const protocol = entry?.protocol ?? protocolForEndpoints(this.declaredEndpoints(group, model)) ?? group.protocol;
		if (protocol === "messages") return streamMessages(connection, projected, model, images);
		return protocol === "responses" ? streamResponses(connection, projected, model, images) : streamChatCompletions(connection, projected, model, images, {
			replayReasoning: group.replayReasoning,
			assistantTextReplay: group.assistantTextReplay,
			thinking: family.chatThinking,
			inlineReasoning: entry?.inlineReasoning
		});
	}
	/**
	* Resolve every image this request carries into the inline data URL the
	* endpoint accepts, applying the whole-request budget first. The harness
	* already projects images away from a text-only route before dispatch, so a
	* retained image here means the route declared the `image` modality; the
	* guard still covers direct adapter use.
	* @param options - the assembled request.
	* @param options - the assembled request.
	* @param model - the upstream model id, variant suffix already stripped.
	* @returns provider-ready data URLs (absent when the request has none) and the
	* message projection the caller must serialize.
	*/
	async resolveRequestImages(options, model) {
		const family = this.family();
		const projected = projectOffloadedImages(options.messages, (ref) => offloadedImageText(ref));
		const refs = /* @__PURE__ */ new Map();
		for (const message of projected) collectImageRefs(message.content, refs);
		if (refs.size === 0) return {
			images: void 0,
			messages: projected
		};
		if (!acceptsImages(model, this.config.options().visionModels)) throw new LlmError(`${family.label} model "${model}" does not accept image input.`, "UNSUPPORTED_CONTENT");
		const attachments = this.config.resolveAttachments?.();
		if (attachments === void 0) throw new LlmError(`${family.label} image input requires the durable attachment service.`, "UNSUPPORTED_CONTENT");
		const ordered = [...refs.values()];
		const resolved = await Promise.all(ordered.map((ref) => attachments.readImageRequest(ref, requestImageTargetFor(ref), options.signal)));
		const rawBytes = /* @__PURE__ */ new Map();
		ordered.forEach((ref, index) => {
			rawBytes.set(String(ref.attachmentId), resolved[index].data.byteLength);
		});
		const offloadImages = requiredImageOffload(projected, {
			representation: "base64",
			maxBytes: REQUEST_IMAGE_TOTAL_BYTES,
			maxImages: 600
		}, (block) => rawBytes.get(String(block.attachment.attachmentId)) ?? 0);
		if (offloadImages > 0) throw new LlmError(`${family.label} request images exceed the route budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`, IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages });
		const images = /* @__PURE__ */ new Map();
		ordered.forEach((ref, index) => {
			images.set(String(ref.attachmentId), toDataUrl(resolved[index]));
		});
		return {
			images: images.size === 0 ? void 0 : images,
			messages: projected
		};
	}
};
//#endregion
//#region src/balance-view.ts
function numberField$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function stringField$1(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
/**
* Normalize one usage-report object. Quota deployments carry
* `quota{limit,used,remaining}`; subscription deployments carry `balance`,
* `planName`, and a `subscription` block. Unrecognized fields are ignored, and
* both shapes may coexist.
* @param body - a non-null, non-array object.
*/
function normalizeUsage(body) {
	const report = body;
	const today = report.usage?.today;
	const balance = {};
	const mode = stringField$1(report.mode);
	if (mode !== void 0) balance.mode = mode;
	const status = stringField$1(report.status);
	if (status !== void 0) balance.status = status;
	const unit = stringField$1(report.unit);
	if (unit !== void 0) balance.unit = unit;
	const limit = numberField$1(report.quota?.limit);
	if (limit !== void 0) balance.limit = limit;
	const used = numberField$1(report.quota?.used);
	if (used !== void 0) balance.used = used;
	const remaining = numberField$1(report.quota?.remaining ?? report.remaining);
	if (remaining !== void 0) balance.remaining = remaining;
	const balanceField = numberField$1(report.balance);
	if (balanceField !== void 0) balance.balance = balanceField;
	const planName = stringField$1(report.planName);
	if (planName !== void 0) balance.planName = planName;
	const dailyUsageUsd = numberField$1(report.subscription?.daily_usage_usd);
	if (dailyUsageUsd !== void 0) balance.dailyUsageUsd = dailyUsageUsd;
	const dailyLimitUsd = numberField$1(report.subscription?.daily_limit_usd);
	if (dailyLimitUsd !== void 0) balance.dailyLimitUsd = dailyLimitUsd;
	const expiresAt = stringField$1(report.subscription?.expires_at);
	if (expiresAt !== void 0) balance.expiresAt = expiresAt;
	const todayRequests = numberField$1(today?.requests);
	if (todayRequests !== void 0) balance.todayRequests = todayRequests;
	const todayCost = numberField$1(today?.cost);
	if (todayCost !== void 0) balance.todayCost = todayCost;
	const rpm = numberField$1(report.usage?.rpm);
	if (rpm !== void 0) balance.rpm = rpm;
	const tpm = numberField$1(report.usage?.tpm);
	if (tpm !== void 0) balance.tpm = tpm;
	return balance;
}
/**
* Re-validate one balance value that crossed a trust boundary. The browser
* casts the JSON body to {@link GroupBalance}; a malformed or hostile reply
* must not reach `toFixed`/`slice` and crash the strip. Only recognized,
* well-typed fields survive, and a value that is not an object is refused
* rather than half-accepted.
*/
function parseBalanceView(body) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return void 0;
	return normalizeUsage(body);
}
/** Normalize one billing-rate reply; absent fields stay absent. */
function parseRateMultiplier(body) {
	const parsed = {};
	if (body === null || typeof body !== "object" || Array.isArray(body)) return parsed;
	const report = body;
	const rateMultiplier = numberField$1(report.resolved_rate_multiplier);
	if (rateMultiplier !== void 0) parsed.rateMultiplier = rateMultiplier;
	const groupRateMultiplier = numberField$1(report.group_rate_multiplier);
	if (groupRateMultiplier !== void 0) parsed.groupRateMultiplier = groupRateMultiplier;
	return parsed;
}
//#endregion
//#region src/balance.ts
/**
* Balance queries against the Protocom official API's usage endpoint, with a
* 60-second per-group cache and a fenced Fetch surface the settings page polls.
* Quota-limited and subscription/wallet deployments answer with different
* shapes; both normalize into {@link GroupBalance}. The billing-rate endpoint
* is absent on simple deployments, so its failure is never fatal.
*
* The HTTP surface is a Host `connection.fetch` route, not a self-registered
* `webServer` exact route. Reachability is entirely the active carrier's
* policy: the Web carrier applies the Host/Origin fence plus browser
* authentication before dispatching here, while the desktop and webworker
* carriers serve `/api/*` directly over their IPC channel, which is their own
* trust boundary. This handler therefore implements no authorization of its own
* and never inspects the peer address.
*
* @module dsh-protocom-api/balance
*/
const RATE_MULTIPLIER_PATH = "/v1/sub2api/billing";
/**
* Normalize one `/v1/usage` reply, refusing a body that is not an object.
* @throws LlmError code `BALANCE_FAILED` for a non-object reply.
*/
function parseUsage(body) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) throw new LlmError("the usage endpoint did not answer with an object", "BALANCE_FAILED");
	return normalizeUsage(body);
}
function cacheKey(key, includeRates) {
	return `${key}|${includeRates ? "rates" : "plain"}`;
}
/** Per-group balance queries with a 60-second cache and a bounded failure backoff. */
var BalanceService = class BalanceService {
	hooks;
	/** Cache lifetime for one group's balance. */
	static TTL_MS = 6e4;
	cache = /* @__PURE__ */ new Map();
	failedAt = /* @__PURE__ */ new Map();
	constructor(hooks) {
		this.hooks = hooks;
	}
	/** Forget every cached balance (a configuration change may alter any group). */
	invalidate() {
		this.cache.clear();
		this.failedAt.clear();
	}
	/**
	* One group's balance, served from cache while fresh.
	* @param key - the group to query.
	* @param includeRates - whether to also read the optional billing-rate endpoint.
	*/
	balance(key, includeRates = false) {
		const options = this.hooks.options();
		const group = options.groups.get(key);
		if (group === void 0 || !group.enabled) return Promise.reject(new LlmError(`protocom-api: group "${key}" is not enabled`, "BALANCE_FAILED"));
		const entryKey = cacheKey(key, includeRates);
		const hit = this.cache.get(entryKey);
		if (hit !== void 0 && Date.now() - hit.at < BalanceService.TTL_MS) return hit.value;
		const failedAt = this.failedAt.get(key);
		if (failedAt !== void 0 && Date.now() - failedAt < 5e3) return Promise.reject(new LlmError(`protocom-api: group "${key}" balance is backing off after a failure`, "BALANCE_FAILED"));
		const value = this.fetchBalance(options.baseURL, group, includeRates);
		value.then(() => {
			this.failedAt.delete(key);
		}, () => {
			this.failedAt.set(key, Date.now());
			if (this.cache.get(entryKey)?.value === value) this.cache.delete(entryKey);
		});
		this.cache.set(entryKey, {
			at: Date.now(),
			value
		});
		return value;
	}
	async fetchBalance(baseURL, group, includeRates) {
		const headers = {
			"accept": "application/json",
			"authorization": `Bearer ${await this.hooks.resolveApiKey(group)}`,
			...attributionHeaders()
		};
		const usageUrl = `${baseURL}/v1/usage`;
		let response;
		try {
			response = await fetch(usageUrl, {
				method: "GET",
				headers
			});
		} catch (error) {
			throw new LlmError(`could not reach ${usageUrl}`, "BALANCE_FAILED", { cause: error });
		}
		if (!response.ok) throw new LlmError(`${usageUrl} answered ${response.status}${response.status === 401 || response.status === 403 ? "; check the API key" : ""}`, "BALANCE_FAILED", { status: response.status });
		const balance = parseUsage(await response.json());
		if (!includeRates) return balance;
		try {
			const rates = await fetch(`${baseURL}${RATE_MULTIPLIER_PATH}`, {
				method: "GET",
				headers
			});
			if (rates.ok) return {
				...balance,
				...parseRateMultiplier(await rates.json())
			};
		} catch {}
		return balance;
	}
};
/**
* Response headers every balance answer carries. Account state is live and
* sensitive, so it is never cacheable and never sniffable as another type.
*/
const JSON_HEADERS$2 = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff"
};
function json$1(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...JSON_HEADERS$2 }
	});
}
function describeError$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Build the `GET /api/protocom-api/balance` Fetch handler for the Host's shared
* `/api` channel. Authorization belongs to the carrier, which applies its trust
* policy before dispatch (the `connection.fetch.register` contract), so this
* handler never inspects the peer address or the Host header. `?group=<key>`
* selects one enabled group and opts into the billing-rate enrichment; omission
* answers every enabled, balance-reporting group. Per-group failures land beside
* the healthy groups as a fixed `{error}` row: the message names neither the
* credential reference nor any caller-supplied input, and the detail goes to the
* local log instead.
*/
function balanceFetchHandler(service, hooks) {
	return async (request) => {
		if (request.method !== "GET") return new Response(null, {
			status: 405,
			headers: {
				...JSON_HEADERS$2,
				allow: "GET"
			}
		});
		const groupParam = new URL(request.url).searchParams.get("group");
		const options = hooks.options();
		if (groupParam !== null) {
			const group = options.groups.get(groupParam);
			if (group === void 0 || !group.enabled || !group.showBalance) return json$1(404, { error: "no enabled balance-reporting group" });
			try {
				return json$1(200, await service.balance(group.key, true));
			} catch (error) {
				hooks.log?.(`protocom-api: balance query for group "${group.key}" failed: ${describeError$1(error)}`);
				return json$1(502, { error: "the balance query failed" });
			}
		}
		const groups = {};
		await Promise.all([...options.groups.values()].filter((group) => group.enabled && group.showBalance).map(async (group) => {
			try {
				groups[group.key] = await service.balance(group.key);
			} catch (error) {
				hooks.log?.(`protocom-api: balance query for group "${group.key}" failed: ${describeError$1(error)}`);
				groups[group.key] = { error: "the balance query failed" };
			}
		}));
		return json$1(200, { groups });
	};
}
//#endregion
//#region src/usage-view.ts
function numberField(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function stringField(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function normalizeWindow(value) {
	if (value === null || typeof value !== "object") return void 0;
	const window = {};
	const percent = numberField(value.percent);
	if (percent !== void 0) window.percent = percent;
	const status = stringField(value.status);
	if (status !== void 0) window.status = status;
	const resetsAt = stringField(value.resetsAt);
	if (resetsAt !== void 0) window.resetsAt = resetsAt;
	return window;
}
/**
* Re-validate one usage reply that crossed a trust boundary. The browser
* casts the JSON body to {@link GoUsageView}; a malformed or hostile reply
* must not reach a `toFixed`/`Date.parse` and crash the strip. Unrecognized
* fields are ignored and a non-object body is refused rather than
* half-accepted.
*/
function parseGoUsage(body) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return void 0;
	const usage = body.usage ?? body;
	if (usage === null || typeof usage !== "object") return void 0;
	const view = {};
	const rolling = normalizeWindow(usage.rolling);
	if (rolling !== void 0) view.rolling = rolling;
	const weekly = normalizeWindow(usage.weekly);
	if (weekly !== void 0) view.weekly = weekly;
	const monthly = normalizeWindow(usage.monthly);
	if (monthly !== void 0) view.monthly = monthly;
	return view;
}
/**
* The subscription's quota, served from cache while fresh. The key is the
* family's single `go` group; a disabled or keyless group answers the failure
* the strip displays.
*/
var GoUsageService = class GoUsageService {
	hooks;
	/** Cache lifetime for one quota reply. */
	static TTL_MS = 6e4;
	cached;
	failedAt;
	constructor(hooks) {
		this.hooks = hooks;
	}
	/** Forget the cached reply (a configuration change may alter the group). */
	invalidate() {
		this.cached = void 0;
		this.failedAt = void 0;
	}
	/** The whole account's quota windows. */
	usage() {
		const options = this.hooks.options();
		const group = options.groups.get("go");
		if (group === void 0 || !group.enabled) return Promise.reject(new LlmError("opencode-go: group \"go\" is not enabled", "USAGE_FAILED"));
		if (this.cached !== void 0 && Date.now() - this.cached.at < GoUsageService.TTL_MS) return this.cached.value;
		if (this.failedAt !== void 0 && Date.now() - this.failedAt < 5e3) return Promise.reject(new LlmError("opencode-go: the usage query is backing off after a failure", "USAGE_FAILED"));
		const value = this.fetchUsage(options.baseURL, group);
		value.then(() => {
			this.failedAt = void 0;
		}, () => {
			this.failedAt = Date.now();
			if (this.cached?.value === value) this.cached = void 0;
		});
		this.cached = {
			at: Date.now(),
			value
		};
		return value;
	}
	async fetchUsage(baseURL, group) {
		const apiKey = await this.hooks.resolveApiKey(group);
		const url = `${baseURL}/v1/usage`;
		let response;
		try {
			response = await fetch(url, {
				method: "GET",
				headers: {
					"accept": "application/json",
					"authorization": `Bearer ${apiKey}`,
					...attributionHeaders()
				}
			});
		} catch (error) {
			throw new LlmError(`could not reach ${url}`, "USAGE_FAILED", { cause: error });
		}
		if (!response.ok) throw new LlmError(`${url} answered ${response.status}${response.status === 401 || response.status === 403 ? "; check the API key" : ""}`, "USAGE_FAILED", { status: response.status });
		const parsed = parseGoUsage(await response.json());
		if (parsed === void 0) throw new LlmError("the usage endpoint did not answer with a usage object", "USAGE_FAILED");
		return parsed;
	}
};
/**
* Response headers every usage answer carries. Account state is live and
* sensitive, so it is never cacheable and never sniffable as another type.
*/
const JSON_HEADERS$1 = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff"
};
function json(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...JSON_HEADERS$1 }
	});
}
function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Build the `GET /api/opencode-go/usage` Fetch handler for the Host's shared
* `/api` channel. Authorization belongs to the carrier, which applies its
* trust policy before dispatch (the `connection.fetch.register` contract), so
* this handler never inspects the peer address or the Host header. A disabled
* or missing `go` group answers 404; an upstream failure answers a fixed
* `{error}` row — the message names neither the credential reference nor any
* caller-supplied input, and the detail goes to the local log instead.
*/
function goUsageFetchHandler(service, hooks) {
	return async (request) => {
		if (request.method !== "GET") return new Response(null, {
			status: 405,
			headers: {
				...JSON_HEADERS$1,
				allow: "GET"
			}
		});
		const group = hooks.options().groups.get("go");
		if (group === void 0 || !group.enabled) return json(404, { error: "the OpenCode Go group is not enabled" });
		try {
			return json(200, await service.usage());
		} catch (error) {
			hooks.log?.(`opencode-go: usage query failed: ${describeError(error)}`);
			return json(502, { error: "the usage query failed" });
		}
	};
}
//#endregion
//#region src/commandcode-view.ts
/** A finite number, or undefined. */
function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** Read one object member as a record, or undefined. */
function rec(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/**
* Normalize one rolling window.
* @param raw - the window object from the reply.
* @returns the window, or undefined when it carries nothing usable.
*/
function parseCommandCodeWindow(raw) {
	const source = rec(raw);
	if (source === void 0) return void 0;
	const used = num(source["used"]);
	const cap = num(source["cap"]);
	if (used === void 0 || cap === void 0) return void 0;
	const resetAt = num(source["resetAt"]);
	return {
		used,
		cap,
		remaining: Math.max(cap - used, 0),
		percent: cap > 0 ? Math.min(Math.max(Math.round(used / cap * 100), 0), 100) : 0,
		exceeded: source["exceeded"] === true,
		...resetAt === void 0 ? {} : { resetAt }
	};
}
/**
* Normalize the credits reply.
* @param body - the parsed `/alpha/billing/credits` body.
* @returns the credit state, or undefined when the body is unusable.
*/
function parseCommandCodeCredits(body) {
	const credits = rec(rec(body)?.["credits"]);
	const limits = rec(rec(body)?.["windowLimits"]);
	if (credits === void 0 && limits === void 0) return void 0;
	const monthlyCredits = num(credits?.["monthlyCredits"]);
	const purchasedCredits = num(credits?.["purchasedCredits"]);
	const freeCredits = num(credits?.["freeCredits"]);
	const fiveHour = parseCommandCodeWindow(limits?.["fiveHour"]);
	const weekly = parseCommandCodeWindow(limits?.["weekly"]);
	const result = {
		...monthlyCredits === void 0 ? {} : { monthlyCredits },
		...purchasedCredits === void 0 ? {} : { purchasedCredits },
		...freeCredits === void 0 ? {} : { freeCredits },
		...fiveHour === void 0 ? {} : { fiveHour },
		...weekly === void 0 ? {} : { weekly }
	};
	return Object.keys(result).length === 0 ? void 0 : result;
}
/**
* Normalize the usage reply.
*
* `successRate` is published as a percentage, but a fraction is accepted and
* scaled: a value at or below 1 that is not exactly 0 or 1 is read as a
* fraction, which is the only reading under which the number means anything.
* @param body - the parsed `/alpha/usage/summary` body.
* @returns the usage totals, or undefined when the body is unusable.
*/
function parseCommandCodeUsage(body) {
	const source = rec(body);
	if (source === void 0) return void 0;
	const rawRate = num(source["successRate"]);
	const successRatePercent = rawRate === void 0 ? void 0 : rawRate > 1 && rawRate <= 100 ? rawRate : rawRate >= 0 && rawRate <= 1 ? rawRate * 100 : void 0;
	const requests = num(source["totalCount"]);
	const completed = num(source["completedCount"]);
	const failed = num(source["failedCount"]);
	const cost = num(source["totalCost"]);
	const averageCost = num(source["averageCost"]);
	const tokensIn = num(source["totalTokensIn"]);
	const tokensOut = num(source["totalTokensOut"]);
	const tokens = num(source["totalTokens"]);
	const periodBasis = typeof source["periodBasis"] === "string" && source["periodBasis"].length > 0 ? source["periodBasis"] : void 0;
	const result = {
		...requests === void 0 ? {} : { requests },
		...completed === void 0 ? {} : { completed },
		...failed === void 0 ? {} : { failed },
		...cost === void 0 ? {} : { cost },
		...averageCost === void 0 ? {} : { averageCost },
		...successRatePercent === void 0 ? {} : { successRatePercent },
		...tokensIn === void 0 ? {} : { tokensIn },
		...tokensOut === void 0 ? {} : { tokensOut },
		...tokens === void 0 ? {} : { tokens },
		...periodBasis === void 0 ? {} : { periodBasis }
	};
	return Object.keys(result).length === 0 ? void 0 : result;
}
/**
* Normalize the whole account surface from the two replies, either of which may
* be missing. A read failure on one half never clears the other.
* @param creditsBody - the parsed credits body, when the read succeeded.
* @param usageBody - the parsed usage body, when the read succeeded.
* @returns the account state, or undefined when neither half is usable.
*/
function parseCommandCodeAccount(creditsBody, usageBody) {
	const credits = creditsBody === void 0 ? void 0 : parseCommandCodeCredits(creditsBody);
	const usage = usageBody === void 0 ? void 0 : parseCommandCodeUsage(usageBody);
	if (credits === void 0 && usage === void 0) return void 0;
	return {
		...credits === void 0 ? {} : { credits },
		...usage === void 0 ? {} : { usage }
	};
}
//#endregion
//#region src/commandcode-account.ts
/**
* The Command Code account surface handler: reads the two `/alpha/*` endpoints
* and answers the normalized shape the settings strip renders.
*
* Mirrors `balance.ts`/`go-usage.ts`: a cached service plus a fenced Fetch
* route, so the account panel rides the Host's own trust fence (the Web
* carrier's Host/Origin check plus browser cookie, or the desktop IPC boundary)
* rather than an unauthenticated exact route.
*
* Every endpoint degrades independently: a failure on one half is reported for
* that half and never blanks the other, which is what keeps a partial outage
* from looking like an empty account.
*
* @module dsh-protocom-api/commandcode-account
*/
/** How long one successful account read is reused. */
const CACHE_TTL_MS = 6e4;
/** How long a failed read is left alone before retrying. */
const FAILURE_BACKOFF_MS = 5e3;
/** Largest reply accepted from either endpoint. */
const MAX_RESPONSE_BYTES = 1048576;
/**
* Read one endpoint's JSON body, or a failure description.
*
* The returned `error` is rendered to the operator as plugin text, so it stays
* a fixed phrase naming the endpoint. The transport's own words go to `log`,
* because they quote upstream bytes -- a parse failure embeds a snippet of the
* body that caused it, which a hostile upstream can shape into apparent UI copy.
* @param baseURL - the family's endpoint root.
* @param path - the account path to read.
* @param apiKey - resolved credential.
* @param log - sink for the detail that must not reach the reply.
* @param signal - caller cancellation.
* @returns the parsed body, or a fixed description of what went wrong.
*/
async function readJson(baseURL, path, apiKey, log, signal) {
	const url = baseURL.replace(/\/+$/, "") + path;
	let response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${apiKey}`,
				...attributionHeaders()
			},
			...signal === void 0 ? {} : { signal }
		});
	} catch (error) {
		log(`${COMMANDCODE.ns}: account read of ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
		return { error: `could not reach ${path}` };
	}
	if (!response.ok) return {
		status: response.status,
		error: `${path} answered ${response.status}`
	};
	try {
		return { body: JSON.parse(await readBoundedBytes(response, MAX_RESPONSE_BYTES)) };
	} catch (error) {
		log(`${COMMANDCODE.ns}: account read of ${path} was unusable: ${error instanceof Error ? error.message : String(error)}`);
		return { error: `${path} did not answer usable JSON` };
	}
}
/** Cached reader for one family's account surface. */
var CommandCodeAccountService = class {
	hooks;
	cache = /* @__PURE__ */ new Map();
	failedAt = /* @__PURE__ */ new Map();
	constructor(hooks) {
		this.hooks = hooks;
	}
	/** Forget cached reads; called when the family's settings change. */
	invalidate() {
		this.cache.clear();
		this.failedAt.delete(COMMANDCODE.ns);
	}
	/**
	* Read the account surface for one group.
	* @param group - the group whose credential authorizes the read.
	* @param signal - caller cancellation.
	* @returns the normalized account state with a per-half outcome.
	*/
	async read(group, signal) {
		const { baseURL } = this.hooks.options();
		const apiKey = await this.hooks.resolveApiKey(group);
		const root = new URL(baseURL).origin;
		let credits;
		let usage;
		try {
			[credits, usage] = await Promise.all([COMMANDCODE.creditsPath === void 0 ? Promise.resolve({ error: "no credits endpoint configured" }) : readJson(root, COMMANDCODE.creditsPath, apiKey, this.hooks.log, signal), COMMANDCODE.usagePath === void 0 ? Promise.resolve({ error: "no usage endpoint configured" }) : readJson(root, COMMANDCODE.usagePath, apiKey, this.hooks.log, signal)]);
		} catch (error) {
			if (signal?.aborted) throw new LlmError("Command Code account read aborted by caller", "ABORTED", { cause: error });
			throw error;
		}
		const view = buildView(credits, usage);
		if (credits.status === 401 || credits.status === 403 || usage.status === 401 || usage.status === 403) view.credentialRejected = true;
		for (const half of [credits, usage]) if (half.error !== void 0) this.hooks.log(`${COMMANDCODE.ns}: ${half.error}`);
		return view;
	}
	/**
	* Read with the standard cache and failure backoff.
	* @param group - the group whose credential authorizes the read.
	* @param signal - caller cancellation.
	* @returns the cached or freshly read account state.
	*/
	async readCached(group, signal) {
		const key = group.key;
		const hit = this.cache.get(key);
		if (hit !== void 0 && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
		const failed = this.failedAt.get(key);
		if (failed !== void 0 && Date.now() - failed < FAILURE_BACKOFF_MS) return hit?.value ?? {
			credits: { reachable: false },
			usage: { reachable: false }
		};
		try {
			const value = await this.read(group, signal);
			this.failedAt.delete(key);
			this.cache.set(key, {
				at: Date.now(),
				value
			});
			return value;
		} catch (error) {
			this.failedAt.set(key, Date.now());
			this.cache.delete(key);
			throw error;
		}
	}
};
/** Assemble the view from the two halves' outcomes. */
function buildView(credits, usage) {
	const normalized = parseCommandCodeAccount(credits.body, usage.body);
	return {
		...normalized === void 0 ? {} : { account: normalized },
		credits: {
			reachable: credits.error === void 0,
			...credits.error === void 0 ? {} : { error: credits.error }
		},
		usage: {
			reachable: usage.error === void 0,
			...usage.error === void 0 ? {} : { error: usage.error }
		}
	};
}
/** Headers every account answer carries: live and sensitive, never cacheable. */
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff"
};
/**
* Build the fenced Fetch handler for the Command Code account route.
* @param service - the cached account reader.
* @param hooks - the family's options and credential resolution.
* @returns a handler answering the normalized account view.
*/
function commandCodeAccountFetchHandler(service, hooks) {
	return async (request) => {
		if (request.method !== "GET") return new Response(null, {
			status: 405,
			headers: {
				...JSON_HEADERS,
				allow: "GET"
			}
		});
		const only = new URL(request.url).searchParams.get("group");
		const groups = [...hooks.options().groups.values()].filter((group) => group.enabled);
		const selected = only === null ? groups : groups.filter((group) => group.key === only);
		if (selected.length === 0) return new Response(JSON.stringify({
			account: null,
			credits: { reachable: false },
			usage: { reachable: false }
		}), {
			status: 200,
			headers: JSON_HEADERS
		});
		try {
			const view = await service.readCached(selected[0], request.signal);
			return new Response(JSON.stringify(view), {
				status: 200,
				headers: JSON_HEADERS
			});
		} catch (error) {
			hooks.log(`${COMMANDCODE.ns}: account read failed: ${error instanceof Error ? error.message : String(error)}`);
			return new Response(JSON.stringify({
				account: null,
				credits: {
					reachable: false,
					error: "account read failed"
				},
				usage: {
					reachable: false,
					error: "account read failed"
				}
			}), {
				status: 502,
				headers: JSON_HEADERS
			});
		}
	};
}
//#endregion
//#region src/fusion.ts
/**
* Fusion dual-model routing — the browser-safe core.
*
* One settings section names two seats: the LEADER that plans and reviews the
* main conversation, and the CODER that every delegated subagent request is
* pinned to. This module owns the namespace, the stored shape, and the
* resolution both halves agree on; `fusion-host.ts` turns a resolved value
* into the Host-side request rewrite, and the client section edits it.
*
* Deliberately import-free, like `family.ts` and `model-registry.ts`: the
* browser client reads the same descriptors as the Host.
*
* @module dsh-protocom-api/fusion
*/
/**
* Diagnostic label for this feature, and the settings-page cell key.
*
* It is NOT a settings namespace: 1.7 keys a form by Loader entry, and this
* section is the `fusion` field of the plugin's single Config. The name
* survives because log lines and the sidebar cell still need a stable word for
* it.
*/
const FUSION_NS = "model-fusion";
/** Reject an empty or untrimmed effort id, which no adapter vocabulary carries. */
function resolveEffort(name, raw) {
	if (raw === void 0) return void 0;
	if (raw.length === 0 || raw.trim() !== raw) throw new Error(`${FUSION_NS}: the ${name} seat reasoningEffort must be a non-empty effort id`);
	return raw;
}
/**
* Validate one seat. A seat with no provider, model, and effort is "unset"
* rather than invalid, because Schemastery normalizes an absent seat to an
* empty object; naming only one half of a route is always a mistake.
* @param name - which seat this is, for the refusal message.
* @param seat - the stored seat, if any.
* @returns the validated seat, or undefined when the seat is unset.
*/
function resolveFusionSeat(name, seat) {
	const provider = seat?.provider ?? "";
	const model = seat?.model ?? "";
	const effort = resolveEffort(name, seat?.reasoningEffort);
	if (provider === "" && model === "" && effort === void 0) return void 0;
	if (provider === "" || model === "") throw new Error(`${FUSION_NS}: the ${name} seat needs both a provider and a model`);
	return {
		provider,
		model,
		...effort === void 0 ? {} : { reasoningEffort: effort }
	};
}
/**
* The one explicit resolve step from a stored section to the facts the Host
* routes on. Enabling without both seats is refused here rather than at
* request time, so an unusable configuration fails at its write.
* @param config - raw section or resolved settings snapshot.
* @returns the validated routing facts.
*/
function resolveFusion(config) {
	const enabled = config.enabled ?? false;
	const leader = resolveFusionSeat("leader", config.leader);
	const coder = resolveFusionSeat("coder", config.coder);
	if (enabled && leader === void 0) throw new Error(`${FUSION_NS}: enabled Fusion requires a leader seat`);
	if (enabled && coder === void 0) throw new Error(`${FUSION_NS}: enabled Fusion requires a coder seat`);
	return {
		enabled,
		...leader === void 0 ? {} : { leader },
		...coder === void 0 ? {} : { coder },
		includeForks: config.includeForks ?? true,
		applyLeader: config.applyLeader ?? true
	};
}
/**
* Whether two seats name the same route and effort — the editor's dirty check,
* where an absent effort and an empty one are the same "model default".
* @param left - one seat, if any.
* @param right - the other seat, if any.
* @returns whether both seats are interchangeable.
*/
function sameFusionSeat(left, right) {
	if (left === void 0 || right === void 0) return left === right;
	return left.provider === right.provider && left.model === right.model && (left.reasoningEffort ?? void 0) === (right.reasoningEffort ?? void 0);
}
//#endregion
//#region src/fusion-host.ts
/**
* Read the lineage facts a rewrite needs. Typed structurally — the rule only
* ever reads these two header fields — so it stays testable against a plain
* object and independent of the Agent class.
* @param session - the Agent's Session, or anything exposing its header.
* @returns the durable lineage facts; an unknown shape reads as a root session.
*/
function subagentFacts(session) {
	return {
		origin: session?.header?.origin,
		isSeeded: session?.header?.isSeeded ?? false
	};
}
/**
* Apply the Fusion coder pin to one resolved call configuration.
*
* A seat's absent effort CLEARS the inherited one rather than leaving it: the
* parent's effort id belongs to the parent's own model vocabulary, and the
* harness makes the same choice when a delegation changes the route
* (`resolveChildAgentOptions` deletes it). Every other field — notably
* `maxTokens`, `temperature`, and `stop` — is preserved, because those are
* properties of the call rather than of the route.
* @param resolved - the configuration the loop resolved.
* @param fusion - the live section value.
* @param facts - the requesting Agent's lineage.
* @returns the configuration to use; `resolved` itself when no rule applies.
*/
function fuseCallConfig(resolved, fusion, facts) {
	if (!fusion.enabled) return resolved;
	if (facts.origin !== "subagent") return resolved;
	if (facts.isSeeded && !fusion.includeForks) return resolved;
	const coder = fusion.coder;
	if (coder === void 0) return resolved;
	const effort = coder.reasoningEffort === void 0 ? void 0 : ReasoningEffortId(coder.reasoningEffort);
	if (resolved.provider === coder.provider && resolved.model === coder.model && resolved.reasoningEffort === effort) return resolved;
	const { reasoningEffort: _inherited, ...rest } = resolved;
	return {
		...rest,
		provider: coder.provider,
		model: coder.model,
		...effort === void 0 ? {} : { reasoningEffort: effort }
	};
}
/**
* Mount Fusion on one Host context: apply its routing rule to every agent's
* request.
*
* The listener is `global` so it sees agents created in any scope — subagent
* children run in their own scope, and an ancestor listener is the only place
* all of them pass through — and `prepend` so it sits at the outside of the
* chain: its `await next()` therefore observes every other listener's decision
* and takes the final word. A listener registered later with `prepend` would
* wrap this one; no shipped component performs a competing `agent/request`
* route rewrite (model selection resolves through agent options, which this
* rule intentionally overrides).
* @param ctx - the plugin's Host context.
* @param read - reads the section from the Loader entry's live config.
* @returns the live source, for tests and for the client-facing helpers.
*/
function mountFusion(ctx, read) {
	const source = () => read();
	let lastRaw;
	let lastGood;
	const current = () => {
		const raw = source();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveFusion(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error(`${FUSION_NS}: keeping the last good configuration after an invalid settings section`);
			ctx.logger.error(error);
			return lastGood;
		}
	};
	current();
	ctx.on("agent/request", async ({ agent }, next) => {
		return fuseCallConfig(await next(), current(), subagentFacts(agent.session));
	}, {
		global: true,
		prepend: true
	});
	ctx.on("loader/volatile-update", () => {
		try {
			resolveFusion(source());
		} catch (error) {
			ctx.logger.error(`${FUSION_NS}: the fusion section is not usable`);
			ctx.logger.error(error);
		}
	});
	return {
		current,
		raw: () => source()
	};
}
//#endregion
//#region src/index.ts
const name = "protocom-api";
const inject = ["llm"];
/** Mount one provider family: adapter, routes, settings section, telemetry. */
function mountFamily(ctx, family, sectionKey, section, telemetry) {
	const ns = family.ns;
	const current = () => section();
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw, family);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error(`${ns}: keeping the last good configuration after an invalid settings section`);
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	/** Resolve one reference to a usable key value, or throw naming where to fix it. */
	const resolveRef = async (ref, provider) => {
		if (!family.credentialRef.test(ref)) throw new LlmError(`${ns}: credential reference "${describeRejectedRef(ref)}" is outside this family's credential namespace`, "MISSING_CREDENTIAL");
		/**
		* The value once it is usable, or a message naming what is wrong with it.
		*
		* The path check runs FIRST because it is the one mistake the generic guard
		* describes only by its symptom. A user who pasted `C:\\Users\\...\\key.txt`
		* is told the value has characters an HTTP header cannot carry, which is
		* true and useless: the fix is to paste the key, not to sanitize a path.
		*/
		const usable = (value) => {
			const shape = describePathShapedSecret(value);
			if (shape !== void 0) throw new LlmError(`${ns}: the value stored for ${ref} is ${shape}, not an API key. Paste the key itself -- the text you copy from the provider -- rather than the file it was saved in.`, "INVALID_CREDENTIAL");
			return assertUsableApiKey(value, "dsh-protocom-api", ref);
		};
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(ref);
			if (hit?.value !== void 0) return usable(hit.value);
		}
		const ambient = process.env[ref];
		if (ambient !== void 0 && ambient.length > 0) return usable(ambient);
		throw new LlmError(`${ns}: no API key for provider route "${provider}"; store ${ref} through the credentials service, or export ${ref} in the launching environment`, "MISSING_CREDENTIAL");
	};
	/**
	* One pool per group, keyed by group key. Rebuilt in place when the group's
	* key set or policy changes, so a live conversation's affinity survives an
	* unrelated settings edit instead of paying one cold cache read for it.
	*/
	const pools = /* @__PURE__ */ new Map();
	const ordinal = { count: 0 };
	const poolFor = (group) => {
		const refs = group.apiKeyRefs;
		const signature = `${group.keyPolicy}\u0000${refs.join("\0")}`;
		let entry = pools.get(group.key);
		if (entry === void 0) {
			entry = {
				pool: new KeyPool(refs.length, group.keyPolicy),
				signature
			};
			pools.set(group.key, entry);
		} else if (entry.signature !== signature) {
			entry.pool.reconfigure(refs.length, group.keyPolicy);
			entry.signature = signature;
		}
		return entry.pool;
	};
	const resolveApiKey = async (group, sessionId) => {
		const refs = group.apiKeyRefs;
		if (refs.length === 0) throw new LlmError(`${ns}: no API key configured for provider route "${group.provider}"; set groups.${group.key}.apiKey in the "${ns}" settings section to a credential reference`, "MISSING_CREDENTIAL");
		const ref = refs.length === 1 ? refs[0] : (() => {
			ordinal.count += 1;
			const index = poolFor(group).select({
				...sessionId === void 0 ? {} : { sessionId },
				ordinal: ordinal.count
			});
			return refs[index ?? 0];
		})();
		return await resolveRef(ref, group.provider);
	};
	/**
	* Park the key a failed request used, so the pool steps past it next time.
	* Only credential-shaped failures qualify: a 5xx or a malformed request is
	* not evidence about the key, and parking on it would rotate a healthy
	* account out of service for a minute.
	* @param group - the group whose key failed.
	* @param sessionId - the conversation that was being served, when any.
	*/
	const reportKeyFailure = (group, sessionId) => {
		if (group.apiKeyRefs.length < 2) return;
		const pool = poolFor(group);
		const failing = pool.lastIndexFor(sessionId);
		if (failing !== void 0) pool.markFailed(failing);
	};
	const adapter = new ProtocomAdapter({
		options,
		resolveApiKey,
		reportKeyFailure,
		log: (message) => {
			ctx.logger.warn(message);
		},
		resolveAttachments: () => ctx.get("attachments")
	});
	const quota = telemetry({
		options,
		resolveApiKey,
		log: (message) => {
			ctx.logger.warn(message);
		}
	});
	let syncRoutes = () => {};
	ctx.effect(() => {
		const directory = ctx.llm.registerConfigurableProviders(family.keys.map((key) => ({
			provider: family.providerOf(key),
			displayName: family.defaults[key]?.displayName ?? key,
			settingsNs: PROTOCOM_NS,
			settingsPath: [
				sectionKey,
				"groups",
				key
			]
		})));
		const discovery = ctx.llm.registerModelDiscovery(ns, (request, signal) => family.listingIsMembership === false ? Promise.resolve(registryDiscovery(family)) : discoverModels(request, signal, {
			baseURL: () => options().baseURL,
			resolveApiKey: async (provider) => {
				const group = [...options().groups.values()].find((candidate) => candidate.provider === provider);
				if (group === void 0) return void 0;
				if (!group.enabled) throw new Error(`${ns}: group "${group.key}" is disabled; toggle it on in the "${ns}" settings section before discovering models`);
				return await resolveApiKey(group);
			}
		}));
		let registration;
		const sync = () => {
			const routes = [...options().groups.values()].filter((group) => group.enabled).map((group) => group.provider);
			if (registration === void 0) {
				if (routes.length === 0) return;
				registration = ctx.llm.registerAdapter(routes, adapter);
			} else registration.replace(routes);
		};
		syncRoutes = sync;
		sync();
		return () => {
			syncRoutes = () => {};
			registration?.();
			directory();
			discovery();
		};
	});
	ctx.on("loader/volatile-update", () => {
		syncRoutes();
		adapter.invalidateListings();
		quota.invalidate();
	});
	quota.mount(ctx);
}
/** The Protocom balance surface: per-group currency balance plus rate enrich. */
function protocomTelemetry(hooks) {
	const balance = new BalanceService({
		options: hooks.options,
		resolveApiKey: hooks.resolveApiKey
	});
	return {
		invalidate: () => {
			balance.invalidate();
		},
		mount: (ctx) => {
			ctx.inject(["connection"], (connectionCtx) => {
				const connection = Reflect.get(connectionCtx, "connection");
				if (connection === void 0) return;
				const path = PROTOCOM.telemetryPath;
				if (path === void 0) return;
				connectionCtx.effect(() => connection.fetch.register({
					path,
					methods: ["GET"],
					requestBody: "buffered",
					fetch: balanceFetchHandler(balance, {
						options: hooks.options,
						resolveApiKey: hooks.resolveApiKey,
						log: hooks.log
					})
				}));
			});
		}
	};
}
/** The Go quota surface: the subscription's rolling/weekly/monthly windows. */
function goTelemetry(hooks) {
	const usage = new GoUsageService({
		options: hooks.options,
		resolveApiKey: hooks.resolveApiKey
	});
	return {
		invalidate: () => {
			usage.invalidate();
		},
		mount: (ctx) => {
			ctx.inject(["connection"], (connectionCtx) => {
				const connection = Reflect.get(connectionCtx, "connection");
				if (connection === void 0) return;
				const path = OPENCODE_GO.telemetryPath;
				if (path === void 0) return;
				connectionCtx.effect(() => connection.fetch.register({
					path,
					methods: ["GET"],
					requestBody: "buffered",
					fetch: goUsageFetchHandler(usage, {
						options: hooks.options,
						resolveApiKey: hooks.resolveApiKey,
						log: hooks.log
					})
				}));
			});
		}
	};
}
/**
* The Command Code account surface: credit balances, rolling windows, and usage
* totals from the `/alpha/*` endpoints, all verified live on 2026-09-23.
*/
function commandCodeTelemetry(hooks) {
	const account = new CommandCodeAccountService({
		options: hooks.options,
		resolveApiKey: (group) => hooks.resolveApiKey(group),
		log: hooks.log
	});
	return {
		invalidate: () => {
			account.invalidate();
		},
		mount: (ctx) => {
			ctx.inject(["connection"], (connectionCtx) => {
				const connection = Reflect.get(connectionCtx, "connection");
				if (connection === void 0) return;
				const path = COMMANDCODE.telemetryPath;
				if (path === void 0) return;
				connectionCtx.effect(() => connection.fetch.register({
					path,
					methods: ["GET"],
					requestBody: "buffered",
					fetch: commandCodeAccountFetchHandler(account, {
						options: hooks.options,
						resolveApiKey: (group) => hooks.resolveApiKey(group),
						log: hooks.log
					})
				}));
			});
		}
	};
}
/**
* The models one family advertises when its endpoint's listing is not its
* catalog.
*
* Reads the family's own registry, keeps the entries tagged for its group --
* which is what makes them menu members in the first place -- and drops the
* ones the vendor has retired, so a probe cannot advertise a model the
* subscription no longer serves.
* @param family - the family whose registry answers for it.
* @returns the discovered rows, in registry order.
*/
function registryDiscovery(family) {
	const refused = new Set(family.refused);
	return family.registry.filter((entry) => family.keys.some((key) => entry.groups?.includes(key) === true)).filter((entry) => !refused.has(entry.id)).map((entry) => ({
		id: entry.id,
		name: entry.displayName,
		contextWindow: entry.contextWindow
	}));
}
/**
* A family that ships no account surface.
*
* ClinePass is the case: Cline's API reference documents no balance, quota or
* usage endpoint, and the subscription's own usage lives on a web dashboard
* behind a browser session rather than behind an API key. Mounting a route
* anyway would mean guessing a response shape no request confirmed, and a
* wrong guess renders as a broken panel rather than as "not supported here".
* So the family declares `telemetryPath: undefined` and mounts nothing.
*/
function noTelemetry() {
	return {
		invalidate: () => {},
		mount: () => {}
	};
}
/**
* The Loader entry id this plugin's settings form is keyed by.
*
* 1.7 names a form after its profile row, so this must match the `id` in
* `cordis.patch.yml`. It is also the namespace every configured-provider entry
* reports, because all four families now live in one Config.
*/
const PROTOCOM_NS = PROTOCOM.ns;
/** Mount the four provider families and the routing layer over them. */
function apply(ctx, config) {
	mountFamily(ctx, PROTOCOM, "protocom", () => config.protocom.get(), protocomTelemetry);
	mountFamily(ctx, OPENCODE_GO, "opencodeGo", () => config.opencodeGo.get(), goTelemetry);
	mountFamily(ctx, COMMANDCODE, "commandcode", () => config.commandcode.get(), commandCodeTelemetry);
	mountFamily(ctx, CLINEPASS, "clinepass", () => config.clinepass.get(), noTelemetry);
	mountFusion(ctx, () => config.fusion.get());
}
//#endregion
export { ANTHROPIC_VERSION, BalanceService, CommandCodeAccountService, CONTEXT_100K, CONTEXT_LADDER, Config, DEFAULT_BASE_URL, DEFAULT_BASE_URL_ORIGIN, DEFAULT_MAX_TOKENS, DEFAULT_RECOMMENDED, DEFAULT_STREAM_IDLE_TIMEOUT_MS, FALLBACK_CONTEXT_WINDOW, FAMILIES, FUSION_NS, FusionSection, GO_CREDENTIAL_REF, GO_DEFAULT_BASE_URL, GO_DEFAULT_BASE_URL_ORIGIN, GO_DEFAULT_RECOMMENDED, GO_REFUSED_MODEL_IDS, GO_REGISTRY, GROUP_DEFAULTS, GROUP_KEYS, GoSection, GoUsageService, MAX_RETRY_ATTEMPTS, MAX_RETRY_DELAY_MS, OPENCODE_GO, PROTOCOM, PROTOCOM_CREDENTIAL_REF, PROTOCOM_NS, ProtocomAdapter, ProtocomSection, REFUSED_CHAT_MODEL_IDS, REGISTRY, RETRYABLE_FAILURE_CODES, RETRY_INITIAL_DELAY_MS, RETRY_JITTER_RATIO, ThinkTagExtractor, acceptsImages, apply, balanceFetchHandler, catalogEntry, contextChoicesFor, contextLabel, contextStepsFor, contextVariantsFor, decodeVariantId, discoverModels, displayNameWithContext, encodeVariantId, endpointOrigin, fetchUpstreamModels, fuseCallConfig, goUsageFetchHandler, groupCatalog, groupOf, identityKey, inject, mapMessageUsage, mapStopReason, matchRegistry, messagesConnection, modelIdentities, mountFusion, name, normalizeUsage, parseBalanceView, parseGoUsage, parseModelsListing, parseRateMultiplier, parseUsage, providerOf, resolveAdapterOptions, resolveBaseURL, resolveFusion, resolveFusionSeat, resolveMessagesThinking, retryBudgetSpanMs, retryPolicyFor, sameFusionSeat, serializeMessagesRequest, servesChat, servesGroup, streamMessages, stripVariantId, subagentFacts, translateMessages, variantLengths };
