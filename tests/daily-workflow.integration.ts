import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/[...path]/route";
import { pool } from "../src/lib/db";
import { tick } from "../src/lib/worker";
import { localDay } from "../src/lib/domain";
import { renderPhotoCard, xmlEscape, wrapCardText } from "../src/lib/photo-card";
import { READY_PHOTO_SQL } from "../src/lib/photo-queue";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Daily workflow tests require the isolated loopback database");
}
const dir = await mkdtemp(path.join(tmpdir(), "our-days-daily-"));
Object.assign(process.env, {
  MEDIA_ROOT: dir, PUSH_CHANNEL: "wecom", PUSH_ENABLED: "true",
  WECOM_CORP_ID: "wwSynthetic", WECOM_APP_SECRET: "synthetic-secret",
  WECOM_AGENT_ID: "100001", WECOM_USER_ID: "operator|partner",
});
const p1 = randomUUID(), p2 = randomUUID(), p3 = randomUUID();
let sends = 0;
let partial = false;
const originalFetch = globalThis.fetch;
try {
  await pool.query("TRUNCATE photos,editions,deliveries,favorites,imports,worker_state CASCADE");
  await pool.query("UPDATE settings SET paused=true,timezone='UTC',send_time='00:00',enabled_at=now()-interval '1 day',weather_lat=NULL,weather_lon=NULL,almanac=false,star_note=''");
  await pool.query(`INSERT INTO photos(id,sha256,original_ext,original_bytes,caption,approved,created_at) VALUES
    ($1::uuid,$1::text,'jpg',1,'Approved first <memory>',true,now()-interval '3 days'),
    ($2::uuid,$2::text,'jpg',1,'Approved second',true,now()-interval '2 days'),
    ($3::uuid,$3::text,'jpg',1,'Not reviewed',false,now()-interval '4 days')`, [p1, p2, p3]);
  const image = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#73846a" } }).webp().toBuffer();
  await writeFile(path.join(dir, `${p1}.display.webp`), image);
  await writeFile(path.join(dir, `${p2}.display.webp`), image);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "qyapi.weixin.qq.com", "No personal content may be sent elsewhere");
    if (url.pathname.endsWith("/gettoken")) return Response.json({ errcode: 0, access_token: "fake" });
    if (url.pathname.endsWith("/agent/get")) return Response.json({ errcode: 0, agentid: 100001, close: 0 });
    if (url.pathname.endsWith("/user/get")) return Response.json({ errcode: 0, userid: url.searchParams.get("userid"), status: 1 });
    if (url.pathname.endsWith("/media/upload")) {
      assert.ok(init?.body instanceof FormData);
      const file = init.body.get("media");
      assert.ok(file instanceof Blob);
      assert.equal(file.type, "image/jpeg");
      assert.ok(file.size < 2 * 1024 * 1024);
      return Response.json({ errcode: 0, media_id: "fake-card" });
    }
    assert.equal(url.pathname, "/cgi-bin/message/send");
    const data = JSON.parse(String(init?.body));
    assert.equal(data.touser, "operator|partner");
    assert.equal(data.msgtype, "image");
    assert.equal(data.enable_duplicate_check, 1);
    sends++;
    return Response.json({ errcode: 0, msgid: "fake-daily-message", invaliduser: partial ? "partner" : "" });
  };
  await tick();
  assert.equal((await pool.query("SELECT id FROM editions")).rowCount, 0);
  await pool.query("UPDATE settings SET paused=false,enabled_at=now()");
  await tick();
  assert.equal((await pool.query("SELECT id FROM editions")).rowCount, 0, "Enabling after today's time must wait until tomorrow");
  await pool.query("UPDATE settings SET enabled_at=now()-interval '1 day'");
  await Promise.all([tick(), tick()]);
  const [edition] = (await pool.query("SELECT * FROM editions")).rows;
  assert.equal(edition.photo_id, p1);
  assert.equal(edition.status, "published");
  assert.equal(edition.snapshot.caption, "Approved first <memory>");
  const [delivery] = (await pool.query("SELECT * FROM deliveries")).rows;
  assert.equal(delivery.channel, "wecom");
  assert.equal(delivery.status, "accepted");
  assert.equal(delivery.attempts, 1);
  assert.deepEqual(delivery.recipient_results, [{ userId: "operator", status: "accepted" }, { userId: "partner", status: "accepted" }]);
  assert.equal(sends, 1);
  await tick(); assert.equal(sends, 1);
  assert.equal((await pool.query(READY_PHOTO_SQL)).rows[0].id, p2);
  assert.equal(xmlEscape('<x & "hi">'), "&lt;x &amp; &quot;hi&quot;&gt;");
  assert.equal(wrapCardText("一二三四", 2).join("|"), "一二|三四");
  const card = await renderPhotoCard(edition.snapshot, localDay(new Date(), "UTC"), image);
  assert.equal((await sharp(card).metadata()).format, "jpeg");
  await assert.rejects(renderPhotoCard({ ...edition.snapshot, caption: "很".repeat(3000) }, "2026-10-19", image), /文案过长/);
  await pool.query("UPDATE deliveries SET status='unknown'");
  await tick(); assert.equal(sends, 1, "Unknown result must not be retried");
  await pool.query("UPDATE editions SET day=day-1,send_at=send_at-interval '1 day'");
  await pool.query(`INSERT INTO editions(id,day,photo_id,title,send_at)
    VALUES($1,current_date+1,$2,'Reserved future photo',now()+interval '1 day')`, [randomUUID(), p2]);
  await assert.rejects(tick(), /待发送照片用完/);
  assert.equal(sends, 1);
  await pool.query("DELETE FROM editions WHERE status='scheduled'");
  partial = true;
  await tick();
  const secondDelivery = (await pool.query("SELECT d.* FROM deliveries d JOIN editions e ON d.edition_id=e.id WHERE e.photo_id=$1", [p2])).rows[0];
  assert.equal(secondDelivery.status, "unknown", "Partial acceptance must not be retryable as a whole");
  assert.deepEqual(secondDelivery.recipient_results, [{ userId: "operator", status: "accepted" }, { userId: "partner", status: "failed" }]);
  assert.equal(sends, 2);
  await tick(); assert.equal(sends, 2, "Partial acceptance must not resend to the already accepted member");
  const token = "d".repeat(64);
  process.env.PUBLIC_URL = "https://example.com/our-days";
  await pool.query("INSERT INTO sessions VALUES($1,'admin',now()+interval '1 hour') ON CONFLICT DO NOTHING",
    [createHash("sha256").update(token).digest("hex")]);
  const retry = await POST(new NextRequest("https://example.com/our-days/api/delivery/retry", {
    method: "POST",
    headers: { Origin: "https://example.com", Cookie: `our_days_session=${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: secondDelivery.id, confirm: true }),
  }), { params: Promise.resolve({ path: ["delivery", "retry"] }) });
  assert.equal(retry.status, 409, "Admin retry API must reject partially accepted group messages");
  console.log("Daily workflow passed: pause, next scheduled time, FIFO approved-only selection, one card/day, actual rendering, mocked WeCom dispatch, no repeats, future reservations and empty-stock errors.");
} finally {
  globalThis.fetch = originalFetch;
  await pool.end();
  for (const file of await readdir(dir)) await unlink(path.join(dir, file));
  await rmdir(dir);
}
