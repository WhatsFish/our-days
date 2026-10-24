import assert from "node:assert/strict";
import { test } from "node:test";
import { sendWecomImage } from "../scripts/wecom-image-probe.mjs";
import { wecomRecipients } from "../src/lib/wecom-image.mjs";

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
    if (url.pathname.endsWith("/user/get")) {
      const userid = url.searchParams.get("userid");
      return Response.json({ errcode: 0, userid, status: options.inactive || options.inactiveSecond && userid === "partner" ? 4 : 1 });
    }
    if (url.pathname.endsWith("/media/upload")) return Response.json({ errcode: 0, media_id: "synthetic-media" });
    assert.equal(url.pathname, "/cgi-bin/message/send");
    const body = JSON.parse(init.body);
    assert.equal(body.touser, options.dual ? "operator|partner" : "operator");
    assert.equal(body.agentid, config.agentId);
    assert.equal(body.msgtype, "image");
    assert.equal(body.toparty, undefined);
    assert.equal(body.totag, undefined);
    assert.equal(body.enable_duplicate_check, 1);
    if (options.timeout) throw new Error("timeout");
    if (options.invalidJSON) return new Response("bad");
    if (options.httpError) return new Response("", { status: 502 });
    return Response.json({ errcode: options.reject ? 81013 : 0,
      ...(options.noMessageId ? {} : { msgid: "synthetic-message" }),
      invaliduser: options.invalid ? "operator" : options.partial ? "partner" : options.unexpected ? "stranger" : "",
      unlicenseduser: options.unlicensed ? "partner" : "" });
  };
  return { fetcher, calls };
}
test("official WeCom image path is a single member-directed application message", async () => {
  const { fetcher, calls } = mock();
  assert.deepEqual(await sendWecomImage(png, config, fetcher), {
    status: "accepted", msgid: "synthetic-message", recipients: [{ userId: "operator", status: "accepted" }],
  });
  assert.equal(calls.length, 5);
  assert.equal(calls.filter(c => c.url.pathname.endsWith("/message/send")).length, 1);
});
test("inactive recipient, broadcast targeting and malformed images never send", async () => {
  const { fetcher, calls } = mock({ inactive: true });
  await assert.rejects(sendWecomImage(png, config, fetcher), /not an active member/);
  assert.equal(calls.some(c => c.url.pathname.endsWith("/media/upload")), false);
  for (const userId of ["@all", "operator|@all", "operator|", "operator|Operator", "a|b|c", "operator;partner", "operator\npartner"]) {
    await assert.rejects(sendWecomImage(png, { ...config, userId }, fetcher), /one or two distinct/);
  }
  await assert.rejects(sendWecomImage(Buffer.from("bad"), config, fetcher), /PNG/);
});
test("both explicit active members receive the exact same uploaded media in one submission", async () => {
  const { fetcher, calls } = mock({ dual: true });
  const result = await sendWecomImage(png, { ...config, userId: "operator|partner" }, fetcher);
  assert.deepEqual(result.recipients, [{ userId: "operator", status: "accepted" }, { userId: "partner", status: "accepted" }]);
  assert.equal(calls.filter(c => c.url.pathname.endsWith("/user/get")).length, 2);
  const uploads = calls.filter(c => c.url.pathname.endsWith("/media/upload"));
  assert.equal(uploads.length, 1);
  assert.deepEqual(Buffer.from(await uploads[0].init.body.get("media").arrayBuffer()), png);
  const submissions = calls.filter(c => c.url.pathname.endsWith("/message/send"));
  assert.equal(submissions.length, 1);
  assert.equal(JSON.parse(submissions[0].init.body).image.media_id, "synthetic-media");
  assert.deepEqual(wecomRecipients("operator|partner"), ["operator", "partner"]);
});
test("inactive second member prevents submission to either member", async () => {
  const { fetcher, calls } = mock({ dual: true, inactiveSecond: true });
  await assert.rejects(sendWecomImage(png, { ...config, userId: "operator|partner" }, fetcher), /not an active member/);
  assert.equal(calls.some(c => c.url.pathname.endsWith("/media/upload")), false);
  assert.equal(calls.some(c => c.url.pathname.endsWith("/message/send")), false);
});
test("partial rejection preserves individual outcomes and forbids resending to accepted recipients", async () => {
  for (const option of [{ partial: true }, { unlicensed: true }]) {
    const { fetcher, calls } = mock({ dual: true, ...option });
    await assert.rejects(sendWecomImage(png, { ...config, userId: "operator|partner" }, fetcher), error => {
      assert.equal(error.unknown, true);
      assert.equal(error.recordId, "synthetic-message");
      assert.deepEqual(error.recipients, [{ userId: "operator", status: "accepted" }, { userId: "partner", status: "failed" }]);
      return true;
    });
    assert.equal(calls.filter(c => c.url.pathname.endsWith("/message/send")).length, 1);
  }
});
test("ambiguous group outcomes stay unknown without retries or false acceptance", async () => {
  for (const option of [{ unexpected: true }, { timeout: true }, { noMessageId: true }, { invalidJSON: true }, { httpError: true }]) {
    const { fetcher, calls } = mock({ dual: true, ...option });
    await assert.rejects(sendWecomImage(png, { ...config, userId: "operator|partner" }, fetcher), error => {
      assert.equal(error.unknown, true);
      assert.deepEqual(error.recipients, [{ userId: "operator", status: "unknown" }, { userId: "partner", status: "unknown" }]);
      return true;
    });
    assert.equal(calls.filter(c => c.url.pathname.endsWith("/message/send")).length, 1);
  }
});
test("invalid recipients and rejected/ambiguous sends are not successful and never retried", async () => {
  for (const options of [{ invalid: true }, { reject: true }, { timeout: true }]) {
    const { fetcher, calls } = mock(options);
    await assert.rejects(sendWecomImage(png, config, fetcher), /rejected|errcode|UNKNOWN/);
    assert.equal(calls.filter(c => c.url.pathname.endsWith("/message/send")).length, 1);
  }
});
