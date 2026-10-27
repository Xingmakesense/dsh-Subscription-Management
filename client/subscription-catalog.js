        // Generated from subscriptions.json by scripts/build-client.mjs.
        const SUBSCRIPTION_VENDORS = Object.freeze(__SUBSCRIPTION_CATALOG__);
        const VENDOR_BY_ID = new Map(SUBSCRIPTION_VENDORS.map((vendor) => [vendor.id, vendor]));

        function vendorApiManageable(vendor) {
            return vendor !== undefined && vendor !== null && vendor.api === "closed";
        }

        function vendorSupports(vendor, method) {
            return Array.isArray(vendor?.methods) && vendor.methods.includes(method);
        }
