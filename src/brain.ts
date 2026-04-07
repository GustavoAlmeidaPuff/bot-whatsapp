import { generateResponse } from "./ai";
import { saveMessage, getWeightedGlobalContext, ContextMessage } from "./storage";
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

  // Build weighted global context across all chats, prioritizing recency and current session.
  const context = getWeightedGlobalContext(chatId, 60);
  const history = context.map(
    (msg: ContextMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam => ({
      role: msg.role as "user" | "assistant" | "system",
      content:
        msg.chatId === chatId
          ? msg.content
          : `[contexto de outra conversa: ${msg.chatId}] ${msg.content}`,
    })
  );

  // Build messages for AI
  const systemContent = buildPersonalitySystemContent(
    config.personality as unknown as Record<string, unknown>
  );

  const systemMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: "system",
    content: [
      systemContent,
      "",
      "MEMORIA E CONTEXTO:",
      "- Considere mensagens de outras conversas como contexto adicional.",
      "- Priorize com muito mais peso as mensagens mais recentes e a sessao atual da conversa.",
      "- Se o usuario corrigir um fato, reconheca o erro de forma direta.",
    ].join("\n"),
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
