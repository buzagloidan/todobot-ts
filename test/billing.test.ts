/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.ts";
import { buildDb } from "../src/db/client.ts";
import { getUserById, addTask, getUserTasks, deleteUserAndData } from "../src/db/queries.ts";
import { fernetEncrypt } from "../src/crypto/fernet.ts";
import { issueOrRotateToken } from "../src/api/token.ts";
import { dispatchQueueMessage } from "../src/queue/consumer.ts";
import { sendDueRemindersForTest as scanAndSendReminders } from "./helpers.ts";
import { getBillingAccount, hasAccess, subscriptionAllowsAccess, saveSubscription, getSubscriptions, billingReply, reconcileBilling, billingCheckoutCacheKey, TRIAL_SECONDS, type LemonSubscription, type BillingSubscription } from "../src/services/billing.ts";
import { verifyBillingSignature } from "../src/routes/billing.ts";
import { applySchema, clearData, createTestUser, drainConversation, makeSignedWebhookRequest, makeSignedWebhookRequestFromMessage, makeMockFetch, TEST_PHONE, TEST_ENC_KEY } from "./helpers.ts";
import type { Env } from "../src/types.ts";

const billingEnv: Env = { ...env, LEMONSQUEEZY_STORE_ID: "12345", LEMONSQUEEZY_VARIANT_ID: "123456", LEMONSQUEEZY_TEST_MODE: "false", LEMONSQUEEZY_API_KEY: "test-billing-key", LEMONSQUEEZY_WEBHOOK_SECRET: "test-webhook-secret" };
let mockFetch: ReturnType<typeof vi.fn>;
const db = buildDb(env);
beforeAll(applySchema);
beforeEach(async () => { await clearData(); mockFetch = vi.fn().mockImplementation(makeMockFetch()); vi.stubGlobal("fetch", mockFetch); });
afterEach(() => vi.unstubAllGlobals());

async function request(req: Request): Promise<Response> {
  const isWebhook = new URL(req.url).pathname === "/webhook";
  const ctx = createExecutionContext();
  const response = await worker.fetch(req, billingEnv, ctx);
  await waitOnExecutionContext(ctx);
  if (isWebhook) await drainConversation();
  return response;
}
async function expiredUser() {
  const id = await createTestUser();
  const user = (await getUserById(db, id))!;
  await env.DB.prepare("UPDATE billing_account SET trial_ends_at = ? WHERE phone_hash = ?").bind(Math.floor(Date.now()/1000)-1, user.phone_number_hash).run();
  return user;
}
function subscription(status = "active", updated = "2026-10-12T07:00:00.000Z"): LemonSubscription {
  return { type: "subscriptions", id: "98765", attributes: { store_id: 12345, variant_id: 123456, status, test_mode: false, trial_ends_at: null, renews_at: "2026-11-12T07:00:00.000Z", ends_at: null, updated_at: updated, urls: { customer_portal: "https://example-store.lemonsqueezy.com/billing/test" } } };
}
async function sign(body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(billingEnv.LEMONSQUEEZY_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body)))).map(n=>n.toString(16).padStart(2,"0")).join("");
}
async function deliver(sub: LemonSubscription, key: string, valid = true) {
  const body = JSON.stringify({ meta: { event_name: "subscription_updated", custom_data: { billing_key: key } }, data: sub });
  return request(new Request("https://worker.example.com/billing/webhook", { method: "POST", headers: { "X-Signature": valid ? await sign(body) : "0".repeat(64) }, body }));
}
function replies() {
  return mockFetch.mock.calls.filter(([url]) => String(url).includes("graph.facebook.com")).flatMap(([,init]) => { const body=JSON.parse(init.body); const text=body.text?.body ?? body.interactive?.body?.text; return text ? [text] : []; });
}

