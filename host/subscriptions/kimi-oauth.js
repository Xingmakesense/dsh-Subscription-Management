import { randomUUID } from "node:crypto";
import { requestJson, formBody } from "./http.js";
import { writeVendorCredential } from "./credentials.js";
import { subscriptionVendor } from "./catalog.js";

const KIMI_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const flows = new Map();

function nonEmpty(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

function publicFlow(flow) {
    return {
        id: flow.id,
        vendor: "kimi",
        phase: flow.phase,
        deviceCode: {
            userCode: flow.userCode,
            verificationUri: flow.verificationUri
        },
        intervalSeconds: Math.max(1, Math.round(flow.intervalMs / 1000)),
        expiresAt: flow.expiresAt,
        ...(flow.error ? { error: flow.error } : {})
    };
}

function terminalFlow(id, phase) {
    return { id, vendor: "kimi", phase };
}

function pruneFlows(now = Date.now()) {
    for (const [id, flow] of flows) {
        if (flow.expiresAt <= now || flow.cancelled === true) flows.delete(id);
    }
}

export async function startKimiLogin() {
    pruneFlows();
    const { response, payload } = await requestJson(`${KIMI_OAUTH_HOST}/api/oauth/device_authorization`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({ client_id: KIMI_OAUTH_CLIENT_ID })
    });
    if (!response.ok || payload === null || typeof payload !== "object") {
        throw new Error("Kimi Code device authorization is unavailable");
    }
    const deviceCode = nonEmpty(payload.device_code);
    const userCode = nonEmpty(payload.user_code);
    const verificationUri = nonEmpty(payload.verification_uri_complete) ?? nonEmpty(payload.verification_uri);
    const expiresIn = integer(payload.expires_in);
    const interval = integer(payload.interval);
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined
        || expiresIn === undefined || expiresIn <= 0) {
        throw new Error("Kimi Code device authorization response is incomplete");
    }
    const flow = {
        id: randomUUID(),
        deviceCode,
        userCode,
        verificationUri,
        intervalMs: Math.max(1, interval ?? 5) * 1000,
        expiresAt: Date.now() + expiresIn * 1000,
        phase: "waiting_device",
        failures: 0,
        cancelled: false,
        inFlight: undefined
    };
    flows.set(flow.id, flow);
    return publicFlow(flow);
}

async function pollKimiFlow(scope, flow) {
    if (flow.cancelled || flows.get(flow.id) !== flow) return terminalFlow(flow.id, "cancelled");
    if (Date.now() >= flow.expiresAt) {
        flows.delete(flow.id);
        return terminalFlow(flow.id, "expired");
    }
    try {
        const { response, payload } = await requestJson(`${KIMI_OAUTH_HOST}/api/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: formBody({
                client_id: KIMI_OAUTH_CLIENT_ID,
                device_code: flow.deviceCode,
                grant_type: DEVICE_GRANT
            })
        });
        if (flow.cancelled || flows.get(flow.id) !== flow) return terminalFlow(flow.id, "cancelled");
        const error = nonEmpty(payload?.error);
        if (response.ok && nonEmpty(payload?.access_token) !== undefined) {
            const expiresIn = integer(payload.expires_in);
            const refresh = nonEmpty(payload.refresh_token);
            if (expiresIn === undefined || expiresIn <= 0 || refresh === undefined) {
                throw new Error("Kimi Code device token response is incomplete");
            }
            // A cancel may have happened while the token request was in flight.
            if (flow.cancelled || flows.get(flow.id) !== flow) return terminalFlow(flow.id, "cancelled");
            await writeVendorCredential(scope, subscriptionVendor("kimi"), {
                kind: "oauth",
                source: "manual",
                secret: {
                    access: payload.access_token,
                    refresh,
                    expires: Date.now() + expiresIn * 1000
                }
            });
            if (flow.cancelled || flows.get(flow.id) !== flow) {
                // Do not resurrect a flow cancelled during the write.
                return terminalFlow(flow.id, "cancelled");
            }
            flows.delete(flow.id);
            return { ...publicFlow(flow), phase: "authenticated" };
        }
        if (error === "authorization_pending") {
            flow.failures = 0;
            flow.error = undefined;
            return publicFlow(flow);
        }
        if (error === "slow_down") {
            flow.intervalMs = Math.min(30_000, flow.intervalMs + 5000);
            return publicFlow(flow);
        }
        flows.delete(flow.id);
        return terminalFlow(flow.id, error === "access_denied" ? "failed" : "expired");
    } catch (error) {
        if (flow.cancelled || flows.get(flow.id) !== flow) return terminalFlow(flow.id, "cancelled");
        flow.failures += 1;
        if (flow.failures <= 3) {
            flow.error = "网络暂时不可用，正在重试";
            flow.intervalMs = Math.min(30_000, flow.intervalMs * 2);
            return publicFlow(flow);
        }
        flows.delete(flow.id);
        return terminalFlow(flow.id, "failed");
    }
}

export function pollKimiLogin(scope, id) {
    const flow = typeof id === "string" ? flows.get(id) : undefined;
    if (flow === undefined) return Promise.resolve(terminalFlow(id, "expired"));
    if (flow.inFlight !== undefined) return flow.inFlight;
    const pending = pollKimiFlow(scope, flow).finally(() => {
        if (flow.inFlight === pending) flow.inFlight = undefined;
    });
    flow.inFlight = pending;
    return pending;
}

export function cancelKimiLogin(id) {
    const flow = typeof id === "string" ? flows.get(id) : undefined;
    if (flow !== undefined) {
        flow.cancelled = true;
        flows.delete(id);
    }
    return terminalFlow(id, "cancelled");
}

export const kimiOAuthTest = Object.freeze({ publicFlow });
