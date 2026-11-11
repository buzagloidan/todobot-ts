import { readFileSync } from "node:fs";


const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const get = name => config.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
if (get("BILLING_ENABLED") !== "true" || get("LEMONSQUEEZY_TEST_MODE") !== "false") throw new Error("This helper only configures explicitly enabled live billing");
if (!/^\d+$/.test(get("LEMONSQUEEZY_STORE_ID") || "") || !/^\d+$/.test(get("LEMONSQUEEZY_VARIANT_ID") || "")) throw new Error("Configure store and variant IDs first");
if (!get("PUBLIC_HOST") || /localhost|example\.com/.test(get("PUBLIC_HOST"))) throw new Error("Configure your public host first");
const storeId = get("LEMONSQUEEZY_STORE_ID");
const variantId = get("LEMONSQUEEZY_VARIANT_ID");
const url = `https://${get("PUBLIC_HOST")}/billing/webhook`;
const apiKey = process.env.LEMONSQUEEZY_API_KEY;
const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
if (!apiKey || !secret || (secret.length < 32 || secret.length > 40)) throw new Error("Provide the API key and a 32–40 character signing secret through environment variables; never through command arguments.");

async function api(path, init = {}) {
  const response = await fetch(`https://api.lemonsqueezy.com/v1/${path}`, { ...init,
    signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json", "Content-Type": "application/vnd.api+json" } });
  if (!response.ok) throw new Error(`Lemon Squeezy setup request failed (${response.status})`);
  return response.json();
}

const [store, variant] = await Promise.all([api(`stores/${storeId}`), api(`variants/${variantId}`)]);
const v = variant.data.attributes;
const product = await api(`products/${v.product_id}`);
if (store.data.attributes.currency !== "ILS" || !v.is_subscription || v.interval !== "month" || v.interval_count !== 1 || v.price !== 2000
  || v.pay_what_you_want || v.test_mode || String(product.data.attributes.store_id) !== storeId || product.data.attributes.status !== "published") {
  throw new Error("The selected variant must be a published, fixed-price ₪20 monthly live subscription in the selected ILS store.");
}

const events = ["subscription_created", "subscription_updated", "subscription_cancelled", "subscription_resumed", "subscription_expired", "subscription_paused", "subscription_unpaused"];
const existing = await api(`webhooks?filter[store_id]=${storeId}`);
const webhook = existing.data.find(item => item.attributes.url === url && !item.attributes.test_mode);
const result = await api(webhook ? `webhooks/${webhook.id}` : "webhooks", {
  method: webhook ? "PATCH" : "POST",
  body: JSON.stringify({ data: { type: "webhooks", ...(webhook ? { id: webhook.id } : {}),
    attributes: { url, events, secret, test_mode: false },
    ...(!webhook ? { relationships: { store: { data: { type: "stores", id: storeId } } } } : {}),
  } }),
});
console.log(`Configured live Todo webhook ${result.data.id}: ${url}`);
console.log("Store the identical signing secret on wa-bot-cf, then deploy your own Worker. No secret values were logged.");
