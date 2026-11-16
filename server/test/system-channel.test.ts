import { test } from "node:test";
import assert from "node:assert/strict";
import { systemChannelSchema } from "../src/system-channel.js";
import { defaultSystemPreferences, emptySystemChannel, pruneSystemModels, sanitizeSystemOverrides } from "../../shared/system-channel.js";

test("system channels start empty and require exposed capability-matched defaults", () => {
    assert.deepEqual(systemChannelSchema.parse(emptySystemChannel).models, []);
    const config = { models: [{ name: "image", capability: "image" as const }], enabledModels: ["image"], defaults: { ...defaultSystemPreferences, imageModel: "image" } };
    assert.equal(systemChannelSchema.safeParse(config).success, true);
    assert.equal(systemChannelSchema.safeParse({ ...config, enabledModels: [] }).success, false);
    assert.equal(systemChannelSchema.safeParse({ ...config, defaults: { ...config.defaults, textModel: "image" } }).success, false);
    assert.equal(systemChannelSchema.safeParse({ ...config, models: [...config.models, ...config.models] }).success, false);
    assert.equal(systemChannelSchema.safeParse({ ...config, apiKey: "must-not-be-stored" }).success, false);
});

test("removing a model clears its exposure and defaults without replacing them", () => {
    const config = pruneSystemModels({ models: [{ name: "other", capability: "image" }], enabledModels: ["removed", "other"], defaults: { ...defaultSystemPreferences, imageModel: "removed" } });
    assert.deepEqual(config.enabledModels, ["other"]);
    assert.equal(config.defaults.imageModel, "");
});

test("imported preferences cannot replace credentials and preserve explicit false and empty prompts", () => {
    assert.deepEqual(sanitizeSystemOverrides({ apiKey: "secret", channels: [], count: 3, streamText: false, imageSystemPrompt: "" }), { streamText: false, imageSystemPrompt: "" });
});
