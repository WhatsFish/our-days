import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/[...path]/route";
import { pool } from "../src/lib/db";
import { READY_PHOTOS_BASE_SQL } from "../src/lib/photo-queue";
import { OPERATOR_COUNTS_SQL } from "../src/lib/operator-status";
import { tick } from "../src/lib/worker";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Queue controls require the isolated loopback test database");
}
const media = await mkdtemp(path.join(tmpdir(), "our-days-queue-"));
Object.assign(process.env, {
  MEDIA_ROOT: media, PUBLIC_URL: "https://example.com/our-days",
  PUSH_CHANNEL: "wecom", PUSH_ENABLED: "true", WECOM_CONFIGURED: "true",
  WECOM_CORP_ID: "wwSynthetic", WECOM_APP_SECRET: "synthetic-secret",
  WECOM_AGENT_ID: "100001", WECOM_USER_ID: "operator",
});
const admin = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
const reader = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
const [a, b, c, unreviewed, fresh] = Array.from({ length: 5 }, () => randomUUID());
const originalFetch = globalThis.fetch;
let sends = 0;
const request = (route: string, body: unknown, token = admin) => POST(new NextRequest(`https://example.com/our-days/api/${route}`, {
  method: "POST", headers: { origin: "https://example.com", cookie: `our_days_session=${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
}), { params: Promise.resolve({ path: route.split("/") }) });
const get = async (route: string) => {
  const response = await GET(new NextRequest(`https://example.com/our-days/api/${route}`, {
    headers: { cookie: `our_days_session=${admin}` },
  }), { params: Promise.resolve({ path: [route.split("?")[0]] }) });
  assert.equal(response.status, 200);
  return response.json();
};
const queue = async () => (await pool.query(READY_PHOTOS_BASE_SQL)).rows.map(row => row.id);
async function nextDay() {
  await pool.query("UPDATE editions SET day=day-10,send_at=send_at-interval '10 days'");
  await Promise.all([tick(), tick()]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM editions WHERE day=current_date")).rows[0].count, 1);
  return (await pool.query("SELECT photo_id FROM editions WHERE day=current_date")).rows[0].photo_id;
}
try {
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query("TRUNCATE photos,editions,deliveries,favorites,imports,worker_state CASCADE");
  await pool.query("UPDATE settings SET paused=true,queue_loop=false,timezone='UTC',send_time='00:00',enabled_at=now()-interval '1 day',weather_lat=NULL,weather_lon=NULL,almanac=false,star_note=''");
  const settingsBefore = (await pool.query("SELECT * FROM settings")).rows[0];
  for (const [token, role] of [[admin, "admin"], [reader, "reader"]]) await pool.query(
    "INSERT INTO sessions VALUES($1,$2,now()+interval '1 hour')",
    [createHash("sha256").update(token).digest("hex"), role]);
  const image = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#7799aa" } }).webp().toBuffer();
  for (const [index, id] of [a, b, c, unreviewed].entries()) {
    await pool.query("INSERT INTO photos(id,sha256,original_ext,original_bytes,caption,approved,created_at) VALUES($1::uuid,$1::text,'jpg',1,'Synthetic caption',$2,now()-$3::int*interval '1 day')",
      [id, id !== unreviewed, 5 - index]);
    await writeFile(path.join(media, `${id}.display.webp`), image);
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "qyapi.weixin.qq.com");
    if (url.pathname.endsWith("/gettoken")) return Response.json({ errcode: 0, access_token: "synthetic" });
    if (url.pathname.endsWith("/agent/get")) return Response.json({ errcode: 0, agentid: 100001, close: 0 });
    if (url.pathname.endsWith("/user/get")) return Response.json({ errcode: 0, userid: "operator", status: 1 });
    if (url.pathname.endsWith("/media/upload")) return Response.json({ errcode: 0, media_id: "synthetic" });
    assert.equal(url.pathname, "/cgi-bin/message/send");
    assert.equal(JSON.parse(String(init?.body)).touser, "operator");
    sends++;
    return Response.json({ errcode: 0, msgid: `synthetic-${sends}` });
  };
  assert.deepEqual(await queue(), [a, b, c]);
  assert.equal((await request("queue/settings", { loop: true }, reader)).status, 403);
  assert.equal((await request("queue/pin", { id: b, pinned: true }, reader)).status, 403);
  assert.equal((await request("queue/settings", { loop: "true" })).status, 400);
  assert.equal((await request("queue/pin", { id: unreviewed, pinned: true })).status, 409);
  assert.equal((await request("queue/pin", { id: randomUUID(), pinned: true })).status, 404);
  assert.equal((await request("queue/pin", { id: c, pinned: true })).status, 200);
  assert.deepEqual(await queue(), [c, a, b]);
  assert.equal((await request("queue/pin", { id: b, pinned: true })).status, 200);
  assert.deepEqual(await queue(), [b, c, a], "Most recent pin is first");
  assert.equal((await request("queue/pin", { id: b, pinned: false })).status, 200);
  assert.deepEqual(await queue(), [c, a, b], "Unpin restores natural order");
  assert.equal((await request("queue/settings", { loop: true })).status, 200);
  assert.deepEqual((await pool.query("SELECT * FROM settings")).rows[0], { ...settingsBefore, queue_loop: true },
    "Loop changes must not enable sending or alter the scheduled time");
  await tick(); assert.equal(sends, 0);
  await pool.query("UPDATE settings SET paused=false");
  assert.equal(await nextDay(), c);
  assert.equal((await pool.query("SELECT queue_pinned_at FROM photos WHERE id=$1", [c])).rows[0].queue_pinned_at, null,
    "Pin is consumed once when the automatic edition is created");
  assert.deepEqual(await queue(), [a, b, c], "Sent photo moves to the tail, ahead of no unseen photos");
  await tick(); assert.equal(sends, 1, "Repeated ticks cannot send twice in one day");
  assert.equal(await nextDay(), a);
  assert.equal(await nextDay(), b);
  assert.equal(await nextDay(), c, "Exhausted first round starts again without deleting history");
  assert.equal(sends, 4);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM editions")).rows[0].count, 4);
  assert.equal((await pool.query(OPERATOR_COUNTS_SQL)).rows[0].ready, 3);
  assert.equal((await pool.query("SELECT next_week_count FROM service_health")).rows[0].next_week_count, 3);
  assert.equal((await get("photos?status=ready")).total, 3, "Library ready filter includes reusable photos");
  assert.equal((await request("queue/settings", { loop: false })).status, 200);
  assert.deepEqual(await queue(), []);
  assert.equal((await request("queue/pin", { id: a, pinned: true })).status, 409);
  assert.equal((await get("photos?status=ready")).total, 0);
  assert.equal((await request("queue/settings", { loop: true })).status, 200);
  assert.equal((await request("queue/pin", { id: b, pinned: true })).status, 200);
  assert.equal((await queue())[0], b, "Previously sent photo can be pinned when cycling is enabled");
  assert.equal(await nextDay(), b);
  assert.equal(sends, 5);
  await pool.query("INSERT INTO photos(id,sha256,original_ext,original_bytes,caption,approved) VALUES($1::uuid,$1::text,'jpg',1,'New synthetic caption',true)", [fresh]);
  await writeFile(path.join(media, `${fresh}.display.webp`), image);
  assert.equal((await queue())[0], fresh, "New unseen materials precede repeats");
  const beforeSnapshot = (await pool.query("SELECT snapshot FROM editions ORDER BY day LIMIT 1")).rows[0].snapshot;
  await pool.query("UPDATE photos SET caption='Updated synthetic caption' WHERE id=$1", [c]);
  assert.deepEqual((await pool.query("SELECT snapshot FROM editions ORDER BY day LIMIT 1")).rows[0].snapshot, beforeSnapshot);
  await pool.query("UPDATE deliveries SET status='unknown' WHERE edition_id IN (SELECT id FROM editions WHERE photo_id=$1)", [b]);
  await pool.query("UPDATE deliveries SET status='failed' WHERE edition_id IN (SELECT id FROM editions WHERE photo_id=$1)", [a]);
  const reserved = randomUUID();
  await pool.query("INSERT INTO editions(id,day,photo_id,title,send_at) VALUES($1,current_date+1,$2,'Future reservation',now()+interval '1 day')", [reserved, c]);
  assert.deepEqual(await queue(), [fresh], "Failed, unknown and future-reserved photos stay out of automatic repeats");
  assert.equal((await request("queue/pin", { id: b, pinned: true })).status, 409);
  assert.equal((await request("queue/pin", { id: c, pinned: true })).status, 409);
  assert.equal((await pool.query(OPERATOR_COUNTS_SQL)).rows[0].ready, 1);
  await pool.query("UPDATE editions SET status='cancelled' WHERE id=$1", [reserved]);
  assert.deepEqual(await queue(), [fresh, c], "Cancelling reservation restores eligibility");
  await pool.query("UPDATE settings SET paused=true,queue_loop=false");
  console.log("Queue controls passed: admin-only pin/unpin, one-shot latest pin, real round-robin ticks with retained history, one/day concurrency, unseen-first, mode toggle, shared filters/counts/monitoring, failed/unknown/future safety and unchanged settings.");
} finally {
  globalThis.fetch = originalFetch;
  await pool.end();
  for (const file of await readdir(media)) await unlink(path.join(media, file));
  await rmdir(media);
}
