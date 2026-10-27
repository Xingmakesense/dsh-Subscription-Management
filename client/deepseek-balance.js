        // DeepSeek account balance and today's observed usage. The Host route
        // queries the account directly and keeps its own daily balance ledger;
        // no sibling plugin route or credential value is used by the browser.
        function finiteNonNegative(value) {
            if (typeof value !== "number" && typeof value !== "string") return undefined;
            if (typeof value === "string" && value.trim().length === 0) return undefined;
            const number = Number(value);
            return Number.isFinite(number) && number >= 0 ? number : undefined;
        }

        function normalizeDeepSeekBalance(payload) {
            if (payload === null || typeof payload !== "object" || payload.ok !== true) {
                const error = new Error(
                    typeof payload?.error === "string" && payload.error.length > 0
                        ? payload.error
                        : "DeepSeek account balance is unavailable"
                );
                error.code = typeof payload?.code === "string" ? payload.code : undefined;
                throw error;
            }
            const currency = typeof payload.currency === "string" && payload.currency.length > 0
                ? payload.currency
                : "CNY";
            return {
                totalBalance: finiteNonNegative(payload.totalBalance),
                todayUsage: finiteNonNegative(payload.todayUsage),
                todayUsageCurrency: typeof payload.todayUsageCurrency === "string" && payload.todayUsageCurrency.length > 0
                    ? payload.todayUsageCurrency
                    : currency,
                currency,
                bonusBalance: finiteNonNegative(payload.bonusBalance),
                rechargeBalance: finiteNonNegative(payload.rechargeBalance),
                usageLabel: typeof payload.usageLabel === "string" ? payload.usageLabel : undefined,
                stale: payload.stale === true
            };
        }

        function classifyDeepSeekError(error) {
            const message = String(error?.message ?? error ?? "");
            return /not connected|sign[- ]in|log ?in|unauthenticated|missing|unavailable|未配置|未连接/iu.test(message)
                ? "unavailable"
                : "error";
        }

        async function readDeepSeekBalance({ rpc, force = false } = {}) {
            if (rpc === undefined || rpc === null || typeof rpc.call !== "function") {
                throw new Error("DeepSeek account service is unavailable");
            }
            return normalizeDeepSeekBalance(
                unwrapKimiRpc(await rpc.call(ACCOUNT_CHANNEL, "deepseek", { force: force === true }))
            );
        }

        function createDeepSeekController(options) {
            const rpc = options?.rpc;
            const onChange = typeof options?.onChange === "function" ? options.onChange : () => {};
            let disposed = false;
            let generation = 0;
            let state = { status: "loading", data: undefined, error: undefined };
            const publish = (next) => {
                if (disposed) return;
                state = next;
                onChange(state);
            };
            const refresh = async (force = false) => {
                if (disposed) return;
                const current = ++generation;
                if (rpc === undefined || rpc === null || typeof rpc.call !== "function") {
                    publish({ status: "unavailable", data: undefined, error: undefined });
                    return;
                }
                publish({
                    status: state.data === undefined ? "loading" : "refreshing",
                    data: state.data,
                    error: undefined
                });
                try {
                    const data = await readDeepSeekBalance({ rpc, force: force === true });
                    if (disposed || current !== generation) return;
                    publish({ status: "ready", data, error: undefined });
                } catch (error) {
                    if (disposed || current !== generation) return;
                    publish({
                        status: classifyDeepSeekError(error),
                        data: state.data,
                        error: String(error?.message ?? error ?? "DeepSeek balance request failed")
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

        function useDeepSeekController(rpc) {
            const [state, setState] = react.useState({ status: "loading", data: undefined, error: undefined });
            const controllerRef = react.useRef(null);
            react.useEffect(() => {
                const controller = createDeepSeekController({
                    rpc,
                    onChange: setState
                });
                controllerRef.current = controller;
                controller.start();
                return () => {
                    controllerRef.current = null;
                    controller.dispose();
                };
            }, [rpc]);
            const refresh = react.useCallback((force = false) => {
                void controllerRef.current?.refresh(force);
            }, []);
            return [state, refresh];
        }
