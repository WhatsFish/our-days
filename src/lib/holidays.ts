import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AppError, localDay } from "./domain";
import { pool, query, transaction } from "./db";
import { holidayOn, holidayPlan, HOLIDAY_HORIZON, type HolidayRules } from "./holiday-calendar";
import { generateHolidayImage } from "./holiday-images";
import { specialMediaPath } from "./special-media";
import { wecomRecipients, sendWecomImage, WecomSendError } from "./wecom-image.mjs";

type HolidaySettings = HolidayRules & { reference_id: string | null };
export type HolidayGeneration = {
  id: string; day: string; revision: number; names: string[]; feedback: string;
  status: string; material_id: string | null; error_code: string | null;
};
export type HolidayCard = {
  day: string; names: string[]; categories: string[]; status: string; error_code: string | null;
  sent_material_id: string | null; recipient_results: unknown; generation: HolidayGeneration | null;
};
export type HolidayDashboard = {
  rules: HolidayRules; referenceReady: boolean; horizon: number;
  upcoming: HolidayCard[]; history: HolidayCard[]; attention: number;
};
export const holidayRulesInput = z.object({ solar_terms: z.boolean(), chinese: z.boolean(), western: z.boolean() }).strict();
export async function holidaySettings() {
  const [settings] = await query<HolidaySettings>("SELECT * FROM holiday_settings WHERE id=true");
  if (!settings) throw new AppError(503, "holiday_settings_missing", "节日配置未初始化");
  return settings;
}

export async function saveHolidayRules(input: unknown) {
  const rules = holidayRulesInput.parse(input);
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(7316,1)");
    await client.query("UPDATE holiday_settings SET solar_terms=$1,chinese=$2,western=$3 WHERE id=true",
      [rules.solar_terms, rules.chinese, rules.western]);
  });
  return rules;
}

// The caller holds the shared publication lock, including while contacting the image provider.
export async function syncHolidayPlan(now = new Date()) {
  const settings = await holidaySettings();
  for (const event of holidayPlan(settings, now)) {
    await transaction(async client => {
      await client.query(`INSERT INTO holiday_cards(day,names,categories) VALUES($1,$2,$3)
        ON CONFLICT(day) DO UPDATE SET names=$2,categories=$3 WHERE holiday_cards.status='waiting'`,
      [event.day, event.names, event.categories]);
      const [card] = (await client.query<{ status: string }>("SELECT status FROM holiday_cards WHERE day=$1 FOR UPDATE", [event.day])).rows;
      if (card.status !== "waiting") return;
      const [last] = (await client.query<HolidayGeneration>("SELECT * FROM holiday_generations WHERE day=$1 ORDER BY revision DESC LIMIT 1", [event.day])).rows;
      if (!last || JSON.stringify(last.names) !== JSON.stringify(event.names)) {
        await client.query("INSERT INTO holiday_generations(id,day,revision,names) VALUES($1,$2,$3,$4)",
          [randomUUID(), event.day, (last?.revision ?? 0) + 1, event.names]);
      }
    });
  }
}

export async function holidayDashboard(now = new Date()): Promise<HolidayDashboard> {
  const settings = await holidaySettings();
  const plan = holidayPlan(settings, now);
  const rows = await query<HolidayCard>(`SELECT c.day::text,c.names,c.categories,c.status,c.error_code,c.sent_material_id,c.recipient_results,
    (SELECT row_to_json(g) FROM (SELECT id,day::text,revision,names,feedback,status,material_id,error_code
      FROM holiday_generations WHERE day=c.day ORDER BY revision DESC LIMIT 1) g) AS generation
    FROM holiday_cards c WHERE c.day >= $1::date-30 ORDER BY c.day`, [localDay(now, "Asia/Shanghai")]);
  const upcoming = plan.map(event => {
    const stored = rows.find(row => row.day === event.day);
    return { day: event.day, names: event.names, categories: event.categories, status: stored?.status ?? "waiting",
      error_code: stored?.error_code ?? null, sent_material_id: stored?.sent_material_id ?? null,
      recipient_results: stored?.recipient_results ?? null,
      generation: stored && JSON.stringify(stored.generation?.names) === JSON.stringify(event.names) ? stored.generation : null };
  });
  const today = localDay(now, "Asia/Shanghai");
  return { rules: { solar_terms: settings.solar_terms, chinese: settings.chinese, western: settings.western },
    referenceReady: !!settings.reference_id, horizon: HOLIDAY_HORIZON, upcoming,
    history: rows.filter(row => row.day < today || row.status !== "waiting").reverse().slice(0, 30),
    attention: upcoming.filter(row => ["failed", "unknown"].includes(row.generation?.status ?? "") ||
      ["failed", "unknown"].includes(row.status)).length };
}

