import { formBody, HttpRequestError, requestJson } from "./http.js";

const REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIRO_REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";

export class SubscriptionUsageError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = "SubscriptionUsageError";
        this.code = ["AUTH", "UPSTREAM", "PARSE", "UNSUPPORTED"].includes(code) ? code : "UPSTREAM";
        if (Number.isInteger(options.status)) this.status = options.status;
        if (typeof options.vendor === "string") this.vendor = options.vendor;
    }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const number = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value !== "string" || !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};
const nonNegative = (value) => {
    const parsed = number(value);
    return parsed !== undefined && parsed >= 0 ? parsed : undefined;
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const vendorName = (vendor) => text(vendor?.name) ?? text(vendor?.id) ?? "Subscription";
const fail = (vendor, code, message, status) => new SubscriptionUsageError(code, message, {
    vendor: text(vendor?.id), status
});
const parseFail = (vendor) => fail(vendor, "PARSE", `${vendorName(vendor)} 用量响应格式无效或已改变`);

function nowMs(value) {
    if (typeof value === "function") return nowMs(value());
    if (value instanceof Date) return value.getTime();
    const parsed = number(value);
    if (parsed !== undefined) return parsed;
    if (typeof value === "string") {
        const parsedDate = Date.parse(value);
        if (Number.isFinite(parsedDate)) return parsedDate;
    }
    return Date.now();
}

function optionsOf(value) {
    if (isObject(value) && !(value instanceof Date)) {
        const options = { ...value, now: nowMs(value.now) };
        if (text(value.region)) options.region = text(value.region).toUpperCase();
        return options;
    }
    if (typeof value === "string" && /^(CN|GLOBAL|INTL)$/i.test(value)) {
        return { now: Date.now(), region: value.toUpperCase() };
    }
    return { now: nowMs(value) };
}

function iso(value) {
    if (value === undefined || value === null || value === "") return undefined;
    const numeric = number(value);
    let time;
    if (numeric !== undefined && !Number.isNaN(numeric)) {
        if (numeric <= 0) return undefined;
        time = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    } else if (typeof value === "string") {
        time = Date.parse(value);
    }
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function windowSeconds(value) {
    const seconds = nonNegative(value);
    if (seconds === undefined || seconds <= 0) return undefined;
    if (seconds % 604800 === 0) return { duration: seconds / 604800, unit: "week" };
    if (seconds % 86400 === 0) return { duration: seconds / 86400, unit: "day" };
    if (seconds % 3600 === 0) return { duration: seconds / 3600, unit: "hour" };
    if (seconds % 60 === 0) return { duration: seconds / 60, unit: "minute" };
    return { duration: seconds, unit: "second" };
}

function makeRow({ name, window, used, limit, remainingPercent, resetAt }) {
    const cleanUsed = nonNegative(used);
    const cleanLimit = nonNegative(limit);
    let percent = nonNegative(remainingPercent);
    if (percent !== undefined) percent = clamp(percent, 0, 100);
    if (cleanLimit === 0) percent = undefined;
    if (percent === undefined && cleanUsed !== undefined && cleanLimit !== undefined && cleanLimit > 0) {
        percent = clamp((cleanLimit - cleanUsed) / cleanLimit * 100, 0, 100);
    }
    if (cleanUsed === undefined && cleanLimit === undefined && percent === undefined) return null;
    return {
        ...(text(name) ? { name: text(name) } : {}),
        ...(isObject(window) ? { window } : {}),
        used: cleanUsed,
        limit: cleanLimit,
        remainingPercent: percent,
        ...(iso(resetAt) ? { resetAt: iso(resetAt) } : {})
    };
}

function percentRow(name, window, remainingPercent, resetAt) {
    const percent = nonNegative(remainingPercent);
    if (percent === undefined) return null;
    const bounded = clamp(percent, 0, 100);
    return makeRow({ name, window, used: 100 - bounded, limit: 100, remainingPercent: bounded, resetAt });
}

function result(options, { summary = null, limits = [], extraUsage = null, plan, accountName } = {}) {
    return {
        summary,
        limits: limits.filter(Boolean),
        extraUsage,
        ...(text(plan) ? { plan: text(plan) } : {}),
        ...(text(accountName) ? { accountName: text(accountName) } : {}),
        fetchedAt: options.now
    };
}

function titlePlan(value) {
    const raw = text(value);
    if (!raw) return undefined;
    const cleaned = raw.replace(/^LEVEL_/, "").replace(/_/g, " ").trim();
    if (!cleaned) return undefined;
    if (cleaned === cleaned.toLowerCase() || cleaned === cleaned.toUpperCase()) {
        return cleaned.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
    }
    return cleaned;
}

export function kimiWindow(value) {
    if (!isObject(value)) return undefined;
    const duration = nonNegative(value.duration);
    const rawUnit = text(value.timeUnit ?? value.time_unit ?? value.unit)?.toUpperCase();
    if (duration === undefined || duration <= 0 || !rawUnit) return undefined;
    const units = {
        TIME_UNIT_MINUTE: "minute", MINUTE: "minute", MINUTES: "minute",
        TIME_UNIT_HOUR: "hour", HOUR: "hour", HOURS: "hour",
        TIME_UNIT_DAY: "day", DAY: "day", DAYS: "day",
        TIME_UNIT_WEEK: "week", WEEK: "week", WEEKS: "week",
        TIME_UNIT_MONTH: "month", MONTH: "month", MONTHS: "month"
    };
    const unit = units[rawUnit];
    if (!unit) return undefined;
    if (unit === "minute" && duration >= 60 && duration % 60 === 0) {
        return { duration: duration / 60, unit: "hour" };
    }
    return { duration, unit };
}

function kimiRow(detail, name, window) {
    if (!isObject(detail)) return null;
    let used = nonNegative(detail.used);
    const limit = nonNegative(detail.limit);
    const remaining = nonNegative(detail.remaining);
    if (used === undefined && limit !== undefined && remaining !== undefined && remaining <= limit) {
        used = limit - remaining;
    }
    return makeRow({
        name, window, used, limit,
        resetAt: detail.resetTime ?? detail.reset_at ?? detail.resetAt ?? detail.reset_time
    });
}

function microToCents(value) {
    const parsed = number(value);
    return parsed === undefined ? undefined : Math.round(parsed / 1_000_000);
}

function kimiMoney(value) {
    if (!isObject(value)) return {};
    return { cents: nonNegative(value.priceInCents), currency: text(value.currency) };
}

function parseKimiBooster(value) {
    if (!isObject(value) || !isObject(value.balance) || value.balance.type !== "BOOSTER") return null;
    const total = nonNegative(value.balance.amount);
    if (total === undefined || total <= 0) return null;
    const monthlyLimit = kimiMoney(value.monthlyChargeLimit);
    const monthlyUsed = kimiMoney(value.monthlyUsed);
    return {
        balanceCents: microToCents(value.balance.amountLeft),
        totalCents: microToCents(total),
        monthlyChargeLimitEnabled: value.monthlyChargeLimitEnabled === true,
        monthlyChargeLimitCents: monthlyLimit.cents,
        monthlyUsedCents: monthlyUsed.cents,
        currency: monthlyLimit.currency ?? monthlyUsed.currency
    };
}

function kimiRatioRow(pool, name, window) {
    if (!isObject(pool)) return null;
    const usedRatio = nonNegative(pool.used_ratio);
    if (usedRatio === undefined) return null;
    return percentRow(name, window, (1 - clamp(usedRatio, 0, 1)) * 100, pool.reset_time ?? pool.resetTime);
}

function sameKimiWindow(a, b) {
    return a?.window?.unit === b?.window?.unit && a?.window?.duration === b?.window?.duration;
}

function preferredKimiRow(counts, ratio) {
    if (!counts) return ratio;
    if (!ratio) return counts;
    if (!sameKimiWindow(counts, ratio) || !counts.resetAt || !ratio.resetAt) return ratio;
    const closeReset = Math.abs(Date.parse(counts.resetAt) - Date.parse(ratio.resetAt)) <= 2000;
    return closeReset && number(counts.remainingPercent) !== undefined
        && counts.remainingPercent < ratio.remainingPercent ? counts : ratio;
}

function kimiPlan(payload) {
    const level = text(payload.user?.membership?.level);
    if (!level || level === "LEVEL_UNSPECIFIED") return undefined;
    if (payload.version === undefined || payload.version === "GOODS_VERSION_V1") {
        const goods = {
            LEVEL_FREE: "Adagio", LEVEL_TRIAL: "Andante", LEVEL_BASIC: "Moderato",
            LEVEL_INTERMEDIATE: "Allegretto", LEVEL_ADVANCED: "Allegro"
        };
        if (goods[level]) return goods[level];
    }
    return titlePlan(level);
}

export function parseKimiUsage(payload, input) {
    const options = optionsOf(input);
    if (!isObject(payload)) throw parseFail({ id: "kimi", name: "Kimi" });
    const limits = [];
    if (payload.limits !== undefined && !Array.isArray(payload.limits)) throw parseFail({ id: "kimi" });
    for (const item of payload.limits ?? []) {
        if (!isObject(item)) continue;
        const row = kimiRow(isObject(item.detail) ? item.detail : item, item.name, kimiWindow(item.window));
        if (row) limits.push(row);
    }
    let summary = kimiRow(payload.usage);
    const pools = isObject(payload.usages) ? payload.usages : {};
    summary = preferredKimiRow(summary,
        kimiRatioRow(pools.limit_7d, "Weekly", { duration: 1, unit: "week" }));
    if (summary?.window?.unit === "week") summary = { ...summary, name: "Weekly" };

    const sessionRatio = kimiRatioRow(pools.limit_5h, "Session", { duration: 5, unit: "hour" });
    if (sessionRatio) {
        let index = limits.findIndex((row) => sameKimiWindow(row, sessionRatio));
        if (index < 0 && limits.length === 1 && limits[0].window === undefined) {
            limits[0] = { ...limits[0], window: { duration: 5, unit: "hour" } };
            index = 0;
        }
        if (index < 0) limits.push(sessionRatio);
        else limits[index] = preferredKimiRow(limits[index], sessionRatio);
    }
    const monthly = kimiRatioRow(pools.limit_month_total, "Total usage", { duration: 1, unit: "month" });
    if (monthly) limits.push(monthly);
    return result(options, {
        summary,
        limits,
        extraUsage: parseKimiBooster(payload.boosterWallet),
        plan: kimiPlan(payload)
    });
}

function headerValue(headers, name) {
    if (!headers) return undefined;
    if (typeof headers.get === "function") return number(headers.get(name));
    const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : number(headers[key]);
}

function codexWindowRow(window, name, fallbackSeconds, headerPercent, now) {
    if (!isObject(window)) return null;
    const usedPercent = nonNegative(window.used_percent) ?? headerPercent;
    if (usedPercent === undefined) return null;
    const resetAt = window.reset_at ?? (nonNegative(window.reset_after_seconds) !== undefined
        ? now / 1000 + nonNegative(window.reset_after_seconds) : undefined);
    return percentRow(name, windowSeconds(window.limit_window_seconds) ?? windowSeconds(fallbackSeconds),
        100 - clamp(usedPercent, 0, 100), resetAt);
}

function codexRateRows(rateLimit, names, headerPercents, now) {
    if (!isObject(rateLimit)) return [];
    const slots = [
        { window: rateLimit.primary_window, seconds: 18000 },
        { window: rateLimit.secondary_window, seconds: 604800 }
    ];
    return slots.map((slot, index) => {
        const seconds = number(slot.window?.limit_window_seconds);
        const name = seconds === 18000 ? names[0] : seconds === 604800 ? names[1] : names[index];
        return codexWindowRow(slot.window, name, slot.seconds, headerPercents[index], now);
    }).filter(Boolean);
}

export function parseCodexUsage(payload, input) {
    const options = optionsOf(input);
    const vendor = { id: "chatgpt", name: "ChatGPT" };
    if (!isObject(payload)) throw parseFail(vendor);
    const limits = codexRateRows(payload.rate_limit, ["Session", "Weekly"], [
        headerValue(options.headers, "x-codex-primary-used-percent"),
        headerValue(options.headers, "x-codex-secondary-used-percent")
    ], options.now);
    for (const entry of Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : []) {
        if (!isObject(entry)) continue;
        const name = text(entry.limit_name) ?? "Model";
        limits.push(...codexRateRows(entry.rate_limit, [name, `${name} Weekly`], [undefined, undefined], options.now));
    }
    const review = codexWindowRow(payload.code_review_rate_limit?.primary_window,
        "Code reviews", 604800, undefined, options.now);
    if (review) limits.push(review);

    let extraUsage = null;
    const balance = nonNegative(payload.credits?.balance);
    if (balance !== undefined && payload.credits?.unlimited !== true) {
        // Codex's observed credit conversion is USD 0.04 per credit.
        extraUsage = { balanceCredits: balance, balanceCents: balance * 4, currency: "USD" };
    } else if (payload.credits?.has_credits === false) {
        extraUsage = { balanceCredits: 0, balanceCents: 0, currency: "USD" };
    }
    return result(options, { limits, extraUsage, plan: titlePlan(payload.plan_type) });
}

function claudeWindow(value, name, window) {
    if (!isObject(value)) return null;
    const used = nonNegative(value.utilization);
    return used === undefined ? null : percentRow(name, window, 100 - clamp(used, 0, 100), value.resets_at);
}

export function parseClaudeUsage(payload, input) {
    const options = optionsOf(input);
    const vendor = { id: "claude", name: "Claude" };
    if (!isObject(payload)) throw parseFail(vendor);
    const limits = [
        claudeWindow(payload.five_hour, "Session", { duration: 5, unit: "hour" }),
        claudeWindow(payload.seven_day, "Weekly", { duration: 1, unit: "week" }),
        claudeWindow(payload.seven_day_sonnet, "Sonnet", { duration: 1, unit: "week" }),
        claudeWindow(payload.seven_day_opus, "Opus", { duration: 1, unit: "week" }),
        claudeWindow(payload.seven_day_routines ?? payload.seven_day_cowork,
            "Daily Routines", { duration: 1, unit: "week" })
    ].filter(Boolean);
    const seen = new Set(limits.map((row) => `${row.name}:${row.resetAt ?? ""}`));
    for (const entry of Array.isArray(payload.limits) ? payload.limits : []) {
        if (!isObject(entry) || entry.kind !== "weekly_scoped") continue;
        const name = text(entry.scope?.model?.display_name);
        if (!name || name === "All models") continue;
        const used = nonNegative(entry.percent);
        const row = used === undefined ? null : percentRow(name, { duration: 1, unit: "week" },
            100 - clamp(used, 0, 100), entry.resets_at);
        if (row && !seen.has(`${row.name}:${row.resetAt ?? ""}`)) {
            limits.push(row);
            seen.add(`${row.name}:${row.resetAt ?? ""}`);
        }
    }
    if (payload.extra_usage?.is_enabled === true) {
        const row = makeRow({
            name: "Extra usage", window: { duration: 1, unit: "month" },
            used: payload.extra_usage.used_credits,
            limit: payload.extra_usage.monthly_limit
        });
        if (row) limits.push(row);
    }
    return result(options, { limits, plan: claudeProfilePlan(payload) });
}

function glmWindow(item) {
    const amount = nonNegative(item.number);
    if (item.unit === 3) return { duration: amount ?? 5, unit: "hour" };
    if (item.unit === 6) {
        const days = amount ?? 7;
        return days % 7 === 0 ? { duration: days / 7, unit: "week" } : { duration: days, unit: "day" };
    }
    return undefined;
}

export function parseGlmUsage(payload, input) {
    const options = optionsOf(input);
    const vendor = { id: "glm", name: "GLM" };
    if (!isObject(payload)) throw parseFail(vendor);
    const container = payload.data ?? payload;
    const rows = Array.isArray(container) ? container : container.limits;
    if (rows !== undefined && !Array.isArray(rows)) throw parseFail(vendor);
    const limits = [];
    for (const item of rows ?? []) {
        if (!isObject(item)) continue;
        const type = item.type ?? item.name;
        const percentage = nonNegative(item.percentage);
        if (["CREDIT_LIMIT", "TOKENS_LIMIT"].includes(type)) {
            const row = makeRow({
                name: item.unit === 6 ? "Weekly" : "Session",
                window: glmWindow(item), used: item.currentValue, limit: item.usage,
                remainingPercent: percentage === undefined ? undefined : 100 - clamp(percentage, 0, 100),
                resetAt: item.nextResetTime
            });
            if (!row && percentage !== undefined) {
                limits.push(percentRow(item.unit === 6 ? "Weekly" : "Session", glmWindow(item),
                    100 - clamp(percentage, 0, 100), item.nextResetTime));
            } else if (row) limits.push(row);
        } else if (type === "TIME_LIMIT") {
            const row = makeRow({
                name: "Web searches", window: { duration: 1, unit: "month" },
                used: item.currentValue, limit: item.usage,
                remainingPercent: percentage === undefined ? undefined : 100 - clamp(percentage, 0, 100),
                resetAt: item.nextResetTime
            });
            if (row) limits.push(row);
        }
    }
    return result(options, { limits: limits.filter(Boolean) });
}

function expandEmbedded(value, depth = 0) {
    if (depth > 12) return value;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
        try { return expandEmbedded(JSON.parse(trimmed), depth + 1); } catch { return value; }
    }
    if (Array.isArray(value)) return value.map((item) => expandEmbedded(item, depth + 1));
    if (isObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEmbedded(item, depth + 1)]));
    }
    return value;
}

