// Regression checks for the Host RPC channel: the plugin must own its prefix on
// the Host webServer instead of borrowing Connection internals (the removed
// `fiber.store` rewrite broke against cordis 4.1.0 and answered HTTP 405).
import assert from "node:assert/strict";
import { createAccountRoute, endpointOf, installAccountData, accountTest } from "./host/accounts.js";

const CHANNEL = "/dsh-subscription-management";
const tick = () => new Promise((resolve) => setImmediate(resolve));

function jsonResponse(status, payload) {
    return { status, payload };
}

/** Minimal node:http request double: headers, method, url and an async body. */
function makeRequest({ method = "POST", url = `${CHANNEL}/auth/status`, headers = {}, body = "" } = {}) {
    const request = {
        method,
        url,
        headers: { "content-type": "application/json", ...headers },
        async *[Symbol.asyncIterator]() {
            if (body.length > 0) yield Buffer.from(body);
        }
    };
    return request;
}

function makeResponse() {
    const response = {
        status: undefined,
        headers: undefined,
        body: "",
        writeHead(status, headers) {
            response.status = status;
            response.headers = headers;
        },
        end(text) {
            response.body = text ?? "";
        }
    };
    return response;
}

function envelope(method, payload = {}) {
    return JSON.stringify({ type: "client-request", rpcId: "rpc-test-1", method, payload });
}

async function drive(route, request) {
    const response = makeResponse();
    await route(request, response);
    return {
        status: response.status,
        headers: response.headers,
        body: response.body.length > 0 ? JSON.parse(response.body) : undefined
    };
}

// A. Endpoint parsing: only this channel's own path segments are accepted.
{
    assert.equal(endpointOf(CHANNEL, `${CHANNEL}/auth/status`), "auth/status");
    assert.equal(endpointOf(CHANNEL, `${CHANNEL}/auth/login/start`), "auth/login/start");
    assert.equal(endpointOf(CHANNEL, `${CHANNEL}/deepseek`), "deepseek");
    assert.equal(endpointOf(CHANNEL, CHANNEL), undefined, "the bare channel is not an endpoint");
    assert.equal(endpointOf(CHANNEL, `${CHANNEL}/`), undefined, "an empty endpoint is refused");
    assert.equal(endpointOf(CHANNEL, `${CHANNEL}/../escape`), undefined, "path traversal is refused");
    assert.equal(endpointOf(CHANNEL, `${CHANNEL}/auth//status`), undefined, "empty segments are refused");
    assert.equal(endpointOf(CHANNEL, "/other/auth/status"), undefined, "a foreign channel is refused");
}

// B. Route contract: method, content type, endpoint, envelope, and the handler result.
{
    const calls = [];
    const route = createAccountRoute({
        handler: async (endpoint, payload) => {
            calls.push([endpoint, payload]);
            return { ok: true, value: { endpoint, payload } };
        },
        reject: () => undefined
    });

    const notPost = await drive(route, makeRequest({ method: "GET", body: "" }));
    assert.equal(notPost.status, 405, "a non-POST method must answer 405");
    assert.equal(notPost.headers.allow, "POST", "405 must advertise the allowed method");

    const wrongType = await drive(route, makeRequest({ headers: { "content-type": "text/plain" }, body: "{}" }));
    assert.equal(wrongType.status, 415, "a non-JSON content type must answer 415");

    const foreign = await drive(route, makeRequest({ url: "/another-plugin/x" }));
    assert.equal(foreign.status, 404, "a path outside the channel must answer 404");

    const badJson = await drive(route, makeRequest({ body: "not-json" }));
    assert.equal(badJson.status, 400, "an unparsable body must answer 400");

    const noRpcId = await drive(route, makeRequest({ body: JSON.stringify({ method: "auth/status" }) }));
    assert.equal(noRpcId.status, 400, "a body without rpcId must answer 400");

    const mismatched = await drive(route, makeRequest({ body: envelope("auth/logout") }));
    assert.equal(mismatched.status, 200);
    assert.equal(mismatched.body.rpcId, "rpc-test-1", "the response must echo the request rpcId");
    assert.equal(mismatched.body.result.ok, false);
    assert.equal(mismatched.body.result.error.code, "gateway/bad-request");

    const ok = await drive(route, makeRequest({ url: `${CHANNEL}/auth/status`, body: envelope("auth/status", { vendor: "kimi" }) }));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, {
        type: "server-response",
        rpcId: "rpc-test-1",
        result: { ok: true, value: { endpoint: "auth/status", payload: { vendor: "kimi" } } }
    });
    assert.deepEqual(calls, [["auth/status", { vendor: "kimi" }]], "the handler receives the endpoint and payload");
}

