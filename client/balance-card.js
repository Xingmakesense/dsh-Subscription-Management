        // Sidebar card: subscription quota above, DeepSeek balance/today below.
        const DEEPSEEK_FALLBACK_CURRENCY = "CNY";

        function formatQuotaPercent(percent) {
            return Number.isFinite(percent) ? `${Math.round(Math.max(0, Math.min(100, percent)))}%` : "—";
        }

        function formatCurrencyAmount(amount, currency) {
            if (!Number.isFinite(amount)) return undefined;
            const code = typeof currency === "string" && currency.length > 0 ? currency : DEEPSEEK_FALLBACK_CURRENCY;
            try {
                return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(amount);
            } catch {
                return `${formatQuotaNumber(amount)} ${code}`;
            }
        }

        function accountOverallState(kimiState, deepState) {
            const kimiData = kimiState?.usage !== undefined && kimiState?.usage !== null;
            const deepData = deepState?.data !== undefined && deepState?.data !== null;
            const hasError = (state) => ["error", "unavailable", "unauthenticated"].includes(state?.status);
            if (kimiData && deepData && !hasError(kimiState) && !hasError(deepState)) return "ready";
            if (kimiData || deepData) return "partial";
            if (["loading", "refreshing"].includes(kimiState?.status)
                || ["loading", "refreshing"].includes(deepState?.status)) return "loading";
            return "error";
        }

        function subscriptionVendorName(vendor) {
            if (typeof vendor !== "string" || vendor.length === 0) return "订阅";
            const known = SUBSCRIPTION_VENDORS.find((item) => item.id === vendor);
            return known?.name ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
        }

        /** Which subscription vendor a selected model belongs to, if any. */
        function vendorForModel(model, provider) {
            const text = `${typeof model === "string" ? model : ""} ${typeof provider === "string" ? provider : ""}`
                .toLowerCase();
            if (text.trim().length === 0) return undefined;
            const route = typeof provider === "string" && provider.length > 0
                ? provider.toLowerCase()
                : text.trim().split(/\s+/)[0];
            const exact = SUBSCRIPTION_VENDORS.find((vendor) =>
                [vendor.id, ...Array.isArray(vendor.modelAliases) ? vendor.modelAliases : []]
                    .some((alias) => route === String(alias).toLowerCase()));
            if (exact !== undefined) return exact.id;
            const match = SUBSCRIPTION_VENDORS.find((vendor) =>
                [vendor.id, ...Array.isArray(vendor.modelAliases) ? vendor.modelAliases : []]
                    .some((alias) => text.includes(String(alias).toLowerCase())));
            return match?.id;
        }

        /** Pure card projection, also used by regression tests. */
        function balanceCardView(kimiState, deepState, modelLabel) {
            const slots = quotaSlots(kimiState?.usage);
            const data = deepState?.data;
            const deepCurrency = data?.currency ?? DEEPSEEK_FALLBACK_CURRENCY;
            const vendor = SUBSCRIPTION_VENDORS.find((item) => item.id === kimiState?.vendor);
            const vendorName = subscriptionVendorName(kimiState?.vendor);
            const balanceText = formatCurrencyAmount(data?.totalBalance, deepCurrency) ?? "—";
            const todayText = formatCurrencyAmount(
                data?.todayUsage,
                data?.todayUsageCurrency ?? deepCurrency
            ) ?? "—";
            const views = slots.map((slot) => {
                const percent = remainingPercentOf(slot.row);
                return {
                    id: slot.id,
                    label: slot.label,
                    bar: slot.bar === true,
                    depth: Number.isFinite(slot.depth) ? slot.depth : 0,
                    percent,
                    text: formatQuotaPercent(percent),
                    resetAt: slot.row?.resetAt
                };
            });
            // Short window inside, long window outside.
            const renderedViews = [...views].sort((a, b) => b.depth - a.depth);
            const lines = [];
            if (views.length === 0) {
                lines.push(`${vendorName}：额度未提供`);
            }
            for (const view of views) {
                if (view.percent === undefined) {
                    lines.push(`${vendorName} ${view.label}：未提供`);
                } else {
                    lines.push(`${vendorName} ${view.label}：剩余 ${Math.round(view.percent)}%${view.resetAt ? `，重置 ${formatResetAt(view.resetAt)}` : ""}`);
                }
            }
            const month = monthQuotaInfo(kimiState?.usage);
            if (month.source === "booster" && !views.some((view) => view.id === "month")) {
                lines.push(`${vendorName} Booster 月度限额（不是订阅固定月额度）：剩余 ${Math.round(month.percent)}%`);
            }
            if (data === undefined || data === null) {
                lines.push(`DeepSeek 账户：${deepState?.error ?? "余额与今日用量不可用"}`);
            } else {
                lines.push(`DeepSeek 余额：${balanceText}${data.stale === true ? "（余额未刷新）" : ""}`);
                lines.push(`DeepSeek 今日已用：${todayText}${data.usageLabel ? `（${data.usageLabel}）` : ""}`);
                if (data.rechargeBalance !== undefined) {
                    lines.push(`DeepSeek 充值余额：${formatCurrencyAmount(data.rechargeBalance, deepCurrency) ?? "—"}`);
                }
                if (data.bonusBalance !== undefined) {
                    lines.push(`DeepSeek 赠金：${formatCurrencyAmount(data.bonusBalance, deepCurrency) ?? "—"}`);
                }
            }
            if (kimiState?.error !== undefined && kimiState?.usage !== undefined) {
                lines.push(`${vendorName} 刷新提示：${kimiState.error}`);
            }
            if (deepState?.error !== undefined && data !== undefined) {
                lines.push(`DeepSeek 刷新提示：${deepState.error}`);
            }
            return {
                vendorName,
                modelName: typeof modelLabel === "string" && modelLabel.length > 0 ? modelLabel : "当前模型",
                planName: kimiState?.usage?.plan ?? vendor?.plan ?? "订阅",
                slots: views,
                renderedSlots: renderedViews,
                balanceText,
                todayText,
                balanceTone: Number.isFinite(data?.totalBalance) && data.totalBalance <= 5 ? "low" : "default",
                planTone: kimiState?.status === "ready" || (kimiState?.status === "refreshing" && kimiState?.usage != null)
                    ? "connected"
                    : "error",
                accountState: accountOverallState(kimiState, deepState),
                title: lines.join("\n")
            };
        }

        const balanceCss = `
.dsh-uak-balanceCard {
    box-sizing: border-box;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    padding: 5px 6px;
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: var(--dsw-radius-md, 8px);
    background: var(--dsw-alias-bg-layer-1, transparent);
    color: var(--dsw-alias-label-secondary);
    font-size: 11px;
    line-height: 15px;
}
.dsh-uak-balanceContext {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 6px;
}
.dsh-uak-balanceModel {
    min-width: 0;
    overflow: hidden;
    color: var(--dsw-alias-label-primary);
    font-size: 12px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dsh-uak-balancePlan {
    flex: none;
    max-width: 50%;
    overflow: hidden;
    color: var(--dsw-alias-label-caption);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dsh-uak-balancePlan::before { content: "· "; }
.dsh-uak-balancePlan[data-tone=connected] { color: #2fa24c; }
.dsh-uak-balancePlan[data-tone=error] { color: #e0433f; }
.dsh-uak-balanceRings {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.dsh-uak-quotaRow {
    display: flex;
    min-width: 0;
    flex: 1 0 100%;
    flex-direction: column;
    gap: 3px;
}
.dsh-uak-quotaHead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
}
.dsh-uak-quotaName {
    overflow: hidden;
    color: var(--dsw-alias-label-secondary);
    font-size: 12px;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dsh-uak-quotaBar {
    display: block;
    width: 100%;
    height: 5px;
    overflow: hidden;
    border-radius: 3px;
    background: var(--dsw-alias-border-l2);
}
.dsh-uak-quotaFill {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: var(--dsw-alias-label-secondary);
    transition: width .2s ease;
}
.dsh-uak-quotaFill[data-tone=ok] { background: #2fa24c; }
.dsh-uak-quotaFill[data-tone=low] { background: #e0433f; }
.dsh-uak-ringItem {
    display: flex;
    min-width: 0;
    flex: 1 1 0;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
}
.dsh-uak-ringValue {
    color: var(--dsw-alias-label-primary);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    line-height: 16px;
    text-align: right;
}
.dsh-uak-ringLabel {
    max-width: 100%;
    overflow: hidden;
    color: var(--dsw-alias-label-caption);
    font-size: 10px;
    line-height: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dsh-uak-balanceStats {
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
}
.dsh-uak-stat {
    display: flex;
    min-width: 0;
    align-items: baseline;
    justify-content: space-between;
    gap: 4px;
}
.dsh-uak-statLabel {
    color: var(--dsw-alias-label-caption);
    font-size: 10px;
    line-height: 14px;
}
.dsh-uak-statValue {
    max-width: 100%;
    overflow: hidden;
    color: var(--dsw-alias-label-primary);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dsh-uak-statValue[data-tone=low] { color: #e0433f; }
.dsh-uak-balanceNarrow {
    width: auto;
    flex: 0 1 auto;
    align-self: center;
    padding: 3px;
    gap: 3px;
    border: 0;
    background: transparent;
    cursor: pointer;
}
.dsh-uak-balanceNarrow .dsh-uak-balanceRings {
    flex-direction: column;
    align-items: center;
    gap: 1px;
}
.dsh-uak-balanceNarrow .dsh-uak-quotaRow {
    flex: 0 0 auto;
}
.dsh-uak-balanceNarrow .dsh-uak-ringItem {
    flex-direction: row;
    gap: 3px;
}
.dsh-uak-balanceNarrow .dsh-uak-ringLabel,
.dsh-uak-balanceNarrow .dsh-uak-quotaName,
.dsh-uak-balanceNarrow .dsh-uak-quotaBar,
.dsh-uak-balanceNarrow .dsh-uak-balanceStats {
    display: none;
}
.dsh-uak-balanceNarrow:focus-visible {
    outline: 2px solid var(--dsw-alias-state-business-primary);
    outline-offset: 1px;
}
`;

        function runningSessionIds(state) {
            return Object.entries(state?.byId ?? {})
                .filter(([, session]) => session?.running === true)
                .map(([id]) => id)
                .sort()
                .join(",");
        }

        function endedRunningSessions(previousIds, currentIds) {
            const previous = new Set(previousIds === "" ? [] : String(previousIds ?? "").split(","));
            const current = new Set(currentIds === "" ? [] : String(currentIds ?? "").split(","));
            return [...previous].some((id) => !current.has(id));
        }

        function useNoSessions(selector) {
            return selector({ byId: {} });
        }

        function quotaTone(percent) {
            if (!Number.isFinite(percent)) return "unknown";
            return percent > 10 ? "ok" : "low";
        }

        function quotaSlotNode(view) {
            const tone = quotaTone(view.percent);
            const barWidth = Number.isFinite(view.percent) ? Math.max(0, Math.min(100, view.percent)) : 0;
            const percent = react.createElement("span", {
                className: "dsh-uak-ringValue",
                "data-tone": tone
            }, view.text);
            const bar = react.createElement("span", { className: "dsh-uak-quotaBar", "aria-hidden": true },
                react.createElement("span", {
                    className: "dsh-uak-quotaFill",
                    "data-tone": tone,
                    style: { width: `${barWidth}%` }
                }));
            if (view.bar) {
                return react.createElement("div", { className: "dsh-uak-quotaRow", key: view.id },
                    react.createElement("div", { className: "dsh-uak-quotaHead" },
                        react.createElement("span", { className: "dsh-uak-quotaName" }, view.label),
                        percent),
                    bar);
            }
            return react.createElement("div", { className: "dsh-uak-ringItem", key: view.id },
                react.createElement("span", { className: "dsh-uak-ringLabel" }, view.label),
                percent);
        }

        /** Current session's selected model, used to pick the vendor to show. */
        function activeModelLabel(state) {
            const sessions = state?.byId ?? {};
            const current = Object.values(sessions).find((session) => (session?.retainedBy?.mainView ?? 0) > 0)
                ?? Object.values(sessions).find((session) => session?.id !== undefined && session?.running === true);
            if (current === undefined) return undefined;
            const values = state?.projectionsBySession?.[current.id]?.values ?? {};
            const selection = values.modelSelection?.next ?? values.modelSelection;
            if (typeof selection === "string") return selection;
            const model = selection?.model ?? selection?.modelId ?? selection?.id;
            const provider = selection?.provider ?? selection?.providerId ?? selection?.directory ?? selection?.vendor;
            return [provider, model].filter((part) => typeof part === "string" && part.length > 0).join(" ") || undefined;
        }

        function BalanceCard({ rpc, wide, useSessions }) {
            const [kimiState, refreshKimi] = useQuotaController(rpc, { autoStart: false });
            const [deepState, refreshDeep] = useDeepSeekController(rpc);
            const narrow = wide === false;
            const preferredVendor = react.useRef(undefined);
            const initialRequested = react.useRef(false);
            const subscriberVendor = react.useMemo(() => readActiveVendor(), []);
            const busy = ["loading", "refreshing"].includes(kimiState.status)
                || ["loading", "refreshing"].includes(deepState.status);
            const refreshAll = react.useCallback(() => {
                refreshKimi(true, preferredVendor.current);
                refreshDeep(true);
            }, [refreshKimi, refreshDeep]);
            const sessionsHook = typeof useSessions === "function" ? useSessions : useNoSessions;
            const runningIds = sessionsHook(runningSessionIds);
            const modelLabel = sessionsHook(activeModelLabel);
            const view = balanceCardView(kimiState, deepState, modelLabel);
            const previousRunning = react.useRef(runningIds);
            react.useEffect(() => {
                const ended = endedRunningSessions(previousRunning.current, runningIds);
                previousRunning.current = runningIds;
                if (ended) refreshAll();
            }, [runningIds, refreshAll]);
            react.useEffect(() => {
                const onAuth = () => {
                    initialRequested.current = true;
                    const active = readActiveVendor();
                    if (active !== undefined) preferredVendor.current = active;
                    refreshAll();
                };
                window.addEventListener(KIMI_AUTH_EVENT, onAuth);
                return () => window.removeEventListener(KIMI_AUTH_EVENT, onAuth);
            }, [refreshAll]);
            react.useEffect(() => {
                initialRequested.current = false;
            }, [rpc]);
            // One initialization request. Unknown models keep the last vendor and
            // never trigger a refresh; a known model change switches exactly once.
            react.useEffect(() => {
                const vendor = vendorForModel(modelLabel);
                if (vendor !== undefined) {
                    initialRequested.current = true;
                    if (vendor === preferredVendor.current) return;
                    preferredVendor.current = vendor;
                    refreshKimi(true, vendor);
                    return;
                }
                if (initialRequested.current) return;
                initialRequested.current = true;
                const initial = preferredVendor.current ?? subscriberVendor;
                preferredVendor.current = initial;
                refreshKimi(false, initial);
            }, [modelLabel, subscriberVendor, refreshKimi, rpc]);

            if (narrow) {
                return react.createElement(
                    "section",
                    {
                        className: "dsh-uak-balanceCard dsh-uak-balanceNarrow",
                        role: "button",
                        tabIndex: 0,
                        "aria-label": `${view.title}。点击刷新`,
                        "aria-busy": busy,
                        "data-dsh-plugin": name,
                        onClick: refreshAll,
                        onKeyDown: (event) => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                refreshAll();
                            }
                        }
                    },
                    react.createElement("div", { className: "dsh-uak-balanceRings" },
                        view.slots.length === 0
                            ? react.createElement("span", { className: "dsh-uak-ringValue", "data-tone": "unknown" }, "—")
                            : view.renderedSlots.map(quotaSlotNode)),
                );
            }

            return react.createElement(
                "section",
                {
                    className: "dsh-uak-balanceCard",
                    role: "button",
                    tabIndex: 0,
                    "aria-label": "今日消耗与剩余余额。点击刷新",
                    "aria-busy": busy,
                    "data-dsh-plugin": name,
                    onClick: refreshAll,
                    onKeyDown: (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            refreshAll();
                        }
                    }
                },
                react.createElement("div", { className: "dsh-uak-balanceContext" },
                    react.createElement("span", { className: "dsh-uak-balanceModel" }, view.modelName),
                    react.createElement("span", { className: "dsh-uak-balancePlan", "data-tone": view.planTone }, view.planName)),
                react.createElement("div", { className: "dsh-uak-balanceRings" },
                    view.slots.length === 0
                        ? react.createElement("span", { className: "dsh-uak-ringValue", "data-tone": "unknown" }, "—")
                        : view.renderedSlots.map(quotaSlotNode)),
                react.createElement("div", { className: "dsh-uak-balanceStats" },
                    react.createElement("div", { className: "dsh-uak-stat" },
                        react.createElement("span", { className: "dsh-uak-statLabel" }, "余额"),
                        react.createElement("strong", { className: "dsh-uak-statValue", "data-tone": view.balanceTone }, view.balanceText)),
                    react.createElement("div", { className: "dsh-uak-stat" },
                        react.createElement("span", { className: "dsh-uak-statLabel" }, "今日"),
                        react.createElement("strong", { className: "dsh-uak-statValue" }, view.todayText))),
            );
        }
