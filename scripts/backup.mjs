import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rmdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const media = "/data/our-days";
const backups = "/data/our-days-backups";
const privateConfig = "/data/our-days-config";
const keyFile = path.join(homedir(), ".config/our-days-backup.key");
const magic = Buffer.from("OURDAYS1");
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${executable} failed (exit ${result.status}); no private output logged`);
  return result.stdout;
}
async function waitForWeb() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:3016/our-days/api/health", { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).status === "ok") return;
    } catch {
      // Startup connection failures are expected only within this bounded window.
    }
    await delay(1000);
  }
  throw new Error("Web did not become healthy after backup; heartbeat will not be advanced");
}
async function key(create = false) {
  try { return Buffer.from((await readFile(keyFile, "utf8")).trim(), "hex"); }
  catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    const value = randomBytes(32);
    await writeFile(keyFile, value.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    return value;
  }
}
export async function decryptBackup(source, target) {
  const size = (await stat(source)).size;
  if (size < 36) throw new Error("Backup is truncated");
  const file = await open(source, "r");
  const header = Buffer.alloc(20), tag = Buffer.alloc(16);
  try { await file.read(header, 0, 20, 0); await file.read(tag, 0, 16, size - 16); }
  finally { await file.close(); }
  if (!header.subarray(0, 8).equals(magic)) throw new Error("Unknown backup format");
  const decipher = createDecipheriv("aes-256-gcm", await key(), header.subarray(8));
  decipher.setAuthTag(tag);
  // Callers must not extract the archive until authentication succeeds.
  await pipeline(createReadStream(source, { start: 20, end: size - 17 }), decipher, createWriteStream(target, { flags: "wx", mode: 0o600 }));
}
async function backup() {
  await mkdir(backups, { recursive: true, mode: 0o700 });
  await chmod(backups, 0o700);
  const space = await statfs(backups);
  if (space.bavail * space.bsize < 1.6 * 1024 ** 3) throw new Error("Less than 1.6GiB free; refusing to risk filling the OS disk");
  const temp = await mkdtemp(path.join(backups, ".pending-"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(backups, `${stamp}.tar.enc`);
  const pending = path.join(temp, "backup.enc");
  const running = command("docker", ["inspect", "our-days-web-1", "--format", "{{.State.Running}}"]).trim() === "true";
  try {
    if (running) command("docker", ["compose", "stop", "--timeout", "10", "web"], { cwd: root });
    const dump = command("docker", ["exec", "traffic-monitor-db-1", "pg_dump", "-U", "umami", "--no-owner", "--no-acl", "our_days"]);
    await writeFile(path.join(temp, "database.sql"), dump, { mode: 0o600, flag: "wx" });
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", await key(true), iv);
    await writeFile(pending, Buffer.concat([magic, iv]), { mode: 0o600, flag: "wx" });
    const tar = spawn("sudo", ["-n", "tar", "-czf", "-", "-C", media, ".", "-C", temp, "database.sql",
      "-C", path.dirname(privateConfig), path.basename(privateConfig)], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve, reject) => {
      tar.once("error", reject);
      tar.once("exit", code => code === 0 ? resolve() : reject(new Error("Photo archive failed")));
    });
    tar.stderr.resume();
    await Promise.all([pipeline(tar.stdout, cipher, createWriteStream(pending, { flags: "a" })), exited]);
    await appendFile(pending, cipher.getAuthTag());
    const verified = path.join(temp, "verified.tar.gz");
    await decryptBackup(pending, verified);
    command("tar", ["-tzf", verified]);
    await rename(pending, target);
    const snapshots = (await readdir(backups)).filter(name => /^[0-9TZ-]+\.tar\.enc$/.test(name)).sort();
    for (const old of snapshots.slice(0, -2)) await unlink(path.join(backups, old));
  } finally {
    try {
      if (running) {
        command("docker", ["compose", "up", "-d", "--no-build", "web"], { cwd: root });
        await waitForWeb();
      }
    }
    finally {
      for (const name of await readdir(temp)) await unlink(path.join(temp, name));
      await rmdir(temp);
    }
  }
  console.log("Encrypted backup authenticated; web readiness confirmed; retaining the latest two snapshots.");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--run")) throw new Error("Run with --run, under the same flock as the publication worker");
  await backup();
}
