        // Subscription authentication: one compact row per vendor, inline auth
        // panels, drag ordering, and Host-owned secrets. No third-level page.
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

        const authCss = `
.dsh-uak-auth { display:flex; flex-direction:column; gap:10px; max-width:760px; color:var(--dsw-alias-label-primary); }
.dsh-uak-authHead { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.dsh-uak-auth h2,.dsh-uak-auth p { margin:0; }
.dsh-uak-auth h2 { font-size:16px; line-height:24px; font-weight:500; }
.dsh-uak-authHint { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:17px; }
.dsh-uak-authList { display:flex; flex-direction:column; overflow:hidden; border-radius:10px; background:var(--dsw-alias-bg-layer-1,transparent); }
.dsh-uak-vendorRow { display:flex; align-items:center; gap:9px; min-height:38px; padding:6px 12px; border-top:1px solid var(--dsw-alias-border-l2); }
.dsh-uak-vendorRow:first-child { border-top:0; }
.dsh-uak-vendorRow[data-managing=true] { background:var(--dsw-alias-bg-sunken,transparent); }
.dsh-uak-vendorName { display:flex; min-width:0; flex:1; align-items:center; gap:8px; font-size:13px; line-height:18px; }
.dsh-uak-vendorPlan { overflow:hidden; color:var(--dsw-alias-label-caption); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.dsh-uak-vendorHandle { flex:none; width:20px; height:24px; padding:0; border:0; background:transparent; color:var(--dsw-alias-label-caption); cursor:grab; user-select:none; }
.dsh-uak-vendorHandle:active { cursor:grabbing; }
.dsh-uak-vendorDot { width:7px; height:7px; flex:none; border-radius:50%; background:var(--dsw-alias-label-dimmed); }
.dsh-uak-vendorDot[data-state=connected] { background:#2fa24c; }
.dsh-uak-vendorDot[data-state=pending] { background:#e8a33d; }
.dsh-uak-vendorDot[data-state=error] { background:#e0433f; }
.dsh-uak-authButton { flex:none; padding:3px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:18px; cursor:pointer; white-space:nowrap; }
.dsh-uak-authButton[data-primary=true] { border-color:var(--dsw-alias-state-business-primary); background:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-on-business-primary,#fff); }
.dsh-uak-authButton[data-active=true] { border-color:var(--dsw-alias-state-business-primary); }
.dsh-uak-authButton:disabled { cursor:default; opacity:.55; }
.dsh-uak-vendorPanel { display:flex; flex-direction:column; gap:8px; padding:8px 12px 12px; border-top:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-sunken,transparent); }
.dsh-uak-authForm { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dsh-uak-authInput { box-sizing:border-box; min-width:0; flex:1; padding:5px 9px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-sunken,transparent); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; }
.dsh-uak-authArea { min-height:64px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
.dsh-uak-authCode { font:600 15px/20px ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; }
.dsh-uak-authError { color:#e0433f; font-size:12px; line-height:17px; }
.dsh-uak-authSuccess { color:#2fa24c; font-size:12px; line-height:17px; }
.dsh-uak-authEmpty { padding:12px; color:var(--dsw-alias-label-tertiary); font-size:12px; }
`;

        function VendorRow(props) {
            const { vendor, account, active, busy, error, managing, onToggle, onToggleApi, onDragStart, onDrop, onDragEnd, onDelete } = props;
            const verified = account?.verified === true;
            const configured = account?.configured === true;
            const state = account === undefined ? "loading" : account?.error ? "error" : verified ? "connected" : configured ? "pending" : "disconnected";
            return react.createElement("div", {
                className: "dsh-uak-vendorRow",
                "data-vendor": vendor.id,
                "data-managing": managing ? "true" : "false",
                onDragOver: managing ? (event) => event.preventDefault() : undefined,
                onDrop: managing ? (event) => onDrop(event, vendor.id) : undefined
            },
            managing ? react.createElement("button", {
                type: "button", className: "dsh-uak-vendorHandle", title: "拖动排序",
                "aria-label": `拖动 ${vendor.name} 排序`, draggable: true,
                onDragStart: (event) => onDragStart(event, vendor.id), onDragEnd
            }, "☰") : null,
            react.createElement("span", { className: "dsh-uak-vendorDot", "data-state": state, "aria-hidden": true }),
            react.createElement("span", { className: "dsh-uak-vendorName" },
                vendor.name,
                react.createElement("span", { className: "dsh-uak-vendorPlan" }, vendor.plan)),
            !managing && vendorApiManageable(vendor) ? react.createElement("button", {
                type: "button", className: "dsh-uak-authButton", title: "Host 保存的 API 管理",
                "data-active": account?.apiConfigured === true,
                onClick: () => onToggleApi(vendor.id)
            }, "API") : null,
            managing ? react.createElement("button", {
                type: "button", className: "dsh-uak-authButton", title: "删除",
                "aria-label": `删除 ${vendor.name}`, onClick: () => onDelete(vendor.id)
            }, "删除") : null,
            !managing ? react.createElement("button", {
                type: "button", className: "dsh-uak-authButton", "data-primary": !verified,
                "data-active": active, disabled: busy, onClick: () => onToggle(vendor.id)
            }, busy ? "处理中…" : verified ? "已验证" : configured ? "待验证" : "认证") : null,
            error === undefined ? null : react.createElement("span", { className: "dsh-uak-authError", role: "alert" }, error));
        }

        function SubscriptionAuthSettings({ rpc }) {
            const [order, setOrder] = react.useState(() => vendorOrder(readStoredList(SUBSCRIPTION_HIDDEN_KEY)));
            const [managing, setManaging] = react.useState(false);
            const [expanded, setExpanded] = react.useState(undefined);
            const [accounts, setAccounts] = react.useState({});
            const [flow, setFlow] = react.useState(undefined);
            const [secret, setSecret] = react.useState("");
            const [busyVendor, setBusyVendor] = react.useState(undefined);
            const [error, setError] = react.useState(undefined);
            const [apiForm, setApiForm] = react.useState(undefined);
            const generation = react.useRef(0);
            const dragId = react.useRef(undefined);
            const activeSignature = react.useRef("");

            const call = react.useCallback((endpoint, payload = {}) => {
                if (rpc === undefined || rpc === null || typeof rpc.call !== "function") {
                    return Promise.reject(new Error("订阅认证服务不可用"));
                }
                return rpc.call(ACCOUNT_CHANNEL, endpoint, payload).then(unwrapKimiRpc);
            }, [rpc]);

            const loadAll = react.useCallback(() => {
                const current = ++generation.current;
                call("auth/status").then((next) => {
                    if (generation.current !== current) return;
                    setAccounts(next?.vendors ?? {});
                }).catch((cause) => {
                    if (generation.current !== current) return;
                    setAccounts(Object.fromEntries(SUBSCRIPTION_VENDORS.map((vendor) => [vendor.id, { error: true }])));
                    setError(cause?.message ?? "订阅认证服务不可用");
                });
            }, [call]);

            react.useEffect(() => {
                loadAll();
                return () => { generation.current += 1; };
            }, [loadAll]);

            // Migrate the old browser-local API settings into Host credentials,
            // then remove the plaintext copy. No legacy key is returned to UI.
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

            // One-shot polling keeps the latest server interval and merges DTOs,
            // so pending never drops vendor/deviceCode and expired always stops.
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
                            setExpanded(undefined);
                            setBusyVendor(undefined);
                            loadAll();
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

            const run = async (vendor, operation) => {
                if (busyVendor !== undefined) return;
                setBusyVendor(vendor.id);
                setError(undefined);
                try {
                    await operation();
                    await loadAll();
                } catch (cause) {
                    setError(cause?.message ?? `${vendor.name} 操作失败`);
                } finally {
                    setBusyVendor(undefined);
                }
            };

            const saveSecret = (vendor, kind, event) => {
                event.preventDefault();
                const value = secret.trim();
                if (value.length === 0) return;
                return run(vendor, async () => {
                    const status = kind === "api-key"
                        ? await call("auth/api-key/set", { vendor: vendor.id, apiKey: value })
                        : await call("auth/token/set", { vendor: vendor.id, kind, token: value });
                    if (status?.verified === true) {
                        setSecret("");
                        setExpanded(undefined);
                    } else {
                        setError(status?.error ?? "凭据已保存，但上游验证未通过，请检查后重试。");
                    }
                });
            };

            const startDevice = (vendor) => run(vendor, async () => {
                const next = await call("auth/login/start", { vendor: vendor.id });
                setFlow({ ...next, vendor: vendor.id });
            });

            const cancelDevice = (vendor) => run(vendor, async () => {
                if (flow?.id !== undefined) await call("auth/login/cancel", { id: flow.id, vendor: vendor.id });
                setFlow(undefined);
                setExpanded(undefined);
            });

            const toggleApi = (id) => {
                if (expanded === `api:${id}`) {
                    setExpanded(undefined);
                    setApiForm(undefined);
                    return;
                }
                const current = accounts[id]?.apiConfig;
                setApiForm({
                    label: current?.label ?? "",
                    endpoint: current?.endpoint ?? "",
                    apiKey: ""
                });
                setExpanded(`api:${id}`);
                setError(undefined);
            };

            const persistOrder = (next) => {
                setOrder(next);
                writeStoredList(SUBSCRIPTION_ORDER_KEY, next);
            };

            const removeVendor = (id) => {
                writeStoredList(SUBSCRIPTION_HIDDEN_KEY, [...readStoredList(SUBSCRIPTION_HIDDEN_KEY), id]);
                if (readActiveVendor() === id) writeActiveVendor(undefined);
                persistOrder(order.filter((item) => item !== id));
                if (expanded === id || expanded === `api:${id}`) setExpanded(undefined);
            };

            const restoreDefaults = () => {
                writeStoredList(SUBSCRIPTION_HIDDEN_KEY, []);
                writeStoredList(SUBSCRIPTION_ORDER_KEY, []);
                writeActiveVendor(undefined);
                activeSignature.current = "";
                setOrder(SUBSCRIPTION_VENDORS.map((vendor) => vendor.id));
                setExpanded(undefined);
            };

            const statusText = (vendor) => {
                const account = accounts[vendor.id];
                if (account?.verified) return `${account.verification === "api" ? "API 已验证（订阅额度未提供）" : "已验证"}${account.plan ? ` · ${account.plan}` : ""}${account.source === "cli" ? " · 官方 CLI" : ""}`;
                if (account?.needsReconnect) return "旧版凭据需要重新认证";
                if (account?.configured) return `已配置，未验证${account.error ? ` · ${account.error}` : ""}`;
                return "未配置";
            };

            const secretPanel = (vendor, kind) => {
                const isArea = kind === "oauth" || kind === "cookie";
                const placeholder = kind === "oauth"
                    ? `粘贴 ${vendor.name} OAuth JSON 或 access token`
                    : kind === "cookie" ? "粘贴完整 Cookie" : `粘贴 ${vendor.name} ${kind === "session" ? "会话 Token" : "订阅 API Key"}`;
                return react.createElement("form", { className: "dsh-uak-authForm", onSubmit: (event) => saveSecret(vendor, kind, event) },
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

            const panel = (vendor) => {
                const account = accounts[vendor.id];
                const loginUrl = safeVendorLoginUrl(flow?.deviceCode?.verificationUri, vendor);
                const isFlow = flow?.vendor === vendor.id && !TERMINAL_AUTH_PHASES.has(flow.phase);
                return react.createElement("div", { className: "dsh-uak-vendorPanel", key: `auth:${vendor.id}` },
                    react.createElement("p", { className: account?.verified ? "dsh-uak-authSuccess" : "dsh-uak-authHint" }, statusText(vendor)),
                    react.createElement("p", { className: "dsh-uak-authHint" }, vendor.authHint),
                    account?.configured ? react.createElement("div", { className: "dsh-uak-authForm" },
                        react.createElement("button", {
                            type: "button", className: "dsh-uak-authButton", disabled: busyVendor !== undefined,
                            onClick: () => run(vendor, () => call("auth/validate", { vendor: vendor.id }))
                        }, "重新验证"),
                        react.createElement("button", {
                            type: "button", className: "dsh-uak-authButton", disabled: busyVendor !== undefined,
                            onClick: () => run(vendor, async () => {
                                await call("auth/logout", { vendor: vendor.id });
                                setExpanded(undefined);
                            })
                        }, "删除凭据")) : null,
                    vendor.cli ? react.createElement("div", { className: "dsh-uak-authForm" },
                        react.createElement("button", {
                            type: "button", className: "dsh-uak-authButton", disabled: busyVendor !== undefined,
                            onClick: () => run(vendor, () => call("auth/cli/import", { vendor: vendor.id }))
                        }, `从 ${vendor.cli.label} 导入并验证`),
                        react.createElement("span", { className: "dsh-uak-authHint" }, `先运行 ${vendor.cli.command}`)) : null,
                    vendorSupports(vendor, "device") ? react.createElement("div", { className: "dsh-uak-authForm" },
                        react.createElement("button", {
                            type: "button", className: "dsh-uak-authButton", disabled: busyVendor !== undefined || isFlow,
                            onClick: () => startDevice(vendor)
                        }, isFlow ? "等待设备授权…" : "使用账号设备登录")) : null,
                    isFlow ? react.createElement("div", { className: "dsh-uak-authForm" },
                        react.createElement("span", { className: "dsh-uak-authHint" }, "设备代码："),
                        react.createElement("span", { className: "dsh-uak-authCode" }, flow.deviceCode?.userCode ?? "—"),
                        loginUrl ? react.createElement("a", { href: loginUrl, target: "_blank", rel: "noreferrer" }, "打开登录页") : null,
                        react.createElement("button", { type: "button", className: "dsh-uak-authButton", onClick: () => cancelDevice(vendor) }, "取消")) : null,
                    vendorSupports(vendor, "oauth") ? secretPanel(vendor, "oauth") : null,
                    vendorSupports(vendor, "session") ? secretPanel(vendor, "session") : null,
                    vendorSupports(vendor, "cookie") ? secretPanel(vendor, "cookie") : null,
                    vendorSupports(vendor, "api-key") ? secretPanel(vendor, "api-key") : null,
                    safeVendorLoginUrl(vendor.consoleUrl, vendor) ? react.createElement("a", {
                        href: safeVendorLoginUrl(vendor.consoleUrl, vendor), target: "_blank", rel: "noreferrer"
                    }, "打开官方控制台") : null,
                    error === undefined ? null : react.createElement("p", { className: "dsh-uak-authError", role: "alert" }, error));
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
                            type: "button", className: "dsh-uak-authButton", "data-primary": "true",
                            disabled: busyVendor !== undefined,
                            onClick: () => run(vendor, async () => {
                                await call("auth/api-config/set", { vendor: vendor.id, ...form });
                                setApiForm(undefined);
                                setExpanded(undefined);
                            })
                        }, "保存"),
                        accounts[vendor.id]?.apiConfigured ? react.createElement("button", {
                            type: "button", className: "dsh-uak-authButton", disabled: busyVendor !== undefined,
                            onClick: () => run(vendor, async () => {
                                await call("auth/api-config/delete", { vendor: vendor.id });
                                setApiForm(undefined);
                                setExpanded(undefined);
                            })
                        }, "删除") : null,
                        react.createElement("button", { type: "button", className: "dsh-uak-authButton", onClick: () => { setApiForm(undefined); setExpanded(undefined); } }, "取消")),
                    error === undefined ? null : react.createElement("p", { className: "dsh-uak-authError", role: "alert" }, error));
            };

            const rows = [];
            for (const id of order) {
                const vendor = VENDOR_BY_ID.get(id);
                if (vendor === undefined) continue;
                rows.push(react.createElement(VendorRow, {
                    key: id, vendor, account: accounts[id], active: expanded === id,
                    busy: busyVendor === id, error: undefined, managing,
                    onToggle: (vendorId) => {
                        setSecret("");
                        setError(undefined);
                        setExpanded(expanded === vendorId ? undefined : vendorId);
                    },
                    onToggleApi: toggleApi,
                    onDragStart: (event, vendorId) => {
                        dragId.current = vendorId;
                        event.dataTransfer?.setData("text/plain", vendorId);
                        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                    },
                    onDrop: (event, vendorId) => {
                        event.preventDefault();
                        if (dragId.current !== undefined && dragId.current !== vendorId) {
                            persistOrder(reorderVendor(order, dragId.current, vendorId));
                        }
                        dragId.current = undefined;
                    },
                    onDragEnd: () => { dragId.current = undefined; },
                    onDelete: removeVendor
                }));
                if (!managing && expanded === id) rows.push(panel(vendor));
                if (!managing && expanded === `api:${id}` && apiForm !== undefined) rows.push(apiPanel(vendor));
            }

            return react.createElement("section", { className: "dsh-uak-auth", "data-dsh-plugin": name },
                react.createElement("div", { className: "dsh-uak-authHead" },
                    react.createElement("h2", null, "订阅认证"),
                    react.createElement("div", { className: "dsh-uak-authForm" },
                        managing ? react.createElement("button", { type: "button", className: "dsh-uak-authButton", onClick: restoreDefaults }, "恢复默认") : null,
                        react.createElement("button", {
                            type: "button", className: "dsh-uak-authButton", "data-active": managing,
                            onClick: () => { setManaging(!managing); setExpanded(undefined); setError(undefined); }
                        }, managing ? "完成" : "管理"))),
                react.createElement("p", { className: "dsh-uak-authHint" },
                    "一行一个厂商，认证在当前行展开。只有真实接口验证成功才显示“已验证”；密钥、Cookie 与 OAuth Token 均由 Host 保存。"),
                managing ? react.createElement("p", { className: "dsh-uak-authHint" }, "按住 ☰ 把手拖动排序，行末可删除厂商。") : null,
                rows.length > 0
                    ? react.createElement("div", { className: "dsh-uak-authList" }, rows)
                    : react.createElement("div", { className: "dsh-uak-authEmpty" }, "厂商已全部移除，点击上方“恢复默认”还原。")
            );
        }
