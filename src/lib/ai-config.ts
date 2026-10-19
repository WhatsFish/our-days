import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { AppError } from "./domain";
import { transaction } from "./db";

const fields = z.object({
  enabled: z.boolean(),
  provider: z.enum(["deepseek", "openai", "zhipu"]),
  model: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/),
  inputRate: z.number().finite().min(0).max(10000).nullable(),
  outputRate: z.number().finite().min(0).max(10000).nullable(),
  monthlyLimit: z.number().finite().positive().max(1000).nullable(),
});
const key = z.string().trim().min(8).max(512).regex(/^[a-zA-Z0-9_.-]+$/);
const storedSchema = fields.extend({ apiKey: key.or(z.literal("")) });
export const aiConfigInput = fields.extend({ apiKey: key.or(z.literal("")).optional(), clearKey: z.boolean().default(false) });
export type StoredAI = z.infer<typeof storedSchema>;
export type PublicAI = Omit<StoredAI, "apiKey"> & { keyConfigured: boolean; source: "dashboard" };
export type AIConfiguration = {
  enabled: boolean; provider: string; model: string; apiKey: string; url: string;
  inputRate: number | null; outputRate: number | null; monthlyLimit: number | null;
};
const defaults: StoredAI = {
  enabled: false, provider: "deepseek", model: "deepseek-flash", apiKey: "",
  inputRate: null, outputRate: null, monthlyLimit: null,
};
function configPath() {
  const dir = process.env.PRIVATE_CONFIG_DIR;
  if (!dir || !path.isAbsolute(dir)) throw new AppError(503, "ai_storage", "AI 私密配置存储未配置");
  return path.join(dir, "ai.json");
}
async function stored(): Promise<StoredAI | null> {
  try { return storedSchema.parse(JSON.parse(await readFile(configPath(), "utf8"))); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof AppError) throw error;
    throw new AppError(503, "ai_storage", "AI 配置读取失败，请检查私密存储");
  }
}
export function publicAI(config: StoredAI): PublicAI {
  const { apiKey, ...safe } = config;
  return { ...safe, keyConfigured: !!apiKey, source: "dashboard" };
}
export async function aiSettings(): Promise<PublicAI> {
  return publicAI((await stored()) ?? defaults);
}
export async function saveAISettings(input: unknown): Promise<PublicAI> {
  const data = aiConfigInput.parse(input);
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(7316,4)");
    const previous = await stored();
    if (data.clearKey && data.apiKey) throw new AppError(400, "ai_key", "不能同时删除和替换密钥");
    if (previous && previous.provider !== data.provider && !data.apiKey && !data.clearKey) {
      throw new AppError(400, "ai_key", "更换供应商时请填写对应的新密钥或清除旧密钥");
    }
    const { clearKey, apiKey, ...rest } = data;
    const next = { ...rest, apiKey: clearKey ? "" : apiKey || previous?.apiKey || "" };
    if (next.enabled && !next.apiKey) {
      throw new AppError(400, "ai_config", "启用 AI 前请填写 API Key");
    }
    if (next.monthlyLimit !== null && (next.inputRate === null || next.outputRate === null)) {
      throw new AppError(400, "ai_config", "启用费用限额时需要填写输入、输出单价；或关闭限额，只记录 token 用量");
    }
    const file = configPath();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.pending`;
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      await rename(temp, file);
    } catch (error) {
      try { await unlink(temp); }
      catch (cleanup) {
        if (!(cleanup instanceof Error && "code" in cleanup && cleanup.code === "ENOENT")) console.warn("[our-days] ai_config_cleanup_failed");
      }
      throw new AppError(503, "ai_storage", "AI 配置保存失败，未完成更新");
    }
    return publicAI(next);
  });
}
export async function runtimeAI(): Promise<AIConfiguration> {
  const config = await stored();
  if (config) return {
    ...config,
    url: config.provider === "zhipu" ? "https://open.bigmodel.cn/api/paas/v4/chat/completions" :
      config.provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions",
  };
  return {
    enabled: process.env.AI_ENABLED === "true", provider: process.env.AI_PROVIDER ?? "foundry",
    apiKey: process.env.AI_API_KEY ?? "", url: process.env.AI_URL ?? "", model: process.env.AI_MODEL ?? "",
    inputRate: process.env.AI_INPUT_USD_PER_MILLION ? Number(process.env.AI_INPUT_USD_PER_MILLION) : null,
    outputRate: process.env.AI_OUTPUT_USD_PER_MILLION ? Number(process.env.AI_OUTPUT_USD_PER_MILLION) : null,
    monthlyLimit: process.env.AI_MONTHLY_USD_LIMIT === "none" ? null : Number(process.env.AI_MONTHLY_USD_LIMIT ?? 5),
  };
}
export async function testAIConnection(fetcher: typeof fetch = fetch) {
  const config = await stored();
  if (!config?.apiKey) throw new AppError(400, "ai_key", "请先保存 API Key");
  if (config.provider === "zhipu") {
    const { probeAIText } = await import("./ai");
    await probeAIText();
    return { ok: true, message: "智谱模型调用成功（仅固定测试文本，token 用量已记录；没有发送照片或回忆说明）" };
  }
  const url = config.provider === "deepseek" ? "https://api.deepseek.com/models" : "https://api.openai.com/v1/models";
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
    });
  } catch { throw new AppError(502, "ai_connection", "无法连接 AI 服务，请检查网络后重试"); }
  if (!response.ok) throw new AppError(502, "ai_connection", `AI 服务返回 HTTP ${response.status}，请检查密钥和账号权限`);
  const body = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(await response.json());
  if (!body.success) throw new AppError(502, "ai_connection", "AI 服务返回的模型列表格式无效");
  if (!body.data.data.some(model => model.id === config.model)) throw new AppError(400, "ai_model", "密钥已连接，但账号模型列表中没有所填模型，请核对模型名称");
  return { ok: true, message: "连接成功，密钥与模型可用；未发送照片或回忆文字，未调用生成接口" };
}
