/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { buildDb } from "../src/db/client.ts";
import {
  addTask,
  getUserById,
  getTaskById,
  addTaskAssignees,
  updateTaskById,
  deleteUserAndData,
  saveMessage,
} from "../src/db/queries.ts";
import {
  showTaskList,
  handleTaskBrowser,
} from "../src/services/task_browser.ts";
import {
  showTaskDetails,
  taskActionButtons,
  handleTaskControl,
  sendTaskReply,
} from "../src/services/task_controls.ts";
import {
  showTimeChoices,
  handleTaskSchedule,
  continueTaskSchedule,
  presetDue,
  parseSimpleTime,
  isTimeOnlyReply,
} from "../src/services/task_schedule.ts";
import {
  getOrCreateProject,
  handleProjectControl,
  showProject,
} from "../src/services/projects.ts";
import { newUndoContext, undoTasks } from "../src/services/task_undo.ts";
import { dispatchQueueMessage } from "../src/queue/consumer.ts";
import { signControl, verifyControl } from "../src/services/controls.ts";
import { refreshRemindersForPhone } from "../src/reminder_scheduler.ts";
import {
  ensureReminderJob,
  deliverReminderJob,
} from "../src/services/reminder_dispatch.ts";
import { parseDueDate } from "../src/time.ts";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const user = async () => (await getUserById(db, actor))!;
const task = (id: number) => getTaskById(db, env.ENCRYPTION_KEY, id, [actor]);
const add = (
  title = "להתקשר לבנק",
  due: Date | null = null,
  recurrence: string | null = null,
) => addTask(db, env.ENCRYPTION_KEY, actor, title, due, recurrence);
const wa = () =>
  mock.mock.calls
    .filter(
      ([url, init]) => String(url).includes("graph.facebook.com") && init?.body,
    )
    .map(([, init]) => JSON.parse(init.body));
const last = () => wa().at(-1);
const rows = () =>
  last().interactive.action.sections.flatMap((s: any) => s.rows);
const button = (name: string) =>
  last().interactive.action.buttons.find((b: any) => b.reply.title === name)
    .reply.id;
const noAI = () =>
  !mock.mock.calls.some(([url]) => String(url).includes("generativelanguage"));
