import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.__DSH_UAK_TEST__ = true;
let captured;
globalThis.window = {
    __ModuleLoader__: {
        load(spec) { captured = spec; }
    }
};
await import("./client.js");
assert.ok(captured !== undefined, "client.js must register a module factory");
const module = captured.factory((id) => ({}));
const {
    normalizeOptions,
    selectQuotaWindows,
    quotaSlots,
    remainingPercentOf,
    formatResetAt,
    monthQuotaInfo,
    classifyQuotaError,
    createQuotaController,
    unwrapKimiRpc,
    normalizeDeepSeekBalance,
    readDeepSeekBalance,
    createDeepSeekController,
    classifyDeepSeekError,
    balanceCardView,
    formatQuotaPercent,
    formatCurrencyAmount,
    safeVendorLoginUrl,
    vendorOrder,
    readActiveVendor,
    reorderVendor,
    SUBSCRIPTION_VENDORS,
    vendorForModel,
    vendorForProvider,
    activeModelLabel,
    activeModelProvider,
    quotaRowText,
    runningSessionIds,
    endedRunningSessions,
    AUTO_REFRESH_INTERVAL_MS,
    AUTO_REFRESH_TICK_MS,
    shouldAutoRefresh
} = module.__test;

// G. Independent enable switch and registration without unrelated features.
{
    assert.deepEqual(normalizeOptions(undefined).value, { enabled: true });
    assert.deepEqual(normalizeOptions({ enabled: false }).value, { enabled: false });
    assert.ok(Array.isArray(normalizeOptions({ enabled: "yes" }).issues));
    const capture = (options, { connection = true } = {}) => {
        const injected = [];
        const slotKeys = [];
        const registrations = [];
        const slots = {
            inject(key, callback) { slotKeys.push(key); callback(); return () => {}; },
            register(options) { registrations.push(options); return () => {}; }
        };
        const ctx = {
            effect: (fn) => fn(),
            get: (service) => service === "connection" && connection
                ? { rpc: { call: async () => ({ ok: true, value: {} }) } }
                : undefined,
            inject(services, callback) {
                injected.push(services);
                callback({
                    get(service) {
                        if (service === "slots") return slots;
                        if (service === "connection" && connection) return { rpc: { call: async () => ({ ok: true, value: {} }) } };
                        return undefined;
                    }
                });
                return { dispose() {} };
            }
        };
        module.apply(ctx, options);
        return { injected, slotKeys, registrations };
    };
    const disabled = capture({ enabled: false });
    assert.deepEqual(disabled.injected, []);
    assert.deepEqual(disabled.slotKeys, []);
    const full = capture({ enabled: true });
    assert.deepEqual(full.injected, [["slots", "connection"]]);
    assert.deepEqual(full.slotKeys, ["sidebar.footer.action", "settings.section"]);
    assert.ok(full.registrations.some((entry) => entry.id === "dsh-subscription-management-balance"));
    const auth = full.registrations.find((entry) => entry.id === "dsh-subscription-management-auth");
    assert.equal(auth.label, "订阅认证");
    const disconnected = capture({ enabled: true }, { connection: false });
    assert.deepEqual(disconnected.injected, []);
    assert.deepEqual(disconnected.slotKeys, []);
}