function findKey(value, keys, descendArrays = true) {
    if (isObject(value)) {
        for (const key of keys) if (value[key] !== undefined) return value[key];
        for (const nested of Object.values(value)) {
            const found = findKey(nested, keys, descendArrays);
            if (found !== undefined) return found;
        }
    } else if (descendArrays && Array.isArray(value)) {
        for (const nested of value) {
            const found = findKey(nested, keys, descendArrays);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

function findObjectWithKeys(value, keys) {
    if (isObject(value)) {
        if (keys.some((key) => value[key] !== undefined)) return value;
        for (const nested of Object.values(value)) {
            const found = findObjectWithKeys(nested, keys);
            if (found) return found;
        }
    } else if (Array.isArray(value)) {
        for (const nested of value) {
            const found = findObjectWithKeys(nested, keys);
            if (found) return found;
        }
    }
    return undefined;
}

function qwenPlan(instances, payload) {
    for (const instance of instances) {
        const plan = text(instance.planName ?? instance.plan_name ?? instance.instanceName
            ?? instance.instance_name ?? instance.packageName ?? instance.package_name);
        if (plan) return plan;
    }
    return text(findKey(payload, ["planName", "plan_name", "packageName", "package_name"]));
}

function qwenActive(instance, now) {
    const status = text(instance?.status ?? instance?.instanceStatus)?.toUpperCase();
    if (["VALID", "ACTIVE"].includes(status)) return true;
    if (["EXPIRED", "INVALID", "INACTIVE", "DISABLED", "TERMINATED", "STOPPED"].includes(status)) return false;
    if (typeof instance?.active === "boolean") return instance.active;
    if (typeof instance?.isActive === "boolean") return instance.isActive;
    const end = iso(instance?.endTime ?? instance?.periodEndTime ?? instance?.expireTime ?? instance?.expirationTime);
    return end !== undefined && Date.parse(end) > now;
}

function checkQwenError(payload) {
    const vendor = { id: "qwen", name: "Qwen" };
    const codeText = text(findKey(payload, ["code", "status", "statusCode"]));
    const message = text(findKey(payload, ["message", "msg", "statusMessage", "status_msg"]))?.toLowerCase() ?? "";
    if ((codeText && /needlogin|login/i.test(codeText)) || /needlogin|console session|log in|login/i.test(message)) {
        throw fail(vendor, "AUTH", "Qwen Coding Plan API Key 在此区域不可用，可能需要控制台会话或切换区域");
    }
    const code = number(findKey(payload, ["statusCode", "status_code", "code"]));
    if (code !== undefined && code !== 0 && code !== 200) {
        throw fail(vendor, [401, 403].includes(code) ? "AUTH" : "UPSTREAM",
            "Qwen Coding Plan 凭据无效或服务请求失败", code);
    }
}

export function parseQwenUsage(payload, input) {
    const options = optionsOf(input);
    const vendor = { id: "qwen", name: "Qwen" };
    const expanded = expandEmbedded(payload);
    if (!isObject(expanded)) throw parseFail(vendor);
    checkQwenError(expanded);
    const rawInstances = findKey(expanded, ["codingPlanInstanceInfos", "coding_plan_instance_infos"]);
    const instances = Array.isArray(rawInstances) ? rawInstances.filter(isObject) : [];
    const active = instances.find((item) => qwenActive(item, options.now));
    const selected = active ?? instances[0];
    const plan = qwenPlan(selected ? [selected, ...instances] : instances, expanded);
    let quota = selected ? findKey(selected, ["codingPlanQuotaInfo", "coding_plan_quota_info"], false) : undefined;
    if (!isObject(quota)) quota = findKey(expanded, ["codingPlanQuotaInfo", "coding_plan_quota_info"]);
    if (!isObject(quota)) {
        quota = findObjectWithKeys(selected ?? expanded, [
            "per5HourUsedQuota", "per5HourTotalQuota", "perWeekUsedQuota", "perWeekTotalQuota",
            "perBillMonthUsedQuota", "perBillMonthTotalQuota"
        ]);
    }
    const hasActivePlan = Boolean(plan && (active || (!instances.length && qwenActive(expanded, options.now))));
    if (!isObject(quota)) {
        if (hasActivePlan) return result(options, { plan });
        throw parseFail(vendor);
    }
    const definitions = [
        ["Session", { duration: 5, unit: "hour" },
            ["per5HourUsedQuota", "perFiveHourUsedQuota"], ["per5HourTotalQuota", "perFiveHourTotalQuota"],
            ["per5HourQuotaNextRefreshTime", "perFiveHourQuotaNextRefreshTime"]],
        ["Weekly", { duration: 1, unit: "week" }, ["perWeekUsedQuota"], ["perWeekTotalQuota"],
            ["perWeekQuotaNextRefreshTime"]],
        ["Monthly", { duration: 1, unit: "month" },
            ["perBillMonthUsedQuota", "perMonthUsedQuota"], ["perBillMonthTotalQuota", "perMonthTotalQuota"],
            ["perBillMonthQuotaNextRefreshTime", "perMonthQuotaNextRefreshTime"]]
    ];
    const limits = definitions.map(([name, window, usedKeys, totalKeys, resetKeys]) => makeRow({
        name, window,
        used: usedKeys.map((key) => quota[key]).find((value) => value !== undefined),
        limit: totalKeys.map((key) => quota[key]).find((value) => value !== undefined),
        resetAt: resetKeys.map((key) => quota[key]).find((value) => value !== undefined)
    })).filter(Boolean);
    if (!limits.length && !hasActivePlan) throw parseFail(vendor);
    return result(options, { limits, plan });
}

export function parseDevinUsage(payload, input) {
    const options = optionsOf(input);
    const vendor = { id: "devin", name: "Devin" };
    if (!isObject(payload) || !isObject(payload.userStatus)) throw parseFail(vendor);
    const status = payload.userStatus.planStatus;
    if (!isObject(status)) throw parseFail(vendor);
    const info = isObject(status.planInfo) ? status.planInfo : {};
    const limits = [];
    const usedPercent = (value) => {
        const parsed = nonNegative(value);
        return parsed === undefined ? undefined : 100 - clamp(parsed, 0, 100);
    };
    if (info.hideDailyQuota !== true) {
        const row = percentRow("Daily quota", { duration: 1, unit: "day" },
            usedPercent(status.dailyQuotaRemainingPercent), status.dailyQuotaResetAtUnix);
        if (row) limits.push(row);
    }
    const weekly = percentRow("Weekly quota", { duration: 1, unit: "week" },
        usedPercent(status.weeklyQuotaRemainingPercent ?? status.dailyQuotaRemainingPercent),
        status.weeklyQuotaResetAtUnix);
    if (weekly) limits.push(weekly);
    const overage = nonNegative(status.overageBalanceMicros);
    const extraUsage = overage === undefined ? null : {
        balanceCents: overage / 10_000,
        currency: "USD"
    };
    return result(options, { limits, extraUsage, plan: text(info.planName) });
}

function inferRemainsMs(raw, end, now) {
    const value = nonNegative(raw);
    if (value === undefined || value <= 0) return undefined;
    const seconds = value * 1000;
    if (end !== undefined && end > now) {
        return Math.abs(seconds - (end - now)) <= Math.abs(value - (end - now)) ? seconds : value;
    }
    const max = 5.5 * 3600 * 1000;
    if (seconds <= max && value > max) return seconds;
    if (value <= max && seconds > max) return value;
    return seconds <= max ? seconds : value;
}

function miniMaxPlan(container, payload, total, region) {
    const explicit = text(container.current_subscribe_title ?? container.plan_name ?? container.plan
        ?? container.current_plan_title ?? container.combo_title ?? payload.current_subscribe_title
        ?? payload.plan_name ?? payload.plan);
    if (explicit) return explicit;
    const rounded = number(total) === undefined ? undefined : Math.round(number(total));
    if (rounded === undefined) return undefined;
    if (region === "CN") return ({ 600: "Starter", 1500: "Plus", 4500: "Max" })[rounded];
    const global = ({ 100: "Starter", 300: "Plus", 1000: "Max", 2000: "Ultra" });
    if (global[rounded]) return global[rounded];
    return rounded % 15 === 0 ? global[rounded / 15] : undefined;
}

export function parseMiniMaxUsage(payload, input) {
    const options = optionsOf(input);
    const vendor = { id: "minimax", name: "MiniMax" };
    if (!isObject(payload)) throw parseFail(vendor);
    const container = isObject(payload.data) ? payload.data : payload;
    const base = isObject(container.base_resp) ? container.base_resp : payload.base_resp;
    const status = number(base?.status_code);
    if (status !== undefined && status !== 0) {
        const message = text(base?.status_msg)?.toLowerCase() ?? "";
        const auth = status === 1004 || /cookie|log in|login/.test(message);
        throw fail(vendor, auth ? "AUTH" : "UPSTREAM",
            auth ? "MiniMax API Key 已失效，请更新凭据" : "MiniMax Token Plan 请求失败", status);
    }
    const rows = container.model_remains ?? payload.model_remains ?? container.modelRemains ?? payload.modelRemains;
    if (!Array.isArray(rows)) throw parseFail(vendor);
    if (!rows.length) return result(options);
    let chosen = rows.find((item) => nonNegative(item?.current_interval_total_count ?? item?.currentIntervalTotalCount) > 0);
    chosen ??= rows.find((item) => (item?.model_name ?? item?.modelName) === "general"
        && nonNegative(item?.current_interval_remaining_percent ?? item?.currentIntervalRemainingPercent) !== undefined);
    chosen ??= rows.find((item) => nonNegative(item?.current_interval_remaining_percent
        ?? item?.currentIntervalRemainingPercent) !== undefined);
    if (!isObject(chosen)) throw parseFail(vendor);

    const total = nonNegative(chosen.current_interval_total_count ?? chosen.currentIntervalTotalCount);
    const percent = nonNegative(chosen.current_interval_remaining_percent ?? chosen.currentIntervalRemainingPercent);
    const explicitUsed = nonNegative(chosen.current_interval_used_count ?? chosen.currentIntervalUsedCount
        ?? chosen.used_count ?? chosen.used);
    const remaining = nonNegative(chosen.current_interval_remaining_count ?? chosen.currentIntervalRemainingCount
        ?? chosen.current_interval_remains_count ?? chosen.currentIntervalRemainsCount
        ?? chosen.current_interval_remain_count ?? chosen.currentIntervalRemainCount
        ?? chosen.remaining_count ?? chosen.remainingCount ?? chosen.remains_count ?? chosen.remainsCount
        ?? chosen.remaining ?? chosen.remains ?? chosen.left_count ?? chosen.leftCount);
    const usageField = nonNegative(chosen.current_interval_usage_count ?? chosen.currentIntervalUsageCount);
    const inferredRemaining = remaining ?? usageField;
    let used = explicitUsed;
    if (used === undefined && total !== undefined && inferredRemaining !== undefined) used = total - inferredRemaining;
    if (used !== undefined && used < 0) used = undefined;

    const start = number(chosen.start_time ?? chosen.startTime);
    const end = number(chosen.end_time ?? chosen.endTime);
    const startMs = start === undefined ? undefined : (start < 10_000_000_000 ? start * 1000 : start);
    const endMs = end === undefined ? undefined : (end < 10_000_000_000 ? end * 1000 : end);
    const remains = inferRemainsMs(chosen.remains_time ?? chosen.remainsTime, endMs, options.now);
    const resetAtMs = endMs !== undefined && endMs > 0
        ? endMs : (remains === undefined ? undefined : options.now + remains);
    const resetAt = Number.isFinite(resetAtMs) ? new Date(resetAtMs).toISOString() : undefined;
    const window = startMs !== undefined && endMs !== undefined && endMs > startMs
        ? windowSeconds((endMs - startMs) / 1000) : { duration: 5, unit: "hour" };
    const region = options.region === "CN" ? "CN" : "GLOBAL";
    const plan = miniMaxPlan(container, payload, total, region);
    let row = percent !== undefined && (used === undefined || total === undefined || total === 0)
        ? percentRow("Session", window, percent, resetAt) : null;
    if (!row) {
        const scale = region === "CN" ? 1 / 15 : 1;
        row = makeRow({
            name: "Session", window,
            used: used === undefined ? undefined : used * scale,
            limit: total === undefined ? undefined : total * scale,
            remainingPercent: percent,
            resetAt
        });
    }
    if (!row) throw parseFail(vendor);
    return result(options, { limits: [row], plan });
}

export function parseTraeUsage(payload, input) {
    const options = optionsOf(input);
    const vendor = { id: "trae", name: "Trae" };
    if (!isObject(payload)) throw parseFail(vendor);
    if (payload.code === 1001) throw fail(vendor, "AUTH", "Trae 会话已过期，请重新登录 trae.cn");
    const summary = payload.usage_summary;
    if (payload.is_credits_billing !== true || !isObject(summary)) throw parseFail(vendor);
    const used = nonNegative(summary.consumed_amount);
    const limit = nonNegative(summary.total_amount);
    if (used === undefined || limit === undefined) throw parseFail(vendor);
    // Pack expiry does not establish one aggregate reset or recurring window.
    const row = makeRow({ name: "Credits", used, limit });
    const packs = Array.isArray(payload.user_entitlement_pack_list) ? payload.user_entitlement_pack_list : [];
    const subscription = packs.find((pack) => isObject(pack) && pack.group_type === 0
        && (pack.status === undefined || pack.status === 1));
    return result(options, { limits: [row], plan: text(subscription?.display_desc) });
}

function geminiTier(modelId) {
    const id = modelId.toLowerCase();
    if (id.includes("flash-lite")) return "Flash Lite";
    if (id.includes("flash")) return "Flash";
    if (id.includes("pro")) return "Pro";
    return undefined;
}

export function parseGeminiUsage(payload, input) {
    const options = optionsOf(input);
    const vendor = { id: "gemini", name: "Gemini" };
    if (!isObject(payload) || !Array.isArray(payload.buckets)) throw parseFail(vendor);
    const models = new Map();
    for (const bucket of payload.buckets) {
        if (!isObject(bucket)) continue;
        const modelId = text(bucket.modelId);
        const fraction = nonNegative(bucket.remainingFraction);
        if (!modelId || fraction === undefined) continue;
        const bounded = clamp(fraction, 0, 1);
        if (!models.has(modelId) || bounded < models.get(modelId).fraction) {
            models.set(modelId, { fraction: bounded, resetAt: bucket.resetTime });
        }
    }
    const groups = new Map();
    for (const [modelId, quota] of models) {
        const name = geminiTier(modelId) ?? modelId;
        if (!groups.has(name) || quota.fraction < groups.get(name).fraction) groups.set(name, quota);
    }
    const order = ["Pro", "Flash", "Flash Lite"];
    const names = [...groups.keys()].sort((a, b) => {
        const ai = order.includes(a) ? order.indexOf(a) : order.length;
        const bi = order.includes(b) ? order.indexOf(b) : order.length;
        return ai - bi || a.localeCompare(b);
    });
    const limits = names.map((name) => {
        const quota = groups.get(name);
        return percentRow(name, undefined, quota.fraction * 100, quota.resetAt);
    }).filter(Boolean);
    return result(options, { limits, plan: text(options.plan) });
}

function kiroPool(raw, name, window, resetAt) {
    if (!isObject(raw)) return null;
    return makeRow({
        name: text(raw.displayName) ?? name,
        window,
        used: raw.currentUsageWithPrecision ?? raw.currentUsage,
        limit: raw.usageLimitWithPrecision ?? raw.usageLimit,
        resetAt
    });
}

export function parseKiroUsage(payload, input) {
    const options = optionsOf(input);
    const vendor = { id: "kiro", name: "Kiro" };
    if (!isObject(payload)) throw parseFail(vendor);
    const breakdowns = Array.isArray(payload.usageBreakdownList) ? payload.usageBreakdownList : [];
    const primary = breakdowns.find((item) => isObject(item)
        && (item.resourceType === "CREDIT" || item.type === "CREDIT")) ?? breakdowns.find(isObject);
    const limits = [];
    if (primary) {
        const row = kiroPool(primary, "Credits", { duration: 1, unit: "month" },
            primary.nextDateReset ?? primary.resetDate);
        if (row) limits.push(row);
        const trial = primary.freeTrialInfo ?? primary.freeTrialUsage;
        if (isObject(trial) && (!trial.freeTrialStatus || trial.freeTrialStatus === "ACTIVE")) {
            const bonus = kiroPool(trial, "Bonus credits", undefined,
                trial.freeTrialExpiry ?? trial.expiryDate ?? trial.expiresAt);
            if (bonus) limits.push(bonus);
        }
        for (const item of Array.isArray(primary.bonuses) ? primary.bonuses : []) {
            if (!isObject(item) || (item.status && !["ACTIVE", "EXHAUSTED"].includes(item.status))) continue;
            const bonus = kiroPool(item, "Bonus credits", undefined, item.expiresAt ?? item.expiryDate);
            if (bonus) limits.push(bonus);
        }
    }
    return result(options, {
        limits,
        plan: titlePlan(payload.subscriptionInfo?.subscriptionTitle)
    });
}

function trpcEntries(payload) {
    if (Array.isArray(payload)) return payload;
    if (isObject(payload) && (payload.result || payload.error)) return [payload];
    if (isObject(payload)) {
        const entries = Object.entries(payload).filter(([key, value]) => /^\d+$/.test(key) && isObject(value));
        if (entries.length) return entries.sort((a, b) => Number(a[0]) - Number(b[0])).map(([, value]) => value);
    }
    return undefined;
}

function trpcPayload(entry) {
    if (!isObject(entry)) return undefined;
    if (isObject(entry.error)) {
        const inspection = JSON.stringify(entry.error).toLowerCase();
        const vendor = { id: "kilo", name: "Kilo" };
        if (/unauthorized|forbidden/.test(inspection)) {
            throw fail(vendor, "AUTH", "Kilo 凭据已失效，请更新 API Token 或重新运行 kilo auth login");
        }
        throw fail(vendor, "UPSTREAM", "Kilo tRPC 请求失败");
    }
    const data = entry.result?.data;
    if (isObject(data)) return data.json === null ? undefined : (data.json ?? data);
    return entry.result?.json === null ? undefined : entry.result?.json;
}

function kiloSubscription(payload) {
    if (!isObject(payload)) return undefined;
    if (isObject(payload.subscription)) return payload.subscription;
    if (["currentPeriodUsageUsd", "currentPeriodBaseCreditsUsd"].some((key) => payload[key] !== undefined)) return payload;
    return undefined;
}

export function parseKiloUsage(payload, input) {
    const options = optionsOf(input);
    const vendor = { id: "kilo", name: "Kilo" };
    const entries = trpcEntries(payload);
    if (!entries) throw parseFail(vendor);
    const creditsPayload = trpcPayload(entries[0]);
    const passPayload = trpcPayload(entries[1]);
    const limits = [];
    const blocks = Array.isArray(creditsPayload?.creditBlocks) ? creditsPayload.creditBlocks : [];
    let total = 0;
    let remaining = 0;
    let sawTotal = false;
    let sawRemaining = false;
    for (const block of blocks) {
        if (!isObject(block)) continue;
        const amount = nonNegative(block.amount_mUsd);
        const balance = nonNegative(block.balance_mUsd);
        if (amount !== undefined) { total += amount / 1_000_000; sawTotal = true; }
        if (balance !== undefined) { remaining += balance / 1_000_000; sawRemaining = true; }
    }
    if (sawTotal && sawRemaining) {
        const row = makeRow({ name: "Credits", used: Math.max(0, total - remaining), limit: total });
        if (row) limits.push(row);
    }
    const subscription = kiloSubscription(passPayload);
    let plan;
    if (subscription) {
        const used = nonNegative(subscription.currentPeriodUsageUsd);
        const base = nonNegative(subscription.currentPeriodBaseCreditsUsd);
        const bonus = nonNegative(subscription.currentPeriodBonusCreditsUsd) ?? 0;
        const row = makeRow({
            name: "Kilo Pass", window: { duration: 1, unit: "month" }, used,
            limit: base === undefined ? undefined : base + bonus,
            resetAt: subscription.nextBillingAt ?? subscription.nextRenewalAt
                ?? subscription.renewsAt ?? subscription.renewAt
        });
        if (row) limits.push(row);
        plan = text(subscription.tier) ?? "Kilo Pass";
    }
    return result(options, { limits, plan });
}

function claudeProfilePlan(payload) {
    const organization = payload?.organization;
    if (!isObject(organization)) return undefined;
    const type = text(organization.organization_type)?.replace(/^claude_/, "");
    const base = titlePlan(type);
    const multiplier = text(organization.rate_limit_tier)?.match(/(\d+)x/i)?.[1];
    return base && multiplier ? `${base} ${multiplier}x` : base;
}

function geminiPlan(payload) {
    if (!isObject(payload)) return {};
    const paid = text(payload.paidTier?.name);
    if (paid) return { plan: paid };
    const tier = text(payload.currentTier?.id ?? payload.currentTier);
    const plan = tier === "standard-tier" ? "Paid" : tier === "free-tier" ? "Free"
        : tier === "legacy-tier" ? "Legacy" : undefined;
    const unsupported = Array.isArray(payload.ineligibleTiers) && payload.ineligibleTiers.some((item) =>
        item?.reasonCode === "UNSUPPORTED_CLIENT");
    if (unsupported && tier !== "standard-tier") {
        throw fail({ id: "gemini", name: "Gemini" }, "UNSUPPORTED",
            "Gemini CLI OAuth 不再支持此个人订阅层级，请使用受支持的 Code Assist 订阅");
    }
    const project = text(payload.cloudaicompanionProject?.id ?? payload.cloudaicompanionProject);
    return { plan, projectId: project };
}

async function requestVendor(vendor, url, init, timeoutMs) {
    try {
        return await requestJson(url, init, timeoutMs);
    } catch (error) {
        if (error instanceof HttpRequestError) {
            throw fail(vendor, "UPSTREAM", error.kind === "timeout"
                ? `${vendorName(vendor)} 请求超时，请稍后重试`
                : `${vendorName(vendor)} 网络请求失败，请检查连接`);
        }
        throw error;
    }
}

function assertResponse(vendor, { response, payload }, credential) {
    if (response.ok) return payload;
    const auth = response.status === 401 || response.status === 403;
    if (auth && credential?.source === "cli") {
        const command = text(vendor.cli?.command) ?? "官方登录";
        throw fail(vendor, "AUTH", `${vendorName(vendor)} CLI 凭据已过期或被拒绝，请重新运行 ${command} 后重试`, response.status);
    }
    throw fail(vendor, auth ? "AUTH" : "UPSTREAM", auth
        ? `${vendorName(vendor)} 认证失败，请重新登录或更新凭据`
        : `${vendorName(vendor)} 服务请求失败（HTTP ${response.status}）`, response.status);
}

function requireKinds(vendor, credential, kinds) {
    if (!isObject(credential) || !kinds.includes(credential.kind)) {
        throw fail(vendor, "UNSUPPORTED", `${vendorName(vendor)} 不支持 ${text(credential?.kind) ?? "未知"} 凭据用于订阅用量`);
    }
    if (credential.kind === "oauth") {
        if (!isObject(credential.secret) || !text(credential.secret.access)) {
            throw fail(vendor, "AUTH", `${vendorName(vendor)} OAuth access token 缺失，请重新连接`);
        }
    } else if (!text(credential.secret)) {
        throw fail(vendor, "AUTH", `${vendorName(vendor)} 凭据为空，请重新连接`);
    }
}

function jwtExpiry(token) {
    if (typeof token !== "string") return undefined;
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        const expires = number(payload.exp);
        return expires === undefined ? undefined : expires * 1000;
    } catch {
        return undefined;
    }
}

function cliRelogin(vendor) {
    const command = text(vendor.cli?.command) ?? "官方登录";
    return fail(vendor, "AUTH", `${vendorName(vendor)} CLI OAuth 凭据已过期，请重新运行 ${command}；不会刷新或改写 CLI 凭据文件`);
}

async function refreshOAuth(vendor, credential, context) {
    if (credential.source === "cli") throw cliRelogin(vendor);
    if (credential.source !== "manual") {
        throw fail(vendor, "AUTH", `${vendorName(vendor)} OAuth 凭据不归本模块所有，请重新连接`);
    }
    if (!["chatgpt", "claude", "kiro", "kimi"].includes(vendor.id)) {
        throw fail(vendor, "AUTH", `${vendorName(vendor)} 不支持安全刷新此 OAuth 记录，请重新登录后更新凭据`);
    }
    const refresh = text(credential.secret.refresh);
    if (!refresh) throw fail(vendor, "AUTH", `${vendorName(vendor)} OAuth refresh token 缺失，请重新连接`);
    if (typeof context.writeCredential !== "function") {
        throw fail(vendor, "AUTH", `${vendorName(vendor)} OAuth 需要刷新，但未提供自有记录写入器，请重新连接`);
    }

    let url;
    let init;
    if (vendor.id === "chatgpt") {
        url = "https://auth.openai.com/oauth/token";
        init = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: formBody({ grant_type: "refresh_token", client_id: CODEX_CLIENT_ID, refresh_token: refresh }) };
    } else if (vendor.id === "claude") {
        url = "https://platform.claude.com/v1/oauth/token";
        init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh,
                client_id: CLAUDE_CLIENT_ID, scope: CLAUDE_SCOPES }) };
    } else if (vendor.id === "kiro") {
        url = KIRO_REFRESH_URL;
        init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ refreshToken: refresh }) };
    } else {
        url = "https://auth.kimi.com/api/oauth/token";
        init = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: formBody({ grant_type: "refresh_token", client_id: KIMI_CLIENT_ID, refresh_token: refresh }) };
    }
    const response = await requestVendor(vendor, url, init);
    if ([400, 401, 403].includes(response.response.status)) {
        throw fail(vendor, "AUTH", `${vendorName(vendor)} OAuth 刷新被拒绝，请重新登录后更新凭据`, response.response.status);
    }
    assertResponse(vendor, response, credential);
    const payload = response.payload;
    const access = text(payload?.access_token ?? payload?.accessToken);
    if (!access || !isObject(payload)) throw parseFail(vendor);
    const expiresIn = nonNegative(payload.expires_in ?? payload.expiresIn);
    if (vendor.id !== "chatgpt" && (expiresIn === undefined || expiresIn <= 0)) throw parseFail(vendor);
    const expires = expiresIn !== undefined && expiresIn > 0
        ? context.now + expiresIn * 1000 : jwtExpiry(access);
    const secret = {
        ...credential.secret,
        access,
        refresh: text(payload.refresh_token ?? payload.refreshToken) ?? refresh,
        ...(expires !== undefined ? { expires } : { expires: undefined }),
        ...(text(payload.profileArn) ? { profileArn: text(payload.profileArn) } : {})
    };
    const next = { ...credential, kind: "oauth", source: "manual", secret };
    for (const key of ["fingerprint", "verifiedFingerprint", "verifiedAt", "lastError", "path"]) delete next[key];
    try {
        await context.writeCredential(next);
    } catch {
        throw fail(vendor, "AUTH", `${vendorName(vendor)} OAuth 刷新后保存失败，请重新连接`);
    }
    return next;
}

