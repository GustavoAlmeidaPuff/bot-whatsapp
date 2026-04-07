import { config, ensureDirs } from "./config";

async function main() {
  if (!config.openRouterApiKey) {
    console.error("⚠️  OPENROUTER_API_KEY not set in .env file");
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
