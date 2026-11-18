import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import { pool } from "../src/lib/db";
import { uploadSpecialMaterial } from "../src/lib/special-media";
import { holidayDashboard, holidaySettings, processHolidayDelivery, processHolidayGeneration, requestHolidayRegeneration, saveHolidayRules, syncHolidayPlan } from "../src/lib/holidays";
import { defaultHolidayRules, holidayPlan } from "../src/lib/holiday-calendar";
import { GET, POST } from "../src/app/api/[...path]/route";
import { tokenHash } from "../src/lib/auth";
import { tick } from "../src/lib/worker";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Holiday tests require isolated database");
}
const dir = await mkdtemp(path.join(tmpdir(), "our-days-holiday-"));
const configDir = path.join(dir, "config");
const { mkdir } = await import("node:fs/promises");
await mkdir(configDir);
Object.assign(process.env, { MEDIA_ROOT: dir, PRIVATE_CONFIG_DIR: configDir, MEDIA_QUOTA_MB: "1024",
  PUSH_CHANNEL: "wecom", PUSH_ENABLED: "true", WECOM_CORP_ID: "wwSynthetic", WECOM_APP_SECRET: "synthetic-only",
  WECOM_AGENT_ID: "100001", WECOM_USER_ID: "operator|partner", PUBLIC_URL: "https://example.com/our-days" });
