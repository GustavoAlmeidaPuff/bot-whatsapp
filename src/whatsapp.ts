import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  isJidBroadcast,
  isJidGroup,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { config } from "./config";
import { processMessage } from "./brain";
import { saveMessage, getChatMode, setChatMode } from "./storage";
import { isRateLimitError, isTransientApiError } from "./ai";

const logger = pino({ level: "silent" });
let currentSocketToken = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(expectedToken: number) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (expectedToken !== currentSocketToken) return;
    void connectWhatsApp();
  }, 1500);
}

function containsJarvisMention(text: string): boolean {
  return /\bjarvis\b/i.test(text);
}

function unwrapMessageContent(message: any): any {
  if (!message) return message;
  if (message.ephemeralMessage?.message) {
    return unwrapMessageContent(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessageContent(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessageContent(message.viewOnceMessage.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessageContent(message.documentWithCaptionMessage.message);
  }
  return message;
}

function extractMessageText(message: any): string {
  const content = unwrapMessageContent(message);
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    ""
  );
}

function extractContextInfo(message: any): any {
  const content = unwrapMessageContent(message);
  return (
    content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo ||
    content?.documentMessage?.contextInfo
  );
}

function isReplyToBot(msg: any, ownJid: string, isGroup: boolean): boolean {
  const contextInfo = extractContextInfo(msg.message);
  if (!contextInfo?.quotedMessage) return false;

  // Only treat as a reply to Jarvis if the quoted message has the bot's signature.
  // This prevents triggering when someone replies to a message manually sent by the operator
  // from the same number — those messages won't have the "*Jarvis:*" prefix.
  const quotedText = extractMessageText(contextInfo.quotedMessage);
  return quotedText.startsWith("*Jarvis:*");
}

export async function connectWhatsApp() {
  const socketToken = ++currentSocketToken;
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
  });

  // Keep connection status to avoid sending on closed socket
  let ownJid = "";
  let isConnected = false;
  let hasAnnouncedOpen = false;

  async function safeReact(chatId: string, key: any, text: string) {
    if (!isConnected) return;
    try {
      await sock.relayMessage(
        chatId,
        {
          reactionMessage: {
            key,
            text,
            senderTimestampMs: Date.now(),
          },
        },
        {}
      );
    } catch (error) {
      console.warn("Failed to send reaction:", (error as any)?.message || error);
    }
  }

  sock.ev.process(async (events) => {
    if (socketToken !== currentSocketToken) return;

    if (events["creds.update"]) {
      await saveCreds();
    }

    if (events["connection.update"]) {
      const { connection, lastDisconnect, qr } = events["connection.update"];
      if (qr) {
        console.log("📱 Scan the QR code below with WhatsApp:");
        qrcode.generate(qr, { small: true });
        return;
      }

      if (connection === "close") {
        isConnected = false;
        hasAnnouncedOpen = false;
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const isSessionConflict =
          reason === DisconnectReason.connectionReplaced ||
          reason === DisconnectReason.multideviceMismatch ||
          reason === 440;
        const shouldReconnect = reason !== DisconnectReason.loggedOut && !isSessionConflict;
        console.warn(`Connection closed due to: ${reason}, reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          scheduleReconnect(socketToken);
        } else if (isSessionConflict) {
          console.error(
            "Sessao WhatsApp em conflito (codigo 440). Feche outras conexoes e refaca o pareamento apagando auth_info."
          );
          process.exit(1);
        } else {
          console.error("You have been logged out. Delete auth_info/ and scan again.");
          process.exit(1);
        }
      } else if (connection === "open") {
        isConnected = true;
        ownJid = sock.user?.id || ownJid;
        if (!hasAnnouncedOpen) {
          hasAnnouncedOpen = true;
          console.log(`📱 Bot JID: ${ownJid}`);
          console.log("✅ Jarvis connected to WhatsApp!");
        }
      }
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      if (type !== "notify") return;

      const msg = messages[0];
      if (!msg.message) return;

      // Ignore broadcast
      if (isJidBroadcast(msg.key.remoteJid!)) return;

      const isFromMe = msg.key.fromMe === true;
      const chatId = msg.key.remoteJid!;

      // For fromMe messages, senderId is the bot's own JID
      const senderId = isFromMe
        ? ownJid
        : (msg.key.participant || msg.key.remoteJid!);

      // Ignore mirror LID messages that match the bot's own number
      // (these are duplicate echoes from WhatsApp, not real messages)
      if (!isFromMe && chatId.endsWith("@lid")) {
        const ownNumber = ownJid.split("@")[0];
        const senderNumber = senderId.split("@")[0];
        if (ownNumber && senderNumber === ownNumber) return;
      }

      // Extract text
      const text = extractMessageText(msg.message);
      if (!text) return;

      const isGroup = chatId.includes("@g.us");
      const hasMention = containsJarvisMention(text);
      const repliedToBot = isReplyToBot(msg, ownJid, isGroup);

      // Owner's messages: save to context but only process if directed at Jarvis.
      // This way the owner can talk to Jarvis by mentioning him or replying to him,
      // while their other messages are still stored for conversation context.
      if (isFromMe) {
        const senderName = "Dono";
        saveMessage(chatId, {
          role: "user",
          content: text,
          from: senderId,
          senderName,
          timestamp: new Date().toISOString(),
        });
        if (!hasMention && !repliedToBot) return;
      } else {
        const senderName: string = (msg as any).pushName || senderId.split("@")[0];
        // Save every message to storage so Jarvis has full conversation context,
        // even for messages not directed at him.
        saveMessage(chatId, {
          role: "user",
          content: text,
          from: senderId,
          senderName,
          timestamp: new Date().toISOString(),
        });
        if (!hasMention && !repliedToBot) return;
      }

      console.log(
        `[${isGroup ? "GROUP" : "PRIVATE"}] ${senderId}: ${text} (mention=${hasMention}, replyToBot=${repliedToBot})`
      );

      // ── Static commands ────────────────────────────────────────────────────
      const normalizedText = text.toLowerCase().trim();

      if (normalizedText.includes("jarvis, ligar aura")) {
        await sock.sendMessage(chatId, { text: "https://open.spotify.com/intl-pt/track/6DvGOGRRjhURCE7weXWV3x?si=9c564f36c08f4ae6" });
        return;
      }
      // ───────────────────────────────────────────────────────────────────────

      // ── Mode switching ──────────────────────────────────────────────────────
      const personality = config.personality as any;
      const modes = personality.modes ?? {};

      let modeCommandHandled = false;
      for (const [modeName, modeDef] of Object.entries(modes) as [string, any][]) {
        const activationPhrases: string[] = modeDef.activation_phrases ?? [];
        const deactivationPhrases: string[] = modeDef.deactivation_phrases ?? [];

        if (activationPhrases.some((p: string) => normalizedText.includes(p.toLowerCase()))) {
          setChatMode(chatId, modeName as any);
          await sock.sendMessage(chatId, { text: `*Jarvis:*\n\n${modeDef.activation_confirmation}` });
          modeCommandHandled = true;
          break;
        }

        if (deactivationPhrases.some((p: string) => normalizedText.includes(p.toLowerCase()))) {
          setChatMode(chatId, "default");
          await sock.sendMessage(chatId, { text: `*Jarvis:*\n\n${modeDef.deactivation_confirmation}` });
          modeCommandHandled = true;
          break;
        }
      }
      if (modeCommandHandled) return;
      // ───────────────────────────────────────────────────────────────────────

      try {
        // React with hourglass while thinking
        await safeReact(chatId, msg.key, "\u231B");

        const reply = await processMessage(chatId, senderId, text);

        if (!isConnected) {
          console.warn("Skipping reply because socket is disconnected.");
          return;
        }

        await sock.sendMessage(chatId, { text: `*Jarvis:*\n\n${reply}` });
        console.log(`Jarvis: ${reply}`);
      } catch (error) {
        if (isRateLimitError(error)) {
          console.warn("AI rate limited after retries.");
        } else if (isTransientApiError(error)) {
          console.warn("AI provider temporarily unavailable after retries.");
        } else {
          console.error("Error processing message:", error);
        }
        if (isConnected) {
          try {
            await sock.sendMessage(chatId, {
              text: isRateLimitError(error)
                ? "Foi mal, eu que falhei agora por limite da API. Tenta de novo em alguns segundos que eu respondo direito."
                : isTransientApiError(error)
                ? "Foi mal, o servidor da IA ficou instavel agora. Tenta de novo em alguns segundos."
                : "Oops, something went wrong. Try again later.",
            });
          } catch (sendError) {
            console.warn("Failed to send error message:", (sendError as any)?.message || sendError);
          }
        }
      } finally {
        // Always remove loading reaction when processing finishes
        await safeReact(chatId, msg.key, "");
      }
    }
  });

  return sock;
}