async function prepareOAuth(vendor, credential, context, force) {
    requireKinds(vendor, credential, ["oauth"]);
    const expires = number(credential.secret.expires);
    if (force || (expires !== undefined && expires <= context.now + REFRESH_LEEWAY_MS)) {
        return refreshOAuth(vendor, credential, context);
    }
    return credential;
}

async function oauthRequest(vendor, credential, context, operation) {
    let current = await prepareOAuth(vendor, credential, context, false);
    let response = await operation(current.secret);
    if (response.response.status === 401 && current === credential) {
        current = await prepareOAuth(vendor, credential, context, true);
        response = await operation(current.secret);
    }
    assertResponse(vendor, response, credential);
    return { ...response, credential: current };
}

async function fetchKimi(vendor, credential, context) {
    requireKinds(vendor, credential, ["api-key", "oauth"]);
    const usageUrl = "https://api.kimi.com/coding/v1/usages";
    const call = (token) => requestVendor(vendor, usageUrl, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" }
    });
    const response = credential.kind === "oauth"
        ? await oauthRequest(vendor, credential, context, (secret) => call(secret.access))
        : await call(credential.secret);
    const payload = assertResponse(vendor, response, credential);
    return parseKimiUsage(payload, context);
}

async function fetchCodex(vendor, credential, context) {
    requireKinds(vendor, credential, ["oauth"]);
    const { response, payload } = await oauthRequest(vendor, credential, context, (secret) =>
        requestVendor(vendor, "https://chatgpt.com/backend-api/wham/usage", {
            headers: {
                authorization: `Bearer ${secret.access}`, accept: "application/json",
                ...(text(secret.accountId) ? { "ChatGPT-Account-Id": text(secret.accountId) } : {})
            }
        }));
    return parseCodexUsage(payload, { ...context, headers: response.headers });
}

