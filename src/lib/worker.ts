import { randomUUID } from "node:crypto";
import { pool, query, transaction } from "./db";
import { AppError, localDay, type Photo, type Settings, type Snapshot } from "./domain";
import { buildSnapshot } from "./content";
import { processImport } from "./media";
import { deliveryStatus, sendNotice } from "./push";
import { sendWechatNotice, wechatReady } from "./wechat";
import { READY_PHOTO_SQL } from "./photo-queue";
import { sendPhotoCard } from "./photo-card";
import { processSpecialSends } from "./special-send";

export async function tick() {
  const lock = await pool.connect();
  const acquired = (await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(7316,1) AS locked")).rows[0].locked;
  if (!acquired) { lock.release(); return; }
  try {
    await processSpecialSends();
    await processImport();
    await query("DELETE FROM sessions WHERE expires_at<now()");
    await query(
      `UPDATE deliveries d SET status=r.status,error_code=CASE WHEN r.status='failed' THEN 'wechat_delivery_failed' ELSE NULL END,updated_at=now()
       FROM wechat_receipts r WHERE d.channel='wechat-test' AND d.record_id=r.record_id AND d.status IN ('accepted','unknown')`);
    await query("DELETE FROM wechat_receipts WHERE received_at<now()-interval '30 days'");
    // A process exit between dispatch and persistence is never safe to automatically retry.
    await query("UPDATE deliveries SET status='unknown',error_code='interrupted',updated_at=now() WHERE status='sending'");
    const [settings] = await query<Settings>("SELECT * FROM settings WHERE id=true");
    if (!settings.paused) {
      const today = localDay(new Date(), settings.timezone);
      if ((process.env.PUSH_CHANNEL ?? "wechat-test") === "wecom") {
        await transaction(async client => {
          const [timing] = (await client.query<{ due: boolean }>(
            `SELECT now()>=($1::date+send_time::time) AT TIME ZONE timezone
              AND (enabled_at IS NULL OR enabled_at<=($1::date+send_time::time) AT TIME ZONE timezone) AS due
             FROM settings WHERE id=true FOR SHARE`, [today])).rows;
          if (!timing.due || (await client.query("SELECT id FROM editions WHERE day=$1::date", [today])).rowCount) return;
          const [next] = (await client.query<Photo>(`${READY_PHOTO_SQL} FOR UPDATE OF p SKIP LOCKED`)).rows;
          if (!next) throw new AppError(409, "photo_queue_empty", "已审核的待发送照片用完了，请补充素材");
          const inserted = await client.query(
            `INSERT INTO editions(id,day,photo_id,title,send_at,notify)
             SELECT $1,$2::date,$3,'今天的照片',($2::date+send_time::time) AT TIME ZONE timezone,true
             FROM settings WHERE id=true ON CONFLICT(day) DO NOTHING RETURNING id`,
            [randomUUID(), today, next.id]);
          if (inserted.rowCount) await client.query("UPDATE photos SET queue_pinned_at=NULL WHERE id=$1", [next.id]);
        });
      }
      const due = await query<{ id: string; day: string; photo_id: string }>(
        "SELECT id,day::text,photo_id FROM editions WHERE status='scheduled' AND send_at<=now() AND day=$1::date ORDER BY send_at", [today]);
      for (const edition of due) {
        const [photo] = await query<Photo>("SELECT * FROM photos WHERE id=$1", [edition.photo_id]);
        if (!photo.approved) throw new AppError(409, "unapproved", "到期照片尚未批准");
        const snapshot = await buildSnapshot(photo, settings, edition.day);
        await transaction(async client => {
          // Recheck approval after external weather lookup; serialize against edits.
          const current = await client.query<Photo>("SELECT * FROM photos WHERE id=$1 FOR UPDATE", [photo.id]);
          if (!current.rows[0].approved || current.rows[0].caption !== photo.caption ||
              current.rows[0].date_label !== photo.date_label || current.rows[0].place_label !== photo.place_label) {
            throw new AppError(409, "changed_photo", "照片内容已修改，请等待下一轮");
          }
          const published = await client.query<{ notify: boolean }>(
            "UPDATE editions SET status='published',snapshot=$2::jsonb,published_at=now() WHERE id=$1 AND status='scheduled' RETURNING notify",
            [edition.id, JSON.stringify(snapshot)]);
          const channel = process.env.PUSH_CHANNEL ?? "wechat-test";
          if (!["wechat-test", "pushplus", "wecom"].includes(channel)) throw new AppError(503, "push_channel", "通知渠道配置无效");
          if (published.rowCount) await client.query("INSERT INTO deliveries(id,edition_id,status,channel) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [randomUUID(), edition.id, published.rows[0].notify && process.env.PUSH_ENABLED === "true" ? "pending" : "disabled", channel]);
        });
      }
      const pending = await query<{ id: string; edition_id: string; channel: string; day: string; snapshot: Snapshot }>(
        `SELECT d.id,d.edition_id,d.channel,e.day::text,e.snapshot FROM deliveries d JOIN editions e ON e.id=d.edition_id
         WHERE d.status='pending' AND e.day=$1::date ORDER BY e.send_at LIMIT 1`, [today]);
      for (const delivery of pending) {
        if (process.env.PUSH_ENABLED !== "true") continue;
        if (delivery.channel === "wecom" ? !(process.env.WECOM_CORP_ID && process.env.WECOM_APP_SECRET && process.env.WECOM_AGENT_ID && process.env.WECOM_USER_ID) :
            delivery.channel === "wechat-test" ? !wechatReady() :
            (!process.env.PUSHPLUS_TOKEN || !process.env.PUSHPLUS_TO || !process.env.PUSHPLUS_SECRET_KEY)) {
          throw new AppError(503, "push_config", "推送及状态查询配置不完整");
        }
        await query("UPDATE deliveries SET status='sending',attempts=attempts+1,updated_at=now() WHERE id=$1", [delivery.id]);
        const result = delivery.channel === "wecom" ? await sendPhotoCard(delivery.snapshot, delivery.day) : delivery.channel === "wechat-test"
          ? await sendWechatNotice(delivery.edition_id, delivery.day)
          : await sendNotice(delivery.edition_id);
        await query("UPDATE deliveries SET status=$2,record_id=$3,error_code=$4,recipient_results=$5::jsonb,updated_at=now() WHERE id=$1",
          [delivery.id, result.status, result.recordId ?? null, result.errorCode ?? null,
            result.recipients ? JSON.stringify(result.recipients) : null]);
      }
    }
    const accepted = await query<{ id: string; record_id: string }>(
      "SELECT id,record_id FROM deliveries WHERE channel='pushplus' AND status='accepted' AND updated_at<now()-interval '30 seconds' ORDER BY updated_at LIMIT 3");
    for (const delivery of accepted) {
      const status = await deliveryStatus(delivery.record_id);
      await query("UPDATE deliveries SET status=$2,updated_at=now(),error_code=$3 WHERE id=$1",
        [delivery.id, status, status === "failed" ? "provider_failed" : null]);
    }
    await query("INSERT INTO worker_state(id,last_tick,error_code) VALUES(true,now(),NULL) ON CONFLICT(id) DO UPDATE SET last_tick=now(),error_code=NULL");
  } catch (error) {
    const code = error instanceof AppError ? error.code : "worker_failure";
    await query("INSERT INTO worker_state(id,error_code) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET error_code=$1", [code]);
    throw error;
  } finally {
    await lock.query("SELECT pg_advisory_unlock(7316,1)");
    lock.release();
  }
}
