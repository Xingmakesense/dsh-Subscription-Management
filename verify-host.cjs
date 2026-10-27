const { join } = require("node:path");

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = (actual, expected, message) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
};

async function main() {
    const { __test } = await import("./host.js");
    same(__test.normalizeOptions(undefined).value, { enabled: true });
    same(__test.normalizeOptions({ enabled: false }).value, { enabled: false });
    assert(Array.isArray(__test.normalizeOptions({ enabled: "yes" }).issues), "enabled must be boolean");

    const raw = {
        usage: { used: 40, limit: 100 },
        limits: [
            { name: "5h", window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { used: 10, limit: 100 } },
            { name: "month", window: { duration: 1, timeUnit: "TIME_UNIT_MONTH" }, detail: { used: 1, limit: 10 } }
        ],
        boosterWallet: {
            balance: { type: "BOOSTER", amount: 50_000_000, amountLeft: 12_340_000 },
            monthlyChargeLimitEnabled: true,
            monthlyChargeLimit: { priceInCents: 6000, currency: "USD" },
            monthlyUsed: { priceInCents: 2345, currency: "USD" }
        }
    };
    const usage = __test.parseKimiUsage(raw);
    same(usage.limits[0].window, { duration: 5, unit: "hour" });
    assert(usage.limits[0].remainingPercent === 90, "5h remaining is derived from real counters");
    same(usage.limits[1].window, { duration: 1, unit: "month" });
    assert(usage.extraUsage.monthlyUsedCents === 2345, "booster money stays in cents");
    assert(__test.parseKimiCredential('{"type":"api_key","key":"abc"}').type === "api_key");
    assert(__test.parseKimiCredential('{"type":"oauth","access":"a","refresh":"r","expires":1}').type === "oauth");
    assert(__test.parseKimiCredential("not-json") === undefined);

    const wallet = __test.accountBalanceFromWallets({
        status: "ready",
        value: [{ currency: "CNY", balance: "100.25" }],
        bonusWallets: [{ currency: "CNY", balance: "20.75" }]
    });
    assert(wallet.totalBalance === 121 && wallet.rechargeBalance === 100.25 && wallet.bonusBalance === 20.75,
        "DeepSeek wallets must sum recharge and bonus");
    const now = Date.UTC(2026, 9, 26, 10, 0, 0);
    const root = join(process.cwd(), "tmp", "host-account-profile");
    const { rmSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
    process.env.DSH_PROFILE_DIR = root;
    assert(__test.recordTodayUsage(100, "CNY", now) === 0, "first balance is a baseline");
    assert(__test.recordTodayUsage(90, "CNY", now + 60_000) === 10, "balance drop is observed spend");
    assert(__test.recordTodayUsage(110, "CNY", now + 120_000) === 10, "top-up does not erase spend");
    assert(__test.recordTodayUsage(80, "CNY", now + 86400_000) === 0, "new day starts a fresh baseline");
    rmSync(root, { recursive: true, force: true });
    console.log("subscription host checks passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
