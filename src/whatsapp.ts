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

  const quotedText = extractMessageText(contextInfo.quotedMessage);
  if (quotedText.startsWith("*Jarvis:*")) return true;

  // In private chats, participant is usually not set — any reply counts
  if (!isGroup) return true;

  // In groups, check that the quoted message was sent by the bot
  const ownNumber = ownJid.split("@")[0].split(":")[0];
  const quotedNumber = (contextInfo.participant || "").split("@")[0].split(":")[0];
  return ownNumber !== "" && ownNumber === quotedNumber;
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

      // Ignore own messages
      if (msg.key.fromMe) return;

      // Ignore broadcast
      if (isJidBroadcast(msg.key.remoteJid!)) return;

      const chatId = msg.key.remoteJid!;
      const senderId = msg.key.participant || msg.key.remoteJid!;

      // Ignore mirror LID messages that match the bot's own number
      if (chatId.endsWith("@lid")) {
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
      if (!hasMention && !repliedToBot) return;

      console.log(
        `[${isGroup ? "GROUP" : "PRIVATE"}] ${senderId}: ${text} (mention=${hasMention}, replyToBot=${repliedToBot})`
      );

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
        console.error("Error processing message:", error);
        if (isConnected) {
          try {
            await sock.sendMessage(chatId, {
              text: "Oops, something went wrong. Try again later.",
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