async function fetchClaude(vendor, credential, context) {
    requireKinds(vendor, credential, ["oauth"]);
    if (Array.isArray(credential.secret.scopes) && !credential.secret.scopes.includes("user:profile")) {
        throw fail(vendor, "AUTH", "Claude 用量接口需要 user:profile；claude setup-token 不能替代，请运行 claude login");
    }
    let profilePlan;
    const { payload } = await oauthRequest(vendor, credential, context, async (secret) => {
        const headers = {
            authorization: `Bearer ${secret.access}`, accept: "application/json",
            "content-type": "application/json", "anthropic-beta": "oauth-2025-04-20",
            "user-agent": "claude-cli/2.1.280 (external, cli)"
        };
        const usage = await requestVendor(vendor, "https://api.anthropic.com/api/oauth/usage?cedar_ember=1", { headers });
        if (usage.response.ok) {
            try {
                const profile = await requestVendor(vendor, "https://api.anthropic.com/api/oauth/profile", { headers });
                if (profile.response.ok) profilePlan = claudeProfilePlan(profile.payload);
            } catch {
                // Usage already proves authentication; plan enrichment is optional.
            }
        }
        return usage;
    });
    const parsed = parseClaudeUsage(payload, context);
    const plan = profilePlan ?? titlePlan(credential.secret.subscriptionType);
    return plan ? { ...parsed, plan } : parsed;
}

