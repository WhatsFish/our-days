import { randomBytes } from "node:crypto";
import { tokenHash } from "../src/lib/auth";
import { pool, transaction } from "../src/lib/db";

try {
  const url = new URL(process.env.PUBLIC_URL ?? "");
  if (url.protocol !== "https:") throw new Error("Password setup requires configured HTTPS");
  const token = randomBytes(32).toString("hex");
  const expires = await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(7316,5)");
    await client.query("UPDATE admin_password_tokens SET used_at=now() WHERE used_at IS NULL");
    const result = await client.query<{ expires_at: Date }>(
      "INSERT INTO admin_password_tokens(token_hash,expires_at) VALUES($1,now()+interval '24 hours') RETURNING expires_at",
      [tokenHash(token)]);
    return result.rows[0].expires_at;
  });
  url.pathname = `${url.pathname.replace(/\/$/, "")}/password`;
  url.hash = new URLSearchParams({ token }).toString();
  console.log(JSON.stringify({ setupUrl: url.href, expiresAt: expires, username: "admin", oneUse: true }));
} finally { await pool.end(); }
