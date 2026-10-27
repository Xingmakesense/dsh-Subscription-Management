import assert from "node:assert/strict";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
const host = readFileSync(new URL("./host.js", import.meta.url), "utf8");
const hostAccounts = readFileSync(new URL("./host/accounts.js", import.meta.url), "utf8");
const hostUsage = readFileSync(new URL("./host/subscriptions/usage.js", import.meta.url), "utf8");
const hostCredentials = readFileSync(new URL("./host/subscriptions/credentials.js", import.meta.url), "utf8");
const hostSubscriptions = readFileSync(new URL("./host/subscriptions/index.js", import.meta.url), "utf8");
const hostSource = [hostAccounts, hostUsage, hostCredentials, hostSubscriptions].join("\n");
const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
const patch = readFileSync(new URL("./cordis.patch.yml", import.meta.url), "utf8");
const icon = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");

{
    assert.equal(manifest.name, "dsh-subscription-management");
    assert.equal(manifest.dsh?.client?.platform, "web");
    assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
    for (const file of [
    "client.js",
    "client/runtime.js",
    "client/options.js",
    "client/subscription-catalog.js",
    "client/quota.js",
    "client/deepseek-balance.js",
    "client/balance-card.js",
    "client/quota-settings.js",
    "client/styles.js",
    "client/apply.js",
    "host.js",
    "host/options.js",
    "host/status.js",
    "host/accounts.js",
    "host/subscriptions/catalog.js",
    "host/subscriptions/credentials.js",
    "host/subscriptions/http.js",
    "host/subscriptions/index.js",
    "host/subscriptions/kimi-oauth.js",
    "host/subscriptions/usage.js",
    "subscriptions.json",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
    "README.md",
    "MAINTENANCE.md",
    "UPLOAD-TO-GITHUB.md",
    "LICENSE",
    "scripts/build-client.mjs",
    "scripts/build-tgz.ps1",
    "verify-host.cjs",
    "verify-client.mjs",
    "verify-subscriptions.mjs",
    "verify-compat.mjs"
]) {
        assert.equal(manifest.files.includes(file), true, file + " must stay in the packed files");
    }
    assert.match(manifest.engines?.dsh ?? "", /0\.2\.1-rc\.2/);
    assert.ok(readme.includes("> 版本 \x60" + manifest.version + "\x60"), "README version must match package.json");
    assert.match(patch, /id:\s*dsh-subscription-management/);
    assert.match(patch, /name:\s*dsh-subscription-management/);
    assert.ok(icon.includes("aria-label"));
}

{
    assert.equal(client.includes('"sidebar.footer.action"'), true, "subscription card slot missing");
    assert.equal(client.includes('"settings.section"'), true, "subscription settings entry missing");
    assert.equal(client.includes('"conversation.input.right"'), false, "unrelated slider must not load");
    assert.equal(client.includes("SubscriptionAuthSettings"), true, "subscription settings component missing");
    assert.equal(client.includes("useSessions"), true, "turn-end refresh must observe sessions");
    assert.equal(client.includes("autoStart"), true, "initialization must be explicitly controlled");
    assert.equal(client.includes("initialRequested"), true, "initial subscription request must be deduplicated");
    assert.equal(client.includes("QuotaRing"), false, "removed ring renderer must stay deleted");
    assert.equal(client.includes("providerCard"), false, "fake vendor usage must stay removed");
    assert.equal(client.includes("sevenDay"), true, "real weekly windows must remain selectable");
    assert.equal(hostUsage.includes("api.kimi.com/coding/v1/usages"), true, "direct Kimi usage endpoint missing");
    assert.equal(hostAccounts.includes("api.deepseek.com/user/balance"), true, "direct DeepSeek balance endpoint missing");
    assert.equal(hostUsage.includes("backend-api/wham/usage"), true, "Codex usage adapter missing");
    assert.equal(hostUsage.includes("api/oauth/usage"), true, "Claude usage adapter missing");
    assert.equal(hostCredentials.includes("cli-link"), true, "read-only CLI credential linking missing");
    assert.equal(hostSubscriptions.includes("requireSubscriptionVendor(input.vendor)"), true, "vendor allowlist guard missing");
    assert.equal(hostSubscriptions.includes("validationInFlight"), true, "validation single-flight missing");
    assert.equal(hostSource.includes("/kimi-subscription"), false, "must not depend on the Kimi plugin channel");
    assert.equal(hostSource.includes("dsh-whale"), false, "must not depend on the whale-widget route");
}

