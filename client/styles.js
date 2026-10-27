        const STYLE_TAG_ID = "dsh-subscription-management/inline.css";
        function installStyle() {
            if (typeof document === "undefined") return () => {};
            let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_TAG_ID) + "]");
            if (tag === null) {
                tag = document.createElement("style");
                tag.dataset.plugin = "dsh-subscription-management";
                tag.dataset.pluginCss = STYLE_TAG_ID;
                document.head.appendChild(tag);
            }
            const css = [balanceCss, authCss].join("\n");
            if (tag.textContent !== css) tag.textContent = css;
            return () => { if (tag.isConnected) tag.remove(); };
        }
