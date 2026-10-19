import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendWecomImage } from "../src/lib/wecom-image.mjs";
export { sendWecomImage } from "../src/lib/wecom-image.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--send-once") || !process.argv[2] || process.argv[2].startsWith("--")) {
    throw new Error("Explicit manual send: node scripts/wecom-image-probe.mjs DEMO.png --send-once");
  }
  if (process.env.PUSH_ENABLED !== "false") throw new Error("Keep automatic pushes disabled during this probe");
  const result = await sendWecomImage(await readFile(process.argv[2]), {
    corpId: process.env.WECOM_CORP_ID, secret: process.env.WECOM_APP_SECRET,
    agentId: Number(process.env.WECOM_AGENT_ID), userId: process.env.WECOM_USER_ID,
  });
  console.log(`WeCom accepted exactly one image, msgid=${result.msgid}; confirm receipt in ordinary WeChat, not only the WeCom app.`);
}
