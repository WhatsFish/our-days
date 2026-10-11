import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { AppError, assertArchiveEntry, editionInput, localDay, photoEdit, settingsInput, validDay } from "../src/lib/domain";
import { checkOrigin, hashPassword, verifyPassword } from "../src/lib/auth";
import { parseWechatReceipt, verifyWechatSignature } from "../src/lib/wechat";
import { buildSnapshot } from "../src/lib/content";

test("date validation rejects overflow, handles leap days and recipient timezones", () => {
  assert.equal(validDay("2026-02-29"), false);
  assert.equal(validDay("2024-02-29"), true);
  assert.equal(validDay("2026-13-01"), false);
  const now = new Date("2026-10-10T23:30:00Z");
  assert.equal(localDay(now, "Asia/Shanghai"), "2026-10-11");
  assert.equal(localDay(now, "America/Los_Angeles"), "2026-10-10");
  assert.equal(editionInput.safeParse({ day: "2026-02-30", photo_id: "bad", title: "test" }).success, false);
});
test("approval needs a caption and settings need paired coordinates", () => {
  const photo = { id: "11111111-1111-4111-8111-111111111111", date_label: "", place_label: "", facts: "", caption: "", approved: true };
  assert.equal(photoEdit.safeParse(photo).success, false);
  assert.equal(photoEdit.safeParse({ ...photo, caption: "A real memory" }).success, true);
  assert.equal(settingsInput.safeParse({ timezone: "invalid", send_time: "25:99" }).success, false);
  assert.equal(settingsInput.safeParse({ timezone: "UTC", send_time: "08:00", paused: true, weather_lat: 0, weather_lon: null, weather_city: "", almanac: false, star_note: "" }).success, false);
});
test("ZIP traversal, oversized files and zip bombs are rejected", () => {
  assert.doesNotThrow(() => assertArchiveEntry("album/photo.jpg", 1000, 900));
  for (const name of ["../photo.jpg", "/photo.jpg", "a/../../photo.jpg", "a\\photo.jpg"]) {
    assert.throws(() => assertArchiveEntry(name, 1, 1), AppError);
  }
  assert.throws(() => assertArchiveEntry("huge.jpg", 26 * 1024 * 1024, 1000000), AppError);
  assert.throws(() => assertArchiveEntry("bomb.jpg", 1000000, 1), AppError);
});
test("password hashes are salted and verification fails closed", () => {
  const first = hashPassword("synthetic-test-code");
  const second = hashPassword("synthetic-test-code");
  assert.notEqual(first, second);
  assert.equal(verifyPassword("synthetic-test-code", first), true);
  assert.equal(verifyPassword("wrong", first), false);
  assert.equal(verifyPassword("anything", ""), false);
});
test("state changes require a trusted Origin", () => {
  process.env.PUBLIC_URL = "https://example.com/our-days";
  assert.doesNotThrow(() => checkOrigin(new Request("https://example.com", { headers: { origin: "https://example.com" } })));
  assert.throws(() => checkOrigin(new Request("https://example.com")), AppError);
  assert.throws(() => checkOrigin(new Request("https://example.com", { headers: { origin: "https://attacker.example" } })), AppError);
});
test("WeChat callback verifies signature age and preserves 64-bit IDs", () => {
  process.env.WECHAT_VERIFY_TOKEN = "synthetic-verification-token";
  const now = Date.parse("2026-10-11T00:00:00Z");
  const timestamp = String(now / 1000), nonce = "123";
  const signature = createHash("sha1").update([process.env.WECHAT_VERIFY_TOKEN, timestamp, nonce].sort().join("")).digest("hex");
  const url = new URL(`https://example.com?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}`);
  assert.doesNotThrow(() => verifyWechatSignature(url, now));
  assert.throws(() => verifyWechatSignature(url, now + 301000), AppError);
  url.searchParams.set("signature", "0".repeat(40));
  assert.throws(() => verifyWechatSignature(url, now), AppError);
  const result = parseWechatReceipt("<xml><FromUserName><![CDATA[test]]></FromUserName><MsgType>event</MsgType><Event>TEMPLATESENDJOBFINISH</Event><MsgID>18446744073709551615</MsgID><Status>success</Status></xml>");
  assert.equal(result.MsgID, "18446744073709551615");
  assert.throws(() => parseWechatReceipt('<!DOCTYPE x [<!ENTITY xx SYSTEM "file:///etc/passwd">]><xml/>'));
});
test("snapshot excludes metadata/facts and works without external calls", async () => {
  const snapshot = await buildSnapshot({
    id: "11111111-1111-4111-8111-111111111111", caption: "Approved words", approved: true,
    date_label: "Around 2020", place_label: "A city", facts: "ADMIN ONLY",
    captured_raw: null, latitude: 10, longitude: 20, used: 0,
  }, { timezone: "Asia/Shanghai", send_time: "08:00", paused: false, weather_lat: null, weather_lon: null, weather_city: "", almanac: true, star_note: "" }, "2026-10-11");
  assert.equal(snapshot.caption, "Approved words");
  assert.ok(snapshot.almanac.includes("宜"));
  assert.equal("facts" in snapshot, false);
  assert.equal("latitude" in snapshot, false);
});
