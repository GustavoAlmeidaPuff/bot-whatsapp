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

function containsJarvisMention(text: string): boolean {
  return /\bjarvis\b/i.test(text);
}

function isReplyToBot(msg: any, ownJid: string, isGroup: boolean): boolean {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (!contextInfo?.quotedMessage) return false;

  // In private chats, participant is usually not set — any reply counts
  if (!isGroup) return true;

  // In groups, check that the quoted message was sent by the bot
  const ownNumber = ownJid.split("@")[0].split(":")[0];
  const quotedNumber = (contextInfo.participant || "").split("@")[0].split(":")[0];
  return ownNumber !== "" && ownNumber === quotedNumber;
}

export async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
  });

  // Get own JID to filter mirror messages
  let ownJid = "";
  sock.ev.on("connection.update", (update) => {
    if (update.connection === "open") {
      ownJid = sock.user?.id || "";
      console.log(`📱 Bot JID: ${ownJid}`);
    }
  });

  sock.ev.process(async (events) => {
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
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.warn(
          `Connection closed due to: ${reason}, reconnecting: ${shouldReconnect}`
        );

        if (shouldReconnect) {
          await connectWhatsApp();
        } else {
          console.error("You have been logged out. Delete auth_info/ and scan again.");
          process.exit(1);
        }
      } else if (connection === "open") {
        console.log("✅ Jarvis connected to WhatsApp!");
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
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      if (!text) return;

      const isGroup = chatId.includes("@g.us");
      if (!containsJarvisMention(text) && !isReplyToBot(msg, ownJid, isGroup)) return;

      console.log(
        `[${isGroup ? "GROUP" : "PRIVATE"}] ${senderId}: ${text}`
      );

      try {
        // React with hourglass while thinking
        await sock.relayMessage(chatId, {
          reactionMessage: {
            key: msg.key,
            text: "\u231B",
            senderTimestampMs: Date.now(),
          },
        }, {});

        const reply = await processMessage(chatId, senderId, text);

        // Remove reaction and send reply
        await sock.relayMessage(chatId, {
          reactionMessage: {
            key: msg.key,
            text: "",
            senderTimestampMs: Date.now(),
          },
        }, {});

        await sock.sendMessage(chatId, { text: `*Jarvis:*\n\n${reply}` });
        console.log(`Jarvis: ${reply}`);
      } catch (error) {
        console.error("Error processing message:", error);
        await sock.sendMessage(chatId, {
          text: "Oops, something went wrong. Try again later.",
        });
      }
    }
  });

  return sock;
}