export async function requestHolidayRegeneration(day: string, feedback: string) {
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(day);
  const opinion = z.string().trim().max(1000).parse(feedback);
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(7316,1)");
    const settings = await holidaySettings();
    const event = holidayPlan(settings).find(item => item.day === day);
    if (!event) throw new AppError(409, "holiday_disabled", "日期不在已启用的未来节日计划中");
    const [timing] = (await client.query<{ future: boolean }>(
      "SELECT now()<($1::date+send_time::time) AT TIME ZONE timezone AS future FROM settings WHERE id=true", [day])).rows;
    if (!timing.future) throw new AppError(409, "holiday_due", "已到发送时间，不能重新生成；已发送内容保持不变");
    await client.query(`INSERT INTO holiday_cards(day,names,categories) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [day, event.names, event.categories]);
    const [card] = (await client.query<{ status: string }>("SELECT status FROM holiday_cards WHERE day=$1 FOR UPDATE", [day])).rows;
    if (card.status !== "waiting") throw new AppError(409, "holiday_frozen", "这天的发送状态已锁定，不能重新生成");
    const [last] = (await client.query<HolidayGeneration>("SELECT * FROM holiday_generations WHERE day=$1 ORDER BY revision DESC LIMIT 1", [day])).rows;
    if (last && ["queued", "generating"].includes(last.status)) throw new AppError(409, "holiday_generating", "已有生成任务，请等待完成");
    if ((last?.revision ?? 0) >= 10) throw new AppError(429, "holiday_revision_limit", "单日最多生成 10 个版本");
    const id = randomUUID();
    await client.query("INSERT INTO holiday_generations(id,day,revision,names,feedback) VALUES($1,$2,$3,$4,$5)",
      [id, day, (last?.revision ?? 0) + 1, event.names, opinion]);
    return { id };
  });
}

export async function processHolidayGeneration(now = new Date()) {
  const lock = await pool.connect();
  const acquired = (await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(7316,7) AS locked")).rows[0].locked;
  if (!acquired) { lock.release(); return; }
  try { await generateNextHoliday(now); }
  finally { await lock.query("SELECT pg_advisory_unlock(7316,7)"); lock.release(); }
}

async function generateNextHoliday(now: Date) {
  // The generation lock proves a leftover row belongs to an interrupted process.
  await query("UPDATE holiday_generations SET status='unknown',error_code='generation_interrupted',updated_at=now() WHERE status='generating'");
  const settings = await holidaySettings();
  const plan = holidayPlan(settings, now);
  const pending = await query<HolidayGeneration>(`SELECT DISTINCT ON(g.day) g.*,g.day::text AS day FROM holiday_generations g
    JOIN holiday_cards c ON c.day=g.day
    WHERE g.day=ANY($1::date[]) AND (c.status='waiting' OR (c.status='failed' AND c.error_code='holiday_not_ready'))
    ORDER BY g.day,g.revision DESC`, [plan.map(event => event.day)]);
  const generation = pending.find(item => item.status === "queued" &&
    JSON.stringify(item.names) === JSON.stringify(plan.find(event => event.day === String(item.day).slice(0, 10))?.names));
  if (!generation) return;
  const day = String(generation.day).slice(0, 10);
  const event = plan.find(item => item.day === day);
  if (!event) return;
  const claimed = await query(`UPDATE holiday_generations SET status='generating',updated_at=now()
    WHERE id=$1 AND status='queued' RETURNING id`, [generation.id]);
  if (!claimed.length) return;
  try {
    if (!settings.reference_id) throw new AppError(503, "holiday_reference_missing", "请配置节日参考图");
    const materialId = await generateHolidayImage(event, settings.reference_id, generation.feedback, generation.id);
    await query("UPDATE holiday_generations SET status='ready',material_id=$2,error_code=NULL,updated_at=now() WHERE id=$1", [generation.id, materialId]);
  } catch (error) {
    const code = error instanceof AppError ? error.code : "holiday_generation_failed";
    await query("UPDATE holiday_generations SET status=$2,error_code=$3,updated_at=now() WHERE id=$1",
      [generation.id, ["ark_generation_unknown", "generation_interrupted"].includes(code) ? "unknown" : "failed", code]);
    console.warn("[our-days] holiday_generation_failed", code);
  }
}

export async function processHolidayDelivery(day: string, now = new Date()): Promise<boolean> {
  const settings = await holidaySettings();
  const event = holidayOn(day, settings);
  const [existing] = await query<{ status: string; recipients: string[] | null; error_code: string | null }>(
    "SELECT status,recipients,error_code FROM holiday_cards WHERE day=$1", [day]);
  if (existing && ["sending", "accepted", "unknown"].includes(existing.status)) return true;
  if (existing?.recipients) return true;
  if (!event) return false;
  const [timing] = await query<{ due: boolean; missed: boolean }>(`SELECT
    $2::timestamptz>=($1::date+send_time::time) AT TIME ZONE timezone
      AND (enabled_at IS NULL OR enabled_at<=($1::date+send_time::time) AT TIME ZONE timezone) AS due,
    $2::timestamptz>(($1::date+send_time::time) AT TIME ZONE timezone)+interval '15 minutes' AS missed
    FROM settings WHERE id=true`, [day, now.toISOString()]);
  if (!timing.due) return true;
  const reserved = await query("SELECT id FROM editions WHERE day=$1 AND status<>'cancelled'", [day]);
  if (reserved.length) {
    await query("UPDATE holiday_cards SET status='skipped',error_code='photo_already_reserved',updated_at=now() WHERE day=$1", [day]);
    return false;
  }
  if (existing?.status === "skipped" || (existing?.status === "failed" && existing.error_code !== "holiday_not_ready")) return true;
  if (timing.missed) {
    await query("UPDATE holiday_cards SET status='failed',error_code='missed_send_window',updated_at=now() WHERE day=$1", [day]);
    return true;
  }
  const [generation] = await query<HolidayGeneration>(
    "SELECT * FROM holiday_generations WHERE day=$1 ORDER BY revision DESC LIMIT 1", [day]);
  if (!generation || generation.status !== "ready" || !generation.material_id ||
      JSON.stringify(generation.names) !== JSON.stringify(event.names)) {
    await query("UPDATE holiday_cards SET status='failed',error_code='holiday_not_ready',updated_at=now() WHERE day=$1", [day]);
    return true;
  }
  if (process.env.PUSH_ENABLED !== "true" || process.env.PUSH_CHANNEL !== "wecom") return true;
  const recipients = wecomRecipients(process.env.WECOM_USER_ID);
  let submitted = false;
  try {
    const [material] = await query<{ original_ext: string; sha256: string }>(
      "SELECT original_ext,sha256 FROM special_materials WHERE id=$1", [generation.material_id]);
    if (!material) throw new AppError(404, "holiday_image_missing", "节日成品文件不存在");
    const bytes = await readFile(specialMediaPath(generation.material_id, `original.${material.original_ext}`));
    if (createHash("sha256").update(bytes).digest("hex") !== material.sha256) throw new AppError(409, "holiday_image_changed", "成品图片校验失败");
    const claimed = await query(`UPDATE holiday_cards SET status='sending',sent_material_id=$2,recipients=$3,error_code=NULL,updated_at=now()
      WHERE day=$1 AND recipients IS NULL RETURNING day`, [day, generation.material_id, recipients]);
    if (!claimed.length) return true;
    submitted = true;
    const result = await sendWecomImage(bytes, {
      corpId: process.env.WECOM_CORP_ID, secret: process.env.WECOM_APP_SECRET,
      agentId: Number(process.env.WECOM_AGENT_ID), userId: recipients.join("|"),
    });
    await query("UPDATE holiday_cards SET status='accepted',record_id=$2,recipient_results=$3::jsonb,updated_at=now() WHERE day=$1",
      [day, result.msgid, JSON.stringify(result.recipients)]);
  } catch (error) {
    const unknown = error instanceof WecomSendError ? error.unknown : submitted && !(error instanceof AppError);
    await query("UPDATE holiday_cards SET status=$2,error_code=$3,record_id=$4,recipient_results=$5::jsonb,updated_at=now() WHERE day=$1",
      [day, unknown ? "unknown" : "failed", error instanceof AppError ? error.code : unknown ? "holiday_send_unknown" : "holiday_send_rejected",
        error instanceof WecomSendError ? error.recordId ?? null : null,
        error instanceof WecomSendError && error.recipients ? JSON.stringify(error.recipients) : null]);
    console.warn("[our-days] holiday_send_failed_or_unknown; no automatic retry");
  }
  return true;
}
