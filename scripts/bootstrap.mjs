import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (!process.argv.includes("--approve-new-secrets")) throw new Error("Explicit --approve-new-secrets is required");
const publicUrl = new URL(process.env.OUR_DAYS_PUBLIC_URL ?? "");
if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/our-days" || publicUrl.username || publicUrl.password ||
    publicUrl.search || publicUrl.hash || publicUrl.href.includes("'")) throw new Error("Provide an HTTPS OUR_DAYS_PUBLIC_URL ending in /our-days");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(homedir(), ".config");
const config = path.join(configDir, "our-days.env");
const access = path.join(configDir, "our-days-access.json");
const monitorConfig = path.join(configDir, "our-days-monitor.env");
const envLink = path.join(root, ".env");
if ([config, access, monitorConfig, envLink].some(existsSync)) throw new Error("Project configuration already exists; refusing to overwrite secrets");
const statusEnv = await realpath(path.join(root, "../status/.env"));
const existingStatus = await readFile(statusEnv, "utf8");
if (/^OUR_DAYS_PG_/m.test(existingStatus)) throw new Error("Status credentials already exist; refusing to replace them");

function sql(database, statement, user = "umami", password) {
  const args = ["exec", "-i"];
  if (password) args.push("-e", "PGPASSWORD");
  args.push("traffic-monitor-db-1", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At",
    "-U", user, "-d", database);
  if (password) args.push("-h", "127.0.0.1");
  const result = spawnSync("docker", args, {
    input: statement, encoding: "utf8",
    env: password ? { ...process.env, PGPASSWORD: password } : process.env,
  });
  if (result.status !== 0) throw new Error(`Database setup failed (${database}); credentials retained, no SQL logged`);
  return result.stdout.trim();
}
if (sql("umami", "SELECT rolname FROM pg_roles WHERE rolname IN ('our_days','our_days_monitor'); SELECT datname FROM pg_database WHERE datname='our_days';")) {
  throw new Error("Target role or database already exists; refusing to claim an existing service");
}
const secret = () => randomBytes(32).toString("hex");
const password = secret(), monitorPassword = secret();
const codes = { admin: randomBytes(18).toString("base64url"), reader: randomBytes(18).toString("base64url") };
const hash = code => { const salt = randomBytes(16).toString("hex"); return `${salt}:${scryptSync(code, salt, 64).toString("hex")}`; };
const values = {
  PUBLIC_URL: publicUrl.href, PG_HOST: "db", PG_PORT: "5432", PG_USER: "our_days", PG_PASSWORD: password, PG_DB: "our_days",
  ADMIN_PASSWORD_HASH: hash(codes.admin), READER_PASSWORD_HASH: hash(codes.reader),
  MEDIA_ROOT: "/data/our-days", OUR_DAYS_DATA_DIR: "/data/our-days", MEDIA_QUOTA_MB: "200",
  PUSH_ENABLED: "false", PUSH_CHANNEL: "wechat-test", WECHAT_VERIFY_TOKEN: secret(),
  WECHAT_APP_ID: "", WECHAT_APP_SECRET: "", WECHAT_OPEN_ID: "", WECHAT_TEMPLATE_ID: "",
  PUSHPLUS_TOKEN: "", PUSHPLUS_TO: "", PUSHPLUS_SECRET_KEY: "",
  AI_ENABLED: "false", AI_MONTHLY_USD_LIMIT: "5",
  NEXT_PUBLIC_UMAMI_SRC: "", NEXT_PUBLIC_UMAMI_WEBSITE_ID: "",
};
const render = values => Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n";
await mkdir(configDir, { recursive: true, mode: 0o700 });
await writeFile(config, render(values), { flag: "wx", mode: 0o600 });
await writeFile(access, JSON.stringify({ url: publicUrl.href, ...codes }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const monitor = { OUR_DAYS_PG_USER: "our_days_monitor", OUR_DAYS_PG_PASSWORD: monitorPassword, OUR_DAYS_PG_DB: "our_days" };
await writeFile(monitorConfig, render(monitor), { flag: "wx", mode: 0o600 });
await symlink(config, envLink);
sql("umami", `
CREATE ROLE our_days LOGIN PASSWORD '${password}';
CREATE ROLE our_days_monitor LOGIN PASSWORD '${monitorPassword}';
CREATE DATABASE our_days OWNER our_days;
REVOKE ALL ON DATABASE our_days FROM PUBLIC;
GRANT CONNECT ON DATABASE our_days TO our_days,our_days_monitor;
`);
sql("our_days", await readFile(path.join(root, "db/schema.sql"), "utf8"), "our_days", password);
sql("our_days", "GRANT USAGE ON SCHEMA public TO our_days_monitor; GRANT SELECT ON service_health TO our_days_monitor;", "our_days", password);
const backup = path.join(configDir, "our-days-status-env-before");
await copyFile(statusEnv, backup);
await chmod(backup, 0o600);
const stagedStatus = `${statusEnv}.our-days-pending`;
await writeFile(stagedStatus, existingStatus + "\n" + render(monitor), { mode: 0o600, flag: "wx" });
await rename(stagedStatus, statusEnv);
await chmod(statusEnv, 0o600);
console.log(`Project configuration: ${config}`);
console.log(`Pairing codes (read privately): ${access}`);
console.log("Database and read-only health monitor ready; real sending and AI remain disabled.");
