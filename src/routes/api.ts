import type { Context } from "hono";
import type { Env } from "../types.ts";
import { buildDb } from "../db/client.ts";
import { getUserByApiTokenHash, decryptPhone } from "../db/queries.ts";
import { hashApiToken } from "../api/token.ts";
import { sendMessage, sendApiTemplate } from "../services/whatsapp.ts";
import { checkUserRateLimit } from "../redis/client.ts";
import { capture } from "../services/posthog.ts";
import { hasAccess } from "../services/billing.ts";

export async function apiHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const secret = c.req.param("secret");
  if (!secret || secret.length < 16 || secret.length > 128) {
    return c.json({ ok: false, error: "invalid_token" }, 401);
  }

  let body = (await c.req.text()).trim();
  if (!body) return c.json({ ok: false, error: "empty_body" }, 400);
  if (body.length > 1000) body = body.slice(0, 1000);

  const db = buildDb(c.env);
  const hash = await hashApiToken(secret);
  const user = await getUserByApiTokenHash(db, hash);
  if (!user) return c.json({ ok: false, error: "invalid_token" }, 401);
  if (!(await hasAccess(c.env, user))) return c.json({ ok: false, error: "subscription_required", price_ils: 20, billing_command: "/billing" }, 402);

  const rl = await checkUserRateLimit(c.env.CACHE, user.id, 60_000, 10);
  if (!rl.allowed) return c.json({ ok: false, error: "rate_limited" }, 429);

  const phone = await decryptPhone(user, c.env.ENCRYPTION_KEY);
  if (!phone) return c.json({ ok: false, error: "send_failed" }, 502);

  // Try free-form first (works within 24h window); fall back to approved template outside it
  let id: string | null = null;
  try {
    id = await sendMessage(c.env, phone, body);
  } catch {
    id = await sendApiTemplate(c.env, phone, body).catch(() => null);
  }
  if (!id) return c.json({ ok: false, error: "send_failed" }, 502);

  capture(c.env, `user_${user.id}`, "api_message_sent", { bytes: body.length },
    { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });

  return c.json({ ok: true, id });
}
