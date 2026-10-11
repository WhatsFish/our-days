import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/lib/auth";
import { pool } from "../src/lib/db";

if (!process.stdout.isTTY) {
  console.error("Run interactively: generated pairing codes must not enter logs or pipelines.");
  process.exitCode = 1;
} else {
  for (const role of ["ADMIN", "READER"]) {
    const code = randomBytes(18).toString("base64url");
    console.log(`${role} pairing code (share privately): ${code}`);
    console.log(`${role}_PASSWORD_HASH='${hashPassword(code)}'`);
  }
}
await pool.end();