// H. Subscription windows, layout, model aliases, and explicit missing values.
{
    const usage = {
        summary: { window: { duration: 1, unit: "week" }, used: 30, limit: 100, remainingPercent: 70 },
        limits: [
            { window: { duration: 5, unit: "hour" }, used: 0, limit: 100, remainingPercent: 0, resetAt: "2026-10-27T00:00:00.000Z" },
            { window: { duration: 24, unit: "hour" }, used: 25, limit: 100, remainingPercent: 75 },
            { window: { duration: 30, unit: "day" }, used: 10, limit: 200, remainingPercent: 95 },
            { window: { duration: 1, unit: "month" }, used: 1, limit: 2, remainingPercent: 50 }
        ],
        extraUsage: {
            balanceCents: 0,
            totalCents: 1200,
            monthlyChargeLimitEnabled: true,
            monthlyChargeLimitCents: 5000,
            monthlyUsedCents: 0,
            currency: "USD"
        }
    };
    const selected = selectQuotaWindows(usage);
    assert.equal(selected.today.window.duration, 24);
    assert.equal(selected.fiveHour.window.duration, 5);
    assert.equal(selected.sevenDay.window.unit, "week", "a real weekly window is preserved");
    assert.equal(selected.thirtyDay.window.duration, 30);
    assert.equal(selected.month.window.unit, "month");
    assert.equal(remainingPercentOf(selected.fiveHour), 0, "explicit zero remains zero");
    assert.equal(remainingPercentOf({ used: 0, limit: 0 }), undefined, "zero limit is unknown");
    assert.equal(remainingPercentOf({ used: 0 }), undefined, "missing limit is unknown");
    assert.equal(remainingPercentOf({ remainingPercent: 0 }), 0);
    assert.equal(formatResetAt("not-a-date"), "未提供");
    assert.notEqual(formatResetAt("2026-10-27T00:00:00.000Z"), "未提供");
    assert.deepEqual(unwrapKimiRpc({ ok: true, value: 3 }), 3);
    assert.deepEqual(unwrapKimiRpc({ authenticated: true }), { authenticated: true });
    assert.throws(() => unwrapKimiRpc({ ok: false, error: { message: "denied" } }), /denied/);

    const month = monthQuotaInfo(usage);
    assert.equal(month.percent, 50);
    assert.equal(month.source, "window");
    const boosterMonth = monthQuotaInfo({
        limits: [],
        extraUsage: {
            monthlyChargeLimitEnabled: true,
            monthlyUsedCents: 1000,
            monthlyChargeLimitCents: 5000,
            currency: "CNY"
        }
    });
    assert.equal(boosterMonth.percent, 80);
    assert.equal(boosterMonth.source, "booster");
    assert.equal(monthQuotaInfo({ limits: [] }).percent, undefined);
    assert.equal(formatQuotaPercent(0), "0%");
    assert.equal(formatQuotaPercent(undefined), "—");
    assert.equal(formatCurrencyAmount(0, "CNY").includes("0"), true);
    assert.equal(formatCurrencyAmount(undefined, "CNY"), undefined);

    const slots = quotaSlots(usage);
    assert.deepEqual(slots.map((slot) => slot.id), ["five", "week", "month"],
        "short windows are inner and long windows outer");
    assert.deepEqual(slots.map((slot) => slot.depth), [0, 1, 2]);
    assert.equal(slots.find((slot) => slot.id === "month").bar, true);
    assert.equal(quotaSlots({ limits: [selected.month] })[0].bar, true,
        "a single named limit uses the bar layout");

    const deepData = normalizeDeepSeekBalance({
        ok: true,
        totalBalance: 0,
        todayUsage: 0,
        currency: "CNY",
        usageLabel: "余额差",
        rechargeBalance: 0,
        bonusBalance: 0
    });
    assert.equal(deepData.totalBalance, 0);
    assert.equal(deepData.todayUsage, 0);
    const nullDeep = normalizeDeepSeekBalance({ ok: true, totalBalance: null, todayUsage: null });
    assert.equal(nullDeep.totalBalance, undefined);
    assert.equal(nullDeep.todayUsage, undefined);
    assert.throws(() => normalizeDeepSeekBalance({ ok: false, error: "no route" }), /no route/);
    assert.equal(classifyDeepSeekError(new Error("DeepSeek balance service is unavailable")), "unavailable");

    const card = balanceCardView({ status: "ready", vendor: "kimi", usage }, { status: "ready", data: deepData });
    assert.equal(card.slots.find((slot) => slot.id === "five").text, "0%");
    assert.equal(card.slots.find((slot) => slot.id === "month").text, "50%");
    assert.deepEqual(card.renderedSlots.map((slot) => slot.id), ["month", "week", "five"]);
    assert.equal(card.balanceText.includes("0"), true);
    assert.equal(card.todayText.includes("0"), true);
    assert.equal(card.accountState, "ready");
    assert.equal(card.title.includes("DeepSeek 余额"), true);
    assert.equal(card.title.includes("周额度"), true, "a real weekly window appears in the tooltip");
    const emptyCard = balanceCardView({ status: "ready", usage: {} }, { status: "error" });
    assert.deepEqual(emptyCard.slots, []);
    assert.deepEqual(emptyCard.renderedSlots, []);
    assert.equal(balanceCardView({ status: "ready", usage }, { status: "error" }).accountState, "partial");

    // A subscription is selected strictly by its provider route. Model names
    // are never evidence: a third-party relay serving glm-4.6 must not switch
    // the card to the Z.ai subscription plan.
    assert.equal(vendorForModel("gpt-5-codex"), undefined, "a bare model name never selects a subscription");
    assert.equal(vendorForModel("glm-4.6", "my-third-party-relay"), undefined,
        "a relay that serves a GLM model is not the GLM coding plan");
    assert.equal(vendorForModel("zhipu/glm-4.6", "openrouter"), undefined);
    assert.equal(vendorForModel("glm-4.6", "z.ai"), "glm", "the exact provider route still selects the plan");
    assert.equal(vendorForModel("glm-4.6", "ZAI"), "glm", "provider matching is case-insensitive");
    assert.equal(vendorForModel("anything", "dashscope"), "qwen");
    assert.equal(vendorForModel("kimi-k2", "moonshot"), "kimi");
    assert.equal(vendorForModel(undefined, "protocom-codex"), "protocom");
    assert.equal(vendorForModel("deepseek-flash", "deepseek"), undefined);
    assert.equal(vendorForProvider("openai"), undefined, "a plain OpenAI key is not a ChatGPT subscription");
    assert.equal(vendorForProvider("chatgpt"), "chatgpt");
    assert.equal(vendorForProvider(""), undefined);
    assert.equal(vendorForProvider(undefined), undefined);
    assert.equal(activeModelLabel({
        byId: { a: { id: "a", retainedBy: { mainView: 1 } } },
        projectionsBySession: { a: { values: { modelSelection: { next: { provider: "openai", model: "gpt-5" } } } } }
    }), "openai gpt-5");
    assert.equal(activeModelProvider({
        byId: { a: { id: "a", retainedBy: { mainView: 1 } } },
        projectionsBySession: { a: { values: { modelSelection: { next: { provider: "z.ai", model: "glm-4.6" } } } } }
    }), "z.ai");
    // Equivalent amounts (Mistral) render money, not a percentage.
    assert.equal(quotaRowText({ used: 10, limit: 40, unit: "amount", currency: "USD" }).includes("30"), true);
    assert.equal(quotaRowText({ used: 25, limit: 100 }), "75%");
    assert.deepEqual(reorderVendor(["kimi", "glm", "qwen"], "qwen", "kimi"), ["qwen", "kimi", "glm"]);
    assert.equal(vendorOrder([]).length, SUBSCRIPTION_VENDORS.length);
    const localValues = new Map();
    window.localStorage = {
        getItem: (key) => localValues.get(key) ?? null,
        setItem: (key, value) => localValues.set(key, String(value)),
        removeItem: (key) => localValues.delete(key)
    };
    localValues.set("utility-appearance-kit:subscription-active", JSON.stringify("glm"));
    assert.equal(readActiveVendor(), "glm", "legacy JSON active vendor must still load");
    localValues.set("utility-appearance-kit:subscription-active", "deepseek");
    assert.equal(readActiveVendor(), undefined, "non-subscription models never become a vendor");
    const kimi = SUBSCRIPTION_VENDORS.find((vendor) => vendor.id === "kimi");
    assert.equal(safeVendorLoginUrl("https://www.kimi.com/code", kimi), "https://www.kimi.com/code");
    assert.equal(safeVendorLoginUrl("http://www.kimi.com/code", kimi), undefined);
    assert.equal(safeVendorLoginUrl("https://kimi.com.evil.example/login", kimi), undefined);
}

