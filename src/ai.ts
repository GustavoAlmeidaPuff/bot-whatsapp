import OpenAI from "openai";
import { config } from "./config";

const openai = new OpenAI({
  apiKey: config.openRouterApiKey,
  baseURL: config.openRouterBaseUrl,
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/jarvis-whatsapp",
    "X-Title": "Jarvis WhatsApp Bot",
  },
});

export async function generateResponse(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  retries = 3,
  delayMs = 5000
): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: config.model,
        messages,
        max_tokens: 1024,
        temperature: 0.7,
      });

      const content = response.choices?.[0]?.message?.content?.trim();
      if (!content) {
        console.warn("AI returned empty response, full body:", JSON.stringify(response, null, 2).slice(0, 500));
        return "...";
      }
      return content;
    } catch (err: any) {
      if (err?.status === 429 && attempt < retries) {
        console.warn(`Rate limited. Retrying in ${delayMs / 1000}s... (attempt ${attempt}/${retries})`);
        await new Promise((res) => setTimeout(res, delayMs * attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries reached");
}
