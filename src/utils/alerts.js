import { CONFIG } from "../config.js";
import { createLogger } from "./logger.js";

const log = createLogger("ALERT");

export async function sendAlert(message, level = "info") {
  const tasks = [];

  if (CONFIG.alerts.discordWebhook) {
    tasks.push(sendDiscord(message, level));
  }
  if (CONFIG.alerts.telegramToken && CONFIG.alerts.telegramChatId) {
    tasks.push(sendTelegram(message));
  }

  await Promise.allSettled(tasks);
}

async function sendDiscord(message, level) {
  const colors = { info: 0x00ff87, warn: 0xffcc00, error: 0xff3b30, trade: 0x00cc6a };
  try {
    await fetch(CONFIG.alerts.discordWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: `⚡ Arb Engine [${level.toUpperCase()}]`,
          description: message,
          color: colors[level] || colors.info,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (err) {
    log.error("Discord alert failed", { error: err.message });
  }
}

async function sendTelegram(message) {
  try {
    const url = `https://api.telegram.org/bot${CONFIG.alerts.telegramToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.alerts.telegramChatId,
        text: `⚡ *Arb Engine*\n${message}`,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    log.error("Telegram alert failed", { error: err.message });
  }
}