const token = (
  t: { id: number; revision: number },
  action: string,
  expiry = now() + 600,
) => signControl(env, "schedule", actor, t.id, t.revision, action, expiry);
async function custom(t: { id: number; revision: number }) {
  await handleTaskSchedule(
    env,
    await user(),
    TEST_PHONE,
    await token(t, "custom"),
  );
  return last().interactive.action.buttons[0].reply.id;
}
async function webhook(text: string) {
  await SELF.fetch(await makeSignedWebhookRequest(text));
  await drainConversation();
}
async function click(id: string) {
  await SELF.fetch(
    await makeSignedWebhookRequestFromMessage({
      from: TEST_PHONE,
      id: crypto.randomUUID(),
      type: "interactive",
      interactive: { list_reply: { id } },
    }),
  );
  await drainConversation();
}
function gemini(tasks: object[]) {
  const base = makeMockFetch();
  mock.mockImplementation((url: any) =>
    String(url).includes("generativelanguage")
      ? Promise.resolve(
          Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        tasks,
                        intent: "task_management",
                        reply: "",
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
}
it("opens ? as a named picker and completes the exact selected task without Gemini", async () => {
  const a = await add("לקנות חלב"),
    b = await add("לקנות לחם", new Date(Date.now() + 3600000));
  await webhook("?");
  expect(last().interactive.type).toBe("list");
  expect(rows().map((r: any) => r.title)).toEqual(["לקנות לחם", "לקנות חלב"]);
  await click(rows()[1].id);
  expect(last().interactive.body.text).toContain("לקנות חלב");
  expect(
    last().interactive.action.buttons.map((b: any) => b.reply.title),
  ).toEqual(["הושלם ✅", "קבע תזכורת", "בטל משימה"]);
  await click(button("הושלם ✅"));
  expect((await task(a.id))!.status).toBe("completed");
  expect((await task(b.id))!.status).toBe("pending");
  expect(noAI()).toBe(true);
});
it("pages through every task with next/previous controls and preserves filters", async () => {
  for (let i = 0; i < 19; i++)
    await add("פריט " + i, new Date(Date.now() + (i + 1) * 60000));
  await showTaskList(env, await user(), TEST_PHONE, "1d");
  const seen = new Set<number>();
  for (let page = 0; page < 3; page++) {
    expect(rows().length).toBeLessThanOrEqual(10);
    for (const row of rows()) {
      const c = await verifyControl(env, row.id, actor);
      expect(c!.values[2]).toBe("1d");
      if (c!.values[1] === "task") seen.add(+c!.values[3]);
    }
    const next = rows().find((r: any) => r.title === "עוד משימות");
    if (next) await handleTaskBrowser(env, await user(), TEST_PHONE, next.id);
  }
  expect(seen.size).toBe(19);
  const prev = rows().find((r: any) => r.title === "העמוד הקודם");
  await handleTaskBrowser(env, await user(), TEST_PHONE, prev.id);
  expect(last().interactive.body.text).toContain("עמוד 2/3");
});
it("?1 and ?2 preserve their due-date filters and do not hide overdue tasks", async () => {
  await add("באיחור", new Date(Date.now() - 60000));
  await add("היום", new Date(Date.now() + 3600000));
  await add("יומיים", new Date(Date.now() + 36 * 3600000));
  await add("ללא שעה");
  await webhook("?1");
  expect(rows().map((r: any) => r.title)).toEqual(["באיחור", "היום"]);
  await webhook("?2");
  expect(rows().map((r: any) => r.title)).toEqual(["באיחור", "היום", "יומיים"]);
});
it("long names and lists respect WhatsApp limits and show full names before action", async () => {
  const long = "אבגדה ".repeat(165).trim();
  const t = await add(long);
  for (let i = 0; i < 9; i++) await add(long + i);
  await showTaskList(env, await user(), TEST_PHONE);
  for (const r of rows()) {
    expect(r.title.length).toBeLessThanOrEqual(24);
    expect(r.description.length).toBeLessThanOrEqual(72);
  }
  expect(last().interactive.body.text.length).toBeLessThanOrEqual(1024);
  await showTaskDetails(env, await user(), TEST_PHONE, t, "פרויקט ".repeat(20));
  expect(
    wa().some((p) =>
      (p.text?.body ?? p.interactive?.body?.text)?.includes(long),
    ),
  ).toBe(true);
  for (const p of wa())
    if (p.interactive) {
      expect(p.interactive.body.text.length).toBeLessThanOrEqual(1024);
      for (const b of p.interactive.action.buttons ?? [])
        expect(b.reply.title.length).toBeLessThanOrEqual(20);
    }
});
it("names duplicated across projects are shown with project context and act independently", async () => {
  const a = await getOrCreateProject(env, actor, "בית"),
    b = await getOrCreateProject(env, actor, "עבודה");
  const ta = await addTask(
    db,
    env.ENCRYPTION_KEY,
    actor,
    "לשלוח מסמך",
    null,
    null,
    undefined,
    { projectId: a.id },
  );
  const tb = await addTask(
    db,
    env.ENCRYPTION_KEY,
    actor,
    "לשלוח מסמך",
    new Date(Date.now() + 3600000),
    null,
    undefined,
    { projectId: b.id },
  );
  await showTaskList(env, await user(), TEST_PHONE);
  expect(last().interactive.body.text).toContain("בית");
  expect(last().interactive.body.text).toContain("עבודה");
  const row = rows().find((r: any) => r.description.includes("עבודה"));
  await handleTaskBrowser(env, await user(), TEST_PHONE, row.id);
  expect(last().interactive.body.text).toContain("עבודה");
  await handleTaskSchedule(env, await user(), TEST_PHONE, button("בטל משימה"));
  expect((await task(tb.id))!.status).toBe("cancelled");
  expect((await task(ta.id))!.status).toBe("pending");
});
it("tagged friends see only assigned tasks and revoked assignments invalidate old selections", async () => {
  const other = await createTestUser(TEST_PHONE_2),
    p = await getOrCreateProject(env, other, "פרטי");
  const assigned = await addTask(
    db,
    env.ENCRYPTION_KEY,
    other,
    "הפריט המשותף",
    null,
    null,
    undefined,
    { projectId: p.id },
  );
  await addTask(
    db,
    env.ENCRYPTION_KEY,
    other,
    "אח פרטי",
    null,
    null,
    undefined,
    { projectId: p.id },
  );
  await addTaskAssignees(db, assigned.id, [actor]);
  await showTaskList(env, await user(), TEST_PHONE);
  expect(rows().map((r: any) => r.title)).toEqual(["הפריט המשותף"]);
  expect(JSON.stringify(last())).not.toContain("אח פרטי");
  const selected = rows()[0].id;
  await env.DB.prepare("DELETE FROM task_assignee WHERE task_id=?")
    .bind(assigned.id)
    .run();
  await handleTaskBrowser(env, await user(), TEST_PHONE, selected);
  expect(last().text.body).toContain("אינה זמינה");
});
it("rejects forged, expired, other-user and stale list selections", async () => {
  const t = await add();
  await showTaskList(env, await user(), TEST_PHONE);
  const selected = rows()[0].id;
  expect(
    await handleTaskBrowser(
      env,
      await user(),
      TEST_PHONE,
      selected.replace(":all:", ":2d:"),
    ),
  ).toBe(false);
  const other = (await getUserById(db, await createTestUser(TEST_PHONE_2)))!;
  expect(await handleTaskBrowser(env, other, TEST_PHONE_2, selected)).toBe(
    false,
  );
  await handleTaskBrowser(
    env,
    await user(),
    TEST_PHONE,
    await signControl(
      env,
      "browse",
      actor,
      "task",
      "all",
      t.id,
      t.revision,
      now() - 1,
    ),
  );
  expect(last().text.body).toContain("פגה");
  await updateTaskById(db, env.ENCRYPTION_KEY, t.id, [actor], {
    description: "שם אחר",
  });
  await handleTaskBrowser(env, await user(), TEST_PHONE, selected);
  expect(last().text.body).toContain("השתנתה");
});
it("creation buttons adapt and opening the time picker makes no task changes", async () => {
  const undo = newUndoContext(actor),
    t = await addTask(
      db,
      env.ENCRYPTION_KEY,
      actor,
      "ללא שעה",
      null,
      null,
      undo,
    );
  await sendTaskReply(env, actor, TEST_PHONE, "נוספה", undo, t.id);
  expect(button("קבע תזכורת")).toBeDefined();
  await handleTaskSchedule(env, await user(), TEST_PHONE, button("קבע תזכורת"));
  expect(rows().some((r: any) => r.title === "זמן אחר")).toBe(true);
  expect((await task(t.id))!.due_date).toBeNull();
  const dated = await add("עם שעה", new Date(Date.now() + 3600000));
  expect((await taskActionButtons(env, actor, dated))[1].title).toBe("שנה זמן");
});
it("schedules a task once, resets reminder state, preserves its project/recurrence and supports Undo", async () => {
  const p = await getOrCreateProject(env, actor, "בית"),
    original = new Date(Date.now() + 3600000);
  const t = await addTask(
    db,
    env.ENCRYPTION_KEY,
    actor,
    "יומי",
    original,
    "daily",
    undefined,
    { projectId: p.id },
  );
  await env.DB.prepare("UPDATE task SET reminder_sent=1 WHERE id=?")
    .bind(t.id)
    .run();
  const due = new Date(Date.now() + 86400000),
    payload = await token(t, String(Math.floor(+due / 1000)));
  await Promise.all([
    handleTaskSchedule(env, await user(), TEST_PHONE, payload),
    handleTaskSchedule(env, await user(), TEST_PHONE, payload),
  ]);
  const changed = (await task(t.id))!;
  expect(+changed.due_date!).toBe(Math.floor(+due / 1000) * 1000);
  expect(changed.reminder_sent).toBe(false);
  expect(changed.project_id).toBe(p.id);
  expect(changed.recurrence).toBe("daily");
  expect(changed.revision).toBe(t.revision + 1);
  await undoTasks(env, actor);
  expect(+(await task(t.id))!.due_date!).toBe(
    Math.floor(+original / 1000) * 1000,
  );
  expect((await task(t.id))!.reminder_sent).toBe(true);
});
it("presets retain their displayed dates across midnight and omit past evenings", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T20:58:00Z"));
  const t = await add();
  await showTimeChoices(env, await user(), TEST_PHONE, t);
  expect(rows().some((r: any) => r.title.startsWith("היום בערב"))).toBe(false);
  const choice = rows().find((r: any) => r.title.startsWith("מחר בבוקר")),
    payload = choice.id;
  vi.setSystemTime(new Date("2026-10-13T21:02:00Z"));
  await handleTaskSchedule(env, await user(), TEST_PHONE, payload);
  expect(
    (await task(t.id))!
      .due_date!.toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" })
      .slice(0, 16),
  ).toBe("2026-10-14 09:00");
});
it("morning presets stay at 09:00 through the Israel daylight-saving transition", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T18:00:00Z"));
  expect(
    presetDue("morning")!
      .toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" })
      .slice(0, 16),
  ).toBe("2026-10-25 09:00");
});
it("custom numeric replies update the selected task only, without Gemini", async () => {
  const a = await add("משימה א"),
    b = await add("משימה ב");
  await custom(a);
  expect(
    await continueTaskSchedule(env, await user(), TEST_PHONE, "מחר ב־10:00"),
  ).toBe(true);
  expect((await task(a.id))!.due_date).not.toBeNull();
  expect((await task(b.id))!.due_date).toBeNull();
  expect(noAI()).toBe(true);
});
it("time-only parsing supports relative durations, numeric hours and explicit dates", () => {
  expect(parseSimpleTime("בעוד שתי שעות")).toBeNull();
  expect(
    Math.round((+parseSimpleTime("בעוד שעתיים")! - Date.now()) / 1000),
  ).toBe(7200);
  expect(isTimeOnlyReply("מחר ב10:00")).toBe(true);
  expect(parseSimpleTime("מחר ב10")).not.toBeNull();
  expect(
    parseSimpleTime("20/10/2026 ב14:30")!
      .toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" })
      .slice(0, 16),
  ).toBe("2026-10-20 14:30");
});
it("malformed clocks, impossible dates, past times and vague times do not change tasks or call Gemini", async () => {
  const t = await add();
  await custom(t);
  for (const input of [
    "מחר ב־25:00",
    "31/02/2027 ב10:00",
    "היום ב00:01",
    "מחר בבוקר",
  ]) {
    await continueTaskSchedule(env, await user(), TEST_PHONE, input);
    expect((await task(t.id))!.due_date).toBeNull();
  }
  expect(noAI()).toBe(true);
});
it("spoken time extraction cannot rename tasks, create tasks or change recurrence", async () => {
  const t = await add("המשימה הנבחרת"),
    other = await add("משימה אחרת");
  await custom(t);
  gemini([
    {
      action: "update",
      title: "משימה אחרת",
      new_title: "אסור לשנות",
      new_due_date: "2026-12-01 08:30",
    },
  ]);
  await continueTaskSchedule(env, await user(), TEST_PHONE, "מחר בשמונה וחצי");
  expect((await task(t.id))!.due_date!.toISOString()).toBe(
    parseDueDate("2026-12-01 08:30")!.toISOString(),
  );
  expect((await task(t.id))!.description).toBe("המשימה הנבחרת");
  expect((await task(t.id))!.recurrence).toBeNull();
  expect((await task(other.id))!.due_date).toBeNull();
  expect(
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM task").first<{
      n: number;
    }>())!.n,
  ).toBe(2);
});
it("a model batch with multiple actions cannot apply a custom time", async () => {
  const t = await add();
  await custom(t);
  gemini([
    { action: "update", title: "א", new_due_date: "2026-12-01 08:00" },
    { action: "add", title: "ב", due_date: "2026-12-01 08:00" },
  ]);
  await continueTaskSchedule(env, await user(), TEST_PHONE, "מחר בשמונה");
  expect((await task(t.id))!.due_date).toBeNull();
});
it("unrelated requests and replies quoted to another message cannot be intercepted by a time draft", async () => {
  const t = await add();
  await custom(t);
  for (const text of [
    "תוסיף לקנות חלב מחר",
    "מחר תזכיר לי להתקשר לבנק",
    "סיימתי את המשימה",
    "?",
  ])
    expect(
      await continueTaskSchedule(env, await user(), TEST_PHONE, text),
    ).toBe(false);
  expect(
    await continueTaskSchedule(
      env,
      await user(),
      TEST_PHONE,
      "מחר ב10:00",
      "some-other-task-message",
    ),
  ).toBe(false);
  expect((await task(t.id))!.due_date).toBeNull();
});
it("custom cancel is bound to its own draft and old cancel buttons cannot erase a newer draft", async () => {
  const a = await add("א"),
    b = await add("ב"),
    old = await custom(a),
    current = await custom(b);
  await handleTaskSchedule(env, await user(), TEST_PHONE, old);
  expect(
    (await env.DB.prepare(
      "SELECT task_id FROM task_schedule_pending WHERE actor_id=?",
    )
      .bind(actor)
      .first<{ task_id: number }>())!.task_id,
  ).toBe(b.id);
  await handleTaskSchedule(env, await user(), TEST_PHONE, current);
  expect(
    await env.DB.prepare("SELECT 1 FROM task_schedule_pending WHERE actor_id=?")
      .bind(actor)
      .first(),
  ).toBeNull();
  expect((await task(a.id))!.due_date).toBeNull();
  expect((await task(b.id))!.due_date).toBeNull();
});
it("draft expiry and later Calendar edits refuse custom rescheduling", async () => {
  const t = await add();
  await custom(t);
  await env.DB.prepare(
    "UPDATE task_schedule_pending SET expires_at=1 WHERE actor_id=?",
  )
    .bind(actor)
    .run();
  await continueTaskSchedule(env, await user(), TEST_PHONE, "מחר ב10:00");
  expect((await task(t.id))!.due_date).toBeNull();
  await custom(t);
  await updateTaskById(db, env.ENCRYPTION_KEY, t.id, [actor], {
    description: "Calendar edit",
  });
  await continueTaskSchedule(env, await user(), TEST_PHONE, "מחר ב10:00");
  expect((await task(t.id))!.due_date).toBeNull();
  expect(last().text.body).toContain("השתנתה");
});
it("task selection and recovery custom drafts do not compete for a later time reply", async () => {
  const t = await add();
  await custom(t);
  await env.DB.prepare("INSERT INTO recovery_pending VALUES (?,?,?,?)")
    .bind(actor, t.id, t.revision, now() + 600)
    .run();
  await showTaskDetails(env, await user(), TEST_PHONE, t);
  expect(
    await env.DB.prepare("SELECT 1 FROM recovery_pending").first(),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT 1 FROM task_schedule_pending").first(),
  ).toBeNull();
});
it("cancelling stops recurrence and suppresses queued reminders, and Undo restores the task", async () => {
  const t = await add("חוזר", new Date(Date.now() - 60000), "daily"),
    job = await ensureReminderJob(env, t);
  await handleTaskSchedule(
    env,
    await user(),
    TEST_PHONE,
    await token(t, "cancel"),
  );
  mock.mockClear();
  await deliverReminderJob(env, job.id);
  expect(wa()).toHaveLength(0);
  expect((await task(t.id))!.status).toBe("cancelled");
  expect((await task(t.id))!.recurrence).toBeNull();
  await undoTasks(env, actor);
  expect((await task(t.id))!.recurrence).toBe("daily");
});
it("project selections use the same adaptive management buttons", async () => {
  const p = await getOrCreateProject(env, actor, "בית");
  await addTask(db, env.ENCRYPTION_KEY, actor, "לנקות", null, null, undefined, {
    projectId: p.id,
  });
  await showProject(env, await user(), TEST_PHONE, p);
  await handleProjectControl(env, await user(), TEST_PHONE, rows()[0].id);
  expect(button("קבע תזכורת")).toBeDefined();
  expect(button("בטל משימה")).toBeDefined();
});
it("schedule controls are actor-bound and expired controls do not mutate tasks", async () => {
  const t = await add(),
    payload = await token(t, String(now() + 3600)),
    other = (await getUserById(db, await createTestUser(TEST_PHONE_2)))!;
  expect(await handleTaskSchedule(env, other, TEST_PHONE_2, payload)).toBe(
    false,
  );
  expect(
    await handleTaskSchedule(
      env,
      await user(),
      TEST_PHONE,
      payload.slice(0, -1) + "z",
    ),
  ).toBe(false);
  await handleTaskSchedule(
    env,
    await user(),
    TEST_PHONE,
    await token(t, "cancel", now() - 1),
  );
  expect((await task(t.id))!.status).toBe("pending");
});
it("trial expiry blocks signed scheduling while allowing draft cancellation", async () => {
  const t = await add(),
    cancel = await custom(t),
    u = await user();
  await env.DB.prepare(
    "UPDATE billing_account SET trial_ends_at=1 WHERE phone_hash=?",
  )
    .bind(u.phone_number_hash)
    .run();
  await click(await token(t, String(now() + 3600)));
  expect((await task(t.id))!.due_date).toBeNull();
  await click(cancel);
  expect(
    await env.DB.prepare("SELECT 1 FROM task_schedule_pending").first(),
  ).toBeNull();
});
it("new due times participate in persistent reminder alarms", async () => {
  const t = await add(),
    enabled = { ...env, REMINDER_SCHEDULER_ENABLED: "true" };
  await handleTaskSchedule(
    enabled,
    await user(),
    TEST_PHONE,
    await token(t, String(now() + 120)),
  );
  await refreshRemindersForPhone(enabled, TEST_PHONE);
  expect(
    await runInDurableObject(
      env.REMINDER_SCHEDULERS.getByName(`owner:${actor}`),
      (_instance, state) => state.storage.getAlarm(),
    ),
  ).not.toBeNull();
});
it("natural-language list requests use the same picker", async () => {
  await add("לקרוא");
  gemini([{ action: "list", title: "" }]);
  await dispatchQueueMessage(
    {
      type: "text_processing",
      userId: actor,
      phone: TEST_PHONE,
      text: "תראה את המשימות",
    },
    env,
  );
  expect(wa().some((p) => p.interactive?.type === "list")).toBe(true);
});
it("deleting the account removes its scheduling draft", async () => {
  await custom(await add());
  await deleteUserAndData(db, actor, null);
  expect(
    await env.DB.prepare("SELECT 1 FROM task_schedule_pending").first(),
  ).toBeNull();
});

