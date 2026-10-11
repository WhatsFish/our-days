import assert from "node:assert/strict";
import { test } from "node:test";
import { sendNotice } from "../src/lib/push";
import { sendWechatNotice } from "../src/lib/wechat";

test("PushPlus separates acceptance, rejection and ambiguous transport failures", async () => {
  process.env.PUSH_ENABLED = "true";
  process.env.PUBLIC_URL = "https://example.com/our-days";
  process.env.PUSHPLUS_TOKEN = "synthetic";
  process.env.PUSHPLUS_TO = "synthetic-recipient";
  const accepted = await sendNotice("edition", async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.to, "synthetic-recipient");
    assert.equal(body.channel, "wechat");
    assert.equal(body.topic, undefined);
    assert.ok(!("photo" in body));
    return Response.json({ code: 200, data: "record-1" });
  });
  assert.equal(accepted.status, "accepted");
  assert.equal((await sendNotice("id", async () => Response.json({ code: 905 }))).status, "failed");
  assert.equal((await sendNotice("id", async () => { throw new Error("timeout"); })).status, "unknown");
  assert.equal((await sendNotice("id", async () => Response.json({ code: 200 }))).status, "unknown");
  process.env.PUSH_ENABLED = "false";
  await assert.rejects(sendNotice("id", async () => { throw new Error("must not call"); }), /未启用/);
});
test("WeChat test channel calls WeChat directly and never PushPlus", async () => {
  Object.assign(process.env, {
    PUSH_ENABLED: "true", PUBLIC_URL: "https://example.com/our-days",
    WECHAT_APP_ID: "synthetic-app", WECHAT_APP_SECRET: "synthetic-secret", WECHAT_OPEN_ID: "synthetic-recipient",
    WECHAT_TEMPLATE_ID: "synthetic-template", WECHAT_VERIFY_TOKEN: "synthetic-token",
  });
  let calls = 0;
  const result = await sendWechatNotice("11111111-1111-4111-8111-111111111111", "2026-10-11", async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.weixin.qq.com");
    if (url.pathname.endsWith("/token")) return Response.json({ access_token: "fake-token", expires_in: 7200 });
    assert.equal(url.pathname, "/cgi-bin/message/template/send");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.touser, "synthetic-recipient");
    assert.equal(body.data.date.value, "2026-10-11");
    return new Response('{"errcode":0,"msgid":18446744073709551615}');
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { status: "accepted", recordId: "18446744073709551615" });
  process.env.PUSH_ENABLED = "false";
});
