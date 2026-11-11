import type { Env } from "../types.ts";
import { sendMessage } from "./whatsapp.ts";

export async function sendAlert(env: Env, type: string, detail: string): Promise<void> {
  if (!env.ALERT_PHONE) return;
  const key = `alert:${type}`;
  const already = await env.CACHE.get(key);
  if (already) return;
  await env.CACHE.put(key, "1", { expirationTtl: 3600 });
  await sendMessage(env, env.ALERT_PHONE, `🚨 [${type}]\n${detail}`).catch(() => {});
}
