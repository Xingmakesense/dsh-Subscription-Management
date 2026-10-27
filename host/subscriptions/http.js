const DEFAULT_TIMEOUT_MS = 15_000;

/** A transport failure whose message never contains request headers or bodies. */
export class HttpRequestError extends Error {
    constructor(kind, message, options = {}) {
        super(message);
        this.name = "HttpRequestError";
        this.kind = kind;
        if (Number.isInteger(options.status)) this.status = options.status;
    }
}

export function formBody(values) {
    return new URLSearchParams(values).toString();
}

function safeOrigin(url) {
    try {
        return new URL(url).origin;
    } catch {
        return "request";
    }
}

/**
 * JSON request shared by subscription adapters and Kimi OAuth.
 * Non-2xx responses are returned to the caller; transport/redirect failures throw.
 */
export async function requestJson(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new HttpRequestError("network", "Invalid request URL");
    }
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
        throw new HttpRequestError("network", "Subscription requests require an HTTPS URL without userinfo");
    }

    const controller = new AbortController();
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        let response;
        try {
            response = await fetch(parsed.href, {
                ...init,
                redirect: "error",
                signal: controller.signal
            });
        } catch (error) {
            const timedOut = controller.signal.aborted;
            throw new HttpRequestError(
                timedOut ? "timeout" : "network",
                timedOut
                    ? `Request to ${safeOrigin(parsed)} timed out`
                    : `Request to ${safeOrigin(parsed)} failed`
            );
        }

        let payload;
        try {
            payload = await response.json();
        } catch {
            if (controller.signal.aborted) {
                throw new HttpRequestError("timeout", `Request to ${safeOrigin(parsed)} timed out`);
            }
            // Callers distinguish an invalid success payload from a useful HTTP error status.
            payload = undefined;
        }
        return { response, payload };
    } finally {
        clearTimeout(timer);
    }
}