async function fetchGlm(vendor, credential, context) {
    requireKinds(vendor, credential, ["api-key"]);
    const selected = text(credential.region)?.toUpperCase();
    const bases = selected === "CN" ? ["https://open.bigmodel.cn"]
        : selected === "INTL" || selected === "GLOBAL" ? ["https://api.z.ai"]
            : ["https://api.z.ai", "https://open.bigmodel.cn"];
    let lastError;
    for (const base of bases) {
        try {
            const headers = { authorization: `Bearer ${credential.secret}`, accept: "application/json" };
            const response = await requestVendor(vendor, `${base}/api/monitor/usage/quota/limit`, { headers });
            const payload = assertResponse(vendor, response, credential);
            const parsed = parseGlmUsage(payload, context);
            if (base === "https://api.z.ai") {
                try {
                    const subscription = await requestVendor(vendor, `${base}/api/biz/subscription/list`, { headers });
                    if (subscription.response.ok) {
                        const plan = Array.isArray(subscription.payload?.data)
                            ? text(subscription.payload.data[0]?.productName) : undefined;
                        if (plan) return { ...parsed, plan };
                    }
                } catch {
                    // Quota remains valid when optional subscription metadata is unavailable.
                }
            }
            return parsed;
        } catch (error) {
            if (lastError?.code !== "AUTH" || error.code === "AUTH") lastError = error;
        }
    }
    throw lastError ?? parseFail(vendor);
}

