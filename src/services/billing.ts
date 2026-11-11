import type { Env } from "../types.ts";
import type { User } from "../db/schema.ts";
import { fernetEncrypt, fernetDecrypt } from "../crypto/fernet.ts";

export const billingEnabled = (env: Env): boolean => env.BILLING_ENABLED !== "false";
export const TRIAL_SECONDS = 7 * 24 * 60 * 60;
export const PRICE_AGOROT = 2000;
export const PRICING_TEXT = "7 ימי ניסיון חינם, ולאחריהם מנוי ב־20 ₪ לחודש";
export const billingCheckoutCacheKey = (key: string): string => `billing_checkout:v2:${key}`;
export type BillingAccount = { phone_hash: string; billing_key: string; trial_ends_at: number | null; trial_started?: boolean };
export type BillingSubscription = {
  id: string; billing_key: string; status: string;
  trial_ends_at: number | null; renews_at: number | null; ends_at: number | null; updated_at: string;
};
export type LemonSubscription = {
  type: string; id: string;
  attributes: {
    store_id: number; variant_id: number; status: string; test_mode: boolean;
    trial_ends_at: string | null; renews_at: string | null; ends_at: string | null; updated_at: string;
    urls?: { customer_portal?: string };
  };
};

export function subscriptionAllowsAccess(sub: BillingSubscription, now = Math.floor(Date.now() / 1000)): boolean {
  if (sub.ends_at !== null && sub.ends_at <= now) return false;
  if (sub.status === "active") return sub.renews_at !== null && sub.renews_at > now;
  if (sub.status === "on_trial") return sub.trial_ends_at !== null && sub.trial_ends_at > now;
  if (sub.status === "cancelled") return sub.ends_at !== null && sub.ends_at > now;
  return false; // paused, past_due, unpaid, expired, and unknown statuses
}

// SQL callers supply trusted column/parameter expressions, never user input.
// Apply this before a bounded scan, so unpaid accounts cannot occupy every batch slot.
export function billingAccessSql(phoneHashSql: string, nowSql: string, enabled = true): string {
  if (!enabled) return `(${nowSql} IS NOT NULL)`;
  return `EXISTS (SELECT 1 FROM billing_account b WHERE b.phone_hash = ${phoneHashSql} AND (
    b.trial_ends_at > ${nowSql} OR EXISTS (
      SELECT 1 FROM billing_subscription s WHERE s.billing_key = b.billing_key
        AND (s.ends_at IS NULL OR s.ends_at > ${nowSql}) AND (
          (s.status = 'active' AND s.renews_at > ${nowSql}) OR
          (s.status = 'on_trial' AND s.trial_ends_at > ${nowSql}) OR
          (s.status = 'cancelled' AND s.ends_at > ${nowSql})
        )
    )
  ))`;
}

export async function getBillingAccount(env: Env, user: Pick<User, "phone_number_hash">, startTrial = false): Promise<BillingAccount> {
  const existing = await env.DB.prepare("SELECT * FROM billing_account WHERE phone_hash = ?")
    .bind(user.phone_number_hash).first<BillingAccount>();
  if (existing && (!startTrial || existing.trial_ends_at !== null)) return existing;
  const end = startTrial ? Math.floor(Date.now() / 1000) + TRIAL_SECONDS : null;
  // D1 makes concurrent first messages share one start date. Never extend a trial.
  await env.DB.prepare(`INSERT INTO billing_account (phone_hash, billing_key, trial_ends_at)
    VALUES (?, ?, ?) ON CONFLICT(phone_hash) DO UPDATE SET
    trial_ends_at = COALESCE(billing_account.trial_ends_at, excluded.trial_ends_at)`)
    .bind(user.phone_number_hash, crypto.randomUUID(), end).run();
  const account = await env.DB.prepare("SELECT * FROM billing_account WHERE phone_hash = ?")
    .bind(user.phone_number_hash).first<BillingAccount>();
  if (!account) throw new Error("Billing account unavailable");
  return { ...account, trial_started: startTrial && existing?.trial_ends_at == null };
}

