import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/[...path]/route";
import { pool } from "../src/lib/db";
import { cookieName, tokenHash } from "../src/lib/auth";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Ark configuration tests require the isolated database");
}
const dir = await mkdtemp(path.join(tmpdir(), "our-days-ark-test-"));
const previousDir = process.env.PRIVATE_CONFIG_DIR;
const previousUrl = process.env.PUBLIC_URL;
process.env.PRIVATE_CONFIG_DIR = dir;
process.env.PUBLIC_URL = "https://example.com/our-days";
const secret = "synthetic-ark-key-only-for-tests";
const adminToken = randomBytes(32).toString("hex");
const readerToken = randomBytes(32).toString("hex");
const file = path.join(dir, "ark-image.json");
const captionFile = path.join(dir, "ai.json");
const captionConfig = '{"provider":"zhipu","apiKey":"synthetic-independent-caption-key"}';
const originalFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; throw new Error("No external calls allowed when saving credentials"); };
async function request(method: "GET" | "POST", token?: string, data?: unknown, origin = "https://example.com") {
  const req = new NextRequest("https://example.com/our-days/api/image/config", {
    method,
    headers: {
      ...(token ? { Cookie: `${cookieName}=${token}` } : {}),
      ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(data) } : {}),
  });
  const result = await (method === "GET" ? GET : POST)(req, { params: Promise.resolve({ path: ["image", "config"] }) });
  const body = await result.text();
  assert.ok(!body.includes(secret), "API responses must never echo the secret");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  return { status: result.status, body: JSON.parse(body) };
}
try {
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query("INSERT INTO sessions VALUES($1,'admin',now()+interval '1 hour'),($2,'reader',now()+interval '1 hour')",
    [tokenHash(adminToken), tokenHash(readerToken)]);
  const before = (await pool.query("SELECT to_jsonb(s) AS s FROM settings s")).rows;
  await writeFile(captionFile, captionConfig, { mode: 0o600 });
  for (const method of ["GET", "POST"] as const) {
    assert.equal((await request(method, undefined, { apiKey: secret })).status, 401);
    assert.equal((await request(method, readerToken, { apiKey: secret })).status, 403);
  }
  assert.equal((await request("POST", adminToken, { apiKey: secret }, "https://wrong.example")).status, 403);
  assert.deepEqual((await request("GET", adminToken)).body, { provider: "ark", keyConfigured: false });
  assert.equal((await request("POST", adminToken, {})).status, 400);
  assert.equal((await request("POST", adminToken, { apiKey: "bad\nheader" })).status, 400);
  assert.equal((await request("POST", adminToken, { apiKey: secret, clearKey: true })).status, 400);
  const saved = await request("POST", adminToken, { apiKey: secret });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { provider: "ark", keyConfigured: true });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8")).apiKey, secret);
  assert.equal((await request("GET", adminToken)).body.keyConfigured, true);
  assert.equal((await request("POST", adminToken, { apiKey: "" })).status, 200);
  assert.equal(JSON.parse(await readFile(file, "utf8")).apiKey, secret, "Blank preserves the key");
  const replacements = ["synthetic-replacement-one", "synthetic-replacement-two"];
  const concurrent = await Promise.all(replacements.map(apiKey => request("POST", adminToken, { apiKey })));
  assert.ok(concurrent.every(result => result.status === 200));
  assert.ok(replacements.includes(JSON.parse(await readFile(file, "utf8")).apiKey));
  assert.equal((await readdir(dir)).some(name => name.endsWith(".pending")), false);
  assert.equal(await readFile(captionFile, "utf8"), captionConfig, "Image settings never overwrite caption settings");
  assert.equal((await request("POST", adminToken, { clearKey: true })).body.keyConfigured, false);
  assert.equal(JSON.parse(await readFile(file, "utf8")).apiKey, "");
  await writeFile(file, "{invalid");
  const corrupt = await request("GET", adminToken);
  assert.equal(corrupt.status, 503, "Corrupt storage must fail explicitly, not pretend no key is configured");
  assert.equal((await request("POST", adminToken, { apiKey: secret })).status, 503);
  assert.equal(await readFile(file, "utf8"), "{invalid", "Corrupt storage is not silently overwritten");
  process.env.PRIVATE_CONFIG_DIR = "relative-path";
  assert.equal((await request("GET", adminToken)).status, 503);
  assert.equal(externalCalls, 0);
  assert.deepEqual((await pool.query("SELECT to_jsonb(s) AS s FROM settings s")).rows, before);
  console.log("Ark credential checks passed: admin/origin guards, write-only responses, 0600 persistence, blank preservation, replacement/deletion, concurrent atomic saves, independent captions, explicit storage failures and zero external calls.");
} finally {
  globalThis.fetch = originalFetch;
  if (previousDir === undefined) delete process.env.PRIVATE_CONFIG_DIR; else process.env.PRIVATE_CONFIG_DIR = previousDir;
  if (previousUrl === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = previousUrl;
  await pool.query("DELETE FROM sessions WHERE token_hash=ANY($1::text[])", [[tokenHash(adminToken), tokenHash(readerToken)]]);
  await pool.end();
  for (const name of await readdir(dir)) await unlink(path.join(dir, name));
  await rmdir(dir);
}
