        // Kimi subscription quota. Data comes directly from this plugin's Host
        // route, which owns the Kimi usage request. No sibling plugin RPC is used.
        const ACCOUNT_CHANNEL = "/utility-appearance-kit";
        const KIMI_AUTH_EVENT = "utility-appearance-kit:kimi-auth";
        const QUOTA_WINDOW_SECONDS = Object.freeze({ minute: 60, hour: 3600, day: 86400, week: 604800, month: 2678400 });
        const QUOTA_UNKNOWN = "未提供";

        function unwrapKimiRpc(response) {
            if (response?.ok === false) throw new Error(response?.error?.message ?? "Kimi RPC failed");
            if (response?.ok === true) return response.value;
            // Some Remote adapters already unwrap the value for their callers.
            return response;
        }

        function quotaWindowSeconds(row) {
            const factor = QUOTA_WINDOW_SECONDS[row?.window?.unit];
            const duration = row?.window?.duration;
            return Number.isFinite(factor) && Number.isFinite(duration) && duration > 0
                ? factor * duration
                : undefined;
        }

        function findQuotaWindow(rows, seconds) {
            return rows.find((row) => quotaWindowSeconds(row) === seconds);
        }

        /** Select real windows only. */
        function selectQuotaWindows(usage) {
            const rows = [usage?.summary, ...Array.isArray(usage?.limits) ? usage.limits : []]
                .filter((row) => row !== null && typeof row === "object");
            return {
                today: findQuotaWindow(rows, 86400),
                fiveHour: findQuotaWindow(rows, 5 * 3600),
                sevenDay: findQuotaWindow(rows, 7 * 86400),
                thirtyDay: findQuotaWindow(rows, 30 * 86400),
                month: rows.find((row) => row?.window?.unit === "month" && row.window.duration === 1)
            };
        }

        /**
         * Rule: the shorter window sits inside, the longer one outside.
         * `depth` 0 is the innermost (shortest) limit, higher numbers are
         * progressively longer and render further out.
         */
        function quotaDepth(slots) {
            return slots.map((slot) => {
                const seconds = quotaWindowSeconds(slot.row);
                return {
                    ...slot,
                    seconds: seconds === undefined ? 0 : seconds
                };
            }).sort((a, b) => a.seconds - b.seconds)
                .map((slot, index) => ({ ...slot, depth: index }));
        }

        /**
         * Vendor quota layout. Two chained limits keep the original two-number
         * layout; three or more gain a full-width monthly bar on top; a single
         * limit becomes a named bar.
         */
        function quotaSlots(usage) {
            const windows = selectQuotaWindows(usage);
            const month = windows.month ?? windows.thirtyDay;
            const week = windows.sevenDay;
            const five = windows.fiveHour;
            const extra = (Array.isArray(usage?.limits) ? usage.limits : []).filter((row) =>
                row !== month && row !== week && row !== five && row !== windows.today);
            if (five !== undefined && week !== undefined && month !== undefined) {
                return quotaDepth([
                    { id: "month", label: "月额度", row: month },
                    { id: "week", label: "周额度", row: week },
                    { id: "five", label: "5小时", row: five }
                ]).map((slot) => ({ ...slot, bar: slot.depth === 2 }));
            }
            if (five !== undefined && week !== undefined) {
                return quotaDepth([
                    { id: "week", label: "周额度", row: week },
                    { id: "five", label: "5小时", row: five }
                ]);
            }
            if (five !== undefined && month !== undefined && week === undefined) {
                return quotaDepth([
                    { id: "five", label: "5小时", row: five },
                    { id: "month", label: "月额度", row: month }
                ]);
            }
            const named = [...(month !== undefined ? [{ id: "month", label: "月额度", row: month }] : []),
                ...(week !== undefined ? [{ id: "week", label: "周额度", row: week }] : []),
                ...(five !== undefined ? [{ id: "five", label: "5小时", row: five }] : []),
                ...extra.map((row, index) => ({
                    id: `extra-${index}`,
                    label: typeof row?.name === "string" && row.name.length > 0 ? row.name : "额度",
                    row
                }))];
            if (named.length === 0) {
                const fallback = windows.today;
                return fallback === undefined ? [] : [{ id: "day", label: "日额度", row: fallback, bar: true, depth: 0 }];
            }
            if (named.length === 1) return [{ ...quotaDepth(named)[0], bar: true }];
            if (named.length === 2) return quotaDepth(named);
            const ordered = quotaDepth(named);
            const outer = ordered.reduce((longest, slot) => slot.depth > longest.depth ? slot : longest, ordered[0]);
            return ordered.map((slot) => ({ ...slot, bar: slot.id === outer.id }));
        }

        function formatQuotaNumber(value) {
            return new Intl.NumberFormat().format(value);
        }

        function validQuotaNumber(value) {
            return Number.isFinite(value) && value >= 0;
        }

        function remainingPercentOf(row) {
            if (Number.isFinite(row?.remainingPercent)
                && row.remainingPercent >= 0 && row.remainingPercent <= 100) {
                return Math.max(0, Math.min(100, row.remainingPercent));
            }
            // Derive only from two known numbers; a zero limit remains unknown.
            if (validQuotaNumber(row?.used) && validQuotaNumber(row?.limit) && row.limit > 0) {
                return Math.max(0, Math.min(100, (row.limit - row.used) / row.limit * 100));
            }
            return undefined;
        }

        function formatResetAt(value) {
            if (typeof value !== "string" || value.length === 0) return QUOTA_UNKNOWN;
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return QUOTA_UNKNOWN;
            try {
                return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
            } catch {
                return value;
            }
        }

        /**
         * Monthly value. Prefer a real 30d/month quota window; otherwise use
         * the enabled booster monthly limit and report that source explicitly.
         */
        function monthQuotaInfo(usage) {
            const windows = selectQuotaWindows(usage);
            const row = windows.month ?? windows.thirtyDay;
            const percent = remainingPercentOf(row);
            if (percent !== undefined) {
                return { percent, source: "window", label: "月度窗口", row };
            }
            const wallet = usage?.extraUsage;
            if (wallet?.monthlyChargeLimitEnabled === true
                && Number.isFinite(wallet.monthlyUsedCents)
                && Number.isFinite(wallet.monthlyChargeLimitCents)
                && wallet.monthlyChargeLimitCents > 0) {
                const remaining = Math.max(0, wallet.monthlyChargeLimitCents - wallet.monthlyUsedCents);
                return {
                    percent: Math.max(0, Math.min(100, remaining / wallet.monthlyChargeLimitCents * 100)),
                    source: "booster",
                    label: "Booster 月度限额",
                    usedCents: wallet.monthlyUsedCents,
                    limitCents: wallet.monthlyChargeLimitCents,
                    currency: wallet.currency
                };
            }
            return { percent: undefined, source: "none", label: "月额度" };
        }

        function classifyQuotaError(error) {
            const message = String(error?.message ?? error ?? "");
            if (/not connected|sign[- ]in|log ?in|unauthenticated|unauthorized|已过期|重新认证|重新运行|401|403/iu.test(message)) return "unauthenticated";
            if (/unavailable|connection|channel|unknown Kimi|RPC/iu.test(message)) return "unavailable";
            return "error";
        }

        /**
         * Framework-independent polling state machine. The newest request wins,
         * stale promises cannot publish, and disposal cancels both timer and state.
         */
        function createQuotaController(options) {
            const rpc = options?.rpc;
            const onChange = typeof options?.onChange === "function" ? options.onChange : () => {};
            let disposed = false;
            let generation = 0;
            let state = { status: "loading", vendor: undefined, usage: undefined, error: undefined };
            const publish = (next) => {
                if (disposed) return;
                state = next;
                onChange(state);
            };
            const refresh = async (force = false, vendor) => {
                if (disposed) return;
                const current = ++generation;
                const requestedVendor = typeof vendor === "string" && vendor.length > 0 ? vendor : state.vendor;
                const vendorChanged = requestedVendor !== undefined && requestedVendor !== state.vendor;
                const retainedUsage = vendorChanged ? undefined : state.usage;
                if (rpc === undefined || rpc === null || typeof rpc.call !== "function") {
                    publish({ status: "unavailable", vendor: requestedVendor, usage: undefined, error: undefined });
                    return;
                }
                publish({
                    status: retainedUsage === undefined ? "loading" : "refreshing",
                    vendor: requestedVendor,
                    usage: retainedUsage,
                    error: undefined
                });
                try {
                    const result = unwrapKimiRpc(await rpc.call(ACCOUNT_CHANNEL, "usage", {
                        force: force === true,
                        ...(requestedVendor === undefined ? {} : { vendor: requestedVendor })
                    }));
                    if (disposed || current !== generation) return;
                    if (result?.configured === false || result?.authenticated !== true) {
                        publish({
                            status: "unauthenticated",
                            vendor: result?.vendor ?? requestedVendor,
                            usage: undefined,
                            error: undefined
                        });
                        return;
                    }
                    const usage = result.usage;
                    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
                        throw new Error("subscription usage returned malformed data");
                    }
                    publish({
                        status: "ready",
                        vendor: result.vendor ?? requestedVendor,
                        usage,
                        verified: result.verified === true,
                        error: undefined
                    });
                } catch (error) {
                    if (disposed || current !== generation) return;
                    publish({
                        status: classifyQuotaError(error),
                        vendor: requestedVendor,
                        usage: retainedUsage,
                        error: String(error?.message ?? error ?? "subscription RPC failed")
                    });
                }
            };
            return Object.freeze({
                start() {
                    if (disposed) return;
                    void refresh(false);
                },
                refresh,
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    generation += 1;
                },
                getState: () => state
            });
        }

        function useQuotaController(rpc, { autoStart = true } = {}) {
            const [state, setState] = react.useState({ status: "loading", vendor: undefined, usage: undefined, error: undefined });
            const controllerRef = react.useRef(null);
            react.useEffect(() => {
                const controller = createQuotaController({
                    rpc,
                    onChange: setState
                });
                controllerRef.current = controller;
                if (autoStart) controller.start();
                return () => {
                    controllerRef.current = null;
                    controller.dispose();
                };
            }, [rpc]);
            const refresh = react.useCallback((force = false, vendor) => {
                void controllerRef.current?.refresh(force, vendor);
            }, []);
            return [state, refresh];
        }
