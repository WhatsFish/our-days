import assert from "node:assert/strict";
import { test } from "node:test";
import { sendWecomImage } from "../scripts/wecom-image-probe.mjs";

const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
const config = { corpId: "wwSynthetic", secret: "synthetic-secret", agentId: 100001, userId: "operator" };
function mock(options = {}) {
  const calls = [];
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "qyapi.weixin.qq.com");
    calls.push({ url, init });
    if (url.pathname.endsWith("/gettoken")) return Response.json({ errcode: 0, access_token: "fake-token" });
    if (url.pathname.endsWith("/agent/get")) return Response.json({ errcode: 0, agentid: config.agentId, close: 0 });
    if (url.pathname.endsWith("/user/get")) return Response.json({ errcode: 0, userid: "operator", status: options.inactive ? 4 : 1 });
    if (url.pathname.endsWith("/media/upload")) return Response.json({ errcode: 0, media_id: "synthetic-media" });
    assert.equal(url.pathname, "/cgi-bin/message/send");
    const body = JSON.parse(init.body);
    assert.equal(body.touser, "operator");
    assert.equal(body.agentid, config.agentId);
    assert.equal(body.msgtype, "image");
    assert.equal(body.toparty, undefined);
    assert.equal(body.totag, undefined);
    assert.equal(body.enable_duplicate_check, 1);
    if (options.timeout) throw new Error("timeout");
    return Response.json({ errcode: options.reject ? 81013 : 0, msgid: "synthetic-message", invaliduser: options.invalid ? "operator" : "" });
  };
  return { fetcher, calls };
}
test("official WeCom image path is a single member-directed application message", async () => {
  const { fetcher, calls } = mock();
  assert.deepEqual(await sendWecomImage(png, config, fetcher), { status: "accepted", msgid: "synthetic-message" });
  assert.equal(calls.length, 5);
  assert.equal(calls.filter(c => c.url.pathname.endsWith("/message/send")).length, 1);
});
test("inactive recipient, broadcast targeting and malformed images never send", async () => {
  const { fetcher, calls } = mock({ inactive: true });
  await assert.rejects(sendWecomImage(png, config, fetcher), /not an active member/);
  assert.equal(calls.some(c => c.url.pathname.endsWith("/media/upload")), false);
  for (const userId of ["@all", "operator|another"]) {
    await assert.rejects(sendWecomImage(png, { ...config, userId }, fetcher), /exactly one member/);
  }
  await assert.rejects(sendWecomImage(Buffer.from("bad"), config, fetcher), /PNG/);
});
test("invalid recipients and rejected/ambiguous sends are not successful and never retried", async () => {
  for (const options of [{ invalid: true }, { reject: true }, { timeout: true }]) {
    const { fetcher, calls } = mock(options);
    await assert.rejects(sendWecomImage(png, config, fetcher), /rejected|errcode|UNKNOWN/);
    assert.equal(calls.filter(c => c.url.pathname.endsWith("/message/send")).length, 1);
  }
});
