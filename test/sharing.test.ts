/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { buildDb } from "../src/db/client.ts";
import {
  addTask,
  getUserById,
  getTaskById,
  completeTask,
  deleteUserAndData,
} from "../src/db/queries.ts";
import {
  maybeOfferShare,
  sendShareDraft,
  handleShareControl,
  shareContent,
} from "../src/services/sharing.ts";
import {
  ensureReminderJob,
  deliverReminderJob,
  handleReminderStatus,
} from "../src/services/reminder_dispatch.ts";
import {
  taskActionButtons,
  handleTaskControl,
  reminderButtons,
} from "../src/services/task_controls.ts";
import { newUndoContext } from "../src/services/task_undo.ts";
import { signControl } from "../src/services/controls.ts";
import {
  applySchema,
  clearData,
  createTestUser,
  makeMockFetch,
  TEST_PHONE,
  TEST_PHONE_2,
  makeSignedWebhookRequest,
  makeSignedWebhookRequestFromMessage,
  drainConversation,
} from "./helpers.ts";
const { message: SHARE_MESSAGE, url: SHARE_URL } = shareContent(env)!;
const BOT_WHATSAPP_URL = `https://wa.me/${env.BOT_WHATSAPP_NUMBER}`;
let actor: number, mock: ReturnType<typeof vi.fn>;
const db = buildDb(env),
  now = () => Math.floor(Date.now() / 1000);
