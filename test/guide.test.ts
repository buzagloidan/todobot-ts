/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { buildDb } from "../src/db/client.ts";
import {
  getUserById,
  getUserTasks,
  getTaskById,
  addTask,
} from "../src/db/queries.ts";
import {
  HELP_TEXT,
  MORE_HELP_TEXT,
  WELCOME_TEXT,
  sendWelcomeMessage,
  sendGuide,
  handleGuideControl,
  afterTaskChanges,
} from "../src/services/guide.ts";
import { signControl } from "../src/services/controls.ts";
import { undoTasks, newUndoContext } from "../src/services/task_undo.ts";
import { getOrCreateProject } from "../src/services/projects.ts";
import { processWebhookMessage } from "../src/routes/webhook.ts";
import { dispatchQueueMessage } from "../src/queue/consumer.ts";
import { validateTaskResponse } from "../src/services/task_response.ts";
import { refreshRemindersForPhone } from "../src/reminder_scheduler.ts";
import {
  applySchema,
  clearData,
  createTestUser,
  makeMockFetch,
  TEST_PHONE,
  TEST_PHONE_2,
} from "./helpers.ts";
let owner: number, fetchMock: ReturnType<typeof vi.fn>;
const db = buildDb(env),
  now = () => Math.floor(Date.now() / 1000);
