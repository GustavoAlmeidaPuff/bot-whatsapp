import { generateResponse } from "./ai";
import { saveMessage, getRecentMessages, StoredMessage } from "./storage";
import { config } from "./config";
import OpenAI from "openai";

function buildPersonalitySystemContent(personality: Record<string, unknown>): string {
  const p = personality as any;
  const fullPersonalityJson = JSON.stringify(personality, null, 2);

  return [
    String(p.system_prompt || ""),
    "",
    "REGRAS DE EXECUCAO:",
    "- Use TODO o JSON de personalidade abaixo como fonte de verdade.",
    "- Se houver conflito entre regras, priorize system_prompt + what_NOT_to_do + what_to_DO.",
    "- Nao ignore campos de idioma, estilo, exemplos, reacoes e valores centrais.",
    "",
    "PERSONALIDADE_COMPLETA_JSON:",
    fullPersonalityJson,
  ].join("\n");
}

export async function processMessage(
  chatId: string,
  senderId: string,
  text: string
): Promise<string> {
  // Save incoming message
  saveMessage(chatId, {
    role: "user",
    content: text,
    from: senderId,
    timestamp: new Date().toISOString(),
  });

  // Get recent context
  const history = getRecentMessages(chatId, 30).map(
    (msg: StoredMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam => ({
      role: msg.role as "user" | "assistant" | "system",
      content: msg.content,
    })
  );

  // Build messages for AI
  const systemContent = buildPersonalitySystemContent(
    config.personality as unknown as Record<string, unknown>
  );

  const systemMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: "system",
    content: systemContent,
  };

  const aiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    systemMessage,
    ...history,
  ];

  // Generate response
  const reply = await generateResponse(aiMessages);

  // Save assistant response
  saveMessage(chatId, {
    role: "assistant",
    content: reply,
    from: "jarvis",
    timestamp: new Date().toISOString(),
  });

  return reply;
}
