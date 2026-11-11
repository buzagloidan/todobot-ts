/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { buildDb } from "../src/db/client.ts";
import {
  addTask,
  getUserById,
  getUserTasks,
  getTaskById,
  completeTask,
  updateTaskById,
  addTaskAssignees,
} from "../src/db/queries.ts";
import {
  getOrCreateProject,
  createChecklist,
  visibleProjects,
  tasksInProject,
  projectText,
  showProject,
  handleProjectControl,
  moveTaskToProject,
} from "../src/services/projects.ts";
import {
  overdueTasks,
  showRecovery,
  recoveryCommand,
  handleRecoveryControl,
  continueRecovery,
} from "../src/services/recovery.ts";
import { signControl } from "../src/services/controls.ts";
import { handleTaskControl } from "../src/services/task_controls.ts";
import { newUndoContext, undoTasks } from "../src/services/task_undo.ts";
import {
  ensureReminderJob,
  deliverReminderJob,
} from "../src/services/reminder_dispatch.ts";
import { refreshRemindersForPhone } from "../src/reminder_scheduler.ts";
import { dispatchQueueMessage } from "../src/queue/consumer.ts";
import { processWebhookMessage } from "../src/routes/webhook.ts";
import { validateTaskResponse } from "../src/services/task_response.ts";
import {
  applySchema,
  clearData,
  createTestUser,
  makeMockFetch,
  TEST_PHONE,
  TEST_PHONE_2,
  TEST_ENC_KEY,
} from "./helpers.ts";
let db: ReturnType<typeof buildDb>,
  owner: number,
  fetchMock: ReturnType<typeof vi.fn>;
beforeAll(async () => {
  await applySchema();
  db = buildDb(env);
});
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
const future = () => new Date(Date.now() + 86400000);
const past = () => new Date(Date.now() - 86400000);
const taskRow = (id: number) =>
  env.DB.prepare("SELECT * FROM task WHERE id=?").bind(id).first<{
    status: string;
    revision: number;
    project_id: number | null;
    due_date: number;
    recurrence: string | null;
    reminder_sent: number;
  }>();