it("long task confirmations keep the complete text and usable buttons within provider limits", async () => {
  const undo = newUndoContext(actor),
    title = "תיאור ארוך ".repeat(90).trim(),
    t = await addTask(db, env.ENCRYPTION_KEY, actor, title, null, null, undo);
  await sendTaskReply(
    env,
    actor,
    TEST_PHONE,
    "✅ נוספה: " + title + "\nמידע נוסף ".repeat(20),
    undo,
    t.id,
  );
  expect(wa().some((p) => p.text?.body.includes(title))).toBe(true);
  expect(last().interactive.body.text.length).toBeLessThanOrEqual(1024);
  expect(button("קבע תזכורת")).toBeDefined();
});
it("a spring daylight-saving gap is refused instead of silently shifting the requested time", () => {
  expect(parseSimpleTime("26/03/2027 ב02:30")).toBeNull();
});
it("a Calendar change during spoken-time parsing wins over the pending edit", async () => {
  const t = await add();
  await custom(t);
  const base = makeMockFetch();
  mock.mockImplementation(async (url: any) => {
    if (String(url).includes("generativelanguage")) {
      await updateTaskById(db, env.ENCRYPTION_KEY, t.id, [actor], {
        description: "Calendar changed",
      });
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    tasks: [
                      {
                        action: "update",
                        title: t.description,
                        new_due_date: "2026-12-01 10:00",
                      },
                    ],
                    intent: "task_management",
                    reply: "",
                  }),
                },
              ],
            },
          },
        ],
      });
    }
    return base(url);
  });
  await continueTaskSchedule(env, await user(), TEST_PHONE, "מחר בעשר");
  expect((await task(t.id))!.description).toBe("Calendar changed");
  expect((await task(t.id))!.due_date).toBeNull();
});
it("voice time replies use the selected task and preserve its title", async () => {
  const t = await add();
  await custom(t);
  const base = makeMockFetch();
  mock.mockImplementation((url: any) => {
    const value = String(url);
    if (value.endsWith("/test-audio"))
      return Promise.resolve(
        Response.json({
          url: "https://audio.example/test",
          mime_type: "audio/ogg",
        }),
      );
    if (value === "https://audio.example/test")
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    if (value.includes("generativelanguage"))
      return Promise.resolve(
        Response.json({
          candidates: [{ content: { parts: [{ text: "בעוד שעתיים" }] } }],
        }),
      );
    return base(url);
  });
  await dispatchQueueMessage(
    {
      type: "voice_processing",
      userId: actor,
      phone: TEST_PHONE,
      audioId: "test-audio",
      audioMimeType: "audio/ogg",
    },
    env,
  );
  expect((await task(t.id))!.due_date).not.toBeNull();
  expect((await task(t.id))!.description).toBe(t.description);
});
