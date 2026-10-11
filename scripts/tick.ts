import { pool } from "../src/lib/db";
import { AppError } from "../src/lib/domain";
import { tick } from "../src/lib/worker";

try { await tick(); }
catch (error) {
  console.error("[our-days] tick failed:", error instanceof AppError ? error.code : "infrastructure_error");
  process.exitCode = 1;
} finally { await pool.end(); }
