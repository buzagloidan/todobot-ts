/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { buildDb } from "../src/db/client.ts";
import {
  addTask,
  getUserById,
  getTaskById,
  getUserTasks,
  addTaskAssignees,
  completeTask,
  scheduleNextRecurrence,
} from "../src/db/queries.ts";
import { getOrCreateProject } from "../src/services/projects.ts";
import { dispatchQueueMessage } from "../src/queue/consumer.ts";
import { newUndoContext, undoTasks } from "../src/services/task_undo.ts";
import {
  taskActionButtons,
  handleTaskControl,
} from "../src/services/task_controls.ts";
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
  drainConversation,
} from "./helpers.ts";
let owner: number, mock: ReturnType<typeof vi.fn>;
const db = buildDb(env);
beforeAll(applySchema);
beforeEach(async () => {
  await clearData();
  owner = await createTestUser();
  mock = vi.fn(makeMockFetch());
  vi.stubGlobal("fetch", mock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const user = async () => (await getUserById(db, owner))!;
const owned = () => getUserTasks(db, env.ENCRYPTION_KEY, [owner]);
const task = (id: number) => getTaskById(db, env.ENCRYPTION_KEY, id, [owner]);
const local = (s: string) => parseDueDate(s)!;
const display = (d: Date) =>
  d.toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" }).slice(0, 16);
async function command(text: string) {
  await SELF.fetch(await makeSignedWebhookRequest(text));
  await drainConversation();
}
function model(rule: string, due: string) {
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
                        tasks: [
                          {
                            action: "add",
                            title: "להתאמן",
                            recurrence: rule,
                            due_date: due,
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
          }),
        )
      : base(url),
  );
}
it("normalizes a model date to the requested weekdays and confirms the actual next time", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(local("2026-10-13 12:00"));
  model("weekly:0,3", "2026-10-12 18:00");
  await dispatchQueueMessage(
    {
      type: "text_processing",
      userId: owner,
      phone: TEST_PHONE,
      text: "כל ראשון ורביעי ב18 להתאמן",
    },
    env,
  );
  const rows = await owned();
  expect(rows).toHaveLength(1);
  expect(rows[0].recurrence).toBe("weekly:0,3");
  expect(display(rows[0].due_date!)).toBe("2026-10-14 18:00");
  expect(
    mock.mock.calls
      .filter(([url]) => String(url).includes("graph.facebook"))
      .some(([, init]) => String(init.body).includes("ראשון ורביעי")),
  ).toBe(true);
});
it("automatic reminder delivery creates one next selected weekday with project and assignments intact", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(local("2026-10-13 12:00"));
  const friend = await createTestUser(TEST_PHONE_2),
    project = await getOrCreateProject(env, owner, "כושר");
  const t = await addTask(
    db,
    env.ENCRYPTION_KEY,
    owner,
    "להתאמן",
    local("2026-10-11 18:00"),
    "weekly:0,3",
    undefined,
    { projectId: project.id },
  );
  await addTaskAssignees(db, t.id, [friend]);
  const job = await ensureReminderJob(env, t);
  await Promise.all([
    deliverReminderJob(env, job.id),
    deliverReminderJob(env, job.id),
  ]);
  const pending = (await owned()).filter((t) => t.status === "pending");
  expect(pending).toHaveLength(1);
  expect(display(pending[0].due_date!)).toBe("2026-10-14 18:00");
  expect(pending[0].project_id).toBe(project.id);
  expect(pending[0].recurrence).toBe("weekly:0,3");
  expect(
    await env.DB.prepare(
      "SELECT 1 FROM task_assignee WHERE task_id=? AND assignee_user_id=?",
    )
      .bind(pending[0].id, friend)
      .first(),
  ).not.toBeNull();
});
it("manual button completion preserves weekday recurrence and Undo restores its original occurrence", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(local("2026-10-14 07:00"));
  const t = await addTask(
    db,
    env.ENCRYPTION_KEY,
    owner,
    "להתאמן",
    local("2026-10-14 18:00"),
    "weekly:0,3",
  );
  await handleTaskControl(
    env,
    await user(),
    TEST_PHONE,
    (await taskActionButtons(env, owner, t))[0].id,
  );
  const pending = (await owned()).filter((t) => t.status === "pending");
  expect(pending).toHaveLength(1);
  expect(display(pending[0].due_date!)).toBe("2026-10-18 18:00");
  await undoTasks(env, owner);
  expect((await task(t.id))!.status).toBe("pending");
  expect((await task(pending[0].id))!.status).toBe("cancelled");
});
it("quick completion by name retains the next workday", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(local("2026-10-15 07:00"));
  await addTask(
    db,
    env.ENCRYPTION_KEY,
    owner,
    "להגיש דוח",
    local("2026-10-15 09:00"),
    "weekdays",
  );
  await command("- להגיש דוח");
  const pending = (await owned()).filter((t) => t.status === "pending");
  expect(pending).toHaveLength(1);
  expect(display(pending[0].due_date!)).toBe("2026-10-18 09:00");
});
it("bulk completion retains next recurring tasks and their grouped Undo", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(local("2026-10-13 12:00"));
  const a = await addTask(
      db,
      env.ENCRYPTION_KEY,
      owner,
      "א",
      local("2026-10-14 18:00"),
      "weekly:0,3",
    ),
    b = await addTask(
      db,
      env.ENCRYPTION_KEY,
      owner,
      "ב",
      local("2026-11-01 09:00"),
      "monthly:1",
    );
  await command("-הכל");
  const pending = (await owned()).filter((t) => t.status === "pending");
  expect(pending).toHaveLength(2);
  expect(pending.map((t) => display(t.due_date!)).sort()).toEqual([
    "2026-10-18 18:00",
    "2026-12-01 09:00",
  ]);
  await undoTasks(env, owner);
  expect((await task(a.id))!.status).toBe("pending");
  expect((await task(b.id))!.status).toBe("pending");
  for (const t of pending) expect((await task(t.id))!.status).toBe("cancelled");
});
it("explicit month-day scheduling survives postponement of its current occurrence", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(local("2026-10-13 12:00"));
  const t = await addTask(
      db,
      env.ENCRYPTION_KEY,
      owner,
      "דוח",
      local("2026-11-03 09:00"),
      "monthly:1",
    ),
    undo = newUndoContext(owner);
  const done = await completeTask(
    db,
    env.ENCRYPTION_KEY,
    t.id,
    [owner],
    [],
    undo,
  );
  const successor = await scheduleNextRecurrence(
    db,
    env.ENCRYPTION_KEY,
    done!,
    undo,
  );
  expect(display(successor!.due_date!)).toBe("2026-12-01 09:00");
});
it("stored weekday order is canonical and invalid rules cannot be persisted", async () => {
  const t = await addTask(
    db,
    env.ENCRYPTION_KEY,
    owner,
    "כושר",
    new Date(Date.now() + 60000),
    "weekly:3,0",
  );
  expect(t.recurrence).toBe("weekly:0,3");
  await expect(
    addTask(db, env.ENCRYPTION_KEY, owner, "שגיאה", new Date(), "weekly:0,0"),
  ).rejects.toThrow("Invalid recurrence");
  expect(await owned()).toHaveLength(1);
});
