import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { query, transaction } from "./db";
import { AppError } from "./domain";
import { runtimeAI, type AIConfiguration } from "./ai-config";
import { AI_ACCOUNTING_CNY_PER_USD, AI_MONTHLY_CNY_LIMIT, GLM_FLASH_CONTEXT_TOKENS, costInCny, supportsPhotoCaption } from "./ai-policy";
import { captionSystemPrompt, prepareCaptionImage, type CaptionContext } from "./ai-caption";
import { mediaPath } from "./media";

async function logCentral(provider: string, model: string, input: number | null, output: number | null, cost: number | null, duration: number, task: string) {
  if (!process.env.COST_PG_USER) {
    console.warn("[our-days] cost_sink_unconfigured; retained in ai_events");
    return;
  }
  const client = new Client({
    host: process.env.COST_PG_HOST ?? "db", port: Number(process.env.COST_PG_PORT ?? 5432),
    user: process.env.COST_PG_USER, password: process.env.COST_PG_PASSWORD,
    database: process.env.COST_PG_DB ?? "cost_tracker", connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO cost_event(service,provider,model,input_tokens,output_tokens,cost_usd,duration_ms,metadata)
       VALUES('our-days',$1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [provider, model, input, output, cost, duration, JSON.stringify({ task, accounting_cny_per_usd: AI_ACCOUNTING_CNY_PER_USD, cost_basis: "estimate" })]);
  } catch {
    console.warn("[our-days] cost_sink_failed; retained in ai_events");
  } finally { await client.end(); }
}

export async function suggestCaption(id: string, style: string, factsDraft?: string, context: CaptionContext = {}) {
  const config = await runtimeAI();
  if (!config.enabled) throw new AppError(409, "ai_disabled", "AI 未启用，可在设置中配置或直接手写文案");
  const [photo] = await query<{ facts: string; date_label: string; place_label: string }>("SELECT facts,date_label,place_label FROM photos WHERE id=$1", [id]);
  if (!photo) throw new AppError(404, "not_found", "照片不存在");
  const facts = factsDraft ?? photo.facts;
  const withPhoto = supportsPhotoCaption(config.provider, config.model);
  if (!withPhoto && !facts.trim()) throw new AppError(400, "facts", "当前模型只生成文字文案，请先填写当时发生了什么");
  let image: string | undefined;
  if (withPhoto) {
    let source: Buffer;
    try { source = await readFile(mediaPath(id, "display.webp")); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new AppError(404, "ai_photo_missing", "找不到照片预览文件，未调用模型；请检查素材");
      }
      throw error;
    }
    image = await prepareCaptionImage(source);
  }
  return requestAIText(config, facts, style, "caption", image, {
    date_label: context.date_label ?? photo.date_label, place_label: context.place_label ?? photo.place_label,
  });
}

export async function probeAIText() {
  const config = await runtimeAI();
  return requestAIText(config, "连接测试", "只回复 OK", "connection_test");
}

