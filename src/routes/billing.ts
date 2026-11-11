import type { Context } from "hono";
import type { Env } from "../types.ts";
import { saveSubscription, isConfiguredSubscription, billingCheckoutCacheKey, type LemonSubscription } from "../services/billing.ts";

export async function verifyBillingSignature(body: string, signature: string, secret: string): Promise<boolean> {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = new Uint8Array(signature.match(/.{2}/g)!.map(hex => parseInt(hex, 16)));
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body));
}

export async function billingWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!c.env.LEMONSQUEEZY_WEBHOOK_SECRET) return c.json({ error: "billing_unavailable" }, 503);
  // Bound raw body before HMAC verification, without relying on a caller-controlled Content-Length.
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: "invalid_body" }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 64 * 1024) { await reader.cancel(); return c.json({ error: "body_too_large" }, 413); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const raw = new TextDecoder().decode(bytes);
  if (!(await verifyBillingSignature(raw, c.req.header("X-Signature") ?? "", c.env.LEMONSQUEEZY_WEBHOOK_SECRET))) {
    return c.json({ error: "invalid_signature" }, 401);
  }
  let event: { meta?: { event_name?: string; custom_data?: { billing_key?: string } }; data?: LemonSubscription };
  try { event = JSON.parse(raw); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!event.data || event.data.type !== "subscriptions") return c.json({ ok: true });
  if (!event.data.attributes || !isConfiguredSubscription(c.env, event.data)) return c.json({ ok: true });
  const key = event.meta?.custom_data?.billing_key;
  if (typeof key !== "string") return c.json({ ok: true });
  const account = await c.env.DB.prepare("SELECT billing_key FROM billing_account WHERE billing_key = ?").bind(key).first();
  if (!account) return c.json({ ok: true });
  // Await the write: failed D1 updates return 500 so Lemon Squeezy retries delivery.
  await saveSubscription(c.env, key, event.data);
  await c.env.CACHE.delete(billingCheckoutCacheKey(key));
  return c.json({ ok: true });
}

export function billingSuccess(c: Context<{ Bindings: Env }>): Response {
  return c.html(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>טודו — חזרה לבוט</title><body style="font-family:system-ui;max-width:560px;margin:10vh auto;padding:24px"><h1>תודה שבחרת בטודו</h1><p>חזור לשיחת WhatsApp ושלח <b>/billing</b> לבדיקת מצב המנוי. אישור התשלום עשוי לקחת כמה רגעים.</p><p>המנוי עולה 20 ₪ לחודש. לניהול או ביטול, שלח <b>/billing</b> בבוט.</p></body></html>`);
}