export async function getSubscriptions(env: Env, key: string): Promise<BillingSubscription[]> {
  const result = await env.DB.prepare("SELECT * FROM billing_subscription WHERE billing_key = ? ORDER BY updated_at DESC")
    .bind(key).all<BillingSubscription>();
  return result.results;
}

export async function hasAccess(env: Env, user: Pick<User, "phone_number_hash">): Promise<boolean> {
  if (!billingEnabled(env)) return true;
  const account = await getBillingAccount(env, user);
  const now = Math.floor(Date.now() / 1000);
  if (account.trial_ends_at !== null && account.trial_ends_at > now) return true;
  return (await getSubscriptions(env, account.billing_key)).some(sub => subscriptionAllowsAccess(sub, now));
}

export async function lemonRequest<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.LEMONSQUEEZY_API_KEY) throw new Error("Billing API key missing");
  const response = await fetch(`https://api.lemonsqueezy.com/v1/${path}`, {
    ...init, signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/vnd.api+json", "Content-Type": "application/vnd.api+json",
      Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Billing API failed (${response.status})`);
  return response.json<T>();
}

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid billing timestamp");
  return Math.floor(parsed / 1000);
}

export function isConfiguredSubscription(env: Env, sub: LemonSubscription): boolean {
  return sub.type === "subscriptions" && String(sub.attributes.store_id) === env.LEMONSQUEEZY_STORE_ID
    && String(sub.attributes.variant_id) === env.LEMONSQUEEZY_VARIANT_ID
    && sub.attributes.test_mode === (env.LEMONSQUEEZY_TEST_MODE === "true");
}

export async function saveSubscription(env: Env, key: string, sub: LemonSubscription): Promise<void> {
  if (!isConfiguredSubscription(env, sub)) throw new Error("Unexpected billing product or mode");
  const a = sub.attributes;
  if (!Number.isFinite(Date.parse(a.updated_at))) throw new Error("Invalid subscription update time");
  const updated = new Date(a.updated_at).toISOString();
  // Older/replayed events cannot overwrite newer state or move an existing subscription to another account.
  await env.DB.prepare(`INSERT INTO billing_subscription
    (id, billing_key, status, trial_ends_at, renews_at, ends_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, trial_ends_at = excluded.trial_ends_at,
      renews_at = excluded.renews_at, ends_at = excluded.ends_at, updated_at = excluded.updated_at
    WHERE excluded.updated_at > billing_subscription.updated_at AND excluded.billing_key = billing_subscription.billing_key`)
    .bind(sub.id, key, a.status, timestamp(a.trial_ends_at), timestamp(a.renews_at), timestamp(a.ends_at), updated).run();
}

async function refreshSubscriptions(env: Env, key: string): Promise<LemonSubscription[]> {
  const stored = await getSubscriptions(env, key);
  const fresh = await Promise.all(stored.map(async sub => {
    const result = await lemonRequest<{ data: LemonSubscription }>(env, `subscriptions/${encodeURIComponent(sub.id)}`);
    await saveSubscription(env, key, result.data);
    return result.data;
  }));
  return fresh;
}

export async function reconcileBilling(env: Env): Promise<void> {
  if (!billingEnabled(env) || !env.LEMONSQUEEZY_API_KEY) return;
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(`SELECT * FROM billing_subscription
    WHERE status IN ('active', 'on_trial') AND last_checked_at < ?
    AND COALESCE(renews_at, trial_ends_at, 0) <= ? ORDER BY last_checked_at ASC LIMIT 20`)
    .bind(now - 300, now).all<BillingSubscription>();
  // Keep API concurrency and per-cron work bounded. Failed renewals remain gated.
  for (let offset = 0; offset < due.results.length; offset += 4) {
    await Promise.all(due.results.slice(offset, offset + 4).map(async sub => {
      await env.DB.prepare("UPDATE billing_subscription SET last_checked_at = ? WHERE id = ?").bind(now, sub.id).run();
      try {
        const result = await lemonRequest<{ data: LemonSubscription }>(env, `subscriptions/${encodeURIComponent(sub.id)}`);
        await saveSubscription(env, sub.billing_key, result.data);
      } catch (err) {
        console.error("[BILLING] Renewal reconciliation failed", sub.id, err instanceof Error ? err.message : "unknown error");
      }
    }));
  }
}

async function createCheckout(env: Env, account: BillingAccount): Promise<string> {
  if (!billingEnabled(env)) throw new Error("Billing is disabled");
  if (!/^\d+$/.test(env.LEMONSQUEEZY_STORE_ID ?? "") || !/^\d+$/.test(env.LEMONSQUEEZY_VARIANT_ID ?? "")) {
    throw new Error("Billing product missing");
  }
  const cacheKey = billingCheckoutCacheKey(account.billing_key);
  const [cached, store] = await Promise.all([
    env.CACHE.get(cacheKey),
    lemonRequest<{ data: { attributes: { currency: string; domain: string } } }>(env, `stores/${env.LEMONSQUEEZY_STORE_ID}`),
  ]);
  const storeHost = store.data.attributes.domain.toLowerCase();
  if (store.data.attributes.currency !== "ILS" || !storeHost.endsWith(".lemonsqueezy.com")) {
    throw new Error("Billing store must use ILS and a Lemon Squeezy domain");
  }
  if (cached) {
    const cachedUrl = await fernetDecrypt(cached, env.ENCRYPTION_KEY);
    if (new URL(cachedUrl).hostname === storeHost) return cachedUrl;
    await env.CACHE.delete(cacheKey); // Store renames invalidate signed checkout URLs on the old host.
  }
  // Check the actual store/variant on each new checkout so a bad setting cannot charge USD or an annual plan.
  const variant = await lemonRequest<{ data: { attributes: { price: number; pay_what_you_want: boolean; is_subscription: boolean; interval: string; interval_count: number; test_mode: boolean; product_id: number } } }>(env, `variants/${env.LEMONSQUEEZY_VARIANT_ID}`);
  const v = variant.data.attributes;
  const product = await lemonRequest<{ data: { attributes: { store_id: number; status: string } } }>(env, `products/${v.product_id}`);
  if (v.price !== PRICE_AGOROT || v.pay_what_you_want || !v.is_subscription || v.interval !== "month" || v.interval_count !== 1
      || v.test_mode !== (env.LEMONSQUEEZY_TEST_MODE === "true") || String(product.data.attributes.store_id) !== env.LEMONSQUEEZY_STORE_ID
      || product.data.attributes.status !== "published") throw new Error("Billing plan must be a published ILS monthly subscription");
  const result = await lemonRequest<{ data: { attributes: { url: string } } }>(env, "checkouts", {
    method: "POST", body: JSON.stringify({ data: { type: "checkouts", attributes: {
      checkout_options: { skip_trial: true, discount: true },
      checkout_data: { custom: { billing_key: account.billing_key } },
      product_options: { enabled_variants: [Number(env.LEMONSQUEEZY_VARIANT_ID)],
        redirect_url: `https://${env.PUBLIC_HOST}/billing/success`, receipt_button_text: "חזרה לטודו",
        receipt_link_url: `https://${env.PUBLIC_HOST}/billing/success` },
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      test_mode: env.LEMONSQUEEZY_TEST_MODE === "true",
    }, relationships: { store: { data: { type: "stores", id: env.LEMONSQUEEZY_STORE_ID } },
      variant: { data: { type: "variants", id: env.LEMONSQUEEZY_VARIANT_ID } } } } }),
  });
  const url = result.data.attributes.url;
  if (!url || new URL(url).protocol !== "https:" || new URL(url).hostname !== storeHost) throw new Error("Invalid checkout URL");
  await env.CACHE.put(cacheKey, await fernetEncrypt(url, env.ENCRYPTION_KEY), { expirationTtl: 3300 });
  return url;
}

