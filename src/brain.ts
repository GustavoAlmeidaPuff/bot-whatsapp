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
  const systemMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: "system",
    content: config.personality.system_prompt,
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