beforeAll(applySchema);
beforeEach(async () => {
  await clearData();
  actor = await createTestUser();
  mock = vi.fn(makeMockFetch());
  vi.stubGlobal("fetch", mock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const user = async () => (await getUserById(db, actor))!;
const wa = () =>
  mock.mock.calls
    .filter(
      ([url, init]) => String(url).includes("graph.facebook.com") && init?.body,
    )
    .map(([, init]) => JSON.parse(init.body));
const offers = () =>
  wa().filter((p) => p.interactive?.body?.text?.includes("טודו עזר לך לזכור"));
const state = () =>
  env.DB.prepare("SELECT state FROM user_share_offer WHERE user_id=?")
    .bind(actor)
    .first<{ state: string }>();
const shareToken = (action: string, expiry = now() + 600) =>
  signControl(env, "share", actor, action, expiry);
async function experienced(recurring = false) {
  const t = await addTask(
      db,
      env.ENCRYPTION_KEY,
      actor,
      "שם פרטי שלא משתפים",
      new Date(Date.now() - 60000),
      recurring ? "daily" : null,
    ),
    job = await ensureReminderJob(env, t);
  await deliverReminderJob(env, job.id);
  const undo = newUndoContext(actor);
  if (!recurring)
    await completeTask(db, env.ENCRYPTION_KEY, t.id, [actor], [], undo);
  mock.mockClear();
  return { t, job, undo };
}
it("does not offer sharing before a reminder is successfully used", async () => {
  const t = await addTask(db, env.ENCRYPTION_KEY, actor, "חדש", null);
  await completeTask(db, env.ENCRYPTION_KEY, t.id, [actor]);
  await maybeOfferShare(env, await user(), TEST_PHONE, { taskId: t.id });
  expect(offers()).toHaveLength(0);
  expect(await state()).toBeNull();
});
it("an API receipt alone never emits a share prompt", async () => {
  const t = await addTask(
      db,
      env.ENCRYPTION_KEY,
      actor,
      "תזכורת",
      new Date(Date.now() - 60000),
      "daily",
    ),
    job = await ensureReminderJob(env, t);
  await deliverReminderJob(env, job.id);
  expect(offers()).toHaveLength(0);
  expect(await state()).toBeNull();
});
it("concurrent completion hooks offer once without leaking task text or automatically sending a draft", async () => {
  const { t } = await experienced(),
    u = await user();
  await Promise.all(
    Array.from({ length: 5 }, () =>
      maybeOfferShare(env, u, TEST_PHONE, { taskId: t.id }),
    ),
  );
  expect(offers()).toHaveLength(1);
  expect((await state())!.state).toBe("offered");
  expect(JSON.stringify(offers())).not.toContain("שם פרטי");
  expect(wa().every((p) => p.to === TEST_PHONE)).toBe(true);
  expect(wa().some((p) => p.interactive?.type === "cta_url")).toBe(false);
});
it("the discovery cooldown defers the offer without consuming its one-time claim", async () => {
  const { t } = await experienced();
  await env.CACHE.put(`guide:v2:${actor}:cooldown`, "1", {
    expirationTtl: 300,
  });
  await maybeOfferShare(env, await user(), TEST_PHONE, { taskId: t.id });
  expect(await state()).toBeNull();
  await env.CACHE.delete(`guide:v2:${actor}:cooldown`);
  await maybeOfferShare(env, await user(), TEST_PHONE, { taskId: t.id });
  expect(offers()).toHaveLength(1);
});
it("dismissal is permanent for automatic offers while /share remains available", async () => {
  const { t } = await experienced();
  await maybeOfferShare(env, await user(), TEST_PHONE, { taskId: t.id });
  await handleShareControl(
    env,
    await user(),
    TEST_PHONE,
    await shareToken("later"),
  );
  await env.CACHE.delete(`guide:v2:${actor}:cooldown`);
  await maybeOfferShare(env, await user(), TEST_PHONE, { taskId: t.id });
  expect(offers()).toHaveLength(1);
  expect((await state())!.state).toBe("dismissed");
  await sendShareDraft(env, await user(), TEST_PHONE);
  expect((await state())!.state).toBe("opened");
});
it("opening the action prepares a public message and contact-selection URL only", async () => {
  await handleShareControl(
    env,
    await user(),
    TEST_PHONE,
    await shareToken("open"),
  );
  const p = wa().at(-1);
  expect(p.interactive.type).toBe("cta_url");
  expect(p.interactive.action.parameters.display_text).toBe("שתף עם חבר");
  const url = new URL(p.interactive.action.parameters.url);
  expect(url.origin).toBe("https://wa.me");
  expect(url.pathname).toBe("/");
  expect(url.searchParams.get("text")).toBe(SHARE_MESSAGE);
  expect(SHARE_MESSAGE).toContain(BOT_WHATSAPP_URL);
  expect(SHARE_MESSAGE).not.toContain("20 ₪");
  expect(SHARE_MESSAGE).not.toContain("NEWS50");
  expect(wa().every((p) => p.to === TEST_PHONE)).toBe(true);
});
it("public sharing content respects WhatsApp body, button and URL bounds", async () => {
  await sendShareDraft(env, await user(), TEST_PHONE);
  const p = wa().at(-1);
  expect(p.interactive.body.text.length).toBeLessThanOrEqual(1024);
  expect(
    p.interactive.action.parameters.display_text.length,
  ).toBeLessThanOrEqual(20);
  expect(SHARE_URL.length).toBeLessThanOrEqual(2048);
});
it("explicitly opening a draft prevents a later automatic share offer", async () => {
  const { t } = await experienced();
  await sendShareDraft(env, await user(), TEST_PHONE);
  await env.CACHE.delete(`guide:v2:${actor}:cooldown`);
  await maybeOfferShare(env, await user(), TEST_PHONE, { taskId: t.id });
  expect(offers()).toHaveLength(0);
});
it("a rejected CTA falls back to a ready message and public share link", async () => {
  const base = makeMockFetch();
  mock.mockImplementation((url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    return body.interactive?.type === "cta_url"
      ? Promise.resolve(
          Response.json({ error: { code: 100 } }, { status: 400 }),
        )
      : base(url);
  });
  await sendShareDraft(env, await user(), TEST_PHONE);
  expect(wa().at(-1).text.body).toContain(SHARE_MESSAGE);
  expect(wa().at(-1).text.body).toContain(SHARE_URL);
  expect(wa().at(-1).text.body.length).toBeLessThanOrEqual(4096);
});
it("uncertain network failures do not resend an invite or mark a draft opened", async () => {
  mock.mockRejectedValue(new Error("network failure"));
  await expect(sendShareDraft(env, await user(), TEST_PHONE)).rejects.toThrow(
    "network failure",
  );
  expect(mock).toHaveBeenCalledTimes(1);
  expect(await state()).toBeNull();
});
it("forged, other-user, expired and unknown actions cannot open drafts", async () => {
  const payload = await shareToken("open"),
    other = (await getUserById(db, await createTestUser(TEST_PHONE_2)))!;
  expect(await handleShareControl(env, other, TEST_PHONE_2, payload)).toBe(
    false,
  );
  expect(
    await handleShareControl(
      env,
      await user(),
      TEST_PHONE,
      payload.slice(0, -1) + "z",
    ),
  ).toBe(false);
  await handleShareControl(
    env,
    await user(),
    TEST_PHONE,
    await shareToken("open", now() - 1),
  );
  expect(
    await handleShareControl(
      env,
      await user(),
      TEST_PHONE,
      await shareToken("send-all"),
    ),
  ).toBe(false);
  expect(wa().some((p) => p.interactive?.type === "cta_url")).toBe(false);
  expect(await state()).toBeNull();
});
it("failed provider delivery is not treated as a success milestone", async () => {
  const { t, job } = await experienced();
  await env.DB.prepare(
    "UPDATE reminder_delivery SET delivery_status='failed' WHERE job_id=?",
  )
    .bind(job.id)
    .run();
  await maybeOfferShare(env, await user(), TEST_PHONE, { taskId: t.id });
  expect(offers()).toHaveLength(0);
  expect(await state()).toBeNull();
});
it("another recipient receipt cannot qualify this actor", async () => {
  const { t, job } = await experienced();
  const other = await createTestUser(TEST_PHONE_2);
  await env.DB.prepare("UPDATE reminder_delivery SET user_id=? WHERE job_id=?")
    .bind(other, job.id)
    .run();
  await maybeOfferShare(env, await user(), TEST_PHONE, { taskId: t.id });
  expect(await state()).toBeNull();
});
it("an Undo group qualifies only actual completed reminder tasks and its actor", async () => {
  const { t, undo } = await experienced();
  await maybeOfferShare(env, await user(), TEST_PHONE, {
    groupId: undo.groupId,
  });
  expect(offers()).toHaveLength(1);
  expect(
    (await getTaskById(db, env.ENCRYPTION_KEY, t.id, [actor]))!.status,
  ).toBe("completed");
});
it("Done on a delivered recurring occurrence can offer sharing without creating another successor", async () => {
  const { t } = await experienced(true);
  const payload = (await reminderButtons(env, actor, t))[0].id;
  await handleTaskControl(env, await user(), TEST_PHONE, payload);
  expect(offers()).toHaveLength(1);
  expect(
    (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM task WHERE status='pending'",
    ).first<{ n: number }>())!.n,
  ).toBe(1);
});
it("a share prompt transport failure cannot undo a successful task completion", async () => {
  const t = await addTask(
      db,
      env.ENCRYPTION_KEY,
      actor,
      "תזכורת",
      new Date(Date.now() - 60000),
    ),
    job = await ensureReminderJob(env, t);
  await deliverReminderJob(env, job.id);
  const base = makeMockFetch();
  mock.mockImplementation((url: any, init: any) => {
    const p = init?.body ? JSON.parse(init.body) : {};
    return p.interactive?.body?.text?.includes("טודו עזר לך לזכור")
      ? Promise.reject(new Error("network failure"))
      : base(url);
  });
  await expect(
    handleTaskControl(
      env,
      await user(),
      TEST_PHONE,
      (await taskActionButtons(env, actor, t))[0].id,
    ),
  ).resolves.toBe(true);
  expect(
    (await getTaskById(db, env.ENCRYPTION_KEY, t.id, [actor]))!.status,
  ).toBe("completed");
});
it("/share and share controls remain available after trial expiry", async () => {
  const u = await user();
  await env.DB.prepare(
    "UPDATE billing_account SET trial_ends_at=1 WHERE phone_hash=?",
  )
    .bind(u.phone_number_hash)
    .run();
  await SELF.fetch(await makeSignedWebhookRequest("/share"));
  await drainConversation();
  expect(wa().some((p) => p.interactive?.type === "cta_url")).toBe(true);
  await SELF.fetch(
    await makeSignedWebhookRequestFromMessage({
      from: TEST_PHONE,
      id: crypto.randomUUID(),
      type: "interactive",
      interactive: { button_reply: { id: await shareToken("open") } },
    }),
  );
  await drainConversation();
  expect(wa().filter((p) => p.interactive?.type === "cta_url")).toHaveLength(2);
});
it("account deletion removes the share-offer metadata", async () => {
  await sendShareDraft(env, await user(), TEST_PHONE);
  await deleteUserAndData(db, actor, null);
  expect(
    await env.DB.prepare("SELECT 1 FROM user_share_offer").first(),
  ).toBeNull();
});