const QWEN_REGIONS = {
    INTL: {
        base: "https://modelstudio.console.alibabacloud.com",
        regionId: "ap-southeast-1", commodityCode: "sfm_codingplan_public_intl",
        referer: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan"
    },
    CN: {
        base: "https://bailian.console.aliyun.com",
        regionId: "cn-beijing", commodityCode: "sfm_codingplan_public_cn",
        referer: "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/efm/coding_plan"
    }
};

function qwenUrl(region) {
    const url = new URL("/data/api.json", region.base);
    url.searchParams.set("action", "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2");
    url.searchParams.set("product", "broadscope-bailian");
    url.searchParams.set("api", "queryCodingPlanInstanceInfoV2");
    url.searchParams.set("currentRegionId", region.regionId);
    return url.href;
}

async function fetchQwen(vendor, credential, context) {
    requireKinds(vendor, credential, ["api-key"]);
    const selected = text(credential.region)?.toUpperCase();
    const regions = selected === "CN" || selected === "INTL" ? [selected] : ["INTL", "CN"];
    let lastError;
    for (const id of regions) {
        const region = QWEN_REGIONS[id];
        try {
            const response = await requestVendor(vendor, qwenUrl(region), {
                method: "POST",
                headers: {
                    authorization: `Bearer ${credential.secret}`, "x-api-key": credential.secret,
                    "X-DashScope-API-Key": credential.secret,
                    "content-type": "application/json", accept: "application/json",
                    origin: region.base, referer: region.referer
                },
                body: JSON.stringify({ queryCodingPlanInstanceInfoRequest: { commodityCode: region.commodityCode } })
            });
            const payload = assertResponse(vendor, response, credential);
            return parseQwenUsage(payload, { ...context, region: id });
        } catch (error) {
            if (lastError?.code !== "AUTH" || error.code === "AUTH") lastError = error;
        }
    }
    throw lastError ?? parseFail(vendor);
}

