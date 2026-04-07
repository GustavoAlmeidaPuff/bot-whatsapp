import fs from "fs";
import path from "path";
import { config } from "./config";

export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string;
  from: string;
  timestamp: string;
}

function getChatFilePath(chatId: string): string {
  const safeId = chatId.replace(/[^a-zA-Z0-9@._-]/g, "_");
  return path.join(config.chatsDir, `${safeId}.jsonl`);
}

export function saveMessage(
  chatId: string,
  message: StoredMessage
): void {
  const filePath = getChatFilePath(chatId);
  const line = JSON.stringify(message) + "\n";
  fs.appendFileSync(filePath, line, "utf-8");
}

export function getRecentMessages(
  chatId: string,
  limit: number = 30
): StoredMessage[] {
  const filePath = getChatFilePath(chatId);
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const lines = content.split("\n");
  const recent = lines.slice(-limit);
  return recent
    .map((line) => {
      try {
        return JSON.parse(line) as StoredMessage;
      } catch {
        return null;
      }
    })
    .filter((m): m is StoredMessage => m !== null);
}
