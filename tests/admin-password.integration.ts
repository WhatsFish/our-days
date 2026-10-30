import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/[...path]/route";
import { pool } from "../src/lib/db";
import { hashPassword, tokenHash } from "../src/lib/auth";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Password tests require isolated database");
}
Object.assign(process.env, {
  PUBLIC_URL: "https://example.com/our-days",
  ADMIN_PASSWORD_HASH: hashPassword("synthetic-legacy-code"),
  READER_PASSWORD_HASH: hashPassword("synthetic-reader-code"),
});
const password = "Abcdefg12";
async function post(route: string, data: unknown, origin = "https://example.com") {
  return POST(new NextRequest(`https://example.com/our-days/api/${route}`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data),
  }), { params: Promise.resolve({ path: route.split("/") }) });
}
const freshToken = async (expired = false) => {
  const token = randomBytes(32).toString("hex");
  await pool.query(`INSERT INTO admin_password_tokens VALUES($1,now()+$2::int*interval '1 hour',NULL)`, [tokenHash(token), expired ? -1 : 1]);
  return token;
};
try {
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query("TRUNCATE admin_credentials,admin_password_tokens,login_limits");
  const before = (await pool.query("SELECT to_jsonb(s) AS s FROM settings s")).rows;
  const legacy = await post("login", { role: "admin", username: "admin", password: "synthetic-legacy-code" });
  assert.equal(legacy.status, 200);
  const oldCookie = legacy.headers.get("set-cookie")!.split(";")[0];
  const token = await freshToken();
  const otherToken = await freshToken();
  const expired = await freshToken(true);
  assert.equal((await post("admin/password", { token, password: "short" })).status, 400);
  for (const invalid of ["Abcdef12", "123456789", "Abcdefghi", "Abcdefg1!", "Abc def12", "密码Abc123456", `A${"1".repeat(256)}`]) {
    assert.equal((await post("admin/password", { token, password: invalid })).status, 400,
      "New passwords require more than eight ASCII letters/digits, including both");
  }
  assert.equal((await post("admin/password", { token, password }, "https://wrong.example")).status, 403);
  assert.equal((await post("admin/password", { token: "a".repeat(64), password })).status, 400);
  assert.equal((await post("admin/password", { token: expired, password })).status, 400);
  const result = await post("admin/password", { token, password });
  assert.equal(result.status, 200);
  assert.equal((await result.text()).includes(password), false);
  assert.equal((await post("admin/password", { token, password })).status, 400, "Setup links are one use");
  assert.equal((await post("admin/password", { token: otherToken, password })).status, 400, "Other outstanding links are invalidated");
  const oldSession = await GET(new NextRequest("https://example.com/our-days/api/session", {
    headers: { Cookie: oldCookie },
  }), { params: Promise.resolve({ path: ["session"] }) });
  assert.equal((await oldSession.json()).role, null);
  assert.equal((await post("login", { role: "admin", username: "admin", password: "synthetic-legacy-code" })).status, 401);
  assert.equal((await post("login", { username: "wrong", password })).status, 401);
  assert.equal((await post("login", { username: "admin", password: "wrong" })).status, 401);
  for (let device = 0; device < 2; device++) {
    const login = await post("login", { username: "admin", password });
    assert.equal(login.status, 200, "Same password can log in on independent devices");
    assert.match(login.headers.get("set-cookie")!, /HttpOnly/i);
    assert.match(login.headers.get("set-cookie")!, /Secure/i);
    assert.match(login.headers.get("set-cookie")!, /Max-Age=604800/i);
  }
  assert.equal((await post("login", { role: "reader", password: "synthetic-reader-code" })).status, 200);
  const stored = (await pool.query("SELECT password_hash FROM admin_credentials")).rows[0].password_hash;
  assert.notEqual(stored, password);
  assert.ok(!stored.includes(password));
  assert.deepEqual((await pool.query("SELECT to_jsonb(s) AS s FROM settings s")).rows, before);
  await pool.query("UPDATE login_limits SET attempts=12 WHERE bucket='admin'");
  assert.equal((await post("login", { username: "admin", password })).status, 429);
  console.log("Admin password passed: one-use/expiry/origin/strong-password guards, hash-only persistence, legacy invalidation, session revocation, independent-device login, reader compatibility, rate limiting, unchanged settings.");
} finally {
  await pool.query("TRUNCATE admin_credentials,admin_password_tokens,login_limits");
  await pool.end();
}
