import z from "@deepseek-ai/schemastery";
import { FAMILIES } from "./provider-runtime/protocom-api.js";

const DEFAULT_OPTIONS = Object.freeze({ enabled: true });

export function normalizeOptions(config) {
    if (config === undefined || config === null) return { value: { ...DEFAULT_OPTIONS } };
    if (typeof config !== "object" || Array.isArray(config)) {
        return { issues: [{ message: "plugin config must be an object" }] };
    }
    const enabled = config.enabled ?? true;
    if (typeof enabled !== "boolean") return { issues: [{ message: "enabled must be a boolean" }] };
    return { value: { ...config, enabled } };
}

const group = z.object({
    enabled: z.boolean().default(false),
    protocol: z.union(["chat-completions", "responses", "messages"]),
    contextLengths: z.array(z.number().step(1).min(1)),
    showBalance: z.boolean().default(true),
    replayReasoning: z.boolean().default(false),
    assistantTextReplay: z.union(["keep", "drop", "user"]).default("keep")
});

function providerSection(family) {
    return z.object({
        baseURL: z.string().default(family.baseURL),
        allowCustomBaseURL: z.boolean(),
        streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).default(300_000),
        groups: z.dict(group).default({}),
        hiddenModels: z.array(z.string()).default([]),
        recommendedModels: z.array(z.string()).default([...family.recommended]),
        modelContexts: z.dict(z.array(z.number().step(1).min(1))).default({}),
        visionModels: z.dict(z.boolean()).default({})
    }).volatile();
}

/** Native DSH model settings only: no author retry, Fusion, or custom UI schema. */
export const Config = z.object({
    enabled: z.boolean().default(true),
    providers: z.object(Object.fromEntries(
        FAMILIES.map((family) => [family.sectionKey, providerSection(family)])
    )).default({})
});
