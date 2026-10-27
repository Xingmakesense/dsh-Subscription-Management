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

export const Config = {
    "~standard": { version: 1, vendor: "dsh-subscription-management", validate: normalizeOptions }
};
