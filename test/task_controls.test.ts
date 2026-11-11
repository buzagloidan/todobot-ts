/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { buildDb } from "../src/db/client.ts";
import {
  addTask,
  completeTask,
  getTaskById,
  getUserById,
  updateTaskById,
  scheduleNextRecurrence,
  deleteUserAndData,
  completeAllPendingTasks,
  addTaskAssignees,
} from "../src/db/queries.ts";
import {
  newUndoContext,
  undoTasks,
  availableUndo,
} from "../src/services/task_undo.ts";
import {
  reminderButtons,
  handleTaskControl,
  sendTaskReply,
} from "../src/services/task_controls.ts";
import { signControl, verifyControl } from "../src/services/controls.ts";
import { sendDueRemindersForTest as scanAndSendReminders } from "./helpers.ts";
import {
  applySchema,
  clearData,
  createTestUser,
  TEST_ENC_KEY,
  TEST_PHONE,
  TEST_PHONE_2,
  makeMockFetch,
  makeSignedWebhookRequestFromMessage,
  drainConversation,
  makeSignedWebhookRequest,
} from "./helpers.ts";
let db: ReturnType<typeof buildDb>,
  actorId: number,
  fetchMock: ReturnType<typeof vi.fn>;
beforeAll(async () => {
  await applySchema();
  db = buildDb(env);
});
beforeEach(async () => {
  await clearData();
  actorId = await createTestUser();
  fetchMock = vi.fn(makeMockFetch());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const user = async () => (await getUserById(db, actorId))!;
const task = async (id: number) => getTaskById(db, TEST_ENC_KEY, id, [actorId]);
const wa = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes("graph.facebook.com"))
    .map(([, init]) => JSON.parse(init.body));
const reply = () =>
  wa()
    .map((body) => body.text?.body ?? body.interactive?.body?.text)
    .filter(Boolean)
    .join("\n");

it("cancels a created task with one-use Undo, keeping its name encrypted", async () => {
  const context = newUndoContext(actorId);
  const created = await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Secret appointment",
    null,
    null,
    context,
  );
  expect(await availableUndo(env, actorId)).toBe(context.groupId);
  expect(await undoTasks(env, actorId)).toContain("הפעולה בוטלה");
  expect((await task(created.id))?.status).toBe("cancelled");
  expect(await undoTasks(env, actorId, context.groupId)).toContain("אין פעולה");
  const raw = await env.DB.prepare("SELECT description FROM task WHERE id=?")
    .bind(created.id)
    .first<{ description: string }>();
  expect(raw?.description).not.toContain("Secret appointment");
});
it("restores title, time, recurrence and reminder state after a grouped edit", async () => {
  const due = new Date(Date.now() + 3600000);
  const created = await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Original",
    due,
    "daily",
  );
  await env.DB.prepare("UPDATE task SET reminder_sent=1 WHERE id=?")
    .bind(created.id)
    .run();
  const context = newUndoContext(actorId);
  await updateTaskById(
    db,
    TEST_ENC_KEY,
    created.id,
    [actorId],
    { description: "Changed", due_date: new Date(+due + 60000) },
    [],
    context,
  );
  await completeTask(db, TEST_ENC_KEY, created.id, [actorId], [], context);
  const encrypted = await env.DB.prepare(
    "SELECT before_encrypted FROM task_undo_change WHERE group_id=?",
  )
    .bind(context.groupId)
    .first<{ before_encrypted: string }>();
  expect(encrypted?.before_encrypted).not.toContain("Original");
  expect(await undoTasks(env, actorId)).toContain("הפעולה בוטלה");
  expect(await task(created.id)).toMatchObject({
    description: "Original",
    status: "pending",
    recurrence: "daily",
    reminder_sent: true,
  });
  expect(+(await task(created.id))!.due_date!).toBe(
    Math.floor(+due / 1000) * 1000,
  );
});
it("refuses to overwrite a later Calendar edit even within the same second", async () => {
  const created = await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Calendar task",
    new Date(),
  );
  const context = newUndoContext(actorId);
  await completeTask(db, TEST_ENC_KEY, created.id, [actorId], [], context);
  await env.DB.prepare("UPDATE task SET due_date=due_date+60 WHERE id=?")
    .bind(created.id)
    .run();
  expect(await undoTasks(env, actorId)).toContain("לא בוצע ביטול");
  expect((await task(created.id))?.status).toBe("completed");
});
it("reminder metadata does not invalidate buttons or Undo", async () => {
  const created = await addTask(db, TEST_ENC_KEY, actorId, "One", null);
  const context = newUndoContext(actorId);
  await updateTaskById(
    db,
    TEST_ENC_KEY,
    created.id,
    [actorId],
    { description: "Two" },
    [],
    context,
  );
  await env.DB.prepare(
    "UPDATE task SET reminder_sent=1, updated_at=updated_at+1 WHERE id=?",
  )
    .bind(created.id)
    .run();
  expect(await undoTasks(env, actorId)).toContain("הפעולה בוטלה");
  expect((await task(created.id))?.description).toBe("One");
});
it("Undo restores all tasks atomically and rejects partial restoration when one changed", async () => {
  const a = await addTask(db, TEST_ENC_KEY, actorId, "A", null),
    b = await addTask(db, TEST_ENC_KEY, actorId, "B", null);
  const ctx = newUndoContext(actorId);
  expect(await completeAllPendingTasks(db, [actorId], TEST_ENC_KEY, ctx)).toBe(
    2,
  );
  await env.DB.prepare("UPDATE task SET due_date=123 WHERE id=?")
    .bind(b.id)
    .run();
  expect(await undoTasks(env, actorId)).toContain("לא בוצע ביטול");
  expect((await task(a.id))?.status).toBe("completed");
});
it("Undo cancels the next recurring occurrence and restores the original", async () => {
  const created = await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Recurring",
    new Date(),
    "daily",
  );
  const ctx = newUndoContext(actorId);
  const completed = await completeTask(
    db,
    TEST_ENC_KEY,
    created.id,
    [actorId],
    [],
    ctx,
  );
  const next = await scheduleNextRecurrence(db, TEST_ENC_KEY, completed!, ctx);
  expect(await undoTasks(env, actorId)).toContain("הפעולה בוטלה");
  expect((await task(created.id))?.status).toBe("pending");
  expect((await task(next!.id))?.status).toBe("cancelled");
});
it("expires Undo after ten minutes", async () => {
  const ctx = newUndoContext(actorId);
  await addTask(db, TEST_ENC_KEY, actorId, "Temp", null, null, ctx);
  await env.DB.prepare("UPDATE task_undo SET expires_at=?")
    .bind(Math.floor(Date.now() / 1000) - 1)
    .run();
  expect(await undoTasks(env, actorId)).toContain("אין פעולה");
});
it("rechecks sharing permissions for Undo and removes snapshots on account deletion", async () => {
  const owner = await createTestUser(TEST_PHONE_2);
  await env.DB.prepare("UPDATE user SET partner_user_id=? WHERE id=?")
    .bind(owner, actorId)
    .run();
  const created = await addTask(db, TEST_ENC_KEY, owner, "Shared", null);
  const ctx = newUndoContext(actorId);
  await completeTask(db, TEST_ENC_KEY, created.id, [actorId, owner], [], ctx);
  await env.DB.prepare("UPDATE user SET partner_user_id=NULL WHERE id=?")
    .bind(actorId)
    .run();
  expect(await undoTasks(env, actorId)).toContain("לא בוצע ביטול");
  await deleteUserAndData(db, owner, null);
  expect(await availableUndo(env, actorId)).toBeNull();
});
it("buttons act on the exact duplicate-named task and are replay safe", async () => {
  const a = await addTask(db, TEST_ENC_KEY, actorId, "Same", null),
    b = await addTask(db, TEST_ENC_KEY, actorId, "Same", null);
  const buttons = await reminderButtons(env, actorId, a);
  expect(
    await handleTaskControl(env, await user(), TEST_PHONE, buttons[0].id),
  ).toBe(true);
  expect((await task(a.id))?.status).toBe("completed");
  expect((await task(b.id))?.status).toBe("pending");
  await handleTaskControl(env, await user(), TEST_PHONE, buttons[0].id);
  expect(reply()).toContain("השתנתה");
});
it("rejects a tampered payload and another account", async () => {
  const created = await addTask(db, TEST_ENC_KEY, actorId, "Private", null);
  const buttons = await reminderButtons(env, actorId, created);
  expect(
    await verifyControl(
      env,
      buttons[0].id.replace(":done:", ":snooze:"),
      actorId,
    ),
  ).toBeNull();
  const other = await createTestUser(TEST_PHONE_2);
  expect(await verifyControl(env, buttons[0].id, other)).toBeNull();
});
it("rejects a stale signed button and expired button", async () => {
  const created = await addTask(db, TEST_ENC_KEY, actorId, "Edited", null);
  const buttons = await reminderButtons(env, actorId, created);
  await updateTaskById(db, TEST_ENC_KEY, created.id, [actorId], {
    description: "New name",
  });
  await handleTaskControl(env, await user(), TEST_PHONE, buttons[0].id);
  expect((await task(created.id))?.status).toBe("pending");
  const expired = await signControl(
    env,
    "task",
    actorId,
    created.id,
    1,
    "done",
    1,
  );
  await handleTaskControl(env, await user(), TEST_PHONE, expired);
  expect(reply()).toContain("פג");
});
it("snoozes a pending reminder once and Undo restores its due date", async () => {
  const due = new Date(Date.now() - 60000);
  const created = await addTask(db, TEST_ENC_KEY, actorId, "Reminder", due);
  const buttons = await reminderButtons(env, actorId, created);
  await handleTaskControl(env, await user(), TEST_PHONE, buttons[1].id);
  const updated = (await task(created.id))!;
  expect(+updated.due_date!).toBeGreaterThan(Date.now() + 29 * 60000);
  await handleTaskControl(env, await user(), TEST_PHONE, buttons[1].id);
  expect((await task(created.id))?.revision).toBe(updated.revision);
  await undoTasks(env, actorId);
  expect(+(await task(created.id))!.due_date!).toBe(
    Math.floor(+due / 1000) * 1000,
  );
});
it("postpones an auto-completed recurring reminder without duplicating its chain", async () => {
  const created = await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Daily",
    new Date(Date.now() - 60000),
    "daily",
  );
  const buttons = await reminderButtons(env, actorId, created);
  await scanAndSendReminders(env);
  await handleTaskControl(env, await user(), TEST_PHONE, buttons[1].id);
  await handleTaskControl(env, await user(), TEST_PHONE, buttons[1].id);
  const rows = (
    await env.DB.prepare("SELECT recurrence,status FROM task").all<{
      recurrence: string | null;
      status: string;
    }>()
  ).results;
  expect(
    rows.filter((t) => t.status === "pending" && t.recurrence === "daily"),
  ).toHaveLength(1);
  expect(
    rows.filter((t) => t.status === "pending" && t.recurrence === null),
  ).toHaveLength(1);
});
it("does not allow a formerly assigned user to use an old button", async () => {
  const owner = await createTestUser(TEST_PHONE_2);
  const created = await addTask(db, TEST_ENC_KEY, owner, "Assignment", null);
  await addTaskAssignees(db, created.id, [actorId]);
  const buttons = await reminderButtons(env, actorId, created);
  await env.DB.prepare("DELETE FROM task_assignee WHERE task_id=?")
    .bind(created.id)
    .run();
  await handleTaskControl(env, await user(), TEST_PHONE, buttons[0].id);
  expect(
    (await getTaskById(db, TEST_ENC_KEY, created.id, [owner]))?.status,
  ).toBe("pending");
});
it("sends signed reminder actions using the approved template parameters", async () => {
  const created = await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Multi\nline",
    new Date(Date.now() - 60000),
  );
  await scanAndSendReminders({
    ...env,
    REMINDER_ACTIONS_TEMPLATE_NAME: "todobot_reminder_actions",
  });
  const body = wa().find((b) => b.type === "template");
  expect(body.template.name).toBe("todobot_reminder_actions");
  expect(body.template.components[0].parameters[0].text).toBe("Multi line");
  const payload = body.template.components[1].parameters[0].payload;
  const control = await verifyControl(env, payload, actorId);
  expect(control?.values.slice(1, 4)).toEqual([
    String(created.id),
    "0",
    "done",
  ]);
});
it("does not send free-form reminder fallback outside the service window", async () => {
  await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Old user",
    new Date(Date.now() - 60000),
  );
  await env.DB.prepare("UPDATE user SET last_active=? WHERE id=?")
    .bind(Math.floor(Date.now() / 1000) - 25 * 3600, actorId)
    .run();
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    if (
      String(url).includes("graph.facebook.com") &&
      JSON.parse(String(init.body)).type === "template"
    )
      return Promise.resolve(new Response("{}", { status: 400 }));
    return makeMockFetch()(url);
  });
  await scanAndSendReminders(env);
  expect(wa().filter((b) => b.type === "interactive")).toHaveLength(0);
});
it("handles template button callbacks through the signed webhook without Gemini", async () => {
  const created = await addTask(db, TEST_ENC_KEY, actorId, "Webhook", null);
  const buttons = await reminderButtons(env, actorId, created);
  await SELF.fetch(
    await makeSignedWebhookRequestFromMessage({
      from: TEST_PHONE,
      id: "template_callback",
      type: "button",
      button: { payload: buttons[0].id, text: "הושלם" },
    }),
  );
  await drainConversation();
  expect((await task(created.id))?.status).toBe("completed");
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes("generativelanguage"),
    ),
  ).toBe(false);
});
it("quick add exposes task buttons and /undo works end to end", async () => {
  await SELF.fetch(await makeSignedWebhookRequest("+Add by name"));
  await drainConversation();
  const body = wa().find((b) =>
    b.interactive?.body?.text?.includes("✅ נוספה"),
  );
  expect(
    body.interactive.action.buttons.map(
      (b: { reply: { title: string } }) => b.reply.title,
    ),
  ).toEqual(["הושלם ✅", "קבע תזכורת", "ביטול הפעולה ↩️"]);
  await SELF.fetch(await makeSignedWebhookRequest("/undo"));
  await drainConversation();
  expect(
    (
      await env.DB.prepare("SELECT status FROM task").first<{
        status: string;
      }>()
    )?.status,
  ).toBe("cancelled");
});

it("restores a bulk completion across bounded snapshot batches", async () => {
  for (let i = 0; i < 45; i++)
    await addTask(db, TEST_ENC_KEY, actorId, `Bulk ${i}`, null);
  const ctx = newUndoContext(actorId);
  expect(await completeAllPendingTasks(db, [actorId], TEST_ENC_KEY, ctx)).toBe(
    45,
  );
  expect(await undoTasks(env, actorId)).toContain("הפעולה בוטלה");
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM task WHERE status='pending'",
      ).first<{ n: number }>()
    )?.n,
  ).toBe(45);
});
it("Undo refuses the whole group when one affected task no longer exists", async () => {
  const ctx = newUndoContext(actorId);
  const a = await addTask(db, TEST_ENC_KEY, actorId, "A", null, null, ctx);
  const b = await addTask(db, TEST_ENC_KEY, actorId, "B", null, null, ctx);
  await env.DB.prepare("DELETE FROM task WHERE id=?").bind(b.id).run();
  expect(await undoTasks(env, actorId)).toContain("לא בוצע ביטול");
  expect((await task(a.id))?.status).toBe("pending");
});
