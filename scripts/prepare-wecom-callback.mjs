import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod, mkdtemp, unlink, rmdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const file = path.join(homedir(), ".config/our-days-wecom.env");
let text;
try { text = await readFile(file, "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; text = ""; }
const defaults = {
  WECOM_CORP_ID: "", WECOM_APP_SECRET: "", WECOM_AGENT_ID: "", WECOM_USER_ID: "",
  WECOM_CALLBACK_TOKEN: randomBytes(16).toString("hex"),
  WECOM_CALLBACK_AES_KEY: randomBytes(32).toString("base64").slice(0, -1),
};
for (const [name, value] of Object.entries(defaults)) {
  if (!text.split("\n").some(line => line.startsWith(name + "="))) text += `\n${name}='${value}'\n`;
}
await writeFile(file, text, { mode: 0o600 });
await chmod(file, 0o600);
function value(name) {
  const line = text.split("\n").find(line => line.startsWith(name + "="));
  return line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
}
const corp = value("WECOM_CORP_ID"), token = value("WECOM_CALLBACK_TOKEN"), aes = value("WECOM_CALLBACK_AES_KEY");
if ((corp && !/^ww[a-zA-Z0-9]+$/.test(corp)) || !/^[a-zA-Z0-9]{1,32}$/.test(token) || !/^[a-zA-Z0-9+/]{43}$/.test(aes)) {
  throw new Error("Invalid callback configuration; values not logged");
}
const temp = await mkdtemp(path.join(tmpdir(), "our-days-callback-"));
try {
  const source = path.join(temp, "callback.env");
  await writeFile(source, `WECOM_CORP_ID='${corp}'\nWECOM_CALLBACK_TOKEN='${token}'\nWECOM_CALLBACK_AES_KEY='${aes}'\n`, { mode: 0o600 });
  const result = spawnSync("sudo", ["-n", "install", "-m", "600", "-o", "10001", "-g", "10001", source, "/data/our-days-callback.env"]);
  if (result.status !== 0) throw new Error("Cannot install private callback configuration");
} finally { await unlink(path.join(temp, "callback.env")); await rmdir(temp); }
console.log("Private callback configuration synchronized; " + (corp ? "CorpID configured." : "fill WECOM_CORP_ID, then run this script again."));
