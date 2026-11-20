import { readFileSync } from "node:fs";

const catalogUrl = new URL("../../subscriptions.json", import.meta.url);

/** Single source of truth shared with the generated Client catalog. */
export const SUBSCRIPTION_VENDORS = Object.freeze(
    JSON.parse(readFileSync(catalogUrl, "utf8")).map((vendor) => Object.freeze(vendor))
);

export const SUBSCRIPTION_VENDOR_MAP = new Map(SUBSCRIPTION_VENDORS.map((vendor) => [vendor.id, vendor]));

export function subscriptionVendor(id) {
    return SUBSCRIPTION_VENDOR_MAP.get(id);
}

export function requireSubscriptionVendor(value) {
    if (typeof value !== "string" || !SUBSCRIPTION_VENDOR_MAP.has(value)) {
        throw new Error("unknown subscription vendor");
    }
    return SUBSCRIPTION_VENDOR_MAP.get(value);
}

export function optionalSubscriptionVendor(value) {
    return typeof value === "string" ? SUBSCRIPTION_VENDOR_MAP.get(value) : undefined;
}

export function vendorSupports(vendor, method) {
    return Array.isArray(vendor?.methods) && vendor.methods.includes(method);
}

/**
 * Whether this plugin may write native model/provider settings after auth.
 *
 * Only `modelSetup: "auto"` vendors are served by the provider runtime mounted
 * by this plugin. Official subscriptions whose own console issues subscription
 * API keys ("manual") are never configured on the user's behalf: the user
 * creates the key and configures models in DSH's native model settings.
 */
export function vendorAllowsAutoModelSetup(vendor) {
    return vendor?.modelSetup === "auto";
}
