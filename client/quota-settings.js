        // Subscription authentication, account summaries, and visible/hidden vendor management.
        const TERMINAL_AUTH_PHASES = new Set(["authenticated", "failed", "cancelled", "expired"]);
        const SUBSCRIPTION_ORDER_KEY = "utility-appearance-kit:subscription-order";
        const SUBSCRIPTION_HIDDEN_KEY = "utility-appearance-kit:subscription-hidden";
        const SUBSCRIPTION_ACTIVE_KEY = "utility-appearance-kit:subscription-active";
        const LEGACY_API_KEY_PREFIX = "utility-appearance-kit:vendor-api:";

        function readStoredList(key) {
            try {
                const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
                return Array.isArray(parsed) ? [...new Set(parsed.filter((item) => typeof item === "string"))] : [];
            } catch {
                return [];
            }
        }

        function writeStoredList(key, value) {
            try { window.localStorage.setItem(key, JSON.stringify([...new Set(value)])); } catch { /* optional */ }
        }

        function readActiveVendor() {
            try {
                const raw = window.localStorage.getItem(SUBSCRIPTION_ACTIVE_KEY);
                let value = raw;
                try {
                    const parsed = JSON.parse(raw);
                    if (typeof parsed === "string") value = parsed;
                } catch {
                    // Older builds also stored a plain vendor id.
                }
                return VENDOR_BY_ID.has(value) ? value : undefined;
            } catch {
                return undefined;
            }
        }

        function writeActiveVendor(vendor) {
            try {
                if (vendor === undefined) window.localStorage.removeItem(SUBSCRIPTION_ACTIVE_KEY);
                else window.localStorage.setItem(SUBSCRIPTION_ACTIVE_KEY, vendor);
            } catch {
                // storage is optional
            }
        }

        function knownVendorIds(ids) {
            const known = new Set(SUBSCRIPTION_VENDORS.map((vendor) => vendor.id));
            return ids.filter((id) => known.has(id));
        }

        function vendorOrder(hidden) {
            const known = new Set(SUBSCRIPTION_VENDORS.map((vendor) => vendor.id));
            const stored = readStoredList(SUBSCRIPTION_ORDER_KEY).filter((id) => known.has(id));
            const rest = SUBSCRIPTION_VENDORS.map((vendor) => vendor.id).filter((id) => !stored.includes(id));
            return [...stored, ...rest].filter((id) => !hidden.includes(id));
        }

        function reorderVendor(order, from, to) {
            const source = order.indexOf(from);
            const target = order.indexOf(to);
            if (source < 0 || target < 0 || source === target) return order;
            const next = [...order];
            next.splice(target, 0, ...next.splice(source, 1));
            return next;
        }

        function safeVendorLoginUrl(value, vendor) {
            if (typeof value !== "string" || value.length === 0) return undefined;
            try {
                const url = new URL(value);
                const host = url.hostname.toLowerCase();
                if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
                if (vendor?.host !== undefined && host !== vendor.host && !host.endsWith(`.${vendor.host}`)) {
                    return undefined;
                }
                return url.href;
            } catch {
                return undefined;
            }
        }

        function quotaWindowLabel(row) {
            const seconds = quotaWindowSeconds(row);
            if (seconds === 5 * 3600) return "5小时额度窗口";
            if (seconds === 7 * 86400) return "周额度窗口";
            if (row?.window?.unit === "month" || seconds === 30 * 86400) return "月额度窗口";
            if (seconds === 86400) return "日额度窗口";
            return "额度窗口";
        }

        function nearestQuotaWindow(usage, now = Date.now()) {
            const rows = [usage?.summary, ...Array.isArray(usage?.limits) ? usage.limits : []]
                .filter((row) => row !== null && typeof row === "object" && Number.isFinite(Date.parse(row.resetAt)))
                .filter((row) => Date.parse(row.resetAt) > now)
                .sort((left, right) => Date.parse(left.resetAt) - Date.parse(right.resetAt));
            return rows[0];
        }

        function formatSummaryReset(value) {
            const time = Date.parse(value);
            if (!Number.isFinite(time)) return "—";
            const date = new Date(time);
            const pad = (part) => String(part).padStart(2, "0");
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        }

        function summaryPercent(row) {
            const percent = remainingPercentOf(row);
            return Number.isFinite(percent) ? `${Math.round(Math.max(0, Math.min(100, percent)))}%` : "—";
        }

        const authCss = `
.dsh-uak-auth { display:flex; flex-direction:column; gap:10px; max-width:760px; color:var(--dsw-alias-label-primary); }
.dsh-uak-authHead { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.dsh-uak-auth h2,.dsh-uak-auth p { margin:0; }
.dsh-uak-auth h2 { font-size:16px; line-height:24px; font-weight:500; }
.dsh-uak-authHint { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:17px; }
.dsh-uak-nativeGuide { padding:8px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1,transparent); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:17px; }
.dsh-uak-authList { display:flex; flex-direction:column; overflow:hidden; border-radius:10px; background:var(--dsw-alias-bg-layer-1,transparent); }
.dsh-uak-manageSection { display:flex; flex-direction:column; gap:5px; }
.dsh-uak-manageTitle { margin:4px 2px 0; color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:600; }
.dsh-uak-manageDrop { min-height:42px; border:1px dashed var(--dsw-alias-border-l2); border-radius:8px; }
.dsh-uak-manageDrop .dsh-uak-authList { border:0; }
.dsh-uak-vendorRow { display:flex; align-items:center; gap:9px; min-height:38px; padding:6px 12px; border-top:1px solid var(--dsw-alias-border-l2); cursor:pointer; }
.dsh-uak-vendorRow:first-child { border-top:0; }
.dsh-uak-vendorRow[data-managing=true] { background:var(--dsw-alias-bg-sunken,transparent); cursor:default; }
.dsh-uak-vendorName { min-width:0; flex:1; overflow:hidden; font-size:13px; line-height:18px; text-overflow:ellipsis; white-space:nowrap; }
.dsh-uak-vendorHandle { flex:none; width:20px; height:24px; padding:0; border:0; background:transparent; color:var(--dsw-alias-label-caption); cursor:grab; user-select:none; }
.dsh-uak-vendorHandle:active { cursor:grabbing; }
.dsh-uak-vendorDot,.dsh-uak-summaryDot { width:7px; height:7px; flex:none; border-radius:50%; background:#e0433f; }
.dsh-uak-vendorDot[data-state=connected],.dsh-uak-summaryDot[data-state=connected] { background:#2fa24c; }
.dsh-uak-vendorStatus { color:#e0433f; }
.dsh-uak-vendorStatus[data-state=connected] { color:#2fa24c; }
.dsh-uak-authButton { flex:none; padding:3px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:18px; cursor:pointer; white-space:nowrap; }
.dsh-uak-authButton[data-primary=true] { border-color:var(--dsw-alias-state-business-primary); background:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-on-business-primary,#fff); }
.dsh-uak-authButton[data-active=true] { border-color:var(--dsw-alias-state-business-primary); }
.dsh-uak-authButton:disabled { cursor:default; opacity:.55; }
.dsh-uak-vendorPanel { display:flex; flex-direction:column; gap:9px; padding:10px 12px 12px; border-top:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-sunken,transparent); }
.dsh-uak-summaryAccount { display:flex; align-items:center; justify-content:space-between; gap:12px; min-width:0; font-size:13px; font-weight:600; }
.dsh-uak-summaryAccount span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-uak-summaryPlan { color:var(--dsw-alias-label-secondary); font-size:12px; }
.dsh-uak-summaryQuota { display:grid; grid-template-columns:minmax(110px,auto) 1fr auto; align-items:center; gap:10px; font-size:12px; }
.dsh-uak-summaryQuota time { color:var(--dsw-alias-label-caption); font-variant-numeric:tabular-nums; }
.dsh-uak-summaryPercent { justify-self:end; color:var(--dsw-alias-label-primary); font-variant-numeric:tabular-nums; font-weight:600; }
.dsh-uak-keyTitle { display:flex; align-items:center; justify-content:space-between; min-height:24px; font-size:12px; font-weight:600; }
.dsh-uak-eyeButton { width:28px; height:24px; padding:0; border:0; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dsh-uak-keyLine { display:flex; align-items:center; gap:7px; }
.dsh-uak-keyLine .dsh-uak-authInput { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
.dsh-uak-groupTabs { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
.dsh-uak-authForm { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dsh-uak-authActions { flex-wrap:nowrap; overflow-x:auto; padding-top:2px; }
.dsh-uak-authActions > * { flex:none; }
.dsh-uak-authLink { display:inline-flex; align-items:center; text-decoration:none; }
.dsh-uak-authInput { box-sizing:border-box; min-width:0; flex:1; padding:5px 9px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-sunken,transparent); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; }
.dsh-uak-authArea { min-height:64px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
.dsh-uak-authCode { font:600 15px/20px ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; }
.dsh-uak-authError { color:#e0433f; font-size:12px; line-height:17px; }
.dsh-uak-authEmpty { padding:12px; color:var(--dsw-alias-label-tertiary); font-size:12px; }
`;

        function VendorRow(props) {
            const { vendor, account, active, busy, managing, onToggle, onToggleApi, onHover,
                onDragStart, onDrop, onDragEnd } = props;
            const verified = account?.verified === true;
            return react.createElement("div", {
                className: "dsh-uak-vendorRow",
                "data-vendor": vendor.id,
                "data-managing": managing ? "true" : "false",
                role: managing ? undefined : "button",
                tabIndex: managing ? undefined : 0,
                "aria-expanded": managing ? undefined : active,
                onMouseEnter: managing ? undefined : () => onHover(vendor.id),
                onClick: managing ? undefined : () => onToggle(vendor.id),
                onKeyDown: managing ? undefined : (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onToggle(vendor.id);
                    }
                },
                onDragOver: managing ? (event) => event.preventDefault() : undefined,
                onDrop: managing ? (event) => onDrop(event, vendor.id) : undefined
            },
            managing ? react.createElement("button", {
                type: "button", className: "dsh-uak-vendorHandle",
                "aria-label": `拖动 ${vendor.name}`, draggable: true,
                onDragStart: (event) => onDragStart(event, vendor.id), onDragEnd
            }, "☰") : null,
            react.createElement("span", {
                className: "dsh-uak-vendorDot",
                "data-state": verified ? "connected" : "error",
                "aria-hidden": true
            }),
            react.createElement("span", { className: "dsh-uak-vendorName" }, vendor.name),
            !managing && vendorApiManageable(vendor) ? react.createElement("button", {
                type: "button", className: "dsh-uak-authButton",
                "data-active": account?.apiConfigured === true,
                onClick: (event) => { event.stopPropagation(); onToggleApi(vendor.id); }
            }, "API") : null,
            !managing ? react.createElement("button", {
                type: "button", className: "dsh-uak-authButton dsh-uak-vendorStatus",
                "data-state": verified ? "connected" : "error",
                "data-active": active, disabled: busy,
                onClick: (event) => { event.stopPropagation(); onToggle(vendor.id); }
            }, busy ? "处理中…" : verified ? "已验证" : "未验证") : null);
        }

        function SubscriptionAuthSettings({ rpc }) {
            const [order, setOrder] = react.useState(() => vendorOrder(readStoredList(SUBSCRIPTION_HIDDEN_KEY)));
            const [hidden, setHidden] = react.useState(() => knownVendorIds(readStoredList(SUBSCRIPTION_HIDDEN_KEY)));
            const [draftOrder, setDraftOrder] = react.useState([]);
            const [draftHidden, setDraftHidden] = react.useState([]);
            const [managing, setManaging] = react.useState(false);
            const [expanded, setExpanded] = react.useState(undefined);
            const [pinned, setPinned] = react.useState(undefined);
            const [accounts, setAccounts] = react.useState({});
            const [summaries, setSummaries] = react.useState({});
            const [apiKeys, setApiKeys] = react.useState({});
            const [visibleKey, setVisibleKey] = react.useState(undefined);
            const [copiedKey, setCopiedKey] = react.useState(undefined);
            const [flow, setFlow] = react.useState(undefined);
            const [secret, setSecret] = react.useState("");
            const [busyVendor, setBusyVendor] = react.useState(undefined);
            const [error, setError] = react.useState(undefined);
            const [apiForm, setApiForm] = react.useState(undefined);
            const generation = react.useRef(0);
            const summaryGeneration = react.useRef(0);
            const dragId = react.useRef(undefined);
            const hoverTimer = react.useRef(undefined);
            const activeSignature = react.useRef("");

            const call = react.useCallback((endpoint, payload = {}) => {
                if (rpc === undefined || rpc === null || typeof rpc.call !== "function") {
                    return Promise.reject(new Error("订阅认证服务不可用"));
                }
                return rpc.call(ACCOUNT_CHANNEL, endpoint, payload).then(unwrapKimiRpc);
            }, [rpc]);

            const loadAll = react.useCallback(() => {
                const current = ++generation.current;
                return call("auth/status").then((next) => {
                    if (generation.current !== current) return;
                    setAccounts(next?.vendors ?? {});
                }).catch((cause) => {
                    if (generation.current !== current) return;
                    setAccounts(Object.fromEntries(SUBSCRIPTION_VENDORS.map((vendor) => [vendor.id, { error: true }])));
                    setError(cause?.message ?? "订阅认证服务不可用");
                });
            }, [call]);

            react.useEffect(() => {
                void loadAll();
                return () => { generation.current += 1; };
            }, [loadAll]);

            react.useEffect(() => {
                for (const vendor of SUBSCRIPTION_VENDORS) {
                    if (!vendorApiManageable(vendor)) continue;
                    try {
                        const key = LEGACY_API_KEY_PREFIX + vendor.id;
                        const raw = window.localStorage.getItem(key);
                        if (raw === null) continue;
                        const legacy = JSON.parse(raw);
                        void call("auth/api-config/set", { vendor: vendor.id, ...legacy }).then(() => {
                            window.localStorage.removeItem(key);
                        }).catch(() => {});
                    } catch {
                        // malformed legacy state is left untouched
                    }
                }
            }, [call]);

            react.useEffect(() => {
                const connected = order.filter((id) => accounts[id]?.verified === true);
                const signature = connected.join(",");
                if (signature === activeSignature.current) return;
                activeSignature.current = signature;
                writeActiveVendor(connected[0]);
                window.dispatchEvent(new Event(KIMI_AUTH_EVENT));
            }, [accounts, order]);

            react.useEffect(() => {
                if (flow === undefined || TERMINAL_AUTH_PHASES.has(flow.phase)) return undefined;
                let live = true;
                let timer;
                const poll = async () => {
                    try {
                        const next = await call("auth/login/poll", { id: flow.id, vendor: flow.vendor });
                        if (!live) return;
                        if (next?.phase === "authenticated") {
                            setFlow(undefined);
                            setBusyVendor(undefined);
                            await loadAll();
                            return;
                        }
                        if (next === undefined || TERMINAL_AUTH_PHASES.has(next.phase)) {
                            setFlow(undefined);
                            setError(next?.phase === "cancelled" ? undefined : "登录已过期或失败，请重新发起。");
                            return;
                        }
                        setFlow((previous) => ({ ...previous, ...next, vendor: flow.vendor }));
                        timer = window.setTimeout(poll, Math.max(1_500, (Number(next.intervalSeconds) || 5) * 1000));
                    } catch (cause) {
                        if (!live) return;
                        setFlow(undefined);
                        setError(cause?.message ?? "登录轮询失败，请重试。");
                    }
                };
                timer = window.setTimeout(poll, 0);
                return () => {
                    live = false;
                    window.clearTimeout(timer);
                };
            }, [flow?.id, call, loadAll]);

            // Load summary and key only for the expanded local account card. The
            // key stays in component memory and is never written to localStorage.
            react.useEffect(() => {
                const vendor = VENDOR_BY_ID.get(expanded);
                if (managing || vendor === undefined || accounts[vendor.id]?.configured !== true) return undefined;
                const current = ++summaryGeneration.current;
                let disposed = false;
                const load = async () => {
                    let usage = summaries[vendor.id];
                    if (usage === undefined) {
                        try {
                            usage = await call("usage", { vendor: vendor.id });
                            if (disposed || current !== summaryGeneration.current) return;
                            setSummaries((previous) => ({ ...previous, [vendor.id]: usage }));
                        } catch (cause) {
                            if (!disposed && current === summaryGeneration.current) {
                                setSummaries((previous) => ({
                                    ...previous,
                                    [vendor.id]: { error: cause?.message ?? "额度信息不可用" }
                                }));
                            }
                        }
                    }
                    const method = accounts[vendor.id]?.method;
                    if ((method !== "api-key" && method !== "api-key-groups") || apiKeys[vendor.id] !== undefined) return;
                    try {
                        const group = vendor.id === "protocom"
                            ? usage?.group ?? accounts[vendor.id]?.group
                            : undefined;
                        const value = await call("auth/api-key/get", { vendor: vendor.id, group });
                        if (disposed || current !== summaryGeneration.current) return;
                        setApiKeys((previous) => ({ ...previous, [vendor.id]: value?.apiKey ?? "" }));
                    } catch {
                        if (!disposed && current === summaryGeneration.current) {
                            setApiKeys((previous) => ({ ...previous, [vendor.id]: "" }));
                        }
                    }
                };
                void load();
                return () => { disposed = true; };
            }, [expanded, managing, accounts, call]);

            const run = async (vendor, operation) => {
                if (busyVendor !== undefined) return;
                setBusyVendor(vendor.id);
                setError(undefined);
                try {
                    await operation();
                    setSummaries((previous) => { const next = { ...previous }; delete next[vendor.id]; return next; });
                    setApiKeys((previous) => { const next = { ...previous }; delete next[vendor.id]; return next; });
                    await loadAll();
                } catch (cause) {
                    setError(cause?.message ?? `${vendor.name} 操作失败`);
                } finally {
                    setBusyVendor(undefined);
                }
            };

            const saveSecret = (vendor, kind, event, group) => {
                event.preventDefault();
                const value = secret.trim();
                if (value.length === 0) return;
                return run(vendor, async () => {
                    const status = kind === "api-key"
                        ? await call("auth/api-key/set", { vendor: vendor.id, apiKey: value, group })
                        : await call("auth/token/set", { vendor: vendor.id, kind, token: value });
                    if (status?.verified === true) setSecret("");
                    else setError(status?.error ?? "凭据已保存，但上游验证未通过，请检查后重试。");
                    // Saving never opens or closes the summary card by itself.
                });
            };

            const startDevice = (vendor) => run(vendor, async () => {
                const next = await call("auth/login/start", { vendor: vendor.id });
                setFlow({ ...next, vendor: vendor.id });
            });

            const cancelDevice = (vendor) => run(vendor, async () => {
                if (flow?.id !== undefined) await call("auth/login/cancel", { id: flow.id, vendor: vendor.id });
                setFlow(undefined);
            });

            const closePanel = () => {
                setExpanded(undefined);
                setPinned(undefined);
                setVisibleKey(undefined);
                setApiKeys({});
            };

            const toggleVendor = (id) => {
                setSecret("");
                setError(undefined);
                setVisibleKey(undefined);
                if (expanded === id && pinned === id) {
                    closePanel();
                    return;
                }
                setExpanded(id);
                setPinned(id);
                setApiForm(undefined);
            };

            const hoverVendor = (id) => {
                if (managing || pinned !== undefined) return;
                window.clearTimeout(hoverTimer.current);
                hoverTimer.current = window.setTimeout(() => {
                    setExpanded(id);
                    setVisibleKey(undefined);
                    setApiForm(undefined);
                }, 120);
            };

            const leaveVendor = (id) => {
                window.clearTimeout(hoverTimer.current);
                if (pinned === undefined && expanded === id) closePanel();
            };

            const toggleApi = (id) => {
                if (expanded === `api:${id}`) {
                    closePanel();
                    setApiForm(undefined);
                    return;
                }
                const current = accounts[id]?.apiConfig;
                setApiForm({ label: current?.label ?? "", endpoint: current?.endpoint ?? "", apiKey: "" });
                setExpanded(`api:${id}`);
                setPinned(id);
                setError(undefined);
            };

            const startManaging = () => {
                const visible = vendorOrder(hidden);
                const storedHidden = knownVendorIds(readStoredList(SUBSCRIPTION_HIDDEN_KEY));
                setDraftOrder(visible);
                setDraftHidden(storedHidden.filter((id) => !visible.includes(id)));
                setManaging(true);
                closePanel();
                setError(undefined);
            };

            const saveManaging = () => {
                writeStoredList(SUBSCRIPTION_ORDER_KEY, draftOrder);
                writeStoredList(SUBSCRIPTION_HIDDEN_KEY, draftHidden);
                setOrder(draftOrder);
                setHidden(draftHidden);
                setManaging(false);
                if (draftHidden.includes(readActiveVendor())) writeActiveVendor(undefined);
            };

            const restoreDefaults = () => {
                setDraftOrder(SUBSCRIPTION_VENDORS.map((vendor) => vendor.id));
                setDraftHidden([]);
            };

            const moveDraftVendor = (from, target, section) => {
                if (from === undefined || from === target) return;
                const source = draftOrder.includes(from) ? "visible" : "hidden";
                const sourceList = source === "visible" ? draftOrder : draftHidden;
                const targetList = section === "visible" ? draftOrder : draftHidden;
                const nextSource = sourceList.filter((id) => id !== from);
                const nextTarget = (source === section ? nextSource : targetList.filter((id) => id !== from));
                const index = target === undefined ? nextTarget.length : Math.max(0, nextTarget.indexOf(target));
                nextTarget.splice(index < 0 ? nextTarget.length : index, 0, from);
                if (section === "visible") setDraftOrder(nextTarget);
                else setDraftHidden(nextTarget);
                if (source !== section) {
                    if (source === "visible") setDraftOrder(nextSource);
                    else setDraftHidden(nextSource);
                }
            };

            const secretPanel = (vendor, kind, group) => {
                const isArea = kind === "oauth" || kind === "cookie";
                const placeholder = kind === "oauth"
                    ? `粘贴 ${vendor.name} OAuth JSON 或 access token`
                    : kind === "cookie" ? "粘贴完整 Cookie" : `粘贴 ${vendor.name} ${kind === "session" ? "会话 Token" : "订阅 API Key"}`;
                return react.createElement("form", {
                    className: "dsh-uak-authForm",
                    onSubmit: (event) => saveSecret(vendor, kind, event, group)
                },
                isArea ? react.createElement("textarea", {
                    className: "dsh-uak-authInput dsh-uak-authArea", value: secret,
                    placeholder, "aria-label": placeholder,
                    onChange: (event) => setSecret(event.currentTarget.value)
                }) : react.createElement("input", {
                    className: "dsh-uak-authInput", type: "password", value: secret,
                    autoComplete: "off", spellCheck: false, placeholder, "aria-label": placeholder,
                    onChange: (event) => setSecret(event.currentTarget.value)
                }),
                react.createElement("button", {
                    type: "submit", className: "dsh-uak-authButton", "data-primary": "true",
                    disabled: busyVendor !== undefined || secret.trim().length === 0
                }, busyVendor === vendor.id ? "验证中…" : "保存并验证"));
            };

            const copyApiKey = async (vendor) => {
                const key = apiKeys[vendor.id];
                if (!key) return;
                try {
                    await navigator.clipboard.writeText(key);
                    setCopiedKey(vendor.id);
                    window.setTimeout(() => setCopiedKey((current) => current === vendor.id ? undefined : current), 1200);
                } catch {
                    setError("复制失败，请检查浏览器剪贴板权限");
                }
            };

            const keySection = (vendor) => {
                const account = accounts[vendor.id];
                if (account?.configured !== true || !["api-key", "api-key-groups"].includes(account?.method)) return null;
                const key = apiKeys[vendor.id] ?? "";
                const visible = visibleKey === vendor.id;
                return react.createElement(react.Fragment, null,
                    react.createElement("div", { className: "dsh-uak-keyTitle" },
                        react.createElement("span", null, "API Key"),
                        react.createElement("button", {
                            type: "button", className: "dsh-uak-eyeButton",
                            "aria-label": visible ? "隐藏 API Key" : "显示 API Key",
                            disabled: !key,
                            onClick: () => setVisibleKey(visible ? undefined : vendor.id)
                        }, "👁")),
                    react.createElement("div", { className: "dsh-uak-keyLine" },
                        react.createElement("input", {
                            className: "dsh-uak-authInput", readOnly: true, tabIndex: 0,
                            "aria-label": `${vendor.name} API Key`,
                            value: visible ? key : "*".repeat(key.length),
                            placeholder: key ? undefined : "读取中或不可用"
                        }),
                        react.createElement("button", {
                            type: "button", className: "dsh-uak-authButton", disabled: !key,
                            onClick: () => copyApiKey(vendor)
                        }, copiedKey === vendor.id ? "已复制" : "复制")));
            };

            const panel = (vendor) => {
                const account = accounts[vendor.id];
                const summary = summaries[vendor.id];
                const usage = summary?.usage;
                const row = nearestQuotaWindow(usage);
                const group = vendor.groups?.find((entry) => entry.id === summary?.group)
                    ?? vendor.groups?.find((entry) => entry.id === account?.group);
                const plan = usage?.plan ?? account?.plan ?? group?.plan ?? vendor.plan;
                const loginUrl = safeVendorLoginUrl(flow?.deviceCode?.verificationUri, vendor);
                const isFlow = flow?.vendor === vendor.id && !TERMINAL_AUTH_PHASES.has(flow.phase);
                const actions = [];
                if (account?.configured) {
                    actions.push(react.createElement("button", {
                        key: "validate", type: "button", className: "dsh-uak-authButton", disabled: busyVendor !== undefined,
                        onClick: () => run(vendor, () => call("auth/validate", { vendor: vendor.id, group: group?.id }))
                    }, "重新验证"));
                    actions.push(react.createElement("button", {
                        key: "logout", type: "button", className: "dsh-uak-authButton", disabled: busyVendor !== undefined,
                        onClick: () => run(vendor, async () => {
                            await call("auth/logout", { vendor: vendor.id });
                            closePanel();
                        })
                    }, "删除凭据"));
                }
                if (vendor.cli) {
                    actions.push(react.createElement("button", {
                        key: "cli", type: "button", className: "dsh-uak-authButton", disabled: busyVendor !== undefined,
                        onClick: () => run(vendor, () => call("auth/cli/import", { vendor: vendor.id }))
                    }, `从 ${vendor.cli.label} 导入并验证`));
                }
                if (vendorSupports(vendor, "device")) {
                    actions.push(react.createElement("button", {
                        key: "device", type: "button", className: "dsh-uak-authButton", disabled: busyVendor !== undefined || isFlow,
                        onClick: () => startDevice(vendor)
                    }, isFlow ? "等待设备授权…" : "使用账号设备登录"));
                }
                const consoleUrl = safeVendorLoginUrl(vendor.consoleUrl, vendor);
                if (consoleUrl) {
                    actions.push(react.createElement("a", {
                        key: "console", className: "dsh-uak-authButton dsh-uak-authLink",
                        href: consoleUrl, target: "_blank", rel: "noreferrer"
                    }, "打开官方控制台"));
                }
                return react.createElement("div", { className: "dsh-uak-vendorPanel", key: `auth:${vendor.id}` },
                    react.createElement("div", { className: "dsh-uak-summaryAccount" },
                        react.createElement("span", null, usage?.accountName ?? "账户名称---"),
                        react.createElement("span", {
                            className: "dsh-uak-summaryDot",
                            "data-state": account?.verified ? "connected" : "error",
                            "aria-label": account?.verified ? "已验证" : "未验证"
                        })),
                    react.createElement("div", { className: "dsh-uak-summaryPlan" }, `套餐：${plan ?? "—"}`),
                    react.createElement("div", { className: "dsh-uak-summaryQuota" },
                        react.createElement("span", null, quotaWindowLabel(row)),
                        react.createElement("time", { dateTime: row?.resetAt }, formatSummaryReset(row?.resetAt)),
                        react.createElement("span", { className: "dsh-uak-summaryPercent" }, summaryPercent(row))),
                    keySection(vendor),
                    react.createElement("p", { className: "dsh-uak-authHint" }, vendor.authHint),
                    vendor.groups ? react.createElement("div", { className: "dsh-uak-groupTabs" },
                        vendor.groups.map((entry) => react.createElement("span", { className: "dsh-uak-authHint", key: entry.id },
                            `${entry.name}${account?.groups?.[entry.id]?.verified ? " · 已验证" : account?.groups?.[entry.id]?.configured ? " · 未验证" : " · 未配置"}`))) : null,
                    isFlow ? react.createElement("div", { className: "dsh-uak-authForm" },
                        react.createElement("span", { className: "dsh-uak-authHint" }, "设备代码："),
                        react.createElement("span", { className: "dsh-uak-authCode" }, flow.deviceCode?.userCode ?? "—"),
                        loginUrl ? react.createElement("a", { href: loginUrl, target: "_blank", rel: "noreferrer" }, "打开登录页") : null,
                        react.createElement("button", { type: "button", className: "dsh-uak-authButton", onClick: () => cancelDevice(vendor) }, "取消")) : null,
                    vendorSupports(vendor, "oauth") ? secretPanel(vendor, "oauth") : null,
                    vendorSupports(vendor, "session") ? secretPanel(vendor, "session") : null,
                    vendorSupports(vendor, "cookie") ? secretPanel(vendor, "cookie") : null,
                    vendorSupports(vendor, "api-key") && !vendor.groups ? secretPanel(vendor, "api-key") : null,
                    vendor.groups ? vendor.groups.map((entry) => react.createElement("div", { key: `save:${entry.id}` },
                        react.createElement("p", { className: "dsh-uak-authHint" }, `${entry.name} API Key`),
                        secretPanel(vendor, "api-key", entry.id))) : null,
                    summary?.error ? react.createElement("p", { className: "dsh-uak-authError" }, summary.error) : null,
                    error === undefined ? null : react.createElement("p", { className: "dsh-uak-authError", role: "alert" }, error),
                    actions.length > 0 ? react.createElement("div", { className: "dsh-uak-authForm dsh-uak-authActions" }, actions) : null);
            };

            const apiPanel = (vendor) => {
                const form = apiForm ?? { label: "", endpoint: "", apiKey: "" };
                const update = (patch) => setApiForm({ ...form, ...patch });
                return react.createElement("div", { className: "dsh-uak-vendorPanel", key: `api:${vendor.id}` },
                    react.createElement("p", { className: "dsh-uak-authHint" },
                        "API 管理只保存到 DSH Host 凭据服务。留空 API Key 可保留已有密钥；地址必须使用 HTTPS。"),
                    react.createElement("div", { className: "dsh-uak-authForm" },
                        react.createElement("input", { className: "dsh-uak-authInput", value: form.label, placeholder: "名称", "aria-label": `${vendor.name} API 名称`, onChange: (event) => update({ label: event.currentTarget.value }) }),
                        react.createElement("input", { className: "dsh-uak-authInput", value: form.endpoint, placeholder: "https://example.com/v1", "aria-label": `${vendor.name} API 地址`, onChange: (event) => update({ endpoint: event.currentTarget.value }) }),
                        react.createElement("input", { className: "dsh-uak-authInput", type: "password", value: form.apiKey, autoComplete: "off", placeholder: accounts[vendor.id]?.apiConfigured ? "留空保留已有 Key" : "API Key", "aria-label": `${vendor.name} API Key`, onChange: (event) => update({ apiKey: event.currentTarget.value }) })),
                    react.createElement("div", { className: "dsh-uak-authForm" },
                        react.createElement("button", {
                            type: "button", className: "dsh-uak-authButton", "data-primary": "true", disabled: busyVendor !== undefined,
                            onClick: () => run(vendor, async () => {
                                await call("auth/api-config/set", { vendor: vendor.id, ...form });
                                setApiForm(undefined);
                                closePanel();
                            })
                        }, "保存"),
                        accounts[vendor.id]?.apiConfigured ? react.createElement("button", {
                            type: "button", className: "dsh-uak-authButton", disabled: busyVendor !== undefined,
                            onClick: () => run(vendor, async () => {
                                await call("auth/api-config/delete", { vendor: vendor.id });
                                setApiForm(undefined);
                                closePanel();
                            })
                        }, "删除") : null,
                        react.createElement("button", { type: "button", className: "dsh-uak-authButton", onClick: () => { setApiForm(undefined); closePanel(); } }, "取消")),
                    error === undefined ? null : react.createElement("p", { className: "dsh-uak-authError" }, error));
            };

            const renderVendor = (id, isManaging, section) => {
                const vendor = VENDOR_BY_ID.get(id);
                if (vendor === undefined) return null;
                const active = expanded === id;
                return react.createElement("div", {
                    key: `${section}:${id}`,
                    onMouseLeave: isManaging ? undefined : () => leaveVendor(id)
                },
                react.createElement(VendorRow, {
                    vendor, account: accounts[id], active,
                    busy: busyVendor === id, managing: isManaging,
                    onToggle: toggleVendor,
                    onToggleApi: toggleApi,
                    onHover: hoverVendor,
                    onDragStart: (event, vendorId) => {
                        dragId.current = vendorId;
                        event.dataTransfer?.setData("text/plain", vendorId);
                        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                    },
                    onDrop: (event, vendorId) => {
                        event.preventDefault();
                        event.stopPropagation();
                        moveDraftVendor(dragId.current, vendorId, section);
                        dragId.current = undefined;
                    },
                    onDragEnd: () => { dragId.current = undefined; }
                }),
                !isManaging && active ? panel(vendor) : null,
                !isManaging && expanded === `api:${id}` && apiForm !== undefined ? apiPanel(vendor) : null);
            };

            const manageList = (ids, section) => react.createElement("div", {
                className: "dsh-uak-manageDrop",
                onDragOver: (event) => event.preventDefault(),
                onDrop: (event) => {
                    event.preventDefault();
                    moveDraftVendor(dragId.current, undefined, section);
                    dragId.current = undefined;
                }
            }, ids.length > 0
                ? react.createElement("div", { className: "dsh-uak-authList" }, ids.map((id) => renderVendor(id, true, section)))
                : react.createElement("div", { className: "dsh-uak-authEmpty" }, "拖动厂商到这里"));

            return react.createElement("section", { className: "dsh-uak-auth", "data-dsh-plugin": name },
                react.createElement("div", { className: "dsh-uak-nativeGuide" },
                    "认证完成后会自动配置文本/图片输入、模型思考档位和默认 1M 上下文。可前往 DSH 设置 → 模型，在原生模型设置中进一步个性化。"),
                react.createElement("div", { className: "dsh-uak-authHead" },
                    react.createElement("h2", null, "订阅认证"),
                    react.createElement("div", { className: "dsh-uak-authForm" },
                        managing ? react.createElement("button", { type: "button", className: "dsh-uak-authButton", onClick: restoreDefaults }, "恢复默认") : null,
                        react.createElement("button", {
                            type: "button", className: "dsh-uak-authButton", "data-active": managing,
                            onClick: managing ? saveManaging : startManaging
                        }, managing ? "保存" : "管理"))),
                react.createElement("p", { className: "dsh-uak-authHint" },
                    "模型、图片、上下文与思考强度请在 DSH 原生模型设置中管理。厂商凭据与账户摘要在此展开。"),
                managing
                    ? react.createElement(react.Fragment, null,
                        react.createElement("p", { className: "dsh-uak-authHint" }, "在显示和隐藏栏目之间拖动厂商，点击保存后应用。"),
                        react.createElement("div", { className: "dsh-uak-manageSection" },
                            react.createElement("div", { className: "dsh-uak-manageTitle" }, "显示"),
                            manageList(draftOrder, "visible")),
                        react.createElement("div", { className: "dsh-uak-manageSection" },
                            react.createElement("div", { className: "dsh-uak-manageTitle" }, "隐藏"),
                            manageList(draftHidden, "hidden")))
                    : order.length > 0
                        ? react.createElement("div", { className: "dsh-uak-authList" }, order.map((id) => renderVendor(id, false, "visible")))
                        : react.createElement("div", { className: "dsh-uak-authEmpty" }, "所有厂商均已隐藏，点击“管理”恢复显示。"));
        }