await writeFile(path.join(configDir, "ark-image.json"), JSON.stringify({ provider: "ark", apiKey: "synthetic-ark-key" }));
const fetchBefore = globalThis.fetch;
const image = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#f4e3cd" } }).png().toBuffer();
let images = 0, sends = 0, mode = "ok", lastPrompt = "", partial = false;
let releaseProvider: (() => void) | undefined, startedProvider: (() => void) | undefined;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "ark.cn-beijing.volces.com") {
    images++;
    const body = JSON.parse(String(init?.body));
    for (const image of Array.isArray(body.image) ? body.image : [body.image]) assert.match(image, /^data:image\/jpeg;base64,/);
    if (images === 2) assert.equal(body.image.length, 2, "Regeneration references both character style and current card");
    assert.equal(body.model, "doubao-seedream-5-5-261028");
    lastPrompt = body.prompt;
    if (mode === "hold") { startedProvider?.(); await new Promise<void>(resolve => { releaseProvider = resolve; }); }
    if (mode === "reject") return Response.json({ error: {} }, { status: 403 });
    if (mode === "unknown") throw new Error("Synthetic ambiguous transport failure");
    return Response.json({ data: [{ b64_json: image.toString("base64") }] });
  }
  assert.equal(url.hostname, "qyapi.weixin.qq.com");
  if (url.pathname.endsWith("/gettoken")) return Response.json({ errcode: 0, access_token: "fake" });
  if (url.pathname.endsWith("/user/get")) return Response.json({ errcode: 0, userid: url.searchParams.get("userid"), status: 1 });
  if (url.pathname.endsWith("/agent/get")) return Response.json({ errcode: 0, agentid: 100001, close: 0 });
  if (url.pathname.endsWith("/media/upload")) return Response.json({ errcode: 0, media_id: "fake-card" });
  assert.equal(url.pathname, "/cgi-bin/message/send");
  assert.equal(JSON.parse(String(init?.body)).touser, "operator|partner");
  sends++;
  return Response.json({ errcode: 0, msgid: "synthetic-msg", invaliduser: partial ? "partner" : "" });
};
async function seedReady(day: string, material: string) {
  const event = holidayPlan(defaultHolidayRules, new Date(`${day}T04:00:00Z`), 1)[0];
  assert.ok(event);
  await pool.query("INSERT INTO holiday_cards(day,names,categories) VALUES($1,$2,$3) ON CONFLICT(day) DO UPDATE SET status='waiting',recipients=NULL,error_code=NULL",
    [day, event.names, event.categories]);
  await pool.query(`INSERT INTO holiday_generations(id,day,revision,names,status,material_id)
    VALUES($1,$2,1,$3,'ready',$4) ON CONFLICT(day,revision) DO UPDATE SET status='ready',material_id=$4`,
  [randomUUID(), day, event.names, material]);
}
try {
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query("TRUNCATE holiday_generations,holiday_cards,holiday_settings,special_sends,special_materials,ai_events,editions,photos CASCADE");
  await pool.query("INSERT INTO holiday_settings(id) VALUES(true)");
  await pool.query("UPDATE settings SET paused=false,send_time='08:00',timezone='Asia/Shanghai',enabled_at=NULL");
  assert.deepEqual(Object.fromEntries(Object.entries(await holidaySettings()).filter(([key]) => key !== "id" && key !== "reference_id")), defaultHolidayRules);
  const reference = await uploadSpecialMaterial(image, "Synthetic birthday reference");
  await pool.query("UPDATE holiday_settings SET reference_id=$1", [reference.id]);
  const now = new Date();
  await syncHolidayPlan(now);
  const plan = await holidayDashboard(now);
  assert.ok(plan.upcoming.length);
  assert.equal(plan.referenceReady, true);
  assert.equal(images, 0, "Reading and planning do not call image APIs");
  const day = plan.upcoming[0].day;
  mode = "hold";
  const started = new Promise<void>(resolve => { startedProvider = resolve; });
  const generation = processHolidayGeneration(now);
  await started;
  await processHolidayGeneration(now);
  assert.equal(images, 1, "Generation advisory lock prevents duplicate paid requests");
  releaseProvider!();
  await generation;
  mode = "ok";
  let latest = (await pool.query("SELECT * FROM holiday_generations WHERE day=$1 ORDER BY revision DESC LIMIT 1", [day])).rows[0];
  assert.equal(latest.status, "ready");
  assert.equal(sends, 0, "Pre-generation never dispatches");
  const initialMaterial = latest.material_id;
  await requestHolidayRegeneration(day, "换成夜晚，两个人物大一点");
  await assert.rejects(requestHolidayRegeneration(day, "Repeated click"), /已有生成任务/);
  mode = "reject";
  await processHolidayGeneration(now);
  latest = (await pool.query("SELECT * FROM holiday_generations WHERE day=$1 ORDER BY revision DESC LIMIT 1", [day])).rows[0];
  assert.equal(latest.status, "failed");
  assert.match(lastPrompt, /换成夜晚/);
  assert.equal((await holidayDashboard()).attention, 1);
  assert.equal(Number((await pool.query("SELECT cost_cny FROM ai_events ORDER BY created_at DESC LIMIT 1")).rows[0].cost_cny), 0);
  const afterFailure = images;
  await saveHolidayRules({ solar_terms: false, chinese: false, western: false });
  await processHolidayGeneration(now);
  assert.equal(images, afterFailure, "Disabled categories do not generate or show stale cached events");
  assert.equal((await holidayDashboard()).upcoming.length, 0);
  await saveHolidayRules(defaultHolidayRules);
  await requestHolidayRegeneration(day, "另一个镜头");
  mode = "unknown";
  await processHolidayGeneration(now);
  latest = (await pool.query("SELECT * FROM holiday_generations WHERE day=$1 ORDER BY revision DESC LIMIT 1", [day])).rows[0];
  assert.equal(latest.status, "unknown");
  assert.equal(Number((await pool.query("SELECT cost_cny FROM ai_events ORDER BY created_at DESC LIMIT 1")).rows[0].cost_cny), 0.33);
  assert.equal(await processHolidayDelivery(day, new Date(`${day}T00:01:00Z`)), true);
  assert.equal(sends, 0, "Failed/unknown regeneration must not dispatch the previous ready version or a photo");
  await pool.query("UPDATE holiday_cards SET status='waiting',error_code=NULL WHERE day=$1", [day]);
  await requestHolidayRegeneration(day, "成功版本");
  mode = "ok";
  await processHolidayGeneration(now);
  await Promise.all([tick(new Date(`${day}T00:01:00Z`)), tick(new Date(`${day}T00:01:00Z`))]);
  assert.equal(sends, 1);
  await saveHolidayRules({ solar_terms: false, chinese: false, western: false });
  assert.equal(await processHolidayDelivery(day, new Date(`${day}T00:02:00Z`)), true, "Already submitted day stays consumed after toggles change");
  assert.equal(sends, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM editions")).rows[0].n, 0, "Holidays consume no photos");
  await saveHolidayRules(defaultHolidayRules);
  await seedReady("2026-12-25", initialMaterial);
  partial = true;
  await processHolidayDelivery("2026-12-25", new Date("2026-12-25T00:01:00Z"));
  assert.equal((await pool.query("SELECT status FROM holiday_cards WHERE day='2026-12-25'")).rows[0].status, "unknown");
  await processHolidayDelivery("2026-12-25", new Date("2026-12-25T00:02:00Z"));
  assert.equal(sends, 2, "Partial acceptance never resends");
  await seedReady("2026-12-24", initialMaterial);
  await processHolidayDelivery("2026-12-24", new Date("2026-12-24T00:16:00Z"));
  assert.equal((await pool.query("SELECT error_code FROM holiday_cards WHERE day='2026-12-24'")).rows[0].error_code, "missed_send_window");
  assert.equal(sends, 2);
  await seedReady("2027-02-14", initialMaterial);
  const photoId = randomUUID();
  await pool.query("INSERT INTO photos(id,sha256,original_ext,original_bytes) VALUES($1,$2,'jpg',1)", [photoId, photoId]);
  await pool.query("INSERT INTO editions(id,day,photo_id,title,send_at) VALUES($1,'2027-02-14',$2,'Manual',now()+interval '1 day')", [randomUUID(), photoId]);
  assert.equal(await processHolidayDelivery("2027-02-14", new Date("2027-02-14T00:01:00Z")), false, "Manual photo reservation remains authoritative");
  assert.equal(sends, 2);
  const token = randomBytes(32).toString("hex");
  await pool.query("INSERT INTO sessions VALUES($1,'reader',now()+interval '1 hour')", [tokenHash(token)]);
  const context = { params: Promise.resolve({ path: ["holidays"] }) };
  assert.equal((await GET(new NextRequest("https://example.com/our-days/api/holidays"), context)).status, 401);
  assert.equal((await GET(new NextRequest("https://example.com/our-days/api/holidays", { headers: { Cookie: `our_days_session=${token}` } }), context)).status, 403);
  assert.equal((await POST(new NextRequest("https://example.com/our-days/api/holidays/settings", {
    method: "POST", headers: { Origin: "https://wrong.example" }, body: JSON.stringify(defaultHolidayRules),
  }), { params: Promise.resolve({ path: ["holidays", "settings"] }) })).status, 403);
  await pool.query("DELETE FROM editions");
  await pool.query("DELETE FROM photos");
  await pool.query("TRUNCATE holiday_generations,holiday_cards");
  await pool.query("UPDATE settings SET send_time='00:00'");
  const beforeEmptyStock = images;
  await assert.rejects(tick(new Date("2026-11-19T04:00:00Z")), /待发送照片用完/);
  assert.equal(images, beforeEmptyStock + 1, "Empty photo inventory must not prevent future holiday pre-generation");
  console.log("Holiday automation passed: default-on rules, deterministic planning, reference image calls, concurrency dedup, paid reservations, feedback regeneration, failures/unknown accounting, disabled switches, no stale-image fallback, daily replacement, no photo consumption, partial/no-repeat safety, missed window, manual reservations and API access guards.");
} finally {
  globalThis.fetch = fetchBefore;
  await pool.end();
  for (const sub of ["special", "config"]) {
    for (const name of await readdir(path.join(dir, sub))) await unlink(path.join(dir, sub, name));
    await rmdir(path.join(dir, sub));
  }
  await rmdir(dir);
}