// C. The trust fence is fail-closed: a rejection never reaches the handler.
{
    let called = false;
    const route = createAccountRoute({
        handler: async () => { called = true; return { ok: true, value: null }; },
        reject: () => 401
    });
    const rejected = await drive(route, makeRequest({ body: envelope("auth/status") }));
    assert.equal(rejected.status, 401, "a rejection must answer with its own status");
    assert.equal(called, false, "a rejected request must not reach the handler");

    const missingFence = createAccountRoute({
        handler: async () => { called = true; return { ok: true, value: null }; },
        reject: () => 503
    });
    const unavailable = await drive(missingFence, makeRequest({ body: envelope("auth/status") }));
    assert.equal(unavailable.status, 503, "a missing Connection fence must fail closed");
    assert.equal(called, false);
}

// D. Oversized bodies are refused before the handler runs.
{
    let called = false;
    const route = createAccountRoute({
        handler: async () => { called = true; return { ok: true, value: null }; },
        reject: () => undefined
    });
    const huge = await drive(route, makeRequest({
        body: envelope("auth/status", { padding: "x".repeat(1024 * 1024 + 16) })
    }));
    assert.equal(huge.status, 413, "a body over the RPC limit must answer 413");
    assert.equal(called, false);
}

// E. The installed plugin path: installAccountData registers the prefix route on
//    the Host webServer, and that route answers a real RPC call end to end.
{
    const registrations = [];
    let disposed = false;
    const storage = new Map();
    const scope = {
        credentials: {
            async resolve(ref) {
                const value = storage.get(String(ref));
                return value === undefined ? undefined : { value, source: "test" };
            },
            async set(ref, value) { storage.set(String(ref), value); },
            async unset(ref) { storage.delete(String(ref)); }
        },
        webServer: {
            register(route) {
                registrations.push(route);
                return () => { disposed = true; };
            }
        },
        get(name) {
            if (name !== "connection") return undefined;
            return { requestRejection: () => undefined };
        },
        effect(execute) {
            return execute();
        }
    };
    const effects = [];
    const ctx = {
        get: () => undefined,
        inject(deps, apply) {
            effects.push([deps, apply]);
        }
    };

    installAccountData(ctx, undefined);
    assert.equal(effects.length, 1, "installAccountData must wait for its Host services");
    assert.deepEqual(effects[0][0], ["webServer", "credentials"], "the Host route only needs webServer and credentials");

    effects[0][1](scope);
    assert.equal(registrations.length, 1, "exactly one prefix route is registered");
    const route = registrations[0];
    assert.equal(route.kind, "prefix", "the channel must claim a prefix route");
    assert.equal(route.path, CHANNEL, "the route path must be this plugin's channel");
    assert.equal(typeof route.handler, "function", "the route carries the RPC handler");

    process.env.DSH_PROFILE_DIR = `${process.cwd()}\\tmp\\verify-channel-profile`;
    storage.set("UTILITY_APPEARANCE_KIT_KIMI_CREDENTIAL", JSON.stringify({ version: 1, kind: "api-key", secret: "sk-test-kimi" }));
    const answered = await drive(route.handler, makeRequest({
        url: `${CHANNEL}/auth/api-key/get`,
        body: envelope("auth/api-key/get", { vendor: "kimi" })
    }));
    await tick();
    assert.equal(answered.status, 200, "the registered route must answer 200 instead of 405");
    assert.equal(answered.body.type, "server-response");
    assert.equal(answered.body.rpcId, "rpc-test-1");
    assert.equal(answered.body.result.ok, true);
    assert.equal(answered.body.result.value.apiKey, "sk-test-kimi");

    const disposedRoute = registrations[0];
    assert.equal(typeof disposedRoute.handler, "function");
    assert.equal(disposed, false, "the disposer is only called by the effect teardown");
    assert.equal(accountTest.createAccountRoute, createAccountRoute);
}