describe("trial and entitlement", () => {
  it("starts seven days once, and concurrent messages never extend it", async () => {
    const u = { phone_number_hash: "new-user" };
    expect(await hasAccess(env,u)).toBe(false); // background checks cannot start trials
    const [a,b]=await Promise.all([getBillingAccount(env,u,true),getBillingAccount(env,u,true)]);
    expect(a.billing_key).toBe(b.billing_key);
    expect(a.trial_ends_at).toBe(b.trial_ends_at);
    expect(a.trial_ends_at! - Math.floor(Date.now()/1000)).toBe(TRIAL_SECONDS);
    await env.DB.prepare("UPDATE billing_account SET trial_ends_at = 1 WHERE phone_hash = ?").bind(u.phone_number_hash).run();
    expect((await getBillingAccount(env,u,true)).trial_ends_at).toBe(1);
    expect(await hasAccess(env,u)).toBe(false);
  });
  it("does not keep active access beyond an unverified renewal", async () => {
    const u=await expiredUser();const a=await getBillingAccount(env,u);const sub=subscription();
    sub.attributes.renews_at=new Date(Date.now()-1000).toISOString();
    await saveSubscription(billingEnv,a.billing_key,sub);
    expect(await hasAccess(env,u)).toBe(false);
    mockFetch.mockResolvedValue(Response.json({data:subscription("active","2026-10-12T10:00:00.000Z")}));
    await reconcileBilling(billingEnv);
    expect(await hasAccess(env,u)).toBe(true);
  });
  it("retains trial expiry after account deletion and registration", async () => {
    const u=await expiredUser();
    await deleteUserAndData(db,u.id,null);
    const replacement=await createTestUser();
    expect(await hasAccess(env,(await getUserById(db,replacement))!)).toBe(false);
  });
  it("cancellation grants access only until the paid period ends", () => {
    const sub: BillingSubscription = { id:"1", billing_key:"a", status:"cancelled",trial_ends_at:null,renews_at:null,ends_at:100,updated_at:"2026-10-12" };
    expect(subscriptionAllowsAccess(sub,99)).toBe(true);
    expect(subscriptionAllowsAccess(sub,100)).toBe(false);
    for(const status of ["expired","unpaid","past_due","paused","unknown"]) expect(subscriptionAllowsAccess({...sub,status},99)).toBe(false);
    expect(subscriptionAllowsAccess({...sub,status:"on_trial",trial_ends_at:100,ends_at:null},100)).toBe(false);
  });
});

describe("signed payment synchronization", () => {
  it("verifies signatures and rejects malformed or altered payloads", async () => {
    const sig=await sign("hello");
    expect(await verifyBillingSignature("hello",sig,billingEnv.LEMONSQUEEZY_WEBHOOK_SECRET!)).toBe(true);
    expect(await verifyBillingSignature("changed",sig,billingEnv.LEMONSQUEEZY_WEBHOOK_SECRET!)).toBe(false);
    expect(await verifyBillingSignature("hello","zz",billingEnv.LEMONSQUEEZY_WEBHOOK_SECRET!)).toBe(false);
  });
  it("unlocks only after a valid signed subscription event", async () => {
    const u=await expiredUser(); const a=await getBillingAccount(env,u);
    expect((await deliver(subscription(),a.billing_key,false)).status).toBe(401);
    expect(await hasAccess(env,u)).toBe(false);
    expect((await deliver(subscription(),a.billing_key)).status).toBe(200);
    expect(await hasAccess(env,u)).toBe(true);
  });
  it("ignores other products, stores, test payments and unknown accounts", async () => {
    const u=await expiredUser();const a=await getBillingAccount(env,u);
    for(const change of [{variant_id:654321},{store_id:2},{test_mode:true}]) {
      const sub=subscription();Object.assign(sub.attributes,change);expect((await deliver(sub,a.billing_key)).status).toBe(200);
    }
    await deliver(subscription(),"unknown-key");
    expect(await hasAccess(env,u)).toBe(false);
  });
  it("duplicate and older events cannot reopen an expired subscription", async () => {
    const u=await expiredUser();const a=await getBillingAccount(env,u);
    await deliver(subscription("expired","2026-10-12T08:00:00.000Z"),a.billing_key);
    await deliver(subscription(),a.billing_key);
    await deliver(subscription("expired","2026-10-12T08:00:00.000Z"),a.billing_key);
    expect(await hasAccess(env,u)).toBe(false);
    expect((await getSubscriptions(env,a.billing_key)).length).toBe(1);
  });
  it("cannot move a subscription to another billing account", async () => {
    const a=await getBillingAccount(env,{phone_number_hash:"a"},true);const b=await getBillingAccount(env,{phone_number_hash:"b"},true);
    await saveSubscription(billingEnv,a.billing_key,subscription());
    await saveSubscription(billingEnv,b.billing_key,subscription("active","2026-10-12T09:00:00.000Z"));
    expect((await getSubscriptions(env,b.billing_key)).length).toBe(0);
  });
});

