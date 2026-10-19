import sharp from "sharp";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Snapshot } from "./domain";
import { AppError } from "./domain";
import { mediaPath } from "./media";
import { sendWecomImage, WecomSendError } from "./wecom-image.mjs";
import type { SendResult } from "./push";

export function xmlEscape(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!));
}
export function wrapCardText(text: string, width = 26) {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "", size = 0;
    for (const char of paragraph) {
      const weight = /^[\x00-\x7f]$/.test(char) ? 0.55 : 1;
      if (size + weight > width && line) { lines.push(line); line = ""; size = 0; }
      line += char; size += weight;
    }
    lines.push(line);
  }
  return lines;
}
export async function renderPhotoCard(snapshot: Snapshot, _day: string, input?: Buffer) {
  process.env.XDG_CACHE_HOME ??= "/tmp/our-days-fontcache";
  process.env.FONTCONFIG_FILE ??= path.resolve("assets/fonts/fonts.conf");
  try { await access(path.resolve("assets/fonts/ZCOOLKuaiLe-Regular.ttf")); }
  catch { throw new AppError(503, "card_font_missing", "手写字体资源缺失，请检查部署"); }
  await mkdir(process.env.XDG_CACHE_HOME, { recursive: true, mode: 0o700 });
  const { data: photo, info: dimensions } = await sharp(input ?? await readFile(mediaPath(snapshot.photo_id, "display.webp")))
    .rotate().resize(968, 1900, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  const photoX = Math.round((1080 - dimensions.width) / 2);
  const photoY = 56;
  const photoBottom = photoY + dimensions.height;
  const caption = wrapCardText(snapshot.caption, 20);
  const details = wrapCardText([snapshot.date_label, snapshot.place_label].filter(Boolean).join(" · "), 29);
  const extras = [snapshot.weather === "未配置天气城市" ? "" : snapshot.weather, snapshot.star_note]
    .filter(Boolean).flatMap(text => wrapCardText(text, 30));
  let y = photoBottom + 64;
  const text: string[] = [];
  function add(lines: string[], size: number, lineHeight: number, color: string) {
    for (const line of lines) { text.push(`<text x="56" y="${y}" font-size="${size}" fill="${color}">${xmlEscape(line)}</text>`); y += lineHeight; }
  }
  if (details.length && details.some(Boolean)) { add(details, 30, 44, "#68645f"); y += 12; }
  add(caption, 44, 62, "#40464b");
  if (extras.length) {
    y += 14;
    add(extras, 30, 42, "#68645f");
  }
  y = Math.max(y + 56, photoBottom + 270);
  // Long reviewed captions stay complete; reject rather than silently truncate or send unreadable cards.
  if (y > 6200) throw new AppError(400, "card_too_long", "文案过长，无法生成清晰的微信图片，请缩短后重试");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${y}">
    <rect width="100%" height="100%" fill="#fffefa"/>
    <rect x="1" y="1" width="1078" height="${y - 2}" fill="none" stroke="#e5e2da" stroke-width="2"/>
    <g font-family="'ZCOOL KuaiLe','Noto Sans CJK SC',sans-serif">
      <image x="${photoX}" y="${photoY}" width="${dimensions.width}" height="${dimensions.height}" href="data:image/jpeg;base64,${photo.toString("base64")}"/>
      ${text.join("")}
    </g></svg>`;
  const image = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  if (image.length > 2 * 1024 * 1024) throw new AppError(400, "card_too_large", "图片卡片超过发送上限，请缩短内容后重试");
  return image;
}
export async function sendPhotoCard(snapshot: Snapshot, day: string): Promise<SendResult> {
  try {
    const image = await renderPhotoCard(snapshot, day);
    const result = await sendWecomImage(image, {
      corpId: process.env.WECOM_CORP_ID, secret: process.env.WECOM_APP_SECRET,
      agentId: Number(process.env.WECOM_AGENT_ID), userId: process.env.WECOM_USER_ID,
    });
    return { status: "accepted", recordId: result.msgid };
  } catch (error) {
    console.warn("[our-days] wecom_image_send_failed");
    return { status: error instanceof WecomSendError && error.unknown ? "unknown" : "failed",
      errorCode: error instanceof AppError ? error.code : error instanceof WecomSendError && error.unknown ? "wecom_unknown" : "wecom_rejected" };
  }
}
