const clampPercent = (value) => Math.max(0, Math.min(100, value));
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const iso = (value) => {
    if (value === undefined || value === null || value === "") return undefined;
    const time = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

function row(name, window, { used, limit, remainingPercent, resetAt }) {
    const percent = finite(remainingPercent);
    if (finite(used) === undefined && finite(limit) === undefined && percent === undefined && iso(resetAt) === undefined) return null;
    return {
        name,
        ...(window ? { window } : {}),
        ...(finite(used) !== undefined ? { used } : {}),
        ...(finite(limit) !== undefined ? { limit } : {}),
        ...(percent !== undefined ? { remainingPercent: clampPercent(percent) } : {}),
        ...(iso(resetAt) ? { resetAt: iso(resetAt) } : {})
    };
}

function envelope(usage, plan) {
    return {
        summary: null,
        limits: usage.limits.filter(Boolean),
        extraUsage: usage.extraUsage ?? null,
        ...(plan ? { plan } : {}),
        fetchedAt: Date.now(),
        verification: "subscription"
    };
}

/** Project the author's Protocom GroupBalance without changing its acquisition. */
export function protocomUsageView(balance, group, vendor) {
    const limit = finite(balance.limit);
    const used = finite(balance.used);
    const remaining = finite(balance.remaining);
    const remainingPercent = limit > 0 && remaining !== undefined
        ? remaining / limit * 100
        : limit > 0 && used !== undefined ? (limit - used) / limit * 100 : undefined;
    return envelope({
        limits: [
            limit !== undefined || used !== undefined || remainingPercent !== undefined
                ? row("总额度", undefined, { used, limit, remainingPercent })
                : null,
            row("日额度", { duration: 1, unit: "day" }, {
                used: finite(balance.dailyUsageUsd),
                limit: finite(balance.dailyLimitUsd)
            })
        ],
        extraUsage: {
            balance: finite(balance.balance),
            remaining,
            unit: balance.unit,
            todayRequests: finite(balance.todayRequests),
            todayCost: finite(balance.todayCost),
            expiresAt: iso(balance.expiresAt),
            rateMultiplier: finite(balance.rateMultiplier),
            groupRateMultiplier: finite(balance.groupRateMultiplier)
        }
    }, balance.planName ?? group?.plan ?? vendor.plan);
}

/** Project the author's three OpenCode Go windows from used to remaining %. */
export function openCodeUsageView(usage, vendor) {
    const convert = (value, name, window) => {
        const filled = finite(value?.percent);
        if (filled === undefined) return null;
        const remaining = clampPercent(100 - filled);
        return row(name, window, {
            used: 100 - remaining,
            limit: 100,
            remainingPercent: remaining,
            resetAt: value.resetsAt
        });
    };
    return envelope({
        limits: [
            convert(usage.rolling, "5小时", { duration: 5, unit: "hour" }),
            convert(usage.weekly, "周额度", { duration: 1, unit: "week" }),
            convert(usage.monthly, "月额度", { duration: 1, unit: "month" })
        ]
    }, vendor.plan);
}

/** Project the author's independently degrading Command Code account view. */
export function commandCodeUsageView(view, vendor) {
    const reachable = view.credits?.reachable === true || view.usage?.reachable === true;
    if (!reachable) {
        const error = new Error(view.credentialRejected
            ? "Command Code 认证失败，请更新 API Key"
            : "Command Code 账户接口当前不可用");
        error.code = view.credentialRejected ? "AUTH" : "UPSTREAM";
        throw error;
    }
    const credits = view.account?.credits ?? {};
    const usage = view.account?.usage ?? {};
    const convert = (value, name, window) => {
        if (!value) return null;
        const used = finite(value.used);
        const cap = finite(value.cap);
        const remaining = finite(value.remaining);
        return row(name, window, {
            used,
            limit: cap,
            remainingPercent: cap > 0 && remaining !== undefined
                ? remaining / cap * 100
                : cap > 0 && used !== undefined ? (cap - used) / cap * 100 : undefined,
            resetAt: value.resetAt
        });
    };
    return envelope({
        limits: [
            convert(credits.fiveHour, "5小时", { duration: 5, unit: "hour" }),
            convert(credits.weekly, "周额度", { duration: 1, unit: "week" })
        ],
        extraUsage: {
            monthlyCredits: finite(credits.monthlyCredits),
            purchasedCredits: finite(credits.purchasedCredits),
            freeCredits: finite(credits.freeCredits),
            periodCost: finite(usage.cost),
            periodRequests: finite(usage.requests),
            creditsReachable: view.credits?.reachable === true,
            usageReachable: view.usage?.reachable === true
        }
    }, vendor.plan);
}