async function overdue(
  title = "להתקשר לבנק",
  recurrence: string | null = null,
) {
  return addTask(db, TEST_ENC_KEY, owner, title, past(), recurrence);
}
async function recover(
  task: { id: number; revision: number },
  action: string,
  actor?: Awaited<ReturnType<typeof user>>,
  expiry = Math.floor(Date.now() / 1000) + 3600,
) {
  const viewer = actor ?? (await user());
  return handleRecoveryControl(
    env,
    viewer,
    TEST_PHONE,
    await signControl(
      env,
      "recover",
      viewer.id,
      action,
      task.id,
      task.revision,
      expiry,
    ),
  );
}
function model(tasks: unknown[]) {
  const base = makeMockFetch();
  fetchMock.mockImplementation((url: string) =>
    String(url).includes("generativelanguage.googleapis.com")
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
                        reply: "בוצע ✅",
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
async function text(message: string) {
  await dispatchQueueMessage(
    {
      type: "text_processing",
      userId: owner,
      phone: TEST_PHONE,
      text: message,
    },
    env,
  );
}

it("stores encrypted project names with keyed owner-specific lookup and deduplicates normalized names", async () => {
  const first = await getOrCreateProject(env, owner, "  עבודה  "),
    again = await getOrCreateProject(env, owner, "עבודה");
  expect(again.id).toBe(first.id);
  const other = await createTestUser(TEST_PHONE_2),
    second = await getOrCreateProject(env, other, "עבודה");
  const rows = (
    await env.DB.prepare("SELECT name_encrypted,name_hash FROM project").all<{
      name_encrypted: string;
      name_hash: string;
    }>()
  ).results;
  expect(rows.every((r) => !r.name_encrypted.includes("עבודה"))).toBe(true);
  expect(rows[0].name_hash).not.toBe(rows[1].name_hash);
  expect(second.id).not.toBe(first.id);
});
it("creates real untimed checklist tasks and Undo cancels the whole creation", async () => {
  const undo = newUndoContext(owner),
    project = await createChecklist(
      env,
      await user(),
      "מעבר דירה",
      ["אריזה", "הזמנת הובלה", "שינוי כתובת"],
      undo,
    );
  const tasks = await tasksInProject(env, await user(), project.id);
  expect(tasks).toHaveLength(3);
  expect(tasks.every((t) => t.due_date === null)).toBe(true);
  expect(undo.changedTaskIds).toHaveLength(3);
  await undoTasks(env, owner);
  expect(
    (await tasksInProject(env, await user(), project.id)).every(
      (t) => t.status === "cancelled",
    ),
  ).toBe(true);
});
it("adding checklist items to an existing project preserves its earlier tasks", async () => {
  const p = await createChecklist(
    env,
    await user(),
    "קניות",
    ["חלב"],
    newUndoContext(owner),
  );
  await createChecklist(
    env,
    await user(),
    "קניות",
    ["לחם"],
    newUndoContext(owner),
  );
  expect(
    (await tasksInProject(env, await user(), p.id))
      .map((t) => t.description)
      .sort(),
  ).toEqual(["חלב", "לחם"]);
});
it("the maximum supported checklist is one atomic batch with complete Undo tracking", async () => {
  const undo = newUndoContext(owner),
    p = await createChecklist(
      env,
      await user(),
      "נסיעה",
      Array.from({ length: 50 }, (_, i) => "פריט " + i),
      undo,
    );
  expect(await tasksInProject(env, await user(), p.id)).toHaveLength(50);
  expect(new Set(undo.changedTaskIds).size).toBe(50);
});
it("checklist progress updates after exact-task button completion", async () => {
  const p = await createChecklist(
      env,
      await user(),
      "עבודה",
      ["הצעה", "פגישה"],
      newUndoContext(owner),
    ),
    task = (await tasksInProject(env, await user(), p.id))[0];
  await handleTaskControl(
    env,
    await user(),
    TEST_PHONE,
    await signControl(
      env,
      "task",
      owner,
      task.id,
      task.revision,
      "done",
      Math.floor(Date.now() / 1000) + 600,
    ),
  );
  expect(await projectText(env, await user(), p)).toContain("1/2 הושלמו");
  expect(await projectText(env, await user(), p)).toContain(
    "✅ " + task.description,
  );
});
it("an assigned user can see only assigned checklist items, not private siblings", async () => {
  const other = await createTestUser(TEST_PHONE_2),
    p = await createChecklist(
      env,
      await user(),
      "עבודה",
      ["פרטי", "משותף"],
      newUndoContext(owner),
    ),
    tasks = await tasksInProject(env, await user(), p.id);
  await addTaskAssignees(db, tasks[0].id, [other]);
  const assignee = (await getUserById(db, other))!;
  expect(await visibleProjects(env, assignee)).toHaveLength(1);
  expect((await tasksInProject(env, assignee, p.id)).map((t) => t.id)).toEqual([
    tasks[0].id,
  ]);
  expect(await projectText(env, assignee, p)).not.toContain(
    tasks[1].description,
  );
  await env.DB.prepare("DELETE FROM task_assignee").run();
  expect(await visibleProjects(env, assignee)).toHaveLength(0);
});
it("project controls recheck membership and reject cross-account or stale task selection", async () => {
  const p = await createChecklist(
      env,
      await user(),
      "עבודה",
      ["פרטי"],
      newUndoContext(owner),
    ),
    task = (await tasksInProject(env, await user(), p.id))[0],
    other = await createTestUser(TEST_PHONE_2);
  const payload = await signControl(
    env,
    "project",
    owner,
    "task",
    p.id,
    task.id,
    Math.floor(Date.now() / 1000) + 600,
  );
  expect(
    await handleProjectControl(
      env,
      (await getUserById(db, other))!,
      TEST_PHONE_2,
      payload,
    ),
  ).toBe(false);
  await completeTask(db, TEST_ENC_KEY, task.id, [owner]);
  await handleProjectControl(env, await user(), TEST_PHONE, payload);
  expect(wa().at(-1).text.body).toContain("הפריט השתנה");
});
it("project selection shows the full task name before offering signed task actions", async () => {
  const name = "להתקשר לחברת ההובלות ולוודא את כל הפרטים לגבי יום המעבר",
    p = await createChecklist(
      env,
      await user(),
      "מעבר דירה",
      [name],
      newUndoContext(owner),
    );
  await showProject(env, await user(), TEST_PHONE, p);
  const choice = wa().at(-1).interactive.action.sections[0].rows[0];
  await handleProjectControl(env, await user(), TEST_PHONE, choice.id);
  expect(wa().at(-1).interactive.body.text).toContain(name);
  expect(wa().at(-1).interactive.action.buttons).toHaveLength(3);
});
it("moves an owned task while recording its previous project for Undo", async () => {
  const a = await getOrCreateProject(env, owner, "בית"),
    b = await getOrCreateProject(env, owner, "עבודה"),
    task = await addTask(
      db,
      TEST_ENC_KEY,
      owner,
      "טלפון",
      future(),
      null,
      undefined,
      { projectId: a.id },
    );
  expect(
    await moveTaskToProject(env, await user(), task, b, newUndoContext(owner)),
  ).toBe(true);
  expect((await taskRow(task.id))?.project_id).toBe(b.id);
  await undoTasks(env, owner);
  expect((await taskRow(task.id))?.project_id).toBe(a.id);
});
it("refuses to move a shared task into another owner’s private project", async () => {
  const other = await createTestUser(TEST_PHONE_2),
    p = await getOrCreateProject(env, owner, "עבודה"),
    task = await addTask(db, TEST_ENC_KEY, other, "משותף", null);
  await addTaskAssignees(db, task.id, [owner]);
  expect(
    await moveTaskToProject(env, await user(), task, p, newUndoContext(owner)),
  ).toBe(false);
});
it("natural checklist creation uses one project action and real tasks", async () => {
  model([
    {
      action: "project_create",
      title: "",
      project_name: "מעבר דירה",
      checklist_items: ["אריזה", "הובלה"],
    },
  ]);
  await text("צור צ׳קליסט למעבר דירה");
  expect(await getUserTasks(db, TEST_ENC_KEY, [owner], "pending")).toHaveLength(
    2,
  );
  expect(wa().at(-1).interactive.body.text).toContain("0/2 הושלמו");
});
it("rejects malformed project actions before even the valid first action mutates", async () => {
  model([
    { action: "add", title: "רגיל" },
    {
      action: "project_create",
      title: "",
      project_name: "עבודה",
      checklist_items: [42],
    },
  ]);
  await text("רשימה");
  expect(await getUserTasks(db, TEST_ENC_KEY, [owner])).toHaveLength(0);
  expect(
    validateTaskResponse({
      tasks: [{ action: "update", title: "טלפון", new_project_name: "עבודה" }],
      intent: "task_management",
      reply: "",
    }),
  ).toBe(true);
});
it("duplicate names require clarification and a project name targets the correct task", async () => {
  const a = await getOrCreateProject(env, owner, "בית"),
    b = await getOrCreateProject(env, owner, "עבודה");
  const first = await addTask(
      db,
      TEST_ENC_KEY,
      owner,
      "להתקשר",
      null,
      null,
      undefined,
      { projectId: a.id },
    ),
    second = await addTask(
      db,
      TEST_ENC_KEY,
      owner,
      "להתקשר",
      null,
      null,
      undefined,
      { projectId: b.id },
    );
  model([{ action: "complete", title: "להתקשר" }]);
  await text("סיימתי להתקשר");
  expect((await taskRow(first.id))?.status).toBe("pending");
  expect((await taskRow(second.id))?.status).toBe("pending");
  model([{ action: "complete", title: "להתקשר", project_name: "עבודה" }]);
  await text("סיימתי להתקשר בפרויקט עבודה");
  expect((await taskRow(first.id))?.status).toBe("pending");
  expect((await taskRow(second.id))?.status).toBe("completed");
});
it("natural add and move preserve task identity and project membership", async () => {
  model([{ action: "add", title: "להתקשר", project_name: "בית" }]);
  await text("הוסף להתקשר לפרויקט בית");
  const task = (await getUserTasks(db, TEST_ENC_KEY, [owner], "pending"))[0];
  model([{ action: "update", title: "להתקשר", new_project_name: "עבודה" }]);
  await text("העבר להתקשר לפרויקט עבודה");
  expect((await taskRow(task.id))?.project_id).not.toBe(task.project_id);
  await undoTasks(env, owner);
  expect((await taskRow(task.id))?.project_id).toBe(task.project_id);
});
it("project recurrence retains its group when reminder delivery creates the successor", async () => {
  const p = await getOrCreateProject(env, owner, "בריאות"),
    task = await addTask(
      db,
      TEST_ENC_KEY,
      owner,
      "ויטמינים",
      past(),
      "daily",
      undefined,
      { projectId: p.id },
    );
  await deliverReminderJob(env, (await ensureReminderJob(env, task)).id);
  const next = await getUserTasks(db, TEST_ENC_KEY, [owner], "pending");
  expect(next).toHaveLength(1);
  expect(next[0].project_id).toBe(p.id);
});

it("recovery keeps pending overdue tasks without moving their time or rearming a reminder", async () => {
  const task = await overdue();
  await env.DB.prepare("UPDATE task SET reminder_sent=1 WHERE id=?")
    .bind(task.id)
    .run();
  await recover(task, "keep");
  expect(await overdueTasks(env, await user())).toHaveLength(0);
  expect(await overdueTasks(env, await user(), true)).toHaveLength(1);
  const row = await taskRow(task.id);
  expect(row?.status).toBe("pending");
  expect(row?.reminder_sent).toBe(1);
  expect(row?.due_date).toBe(Math.floor(+task.due_date! / 1000));
});
it("a kept task is reviewed again after an actual task change", async () => {
  const task = await overdue();
  await recover(task, "keep");
  await updateTaskById(db, TEST_ENC_KEY, task.id, [owner], {
    description: "שם חדש",
  });
  expect(await overdueTasks(env, await user())).toHaveLength(1);
});
it("cancel stops recurring tasks and Undo restores the complete original state", async () => {
  const task = await overdue("לחזור", "weekly");
  await recover(task, "cancel");
  expect((await taskRow(task.id))?.status).toBe("cancelled");
  expect((await taskRow(task.id))?.recurrence).toBeNull();
  await undoTasks(env, owner);
  expect((await taskRow(task.id))?.status).toBe("pending");
  expect((await taskRow(task.id))?.recurrence).toBe("weekly");
});
it("rescheduling reuses the task and arms its new due time, with stale button protection", async () => {
  const task = await overdue();
  await env.DB.prepare("UPDATE task SET reminder_sent=1 WHERE id=?")
    .bind(task.id)
    .run();
  await recover(task, "tomorrow");
  const after = await taskRow(task.id);
  expect(after?.due_date).toBeGreaterThan(Date.now() / 1000);
  expect(after?.reminder_sent).toBe(0);
  expect(await getUserTasks(db, TEST_ENC_KEY, [owner])).toHaveLength(1);
  await refreshRemindersForPhone(
    { ...env, REMINDER_SCHEDULER_ENABLED: "true" },
    TEST_PHONE,
  );
  expect(
    await runInDurableObject(
      env.REMINDER_SCHEDULERS.getByName(`owner:${owner}`),
      (_, state) => state.storage.getAlarm(),
    ),
  ).toBe(after!.due_date * 1000);
  await recover(task, "cancel");
  expect((await taskRow(task.id))?.status).toBe("pending");
});
it("old or expired recovery buttons cannot alter tasks", async () => {
  const task = await overdue();
  await recover(task, "cancel", await user(), 1);
  expect((await taskRow(task.id))?.status).toBe("pending");
  await updateTaskById(db, TEST_ENC_KEY, task.id, [owner], {
    description: "חדש",
  });
  await recover(task, "cancel");
  expect((await taskRow(task.id))?.status).toBe("pending");
});
it("recovery rechecks shared access after a task was unassigned", async () => {
  const task = await overdue(),
    other = await createTestUser(TEST_PHONE_2);
  await addTaskAssignees(db, task.id, [other]);
  const assignee = (await getUserById(db, other))!;
  const payload = await signControl(
    env,
    "recover",
    other,
    "cancel",
    task.id,
    task.revision,
    Math.floor(Date.now() / 1000) + 600,
  );
  await env.DB.prepare("DELETE FROM task_assignee").run();
  await handleRecoveryControl(env, assignee, TEST_PHONE_2, payload);
  expect((await taskRow(task.id))?.status).toBe("pending");
});
it("recovery list pages past nine tasks and selection uses task names", async () => {
  for (let i = 0; i < 12; i++) await overdue("פריט " + i);
  await recoveryCommand(env, await user(), "/recover list", TEST_PHONE);
  const rows = wa().at(-1).interactive.action.sections[0].rows;
  expect(rows).toHaveLength(10);
  await handleRecoveryControl(env, await user(), TEST_PHONE, rows.at(-1).id);
  expect(wa().at(-1).interactive.action.sections[0].rows).toHaveLength(3);
});
it("custom recovery time changes only the explicitly selected task", async () => {
  const task = await overdue(),
    other = await overdue("אחר");
  await recover(task, "custom");
  model([
    {
      action: "update",
      title: "מודל ניסה שם אחר",
      new_due_date: "2027-01-10 11:30",
    },
  ]);
  expect(
    await continueRecovery(env, await user(), TEST_PHONE, "מחר ב־11:30"),
  ).toBe(true);
  expect((await taskRow(task.id))?.due_date).toBeGreaterThan(Date.now() / 1000);
  expect((await taskRow(other.id))?.due_date).toBe(
    Math.floor(+other.due_date! / 1000),
  );
});
it("a pending custom-time prompt does not capture unrelated new task requests", async () => {
  const task = await overdue();
  await recover(task, "custom");
  model([{ action: "add", title: "חלב" }]);
  await text("תזכיר לי לקנות חלב");
  expect(await getUserTasks(db, TEST_ENC_KEY, [owner], "pending")).toHaveLength(
    2,
  );
  expect((await taskRow(task.id))?.due_date).toBe(
    Math.floor(+task.due_date! / 1000),
  );
});
it("expired custom-time prompts and malformed/multi-action responses never mutate", async () => {
  const task = await overdue();
  await recover(task, "custom");
  model([
    { action: "update", title: "בנק", new_due_date: "2027-01-10 11:30" },
    { action: "delete", title: "אחר" },
  ]);
  await continueRecovery(env, await user(), TEST_PHONE, "מחר ב11");
  expect((await taskRow(task.id))?.revision).toBe(task.revision);
  await env.DB.prepare("UPDATE recovery_pending SET expires_at=1").run();
  expect(await continueRecovery(env, await user(), TEST_PHONE, "מחר ב11")).toBe(
    false,
  );
});
it("natural recovery sends one interactive view rather than a duplicate reply or mutation", async () => {
  await overdue();
  model([{ action: "recover", title: "" }]);
  await text("עזור לי לנקות את המשימות באיחור");
  expect(wa().filter((b) => b.type === "interactive")).toHaveLength(1);
  expect(await getUserTasks(db, TEST_ENC_KEY, [owner], "pending")).toHaveLength(
    1,
  );
});
it("the webhook serves projects and recovery as direct commands without Gemini", async () => {
  await createChecklist(
    env,
    await user(),
    "עבודה",
    ["שיחה"],
    newUndoContext(owner),
  );
  await overdue();
  await processWebhookMessage(
    { from: TEST_PHONE, type: "text", text: { body: "/projects" } },
    env,
  );
  await processWebhookMessage(
    { from: TEST_PHONE, type: "text", text: { body: "/recover" } },
    env,
  );
  expect(wa().filter((b) => b.type === "interactive")).toHaveLength(2);
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes("generativelanguage"),
    ),
  ).toBe(false);
});

