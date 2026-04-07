import fs from "fs";
import path from "path";
import { config } from "./config";

export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string;
  from: string;
  timestamp: string;
}

export interface ContextMessage extends StoredMessage {
  chatId: string;
  timestampMs: number;
  sessionId: number;
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

function parseStoredLine(line: string): StoredMessage | null {
  try {
    return JSON.parse(line) as StoredMessage;
  } catch {
    return null;
  }
}

function readChatMessagesWithMeta(chatId: string): ContextMessage[] {
  const filePath = getChatFilePath(chatId);
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const raw = content
    .split("\n")
    .map(parseStoredLine)
    .filter((m): m is StoredMessage => m !== null)
    .map((m) => ({
      ...m,
      chatId,
      timestampMs: Number.isFinite(Date.parse(m.timestamp)) ? Date.parse(m.timestamp) : 0,
      sessionId: 0,
    }))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  // Conversation session segmentation by natural pauses.
  // We use soft windows (long pause = likely another topic/session).
  let sessionId = 0;
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) {
      const gapMs = raw[i].timestampMs - raw[i - 1].timestampMs;
      if (gapMs > 2 * 60 * 60 * 1000) sessionId += 1; // 2h+ likely another session
    }
    raw[i].sessionId = sessionId;
  }

  return raw;
}

function listAllChatIds(): string[] {
  if (!fs.existsSync(config.chatsDir)) return [];
  return fs
    .readdirSync(config.chatsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.replace(/\.jsonl$/, ""));
}

function scoreMessage(
  msg: ContextMessage,
  nowMs: number,
  currentChatId: string,
  currentSessionId: number
): number {
  const ageMs = Math.max(nowMs - msg.timestampMs, 0);
  const ageMin = ageMs / (60 * 1000);

  let score = 0;
  if (ageMin <= 10) score += 10;
  else if (ageMin <= 30) score += 8;
  else if (ageMin <= 90) score += 6;
  else if (ageMin <= 180) score += 4;
  else if (ageMin <= 720) score += 2;
  else score += 1;

  if (msg.chatId === currentChatId) score += 5;
  if (msg.chatId === currentChatId && msg.sessionId === currentSessionId) score += 4;
  if (msg.role === "assistant") score += 0.5;

  return score;
}

export function getWeightedGlobalContext(
  currentChatId: string,
  totalLimit = 60
): ContextMessage[] {
  const nowMs = Date.now();
  const currentChatMessages = readChatMessagesWithMeta(currentChatId);
  const currentSessionId =
    currentChatMessages.length > 0 ? currentChatMessages[currentChatMessages.length - 1].sessionId : 0;

  const allChatIds = listAllChatIds();
  const allMessages = allChatIds.flatMap((chatId) => readChatMessagesWithMeta(chatId));
  if (allMessages.length === 0) return [];

  // Preserve strong local continuity from current chat.
  const localStrong = currentChatMessages.slice(-28);
  const selectedKeys = new Set(localStrong.map((m) => `${m.chatId}:${m.timestamp}:${m.from}:${m.content}`));

  const remainingSlots = Math.max(totalLimit - localStrong.length, 0);
  const globalRanked = allMessages
    .filter((m) => !selectedKeys.has(`${m.chatId}:${m.timestamp}:${m.from}:${m.content}`))
    .map((m) => ({
      msg: m,
      score: scoreMessage(m, nowMs, currentChatId, currentSessionId),
    }))
    .sort((a, b) => b.score - a.score || b.msg.timestampMs - a.msg.timestampMs)
    .slice(0, remainingSlots)
    .map((x) => x.msg);

  // Final ordering by time to keep coherent conversational flow.
  return [...localStrong, ...globalRanked].sort((a, b) => a.timestampMs - b.timestampMs);
}