beforeAll(applySchema);
beforeEach(async () => {
  await clearData();
  owner = await createTestUser();
  fetchMock = vi.fn(makeMockFetch());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const user = async () => (await getUserById(db, owner))!;
const wa = () =>
  fetchMock.mock.calls
    .filter(
      ([url, init]) => String(url).includes("graph.facebook.com") && init?.body,
    )
    .map(([, init]) => JSON.parse(init.body));
const bodies = () =>
  wa()
    .map((p) => p.text?.body ?? p.interactive?.body?.text)
    .filter(Boolean);
const message = async (text: string) =>
  processWebhookMessage(
    {
      from: TEST_PHONE,
      id: crypto.randomUUID(),
      type: "text",
      text: { body: text },
    },
    env,
  );
const control = (action: string, expiry = now() + 600) =>
  signControl(env, "guide", owner, action, expiry);
async function create(title = "משימה", due: number | null = null) {
  const undo = newUndoContext(owner);
  await addTask(
    db,
    env.ENCRYPTION_KEY,
    owner,
    title,
    due === null ? null : new Date(due * 1000),
    null,
    undo,
  );
  return undo;
}
it("help fits WhatsApp interactive limits and exposes core features without legacy modes", async () => {
  await sendWelcomeMessage(env, TEST_PHONE, owner);
  await sendGuide(env, await user(), TEST_PHONE, "help");
  await sendGuide(env, await user(), TEST_PHONE, "more");
  for (const p of wa()) {
    expect(p.interactive.body.text.length).toBeLessThanOrEqual(1024);
    expect(p.interactive.action.buttons.length).toBeLessThanOrEqual(3);
    for (const b of p.interactive.action.buttons)
      expect(b.reply.title.length).toBeLessThanOrEqual(20);
  }
  for (const text of [HELP_TEXT, MORE_HELP_TEXT, WELCOME_TEXT])
    expect(text).not.toMatch(/\/board|\/biz|tax|מס כלול|חשבונית/);
  expect(HELP_TEXT).toContain("/calendar");
  expect(HELP_TEXT).toContain("#");
  expect(HELP_TEXT).toContain("/help more");
  expect((await getUserTasks(db, env.ENCRYPTION_KEY, [owner])).length).toBe(0);
});
it("greetings send one welcome, then a useful start guide, without Gemini or a repeated trial notice", async () => {
  await env.DB.prepare("UPDATE user SET created_at=? WHERE id=?")
    .bind(now(), owner)
    .run();
  await message("היי");
  expect(bodies()).toEqual([WELCOME_TEXT]);
  await message("שלום");
  expect(bodies().length).toBe(2);
  expect(bodies()[1]).toContain("מה צריך לעשות");
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes("generativelanguage"),
    ),
  ).toBe(false);
  expect(await env.CACHE.get(`welcomed:${owner}`)).toBe("1");
});
it("legacy consent buttons return one start guide", async () => {
  await processWebhookMessage(
    {
      from: TEST_PHONE,
      id: crypto.randomUUID(),
      type: "interactive",
      interactive: { button_reply: { id: "agree_btn", title: "מסכים" } },
    },
    env,
  );
  expect(bodies()).toHaveLength(1);
  expect(bodies()[0]).toContain("מה צריך לעשות");
});
it("# lists projects and # name shows its tasks without Gemini", async () => {
  await getOrCreateProject(env, owner, "עבודה");
  await message("#");
  await message("# עבודה");
  expect(bodies().join("\n")).toContain("עבודה");
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes("generativelanguage"),
    ),
  ).toBe(false);
});
it("old business session flags cannot capture help or retired commands", async () => {
  await env.DB.prepare(
    "UPDATE user SET biz_setup_state='company_name' WHERE id=?",
  )
    .bind(owner)
    .run();
  await env.CACHE.put(`biz_mode:${owner}`, "1");
  await env.CACHE.put(`biz_mode:${TEST_PHONE}`, "1");
  await message("/help");
  await message("/biz");
  await message("/board");
  expect(bodies()[0]).toBe(HELP_TEXT);
  expect(bodies().slice(1)).toEqual([
    "לא זיהיתי את הפקודה. /help — המדריך הקצר.",
    "לא זיהיתי את הפקודה. /help — המדריך הקצר.",
  ]);
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes("generativelanguage"),
    ),
  ).toBe(false);
});
it("retired board model actions invalidate the entire action batch", () => {
  expect(
    validateTaskResponse({
      tasks: [
        { action: "add", title: "קניות" },
        { action: "board_show", title: "" },
      ],
      intent: "task_management",
      reply: "",
    }),
  ).toBe(false);
});
it("signed demo creates exactly one encrypted task and undo snapshot across simultaneous retries", async () => {
  const payload = await control("demo"),
    u = await user(),
    before = now();
  await Promise.all([
    handleGuideControl(env, u, TEST_PHONE, payload),
    handleGuideControl(env, u, TEST_PHONE, payload),
  ]);
  const tasks = await getUserTasks(db, env.ENCRYPTION_KEY, [owner]);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].description).toBe("בדיקת התזכורת הראשונה");
  expect(
    Math.floor(+new Date(tasks[0].due_date!) / 1000) - before,
  ).toBeGreaterThanOrEqual(59);
  expect(
    Math.floor(+new Date(tasks[0].due_date!) / 1000) - before,
  ).toBeLessThanOrEqual(62);
  expect(
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM task_undo_change").first<{
      n: number;
    }>())!.n,
  ).toBe(1);
  const raw = await env.DB.prepare("SELECT description FROM task").first<{
    description: string;
  }>();
  expect(raw!.description).not.toContain("בדיקת");
  await undoTasks(env, owner);
  expect(
    (await getTaskById(db, env.ENCRYPTION_KEY, tasks[0].id, [owner]))?.status,
  ).not.toBe("pending");
  await handleGuideControl(env, u, TEST_PHONE, payload);
  expect(
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM task").first<{
      n: number;
    }>())!.n,
  ).toBeLessThanOrEqual(1);
});
it("demo task participates in the persistent reminder scheduler", async () => {
  const enabled = { ...env, REMINDER_SCHEDULER_ENABLED: "true" };
  await handleGuideControl(
    enabled,
    await user(),
    TEST_PHONE,
    await control("demo"),
  );
  await refreshRemindersForPhone(enabled, TEST_PHONE);
  const stub = env.REMINDER_SCHEDULERS.getByName(`owner:${owner}`);
  // The scheduler uses the owner ID for its Durable Object identity.
  expect(
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    ),
  ).not.toBeNull();
});
it("forged, other-user and expired demo buttons cannot create tasks", async () => {
  const u = await user(),
    payload = await control("demo"),
    other = (await getUserById(db, await createTestUser(TEST_PHONE_2)))!;
  expect(
    await handleGuideControl(env, u, TEST_PHONE, payload.slice(0, -1) + "z"),
  ).toBe(false);
  expect(await handleGuideControl(env, other, TEST_PHONE_2, payload)).toBe(
    false,
  );
  await handleGuideControl(
    env,
    u,
    TEST_PHONE,
    await control("demo", now() - 1),
  );
  expect((await getUserTasks(db, env.ENCRYPTION_KEY, [owner])).length).toBe(0);
});
it("expired trials retain help and account access but cannot run demos", async () => {
  const u = await user();
  await env.DB.prepare(
    "UPDATE billing_account SET trial_ends_at=1 WHERE phone_hash=?",
  )
    .bind(u.phone_number_hash)
    .run();
  await message("/help more");
  expect(bodies()[0]).toBe(MORE_HELP_TEXT);
  await handleGuideControl(env, u, TEST_PHONE, await control("demo"));
  expect((await getUserTasks(db, env.ENCRYPTION_KEY, [owner])).length).toBe(0);
});
it("Calendar buttons create a private connection link without creating tasks", async () => {
  await handleGuideControl(
    env,
    await user(),
    TEST_PHONE,
    await control("calendar"),
  );
  expect(bodies()[0]).toMatch(/\/calendar\/connect\?token=/);
  expect((await getUserTasks(db, env.ENCRYPTION_KEY, [owner])).length).toBe(0);
});
it("discovery is tied to successful creation, once per feature and at most once per day", async () => {
  const u = await user();
  await afterTaskChanges(env, u, TEST_PHONE, "nonexistent");
  expect(bodies()).toHaveLength(0);
  const first = await create("ראשונה", now() + 3600);
  await afterTaskChanges(env, u, TEST_PHONE, first.groupId);
  expect(bodies()).toHaveLength(1);
  expect(bodies()[0]).toContain("ביומן Google");
  const second = await create("שנייה", now() + 3600);
  await afterTaskChanges(env, u, TEST_PHONE, second.groupId);
  expect(bodies()).toHaveLength(1);
  await env.CACHE.delete(`guide:v2:${owner}:cooldown`);
  const third = await create("שלישית", now() + 3600);
  await afterTaskChanges(env, u, TEST_PHONE, third.groupId);
  expect(bodies()).toHaveLength(2);
  expect(bodies()[1]).toContain("לקבץ");
  await env.CACHE.delete(`guide:v2:${owner}:cooldown`);
  const fourth = await create("רביעית", now() + 3600);
  await afterTaskChanges(env, u, TEST_PHONE, fourth.groupId);
  expect(bodies()).toHaveLength(2);
});
it("used features and the welcome cooldown suppress discovery prompts", async () => {
  await env.DB.prepare(
    "INSERT INTO google_calendar_connection(user_id,connection_id,calendar_id_encrypted,status) VALUES (?,?,?,'connected')",
  )
    .bind(owner, crypto.randomUUID(), "unused-encrypted-calendar")
    .run();
  const u = await user();
  await getOrCreateProject(env, owner, "בית");
  for (let i = 0; i < 3; i++) {
    const ctx = await create("פריט " + i, now() + 3600);
    await afterTaskChanges(env, u, TEST_PHONE, ctx.groupId);
  }
  expect(bodies()).toHaveLength(0);
});
it("welcome cooldown lets task creation succeed without an immediate discovery burst", async () => {
  await env.CACHE.put(`guide:v2:${owner}:cooldown`, "1", {
    expirationTtl: 300,
  });
  const ctx = await create("ראשונה", now() + 3600);
  await afterTaskChanges(env, await user(), TEST_PHONE, ctx.groupId);
  expect(bodies()).toHaveLength(0);
  expect(await env.CACHE.get(`guide:v2:${owner}:activated`)).toBe("1");
});
it("activation analytics contain counts and feature flags, never task text or phone numbers", async () => {
  const analytics = { ...env, POSTHOG_API_KEY: "test-analytics" };
  const ctx = await create("פריט פרטי", now() + 3600);
  await afterTaskChanges(analytics, await user(), TEST_PHONE, ctx.groupId);
  const events = fetchMock.mock.calls
    .filter(([url]) => String(url).includes("posthog"))
    .map(([, init]) => JSON.parse(init.body));
  expect(
    events.some(
      (e) =>
        e.event === "first_task_created" && e.properties.has_due_date === true,
    ),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("פריט פרטי");
  expect(JSON.stringify(events)).not.toContain(TEST_PHONE);
});

it("first natural-language task works without a consent click or business-mode interception", async () => {
  await env.DB.prepare(
    "UPDATE user SET biz_setup_state='company_name',created_at=? WHERE id=?",
  )
    .bind(now(), owner)
    .run();
  await env.CACHE.put(`biz_mode:${owner}`, "1");
  const base = makeMockFetch();
  fetchMock.mockImplementation((url: any) =>
    String(url).includes("generativelanguage")
      ? Promise.resolve(
          Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        tasks: [
                          { action: "add", title: "לקרוא ספר", due_date: null },
                        ],
                        intent: "task_management",
                        reply: "בוצע",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        )
      : base(url),
  );
  await message("תוסיף לי לקרוא ספר");
  expect(
    (await getUserTasks(db, env.ENCRYPTION_KEY, [owner])).map(
      (t) => t.description,
    ),
  ).toEqual(["לקרוא ספר"]);
  expect(bodies().filter((t) => t === WELCOME_TEXT)).toHaveLength(1);
  expect(await env.CACHE.get(`guide:v2:${owner}:activated`)).toBe("1");
  const llm = fetchMock.mock.calls.find(([url]) =>
    String(url).includes("generativelanguage"),
  );
  expect(llm).toBeDefined();
  expect(llm![1].body).not.toMatch(/board_show|board_create|business mode/);
});

it("failed demo transactions roll back consumption so a retry can succeed", async () => {
  const payload = await control("demo"),
    u = await user();
  await env.DB.prepare(
    "CREATE TRIGGER fail_demo BEFORE INSERT ON task BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  ).run();
  await expect(
    handleGuideControl(env, u, TEST_PHONE, payload),
  ).rejects.toThrow();
  expect(
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM task_control_use").first<{
      n: number;
    }>())!.n,
  ).toBe(0);
  await env.DB.prepare("DROP TRIGGER fail_demo").run();
  await handleGuideControl(env, u, TEST_PHONE, payload);
  expect((await getUserTasks(db, env.ENCRYPTION_KEY, [owner])).length).toBe(1);
});
it("quick task creation also records activation", async () => {
  await message("+לקנות לחם");
  expect(
    (await getUserTasks(db, env.ENCRYPTION_KEY, [owner])).map(
      (t) => t.description,
    ),
  ).toEqual(["לקנות לחם"]);
  expect(await env.CACHE.get(`guide:v2:${owner}:activated`)).toBe("1");
});
