import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureLabel, embeddedPlace } from "../src/lib/photo-metadata";
import { aiConfigInput, publicAI, runtimeAI, testAIConnection } from "../src/lib/ai-config";

test("capture labels preserve camera wall time without guessing an offset", () => {
  assert.equal(captureLabel("2020:01:02 23:45:12"), "2020年1月2日 23:45");
  assert.equal(captureLabel("2020-01-02T23:45:12+09:00"), "2020年1月2日 23:45");
  assert.equal(captureLabel(null), "");
  assert.equal(captureLabel("2026:02:30 12:00:00"), "");
  assert.equal(captureLabel("File uploaded yesterday"), "");
  assert.equal(captureLabel("2024-02-29"), "2024年2月29日");
});
test("place extraction uses only embedded descriptive metadata, not invented GPS labels", () => {
  assert.equal(embeddedPlace({ Country: "Japan", State: "Tokyo", City: "Tokyo", Location: "Park" }), "Japan · Tokyo · Park");
  assert.equal(embeddedPlace({ GPSLatitude: 35, GPSLongitude: 139 }), "");
  assert.equal(embeddedPlace({ City: ["not", "a", "string"], Country: " " }), "");
});
test("AI public configuration never exposes API key; unsafe inputs fail validation", () => {
  const config = { enabled: false, provider: "deepseek" as const, model: "deepseek-flash", apiKey: "synthetic-secret", inputRate: 1, outputRate: 2, monthlyLimit: 5 };
  const result = publicAI(config);
  assert.equal(result.keyConfigured, true);
  assert.equal("apiKey" in result, false);
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
  assert.equal(aiConfigInput.safeParse({ ...config, provider: "custom", url: "http://127.0.0.1" }).success, false);
  assert.equal(aiConfigInput.safeParse({ ...config, apiKey: "key\nInjected: secret" }).success, false);
  assert.equal(aiConfigInput.safeParse({ ...config, monthlyLimit: -1 }).success, false);
  assert.equal(aiConfigInput.safeParse({ ...config, monthlyLimit: null, inputRate: null, outputRate: null }).success, true);
});
test("saved AI config is loaded per call and connection test sends no photo facts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "our-days-ai-unit-"));
  const previous = process.env.PRIVATE_CONFIG_DIR;
  process.env.PRIVATE_CONFIG_DIR = dir;
  try {
    const config = { enabled: true, provider: "deepseek", model: "deepseek-flash", apiKey: "synthetic-secret", inputRate: 1, outputRate: 2, monthlyLimit: 5 };
    await writeFile(path.join(dir, "ai.json"), JSON.stringify(config), { mode: 0o600 });
    assert.equal((await runtimeAI()).url, "https://api.deepseek.com/chat/completions");
    const result = await testAIConnection(async (url, init) => {
      assert.equal(String(url), "https://api.deepseek.com/models");
      assert.equal(init?.body, undefined);
      assert.equal(init?.redirect, "error");
      return Response.json({ data: [{ id: "deepseek-flash" }] });
    });
    assert.equal(result.ok, true);
    await assert.rejects(testAIConnection(async () => new Response("", { status: 401 })), /HTTP 401/);
    await assert.rejects(testAIConnection(async () => Response.json({ data: [{ id: "other" }] })), /没有所填模型/);
    await writeFile(path.join(dir, "ai.json"), JSON.stringify({ ...config, enabled: false }));
    assert.equal((await runtimeAI()).enabled, false);
    await writeFile(path.join(dir, "ai.json"), JSON.stringify({ ...config, provider: "zhipu", model: "glm-5.3" }));
    assert.equal((await runtimeAI()).url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
    assert.equal(aiConfigInput.safeParse({ ...config, provider: "zhipu", model: "glm-5.3" }).success, true);
    await writeFile(path.join(dir, "ai.json"), JSON.stringify({ ...config, monthlyLimit: null, inputRate: null, outputRate: null }));
    assert.equal((await runtimeAI()).monthlyLimit, null);
    assert.equal((await runtimeAI()).inputRate, null);
    await writeFile(path.join(dir, "ai.json"), JSON.stringify({ ...config, provider: "zhipu", model: "GLM-5.3-Flash", monthlyLimit: null }));
    assert.equal((await runtimeAI()).model, "glm-5.3-flash");
  } finally {
    if (previous === undefined) delete process.env.PRIVATE_CONFIG_DIR; else process.env.PRIVATE_CONFIG_DIR = previous;
    await unlink(path.join(dir, "ai.json")); await rmdir(dir);
  }
});