describe("paid bot enforcement", () => {
  it("blocks text, audio, contacts, interactive actions and reactions without calling AI", async () => {
    const u=await expiredUser();await addTask(db,TEST_ENC_KEY,u.id,"keep this task",null);
    const messages=[{type:"text",text:{body:"+blocked task"}},{type:"audio",audio:{id:"audio"}},{type:"reaction",reaction:{emoji:"👍",message_id:"old"}},{type:"contacts",contacts:[]},{type:"interactive",interactive:{button_reply:{id:"agree_btn"}}}];
    for(const [i,message] of messages.entries()) await request(await makeSignedWebhookRequestFromMessage({from:TEST_PHONE,id:`blocked-${i}`, ...message}));
    expect((await getUserTasks(db,TEST_ENC_KEY,[u.id])).length).toBe(1);
    expect(mockFetch.mock.calls.some(([url])=>String(url).includes("googleapis.com"))).toBe(false);
    expect(replies()).toHaveLength(5);
    expect(replies().every(text=>text.includes("20 ₪"))).toBe(true);
  });
  it("keeps help, pricing and privacy available after expiry", async () => {
    await expiredUser();
    await request(await makeSignedWebhookRequest("/HELP"));
    await request(await makeSignedWebhookRequest("/privacy"));
    expect(replies().some(text=>text.includes("7 ימי ניסיון"))).toBe(true);
    expect(replies().some(text=>text.includes("Lemon Squeezy"))).toBe(true);
  });
  it("rejects queued processing and API sends after trial expiry", async () => {
    const u=await expiredUser();
    await dispatchQueueMessage({type:"voice_processing",userId:u.id,phone:TEST_PHONE,audioId:"audio"},billingEnv);
    expect(mockFetch.mock.calls.some(([url])=>String(url).includes("googleapis.com"))).toBe(false);
    const token=await issueOrRotateToken(db,env,u.id);mockFetch.mockClear();
    const res=await request(new Request(`https://worker.example.com/api/v1/${token}`,{method:"POST",body:"blocked notification"}));
    expect(res.status).toBe(402);expect(mockFetch).not.toHaveBeenCalled();
  });
  it("keeps reminders pending for an expired owner", async () => {
    const u=await expiredUser();const task=await addTask(db,TEST_ENC_KEY,u.id,"later",new Date(Date.now()-10000));
    await scanAndSendReminders(env);
    expect(mockFetch).not.toHaveBeenCalled();
    const row=await env.DB.prepare("SELECT reminder_sent FROM task WHERE id = ?").bind(task.id).first<{reminder_sent:number}>();
    expect(row?.reminder_sent).toBe(0);
  });
});