it("recovery all provides a name picker for previously kept tasks", async () => {
  const first = await overdue("ראשון"),
    second = await overdue("שני");
  await recover(first, "keep");
  await recover(second, "keep");
  await recoveryCommand(env, await user(), "/recover all", TEST_PHONE);
  expect(
    wa()
      .at(-1)
      .interactive.action.sections[0].rows.map(
        (r: { title: string }) => r.title,
      )
      .sort(),
  ).toEqual(["ראשון", "שני"].sort());
});
it("voice requests use the same recovery flow after transcription", async () => {
  await overdue();
  const base = makeMockFetch();
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    if (String(url).includes(`graph.facebook.com/${env.WHATSAPP_API_VERSION}/audio-test`))
      return Promise.resolve(
        Response.json({
          url: "https://media.test/voice",
          mime_type: "audio/ogg",
        }),
      );
    if (String(url).includes("media.test"))
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    if (String(url).includes("generativelanguage.googleapis.com"))
      return Promise.resolve(
        Response.json({
          candidates: [{ content: { parts: [{ text: "/recover" }] } }],
        }),
      );
    return base(url);
  });
  await dispatchQueueMessage(
    {
      type: "voice_processing",
      userId: owner,
      phone: TEST_PHONE,
      audioId: "audio-test",
    },
    env,
  );
  expect(wa().filter((b) => b.type === "interactive")).toHaveLength(1);
  expect(await getUserTasks(db, TEST_ENC_KEY, [owner], "pending")).toHaveLength(
    1,
  );
});
it("webhook project selection and task completion use the signed controls end to end", async () => {
  const p = await createChecklist(
    env,
    await user(),
    "עבודה",
    ["שיחה"],
    newUndoContext(owner),
  );
  await showProject(env, await user(), TEST_PHONE, p);
  const selection = wa().at(-1).interactive.action.sections[0].rows[0].id;
  await processWebhookMessage(
    {
      from: TEST_PHONE,
      type: "interactive",
      interactive: { list_reply: { id: selection } },
    },
    env,
  );
  const done = wa().at(-1).interactive.action.buttons[0].reply.id;
  await processWebhookMessage(
    {
      from: TEST_PHONE,
      type: "interactive",
      interactive: { button_reply: { id: done } },
    },
    env,
  );
  expect(await projectText(env, await user(), p)).toContain("1/1 הושלמו");
});
