import { generateResponse } from "./ai";
import { saveMessage, getRecentMessages, StoredMessage } from "./storage";
import { config } from "./config";
import OpenAI from "openai";

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
  const p = config.personality as any;
  const systemContent = [
    p.system_prompt,
    `\nGÍRIAS QUE VOCÊ USA: ${p.speech_patterns?.casual?.join(", ")}`,
    `\nRISADAS: discreta="${p.speech_patterns?.laughs?.discrete}", forte="${p.speech_patterns?.laughs?.strong}", sarcástica="${p.speech_patterns?.laughs?.sarcastic}"`,
    `\nO QUE NÃO FAZER:\n${p.what_NOT_to_do?.map((x: string) => `- ${x}`).join("\n")}`,
    `\nO QUE FAZER:\n${p.what_to_DO?.map((x: string) => `- ${x}`).join("\n")}`,
    `\nEXEMPLOS DE RESPOSTAS BOAS:\n${Object.values(p.examples_of_good_responses ?? {}).map((ex: any) => `user: "${ex.user}" → bot: "${ex.bot}"`).join("\n")}`,
  ].join("\n");

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
