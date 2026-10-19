export const AI_MONTHLY_CNY_LIMIT = 100;
// Fixed, conservative accounting rate, not a live exchange-rate quote.
export const AI_ACCOUNTING_CNY_PER_USD = 8;
export const GLM_FLASH_MODEL = "glm-5.3-flash";
export const GLM_FLASH_CONTEXT_TOKENS = 1_048_576;

export function supportsPhotoCaption(provider: string, model: string) {
  return provider === "zhipu" && /^glm-5\.3-flashx?$/i.test(model);
}

export function aiPricing(provider: string, model: string, inputRate: number | null, outputRate: number | null) {
  if (provider === "zhipu" && model.toLowerCase() === GLM_FLASH_MODEL) {
    return { inputRate: 0.8, outputRate: 2.8, currency: "CNY" as const };
  }
  return { inputRate, outputRate, currency: "USD" as const };
}

export function costInCny(amount: number, currency: "CNY" | "USD") {
  return currency === "CNY" ? amount : amount * AI_ACCOUNTING_CNY_PER_USD;
}
