import assert from "node:assert/strict";
import { test } from "node:test";
import { createCipheriv, createHash } from "node:crypto";
import { decryptWecomCallback, wecomEncryptedBody } from "../src/lib/wecom-callback";

test("WeCom encrypted URL verification checks signature, receiver, age and padding", () => {
  const key = Buffer.alloc(32, 7);
  const settings = { token: "syntheticToken", aes: key.toString("base64").slice(0, -1), corp: "wwSynthetic" };
  const message = Buffer.from("verification-echo");
  const header = Buffer.alloc(20); header.writeUInt32BE(message.length, 16);
  const body = Buffer.concat([header, message, Buffer.from(settings.corp)]);
  const padding = 32 - body.length % 32;
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([body, Buffer.alloc(padding, padding)])), cipher.final()]).toString("base64");
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = "42";
  const sig = createHash("sha1").update([settings.token, timestamp, nonce, encrypted].sort().join("")).digest("hex");
  const url = new URL(`https://example.com?timestamp=${timestamp}&nonce=${nonce}&msg_signature=${sig}`);
  assert.equal(decryptWecomCallback(url, encrypted, settings).toString(), message.toString());
  assert.throws(() => decryptWecomCallback(url, encrypted, { ...settings, corp: "wwWrong" }));
  assert.throws(() => decryptWecomCallback(url, encrypted, settings, Date.now() + 301000));
  assert.throws(() => decryptWecomCallback(url, encrypted + "a", settings));
  url.searchParams.set("msg_signature", "0".repeat(40));
  assert.throws(() => decryptWecomCallback(url, encrypted, settings));
  assert.equal(wecomEncryptedBody(`<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`), encrypted);
  assert.throws(() => wecomEncryptedBody('<!DOCTYPE xml><xml/>'));
});
