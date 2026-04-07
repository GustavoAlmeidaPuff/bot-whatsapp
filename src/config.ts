import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || "",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  model: "gemini-3-flash-preview",
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
