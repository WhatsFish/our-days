import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { query, transaction } from "../../../lib/db";
import { checkOrigin, cookieName, login, requireRole, roleFor, tokenHash } from "../../../lib/auth";
import { AppError, editionInput, photoEdit, publicError, settingsInput, uuid, type Settings } from "../../../lib/domain";
import { enqueueUpload, mediaPath, storageBytes, uploadLimit } from "../../../lib/media";
import { suggestCaption } from "../../../lib/ai";
import { parseWechatReceipt, verifyWechatSignature, wechatReady } from "../../../lib/wechat";
import { decryptWecomCallback, wecomEncryptedBody } from "../../../lib/wecom-callback";
import { aiSettings, runtimeAI, saveAISettings, testAIConnection } from "../../../lib/ai-config";
import { lookupPhotoPlace } from "../../../lib/photo-place";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
type Context = { params: Promise<{ path: string[] }> };

async function boundedBody(request: Request, max: number): Promise<Buffer> {
  if (Number(request.headers.get("content-length") ?? 0) > max) throw new AppError(413, "body_size", "上传内容过大");
  if (!request.body) throw new AppError(400, "body", "请求为空");
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new AppError(413, "body_size", "上传内容过大"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function parseJson(request: Request): Promise<unknown> {
  const buffer = await boundedBody(request, 32 * 1024);
  try { return JSON.parse(buffer.toString("utf8")); }
  catch { throw new AppError(400, "json", "JSON 格式错误"); }
}
function failure(error: unknown) {
  const result = publicError(error);
  return json({ error: result.message, code: result.code }, result.status);
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const params = await context.params;
    const route = params.path.join("/");
    if (route === "wecom/callback") {
      const echo = decryptWecomCallback(request.nextUrl, request.nextUrl.searchParams.get("echostr") ?? "");
      return new NextResponse(new Uint8Array(echo), { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    }
    if (route === "wechat/callback") {
      verifyWechatSignature(request.nextUrl);
      const echo = request.nextUrl.searchParams.get("echostr");
      if (!echo || echo.length > 256) throw new AppError(400, "echo", "无效验证请求");
      return new NextResponse(echo, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    }
    if (route === "health") {
      const versions = await query("SELECT version FROM schema_version WHERE version=1");
      if (!versions.length) throw new AppError(503, "schema", "数据库尚未初始化");
      return json({ status: "ok" });
    }
    if (route === "session") return json({ role: await roleFor(request) });
    const role = await requireRole(request);
    if (params.path[0] === "media" && params.path.length === 3) {
      const id = uuid.parse(params.path[1]);
      const size = z.enum(["thumb", "display"]).parse(params.path[2]);
      if (role !== "admin") {
        const allowed = await query("SELECT id FROM editions WHERE photo_id=$1 AND status='published' AND published_at<=now() LIMIT 1", [id]);
        if (!allowed.length) throw new AppError(404, "not_found", "照片尚未解锁");
      }
      if (!(await query("SELECT id FROM photos WHERE id=$1", [id])).length) throw new AppError(404, "not_found", "照片不存在");
      return new NextResponse(new Uint8Array(await readFile(mediaPath(id, `${size}.webp`))), {
        headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    if (route === "editions") {
      const rows = await query(
        `SELECT e.id,e.day::text,e.photo_id,e.title,e.send_at,e.notify,e.status,e.snapshot,
          (f.edition_id IS NOT NULL) AS favorite
         FROM editions e LEFT JOIN favorites f ON f.edition_id=e.id
         WHERE e.status='published' AND e.published_at<=now() ORDER BY e.day DESC LIMIT 366`);
      return json(rows);
    }
    await requireRole(request, true);
    if (route === "imports") {
      const ids = z.array(uuid).min(1).max(100).parse((request.nextUrl.searchParams.get("ids") ?? "").split(","));
      return json(await query("SELECT id,status,added,duplicates,errors FROM imports WHERE id=ANY($1::uuid[])", [ids]));
    }
    if (route === "admin") {
      const [photos, editions, imports, deliveries, settings, worker, bytes, costs, ai, aiRuntime] = await Promise.all([
        query(`SELECT p.*, (SELECT count(*)::int FROM editions e WHERE e.photo_id=p.id AND e.status<>'cancelled') AS used
               FROM photos p ORDER BY created_at DESC LIMIT 1000`),
        query("SELECT id,day::text,photo_id,title,send_at,notify,status,snapshot FROM editions ORDER BY day DESC LIMIT 366"),
        query("SELECT id,status,added,duplicates,errors,created_at FROM imports ORDER BY created_at DESC LIMIT 20"),
        query("SELECT d.*,e.day::text FROM deliveries d JOIN editions e ON e.id=d.edition_id ORDER BY e.day DESC LIMIT 50"),
        query<Settings>("SELECT * FROM settings WHERE id=true"),
        query("SELECT * FROM worker_state"), storageBytes(),
        query("SELECT coalesce(sum(cost_usd),0)::text AS total FROM ai_events WHERE created_at>=date_trunc('month',now())"),
        aiSettings(), runtimeAI(),
      ]);
      return json({ photos, editions, imports, deliveries, settings: settings[0], worker: worker[0] ?? null, bytes,
        quotaMb: Number(process.env.MEDIA_QUOTA_MB ?? 200), aiCost: costs[0].total,
        pushEnabled: process.env.PUSH_ENABLED === "true",
        pushChannel: process.env.PUSH_CHANNEL ?? "wechat-test",
        pushReady: (process.env.PUSH_CHANNEL ?? "wechat-test") === "wechat-test" ? wechatReady() :
          !!(process.env.PUSHPLUS_TOKEN && process.env.PUSHPLUS_TO && process.env.PUSHPLUS_SECRET_KEY),
        aiEnabled: aiRuntime.enabled, ai });
    }
    throw new AppError(404, "not_found", "接口不存在");
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const params = await context.params;
    const route = params.path.join("/");
    if (route === "wecom/callback") {
      const encrypted = wecomEncryptedBody((await boundedBody(request, 64 * 1024)).toString("utf8"));
      decryptWecomCallback(request.nextUrl, encrypted);
      // This endpoint only verifies and acknowledges; no message content is logged or acted upon.
      return new NextResponse("", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    }
    if (route === "wechat/callback") {
      verifyWechatSignature(request.nextUrl);
      const receipt = parseWechatReceipt((await boundedBody(request, 32 * 1024)).toString("utf8"));
      if (receipt.MsgType === "event" && receipt.Event === "MASSSENDJOBFINISH") {
        await query(
          `INSERT INTO wechat_mass_receipts(record_id,status,total_count,filter_count,sent_count,error_count)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(record_id) DO NOTHING`,
          [receipt.MsgID, receipt.Status, Number(receipt.TotalCount), Number(receipt.FilterCount),
            Number(receipt.SentCount), Number(receipt.ErrorCount)]);
      }
      if (receipt.FromUserName === process.env.WECHAT_OPEN_ID && receipt.MsgType === "event" &&
          receipt.Event === "TEMPLATESENDJOBFINISH" && receipt.MsgID && receipt.Status) {
        await query(
          "INSERT INTO wechat_receipts(record_id,status) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [receipt.MsgID, receipt.Status === "success" ? "delivered" : "failed"]);
        await query(
          `UPDATE deliveries SET status=$2,error_code=$3,updated_at=now()
           WHERE channel='wechat-test' AND record_id=$1 AND status IN ('accepted','unknown')`,
          [receipt.MsgID, receipt.Status === "success" ? "delivered" : "failed",
            receipt.Status === "success" ? null : "wechat_delivery_failed"]);
      }
      return new NextResponse("success", { headers: { "Content-Type": "text/plain" } });
    }
    checkOrigin(request);
    if (route === "login") {
      const body = z.object({ role: z.enum(["admin", "reader"]), password: z.string().min(1).max(256) }).parse(await parseJson(request));
      const session = await login(body.role, body.password);
      const response = json({ role: body.role });
      response.cookies.set(cookieName, session.token, {
        httpOnly: true, secure: new URL(process.env.PUBLIC_URL!).protocol === "https:",
        sameSite: "strict", path: "/our-days", maxAge: session.seconds,
      });
      return response;
    }
    await requireRole(request);
    if (route === "logout") {
      await query("DELETE FROM sessions WHERE token_hash=$1", [tokenHash(request.cookies.get(cookieName)!.value)]);
      const response = json({ ok: true });
      response.cookies.set(cookieName, "", { path: "/our-days", maxAge: 0 });
      return response;
    }
    if (route === "favorite") {
      const body = z.object({ id: uuid, favorite: z.boolean() }).parse(await parseJson(request));
      if (!(await query("SELECT id FROM editions WHERE id=$1 AND status='published' AND published_at<=now()", [body.id])).length) throw new AppError(404, "not_found", "来信尚未解锁");
      if (body.favorite) await query("INSERT INTO favorites(edition_id) VALUES($1) ON CONFLICT DO NOTHING", [body.id]);
      else await query("DELETE FROM favorites WHERE edition_id=$1", [body.id]);
      return json({ ok: true });
    }
    await requireRole(request, true);
    if (route === "upload") {
      const bytes = await boundedBody(request, uploadLimit + 64 * 1024);
      const form = await new Request(request.url, {
        method: "POST", headers: { "Content-Type": request.headers.get("content-type") ?? "" }, body: new Uint8Array(bytes),
      }).formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new AppError(400, "file", "请选择图片或 ZIP");
      const id = await enqueueUpload(Buffer.from(await file.arrayBuffer()), file.name.toLowerCase().endsWith(".zip"));
      return json({ id }, 202);
    }
    const body = await parseJson(request);
    if (route === "ai/config") return json(await saveAISettings(body));
    if (route === "ai/test") {
      z.object({ confirm: z.literal(true) }).parse(body);
      return json(await testAIConnection());
    }
    if (route === "photo/place") {
      const value = z.object({ id: uuid, consent: z.literal(true) }).parse(body);
      return json(await lookupPhotoPlace(value.id));
    }
    if (route === "photo") {
      const value = photoEdit.parse(body);
      const rows = await query(
        `UPDATE photos SET date_label=$2,place_label=$3,facts=$4,caption=$5,approved=$6 WHERE id=$1 RETURNING id`,
        [value.id, value.date_label, value.place_label, value.facts, value.caption, value.approved]);
      if (!rows.length) throw new AppError(404, "not_found", "照片不存在");
      return json({ ok: true });
    }
    if (route === "photo/delete") {
      const { id } = z.object({ id: uuid }).parse(body);
      await transaction(async client => {
        const photo = await client.query<{ original_ext: string }>("SELECT original_ext FROM photos WHERE id=$1 FOR UPDATE", [id]);
        if (!photo.rowCount) throw new AppError(404, "not_found", "照片不存在");
        if ((await client.query("SELECT id FROM editions WHERE photo_id=$1", [id])).rowCount) {
          throw new AppError(409, "in_use", "照片已有来信记录，不能删除");
        }
        // Keep the row until all files are removed; ENOENT is an idempotent retry.
        for (const suffix of [`original.${photo.rows[0].original_ext}`, "display.webp", "thumb.webp"]) {
          try { await unlink(mediaPath(id, suffix)); }
          catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        }
        await client.query("DELETE FROM photos WHERE id=$1", [id]);
      });
      return json({ ok: true });
    }
    if (route === "settings") {
      const s = settingsInput.parse(body);
      await query(`UPDATE settings SET timezone=$1,send_time=$2,paused=$3,weather_lat=$4,weather_lon=$5,weather_city=$6,almanac=$7,star_note=$8 WHERE id=true`,
        [s.timezone, s.send_time, s.paused, s.weather_lat, s.weather_lon, s.weather_city, s.almanac, s.star_note]);
      return json({ ok: true });
    }
    if (route === "schedule") {
      const value = editionInput.parse(body);
      const result = await transaction(async client => {
        const s = (await client.query<Settings>("SELECT * FROM settings WHERE id=true FOR SHARE")).rows[0];
        const photo = await client.query("SELECT id FROM photos WHERE id=$1 AND approved=true FOR SHARE", [value.photo_id]);
        if (!photo.rowCount) throw new AppError(409, "unapproved", "照片必须先批准");
        const time = (await client.query<{ at: Date; future: boolean }>(
          "SELECT ($1::date+$2::time) AT TIME ZONE $3 AS at, (($1::date+$2::time) AT TIME ZONE $3)>now() AS future",
          [value.day, s.send_time, s.timezone])).rows[0];
        if (!time.future) throw new AppError(400, "past", "排期时间必须在未来；调整发送时间后再保存");
        const inserted = await client.query(
          `INSERT INTO editions(id,day,photo_id,title,send_at,notify) VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(day) DO UPDATE SET photo_id=$3,title=$4,send_at=$5,notify=$6,status='scheduled'
           WHERE editions.status<>'published' RETURNING id`,
          [randomUUID(), value.day, value.photo_id, value.title, time.at, value.notify]);
        if (!inserted.rowCount) throw new AppError(409, "published", "当天来信已发布，不能覆盖");
        return inserted.rows[0];
      });
      return json(result);
    }
    if (route === "cancel") {
      const { id } = z.object({ id: uuid }).parse(body);
      const rows = await query("UPDATE editions SET status='cancelled' WHERE id=$1 AND status='scheduled' RETURNING id", [id]);
      if (!rows.length) throw new AppError(409, "state", "只能取消未发布的来信");
      return json({ ok: true });
    }
    if (route === "delivery/retry") {
      const { id, confirm } = z.object({ id: uuid, confirm: z.literal(true) }).parse(body);
      void confirm;
      if (process.env.PUSH_ENABLED !== "true") throw new AppError(409, "push_disabled", "真实推送未启用");
      const rows = await query(
        `UPDATE deliveries d SET status='pending',error_code=NULL,updated_at=now()
         FROM editions e,settings s WHERE d.id=$1 AND d.edition_id=e.id AND d.status='failed'
         AND d.attempts<3 AND e.day=(now() AT TIME ZONE s.timezone)::date RETURNING d.id`, [id]);
      if (!rows.length) throw new AppError(409, "state", "仅能重试今天明确失败的消息，最多三次；未知状态不可重发");
      return json({ ok: true });
    }
    if (route === "ai") {
      const value = z.object({ id: uuid, consent: z.literal(true), style: z.enum(["朴实", "俏皮", "温柔"]) }).parse(body);
      return json({ draft: await suggestCaption(value.id, value.style) });
    }
    throw new AppError(404, "not_found", "接口不存在");
  } catch (error) { return failure(error); }
}
