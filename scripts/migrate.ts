import { readFile } from "node:fs/promises";
import { pool } from "../src/lib/db";

try {
  const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  await pool.query(schema);
  console.log("our-days schema ready");
} catch {
  console.error("our-days schema migration failed; verify database access");
  process.exitCode = 1;
} finally { await pool.end(); }