async function requestAIText(config: AIConfiguration, facts: string, style: string, task: "caption" | "connection_test", image?: string, context: CaptionContext = {}) {
  const { url, apiKey: key, model, inputRate, outputRate, provider, currency } = config;
  if (!url || new URL(url).protocol !== "https:" || !key || !model ||
      (inputRate !== null && (!Number.isFinite(inputRate) || inputRate < 0)) ||
      (outputRate !== null && (!Number.isFinite(outputRate) || outputRate < 0)) ||
      inputRate === null || outputRate === null) {
    throw new AppError(503, "ai_config", "此模型缺少有效价格，无法执行每月 100 元限额；请选择预设模型或补充单价");
  }
  const reasoningOnly = provider === "zhipu" && /^glm-5\.3-flashx?$/i.test(model);
  const outputLimit = reasoningOnly ? (task === "connection_test" ? 2048 : 4096) : task === "connection_test" ? 32 : 800;
  const event = randomUUID();
  const system = task === "connection_test" ? "这是连接测试，只回复 OK。" :
    captionSystemPrompt + (image ? "" : "\n本次没有提供图片，只使用文字事实，不补写画面细节。");
  const user = JSON.stringify({ style, confirmed_facts: facts, ...context });
  // Reserve the full documented context ceiling until actual vision usage is returned.
  const inputLimit = image ? GLM_FLASH_CONTEXT_TOKENS : Buffer.byteLength(system + user, "utf8") + 256;
  const reserveNative = (inputLimit * inputRate + outputLimit * outputRate) / 1_000_000;
  const reserve = costInCny(reserveNative, currency);
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(7316,3)");
    const sum = await client.query<{ total: string; unknown_cost: number }>(
      `SELECT COALESCE(sum(COALESCE(cost_cny,cost_usd*$1)),0)::text AS total,
       count(*) FILTER(WHERE cost_cny IS NULL AND cost_usd IS NULL)::int AS unknown_cost
       FROM ai_events WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`,
      [AI_ACCOUNTING_CNY_PER_USD]);
    const recent = await client.query("SELECT id FROM ai_events WHERE created_at>now()-interval '30 seconds'");
    if (recent.rowCount) throw new AppError(429, "ai_rate", "请等待 30 秒再生成");
    if (sum.rows[0].unknown_cost > 0) throw new AppError(409, "ai_budget_unknown", "本月有历史调用费用未知，已暂停生成以保证 100 元限额；需要管理员核对历史账单");
    if (Number(sum.rows[0].total) + reserve > AI_MONTHLY_CNY_LIMIT) throw new AppError(429, "ai_budget", "本月 AI 100 元预算不足，已停止调用");
    await client.query("INSERT INTO ai_events(id,provider,model,cost_usd,cost_cny,status,task) VALUES($1,$2,$3,$4,$5,'reserved',$6)",
      [event, provider, model, reserve / AI_ACCOUNTING_CNY_PER_USD, reserve, task]);
  });
  let input: number | null = null, output: number | null = null, cost = reserve;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST", signal: AbortSignal.timeout(image ? 60000 : 30000), redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(provider === "foundry" ? { "api-key": key } : {}) },
      body: JSON.stringify({
        model, max_tokens: outputLimit,
        ...(provider === "zhipu" ? { thinking: { type: reasoningOnly ? "enabled" : "disabled" } } : {}),
        ...(reasoningOnly ? { reasoning_effort: "low" } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: image ? [
            { type: "image_url", image_url: { url: image } },
            { type: "text", text: user },
          ] : user },
        ],
      }),
    });
    if (!response.ok) {
      const guidance = response.status === 401 ? "鉴权失败，请检查 API Key 是否正确、是否为模型标准 API Key（非 Coding Plan）" :
        response.status === 403 ? "账号没有此模型的调用权限" :
        response.status === 429 ? "供应商限流或账号额度不足" : "供应商请求失败";
      throw new AppError(502, `ai_provider_http_${response.status}`, `AI 服务返回 HTTP ${response.status}：${guidance}；未自动重试`);
    }
    const body = z.object({
      choices: z.array(z.object({ message: z.object({ content: z.string().min(1).max(6000) }) })).min(1),
      usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional(),
    }).parse(await response.json());
    if (body.usage) {
      input = body.usage.prompt_tokens; output = body.usage.completion_tokens;
      cost = costInCny((input * inputRate + output * outputRate) / 1_000_000, currency);
    }
    await query("UPDATE ai_events SET input_tokens=$2,output_tokens=$3,cost_usd=$4,cost_cny=$5,status=$6,error_code=NULL WHERE id=$1",
      [event, input, output, cost / AI_ACCOUNTING_CNY_PER_USD, cost, input === null ? "estimated" : "complete"]);
    return body.choices[0].message.content;
  } catch (error) {
    const knownRejection = error instanceof AppError && error.code.startsWith("ai_provider_http_");
    if (error instanceof AppError && /^ai_provider_http_4\d\d$/.test(error.code)) cost = 0;
    await query("UPDATE ai_events SET status=$2,error_code=$3,cost_usd=$4,cost_cny=$5 WHERE id=$1",
      [event, knownRejection ? "failed" : "unknown", error instanceof AppError ? error.code : "ai_transport_or_response", cost / AI_ACCOUNTING_CNY_PER_USD, cost]);
    if (error instanceof AppError) throw error;
    throw new AppError(502, "ai_unknown", "AI 超时或返回无效；预算预留保留，未自动重试");
  } finally { await logCentral(provider, model, input, output, cost / AI_ACCOUNTING_CNY_PER_USD, Date.now() - started, task); }
}
