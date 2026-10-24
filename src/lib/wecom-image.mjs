export class WecomSendError extends Error {
  constructor(message, unknown = false, recipients, recordId) {
    super(message); this.unknown = unknown; this.recipients = recipients; this.recordId = recordId;
  }
}

export function wecomRecipients(value) {
  const ids = typeof value === "string" ? value.split("|") : [];
  if (ids.length < 1 || ids.length > 2 || ids.some(id =>
    !/^[a-zA-Z0-9_.@-]{1,64}$/.test(id) || id.toLowerCase() === "@all") ||
    new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
    throw new WecomSendError("Provide one or two distinct explicit member UserIDs separated by |; never @all");
  }
  return ids;
}

export async function sendWecomImage(image, config, fetcher = fetch) {
  const userIds = wecomRecipients(config.userId);
  if (!Buffer.isBuffer(image) || image.length === 0 || image.length > 2 * 1024 * 1024 ||
      !(image.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" || image.subarray(0, 3).toString("hex") === "ffd8ff")) {
    throw new WecomSendError("Use a PNG/JPEG of at most 2MiB");
  }
  if (!/^ww[a-zA-Z0-9]+$/.test(config.corpId ?? "") ||
      typeof config.secret !== "string" || !config.secret.trim() ||
      !Number.isSafeInteger(config.agentId) || config.agentId <= 0) {
    throw new WecomSendError("Provide a CorpID, application Secret and numeric AgentID");
  }
  async function responseJSON(response, operation) {
    if (!response.ok) throw new WecomSendError(`${operation}: HTTP ${response.status}`, operation.startsWith("Submission"));
    let body;
    try { body = await response.json(); }
    catch { throw new WecomSendError(`${operation}: invalid JSON`, operation.startsWith("Submission")); }
    if (typeof body.errcode !== "number") throw new WecomSendError(`${operation}: missing errcode`, operation.startsWith("Submission"));
    if (body.errcode !== 0) throw new WecomSendError(`${operation}: WeCom errcode ${body.errcode}`);
    return body;
  }
  const tokenUrl = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
  tokenUrl.search = new URLSearchParams({ corpid: config.corpId, corpsecret: config.secret }).toString();
  const auth = await responseJSON(await fetcher(tokenUrl, { signal: AbortSignal.timeout(10000) }), "Credentials");
  if (typeof auth.access_token !== "string" || !auth.access_token) throw new Error("Credentials: no access token");
  const agentUrl = new URL("https://qyapi.weixin.qq.com/cgi-bin/agent/get");
  agentUrl.search = new URLSearchParams({ access_token: auth.access_token, agentid: String(config.agentId) }).toString();
  const agent = await responseJSON(await fetcher(agentUrl, { signal: AbortSignal.timeout(10000) }), "Application");
  if (Number(agent.agentid) !== config.agentId || agent.close !== 0) {
    throw new Error("Application: ID mismatch or disabled application");
  }
  for (const userId of userIds) {
    const memberUrl = new URL("https://qyapi.weixin.qq.com/cgi-bin/user/get");
    memberUrl.search = new URLSearchParams({ access_token: auth.access_token, userid: userId }).toString();
    const member = await responseJSON(await fetcher(memberUrl, { signal: AbortSignal.timeout(10000) }), "Recipient");
    if (typeof member.userid !== "string" || member.userid.toLowerCase() !== userId.toLowerCase() || member.status !== 1) {
      throw new Error("Recipient: not an active member; complete membership before any send");
    }
  }
  const form = new FormData();
  const png = image.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  form.set("media", new Blob([image], { type: png ? "image/png" : "image/jpeg" }), png ? "our-days.png" : "our-days.jpg");
  const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(auth.access_token)}&type=image`;
  const asset = await responseJSON(await fetcher(uploadUrl, {
    method: "POST", body: form, signal: AbortSignal.timeout(15000),
  }), "Upload");
  if (typeof asset.media_id !== "string" || !asset.media_id) throw new Error("Upload: no media ID");
  let response;
  try {
    response = await fetcher(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(auth.access_token)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: userIds.join("|"), agentid: config.agentId, msgtype: "image",
        image: { media_id: asset.media_id },
        enable_duplicate_check: 1, duplicate_check_interval: 3600,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new WecomSendError("Submission UNKNOWN; inspect both phones before considering another attempt", true,
      userIds.map(userId => ({ userId, status: "unknown" })));
  }
  // HTTP/JSON errors here may follow an accepted task; never automatically retry.
  let result;
  try { result = await responseJSON(response, "Submission (no automatic retry)"); }
  catch (error) {
    if (error instanceof WecomSendError) error.recipients = userIds.map(userId => ({ userId, status: error.unknown ? "unknown" : "failed" }));
    throw error;
  }
  const rejected = [result.invaliduser, result.unlicenseduser].filter(Boolean);
  if (rejected.some(value => typeof value !== "string") || result.invalidparty || result.invalidtag) {
    throw new WecomSendError("Submission: unexpected recipient results; no retry", true,
      userIds.map(userId => ({ userId, status: "unknown" })));
  }
  const invalid = new Set(rejected.flatMap(value => value.split("|")).map(value => value.toLowerCase()));
  if ([...invalid].some(id => !userIds.some(userId => userId.toLowerCase() === id))) {
    throw new WecomSendError("Submission: unexpected rejected member; no retry", true,
      userIds.map(userId => ({ userId, status: "unknown" })));
  }
  const hasMessageId = typeof result.msgid === "string" && !!result.msgid;
  const recipients = userIds.map(userId => ({
    userId, status: invalid.has(userId.toLowerCase()) ? "failed" : hasMessageId ? "accepted" : "unknown",
  }));
  if (invalid.size) {
    throw new WecomSendError("Recipient rejected or unlicensed; some recipients may already have received the image; no automatic retry",
      recipients.some(recipient => recipient.status !== "failed"), recipients, hasMessageId ? result.msgid : undefined);
  }
  if (!hasMessageId) throw new WecomSendError("Submission: no message ID; receipt unconfirmed", true, recipients);
  return { status: "accepted", msgid: result.msgid, recipients };
}
