import { z } from "zod";
import { AppError } from "./domain";
import type { WecomRecipientResult } from "./wecom-image.mjs";

const sent = z.object({ code: z.number(), data: z.unknown().optional() });
export type SendResult = {
  status: "accepted" | "failed" | "unknown"; recordId?: string; errorCode?: string; recipients?: WecomRecipientResult[];
};
export async function sendNotice(editionId: string, fetcher: typeof fetch = fetch): Promise<SendResult> {
  if (process.env.PUSH_ENABLED !== "true") throw new AppError(409, "push_disabled", "真实推送未启用");
  const token = process.env.PUSHPLUS_TOKEN, to = process.env.PUSHPLUS_TO;
  if (!token || !to || !process.env.PUBLIC_URL) throw new AppError(503, "push_config", "推送通道尚未配置");
  const page = new URL(process.env.PUBLIC_URL);
  if (page.protocol !== "https:") throw new AppError(503, "push_https", "真实通知需要 HTTPS");
  page.searchParams.set("edition", editionId);
  try {
    const response = await fetcher("https://www.pushplus.plus/send", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token, to, channel: "wechat", template: "txt",
        title: "鱼羊日记 · 今天的照片已更新",
        content: `你订阅的私人来信已更新。请在已配对的设备打开：${page.href}`,
      }),
    });
    // A transport/parse failure after submission may still have delivered the message.
    if (!response.ok) return { status: "unknown", errorCode: `http_${response.status}` };
    const body = sent.parse(await response.json());
    if (body.code !== 200) return { status: "failed", errorCode: `pushplus_${body.code}` };
    if (typeof body.data !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.data)) {
      return { status: "unknown", errorCode: "invalid_record" };
    }
    return { status: "accepted", recordId: body.data };
  } catch {
    console.warn("[our-days] push_submission_unknown");
    return { status: "unknown", errorCode: "transport_unknown" };
  }
}

let access: { key: string; expires: number } | undefined;
export async function deliveryStatus(record: string): Promise<"accepted" | "delivered" | "failed"> {
  if (!process.env.PUSHPLUS_SECRET_KEY) throw new AppError(503, "status_config", "需配置 PushPlus 开放接口 SecretKey 后才能查询送达");
  if (!access || access.expires < Date.now()) {
    const response = await fetch("https://www.pushplus.plus/api/common/openApi/getAccessKey", {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: process.env.PUSHPLUS_TOKEN, secretKey: process.env.PUSHPLUS_SECRET_KEY }),
    });
    const body = z.object({ code: z.literal(200), data: z.object({ accessKey: z.string().min(1), expiresIn: z.number().positive() }) }).parse(await response.json());
    access = { key: body.data.accessKey, expires: Date.now() + Math.max(0, body.data.expiresIn - 60) * 1000 };
  }
  const response = await fetch(`https://www.pushplus.plus/api/open/message/sendMessageResult?shortCode=${encodeURIComponent(record)}`, {
    headers: { "access-key": access.key }, signal: AbortSignal.timeout(10000), cache: "no-store",
  });
  const body = z.object({ code: z.literal(200), data: z.object({ status: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }) }).parse(await response.json());
  return body.data.status === 2 ? "delivered" : body.data.status === 3 ? "failed" : "accepted";
}
