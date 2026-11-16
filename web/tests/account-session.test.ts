import { afterAll, afterEach, expect, test } from "bun:test";
import { cloudRequest, CloudError } from "../src/services/api/cloud";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const target = new EventTarget();
let expired = 0;
target.addEventListener("canvas-session-expired", () => expired++);
Object.defineProperty(globalThis, "window", { configurable: true, value: target });
afterEach(() => { globalThis.fetch = originalFetch; expired = 0; });
afterAll(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("authenticated API failures notify session expiry, while logout never triggers the expiry flow", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "授权凭据已失效，请重新登录" }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
    await expect(cloudRequest("/account/overview")).rejects.toBeInstanceOf(CloudError);
    expect(expired).toBe(1);
    await expect(cloudRequest("/auth/logout", {}, "POST", null)).rejects.toBeInstanceOf(CloudError);
    await expect(cloudRequest("/library/settings")).rejects.toBeInstanceOf(CloudError);
    expect(expired).toBe(1);
});

test("rate limits, service failures and offline requests do not expire the session", async () => {
    for (const status of [403, 429, 502, 503]) {
        globalThis.fetch = (async () => new Response("{}", { status, headers: { "content-type": "application/json" } })) as typeof fetch;
        await expect(cloudRequest("/auth/credentials", {})).rejects.toBeInstanceOf(CloudError);
    }
    globalThis.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    await expect(cloudRequest("/account/overview")).rejects.toThrow("offline");
    expect(expired).toBe(0);
});

test("cloud storage disabled responses retain the machine code and never expire login", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: "CLOUD_STORAGE_DISABLED", message: "管理员已关闭云端存储" }), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch;
    try { await cloudRequest("/sync/changes"); throw new Error("expected rejection"); }
    catch (error) { expect(error).toBeInstanceOf(CloudError); expect((error as CloudError).body).toEqual({ code: "CLOUD_STORAGE_DISABLED", message: "管理员已关闭云端存储" }); }
    expect(expired).toBe(0);
});

test("cancelling a sync request leaves authentication and administrator requests usable", async () => {
    const sync = new AbortController();
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        if (init?.signal === sync.signal) return new Promise<Response>((_resolve, reject) => sync.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
        expect(init?.signal?.aborted).toBe(false);
        return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const pending = cloudRequest("/sync/changes", undefined, "GET", sync.signal);
    sync.abort(); await expect(pending).rejects.toThrow("Aborted");
    await expect(cloudRequest("/admin/storage/pools")).resolves.toEqual({});
    await expect(cloudRequest("/auth/session")).resolves.toEqual({});
    expect(expired).toBe(0);
});