// I. Account state: verified Host RPC, vendor isolation, latest-promise-wins,
//    turn-end trigger, and no publication after disposal.
{
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const response = (value) => ({ ok: true, value });
    const readyUsage = (marker) => ({ summary: { name: marker }, limits: [], extraUsage: null });

    const unauthenticatedCalls = [];
    const unauthenticated = createQuotaController({
        rpc: { call: async (channel, endpoint, payload) => {
            unauthenticatedCalls.push([channel, endpoint, payload]);
            return response({ configured: false, authenticated: false });
        } }
    });
    unauthenticated.start();
    await tick();
    assert.equal(unauthenticated.getState().status, "unauthenticated");
    assert.deepEqual(unauthenticatedCalls, [["/dsh-subscription-management", "usage", { force: false }]],
        "unauthenticated Kimi must use this plugin's independent Host route");
    unauthenticated.dispose();

    const pending = [];
    const states = [];
    const controller = createQuotaController({
        rpc: {
            call(_channel, _endpoint, payload) {
                return new Promise((resolve) => pending.push({ resolve, payload }));
            }
        },
        onChange: (state) => states.push(state)
    });
    controller.start();
    await tick();
    assert.equal(states[0].status, "loading");
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].payload, { force: false });

    const manual = controller.refresh(true);
    await tick();
    assert.equal(pending.length, 2);
    assert.deepEqual(pending[1].payload, { force: true }, "manual refresh must force Kimi usage");
    pending[1].resolve(response({ configured: true, authenticated: true, verified: true, vendor: "kimi", usage: readyUsage("new") }));
    await manual;
    pending[0].resolve(response({ configured: true, authenticated: true, verified: true, vendor: "kimi", usage: readyUsage("stale") }));
    await tick();
    assert.equal(controller.getState().usage.summary.name, "new", "stale promise must not overwrite newer data");

    const background = controller.refresh(false);
    await tick();
    assert.equal(pending.length, 3);
    assert.deepEqual(pending[2].payload, { force: false, vendor: "kimi" },
        "later refreshes must retain the current vendor");
    assert.equal(controller.getState().status, "refreshing",
        "a turn-end refresh must not replace existing data with loading");
    assert.equal(controller.getState().usage.summary.name, "new",
        "refreshing must keep the last good rows visible");
    const publishedBeforeDispose = states.length;
    controller.dispose();
    pending[2].resolve(response({ configured: true, authenticated: true, verified: true, vendor: "kimi", usage: readyUsage("after-dispose") }));
    await background;
    await tick();
    assert.equal(states.length, publishedBeforeDispose, "disposal must suppress late promise state");
    assert.notEqual(controller.getState().usage.summary.name, "after-dispose");

    const failed = createQuotaController({
        rpc: { call: async () => response({ configured: true, authenticated: true, usage: null }) }
    });
    await failed.refresh(false);
    assert.equal(failed.getState().status, "error", "a null usage payload must not become a blank ready panel");
    failed.dispose();

    for (const [message, status] of [
        ["connection unavailable", "unavailable"],
        ["Kimi Code subscription is not connected", "unauthenticated"],
        ["Could not read Kimi Code subscription usage", "error"]
    ]) {
        assert.equal(classifyQuotaError(new Error(message)), status);
        const failed = createQuotaController({
            rpc: { call: async () => { throw new Error(message); } }
        });
        await failed.refresh(false);
        assert.equal(failed.getState().status, status);
        failed.dispose();
    }

    // DeepSeek values also come directly from this plugin's Host route.
    const deepStates = [];
    const read = await readDeepSeekBalance({
        rpc: {
            call: async (channel, endpoint, payload) => {
                assert.equal(channel, "/dsh-subscription-management");
                assert.equal(endpoint, "deepseek");
                assert.deepEqual(payload, { force: true });
                return response({ ok: true, totalBalance: 2, todayUsage: 1, currency: "CNY" });
            }
        },
        force: true
    });
    assert.equal(read.totalBalance, 2);
    assert.equal(read.todayUsage, 1);

    let deepPending;
    const deepController = createDeepSeekController({
        rpc: {
            call: () => new Promise((resolve) => { deepPending = resolve; })
        },
        onChange: (state) => deepStates.push(state)
    });
    deepController.start();
    await tick();
    deepPending(response({ ok: true, totalBalance: 12.5, todayUsage: 1.25, currency: "CNY" }));
    await tick();
    assert.equal(deepController.getState().status, "ready");
    assert.equal(deepController.getState().data.totalBalance, 12.5);
    const deepRefresh = deepController.refresh(true);
    await tick();
    assert.equal(deepController.getState().status, "refreshing");
    assert.equal(deepController.getState().data.totalBalance, 12.5,
        "a refresh must retain the previous DeepSeek data");
    deepPending(response({ ok: true, totalBalance: 10, todayUsage: 2, currency: "CNY" }));
    await deepRefresh;
    assert.equal(deepController.getState().data.totalBalance, 10);
    deepController.dispose();

    const missingDeep = createDeepSeekController({
        rpc: { call: async () => { throw new Error("DeepSeek account is not connected"); } }
    });
    await missingDeep.refresh(false);
    assert.equal(missingDeep.getState().status, "unavailable");
    missingDeep.dispose();

    // Switching vendors must not relabel the previous vendor's quota. Later
    // manual refresh keeps the newly selected vendor in the RPC payload.
    const switchCalls = [];
    let finishGlm;
    let deferGlm = true;
    const switching = createQuotaController({
        rpc: {
            call: async (_channel, _endpoint, payload) => {
                switchCalls.push(payload);
                const vendor = payload.vendor ?? "kimi";
                const value = {
                    configured: true,
                    authenticated: true,
                    verified: true,
                    vendor,
                    usage: { summary: { name: vendor }, limits: [], extraUsage: null }
                };
                if (vendor === "glm" && deferGlm) {
                    deferGlm = false;
                    return new Promise((resolve) => {
                        finishGlm = () => resolve(response(value));
                    });
                }
                return response(value);
            }
        }
    });
    await switching.refresh(false);
    assert.equal(switching.getState().usage.summary.name, "kimi");
    const changed = switching.refresh(true, "glm");
    await tick();
    assert.equal(switching.getState().vendor, "glm");
    assert.equal(switching.getState().usage, undefined, "old Kimi data is cleared while GLM loads");
    finishGlm();
    await changed;
    assert.equal(switching.getState().usage.summary.name, "glm");
    await switching.refresh(true);
    assert.deepEqual(switchCalls.at(-1), { force: true, vendor: "glm" });
    switching.dispose();

    assert.equal(runningSessionIds({ byId: { a: { running: true }, b: { running: false } } }), "a");
    assert.equal(endedRunningSessions("a,b", "b"), true, "a stopped session must trigger refresh");
    assert.equal(endedRunningSessions("a", "a"), false, "an unchanged running set must not refresh");
    assert.equal(endedRunningSessions("a", ""), true, "the final turn end must trigger refresh");
}

