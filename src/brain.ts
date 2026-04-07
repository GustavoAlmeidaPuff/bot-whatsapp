import { generateResponse } from "./ai";
import { saveMessage, getWeightedGlobalContext, getChatMode, ContextMessage } from "./storage";
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
  // Note: the incoming message is already saved in whatsapp.ts before this is called.

  const chatMode = getChatMode(chatId);
  const personality = config.personality as any;
  const modeConfig = chatMode !== "default" ? (personality.modes?.[chatMode] ?? null) : null;

  // Build weighted global context across all chats, prioritizing recency and current session.
  const context = getWeightedGlobalContext(chatId, 80);

  // Format each message so the AI knows who said what.
  // For assistant messages, keep content as-is (already attributed to Jarvis).
  // For user messages, prefix with the sender's name so the AI understands the conversation.
  const history = context.map(
    (msg: ContextMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      if (msg.role === "assistant") {
        return { role: "assistant", content: msg.content };
      }

      const label = (msg as any).senderName || msg.from.split("@")[0];
      const prefix = msg.chatId !== chatId ? `[outra conversa] ` : "";
      return {
        role: "user",
        content: `${prefix}${label}: ${msg.content}`,
      };
    }
  );

  // Build messages for AI
  const systemContent = buildPersonalitySystemContent(
    config.personality as unknown as Record<string, unknown>
  );

  const systemParts = [
    systemContent,
    "",
    "CONTEXTO DE CONVERSA:",
    "- Voce recebe o historico completo de mensagens do chat, incluindo mensagens de pessoas que nao estao falando diretamente com voce.",
    "- Cada mensagem de usuario tem o prefixo 'Nome: mensagem' para indicar quem falou.",
    "- Mensagens marcadas com [outra conversa] sao de outros chats — use como contexto secundario.",
    "- As mensagens mais recentes e da sessao atual tem muito mais peso. Priorize-as.",
    "- Quando alguem perguntar 'o que voce acha sobre isso?' ou similar, analise o que foi discutido recentemente no chat para entender o 'isso'.",
    "- Se o usuario corrigir um fato, reconheca o erro de forma direta.",
  ];

  // Inject active mode system prompt — overrides default behavior for this chat
  if (modeConfig?.system_prompt) {
    systemParts.push("", "MODO ATIVO: " + (modeConfig.description ?? ""), modeConfig.system_prompt);
  }

  const systemMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: "system",
    content: systemParts.join("\n"),
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
