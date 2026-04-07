import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

export const config = {
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterBaseUrl: "https://openrouter.ai/api/v1",
  model: "nvidia/nemotron-3-super-120b-a12b:free",
  dataDir: path.resolve("data"),
  chatsDir: path.resolve("data", "chats"),
  authDir: path.resolve("auth_info"),
  personality: JSON.parse(
    fs.readFileSync(path.resolve("src", "personality.json"), "utf-8")
  ) as {
    name: string;
    system_prompt: string;
    language: string;
    traits: string[];
  },
};

export function ensureDirs() {
  fs.mkdirSync(config.chatsDir, { recursive: true });
  fs.mkdirSync(config.authDir, { recursive: true });
}
