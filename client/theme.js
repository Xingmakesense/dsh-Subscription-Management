        /**
         * Theme contract shared by every card and panel this plugin renders.
         *
         * Colours come from the harness theme tokens (light and dark), so a theme
         * switch recolours the plugin without a reload. Utility-Appearance-Kit is
         * installed in the same profile and redefines some of those tokens on the
         * document root; that only repaints, it never removes a declaration this
         * stylesheet relies on. Every rule therefore keeps a literal fallback, and
         * the state colours (red/green) are literals so they survive any palette.
         *
         * The `--dsm-*` names are private: they are remapped together with each
         * theme so one change cannot leave a half-theme behind.
         */
        const THEME_VARS = `
[data-dsh-plugin="dsh-subscription-management"] {
    --dsm-text: var(--dsw-alias-label-primary, #172033);
    --dsm-text-secondary: var(--dsw-alias-label-secondary, #4b5563);
    --dsm-text-caption: var(--dsw-alias-label-tertiary, #6b7280);
    --dsm-border: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2, #dbe3ef));
    --dsm-surface: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1, #ffffff));
    --dsm-sunken: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-sunken, #f4f7fb));
    --dsm-hover: var(--dsw-alias-interactive-bg-hover, rgb(125 160 220 / .14));
    --dsm-accent: var(--dsw-alias-state-business-primary, #2563eb);
    --dsm-on-accent: var(--dsw-alias-on-business-primary, #ffffff);
    --dsm-ok: #2fa24c;
    --dsm-bad: #e0433f;
    --dsm-warn: #e8a33d;
    color: var(--dsm-text);
}
[data-dsh-plugin="dsh-subscription-management"] .dsh-uak-authButton {
    color: var(--dsm-text);
    border-color: var(--dsm-border);
}
[data-dsh-plugin="dsh-subscription-management"] .dsh-uak-authButton[data-primary=true] {
    border-color: var(--dsm-accent);
    background: var(--dsm-accent);
    color: var(--dsm-on-accent);
}
[data-dsh-plugin="dsh-subscription-management"] .dsh-uak-authButton:not([data-primary=true]):hover {
    background: var(--dsm-hover);
}
[data-dsh-plugin="dsh-subscription-management"] :where(.dsh-uak-authButton, .dsh-uak-eyeButton, .dsh-uak-vendorHandle, .dsh-uak-authLink):focus-visible,
[data-dsh-plugin="dsh-subscription-management"] .dsh-uak-balanceCard:focus-visible {
    outline: 2px solid var(--dsm-accent);
    outline-offset: 1px;
}
@media (prefers-color-scheme: dark) {
    [data-dsh-plugin="dsh-subscription-management"] {
        --dsm-ok: #4ade80;
        --dsm-bad: #f87171;
    }
}
`;

        /**
         * Auto-continue notice repair (third-party row supplied by dsh-cockpit).
         *
         * The row paints itself with `--dsw-alias-bg-elevated` / label tokens, so a
         * theme switch (or Utility-Appearance-Kit's token overrides) can leave it
         * unreadable. This scope pins that one row to black on white regardless of
         * theme, marks the failure code red and leaves every other colour alone. It
         * is deliberately scoped by the row's own `status` role plus the
         * auto-continue prefix, so no unrelated notice is touched.
         */
        const CONTINUE_NOTICE_SELECTOR = '[role="status"][aria-live="polite"]';
        const CONTINUE_NOTICE_MARK = "dsm-continue-notice";
        const CONTINUE_NOTICE_FIX = "dsm-continue-notice-fix";
        const CONTINUE_NOTICE_PREFIX = "【自动续轮";
        const CONTINUE_NOTICE_CSS = `
[data-dsm-continue-notice="${CONTINUE_NOTICE_FIX}"],
[data-dsm-continue-notice="${CONTINUE_NOTICE_FIX}"] * {
    color: #ffffff !important;
    -webkit-text-fill-color: #ffffff !important;
}
[data-dsm-continue-notice="${CONTINUE_NOTICE_FIX}"] {
    background: #000000 !important;
    border-color: #3a3a3a !important;
    border-left-color: #ffffff !important;
}
[data-dsm-continue-notice="${CONTINUE_NOTICE_FIX}"] [data-dsm-failure-code="true"] {
    color: #ff4d4f !important;
    -webkit-text-fill-color: #ff4d4f !important;
    font-weight: 600;
}
`;

        const FAILURE_CODE_PATTERN = /(故障码\s*)\b([A-Z][A-Z0-9_]{1,})\b/;

        /**
         * Split one notice row's text so the failure code can be highlighted.
         * @param {string} value - the row's whole text content.
         * @returns {{ code: string | undefined, parts: Array<{ value: string, code: boolean }> }}
         */
        function splitContinueNoticeText(value) {
            const text = typeof value === "string" ? value : "";
            const match = FAILURE_CODE_PATTERN.exec(text);
            if (match === null) return { code: undefined, parts: [{ value: text, code: false }] };
            const start = match.index;
            const end = start + match[0].length;
            return {
                code: match[2],
                parts: [
                    { value: text.slice(0, start + match[1].length), code: false },
                    { value: match[2], code: true },
                    { value: text.slice(end), code: false }
                ].filter((part) => part.value.length > 0)
            };
        }

        function isContinueNotice(node) {
            if (typeof Element === "undefined" || !(node instanceof Element)) return false;
            if (!node.matches(CONTINUE_NOTICE_SELECTOR)) return false;
            return String(node.textContent ?? "").startsWith(CONTINUE_NOTICE_PREFIX);
        }

        function markContinueNotice(node) {
            if (node.getAttribute("data-dsm-continue-notice") === CONTINUE_NOTICE_FIX) return;
            const { parts } = splitContinueNoticeText(node.textContent ?? "");
            if (parts.length > 1) {
                // The row is a third-party React subtree. Repaint it once by
                // replacing only the text nodes whose value is the failure code;
                // attribution goes on an inline span so no foreign markup is kept.
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                let current = walker.nextNode();
                while (current !== null) {
                    const text = current.nodeValue ?? "";
                    const match = FAILURE_CODE_PATTERN.exec(text);
                    if (match !== null) {
                        const codeStart = match.index + match[1].length;
                        const code = match[2];
                        const after = current.splitText(codeStart);
                        const highlighted = after.splitText(code.length);
                        const span = document.createElement("span");
                        span.setAttribute("data-dsm-failure-code", "true");
                        span.textContent = code;
                        after.parentNode?.replaceChild(span, after);
                        if (highlighted.nodeValue === "") highlighted.remove();
                        break;
                    }
                    current = walker.nextNode();
                }
            }
            node.setAttribute("data-dsm-continue-notice", CONTINUE_NOTICE_FIX);
        }

        function mountContinueNoticeFix() {
            if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
            const scan = (root) => {
                if (isContinueNotice(root)) markContinueNotice(root);
                if (typeof root.querySelectorAll !== "function") return;
                for (const node of root.querySelectorAll(CONTINUE_NOTICE_SELECTOR)) {
                    if (isContinueNotice(node)) markContinueNotice(node);
                }
            };
            scan(document);
            const observer = new MutationObserver((records) => {
                for (const record of records) {
                    for (const node of record.addedNodes) {
                        if (node.nodeType === 1) scan(node);
                    }
                }
            });
            observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
            return () => observer.disconnect();
        }
