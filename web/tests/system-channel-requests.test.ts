import { afterAll, beforeEach, expect, test } from "bun:test";
import axios from "axios";
import type { AiConfig, ApiCallFormat, ModelCapability } from "../src/stores/use-config-store";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { defaultConfig } = await import("../src/stores/use-config-store");
const { requestGeneration, requestImageQuestion } = await import("../src/services/api/image");
const { runModelPlugin } = await import("../src/services/api/model-plugin");
const { useUserStore } = await import("../src/stores/use-user-store");
const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
const originalUser = useUserStore.getState().user;
const requests: Array<{ url: string; data: Record<string, any> }> = [];
function fixture(model: string, capability: ModelCapability, apiFormat: ApiCallFormat = "openai"): AiConfig {
    return { ...defaultConfig, model: `fixture::${model}`, [`${capability}Model`]: `fixture::${model}`, systemPrompt: "system instruction", channels: [{ id: "fixture", name: "Fixture", apiFormat, baseUrl: "https://example.com", apiKey: "fixture-key", models: [{ name: model, capability }] }] };
}
beforeEach(() => {
    requests.length = 0;
    useUserStore.getState().clearSession();
    axios.defaults.adapter = async config => {
        requests.push({ url: config.url || "", data: JSON.parse(config.data) });
        const data = config.url?.includes("generateContent") ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] } }] } : { data: [{ b64_json: "AAAA" }] };
        return { config, data, status: 200, statusText: "OK", headers: {} };
    };
});
afterAll(() => {
    globalThis.fetch = originalFetch; axios.defaults.adapter = originalAdapter;
    if (originalUser) useUserStore.getState().setUser(originalUser);
    else useUserStore.getState().clearSession();
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("Base64 is optional for OpenAI image models and omitted for gpt-image and Gemini", async () => {
    const config = fixture("dall-e-3", "image");
    await requestGeneration(config, "original input");
    expect(requests.at(-1)?.data.response_format).toBe("b64_json");
    expect(requests.at(-1)?.data.prompt).toBe("system instruction\n\noriginal input");
    await requestGeneration({ ...config, returnBase64: false }, "original input");
    expect(requests.at(-1)?.data).not.toHaveProperty("response_format");
    await requestGeneration(fixture("gpt-image-2", "image"), "original input");
    expect(requests.at(-1)?.data).not.toHaveProperty("response_format");
    await requestGeneration(fixture("gemini-image", "image", "gemini"), "original input");
    expect(requests.at(-1)?.data).not.toHaveProperty("response_format");
    expect(requests.at(-1)?.data.systemInstruction.parts[0].text).toBe("system instruction");
});

test("non-stream text uses full OpenAI and Gemini responses without rewriting input messages", async () => {
    const deltas: string[] = [];
    globalThis.fetch = (async (url, init) => {
        requests.push({ url: String(url), data: JSON.parse(String(init?.body)) });
        const payload = String(url).includes("generateContent") ? { candidates: [{ content: { parts: [{ text: "complete" }] } }] } : { output_text: "complete" };
        return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const messages = [{ role: "user" as const, content: "original" }];
    expect(await requestImageQuestion({ ...fixture("text-model", "text"), streamText: false }, messages, text => deltas.push(text))).toBe("complete");
    expect(requests.at(-1)?.data.stream).toBe(false);
    expect(requests.at(-1)?.url).toEndWith("/responses");
    expect(await requestImageQuestion({ ...fixture("text-model", "text", "gemini"), streamText: false }, messages, text => deltas.push(text))).toBe("complete");
    expect(requests.at(-1)?.url).toEndWith(":generateContent");
    expect(deltas).toEqual(["complete", "complete"]);
    expect(messages).toEqual([{ role: "user", content: "original" }]);
});

test("scripts receive effective prompts and explicit stream/Base64 switches", async () => {
    const value = await runModelPlugin({ capability: "image", script: "return { prompt, stream: params.stream, base64: params.returnBase64 };", config: { ...fixture("script-image", "image"), streamText: false, returnBase64: false }, prompt: "system instruction\n\noriginal" });
    expect(value).toEqual({ prompt: "system instruction\n\noriginal", stream: false, base64: false });
});
