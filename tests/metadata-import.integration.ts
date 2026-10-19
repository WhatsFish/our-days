import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ExifTool } from "exiftool-vendored";
import { pool } from "../src/lib/db";
import { importPhoto } from "../src/lib/media";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Metadata tests require isolated database");
}
const temp = await mkdtemp(path.join(tmpdir(), "our-days-exif-test-"));
process.env.MEDIA_ROOT = temp;
process.env.MEDIA_QUOTA_MB = "5";
const tool = new ExifTool({ maxProcs: 1 });
let sha: string | undefined;
try {
  const source = path.join(temp, "fixture.jpg");
  await writeFile(source, await sharp({ create: { width: 20, height: 20, channels: 3, background: "#789078" } }).jpeg().toBuffer());
  await tool.write(source, { DateTimeOriginal: "2020:01:02 23:45:12", City: "Kyoto", Country: "Japan", Artist: randomUUID() });
  const image = await readFile(source);
  sha = createHash("sha256").update(image).digest("hex");
  assert.equal(await importPhoto(image, tool), "added");
  const row = (await pool.query("SELECT id,date_label,place_label,metadata_place,approved FROM photos WHERE sha256=$1", [sha])).rows[0];
  assert.equal(row.date_label, "2020年1月2日 23:45");
  assert.equal(row.place_label, "Japan · Kyoto");
  assert.equal(row.metadata_place, "Japan · Kyoto");
  assert.equal(row.approved, false);
  await pool.query("UPDATE photos SET date_label='Manual date',place_label='Manual place' WHERE id=$1", [row.id]);
  assert.equal(await importPhoto(image, tool), "duplicate");
  const edited = (await pool.query("SELECT date_label,place_label FROM photos WHERE id=$1", [row.id])).rows[0];
  assert.equal(edited.date_label, "Manual date");
  assert.equal(edited.place_label, "Manual place");
  console.log("Metadata import passed: real EXIF/IPTC date+place prefilled; no approval; duplicate upload preserves manual edits.");
} finally {
  if (sha) await pool.query("DELETE FROM photos WHERE sha256=$1", [sha]);
  await tool.end(); await pool.end();
  for (const file of await readdir(temp)) await unlink(path.join(temp, file));
  await rmdir(temp);
}
