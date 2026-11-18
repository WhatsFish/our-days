import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { AppError } from "./domain";
import { transaction } from "./db";

const apiKey = z.string().trim().min(8).max(512).regex(/^[a-zA-Z0-9_.-]+$/).or(z.literal(""));
const storedSchema = z.object({ provider: z.literal("ark"), apiKey }).strict();
export const arkConfigInput = z.object({
  apiKey: apiKey.optional(),
  clearKey: z.boolean().default(false),
}).strict();
export type PublicArk = { provider: "ark"; keyConfigured: boolean };

function configPath() {
  const dir = process.env.PRIVATE_CONFIG_DIR;
  if (!dir || !path.isAbsolute(dir)) throw new AppError(503, "ark_storage", "图片生成私密配置存储未配置");
  return path.join(dir, "ark-image.json");
}

async function stored() {
  try { return storedSchema.parse(JSON.parse(await readFile(configPath(), "utf8"))); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof AppError) throw error;
    throw new AppError(503, "ark_storage", "火山方舟配置读取失败，请检查私密存储");
  }
}

export async function arkSettings(): Promise<PublicArk> {
  const config = await stored();
  return { provider: "ark", keyConfigured: !!config?.apiKey };
}

export async function arkImageKey() {
  const config = await stored();
  if (!config?.apiKey) throw new AppError(503, "ark_key_missing", "请先保存火山方舟图片 API Key");
  return config.apiKey;
}

export async function saveArkSettings(input: unknown): Promise<PublicArk> {
  const data = arkConfigInput.parse(input);
  if (data.clearKey && data.apiKey) throw new AppError(400, "ark_key", "不能同时删除和替换密钥");
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(7316,6)");
    const previous = await stored();
    const next = { provider: "ark" as const, apiKey: data.clearKey ? "" : data.apiKey || previous?.apiKey || "" };
    if (!next.apiKey && !data.clearKey) throw new AppError(400, "ark_key", "请填写火山方舟 API Key");
    const file = configPath();
    const temp = `${file}.${randomUUID()}.pending`;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      await rename(temp, file);
    } catch {
      try { await unlink(temp); }
      catch (cleanup) {
        if (!(cleanup instanceof Error && "code" in cleanup && cleanup.code === "ENOENT")) console.warn("[our-days] ark_config_cleanup_failed");
      }
      throw new AppError(503, "ark_storage", "火山方舟配置保存失败，未完成更新");
    }
    return { provider: "ark", keyConfigured: !!next.apiKey };
  });
}
