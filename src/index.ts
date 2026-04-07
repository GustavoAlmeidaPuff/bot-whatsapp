import { config, ensureDirs } from "./config";

// Suppress noisy Baileys internal session logs
const _origLog = console.log.bind(console);
console.log = (...args: any[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("Closing session:")) return;
  _origLog(...args);
};

async function main() {
  if (!config.geminiApiKey) {
    console.error("⚠️  GEMINI_API_KEY not set in .env file");
    console.error("   Copy .env.example to .env and add your API key");
    process.exit(1);
  }

  ensureDirs();

  console.log("🤖 Starting Jarvis...");
  const { connectWhatsApp } = await import("./whatsapp");
  await connectWhatsApp();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