describe("checkout", () => {
  it("uses the exact monthly ILS variant, skips a second trial, and sends only an opaque account key", async () => {
    const u=await expiredUser();
    mockFetch.mockImplementation(async (url:string,init:RequestInit) => {
      const path=String(url).split("/v1/")[1];
      if(path==="stores/12345") return Response.json({data:{attributes:{currency:"ILS",domain:"example-store.lemonsqueezy.com"}}});
      if(path==="variants/123456") return Response.json({data:{attributes:{price:2000,pay_what_you_want:false,is_subscription:true,interval:"month",interval_count:1,test_mode:false,product_id:555}}});
      if(path==="products/555") return Response.json({data:{attributes:{store_id:12345,status:"published"}}});
      if(path==="checkouts") return Response.json({data:{attributes:{url:"https://example-store.lemonsqueezy.com/checkout/custom/test"}}});
      throw new Error("Unexpected URL");
    });
    const account = await getBillingAccount(env,u);
    await env.CACHE.put(`billing_checkout:${account.billing_key}`, await fernetEncrypt("https://sikumai.lemonsqueezy.com/checkout/custom/old-hidden-discount", TEST_ENC_KEY));
    await env.CACHE.put(billingCheckoutCacheKey(account.billing_key), await fernetEncrypt("https://sikumai.lemonsqueezy.com/checkout/custom/old-store", TEST_ENC_KEY));
    expect(await billingReply(billingEnv,u)).toContain("https://example-store.lemonsqueezy.com/checkout/custom/test");
    const checkout=mockFetch.mock.calls.find(([url])=>String(url).endsWith("/checkouts"))!;
    const payload=JSON.parse(checkout[1].body).data;
    expect(payload.relationships.variant.data.id).toBe("123456");
    expect(payload.attributes.checkout_options.skip_trial).toBe(true);
    expect(payload.attributes.checkout_options.discount).toBe(true);
    expect(Object.keys(payload.attributes.checkout_data.custom)).toEqual(["billing_key"]);
    expect(JSON.stringify(payload)).not.toContain(TEST_PHONE);
    mockFetch.mockClear();expect(await billingReply(billingEnv,u)).toContain("checkout/custom/test");expect(mockFetch.mock.calls.map(([url])=>String(url))).toEqual(["https://api.lemonsqueezy.com/v1/stores/12345"]);
  });
  it("never starts checkout while the free trial is active", async () => {
    const id=await createTestUser();expect(await billingReply(billingEnv,(await getUserById(db,id))!)).toContain("הניסיון שלך פעיל");expect(mockFetch).not.toHaveBeenCalled();
  });
  it("returns management links for paid subscribers and refreshes their state", async () => {
    const u=await expiredUser();const a=await getBillingAccount(env,u);await saveSubscription(billingEnv,a.billing_key,subscription());
    mockFetch.mockResolvedValue(Response.json({data:subscription()}));
    expect(await billingReply(billingEnv,u)).toContain("/billing/test");
    expect(mockFetch.mock.calls.every(([url])=>!String(url).endsWith("/checkouts"))).toBe(true);
  });
});

describe("account deletion with billing", () => {
  it("cancels recurring billing before deleting the user, while retaining the trial ledger", async () => {
    const u=await expiredUser();const a=await getBillingAccount(env,u);await saveSubscription(billingEnv,a.billing_key,subscription());
    const base=makeMockFetch();
    mockFetch.mockImplementation(async (url:string,init:RequestInit) => {
      if(String(url).includes("api.lemonsqueezy.com")) {
        expect(init.method).toBe("DELETE");expect(await getUserById(db,u.id)).not.toBeNull();
        const cancelled=subscription("cancelled","2026-10-12T11:00:00.000Z");cancelled.attributes.ends_at=cancelled.attributes.renews_at;
        return Response.json({data:cancelled});
      }
      return base(url);
    });
    await request(await makeSignedWebhookRequest("/delete"));
    await request(await makeSignedWebhookRequest("/confirm"));
    expect(await getUserById(db,u.id)).toBeNull();
    expect((await getBillingAccount(env,u)).trial_ends_at).toBe(a.trial_ends_at);
    expect((await getSubscriptions(env,a.billing_key))[0].status).toBe("cancelled");
    expect(mockFetch.mock.calls.some(([url,init])=>String(url).includes("api.lemonsqueezy.com")&&init.method==="DELETE")).toBe(true);
  });
  it("preserves the account if recurring billing cannot be cancelled", async () => {
    const u=await expiredUser();const a=await getBillingAccount(env,u);await saveSubscription(billingEnv,a.billing_key,subscription());
    const base=makeMockFetch();mockFetch.mockImplementation((url:string)=>String(url).includes("api.lemonsqueezy.com")?Promise.resolve(new Response("{}",{status:503})):base(url));
    await request(await makeSignedWebhookRequest("/delete"));await request(await makeSignedWebhookRequest("/confirm"));
    expect(await getUserById(db,u.id)).not.toBeNull();expect(replies().some(text=>text.includes("החשבון עדיין לא נמחק"))).toBe(true);
  });
});


describe("renewal checkout safety", () => {
  it("does not create a second subscription while a renewal remains unverified", async () => {
    const u=await expiredUser();const a=await getBillingAccount(env,u);const sub=subscription();
    sub.attributes.renews_at=new Date(Date.now()-1000).toISOString();
    await saveSubscription(billingEnv,a.billing_key,sub);
    mockFetch.mockResolvedValue(Response.json({data:sub}));
    expect(await billingReply(billingEnv,u)).toContain("/billing/test");
    expect(mockFetch.mock.calls.some(([url])=>String(url).endsWith("/checkouts"))).toBe(false);
  });
});
