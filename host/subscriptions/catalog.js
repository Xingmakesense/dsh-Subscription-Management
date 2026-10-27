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
