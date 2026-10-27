        const BALANCE_SLOT = "sidebar.footer.action";
        const AUTH_SETTINGS_SLOT = "settings.section";

        function mountSubscription(ctx) {
            const connection = typeof ctx.get === "function" ? ctx.get("connection") : undefined;
            if (connection === undefined || connection === null || connection.rpc === undefined) return;
            ctx.inject(["slots", "connection"], (scope) => {
                let disposeBalance;
                let disposeAuth;
                const timers = [];
                const install = () => {
                    if (disposeBalance !== undefined && disposeAuth !== undefined) return true;
                    const slots = scope.get("slots");
                    const rpc = scope.get("connection")?.rpc ?? connection.rpc;
                    if (slots === undefined || rpc === undefined) return false;
                    if (disposeBalance === undefined) {
                        disposeBalance = slots.inject(BALANCE_SLOT, () => slots.register({
                            name: BALANCE_SLOT,
                            id: "dsh-subscription-management-balance",
                            order: 90,
                            inject: (wide) => ({ rpc, wide })
                        }, BalanceCard));
                    }
                    if (disposeAuth === undefined) {
                        disposeAuth = slots.inject(AUTH_SETTINGS_SLOT, () => slots.register({
                            name: AUTH_SETTINGS_SLOT,
                            id: "dsh-subscription-management-auth",
                            order: 17,
                            label: "订阅认证",
                            inject: () => ({ rpc })
                        }, SubscriptionAuthSettings));
                    }
                    return true;
                };
                if (!install()) {
                    for (const delay of [250, 1_000, 3_000]) {
                        timers.push(setTimeout(install, delay));
                    }
                }
                return () => {
                    for (const timer of timers) clearTimeout(timer);
                    try { disposeAuth?.(); } catch { /* ignore */ }
                    try { disposeBalance?.(); } catch { /* ignore */ }
                };
            });
        }

        const apply = (ctx, config) => {
            const normalized = normalizeOptions(config);
            if (normalized.value?.enabled !== true) return;
            try {
                if (typeof ctx.effect === "function") ctx.effect(() => installStyle());
                else installStyle();
            } catch (error) {
                console.warn("[dsh-subscription-management] stylesheet skipped:", error);
            }
            try {
                mountSubscription(ctx);
            } catch (error) {
                console.warn("[dsh-subscription-management] mount skipped:", error);
            }
        };

        const Config = {
            "~standard": { version: 1, vendor: "dsh-subscription-management", validate: normalizeOptions }
        };

        exports.name = name;
        exports.inject = inject;
        exports.apply = apply;
        exports.Config = Config;
        if (typeof globalThis !== "undefined" && globalThis.__DSH_UAK_TEST__ === true) {
            exports.__test = {
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
                activeModelLabel,
                runningSessionIds,
                endedRunningSessions
            };
        }