async function fetchDevin(vendor, credential, context) {
    requireKinds(vendor, credential, ["session"]);
    if (!credential.secret.startsWith("devin-session-token$")) {
        throw fail(vendor, "UNSUPPORTED",
            "Devin 个人浏览器 Bearer 与 CLI 会话不通用；此适配器仅支持 devin-session-token$ 的 GetUserStatus 路径");
    }
    const response = await requestVendor(vendor,
        "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus", {
            method: "POST",
            headers: { "content-type": "application/json", "Connect-Protocol-Version": "1", accept: "application/json" },
            body: JSON.stringify({ metadata: {
                apiKey: credential.secret, ideName: "devin", ideVersion: "1.108.2",
                extensionName: "devin", extensionVersion: "1.108.2", locale: "en"
            } })
        });
    return parseDevinUsage(assertResponse(vendor, response, credential), context);
}

async function fetchKilo(vendor, credential, context) {
    requireKinds(vendor, credential, ["api-key", "session"]);
    const procedures = ["user.getCreditBlocks", "kiloPass.getState"];
    const url = new URL(`/api/trpc/${procedures.join(",")}`, "https://app.kilo.ai");
    url.searchParams.set("batch", "1");
    url.searchParams.set("input", JSON.stringify({
        "0": { json: null }, "1": { json: null }
    }));
    const headers = { authorization: `Bearer ${credential.secret}`, accept: "application/json" };
    const response = await requestVendor(vendor, url, { headers });
    if (response.response.status === 404) {
        // Older Kilo deployments expose profile only: validate auth, claim no quota.
        const profile = await requestVendor(vendor, "https://api.kilo.ai/api/profile", { headers });
        const payload = assertResponse(vendor, profile, credential);
        if (!isObject(payload)) throw parseFail(vendor);
        return result(context);
    }
    return parseKiloUsage(assertResponse(vendor, response, credential), context);
}

