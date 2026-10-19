export class WecomSendError extends Error {
  constructor(message, unknown = false) { super(message); this.unknown = unknown; }
}

export async function sendWecomImage(image, config, fetcher = fetch) {
  if (!Buffer.isBuffer(image) || image.length === 0 || image.length > 2 * 1024 * 1024 ||
      !(image.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" || image.subarray(0, 3).toString("hex") === "ffd8ff")) {
    throw new WecomSendError("Use a PNG/JPEG of at most 2MiB");
  }
  if (!/^ww[a-zA-Z0-9]+$/.test(config.corpId ?? "") ||
      typeof config.secret !== "string" || !config.secret.trim() ||
      !Number.isSafeInteger(config.agentId) || config.agentId <= 0 ||
      !/^[a-zA-Z0-9_.@-]{1,64}$/.test(config.userId ?? "") ||
      config.userId.toLowerCase() === "@all") {
    throw new WecomSendError("Provide a CorpID, application Secret, numeric AgentID and exactly one member UserID; never @all");
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
  const memberUrl = new URL("https://qyapi.weixin.qq.com/cgi-bin/user/get");
  memberUrl.search = new URLSearchParams({ access_token: auth.access_token, userid: config.userId }).toString();
  const member = await responseJSON(await fetcher(memberUrl, { signal: AbortSignal.timeout(10000) }), "Recipient");
  if (typeof member.userid !== "string" || member.userid.toLowerCase() !== config.userId.toLowerCase() || member.status !== 1) {
    throw new Error("Recipient: not an active member; complete membership before any send");
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
        touser: config.userId, agentid: config.agentId, msgtype: "image",
        image: { media_id: asset.media_id },
        enable_duplicate_check: 1, duplicate_check_interval: 3600,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new WecomSendError("Submission UNKNOWN; inspect the recipient phone before considering another attempt", true);
  }
  // HTTP/JSON errors here may follow an accepted task; never automatically retry.
  const result = await responseJSON(response, "Submission (no automatic retry)");
  if (result.invaliduser || result.invalidparty || result.invalidtag || result.unlicenseduser) {
    throw new Error("Recipient rejected or unlicensed; API acceptance does not establish receipt");
  }
  if (typeof result.msgid !== "string" || !result.msgid) throw new WecomSendError("Submission: no message ID; receipt unconfirmed", true);
  return { status: "accepted", msgid: result.msgid };
}
