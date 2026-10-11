import { createHash, timingSafeEqual } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { AppError } from "./domain";
import type { SendResult } from "./push";

export function wechatReady() {
  return !!(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET &&
    process.env.WECHAT_OPEN_ID && process.env.WECHAT_TEMPLATE_ID && process.env.WECHAT_VERIFY_TOKEN);
}
export function verifyWechatSignature(url: URL, now = Date.now()) {
  const token = process.env.WECHAT_VERIFY_TOKEN;
  if (!token) throw new AppError(503, "wechat_config", "微信回调未配置");
  const timestamp = url.searchParams.get("timestamp") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  const signature = url.searchParams.get("signature") ?? "";
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 ||
      !nonce || nonce.length > 128 || !/^[a-f0-9]{40}$/.test(signature)) {
    throw new AppError(403, "wechat_signature", "微信签名无效或已过期");
  }
  const expected = createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new AppError(403, "wechat_signature", "微信签名无效");
}

export function parseWechatReceipt(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new AppError(400, "wechat_xml", "无效微信回调");
  }
  const parsed = new XMLParser({ parseTagValue: false, processEntities: false }).parse(xml);
  const receipt = z.object({ xml: z.object({
    FromUserName: z.string(), MsgType: z.string(), Event: z.string().optional(),
    MsgID: z.string().optional(), Status: z.string().optional(),
    TotalCount: z.string().optional(), FilterCount: z.string().optional(),
    SentCount: z.string().optional(), ErrorCount: z.string().optional(),
  }) }).parse(parsed).xml;
  if (receipt.MsgType === "event" && receipt.Event === "MASSSENDJOBFINISH") {
    const count = z.string().regex(/^\d{1,10}$/).refine(value => Number(value) <= 2147483647);
    z.object({
      FromUserName: z.literal("mphelper"),
      MsgID: z.string().regex(/^\d{1,20}$/),
      Status: z.string().min(1).max(100),
      TotalCount: count, FilterCount: count, SentCount: count, ErrorCount: count,
    }).parse(receipt);
  }
  return receipt;
}

let cached: { token: string; expires: number } | undefined;
export async function sendWechatNotice(editionId: string, day: string, fetcher: typeof fetch = fetch): Promise<SendResult> {
  if (process.env.PUSH_ENABLED !== "true") throw new AppError(409, "push_disabled", "真实推送未启用");
  if (!wechatReady() || !process.env.PUBLIC_URL) throw new AppError(503, "wechat_config", "微信测试号尚未配置");
  const page = new URL(process.env.PUBLIC_URL);
  if (page.protocol !== "https:") throw new AppError(503, "push_https", "真实通知需要 HTTPS");
  page.searchParams.set("edition", editionId);
  if (!cached || cached.expires < Date.now()) {
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.search = new URLSearchParams({
      grant_type: "client_credential", appid: process.env.WECHAT_APP_ID!,
      secret: process.env.WECHAT_APP_SECRET!,
    }).toString();
    try {
      const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      const body = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).parse(await response.json());
      cached = { token: body.access_token, expires: Date.now() + Math.max(0, body.expires_in - 120) * 1000 };
    } catch {
      return { status: "failed", errorCode: "wechat_token_failed" };
    }
  }
  try {
    const response = await fetcher(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(cached.token)}`, {
      method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: process.env.WECHAT_OPEN_ID, template_id: process.env.WECHAT_TEMPLATE_ID,
        url: page.href, client_msg_id: editionId,
        data: { date: { value: day }, note: { value: "今天的私人来信已更新，点开查看。" } },
      }),
    });
    if (!response.ok) return { status: "unknown", errorCode: `wechat_http_${response.status}` };
    // msgid may exceed JS's safe integer range; preserve the original decimal representation.
    const text = (await response.text()).replace(/("msgid"\s*:\s*)(\d+)/g, '$1"$2"');
    const body = z.object({ errcode: z.number(), msgid: z.string().optional() }).parse(JSON.parse(text));
    if (body.errcode !== 0) {
      if ([40001, 40014, 42001].includes(body.errcode)) cached = undefined;
      return { status: "failed", errorCode: `wechat_${body.errcode}` };
    }
    if (!body.msgid || !/^\d+$/.test(body.msgid)) return { status: "unknown", errorCode: "wechat_missing_id" };
    return { status: "accepted", recordId: body.msgid };
  } catch {
    console.warn("[our-days] wechat_submission_unknown");
    return { status: "unknown", errorCode: "wechat_transport_unknown" };
  }
}