function kiroRegion(profileArn) {
    const region = String(profileArn).split(":")[3];
    if (!/^[a-z0-9-]+$/i.test(region ?? "")) {
        throw fail({ id: "kiro", name: "Kiro" }, "AUTH", "Kiro profileArn 缺少有效区域，请重新导入 OAuth 凭据");
    }
    return region;
}

async function fetchKiro(vendor, credential, context) {
    if (credential?.kind === "api-key") {
        throw fail(vendor, "UNSUPPORTED", "Kiro 订阅 API Key 用量端点尚未接入；请使用带 profileArn 的 OAuth 凭据");
    }
    requireKinds(vendor, credential, ["oauth"]);
    const initialArn = text(credential.secret.profileArn);
    const { payload } = await oauthRequest(vendor, credential, context, (secret) => {
        const arn = text(secret.profileArn) ?? initialArn;
        if (!arn) throw fail(vendor, "AUTH", "Kiro OAuth 凭据缺少 profileArn，请重新导入");
        const url = new URL(`https://q.${kiroRegion(arn)}.amazonaws.com/getUsageLimits`);
        url.searchParams.set("origin", "AI_EDITOR");
        url.searchParams.set("profileArn", arn);
        url.searchParams.set("resourceType", "AGENTIC_REQUEST");
        return requestVendor(vendor, url, {
            headers: {
                authorization: `Bearer ${secret.access}`, accept: "application/json",
                ...(secret.authMethod === "external_idp" ? { TokenType: "EXTERNAL_IDP" } : {})
            }
        });
    });
    return parseKiroUsage(payload, context);
}

async function fetchCerebras(vendor, credential, context) {
    requireKinds(vendor, credential, ["api-key"]);
    const response = await requestVendor(vendor, "https://api.cerebras.ai/v1/models", {
        headers: { authorization: `Bearer ${credential.secret}`, accept: "application/json" }
    });
    const payload = assertResponse(vendor, response, credential);
    if (!isObject(payload) || !Array.isArray(payload.data)) throw parseFail(vendor);
    return result(context); // This endpoint verifies auth; it exposes no subscription quota.
}

async function fetchMiniMax(vendor, credential, context) {
    requireKinds(vendor, credential, ["api-key"]);
    const selected = text(credential.region)?.toUpperCase();
    const regions = selected === "CN" || selected === "GLOBAL" ? [selected] : ["GLOBAL", "CN"];
    let lastError;
    for (const region of regions) {
        const base = region === "CN" ? "https://api.minimaxi.com" : "https://www.minimax.io";
        try {
            const response = await requestVendor(vendor, `${base}/v1/token_plan/remains`, {
                headers: { authorization: `Bearer ${credential.secret}`, accept: "application/json",
                    "content-type": "application/json" }
            });
            const payload = assertResponse(vendor, response, credential);
            return parseMiniMaxUsage(payload, { ...context, region });
        } catch (error) {
            if (lastError?.code !== "AUTH" || error.code === "AUTH") lastError = error;
        }
    }
    throw lastError ?? parseFail(vendor);
}

async function fetchTrae(vendor, credential, context) {
    requireKinds(vendor, credential, ["cookie"]);
    const cookie = credential.secret.replace(/^Cookie:\s*/i, "");
    if (!cookie) throw fail(vendor, "AUTH", "Trae Cookie 为空，请重新粘贴");
    const headers = {
        cookie, origin: "https://www.trae.cn", referer: "https://www.trae.cn/",
        "content-type": "application/json", accept: "application/json"
    };
    const exchanged = await requestVendor(vendor, "https://api.trae.cn/cloudide/api/v3/common/GetUserToken", {
        method: "POST", headers, body: "{}"
    });
    const tokenPayload = assertResponse(vendor, exchanged, credential);
    if (tokenPayload?.code === 1001) throw fail(vendor, "AUTH", "Trae 会话已过期，请重新登录 trae.cn");
    const token = text(tokenPayload?.Result?.Token);
    if (!token) throw parseFail(vendor);
    // The exchanged token is scoped to this call and is never persisted.
    const response = await requestVendor(vendor, "https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list", {
        method: "POST",
        headers: { ...headers, authorization: `Cloud-IDE-JWT ${token}` },
        body: JSON.stringify({ require_usage: true, full_data: true })
    });
    return parseTraeUsage(assertResponse(vendor, response, credential), context);
}

async function fetchGemini(vendor, credential, context) {
    requireKinds(vendor, credential, ["oauth"]);
    let metadata = {};
    let metadataTried = false;
    const { payload } = await oauthRequest(vendor, credential, context, async (secret) => {
        const headers = { authorization: `Bearer ${secret.access}`, accept: "application/json",
            "content-type": "application/json" };
        if (!metadataTried) {
            metadataTried = true;
            try {
                const status = await requestVendor(vendor, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
                    method: "POST", headers,
                    body: JSON.stringify({ metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } })
                });
                if (status.response.ok) metadata = geminiPlan(status.payload);
            } catch (error) {
                if (error instanceof SubscriptionUsageError && error.code === "UNSUPPORTED") throw error;
                // Quota can succeed without tier metadata; use any project from the imported credential.
            }
        }
        const project = metadata.projectId ?? text(secret.projectId);
        return requestVendor(vendor, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
            method: "POST", headers, body: JSON.stringify(project ? { project } : {})
        });
    });
    return parseGeminiUsage(payload, { ...context, plan: metadata.plan });
}

async function fetchClinePass(vendor) {
    throw fail(vendor, "UNSUPPORTED", "ClinePass 没有已确认的订阅额度或只读验证端点");
}

const FETCHERS = {
    kimi: fetchKimi,
    chatgpt: fetchCodex,
    claude: fetchClaude,
    glm: fetchGlm,
    qwen: fetchQwen,
    devin: fetchDevin,
    kilo: fetchKilo,
    kiro: fetchKiro,
    cerebras: fetchCerebras,
    minimax: fetchMiniMax,
    trae: fetchTrae,
    gemini: fetchGemini,
    clinepass: fetchClinePass
};

export async function fetchSubscriptionUsage(vendor, credential, { writeCredential, now } = {}) {
    if (!isObject(vendor) || typeof FETCHERS[vendor.id] !== "function") {
        throw new SubscriptionUsageError("UNSUPPORTED", "不支持此订阅厂商或用量适配器", { vendor: text(vendor?.id) });
    }
    const context = { writeCredential, now: nowMs(now) };
    try {
        return await FETCHERS[vendor.id](vendor, credential, context);
    } catch (error) {
        if (error instanceof SubscriptionUsageError) throw error;
        throw fail(vendor, "PARSE", `${vendorName(vendor)} 用量响应解析失败`);
    }
}

/** Pure parser seams. No request is made at module load or by these functions. */
export const usageTest = Object.freeze({
    parseKimiUsage,
    parseCodexUsage,
    parseClaudeUsage,
    parseGlmUsage,
    parseQwenUsage,
    parseMiniMaxUsage,
    parseDevinUsage,
    parseGeminiUsage,
    parseKiroUsage,
    parseTraeUsage,
    parseKiloUsage,
    kimiWindow
});
