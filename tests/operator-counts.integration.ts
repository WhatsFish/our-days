import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/lib/db";
import { OPERATOR_COUNTS_SQL } from "../src/lib/operator-status";

if (process.env.PG_HOST !== "127.0.0.1" || process.env.PG_PORT !== "54326" || process.env.PG_DB !== "our_days_test") {
  throw new Error("Operator counts require the isolated database");
}
try {
  await pool.query("TRUNCATE photos,editions,deliveries,favorites,imports CASCADE");
  const ids = Array.from({ length: 6 }, () => randomUUID());
  for (let i = 0; i < ids.length; i++) {
    await pool.query("INSERT INTO photos(id,sha256,original_ext,original_bytes,approved,caption) VALUES($1,$2,'jpg',1,$3,'synthetic')",
      [ids[i], randomUUID(), i !== 4]);
  }
  const states = ["accepted", "delivered", "failed", "unknown"];
  for (let i = 0; i < states.length; i++) {
    const edition = randomUUID();
    await pool.query("INSERT INTO editions(id,day,photo_id,title,send_at) VALUES($1,'2020-01-01'::date+$2::int,$3,'synthetic',now())",
      [edition, i, ids[i]]);
    await pool.query("INSERT INTO deliveries(id,edition_id,channel,status) VALUES($1,$2,'wecom',$3)", [randomUUID(), edition, states[i]]);
  }
  await pool.query("INSERT INTO imports(id,ext) VALUES($1,'image')", [randomUUID()]);
  const row = (await pool.query(OPERATOR_COUNTS_SQL)).rows[0];
  assert.equal(row.photos, 6); assert.equal(row.unreviewed, 1); assert.equal(row.ready, 1);
  assert.equal(row.submitted, 2); assert.equal(row.provider_delivered, 1);
  assert.equal(row.failed, 1); assert.equal(row.unknown, 1); assert.equal(row.pending_import, 1);
  console.log("Operator counts passed: exact unused stock, unreviewed, accepted vs delivered, failed, unknown and pending imports.");
} finally { await pool.end(); }
