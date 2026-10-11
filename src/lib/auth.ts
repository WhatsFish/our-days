import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { query } from "./db";
import { AppError } from "./domain";

export const cookieName = "our_days_session";
export function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored)) return false;
  const [salt, digest] = stored.split(":");
  return timingSafeEqual(Buffer.from(digest, "hex"), scryptSync(password, salt, 64));
}
export function checkOrigin(request: Request) {
  const configured = process.env.PUBLIC_URL;
  if (!configured) throw new AppError(503, "not_configured", "服务尚未配置");
  if (request.headers.get("origin") !== new URL(configured).origin) {
    throw new AppError(403, "origin", "请求来源不受信任");
  }
}
export async function roleFor(request: NextRequest): Promise<"admin" | "reader" | null> {
  const token = request.cookies.get(cookieName)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const rows = await query<{ role: "admin" | "reader" }>(
    "SELECT role FROM sessions WHERE token_hash=$1 AND expires_at>now()", [tokenHash(token)]);
  return rows[0]?.role ?? null;
}
export async function requireRole(request: NextRequest, admin = false) {
  const role = await roleFor(request);
  if (!role) throw new AppError(401, "login", "请先登录");
  if (admin && role !== "admin") throw new AppError(403, "admin", "需要管理权限");
  return role;
}
export async function login(role: "admin" | "reader", password: string) {
  const limits = await query<{ attempts: number }>(
    `INSERT INTO login_limits(bucket) VALUES ($1)
     ON CONFLICT(bucket) DO UPDATE SET
       attempts=CASE WHEN login_limits.started_at < now()-interval '15 minutes' THEN 1 ELSE login_limits.attempts+1 END,
       started_at=CASE WHEN login_limits.started_at < now()-interval '15 minutes' THEN now() ELSE login_limits.started_at END
     RETURNING attempts`, [role]);
  if (limits[0].attempts > 12) throw new AppError(429, "rate_limit", "尝试过于频繁，请 15 分钟后再试");
  const stored = process.env[role === "admin" ? "ADMIN_PASSWORD_HASH" : "READER_PASSWORD_HASH"];
  if (!stored) throw new AppError(503, "not_configured", "登录密钥尚未配置");
  if (!verifyPassword(password, stored)) throw new AppError(401, "credentials", "配对码不正确");
  const token = randomBytes(32).toString("hex");
  const seconds = role === "admin" ? 86400 * 7 : 86400 * 90;
  await query("INSERT INTO sessions VALUES($1,$2,now()+$3*interval '1 second')", [tokenHash(token), role, seconds]);
  return { token, seconds };
}
