import fs from "fs";
import path from "path";
import { config } from "./config";

// ─── Chat Modes ────────────────────────────────────────────────────────────────

export type ChatMode = "default" | "english_training";

function getModesFilePath(): string {
  return path.join(config.dataDir, "modes.json");
}

function readModes(): Record<string, ChatMode> {
  const filePath = getModesFilePath();
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

export function getChatMode(chatId: string): ChatMode {
  return readModes()[chatId] ?? "default";
}

export function setChatMode(chatId: string, mode: ChatMode): void {
  const modes = readModes();
  modes[chatId] = mode;
  fs.writeFileSync(getModesFilePath(), JSON.stringify(modes, null, 2), "utf-8");
}

export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string;
  from: string;
  senderName?: string;
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

  // Segment messages into conversation sessions based on time gaps.
  // A gap of 1h+ likely signals a new conversation topic/session.
  let sessionId = 0;
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) {
      const gapMs = raw[i].timestampMs - raw[i - 1].timestampMs;
      if (gapMs > 60 * 60 * 1000) sessionId += 1; // 1h+ = new session
    }
    raw[i].sessionId = sessionId;
  }

  return raw;
}

function scoreMessage(
  msg: ContextMessage,
  nowMs: number,
  currentChatId: string,
  currentSessionId: number
): number {
  const ageMs = Math.max(nowMs - msg.timestampMs, 0);
  const ageMin = ageMs / (60 * 1000);

  // Recency score: steeply decays the older the message gets
  let score = 0;
  if (ageMin <= 5) score += 20;
  else if (ageMin <= 15) score += 15;
  else if (ageMin <= 30) score += 10;
  else if (ageMin <= 60) score += 6;
  else if (ageMin <= 180) score += 3;
  else if (ageMin <= 720) score += 1.5;
  else score += 0.5;

  // Strong bonus for being in the current chat
  if (msg.chatId === currentChatId) score += 8;
  // Extra bonus for being in the current session of the current chat
  if (msg.chatId === currentChatId && msg.sessionId === currentSessionId) score += 10;

  return score;
}

export function getWeightedGlobalContext(
  currentChatId: string,
  totalLimit = 80
): ContextMessage[] {
  const nowMs = Date.now();
  const currentChatMessages = readChatMessagesWithMeta(currentChatId);
  if (currentChatMessages.length === 0) return [];

  const currentSessionId = currentChatMessages[currentChatMessages.length - 1].sessionId;

  // Always include ALL messages from the current session first.
  const currentSession = currentChatMessages.filter((m) => m.sessionId === currentSessionId);
  const selectedKeys = new Set(currentSession.map((m) => `${m.timestamp}:${m.from}:${m.content}`));

  // Fill remaining slots with older messages from the same chat only.
  const remainingSlots = Math.max(totalLimit - currentSession.length, 0);
  const olderMessages = currentChatMessages
    .filter((m) => m.sessionId !== currentSessionId && !selectedKeys.has(`${m.timestamp}:${m.from}:${m.content}`))
    .map((m) => ({ msg: m, score: scoreMessage(m, nowMs, currentChatId, currentSessionId) }))
    .sort((a, b) => b.score - a.score || b.msg.timestampMs - a.msg.timestampMs)
    .slice(0, remainingSlots)
    .map((x) => x.msg);

  return [...currentSession, ...olderMessages].sort((a, b) => a.timestampMs - b.timestampMs);
}
