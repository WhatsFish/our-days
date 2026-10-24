import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { pool } from "../src/lib/db";
import { buildSnapshot } from "../src/lib/content";
import { localDay, type Photo, type Settings } from "../src/lib/domain";
import { renderPhotoCard } from "../src/lib/photo-card";
import { READY_PHOTOS_BASE_SQL } from "../src/lib/photo-queue";
import { sendWecomImage, WecomSendError, type WecomRecipientResult } from "../src/lib/wecom-image.mjs";

const one = process.argv.includes("--send-one");
const count = one ? 1 : 2;
const send = one || process.argv.includes("--send-two");
if (process.argv.includes("--require-weather")) throw new Error("Weather is hidden on photo cards; remove --require-weather. No messages submitted.");
if ((process.argv.includes("--check") && send) || (one && process.argv.includes("--send-two"))) {
  throw new Error("Choose --check, --send-one or --send-two");
}
const stateFile = process.env.E2E_STATE_FILE;
const label = process.env.E2E_LABEL ?? "E2E";
if (!/^[\p{L}\p{N} ._-]{1,24}$/u.test(label)) throw new Error("Invalid E2E display label");
if (send && (!stateFile || !path.isAbsolute(stateFile))) throw new Error("Provide a new private E2E_STATE_FILE; existing runs cannot be repeated");
if (process.env.PUSH_CHANNEL !== "wecom") throw new Error("Expected the configured WeCom channel");
const client = await pool.connect();
let locked = false;
type Item = { photo_id: string; number: number; sha256: string; width: number; height: number; bytes: number; status: string; record_id?: string; error_code?: string; submitted_at?: string; recipients?: WecomRecipientResult[] };
const state: { type: string; label: string; created_at: string; changes_daily_queue: boolean; items: Item[] } = {
  type: "manual_material_e2e", label, created_at: new Date().toISOString(), changes_daily_queue: false, items: [],
};
async function save() { if (send) await writeFile(stateFile!, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); }
try {
  locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(7316,1) AS locked")).rows[0].locked;
  if (!locked) throw new Error("Worker is busy; no E2E messages submitted");
  const [settings] = (await client.query<Settings>("SELECT * FROM settings WHERE id=true")).rows;
  const photos = (await client.query<Photo>(`${READY_PHOTOS_BASE_SQL} LIMIT $1`, [count])).rows;
  if (photos.length !== count) throw new Error(`Need ${count} available approved photos; no messages submitted`);
  const cards: Buffer[] = [];
  for (const [index, photo] of photos.entries()) {
    if (!photo.caption.trim()) throw new Error("Missing approved caption; no messages submitted");
    const snapshot = await buildSnapshot(photo, settings, localDay(new Date(), settings.timezone));
    const image = await renderPhotoCard(snapshot, `${localDay(new Date(), settings.timezone)} · ${label} ${index + 1}/${count}`);
    const meta = await sharp(image).metadata();
    if (meta.format !== "jpeg" || meta.width !== 1080 || !meta.height || meta.exif || image.length > 2 * 1024 * 1024) {
      throw new Error("Rendered card failed validation; no messages submitted");
    }
    cards.push(image);
    state.items.push({ photo_id: photo.id, number: index + 1, sha256: createHash("sha256").update(image).digest("hex"),
      width: meta.width, height: meta.height, bytes: image.length, status: "prepared" });
    console.log(`Prepared E2E ${index + 1}/${count}: ${meta.width}x${meta.height}, ${image.length} bytes, no EXIF on output`);
  }
  if (send) {
    await writeFile(stateFile!, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    for (let index = 0; index < cards.length; index++) {
      const current = (await client.query<Photo>("SELECT * FROM photos WHERE id=$1", [photos[index].id])).rows[0];
      if (!current?.approved || current.caption !== photos[index].caption ||
          current.date_label !== photos[index].date_label || current.place_label !== photos[index].place_label) {
        state.items[index].status = "cancelled_material_changed"; await save();
        throw new Error("Material changed while preparing; remaining sends cancelled");
      }
      state.items[index].status = "submitting";
      state.items[index].submitted_at = new Date().toISOString();
      await save();
      try {
        const result = await sendWecomImage(cards[index], {
          corpId: process.env.WECOM_CORP_ID, secret: process.env.WECOM_APP_SECRET,
          agentId: Number(process.env.WECOM_AGENT_ID), userId: process.env.WECOM_USER_ID,
        });
        state.items[index].status = "accepted"; state.items[index].record_id = result.msgid;
        state.items[index].recipients = result.recipients;
        await save();
        console.log(`E2E ${index + 1}/${count} accepted by WeCom; actual phone receipt still unconfirmed`);
      } catch (error) {
        state.items[index].status = error instanceof WecomSendError && error.unknown ? "unknown" : "failed";
        if (error instanceof WecomSendError) {
          state.items[index].recipients = error.recipients;
          state.items[index].record_id = error.recordId;
        }
        state.items[index].error_code = error instanceof WecomSendError && error.unknown ? "submission_unknown" : "provider_rejected";
        await save();
        throw new Error("Submission failed or uncertain; batch stopped with no automatic retry");
      }
    }
  }
  console.log(send ? `${count} manual E2E submission(s) completed. Daily queue and schedule unchanged; no AI calls.` :
    "Render-only validation passed. No messages sent; daily queue and schedule unchanged.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "E2E failure");
  process.exitCode = 1;
} finally {
  try { if (locked) await client.query("SELECT pg_advisory_unlock(7316,1)"); }
  finally { client.release(); await pool.end(); }
}
