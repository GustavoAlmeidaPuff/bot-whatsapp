import OpenAI from "openai";
import { config } from "./config";

const openai = new OpenAI({
  apiKey: config.geminiApiKey,
  baseURL: config.geminiBaseUrl,
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/jarvis-whatsapp",
    "X-Title": "Jarvis WhatsApp Bot",
  },
});

export function isRateLimitError(err: unknown): boolean {
  return (err as any)?.status === 429;
}

export async function generateResponse(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  retries = 5,
  delayMs = 1000
): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: config.model,
        messages,
        max_tokens: 1024,
        temperature: 0.7,
      });

      const rawContent = response.choices?.[0]?.message?.content;
      const content = (() => {
        if (typeof rawContent === "string") return rawContent.trim();
        if (!Array.isArray(rawContent)) return "";
        const parts = rawContent as Array<{ text?: string }>;
        return parts
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .join("")
          .trim();
      })();
      if (!content) {
        console.warn("AI returned empty response, full body:", JSON.stringify(response, null, 2).slice(0, 500));
        return "...";
      }
      return content;
    } catch (err: any) {
      if (isRateLimitError(err) && attempt < retries) {
        const resetHeader = err?.headers?.get?.("x-ratelimit-reset");
        const exponentialBackoff = delayMs * Math.pow(2, attempt - 1);
        const jitterMs = Math.floor(Math.random() * 500);
        const waitMs = resetHeader
          ? Math.max(Number(resetHeader) - Date.now(), 0) + 500
          : exponentialBackoff + jitterMs;
        console.warn(`Rate limited. Retrying in ${(waitMs / 1000).toFixed(1)}s... (attempt ${attempt}/${retries})`);
        await new Promise((res) => setTimeout(res, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries reached");
}
