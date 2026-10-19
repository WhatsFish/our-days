import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { pool } from "../src/lib/db";
import { GET, POST } from "../src/app/api/[...path]/route";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Receipt tests require the isolated loopback test database");
}
process.env.WECHAT_VERIFY_TOKEN = "synthetic-receipt-token";
process.env.WECHAT_OPEN_ID = "synthetic-recipient";
const temp = await mkdtemp(path.join(tmpdir(), "our-days-api-config-"));
process.env.PRIVATE_CONFIG_DIR = temp;
process.env.MEDIA_ROOT = temp;
process.env.PUBLIC_URL = "https://example.com/our-days";
process.env.AI_ENABLED = "false";
const timestamp = String(Math.floor(Date.now() / 1000)), nonce = "synthetic";
const signature = createHash("sha1").update([process.env.WECHAT_VERIFY_TOKEN, timestamp, nonce].sort().join("")).digest("hex");
const url = `https://example.com/our-days/api/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}`;
const mass = `<xml><FromUserName>mphelper</FromUserName><MsgType>event</MsgType>
  <Event>MASSSENDJOBFINISH</Event><MsgID>18446744073709551613</MsgID><Status>send success</Status>
  <TotalCount>1</TotalCount><FilterCount>0</FilterCount><SentCount>0</SentCount><ErrorCount>0</ErrorCount></xml>`;
