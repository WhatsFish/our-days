import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/[...path]/route";
import { pool } from "../src/lib/db";
import { storageBytes } from "../src/lib/media";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Special-material tests require the isolated loopback database");
}
const root = await mkdtemp(path.join(tmpdir(), "our-days-special-"));
Object.assign(process.env, { MEDIA_ROOT: root, MEDIA_QUOTA_MB: "5", PUBLIC_URL: "https://example.com/our-days" });
const admin = "f".repeat(64), reader = "e".repeat(64);
const context = (route: string) => ({ params: Promise.resolve({ path: route.split("?")[0].split("/") }) });
async function get(route: string, token = admin) {
  return GET(new NextRequest(`https://example.com/our-days/api/${route}`, {
    headers: { Cookie: `our_days_session=${token}` },
  }), context(route));
}
async function upload(image: Buffer, token = admin, title = "Birthday finished artwork", origin = "https://example.com") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(image)], "finished.png", { type: "image/png" }));
  form.set("title", title);
  return POST(new NextRequest("https://example.com/our-days/api/special/upload", {
    method: "POST", headers: { Origin: origin, Cookie: `our_days_session=${token}` }, body: form,
  }), context("special/upload"));
}
const fingerprint = async () => (await pool.query(`SELECT
  (SELECT count(*)::int FROM photos) AS photos,
  (SELECT count(*)::int FROM editions) AS editions,
  (SELECT count(*)::int FROM deliveries) AS deliveries,
  (SELECT to_jsonb(s) FROM settings s WHERE id=true) AS settings`)).rows[0];
try {
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query("TRUNCATE special_sends,special_materials");
  for (const [token, role] of [[admin, "admin"], [reader, "reader"]]) {
    await pool.query("INSERT INTO sessions VALUES($1,$2,now()+interval '1 hour') ON CONFLICT DO NOTHING",
      [createHash("sha256").update(token).digest("hex"), role]);
  }
  const before = await fingerprint();
  const original = await sharp({ create: { width: 320, height: 480, channels: 3, background: "#98b8aa" } })
    .png().withMetadata({ exif: { IFD0: { Artist: "Private original metadata" } } }).toBuffer();
  assert.equal((await get("special", reader)).status, 403);
  assert.equal((await get("special", "")).status, 401);
  assert.equal((await upload(original, reader)).status, 403);
  assert.equal((await upload(original, admin, "Title", "https://other.example")).status, 403);
  assert.equal((await get("special?page=0")).status, 400);
  const saved = await upload(original);
  assert.equal(saved.status, 201);
  const result = await saved.json();
  assert.equal(result.duplicate, false);
  assert.equal((await upload(original)).status, 201);
  const duplicate = await (await upload(original)).json();
  assert.equal(duplicate.id, result.id); assert.equal(duplicate.duplicate, true);
  const list = await (await get("special")).json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].title, "Birthday finished artwork");
  assert.equal(list.items[0].width, 320); assert.equal(list.items[0].height, 480);
  const originalResponse = await get(`special/${result.id}/original`);
  assert.equal(originalResponse.status, 200);
  assert.match(originalResponse.headers.get("content-disposition")!, /^attachment;/);
  assert.deepEqual(Buffer.from(await originalResponse.arrayBuffer()), original, "Finished original must be preserved byte for byte");
  const preview = await get(`special/${result.id}/preview`);
  assert.equal(preview.status, 200);
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  const metadata = await sharp(previewBytes).metadata();
  assert.equal(metadata.width, 320); assert.equal(metadata.height, 480);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.format, "jpeg");
  assert.equal((await get(`special/${result.id}/preview`, reader)).status, 403);
  assert.equal((await get(`special/${randomUUID()}/original`)).status, 404);
  assert.equal((await get("special/invalid/preview")).status, 400);
  assert.equal((await get(`special/${result.id}/anything`)).status, 400);
  assert.equal(await storageBytes(), original.length + previewBytes.length, "Private special files must count against the shared quota");
  const expectedFiles = (await readdir(path.join(root, "special"))).sort();
  assert.equal((await upload(Buffer.from("not an image"))).status, 400);
  const animation = await sharp({ create: { width: 10, height: 20, channels: 3, background: "#aabbcc" } }).gif().toBuffer();
  assert.equal((await upload(animation)).status, 400);
  process.env.MEDIA_QUOTA_MB = "0.001";
  const another = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#aabbdd" } }).png().toBuffer();
  assert.equal((await upload(another)).status, 507, "Special uploads share storage quota with normal material");
  assert.deepEqual((await readdir(path.join(root, "special"))).sort(), expectedFiles);
  assert.deepEqual(await fingerprint(), before, "Special uploads must not change the normal queue, schedule, captions or delivery history");
  console.log("Special materials passed: admin-only upload/list/preview/original, same-origin, original preservation, stripped preview, dedup, image validation, shared quota, and untouched daily records.");
} finally {
  await pool.query("TRUNCATE special_sends,special_materials");
  await pool.end();
  const special = path.join(root, "special");
  for (const file of await readdir(special)) await unlink(path.join(special, file));
  await rmdir(special); await rmdir(root);
}