// J. Five-minute auto refresh: the ticker's decision function.
{
    assert.equal(AUTO_REFRESH_INTERVAL_MS, 5 * 60 * 1000, "the card refreshes every five minutes");
    assert.equal(AUTO_REFRESH_TICK_MS, 60 * 1000, "the ticker wakes once a minute");
    assert.ok(AUTO_REFRESH_INTERVAL_MS > AUTO_REFRESH_TICK_MS, "a tick must not be longer than the interval");

    const base = Date.parse("2026-11-05T12:00:00.000Z");
    assert.equal(shouldAutoRefresh({ now: base, lastAt: base }), false, "no refresh right after a request");
    assert.equal(shouldAutoRefresh({ now: base + 1000, lastAt: base }), false, "one second is not five minutes");
    assert.equal(shouldAutoRefresh({ now: base + AUTO_REFRESH_INTERVAL_MS - 1, lastAt: base }), false,
        "one millisecond short of the interval must not refresh");
    assert.equal(shouldAutoRefresh({ now: base + AUTO_REFRESH_INTERVAL_MS, lastAt: base }), true,
        "the exact interval boundary refreshes");
    assert.equal(shouldAutoRefresh({ now: base + 3 * AUTO_REFRESH_INTERVAL_MS, lastAt: base }), true,
        "a throttled background tab refreshes once it returns");
    assert.equal(shouldAutoRefresh({ now: base + 10 * AUTO_REFRESH_INTERVAL_MS, lastAt: base, hidden: true }), false,
        "a hidden page never polls");
    assert.equal(shouldAutoRefresh({ now: base, hidden: false }), false,
        "without a baseline the first request owns the window");
    assert.equal(shouldAutoRefresh({ now: Number.NaN, lastAt: base }), false, "an unreadable clock does not refresh");
    assert.equal(shouldAutoRefresh({ now: base - 60_000, lastAt: base }), true,
        "a backwards clock jump still retries rather than stalling forever");
}

