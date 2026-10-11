import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { pool } from "../src/lib/db";
import { POST } from "../src/app/api/[...path]/route";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Receipt tests require the isolated loopback test database");
}
process.env.WECHAT_VERIFY_TOKEN = "synthetic-receipt-token";
process.env.WECHAT_OPEN_ID = "synthetic-recipient";
const timestamp = String(Math.floor(Date.now() / 1000)), nonce = "synthetic";
const signature = createHash("sha1").update([process.env.WECHAT_VERIFY_TOKEN, timestamp, nonce].sort().join("")).digest("hex");
const url = `https://example.com/our-days/api/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}`;
const mass = `<xml><FromUserName>mphelper</FromUserName><MsgType>event</MsgType>
  <Event>MASSSENDJOBFINISH</Event><MsgID>18446744073709551613</MsgID><Status>send success</Status>
  <TotalCount>1</TotalCount><FilterCount>0</FilterCount><SentCount>0</SentCount><ErrorCount>0</ErrorCount></xml>`;
async function receive(body: string, target = url) {
  return POST(new NextRequest(target, { method: "POST", body }), { params: Promise.resolve({ path: ["wechat", "callback"] }) });
}
try {
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query("TRUNCATE wechat_receipts,wechat_mass_receipts");
  assert.equal((await receive(mass, url.replace(signature, "0".repeat(40)))).status, 403);
  assert.equal((await receive(mass)).status, 200);
  assert.equal((await receive(mass)).status, 200);
  const rows = (await pool.query("SELECT * FROM wechat_mass_receipts")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_id, "18446744073709551613");
  assert.equal(rows[0].total_count, 1);
  assert.equal(rows[0].sent_count, 0);
  assert.equal(rows[0].status, "send success");
  assert.equal((await receive(mass.replace("<ErrorCount>0</ErrorCount>", ""))).status, 400);
  assert.equal((await receive(mass.replace("mphelper", "synthetic-recipient"))).status, 400);
  const template = `<xml><FromUserName>synthetic-recipient</FromUserName><MsgType>event</MsgType>
    <Event>TEMPLATESENDJOBFINISH</Event><MsgID>18446744073709551614</MsgID><Status>success</Status></xml>`;
  assert.equal((await receive(template)).status, 200);
  assert.equal((await pool.query("SELECT status FROM wechat_receipts")).rows[0].status, "delivered");
  console.log("Receipt integration passed: signature, mass counters, zero-recipient success, deduplication, validation, template regression.");
} finally { await pool.end(); }