export const BILLING_COMMANDS = new Set(["/billing", "/subscribe", "/subscription", "מנוי", "תשלום"]);
export const PUBLIC_COMMANDS = new Set(["/share", "/help", "/help more", "/tos", "/privacy", "/calendar disconnect", "/delete", "/confirm", '/agenda off', '/undo', 'undo', 'בטל פעולה אחרונה', 'בטל את הפעולה האחרונה']);

export async function cancelSubscriptions(env: Env, user: Pick<User, "phone_number_hash">): Promise<void> {
  const account = await getBillingAccount(env, user);
  const subscriptions = await getSubscriptions(env, account.billing_key);
  for (const subscription of subscriptions) {
    if (["cancelled", "expired"].includes(subscription.status)) continue;
    const result = await lemonRequest<{ data: LemonSubscription }>(env, `subscriptions/${encodeURIComponent(subscription.id)}`, { method: "DELETE" });
    await saveSubscription(env, account.billing_key, result.data);
  }
  await env.CACHE.delete(billingCheckoutCacheKey(account.billing_key));
}

export async function billingReply(env: Env, user: Pick<User, "phone_number_hash">): Promise<string> {
  if (!billingEnabled(env)) return "המופע הזה פועל ללא מנוי בתשלום.";
  const account = await getBillingAccount(env, user);
  try {
    // Recover missed updates and fetch a fresh signed portal URL only when requested.
    const fresh = await refreshSubscriptions(env, account.billing_key);
    const stored = await getSubscriptions(env, account.billing_key);
    const usable = stored.find(sub => subscriptionAllowsAccess(sub));
    const managed = fresh.find(sub => sub.id === usable?.id) ?? fresh[0];
    const portal = managed?.attributes.urls?.customer_portal;
    if (usable) return `✅ המנוי שלך פעיל — 20 ₪ לחודש.${usable.status === "cancelled" ? "\nהמנוי בוטל ויישאר זמין עד סוף התקופה ששולמה." : ""}${portal ? `\nלניהול המנוי, עדכון כרטיס או ביטול:\n${portal}` : ""}`;
    if (stored.some(sub => ["active", "on_trial", "past_due", "unpaid", "paused"].includes(sub.status))) {
      return `⚠️ המנוי אינו פעיל כרגע. יש להסדיר את התשלום כדי להמשיך.${portal ? `\nלניהול המנוי, עדכון כרטיס או ביטול:\n${portal}` : `\nלעזרה: ${env.SUPPORT_EMAIL || "/help"}`}`;
    }
    const trialActive = account.trial_ends_at !== null && account.trial_ends_at > Date.now() / 1000;
    if (trialActive) {
      const end = new Date(account.trial_ends_at! * 1000).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
      return `🎁 הניסיון שלך פעיל עד ${end}.\n${PRICING_TEXT}.\nלא נחייב אותך אוטומטית במהלך הניסיון. בסיומו שלח /subscribe להצטרפות.`;
    }
    const checkout = await createCheckout(env, account);
    return `🔒 תקופת הניסיון הסתיימה. המשימות שלך נשמרו.\nלהמשך השימוש: *20 ₪ לחודש*, בחיוב חודשי מתחדש.\nלהצטרפות מאובטחת דרך Lemon Squeezy:\n${checkout}\n\nלאחר התשלום שלח /billing. אפשר לבטל בכל עת דרך /billing.`;
  } catch (err) {
    console.error("[BILLING] Unable to prepare billing reply:", err instanceof Error ? err.message : "unknown error");
    return `🔒 ${PRICING_TEXT}.\nלא ניתן לפתוח את התשלום כרגע. נסה /billing שוב בעוד רגע או פנה ל־${env.SUPPORT_EMAIL || "/help"}.\nהמשימות שלך נשמרו.`;
  }
}
