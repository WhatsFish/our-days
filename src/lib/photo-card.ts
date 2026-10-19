import sharp from "sharp";
import { mkdir, readFile } from "node:fs/promises";
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
export async function renderPhotoCard(snapshot: Snapshot, day: string, input?: Buffer) {
  process.env.XDG_CACHE_HOME ??= "/tmp/our-days-fontcache";
  await mkdir(process.env.XDG_CACHE_HOME, { recursive: true, mode: 0o700 });
  const photo = await sharp(input ?? await readFile(mediaPath(snapshot.photo_id, "display.webp")))
    .resize(952, 680, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  const caption = wrapCardText(snapshot.caption);
  const details = wrapCardText([snapshot.date_label, snapshot.place_label].filter(Boolean).join(" · "), 36);
  const extras = [snapshot.weather === "未配置天气城市" ? "" : snapshot.weather, snapshot.almanac, snapshot.star_note].filter(Boolean).flatMap(text => wrapCardText(text, 38));
  let y = 950;
  const text: string[] = [];
  function add(lines: string[], size: number, lineHeight: number, color: string) {
    for (const line of lines) { text.push(`<text x="64" y="${y}" font-size="${size}" fill="${color}">${xmlEscape(line)}</text>`); y += lineHeight; }
  }
  add(details, 25, 38, "#6f786a"); y += 25;
  add(caption, 34, 58, "#354236"); y += 35;
  add(extras, 24, 40, "#6f786a"); y += 40;
  // Long reviewed captions stay complete; reject rather than silently truncate or send unreadable cards.
  if (y > 6200) throw new AppError(400, "card_too_long", "文案过长，无法生成清晰的微信图片，请缩短后重试");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${Math.max(y, 1220)}">
    <rect width="100%" height="100%" fill="#f7f3eb"/>
    <g font-family="Noto Sans CJK SC,sans-serif">
      <text x="64" y="82" font-size="26" fill="#6f786a">拾光 · ${xmlEscape(day)}</text>
      <text x="64" y="153" font-size="40" fill="#354236">今天，想与你重温一个瞬间。</text>
      <image x="64" y="210" width="952" height="680" preserveAspectRatio="xMidYMid meet" href="data:image/jpeg;base64,${photo.toString("base64")}"/>
      ${text.join("")}
    </g></svg>`;
  const image = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
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
