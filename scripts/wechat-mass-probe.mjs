import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const imagePath = process.argv[2];
if (!imagePath) throw new Error("Usage: node scripts/wechat-mass-probe.mjs IMAGE [--send-once | --send-five]");
if (process.argv.includes("--send-once") && process.argv.includes("--send-five")) throw new Error("Choose one send mode");
const image = await readFile(imagePath);
if (image.length > 2 * 1024 * 1024 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
  throw new Error("Expected a PNG of at most 2MiB");
}
console.log(`Mass image probe ready: ${image.length} bytes. No customer-service API is used.`);
if (process.argv.includes("--send-once") || process.argv.includes("--send-five")) {
  const count = process.argv.includes("--send-five") ? 5 : 1;
  const resume = process.argv.includes("--resume-accepted");
  const submissionOnly = process.argv.includes("--submission-only");
  if (resume && (count !== 5 || !submissionOnly)) throw new Error("Resume requires --send-five --submission-only");
  if (process.env.PUSH_ENABLED !== "false") throw new Error("Keep automatic pushes disabled");
  for (const key of ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_OPEN_ID", "PROBE_STATE_FILE"]) {
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  }
  const state = resume ? JSON.parse(await readFile(process.env.PROBE_STATE_FILE, "utf8")) :
    { clientmsgid: randomBytes(16).toString("hex"), status: "preflight", tag_id: null, msg_id: null, messages: [] };
  if (resume && (!Array.isArray(state.messages) || state.messages.length < 1 || state.messages.length >= count ||
      state.status !== "accepted" || !Number.isSafeInteger(state.tag_id) ||
      state.messages.some(message => !message.msg_id || !["accepted", "SEND_SUCCESS"].includes(message.status)))) {
    throw new Error("Resume requires a recorded accepted batch, never an unknown or rejected submission");
  }
  // Refuse a second invocation against the same record, even after a transport timeout.
  if (!resume) await writeFile(process.env.PROBE_STATE_FILE, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  const save = () => writeFile(process.env.PROBE_STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  const tokenURL = new URL("https://api.weixin.qq.com/cgi-bin/token");
  tokenURL.search = new URLSearchParams({
    grant_type: "client_credential", appid: process.env.WECHAT_APP_ID, secret: process.env.WECHAT_APP_SECRET,
  }).toString();
  const auth = await (await fetch(tokenURL, { signal: AbortSignal.timeout(10000) })).json();
  if (!auth.access_token) throw new Error(`Token failed: ${auth.errcode}`);
  async function call(endpoint, body) {
    const r = await fetch(`https://api.weixin.qq.com${endpoint}?access_token=${encodeURIComponent(auth.access_token)}`, {
      method: "POST", headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
      body: body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`WeChat HTTP ${r.status}; ${endpoint}`);
    const text = (await r.text()).replace(/("(?:msg_id|msg_data_id)"\s*:\s*)(\d+)/g, '$1"$2"');
    return JSON.parse(text);
  }
  const checked = (r, operation) => {
    if (r.errcode && r.errcode !== 0) throw new Error(`${operation}: WeChat errcode ${r.errcode}`);
    return r;
  };
  let submitted = resume, terminal = false;
  try {
    if (!resume) {
      const tag = checked(await call("/cgi-bin/tags/create", { tag: { name: `ourdays-${state.clientmsgid.slice(0, 12)}` } }), "Create private test tag");
      if (!Number.isSafeInteger(tag.tag?.id)) throw new Error("No valid tag ID");
      state.tag_id = tag.tag.id;
      await save();
      checked(await call("/cgi-bin/tags/members/batchtagging", { tagid: state.tag_id, openid_list: [process.env.WECHAT_OPEN_ID] }), "Tag recipient");
    }
    const audience = checked(await call("/cgi-bin/user/tag/get", { tagid: state.tag_id, next_openid: "" }), "Check audience");
    if (audience.count !== 1 || audience.data?.openid?.length !== 1 ||
        audience.data.openid[0] !== process.env.WECHAT_OPEN_ID) {
      throw new Error("Refusing to send: tag must contain exactly the configured recipient");
    }
    if (audience.next_openid) {
      const remaining = checked(await call("/cgi-bin/user/tag/get", { tagid: state.tag_id, next_openid: audience.next_openid }), "Check remaining audience");
      if (remaining.count !== 0 || (remaining.data?.openid?.length ?? 0) !== 0) throw new Error("Unexpected additional tagged recipients");
    }
    const media = new FormData();
    media.set("media", new Blob([image], { type: "image/png" }), "our-days-demo.png");
    const uploadResponse = await fetch(
      `https://api.weixin.qq.com/cgi-bin/media/upload?type=image&access_token=${encodeURIComponent(auth.access_token)}`,
      { method: "POST", body: media, signal: AbortSignal.timeout(15000) },
    );
    if (!uploadResponse.ok) throw new Error("Image upload HTTP failure");
    const asset = checked(await uploadResponse.json(), "Upload demo");
    if (!asset.media_id) throw new Error("No image media_id");
    for (let index = state.messages.length; index < count; index++) {
      if (index > 0) {
        console.log("Waiting 60 seconds before the next explicitly requested message.");
        await delay(60000);
      }
      const message = {
        number: index + 1, clientmsgid: randomBytes(16).toString("hex"),
        submitted_at: new Date().toISOString(), msg_id: null, status: "submitting",
      };
      state.messages.push(message);
      state.status = "submitting";
      await save();
      terminal = false;
      submitted = true;
      const result = await call("/cgi-bin/message/mass/sendall", {
        filter: { is_to_all: false, tag_id: state.tag_id },
        msgtype: "image",
        images: {
          media_ids: [asset.media_id],
          title: count === 1 ? "拾光 · 主动图片推送测试" : `拾光 · 连续群发测试 ${index + 1}/5`,
          recommend: "版式演示：示意画面与示例天气，不是真实照片或预报。",
          need_open_comment: 0, only_fans_can_comment: 0,
        },
        clientmsgid: message.clientmsgid,
      });
      console.log(`Message ${index + 1}/${count}: mass submission errcode=${result.errcode}`);
      if (result.errcode !== 0) {
        state.status = message.status = `rejected_${result.errcode}`;
        terminal = true;
        await save();
        throw new Error(`Mass submission rejected: ${result.errcode}; remaining messages cancelled`);
      }
      state.msg_id = message.msg_id = result.msg_id ?? null;
      state.status = message.status = "accepted";
      await save();
      console.log(`Mass task accepted: msg_id=${state.msg_id}; tag=${state.tag_id}; at=${message.submitted_at}`);
      if (!state.msg_id) throw new Error("Accepted without message ID; do not retry");
      if (submissionOnly) {
        console.log("Accepted only; skipping exhausted status-query API. Phone confirmation required.");
        continue;
      }
      // Test accounts may allow only ten status queries per day.
      for (let attempt = 0; attempt < 2; attempt++) {
        await delay(30000);
        const result = checked(await call("/cgi-bin/message/mass/get", { msg_id: state.msg_id }), "Query mass task");
        if (result.msg_status && result.msg_status !== "SENDING") {
          state.status = message.status = result.msg_status;
          terminal = true;
          await save();
          break;
        }
      }
      console.log(`Message ${index + 1}/${count}: final task status=${message.status}`);
      if (message.status !== "SEND_SUCCESS") throw new Error("Task not confirmed successful; remaining messages cancelled, no retry");
    }
    console.log(`Completed ${count} requested sends; phone receipt still requires user confirmation.`);
  } finally {
    if (state.tag_id !== null && (!submitted || terminal)) {
      checked(await call("/cgi-bin/tags/delete", { tag: { id: state.tag_id } }), "Remove private test tag");
      console.log("Temporary recipient tag removed.");
    }
  }
}
