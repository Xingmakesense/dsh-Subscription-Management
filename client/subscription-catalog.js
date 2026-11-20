        // Generated from subscriptions.json by scripts/build-client.mjs.
        const SUBSCRIPTION_VENDORS = Object.freeze(__SUBSCRIPTION_CATALOG__);
        const VENDOR_BY_ID = new Map(SUBSCRIPTION_VENDORS.map((vendor) => [vendor.id, vendor]));

        /** Closed vendors default to manual API storage; `apiConfig: false` opts out. */
        function vendorApiManageable(vendor) {
            return vendor !== undefined && vendor !== null && vendor.api === "closed" && vendor.apiConfig !== false;
        }

        /**
         * Whether the vendor's own console issues subscription-scoped API keys.
         *
         * Those subscriptions are authenticated with a key the user creates
         * themselves, so the plugin must not write model/provider settings on
         * their behalf.
         */
        function vendorUsesConsoleApiKey(vendor) {
            return Array.isArray(vendor?.methods) && vendor.methods.includes("api-key");
        }

        /**
         * Whether the user configures models themselves after authenticating.
         *
         * `modelSetup: "manual"` is the default for official subscriptions that
         * own their API-key console; only the provider runtime mounted by this
         * plugin ("auto") writes native provider groups after authentication.
         */
        function providerNeedsManualModelSetup(vendor) {
            return vendor?.modelSetup !== "auto";
        }

        function vendorSupports(vendor, method) {
            return Array.isArray(vendor?.methods) && vendor.methods.includes(method);
        }