// K. Both slot components render without throwing, including an expanded
//    account panel with per-group details and an amount-valued budget.
{
    const fakeReactBase = (created, stateOverrides) => {
        let stateIndex = 0;
        return {
            Fragment: Symbol.for("fragment"),
            createElement(type, props, ...children) {
                created.push({ type, props, children });
                return { type, props, children };
            },
            useState: (initial) => {
                stateIndex += 1;
                const override = stateOverrides[stateIndex];
                return [override === undefined ? (typeof initial === "function" ? initial() : initial) : override, () => {}];
            },
            useRef: (value) => ({ current: value }),
            useMemo: (factory) => factory(),
            useCallback: (callback) => callback,
            useEffect: () => {},
            useLayoutEffect: () => {}
        };
    };
    const mount = (stateOverrides = {}) => {
        const created = [];
        const instance = captured.factory((id) => (id === "react" ? fakeReactBase(created, stateOverrides) : {}));
        const registrations = [];
        const slots = {
            inject(_key, callback) { callback(); return () => {}; },
            register(options, component) { registrations.push({ options, component }); return () => {}; }
        };
        const rpc = { call: async () => ({ ok: true, value: { vendors: {} } }) };
        const ctx = {
            effect: (fn) => fn(),
            get: (service) => service === "connection" ? { rpc } : undefined,
            inject(_services, callback) {
                callback({ get: (service) => service === "slots" ? slots : service === "connection" ? { rpc } : undefined });
                return { dispose() {} };
            }
        };
        instance.apply(ctx, { enabled: true });
        return { created, registrations };
    };

    const empty = mount();
    assert.equal(empty.registrations.length, 2, "the plugin must register the card and the settings section");
    const card = empty.registrations.find((entry) => entry.options.id === "dsh-subscription-management-balance");
    const settings = empty.registrations.find((entry) => entry.options.id === "dsh-subscription-management-auth");
    assert.ok(card !== undefined && typeof card.component === "function");
    assert.ok(settings !== undefined && typeof settings.component === "function");
    card.component({ ...card.options.inject(true), useSessions: undefined });
    settings.component({ ...settings.options.inject() });
    assert.ok(empty.created.some((node) => node.type === "section"), "both components must render a section root");

    // SubscriptionAuthSettings state order: 1 order, 2 hidden, 3 draftOrder,
    // 4 draftHidden, 5 managing, 6 expanded, 7 pinned, 8 accounts, 9 summaries.
    const agyUsage = {
        summary: { window: { duration: 5, unit: "hour" }, used: 20, limit: 100, remainingPercent: 80, resetAt: "2026-10-27T05:00:00Z" },
        limits: [{ name: "周额度", window: { duration: 1, unit: "week" }, used: 50, limit: 100, remainingPercent: 50 }],
        details: [{ label: "Gemini 5小时", text: "80%" }, { label: "Claude / GPT 5小时", text: "20%" }]
    };
    const expandedAgy = mount({
        6: "antigravity",
        8: { antigravity: { configured: true, verified: true, method: "oauth" } },
        9: { antigravity: { usage: agyUsage } }
    });
    const agySettings = expandedAgy.registrations.find((entry) => entry.options.id === "dsh-subscription-management-auth");
    agySettings.component({ rpc: { call: async () => ({ ok: true, value: {} }) } });
    const agyText = JSON.stringify(expandedAgy.created.map((node) => node.children));
    assert.equal(agyText.includes("Gemini 5小时"), true, "an expanded Antigravity panel lists every group");
    assert.equal(agyText.includes("社区逆向"), true, "reverse-engineered quotas are labelled as such");
    assert.equal(agyText.includes("不会替你配置模型"), true,
        "the panel states that models are configured by the user");

    const mistralUsage = {
        summary: {
            name: "API 月度额度", window: { duration: 1, unit: "month" },
            used: 10, limit: 40, remainingPercent: 75, unit: "amount", currency: "USD",
            resetAt: "2026-11-01T00:00:00Z"
        },
        limits: [],
        plan: "Mistral Pro"
    };
    const expandedMistral = mount({
        6: "mistral",
        8: { mistral: { configured: true, verified: true, method: "api-key" } },
        9: { mistral: { usage: mistralUsage } }
    });
    const mistralSettings = expandedMistral.registrations.find((entry) => entry.options.id === "dsh-subscription-management-auth");
    mistralSettings.component({ rpc: { call: async () => ({ ok: true, value: {} }) } });
    const mistralText = JSON.stringify(expandedMistral.created.map((node) => node.children));
    assert.equal(mistralText.includes("等价额度"), true, "an amount-valued subscription is labelled as equivalent quota");
    assert.equal(mistralText.includes("Mistral Pro"), true, "the panel shows the vendor plan");
}

console.log("client subscription checks passed");