// F. Real Cordis integration: the exact environment that used to break.
//    A real Context must resolve `webServer`/`credentials`, run the effect, and
//    keep the registered prefix route reachable — with no Connection fiber
//    internals touched.
{
    let cordis;
    try {
        cordis = await import("@deepseek-ai/cordis");
    } catch {
        console.log("channel: @deepseek-ai/cordis is not installed; run `pnpm install` for the real-deployment check");
        cordis = undefined;
    }
    const { Context, Service } = cordis ?? {};
    if (Context !== undefined) {
        const routes = [];
        class FakeWebServer extends Service {
            constructor(ctx) {
                super(ctx, "webServer");
            }

            register(route) {
                routes.push(route);
                return () => {
                    const index = routes.indexOf(route);
                    if (index >= 0) routes.splice(index, 1);
                };
            }

            get protocol() {
                return "http:";
            }
        }
        class FakeCredentials extends Service {
            constructor(ctx) {
                super(ctx, "credentials");
            }

            async resolve() {
                return { value: JSON.stringify({ version: 1, kind: "api-key", secret: "sk-cordis-path" }), source: "test" };
            }

            async set() {}
            async unset() {}
        }
        class FakeConnection extends Service {
            constructor(ctx) {
                super(ctx, "connection");
            }

            requestRejection() {
                return undefined;
            }
        }

        const root = new Context();
        root.plugin(FakeWebServer);
        root.plugin(FakeCredentials);
        root.plugin(FakeConnection);
        await tick();
        await tick();
        installAccountData(root, undefined);
        // ctx.inject starts a child fiber once every dependency resolves.
        await tick();
        await tick();
        await tick();
        assert.equal(routes.length, 1, `cordis must receive exactly one route, got ${routes.length}`);
        assert.equal(routes[0].kind, "prefix");
        assert.equal(routes[0].path, CHANNEL);

        const answered = await drive(routes[0].handler, makeRequest({
            url: `${CHANNEL}/auth/api-key/get`,
            body: envelope("auth/api-key/get", { vendor: "kimi" })
        }));
        assert.equal(answered.status, 200, "the route must answer through a real cordis tree");
        assert.equal(answered.body.result.value.apiKey, "sk-cordis-path");
        await root.fiber.dispose();
    }
}

// G. Real node:http exchange: the handler must work on an actual IncomingMessage
//    (async body iteration, writeHead, end) — the shape webServer handlers get.
{
    const { createServer } = await import("node:http");
    const route = createAccountRoute({
        handler: async (endpoint, payload) => ({ ok: true, value: { endpoint, payload } }),
        reject: (request) => (request.headers["x-test-deny"] === "1" ? 403 : undefined)
    });
    const server = createServer((req, res) => {
        route(req, res).catch(() => {
            res.writeHead(500);
            res.end();
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}${CHANNEL}/auth/status`;
    try {
        const ok = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: envelope("auth/status", { vendor: "kimi" })
        });
        assert.equal(ok.status, 200, "a real HTTP POST must answer 200");
        assert.equal(ok.headers.get("cache-control"), "no-store");
        const result = await ok.json();
        assert.equal(result.type, "server-response");
        assert.equal(result.rpcId, "rpc-test-1");
        assert.deepEqual(result.result, { ok: true, value: { endpoint: "auth/status", payload: { vendor: "kimi" } } });

        const denied = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-test-deny": "1" },
            body: envelope("auth/status")
        });
        assert.equal(denied.status, 403, "the fence status must reach the wire");

        const wrongMethod = await fetch(url, { method: "GET" });
        assert.equal(wrongMethod.status, 405, "GET must answer 405 over real HTTP");
        assert.equal(wrongMethod.headers.get("allow"), "POST");

        const wrongType = await fetch(url, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}"
        });
        assert.equal(wrongType.status, 415);

        const longBody = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ rpcId: "x", method: "auth/status", payload: "y".repeat(2 * 1024 * 1024) })
        });
        assert.equal(longBody.status, 413, "the declared length over the limit must answer 413");
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

console.log("subscription channel checks passed");