async function receive(body: string, target = url) {
  return POST(new NextRequest(target, { method: "POST", body }), { params: Promise.resolve({ path: ["wechat", "callback"] }) });
}
try {
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query("TRUNCATE wechat_receipts,wechat_mass_receipts");
  assert.equal((await receive(mass, url.replace(signature, "0".repeat(40)))).status, 403);
  assert.equal((await receive(mass)).status, 200);
  assert.equal((await receive(mass)).status, 200);
  const rows = (await pool.query("SELECT * FROM wechat_mass_receipts")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_id, "18446744073709551613");
  assert.equal(rows[0].total_count, 1);
  assert.equal(rows[0].sent_count, 0);
  assert.equal(rows[0].status, "send success");
  assert.equal((await receive(mass.replace("<ErrorCount>0</ErrorCount>", ""))).status, 400);
  assert.equal((await receive(mass.replace("mphelper", "synthetic-recipient"))).status, 400);
  const template = `<xml><FromUserName>synthetic-recipient</FromUserName><MsgType>event</MsgType>
    <Event>TEMPLATESENDJOBFINISH</Event><MsgID>18446744073709551614</MsgID><Status>success</Status></xml>`;
  assert.equal((await receive(template)).status, 200);
  assert.equal((await pool.query("SELECT status FROM wechat_receipts")).rows[0].status, "delivered");
  const token = "a".repeat(64), reader = "b".repeat(64);
  await pool.query("INSERT INTO sessions VALUES($1,'admin',now()+interval '1 hour'),($2,'reader',now()+interval '1 hour') ON CONFLICT DO NOTHING",
    [createHash("sha256").update(token).digest("hex"), createHash("sha256").update(reader).digest("hex")]);
  async function adminPost(endpoint: string, body: unknown, cookie = token) {
    return POST(new NextRequest(`https://example.com/our-days/api/${endpoint}`, {
      method: "POST", headers: { Origin: "https://example.com", Cookie: `our_days_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ path: endpoint.split("/") }) });
  }
  assert.equal((await adminPost("photo/place", { id: randomUUID(), consent: false })).status, 400);
  const settings = { enabled: true, provider: "deepseek", model: "deepseek-flash", apiKey: "synthetic-secret", inputRate: 1, outputRate: 2, monthlyLimit: 5 };
  const importId = randomUUID();
  await pool.query("INSERT INTO imports(id,ext,status,added,duplicates) VALUES($1,'image','done',0,1)", [importId]);
  const importsRequest = (cookie: string, ids: string) => GET(new NextRequest(
    `https://example.com/our-days/api/imports?ids=${ids}`,
    { headers: { Cookie: `our_days_session=${cookie}` } },
  ), { params: Promise.resolve({ path: ["imports"] }) });
  assert.equal((await importsRequest(reader, importId)).status, 403);
  assert.equal((await importsRequest(token, "not-a-uuid")).status, 400);
  const importsResponse = await importsRequest(token, importId);
  assert.equal(importsResponse.status, 200);
  const importRows = await importsResponse.json();
  assert.equal(importRows.length, 1);
  assert.equal(importRows[0].id, importId);
  assert.equal(importRows[0].duplicates, 1);
  await pool.query("DELETE FROM imports WHERE id=$1", [importId]);
  const dailySettings = { timezone: "Asia/Shanghai", send_time: "23:59", paused: true, weather_lat: null, weather_lon: null, weather_city: "", almanac: false, star_note: "" };
  assert.equal((await adminPost("settings", dailySettings)).status, 200);
  process.env.PUSH_ENABLED = "false";
  assert.equal((await adminPost("settings", { ...dailySettings, paused: false })).status, 409);
  Object.assign(process.env, { PUSH_ENABLED: "true", PUSH_CHANNEL: "wecom", WECOM_CONFIGURED: "true" });
  assert.equal((await adminPost("settings", { ...dailySettings, paused: false })).status, 200);
  assert.ok((await pool.query("SELECT enabled_at FROM settings")).rows[0].enabled_at);
  assert.equal((await adminPost("settings", dailySettings)).status, 200);
  process.env.PUSH_ENABLED = "false";
  assert.equal((await adminPost("ai/config", settings, reader)).status, 403);
  const saved = await adminPost("ai/config", settings);
  assert.equal(saved.status, 200);
  const safe = await saved.text();
  assert.equal(safe.includes("synthetic-secret"), false);
  assert.equal(JSON.parse(safe).keyConfigured, true);
  assert.equal((await adminPost("ai/config", { ...settings, apiKey: "", enabled: false })).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(temp, "ai.json"), "utf8")).apiKey, settings.apiKey);
  assert.equal((await adminPost("ai/config", { ...settings, provider: "openai", apiKey: "" })).status, 400);
  const originalFetch = globalThis.fetch;
  const photoId = randomUUID();
  await pool.query("INSERT INTO photos(id,sha256,original_ext,original_bytes,facts) VALUES($1,$2,'jpg',1,'A confirmed synthetic memory')", [photoId, randomUUID()]);
  assert.equal((await adminPost("ai/config", settings)).status, 200);
  try {
    globalThis.fetch = async (input, init) => {
      const endpoint = String(input);
      if (endpoint.startsWith("https://nominatim.openstreetmap.org/")) {
        const url = new URL(endpoint);
        assert.equal(url.searchParams.get("lat"), "35.123");
        assert.equal(url.searchParams.get("lon"), "139.988");
        return Response.json({ address: { country: "Japan", state: "Tokyo", city: "Sample City" } });
      }
      if (endpoint.endsWith("/models")) return Response.json({ data: [{ id: "deepseek-flash" }] });
      assert.equal(endpoint, "https://api.deepseek.com/chat/completions");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.messages[1].content.includes("A confirmed synthetic memory"), true);
      assert.equal("image" in payload, false);
      return Response.json({ choices: [{ message: { content: "Synthetic candidate" } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
    };
    assert.equal((await adminPost("ai/test", { confirm: true })).status, 200);
    assert.equal((await adminPost("ai", { id: photoId, style: "温柔", consent: true })).status, 200);
    assert.equal((await pool.query("SELECT provider FROM ai_events ORDER BY created_at DESC LIMIT 1")).rows[0].provider, "deepseek");
    assert.equal((await adminPost("photo/place", { id: photoId, consent: true })).status, 400);
    await pool.query("UPDATE photos SET latitude=35.123456,longitude=139.987654 WHERE id=$1", [photoId]);
    const place = await adminPost("photo/place", { id: photoId, consent: true });
    assert.equal(place.status, 200);
    assert.equal((await place.json()).place, "Japan · Tokyo · Sample City");
    const row = (await pool.query("SELECT place_label,approved,gps_place_guess FROM photos WHERE id=$1", [photoId])).rows[0];
    assert.equal(row.place_label, "");
    assert.equal(row.approved, false);
    assert.equal(row.gps_place_guess, "Japan · Tokyo · Sample City");
    globalThis.fetch = async () => { throw new Error("Cache must avoid any new external request"); };
    assert.equal((await adminPost("photo/place", { id: photoId, consent: true })).status, 200);
    await pool.query("UPDATE ai_events SET created_at=now()-interval '31 seconds'");
    assert.equal((await adminPost("ai/config", {
      ...settings, provider: "zhipu", model: "glm-5.3", apiKey: "synthetic-zhipu-key", enabled: false,
    })).status, 200);
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://open.bigmodel.cn/api/paas/v4/chat/completions");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.model, "glm-5.3");
      assert.equal(payload.max_tokens, 32);
      assert.equal(payload.thinking.type, "disabled");
      assert.equal(JSON.stringify(payload).includes("A confirmed synthetic memory"), false);
      assert.equal(init?.redirect, "error");
      return Response.json({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
    };
    const zhipuTest = await adminPost("ai/test", { confirm: true });
    assert.equal(zhipuTest.status, 200);
    const lastAI = (await pool.query("SELECT provider,task,cost_usd FROM ai_events ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.equal(lastAI.provider, "zhipu");
    assert.equal(lastAI.task, "connection_test");
    assert.ok(Number(lastAI.cost_usd) > 0);
    const noCap = { ...settings, provider: "zhipu", model: "glm-5.3", apiKey: "", enabled: true, monthlyLimit: null, inputRate: null, outputRate: null };
    assert.equal((await adminPost("ai/config", noCap)).status, 200);
    await pool.query("UPDATE ai_events SET created_at=now()-interval '31 seconds',cost_usd=999999");
    assert.equal((await adminPost("ai/test", { confirm: true })).status, 200, "Uncapped calls must not be blocked by prior monthly spend");
    const unpriced = (await pool.query("SELECT input_tokens,output_tokens,cost_usd,status FROM ai_events ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.equal(unpriced.input_tokens, 10);
    assert.equal(unpriced.output_tokens, 1);
    assert.equal(unpriced.cost_usd, null);
    assert.equal(unpriced.status, "complete");
    assert.equal((await adminPost("ai/config", { ...noCap, monthlyLimit: 5 })).status, 400, "A cap needs known prices");
    await pool.query("UPDATE ai_events SET created_at=now()-interval '31 seconds'");
    assert.equal((await adminPost("ai/config", { ...noCap, monthlyLimit: 5, inputRate: 1, outputRate: 2 })).status, 200);
    assert.equal((await adminPost("ai/test", { confirm: true })).status, 409, "Unknown historic costs must not be counted as zero under a new cap");
    const flashConfig = await adminPost("ai/config", { ...noCap, model: "GLM-5.3-Flash" });
    assert.equal(flashConfig.status, 200);
    assert.equal((await flashConfig.json()).model, "glm-5.3-flash");
    await pool.query("UPDATE ai_events SET created_at=now()-interval '31 seconds'");
    let flashCalls = 0;
    globalThis.fetch = async (_input, init) => {
      flashCalls++;
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.model, "glm-5.3-flash");
      assert.equal(payload.thinking.type, "enabled");
      assert.equal(payload.max_tokens, 2048);
      return new Response("", { status: 401 });
    };
    const rejected = await adminPost("ai/test", { confirm: true });
    assert.equal(rejected.status, 502);
    assert.match((await rejected.json()).error, /HTTP 401/);
    assert.equal(flashCalls, 1, "Authentication failure must not be automatically retried");
    const failedEvent = (await pool.query("SELECT status,error_code FROM ai_events ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.equal(failedEvent.status, "failed");
    assert.equal(failedEvent.error_code, "ai_provider_http_401");
  } finally { globalThis.fetch = originalFetch; }
  assert.equal((await adminPost("ai/config", { ...settings, enabled: false, apiKey: "", clearKey: true })).status, 200);
  const dashboard = await GET(new NextRequest("https://example.com/our-days/api/admin", { headers: { Cookie: `our_days_session=${token}` } }),
    { params: Promise.resolve({ path: ["admin"] }) });
  assert.equal(dashboard.status, 200);
  const publicDashboard = await dashboard.text();
  assert.equal(publicDashboard.includes("synthetic-secret"), false);
  assert.equal(JSON.parse(publicDashboard).ai.keyConfigured, false);
  assert.equal(JSON.parse(publicDashboard).aiUnknownCost, 2);
  const status = JSON.parse(publicDashboard);
  assert.equal(typeof status.stats.photos, "number");
  assert.equal(typeof status.stats.submitted, "number");
  assert.equal(status.resources.processRss > 0, true);
  assert.equal(status.resources.diskFree > 0, true);
  assert.equal(Array.isArray(status.queue), true);
  await pool.query("DELETE FROM photos WHERE id=$1", [photoId]);
  console.log("Receipt integration passed: signature, mass counters, zero-recipient success, deduplication, validation, template regression.");
  console.log("AI settings integration passed: admin-only save, no key echoes, blank preservation, supplier-change guard, mock generation, cost recording, connection test and key deletion.");
} finally {
  await pool.end();
  for (const file of await readdir(temp)) await unlink(path.join(temp, file));
  await rmdir(temp);
}
