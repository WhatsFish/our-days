import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { query, transaction } from "./db";
import { AppError, uuid } from "./domain";
import { specialMediaPath } from "./special-media";
import { sendWecomImage, wecomRecipients, WecomSendError } from "./wecom-image.mjs";

export async function scheduleSpecialSend(id: string, at: string) {
  uuid.parse(id);
  const date = new Date(z.string().datetime({ offset: true }).parse(at));
  if (date.getTime() <= Date.now()) throw new AppError(400, "special_past", "特殊推送时间必须在未来");
  const recipients = wecomRecipients(process.env.WECOM_USER_ID);
  if (process.env.PUSH_CHANNEL !== "wecom" || process.env.PUSH_ENABLED !== "true") {
    throw new AppError(409, "special_disabled", "企业微信推送通道尚未开启");
  }
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(7316,1)");
    const [material] = (await client.query<{ original_ext: string; sha256: string }>(
      "SELECT original_ext,sha256 FROM special_materials WHERE id=$1 FOR SHARE", [id])).rows;
    if (!material) throw new AppError(404, "not_found", "特殊素材不存在");
    const image = await readFile(specialMediaPath(id, `original.${material.original_ext}`));
    if (!["jpg", "png"].includes(material.original_ext) || image.length > 2 * 1024 * 1024) {
      throw new AppError(400, "special_image", "原样发送要求 JPEG/PNG 且不超过 2MiB；请先准备符合限制的成品图");
    }
    if (createHash("sha256").update(image).digest("hex") !== material.sha256) {
      throw new AppError(409, "special_changed", "原文件校验不一致，未安排发送");
    }
    const result = await client.query<{ id: string; send_at: Date; status: string }>(
      `INSERT INTO special_sends(id,material_id,send_at,recipients,image_sha256)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(material_id,send_at) DO NOTHING RETURNING id,send_at,status`,
      [randomUUID(), id, date, recipients, material.sha256]);
    if (result.rows[0]) return result.rows[0];
    return (await client.query<{ id: string; send_at: Date; status: string }>(
      "SELECT id,send_at,status FROM special_sends WHERE material_id=$1 AND send_at=$2", [id, date])).rows[0];
  });
}

// Called only while the worker holds its shared publication advisory lock.
export async function processSpecialSends() {
  await query("UPDATE special_sends SET status='unknown',error_code='interrupted',updated_at=now() WHERE status='sending'");
  await query(`UPDATE special_sends SET status='failed',error_code='missed_send_window',updated_at=now()
    WHERE status='scheduled' AND send_at<now()-interval '15 minutes'`);
  if (process.env.PUSH_ENABLED !== "true" || process.env.PUSH_CHANNEL !== "wecom") return;
  const due = await query<{ id: string; material_id: string; original_ext: string; image_sha256: string; recipients: string[] }>(
    `SELECT s.id,s.material_id,s.image_sha256,s.recipients,m.original_ext
     FROM special_sends s JOIN special_materials m ON m.id=s.material_id
     WHERE s.status='scheduled' AND s.send_at<=now() ORDER BY s.send_at,s.id LIMIT 1`);
  for (const item of due) {
    const claimed = await query(`UPDATE special_sends SET status='sending',attempts=attempts+1,updated_at=now()
      WHERE id=$1 AND status='scheduled' RETURNING id`, [item.id]);
    if (!claimed.length) continue;
    let submitted = false;
    try {
      const image = await readFile(specialMediaPath(item.material_id, `original.${item.original_ext}`));
      if (createHash("sha256").update(image).digest("hex") !== item.image_sha256) {
        throw new AppError(409, "special_changed", "原文件已改变，停止发送");
      }
      submitted = true;
      const result = await sendWecomImage(image, {
        corpId: process.env.WECOM_CORP_ID, secret: process.env.WECOM_APP_SECRET,
        agentId: Number(process.env.WECOM_AGENT_ID), userId: item.recipients.join("|"),
      });
      await query(`UPDATE special_sends SET status='accepted',record_id=$2,recipient_results=$3::jsonb,
        error_code=NULL,updated_at=now() WHERE id=$1`, [item.id, result.msgid, JSON.stringify(result.recipients)]);
    } catch (error) {
      const unknown = error instanceof WecomSendError ? error.unknown : submitted && !(error instanceof AppError);
      await query(`UPDATE special_sends SET status=$2,error_code=$3,record_id=$4,recipient_results=$5::jsonb,updated_at=now()
        WHERE id=$1`, [item.id, unknown ? "unknown" : "failed",
        error instanceof AppError ? error.code : unknown ? "special_submission_unknown" : "special_rejected",
        error instanceof WecomSendError ? error.recordId ?? null : null,
        error instanceof WecomSendError && error.recipients ? JSON.stringify(error.recipients) : null]);
      console.warn("[our-days] special_send_failed_or_unknown; no automatic retry");
    }
  }
}