function asarPath() {
    const candidates = [process.env.DSH_DESKTOP_ASAR];
    for (const base of [process.env.ProgramFiles, process.env.ProgramW6432, process.env["ProgramFiles(x86)"]]) {
        if (typeof base === "string" && base.length > 0) {
            candidates.push(join(base, "DSH", "resources", "app.asar"));
        }
    }
    if (typeof process.env.LOCALAPPDATA === "string" && process.env.LOCALAPPDATA.length > 0) {
        candidates.push(join(process.env.LOCALAPPDATA, "Programs", "DSH", "resources", "app.asar"));
    }
    // The desktop app may be installed on a non-system drive (F: on this
    // machine). Check the standard per-drive locations as a bounded fallback.
    for (const drive of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
        candidates.push(`${drive}:\\Program Files\\DSH\\resources\\app.asar`);
        candidates.push(`${drive}:\\Program Files (x86)\\DSH\\resources\\app.asar`);
    }
    return candidates.filter((value) => typeof value === "string" && value.length > 0)
        .find((path) => existsSync(path));
}

/** Semver precedence for the subset DSH uses, including rc.N suffixes. */
function atLeast(actual, minimum) {
    const parse = (value) => {
        const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
        return match === null ? undefined : {
            core: [Number(match[1]), Number(match[2]), Number(match[3])],
            pre: match[4]?.split(".") ?? []
        };
    };
    const left = parse(actual);
    const right = parse(minimum);
    if (left === undefined || right === undefined) return false;
    for (let index = 0; index < 3; index += 1) {
        if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index];
    }
    if (left.pre.length === 0) return true;
    if (right.pre.length === 0) return false;
    const length = Math.max(left.pre.length, right.pre.length);
    for (let index = 0; index < length; index += 1) {
        const a = left.pre[index];
        const b = right.pre[index];
        if (a === undefined) return false;
        if (b === undefined) return true;
        if (a === b) continue;
        const an = /^\d+$/.test(a) ? Number(a) : undefined;
        const bn = /^\d+$/.test(b) ? Number(b) : undefined;
        if (an !== undefined && bn !== undefined) return an > bn;
        if (an !== undefined) return false;
        if (bn !== undefined) return true;
        return a > b;
    }
    return true;
}

function readAsarFile(asar, target) {
    const fd = openSync(asar, "r");
    try {
        const head = Buffer.alloc(16);
        readSync(fd, head, 0, 16, 0);
        const headerSize = head.readUInt32LE(12);
        const headerBuffer = Buffer.alloc(headerSize);
        readSync(fd, headerBuffer, 0, headerSize, 16);
        const header = JSON.parse(headerBuffer.toString("utf8").replace(/\0+$/u, ""));
        const parts = target.split("/");
        let node = header;
        for (const part of parts) {
            node = node.files?.[part];
            if (node === undefined) return undefined;
        }
        if (node.files !== undefined) return undefined;
        const body = Buffer.alloc(Number(node.size));
        readSync(fd, body, 0, body.length, 16 + headerSize + Number(node.offset));
        return body.toString("utf8");
    } finally {
        closeSync(fd);
    }
}

const asar = asarPath();
if (asar === undefined) {
    console.log("compatibility: DSH asar not found in env, Program Files, LocalAppData, or any drive; skipped installed-shell assertions");
    console.log("compatibility: set DSH_DESKTOP_ASAR to the absolute app.asar path to force the check");
} else {
    const dshPackage = readAsarFile(asar, "dsh/package.json");
    const installedVersion = dshPackage === undefined ? undefined : JSON.parse(dshPackage).version;
    assert.ok(installedVersion !== undefined, "the installed DSH version is unreadable");
    assert.equal(atLeast(installedVersion, "0.2.1-rc.2"), true,
        `installed DSH ${installedVersion} is below the tested 0.2.1-rc.2 floor`);

    const conversation = readAsarFile(asar, "dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js") ?? "";
    const sidebar = readAsarFile(asar, "dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js") ?? "";
    const preload = readAsarFile(asar, "lib/preload-app.cjs") ?? "";
    assert.equal(conversation.includes('"conversation.input.right"'), true, "installed conversation lacks the right slot");
    assert.equal(sidebar.includes('"sidebar.brand.name"'), true, "installed sidebar lacks the brand-name slot");
    assert.equal(sidebar.includes('"sidebar.footer.action"'), true, "installed sidebar lacks the quota footer slot");
    assert.equal(sidebar.includes('"sidebar.settings"'), true, "installed sidebar lacks the settings section seat");
    assert.equal(sidebar.includes('renderSlot("sidebar.footer.action", { wide })'), true,
        "quota footer must receive the sidebar wide/compact layout prop");
    assert.equal(preload.includes("data-windows-menu") || preload.includes("windowsMenu"), true,
        "installed desktop no longer exposes the caption menu");
    assert.equal(preload.includes("attachShadow({ mode: \"open\" })"), true,
        "caption menu shadow root is no longer open");
    console.log(`compatibility: DSH ${installedVersion}, caption shadow root and composer slots match`);
}

console.log("compatibility checks passed");
