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

        /**
         * The exact DSH provider routes a subscription owns.
         *
         * The catalog lists them explicitly; a vendor id is always its own
         * route. Legacy catalogs used `modelAliases` for the same purpose.
         */
        function providerRouteIds(vendor) {
            const explicit = Array.isArray(vendor?.providerIds) ? vendor.providerIds
                : Array.isArray(vendor?.modelAliases) ? vendor.modelAliases : [];
            return [vendor?.id, ...explicit]
                .filter((id) => typeof id === "string" && id.trim().length > 0)
                .map((id) => id.trim().toLowerCase());
        }

        /**
         * Which subscription vendor owns an exact provider route.
         *
         * Strict by design: only the **provider** decides, and only on an exact
         * match. A third-party relay that happens to serve `glm-4.6` is not the
         * Z.ai subscription, so model names are never evidence on their own.
         */
        function vendorForProvider(provider) {
            if (typeof provider !== "string") return undefined;
            const route = provider.trim().toLowerCase();
            if (route.length === 0) return undefined;
            return SUBSCRIPTION_VENDORS.find((vendor) => providerRouteIds(vendor).includes(route))?.id;
        }

        /** Which subscription vendor the selected model belongs to, if any. */
        function vendorForModel(model, provider) {
            if (typeof provider === "string" && provider.trim().length > 0) return vendorForProvider(provider);
            // A bare label counts only when it is exactly a known provider route.
            return vendorForProvider(model);
        }

        /**
         * Amount-valued quota ("等价额度").
         *
         * Some subscriptions (Mistral) answer with a monthly budget in money or
         * credits instead of a percentage. The row keeps `used`/`limit` in that
         * native unit and flags `unit`, so the card shows the remaining
         * equivalent amount and only then the derived percentage.
         */
        function quotaRowAmount(row) {
            if (row?.unit !== "amount" && row?.unit !== "credits" && row?.unit !== "tokens") return undefined;
            if (!Number.isFinite(row?.limit) || !Number.isFinite(row?.used)) return undefined;
            const remaining = Math.max(0, row.limit - row.used);
            return {
                unit: row.unit,
                currency: typeof row.currency === "string" && row.currency.length > 0 ? row.currency : undefined,
                remaining,
                used: row.used,
                limit: row.limit
            };
        }

        /** Card text for one quota row: an equivalent amount when the vendor quotes one. */
        function quotaRowText(row) {
            const amount = quotaRowAmount(row);
            if (amount !== undefined) {
                if (amount.currency !== undefined) {
                    const money = formatCurrencyAmount(amount.remaining, amount.currency);
                    if (money !== undefined) return money;
                }
                const suffix = amount.unit === "credits" ? " credits" : amount.unit === "tokens" ? " tokens" : "";
                return `${formatQuotaNumber(amount.remaining)}${suffix}`;
            }
            return formatQuotaPercent(remainingPercentOf(row));
        }

        /**
         * Every configured vendor the card lists, in catalog order.
         *
         * A loaded usage wins; a configured vendor without a loaded usage still
         * appears so the card never hides a subscription that is set up.
         */
        function activeVendors(kimiState, configured) {
            const cache = kimiState?.usageByVendor ?? {};
            const loaded = Object.keys(cache);
            const list = typeof configured === "object" && configured !== null
                ? SUBSCRIPTION_VENDORS.filter((vendor) => configured[vendor.id] === true)
                    .map((vendor) => vendor.id)
                : [];
            const ids = [...new Set([...loaded, ...list])];
            return ids.sort((left, right) => {
                const order = SUBSCRIPTION_VENDORS.map((vendor) => vendor.id);
                return order.indexOf(left) - order.indexOf(right);
            });
        }

        /** Vendor list + per-vendor usage rows + the vendors still without data. */
        function vendorEntries(kimiState, configured) {
            const cache = kimiState?.usageByVendor ?? {};
            const ids = activeVendors(kimiState, configured);
            const current = kimiState?.vendor;
            // The vendor being read comes first so its spinner/preview is visible.
            if (typeof current === "string" && ids.includes(current)) {
                ids.splice(ids.indexOf(current), 1);
                ids.unshift(current);
            }
            return ids.map((id) => ({
                id,
                name: subscriptionVendorName(id),
                usage: cache[id],
                pending: cache[id] === undefined
            }));
        }

        /** Pure card projection, also used by regression tests. */
        function balanceCardView(kimiState, deepState, modelLabel, configured) {
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
                const amount = quotaRowAmount(slot.row);
                return {
                    id: slot.id,
                    label: slot.label,
                    bar: slot.bar === true,
                    depth: Number.isFinite(slot.depth) ? slot.depth : 0,
                    percent,
                    amount,
                    text: quotaRowText(slot.row),
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
                const reset = view.resetAt ? `，重置 ${formatResetAt(view.resetAt)}` : "";
                if (view.amount !== undefined) {
                    const percent = view.percent === undefined ? "" : `（剩余 ${Math.round(view.percent)}%）`;
                    lines.push(`${vendorName} ${view.label}：剩余等价额度 ${view.text}${percent}${reset}`);
                } else if (view.percent === undefined) {
                    lines.push(`${vendorName} ${view.label}：未提供`);
                } else {
                    lines.push(`${vendorName} ${view.label}：剩余 ${Math.round(view.percent)}%${reset}`);
                }
            }
            const entries = vendorEntries(kimiState, configured);
            for (const entry of entries) {
                if (entry.id === kimiState?.vendor) continue;
                const rows = quotaSlots(entry.usage);
                if (rows.length === 0) {
                    lines.push(`${entry.name}：${entry.pending ? "读取中" : "额度未提供"}`);
                    continue;
                }
                // Other subscriptions keep the exact card layout untouched; they
                // are reachable through the same hover tooltip as the active one.
                lines.push(`其他订阅：`);
                lines.push(...rows.map((slot) => {
                    const percent = remainingPercentOf(slot.row);
                    const opening = `· ${entry.name} ${slot.label}`;
                    if (quotaRowAmount(slot.row) === undefined) {
                        return percent === undefined
                            ? `${opening}：未提供`
                            : `${opening}：剩余 ${Math.round(percent)}%`;
                    }
                    const detail = percent === undefined ? "" : `（剩余 ${Math.round(percent)}%）`;
                    return `${opening}：剩余等价额度 ${quotaRowText(slot.row)}${detail}`;
                }));
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
                entries,
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
    margin-left: auto;
    overflow: hidden;
    color: var(--dsw-alias-label-caption);
    font-size: 10px;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
}
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
.dsh-uak-ringValue[data-tone=ok] { color: #2fa24c; }
.dsh-uak-ringValue[data-tone=low] { color: #e0433f; }
.dsh-uak-ringLabel {
    max-width: 100%;
    overflow: hidden;
    color: var(--dsw-alias-label-primary);
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
    color: var(--dsw-alias-label-primary);
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
            if (percent < 10) return "low";
            if (percent > 10) return "ok";
            return "default";
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

        /** Current session's model selection, split into provider and model. */
        function activeModelSelection(state) {
            const sessions = state?.byId ?? {};
            const current = Object.values(sessions).find((session) => (session?.retainedBy?.mainView ?? 0) > 0)
                ?? Object.values(sessions).find((session) => session?.id !== undefined && session?.running === true);
            if (current === undefined) return undefined;
            const values = state?.projectionsBySession?.[current.id]?.values ?? {};
            const selection = values.modelSelection?.next ?? values.modelSelection;
            if (typeof selection === "string") return { model: selection };
            const model = selection?.model ?? selection?.modelId ?? selection?.id;
            const provider = selection?.provider ?? selection?.providerId ?? selection?.directory ?? selection?.vendor;
            const hasModel = typeof model === "string" && model.length > 0;
            const hasProvider = typeof provider === "string" && provider.length > 0;
            if (!hasModel && !hasProvider) return undefined;
            return {
                ...(hasProvider ? { provider } : {}),
                ...(hasModel ? { model } : {})
            };
        }

        /** Display label for the selected model. */
        function activeModelLabel(state) {
            const selection = activeModelSelection(state);
            if (selection === undefined) return undefined;
            return [selection.provider, selection.model]
                .filter((part) => typeof part === "string" && part.length > 0)
                .join(" ") || undefined;
        }

        /** Exact DSH provider route of the selected model; the only vendor signal. */
        function activeModelProvider(state) {
            return activeModelSelection(state)?.provider;
        }

        /**
         * Automatic refresh cadence for the sidebar card.
         *
         * The timer ticks once a minute and the guard decides whether the
         * five-minute window has actually elapsed, so a background tab that
         * was throttled still refreshes as soon as it becomes visible again.
         */
        const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
        const AUTO_REFRESH_TICK_MS = 60 * 1000;

        /**
         * Whether the periodic refresh should fire now.
         *
         * @param {{ now?: number, lastAt?: number, hidden?: boolean, intervalMs?: number }} input
         * @returns {boolean} `true` only when visible and the interval elapsed.
         */
        function shouldAutoRefresh({ now = Date.now(), lastAt, hidden = false, intervalMs = AUTO_REFRESH_INTERVAL_MS } = {}) {
            if (hidden) return false;
            if (!Number.isFinite(lastAt)) return false;
            if (!Number.isFinite(now)) return false;
            // A clock move backwards must not stall the timer forever.
            if (now <= lastAt) return now < lastAt;
            return now - lastAt >= intervalMs;
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
            const lastRefreshAt = react.useRef(Date.now());
            const busyRef = react.useRef(busy);
            busyRef.current = busy;
            const refreshAll = react.useCallback(() => {
                lastRefreshAt.current = Date.now();
                refreshKimi(true, preferredVendor.current);
                for (const vendor of configuredRef.current) {
                    if (vendor !== preferredVendor.current) refreshKimi(true, vendor);
                }
                refreshDeep(true);
            }, [refreshKimi, refreshDeep]);
            const sessionsHook = typeof useSessions === "function" ? useSessions : useNoSessions;
            const runningIds = sessionsHook(runningSessionIds);
            const modelLabel = sessionsHook(activeModelLabel);
            const modelProvider = sessionsHook(activeModelProvider);
            // Every configured vendor is read once, so the card can list them all.
            const configuredVendors = react.useMemo(() => vendorOrder(readStoredList(SUBSCRIPTION_HIDDEN_KEY)), []);
            const configuredRef = react.useRef(configuredVendors);
            configuredRef.current = configuredVendors;
            const requested = react.useRef(new Set());
            const readVendor = (vendor, force) => {
                if (typeof vendor !== "string" || vendor.length === 0) return;
                requested.current.add(vendor);
                refreshKimi(force, vendor);
            };
            const readConfigured = () => {
                for (const vendor of configuredRef.current) readVendor(vendor, false);
            };
            // Configured vendors plus everything already read: the active card is
            // driven by live data, not by the stored order snapshot.
            const view = balanceCardView(kimiState, deepState, modelLabel, Object.fromEntries(
                [...new Set([...configuredVendors, ...Object.keys(kimiState?.usageByVendor ?? {}), ...(kimiState?.vendor ? [kimiState.vendor] : [])])]
                    .filter((vendor) => typeof vendor === "string" && vendor.length > 0)
                    .map((vendor) => [vendor, true])
            ));
            const previousRunning = react.useRef(runningIds);
            react.useEffect(() => {
                const ended = endedRunningSessions(previousRunning.current, runningIds);
                previousRunning.current = runningIds;
                if (ended) refreshAll();
            }, [runningIds, refreshAll]);
            react.useEffect(() => {
                const onAuth = () => {
                    // The settings page announces a finished verification; the
                    // freshly verified vendor becomes the one the card shows and
                    // its usage is read immediately instead of after the next tick.
                    initialRequested.current = true;
                    const active = readActiveVendor();
                    if (active !== undefined) {
                        preferredVendor.current = active;
                        refreshKimi(true, active);
                    }
                    refreshAll();
                };
                window.addEventListener(KIMI_AUTH_EVENT, onAuth);
                return () => window.removeEventListener(KIMI_AUTH_EVENT, onAuth);
            }, [refreshAll]);
            react.useEffect(() => {
                initialRequested.current = false;
                readConfigured();
            }, [rpc]);
            // Five-minute cadence: one ticker for the card, skipped while the
            // page is hidden or a request is still in flight. A manual refresh
            // or a turn-end refresh resets the window through `refreshAll`.
            react.useEffect(() => {
                const timer = setInterval(() => {
                    const hidden = typeof document !== "undefined" && document.hidden === true;
                    if (busyRef.current) return;
                    if (!shouldAutoRefresh({ lastAt: lastRefreshAt.current, hidden })) return;
                    refreshAll();
                }, AUTO_REFRESH_TICK_MS);
                if (typeof timer?.unref === "function") timer.unref();
                return () => clearInterval(timer);
            }, [refreshAll]);
            // One initialization request. A subscription is chosen only from the
            // exact provider route: an unrecognized route keeps the last vendor and
            // never triggers a refresh, a recognized one switches exactly once.
            react.useEffect(() => {
                const vendor = vendorForModel(modelLabel, modelProvider);
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
                for (const other of configuredRef.current) {
                    if (other !== initial) refreshKimi(false, other);
                }
            }, [modelLabel, modelProvider, subscriberVendor, refreshKimi, rpc]);

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
