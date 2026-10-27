import { installAccountData, accountTest } from "./host/accounts.js";
import { Config, normalizeOptions } from "./host/options.js";
import { recordStatus } from "./host/status.js";

export const name = "dsh-subscription-management";
export const inject = [];
export { Config, normalizeOptions };

export const __test = Object.freeze({
    ...accountTest,
    normalizeOptions
});

export function apply(ctx, config) {
    const normalized = normalizeOptions(config);
    if (normalized.value?.enabled !== true) {
        recordStatus("plugin", { phase: normalized.issues === undefined ? "disabled" : "config-error" });
        return;
    }
    recordStatus("plugin", { phase: "apply" });
    installAccountData(ctx);
}
