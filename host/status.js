import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function cachePath() {
    const base = process.env.DSH_PROFILE_DIR ?? join(homedir(), ".dsh", "profiles", process.env.DSH_PROFILE ?? "desktop");
    return join(base, ".dsh-subscription-management", "probes.json");
}

/**
 * Tiny diagnostic breadcrumb in the profile (`<profile>/.dsh-subscription-management/status.json`).
 * Engine and calendar diagnostics live under separate keys so a later holiday
 * refresh cannot erase the declaration engine's last phase (the old flat file
 * made `declared` disappear seconds after it was written).
 *
 * @param {"plugin"|"engine"|"holiday"} scope diagnostic producer.
 * @param {Record<string, unknown>} patch fields to merge into that scope.
 */
export function recordStatus(scope, patch) {
    try {
        const path = join(dirname(cachePath()), "status.json");
        mkdirSync(dirname(path), { recursive: true });
        let previous = {};
        try {
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) previous = parsed;
        } catch {
            // first write
        }
        const at = Date.now();
        const body = JSON.stringify({
            ...previous,
            ...patch,
            [scope]: { ...patch, at, pid: process.pid },
            at,
            pid: process.pid
        });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, body, "utf8");
        renameSync(tmp, path);
    } catch {
        // diagnostics must never cost the plugin
    }
}

export function log(ctx, level, message) {
    const logger = ctx.logger;
    const write = logger?.[level];
    if (typeof write === "function") {
        try {
            write.call(logger, `dsh-subscription-management: ${message}`);
            return;
        } catch {
            // fall through to silence
        }
    }
    if (level === "warn") console.warn(`dsh-subscription-management: ${message}`);
}
