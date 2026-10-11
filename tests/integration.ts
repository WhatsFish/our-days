import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { pool, query } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { tick } from "../src/lib/worker";
import { zipFixture } from "./fixtures";

if (process.env.PG_DB !== "our_days_test" || process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326") {
  throw new Error("Integration tests require the dedicated local our_days_test database on port 54326");
}
const media = await mkdtemp(path.join(tmpdir(), "our-days-synthetic-"));
const origin = "http://127.0.0.1:3316";
const base = `${origin}/our-days`;
Object.assign(process.env, {
  MEDIA_ROOT: media, MEDIA_QUOTA_MB: "5", PUBLIC_URL: base,
  ADMIN_PASSWORD_HASH: hashPassword("synthetic-admin-code"),
  READER_PASSWORD_HASH: hashPassword("synthetic-reader-code"),
  PUSH_ENABLED: "false", PUSH_CHANNEL: "wechat-test", AI_ENABLED: "false",
  WECHAT_VERIFY_TOKEN: "synthetic-verification", WECHAT_OPEN_ID: "synthetic-recipient",
});
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", "3316"], {
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", chunk => { output = (output + chunk).slice(-10000); });
server.stderr.on("data", chunk => { output = (output + chunk).slice(-10000); });
async function request(route: string, cookie = "", data?: unknown) {
  return fetch(`${base}/api/${route}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { cookie, origin, ...(data instanceof FormData ? {} : { "Content-Type": "application/json" }) },
    body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
  });
}
async function signIn(role: string, password: string) {
  const r = await request("login", "", { role, password });
  assert.equal(r.status, 200, await r.text());
  assert.match(r.headers.get("set-cookie")!, /HttpOnly/i);
  return r.headers.get("set-cookie")!.split(";")[0];
}
function callbackURL() {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = "synthetic";
  const signature = createHash("sha1").update([process.env.WECHAT_VERIFY_TOKEN!, timestamp, nonce].sort().join("")).digest("hex");
  return `${base}/api/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}`;
}
try {
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query("TRUNCATE sessions,login_limits,photos,imports,settings,editions,deliveries,favorites,worker_state,ai_events,wechat_receipts CASCADE");
  await pool.query("INSERT INTO settings(id) VALUES(true)");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* Server startup is bounded below. */ }
    if (ready) break;
    if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
    await delay(500);
  }
  assert.ok(ready, output);
  assert.equal((await request("admin")).status, 401);
  const admin = await signIn("admin", "synthetic-admin-code");
  const reader = await signIn("reader", "synthetic-reader-code");
  assert.equal((await request("admin", reader)).status, 403);
  assert.equal((await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie: admin } })).status, 403);
  assert.equal((await request("editions", reader)).headers.get("cache-control"), "private, no-store");
  assert.equal((await request("ai", admin, { id: randomUUID(), style: "温柔", consent: true })).status, 409);
  assert.equal((await fetch(`${callbackURL()}&echostr=sample`)).status, 200);
  assert.equal((await fetch(`${base}/api/wechat/callback?echostr=sample`)).status, 403);

  const image = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#8a9d80" } })
    .withExif({ IFD0: { Artist: "SYNTHETIC ONLY" }, IFD2: { DateTimeOriginal: "2020:01:02 12:34:56" } }).jpeg().toBuffer();
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "synthetic.jpg");
  assert.equal((await request("upload", reader, form)).status, 403);
  assert.equal((await request("upload", admin, form)).status, 202);
  await tick();
  let photos = await query<{ id: string; captured_raw: string; approved: boolean }>("SELECT id,captured_raw,approved FROM photos");
  assert.equal(photos.length, 1);
  assert.ok(photos[0].captured_raw.includes("2020"));
  assert.equal(photos[0].approved, false);
  const id = photos[0].id;
  assert.equal((await request(`media/${id}/display`, reader)).status, 404);
  assert.equal((await request(`media/${id}/display`)).status, 401);
  const display = await request(`media/${id}/display`, admin);
  assert.equal(display.status, 200);
  const metadata = await sharp(Buffer.from(await display.arrayBuffer())).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.format, "webp");

  const archive = zipFixture([{ name: "album/same.jpg", bytes: image }, { name: "notes.txt", bytes: Buffer.from("not an image") }]);
  const zipForm = new FormData(); zipForm.set("file", new Blob([new Uint8Array(archive)]), "album.zip");
  assert.equal((await request("upload", admin, zipForm)).status, 202);
  await tick();
  const zipJob = (await query<{ duplicates: number; errors: string[] }>("SELECT duplicates,errors FROM imports ORDER BY created_at DESC LIMIT 1"))[0];
  assert.equal(zipJob.duplicates, 1); assert.equal(zipJob.errors.length, 1);
  assert.equal((await query("SELECT id FROM photos")).length, 1);
  const badForm = new FormData(); badForm.set("file", new Blob([new Uint8Array(zipFixture([{ name: "../escape.jpg", bytes: image }]))]), "bad.zip");
  assert.equal((await request("upload", admin, badForm)).status, 202);
  await tick();
  assert.equal((await query<{ status: string }>("SELECT status FROM imports ORDER BY created_at DESC LIMIT 1"))[0].status, "failed");

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.equal((await request("schedule", admin, { day: tomorrow, photo_id: id, title: "Test" })).status, 409);
  assert.equal((await request("photo", admin, { id, date_label: "2020", place_label: "A city", facts: "ADMIN ONLY", caption: "A synthetic letter", approved: true })).status, 200);
  assert.equal((await request("schedule", admin, { day: tomorrow, photo_id: id, title: "Test", notify: false })).status, 200);
  assert.equal((await request("schedule", admin, { day: tomorrow, photo_id: id, title: "Replaced", notify: false })).status, 200);
  assert.equal((await query("SELECT id FROM editions")).length, 1);
  assert.equal((await request("editions", reader)).status, 200);
  assert.deepEqual(await (await request("editions", reader)).json(), []);
  assert.equal((await request("photo/delete", admin, { id })).status, 409);
  await query("UPDATE editions SET day=(now() AT TIME ZONE 'Asia/Shanghai')::date,send_at=now()-interval '1 minute'");
  await tick();
  assert.deepEqual(await (await request("editions", reader)).json(), []);
  await query("UPDATE settings SET paused=false,almanac=true");
  await Promise.all([tick(), tick()]);
  await tick();
  const letters = await (await request("editions", reader)).json();
  assert.equal(letters.length, 1);
  assert.equal(letters[0].title, "Replaced");
  assert.equal(letters[0].snapshot.caption, "A synthetic letter");
  assert.equal(JSON.stringify(letters).includes("ADMIN ONLY"), false);
  assert.equal((await request(`media/${id}/display`, reader)).status, 200);
  assert.equal((await query("SELECT id FROM deliveries")).length, 1);
  assert.equal((await query<{ status: string }>("SELECT status FROM deliveries"))[0].status, "disabled");
  assert.equal((await request("favorite", reader, { id: letters[0].id, favorite: true })).status, 200);
  assert.equal((await (await request("editions", reader)).json())[0].favorite, true);
  assert.equal((await request("photo", admin, { id, date_label: "2030", place_label: "", facts: "", caption: "New caption", approved: true })).status, 200);
  assert.equal((await (await request("editions", reader)).json())[0].snapshot.caption, "A synthetic letter");
  const delivery = (await query<{ id: string }>("SELECT id FROM deliveries"))[0];
  await query("UPDATE deliveries SET status='accepted',record_id='18446744073709551615'");
  const receipt = "<xml><FromUserName>synthetic-recipient</FromUserName><MsgType>event</MsgType><Event>TEMPLATESENDJOBFINISH</Event><MsgID>18446744073709551615</MsgID><Status>success</Status></xml>";
  assert.equal((await fetch(callbackURL(), { method: "POST", body: receipt })).status, 200);
  assert.equal((await query<{ status: string }>("SELECT status FROM deliveries"))[0].status, "delivered");
  const earlyReceipt = receipt.replace("18446744073709551615", "18446744073709551614");
  assert.equal((await fetch(callbackURL(), { method: "POST", body: earlyReceipt })).status, 200);
  await query("UPDATE deliveries SET status='accepted',record_id='18446744073709551614'");
  await tick();
  assert.equal((await query<{ status: string }>("SELECT status FROM deliveries"))[0].status, "delivered");
  await query("UPDATE deliveries SET status='sending',record_id=NULL");
  await tick();
  assert.equal((await query<{ status: string }>("SELECT status FROM deliveries"))[0].status, "unknown");
  assert.equal((await request("delivery/retry", admin, { id: delivery.id, confirm: true })).status, 409);
  assert.equal((await request("logout", reader, {})).status, 200);
  assert.equal((await request(`media/${id}/display`, reader)).status, 401);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("x-robots-tag")!, /noindex/);
  assert.equal((await page.text()).includes("A synthetic letter"), false);
  console.log("Integration passed: auth/CSRF, private media, EXIF stripping, ZIP safety, dedup, approval, scheduling, pause, concurrent ticks, immutable letters, favorites, callback, unknown delivery and logout.");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  server.kill("SIGTERM");
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", () => resolve()); });
  await pool.end();
  for (const file of await readdir(media)) await unlink(path.join(media, file));
  await rmdir(media);
}
