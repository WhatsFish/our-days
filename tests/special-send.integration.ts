import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { pool } from "../src/lib/db";
import { uploadSpecialMaterial, specialMediaPath } from "../src/lib/special-media";
import { scheduleSpecialSend } from "../src/lib/special-send";
import { tick } from "../src/lib/worker";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Special scheduling tests require the isolated database");
}
const root = await mkdtemp(path.join(tmpdir(), "our-days-special-send-"));
Object.assign(process.env, {
  MEDIA_ROOT: root, MEDIA_QUOTA_MB: "5", PUSH_ENABLED: "true", PUSH_CHANNEL: "wecom",
  WECOM_CORP_ID: "wwSynthetic", WECOM_APP_SECRET: "synthetic-secret",
  WECOM_AGENT_ID: "100001", WECOM_USER_ID: "operator|partner",
});
const originalFetch = globalThis.fetch;
let sends = 0, uploads = 0, mode = "ok";
const original = await sharp({ create: { width: 320, height: 480, channels: 3, background: "#aabbcc" } }).png().toBuffer();
try {
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query("TRUNCATE special_sends,special_materials,photos,editions,deliveries,favorites,imports,worker_state CASCADE");
  await pool.query("UPDATE settings SET paused=true,timezone='UTC',send_time='00:00',enabled_at=now()-interval '1 day',weather_lat=NULL,weather_lon=NULL,almanac=false,star_note=''");
  const settings = (await pool.query("SELECT * FROM settings")).rows[0];
  const material = await uploadSpecialMaterial(original, "Synthetic birthday");
  const at = new Date(Date.now() + 60000).toISOString();
  const scheduled = await scheduleSpecialSend(material.id, at);
  const duplicate = await scheduleSpecialSend(material.id, at);
  assert.equal(scheduled.id, duplicate.id, "Same material/time cannot create duplicate tasks");
  await assert.rejects(scheduleSpecialSend(material.id, "2020-01-01T00:00:00Z"), /必须在未来/);
  await assert.rejects(scheduleSpecialSend(randomUUID(), at), /不存在/);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "qyapi.weixin.qq.com");
    if (url.pathname.endsWith("/gettoken")) return Response.json({ errcode: 0, access_token: "synthetic" });
    if (url.pathname.endsWith("/agent/get")) return Response.json({ errcode: 0, agentid: 100001, close: 0 });
    if (url.pathname.endsWith("/user/get")) return Response.json({ errcode: 0, userid: url.searchParams.get("userid"), status: 1 });
    if (url.pathname.endsWith("/media/upload")) {
      uploads++;
      assert.ok(init?.body instanceof FormData);
      const file = init.body.get("media");
      assert.ok(file instanceof Blob);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), original, "Finished artwork must be uploaded without borders, text or re-encoding");
      return Response.json({ errcode: 0, media_id: "original-artwork" });
    }
    assert.equal(url.pathname, "/cgi-bin/message/send");
    sends++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.touser, "operator|partner", "Frozen recipients must not change with later environment edits");
    assert.equal(body.image.media_id, "original-artwork");
    if (mode === "timeout") throw new Error("synthetic timeout");
    return Response.json({ errcode: 0, msgid: `special-${sends}`, invaliduser: mode === "partial" ? "partner" : "" });
  };
  await tick(); assert.equal(sends, 0, "No early submission");
  process.env.WECOM_USER_ID = "operator";
  await pool.query("UPDATE special_sends SET send_at=now()-interval '2 seconds' WHERE id=$1", [scheduled.id]);
  await Promise.all([tick(), tick()]);
  assert.equal(sends, 1); assert.equal(uploads, 1);
  const accepted = (await pool.query("SELECT * FROM special_sends WHERE id=$1", [scheduled.id])).rows[0];
  assert.equal(accepted.status, "accepted"); assert.equal(accepted.attempts, 1);
  assert.equal(accepted.recipient_results.length, 2);
  await tick(); assert.equal(sends, 1, "Accepted job cannot send again");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM editions")).rows[0].n, 0, "Special send cannot occupy daily edition");
  assert.deepEqual((await pool.query("SELECT * FROM settings")).rows[0], settings);
  process.env.WECOM_USER_ID = "operator|partner";
  for (const [index, scenario] of ["partial", "timeout", "changed", "missed", "interrupted"].entries()) {
    const job = await scheduleSpecialSend(material.id, new Date(Date.now() + (120 + index) * 1000).toISOString());
    await pool.query("UPDATE special_sends SET send_at=now()-$2::int*interval '1 second' WHERE id=$1", [job.id, scenario === "missed" ? 1200 : 2]);
    mode = scenario;
    if (scenario === "changed") await writeFile(specialMediaPath(material.id, "original.png"), Buffer.from("changed"));
    if (scenario === "interrupted") await pool.query("UPDATE special_sends SET status='sending' WHERE id=$1", [job.id]);
    const beforeSends: number = sends;
    await tick();
    const row = (await pool.query("SELECT * FROM special_sends WHERE id=$1", [job.id])).rows[0];
    assert.equal(row.status, ["partial", "timeout", "interrupted"].includes(scenario) ? "unknown" : "failed");
    assert.equal(sends, beforeSends + (["partial", "timeout"].includes(scenario) ? 1 : 0));
    await tick(); assert.equal(sends, beforeSends + (["partial", "timeout"].includes(scenario) ? 1 : 0));
    if (scenario === "changed") await writeFile(specialMediaPath(material.id, "original.png"), original);
  }
  assert.ok((await pool.query("SELECT delivery_attention FROM service_health")).rows[0].delivery_attention >= 5);
  console.log("Special sends passed: persistent future task, no early send, exact original image, frozen dual recipients, concurrent exactly-once claim, dedup scheduling, independent daily history/settings, partial/timeout/interruption protection, missed-window and changed-file rejection.");
} finally {
  globalThis.fetch = originalFetch;
  await pool.end();
  for (const file of await readdir(path.join(root, "special"))) await unlink(path.join(root, "special", file));
  await rmdir(path.join(root, "special")); await rmdir(root);
}
