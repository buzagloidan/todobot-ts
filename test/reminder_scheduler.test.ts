/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  env,
  runInDurableObject,
  runDurableObjectAlarm,
  createMessageBatch,
  createExecutionContext,
  getQueueResult,
} from "cloudflare:test";
import worker from "../src/index.ts";
import { buildDb } from "../src/db/client.ts";
import {
  addTask,
  completeTask,
  updateTaskById,
  getUserById,
  addTaskAssignees,
} from "../src/db/queries.ts";
import {
  ensureReminderJob,
  deliverReminderJob,
  dispatchOwnerReminders,
  nextReminderAt,
  handleReminderStatus,
  nowSeconds,
} from "../src/services/reminder_dispatch.ts";
import {
  refreshRemindersForPhone,
  recoverReminderSchedules,
} from "../src/reminder_scheduler.ts";
import { newUndoContext, undoTasks } from "../src/services/task_undo.ts";
import {
  applySchema,
  clearData,
  createTestUser,
  makeMockFetch,
  makeSignedWebhookRequestFromBody,
  TEST_ENC_KEY,
  TEST_PHONE,
  TEST_PHONE_2,
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
  await env.CACHE.delete("alert:reminder_uncertain");
  await env.CACHE.delete("alert:reminder_failed");
  await env.CACHE.delete("alert:reminder_delivery_failed");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const calls = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes("graph.facebook.com"))
    .map(([, init]) => JSON.parse(init.body));
const sends = () =>
  calls().filter((b) => b.type === "template" || b.type === "interactive");
const row = (id: string) =>
  env.DB.prepare("SELECT * FROM reminder_job WHERE id=?")
    .bind(id)
    .first<{ state: string; attempt: number; next_task_id: number | null }>();
const flag = (id: number) =>
  env.DB.prepare("SELECT reminder_sent,revision,status FROM task WHERE id=?")
    .bind(id)
    .first<{ reminder_sent: number; revision: number; status: string }>();
const due = async (title = "Due") =>
  addTask(db, TEST_ENC_KEY, owner, title, new Date(Date.now() - 60000));
const buffer = () => {
  const ids: string[] = [];
  return {
    ids,
    queue: {
      sendBatch: vi.fn(async (messages: { body: { jobId: string } }[]) => {
        ids.push(...messages.map((m) => m.body.jobId));
      }),
    },
  };
};

it("arms the precise next due timestamp and moves it when a task is edited", async () => {
  const task = await addTask(
    db,
    TEST_ENC_KEY,
    owner,
    "Timed",
    new Date((nowSeconds() + 600) * 1000),
  );
  const stub = env.REMINDER_SCHEDULERS.getByName(`owner:${owner}`);
  await stub.refresh(owner);
  expect(
    await runInDurableObject(stub, (_, state) => state.storage.getAlarm()),
  ).toBe(+task.due_date!);
  const changed = new Date((nowSeconds() + 300) * 1000);
  await updateTaskById(db, TEST_ENC_KEY, task.id, [owner], {
    due_date: changed,
  });
  await stub.refresh(owner);
  expect(
    await runInDurableObject(stub, (_, state) => state.storage.getAlarm()),
  ).toBe(+changed);
  await completeTask(db, TEST_ENC_KEY, task.id, [owner]);
  await stub.refresh(owner);
  expect(
    await runInDurableObject(stub, (_, state) => state.storage.getAlarm()),
  ).toBeNull();
});
it("arms task changes through the same phone hook used by conversation and Calendar jobs", async () => {
  const task = await addTask(
    db,
    TEST_ENC_KEY,
    owner,
    "Calendar time",
    new Date((nowSeconds() + 600) * 1000),
  );
  await refreshRemindersForPhone(
    { ...env, REMINDER_SCHEDULER_ENABLED: "true" },
    TEST_PHONE,
  );
  const stub = env.REMINDER_SCHEDULERS.getByName(`owner:${owner}`);
  expect(
    await runInDurableObject(stub, (_, state) => state.storage.getAlarm()),
  ).toBe(+task.due_date!);
  await env.DB.prepare("UPDATE task SET due_date=due_date+60 WHERE id=?")
    .bind(task.id)
    .run();
  await refreshRemindersForPhone(
    { ...env, REMINDER_SCHEDULER_ENABLED: "true" },
    TEST_PHONE,
  );
  expect(
    await runInDurableObject(stub, (_, state) => state.storage.getAlarm()),
  ).toBe(+task.due_date! + 60000);
});
it("Undo re-arms the original due time", async () => {
  const task = await addTask(
    db,
    TEST_ENC_KEY,
    owner,
    "Undo",
    new Date((nowSeconds() + 600) * 1000),
  );
  const undo = newUndoContext(owner);
  await completeTask(db, TEST_ENC_KEY, task.id, [owner], [], undo);
  expect(await nextReminderAt(env, owner)).toBeNull();
  await undoTasks(env, owner);
  expect(await nextReminderAt(env, owner)).toBe(+task.due_date!);
});
it("dispatches 250 simultaneous reminders in consecutive pages without a minute boundary", async () => {
  const now = nowSeconds();
  const template = await due("Template");
  const encrypted = (await env.DB.prepare(
    "SELECT description FROM task WHERE id=?",
  )
    .bind(template.id)
    .first<{ description: string }>())!.description;
  await env.DB.prepare("DELETE FROM task").run();
  await env.DB.prepare(
    `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<250)
    INSERT INTO task(user_id,description,status,due_date,reminder_sent,created_at,updated_at) SELECT ?,?,'pending',?,0,?,? FROM seq`,
  )
    .bind(owner, encrypted, now - 60, now, now)
    .run();
  const buffered = buffer();
  expect(await dispatchOwnerReminders(env, owner, buffered.queue)).toBe(100);
  expect(await nextReminderAt(env, owner)).toBeLessThan(Date.now());
  expect(await dispatchOwnerReminders(env, owner, buffered.queue)).toBe(100);
  expect(await dispatchOwnerReminders(env, owner, buffered.queue)).toBe(50);
  expect(new Set(buffered.ids).size).toBe(250);
  expect(await dispatchOwnerReminders(env, owner, buffered.queue)).toBe(0);
  expect(
    buffered.queue.sendBatch.mock.calls.every(([rows]) => rows.length <= 100),
  ).toBe(true);
});
it("delivers an actual scheduler alarm through the Worker queue handler", async () => {
  const task = await addTask(
    db,
    TEST_ENC_KEY,
    owner,
    "Alarm task",
    new Date((nowSeconds() + 600) * 1000),
  );
  const stub = env.REMINDER_SCHEDULERS.getByName(`owner:${owner}`);
  await stub.refresh(owner);
  await env.DB.prepare("UPDATE task SET due_date=? WHERE id=?")
    .bind(nowSeconds() - 60, task.id)
    .run();
  task.due_date = new Date((nowSeconds() - 60) * 1000);
  task.revision = (await flag(task.id))!.revision;
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const job = await ensureReminderJob(env, task);
  expect((await row(job.id))?.state).toBe("queued");
  const batch = createMessageBatch("wa-reminders", [
    {
      id: "one",
      timestamp: new Date(),
      attempts: 1,
      body: { type: "reminder" as const, jobId: job.id },
    },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  const result = await getQueueResult(batch, ctx);
  expect(result.explicitAcks).toEqual(["one"]);
  expect(result.retryMessages).toEqual([]);
  expect((await flag(task.id))?.reminder_sent).toBe(1);
  expect(sends()).toHaveLength(1);
});
it("the queue handler acknowledges healthy work and retries only the throttled message", async () => {
  const slow = await ensureReminderJob(env, await due("Throttled")),
    healthy = await ensureReminderJob(env, await due("Healthy"));
  const base = makeMockFetch();
  fetchMock.mockImplementation((url: string, init: RequestInit) =>
    String(init.body).includes("Throttled")
      ? Promise.resolve(
          Response.json({ error: { code: 130429 } }, { status: 429 }),
        )
      : base(url),
  );
  const batch = createMessageBatch(
    "wa-reminders",
    [slow, healthy].map((job, i) => ({
      id: String(i),
      timestamp: new Date(),
      attempts: 1,
      body: { type: "reminder" as const, jobId: job.id },
    })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  const result = await getQueueResult(batch, ctx);
  expect(result.explicitAcks).toEqual(["1"]);
  expect(result.retryMessages.map((m) => m.msgId)).toEqual(["0"]);
});
it("only signed status webhooks can resolve an uncertain delivery and they do not refresh chat activity", async () => {
  const task = await due(),
    job = await ensureReminderJob(env, task);
  const activity = (await getUserById(db, owner))!.last_active.getTime();
  await env.DB.prepare("UPDATE reminder_job SET state='uncertain' WHERE id=?")
    .bind(job.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO reminder_delivery(job_id,user_id,state,updated_at) VALUES (?,?,'uncertain',?)",
  )
    .bind(job.id, owner, nowSeconds())
    .run();
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                {
                  id: "signed-id",
                  status: "delivered",
                  biz_opaque_callback_data: `r:${job.id}:${owner}`,
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const bad = await makeSignedWebhookRequestFromBody(body);
  bad.headers.set("x-hub-signature-256", "sha256=" + "0".repeat(64));
  expect((await worker.fetch(bad, env, createExecutionContext())).status).toBe(
    403,
  );
  expect((await row(job.id))?.state).toBe("uncertain");
  expect(
    (
      await worker.fetch(
        await makeSignedWebhookRequestFromBody(body),
        env,
        createExecutionContext(),
      )
    ).status,
  ).toBe(200);
  await deliverReminderJob(env, job.id);
  expect(sends()).toHaveLength(0);
  expect((await flag(task.id))?.reminder_sent).toBe(1);
  expect((await getUserById(db, owner))!.last_active.getTime()).toBe(activity);
});
it("recovery continues past 200 owners immediately and repairs their future timers", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600000);
  const now = nowSeconds();
  await env.DB.prepare(
    `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<201)
    INSERT INTO user(phone_number_encrypted,phone_number_hash,created_at,last_active) SELECT 'test-only','recover-'||x,?,? FROM seq`,
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO billing_account(phone_hash,billing_key,trial_ends_at) SELECT phone_number_hash,phone_number_hash,? FROM user WHERE phone_number_hash LIKE 'recover-%'",
  )
    .bind(now + 86400)
    .run();
  await env.DB.prepare(
    "INSERT INTO task(user_id,description,status,due_date,created_at,updated_at) SELECT id,'test-only','pending',?,?,? FROM user WHERE phone_number_hash LIKE 'recover-%'",
  )
    .bind(now + 120, now, now)
    .run();
  const recovery = env.REMINDER_SCHEDULERS.getByName("recovery");
  await recoverReminderSchedules({
    ...env,
    REMINDER_SCHEDULER_ENABLED: "true",
  });
  await runDurableObjectAlarm(recovery);
  expect(
    await runInDurableObject(recovery, (_, state) =>
      state.storage.get("cursor"),
    ),
  ).toBeDefined();
  await runDurableObjectAlarm(recovery);
  expect(
    await runInDurableObject(recovery, (_, state) => state.storage.getAlarm()),
  ).toBeNull();
  const last = (await env.DB.prepare(
    "SELECT MAX(id) AS id FROM user WHERE phone_number_hash LIKE 'recover-%'",
  ).first<{ id: number }>())!.id;
  expect(
    await runInDurableObject(
      env.REMINDER_SCHEDULERS.getByName(`owner:${last}`),
      (_, state) => state.storage.getAlarm(),
    ),
  ).toBe((now + 120) * 1000);
});
it("uses the legacy approved template if the optional action template is rejected", async () => {
  await env.DB.prepare("UPDATE user SET last_active=? WHERE id=?")
    .bind(nowSeconds() - 25 * 3600, owner)
    .run();
  const task = await due();
  const base = makeMockFetch();
  fetchMock.mockImplementation((url: string, init: RequestInit) =>
    String(init.body).includes("missing_actions")
      ? Promise.resolve(
          Response.json({ error: { code: 132001 } }, { status: 400 }),
        )
      : base(url),
  );
  await deliverReminderJob(
    { ...env, REMINDER_ACTIONS_TEMPLATE_NAME: "missing_actions" },
    (await ensureReminderJob(env, task)).id,
  );
  expect((await flag(task.id))?.reminder_sent).toBe(1);
  expect(sends()).toHaveLength(2);
});
it("a queue admission failure leaves recoverable work rather than marking it sent", async () => {
  const task = await due();
  const failed = {
    sendBatch: vi.fn().mockRejectedValue(new Error("Queue unavailable")),
  };
  await expect(dispatchOwnerReminders(env, owner, failed)).rejects.toThrow(
    "Queue unavailable",
  );
  const job = await ensureReminderJob(env, task);
  expect((await row(job.id))?.state).toBe("ready");
  expect((await flag(task.id))?.reminder_sent).toBe(0);
  await env.DB.prepare("UPDATE reminder_job SET next_attempt_at=0").run();
  const buffered = buffer();
  expect(await dispatchOwnerReminders(env, owner, buffered.queue)).toBe(1);
});
it("duplicate queue deliveries can only submit one message", async () => {
  const task = await due();
  const job = await ensureReminderJob(env, task);
  await Promise.all([
    deliverReminderJob(env, job.id),
    deliverReminderJob(env, job.id),
  ]);
  expect(sends()).toHaveLength(1);
  expect((await flag(task.id))?.reminder_sent).toBe(1);
  await deliverReminderJob(env, job.id);
  expect(sends()).toHaveLength(1);
});
it.each(["cancel", "reschedule", "rename"])(
  "drops a stale queued job after %s",
  async (action) => {
    const task = await due();
    const job = await ensureReminderJob(env, task);
    if (action === "cancel")
      await completeTask(db, TEST_ENC_KEY, task.id, [owner]);
    else
      await updateTaskById(
        db,
        TEST_ENC_KEY,
        task.id,
        [owner],
        action === "rename"
          ? { description: "Edited" }
          : { due_date: new Date(Date.now() + 60000) },
      );
    await deliverReminderJob(env, job.id);
    expect(sends()).toHaveLength(0);
    expect((await row(job.id))?.state).toBe("stale");
  },
);
it("does not deliver before the due timestamp or after trial expiry", async () => {
  const task = await addTask(
    db,
    TEST_ENC_KEY,
    owner,
    "Future",
    new Date((nowSeconds() + 60) * 1000),
  );
  const job = await ensureReminderJob(env, task);
  expect(await deliverReminderJob(env, job.id)).toBeGreaterThan(0);
  expect(sends()).toHaveLength(0);
  const past = await due();
  const pastJob = await ensureReminderJob(env, past);
  await env.DB.prepare("UPDATE billing_account SET trial_ends_at=1").run();
  await deliverReminderJob(env, pastJob.id);
  expect((await row(pastJob.id))?.state).toBe("blocked");
  expect(sends()).toHaveLength(0);
  expect(await nextReminderAt(env, owner)).toBeNull();
});
it("provider throttling retries independently and does not consume another task", async () => {
  const task = await due("Rate limited"),
    other = await due("Healthy");
  const job = await ensureReminderJob(env, task),
    otherJob = await ensureReminderJob(env, other);
  const base = makeMockFetch();
  let reject = true;
  fetchMock.mockImplementation((url: string, init: RequestInit) =>
    reject && String(init.body).includes("Rate limited")
      ? Promise.resolve(
          Response.json(
            { error: { code: 130429 } },
            { status: 429, headers: { "Retry-After": "30" } },
          ),
        )
      : base(url),
  );
  expect(await deliverReminderJob(env, job.id)).toBeGreaterThanOrEqual(30);
  await deliverReminderJob(env, otherJob.id);
  expect((await flag(other.id))?.reminder_sent).toBe(1);
  expect((await flag(task.id))?.reminder_sent).toBe(0);
  reject = false;
  await env.DB.prepare("UPDATE reminder_job SET next_attempt_at=0 WHERE id=?")
    .bind(job.id)
    .run();
  await deliverReminderJob(env, job.id);
  expect((await flag(task.id))?.reminder_sent).toBe(1);
});
it("keeps transient failures recoverable beyond the Queue retry budget", async () => {
  const task = await due();
  const job = await ensureReminderJob(env, task);
  await env.DB.prepare("UPDATE reminder_job SET attempt=20 WHERE id=?")
    .bind(job.id)
    .run();
  fetchMock.mockResolvedValue(
    Response.json({ error: { code: 130429 } }, { status: 429 }),
  );
  expect(await deliverReminderJob(env, job.id)).toBeGreaterThan(0);
  expect((await row(job.id))?.state).toBe("retry");
});
it("an uncertain network outcome is not automatically repeated and a signed receipt recovers it", async () => {
  const task = await due();
  const job = await ensureReminderJob(env, task);
  const base = makeMockFetch();
  let lost = true;
  fetchMock.mockImplementation((url: string, init: RequestInit) =>
    lost && String(init.body).includes("biz_opaque_callback_data")
      ? Promise.reject(new Error("Response lost"))
      : base(url),
  );
  await deliverReminderJob(env, job.id);
  expect((await row(job.id))?.state).toBe("uncertain");
  expect((await flag(task.id))?.reminder_sent).toBe(0);
  await deliverReminderJob(env, job.id);
  expect(sends()).toHaveLength(1);
  // A callback may arrive after a network timeout; it identifies the existing recipient attempt.
  lost = false;
  await handleReminderStatus(env, {
    id: "wa-recovered",
    status: "delivered",
    biz_opaque_callback_data: `r:${job.id}:${owner}`,
  });
  await deliverReminderJob(env, job.id);
  expect(sends()).toHaveLength(1);
  expect((await flag(task.id))?.reminder_sent).toBe(1);
});
it("an interrupted sender does not re-send a persisted in-flight recipient", async () => {
  const task = await due();
  const job = await ensureReminderJob(env, task);
  await env.DB.prepare(
    "UPDATE reminder_job SET state='sending',lease_until=0 WHERE id=?",
  )
    .bind(job.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO reminder_delivery(job_id,user_id,state,updated_at) VALUES (?,?,'sending',?)",
  )
    .bind(job.id, owner, nowSeconds())
    .run();
  await deliverReminderJob(env, job.id);
  expect(sends()).toHaveLength(0);
  expect((await row(job.id))?.state).toBe("uncertain");
});
it("an already accepted recipient is skipped after a worker crash", async () => {
  const task = await due();
  const job = await ensureReminderJob(env, task);
  await env.DB.prepare(
    "UPDATE reminder_job SET state='sending',lease_until=0 WHERE id=?",
  )
    .bind(job.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO reminder_delivery(job_id,user_id,state,whatsapp_id,updated_at) VALUES (?,?,'accepted','wa-existing',?)",
  )
    .bind(job.id, owner, nowSeconds())
    .run();
  await deliverReminderJob(env, job.id);
  expect(sends()).toHaveLength(0);
  expect((await flag(task.id))?.reminder_sent).toBe(1);
});
it("creates only one future recurring occurrence and retains assignments", async () => {
  const other = await createTestUser(TEST_PHONE_2);
  const task = await addTask(
    db,
    TEST_ENC_KEY,
    owner,
    "Recurring",
    new Date(Date.now() - 3 * 86400000),
    "daily",
  );
  await addTaskAssignees(db, task.id, [other]);
  const job = await ensureReminderJob(env, task);
  await deliverReminderJob(env, job.id);
  await deliverReminderJob(env, job.id);
  const next = (
    await env.DB.prepare(
      "SELECT id,due_date FROM task WHERE user_id=? AND status='pending'",
    )
      .bind(owner)
      .all<{ id: number; due_date: number }>()
  ).results;
  expect(next).toHaveLength(1);
  expect(next[0].due_date).toBeGreaterThan(nowSeconds());
  expect(
    (
      await env.DB.prepare(
        "SELECT assignee_user_id FROM task_assignee WHERE task_id=?",
      )
        .bind(next[0].id)
        .first<{ assignee_user_id: number }>()
    )?.assignee_user_id,
  ).toBe(other);
  expect(sends()).toHaveLength(2);
});
it("does not repeat the owner message while retrying an assigned recipient", async () => {
  const other = await createTestUser(TEST_PHONE_2);
  const task = await due();
  await addTaskAssignees(db, task.id, [other]);
  const job = await ensureReminderJob(env, task);
  const base = makeMockFetch();
  let reject = true;
  fetchMock.mockImplementation((url: string, init: RequestInit) =>
    reject && String(init.body).includes(TEST_PHONE_2)
      ? Promise.resolve(
          Response.json({ error: { code: 131056 } }, { status: 400 }),
        )
      : base(url),
  );
  expect(await deliverReminderJob(env, job.id)).toBeGreaterThan(0);
  reject = false;
  await env.DB.prepare("UPDATE reminder_job SET next_attempt_at=0 WHERE id=?")
    .bind(job.id)
    .run();
  await deliverReminderJob(env, job.id);
  expect(sends().filter((b) => b.to === TEST_PHONE)).toHaveLength(1);
  expect((await flag(task.id))?.reminder_sent).toBe(1);
});
it("the old 900/minute soft cap does not throttle queued reminders", async () => {
  const now = new Date(),
    p = (n: number) => String(n).padStart(2, "0");
  const bucket = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  await env.CACHE.put(`svc:whatsapp:m:${bucket}`, "900");
  const task = await due();
  await deliverReminderJob(env, (await ensureReminderJob(env, task)).id);
  expect((await flag(task.id))?.reminder_sent).toBe(1);
  await env.CACHE.delete(`svc:whatsapp:m:${bucket}`);
});
it("stale or mismatched delivery receipts cannot change a different attempt", async () => {
  const task = await due();
  const job = await ensureReminderJob(env, task);
  await deliverReminderJob(env, job.id);
  const delivery = await env.DB.prepare(
    "SELECT whatsapp_id FROM reminder_delivery WHERE job_id=? AND user_id=?",
  )
    .bind(job.id, owner)
    .first<{ whatsapp_id: string }>();
  await handleReminderStatus(env, {
    id: "other-id",
    status: "failed",
    errors: [{ code: 131026 }],
    biz_opaque_callback_data: `r:${job.id}:${owner}`,
  });
  expect(
    (
      await env.DB.prepare(
        "SELECT delivery_status FROM reminder_delivery WHERE job_id=?",
      )
        .bind(job.id)
        .first<{ delivery_status: string | null }>()
    )?.delivery_status,
  ).toBeNull();
  await handleReminderStatus(env, {
    id: delivery!.whatsapp_id,
    status: "read",
    biz_opaque_callback_data: `r:${job.id}:${owner}`,
  });
  await handleReminderStatus(env, {
    id: delivery!.whatsapp_id,
    status: "sent",
    biz_opaque_callback_data: `r:${job.id}:${owner}`,
  });
  expect(
    (
      await env.DB.prepare(
        "SELECT delivery_status FROM reminder_delivery WHERE job_id=?",
      )
        .bind(job.id)
        .first<{ delivery_status: string }>()
    )?.delivery_status,
  ).toBe("read");
});

it("records asynchronous Meta failure codes without replaying an accepted recurring reminder", async () => {
  const task = await addTask(db, TEST_ENC_KEY, owner, "Recurring", new Date(Date.now() - 60000), "weekly");
  const job = await ensureReminderJob(env, task);
  await deliverReminderJob(env, job.id);
  const acceptedJob = await row(job.id);
  const delivery = await env.DB.prepare("SELECT whatsapp_id FROM reminder_delivery WHERE job_id=? AND user_id=?")
    .bind(job.id, owner).first<{ whatsapp_id: string }>();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await handleReminderStatus(env, {
    id: delivery!.whatsapp_id,
    status: "failed",
    biz_opaque_callback_data: `r:${job.id}:${owner}`,
    errors: [{ code: 131026, title: "Private provider text", error_data: { details: TEST_PHONE } }],
  });
  expect(await env.DB.prepare("SELECT error_code,delivery_status,state FROM reminder_delivery WHERE job_id=? AND user_id=?")
    .bind(job.id, owner).first()).toMatchObject({ error_code: 131026, delivery_status: "failed", state: "accepted" });
  expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "reminder_delivery_failed", job_id: job.id, user_id: owner, error_codes: [131026] }));
  const alert = calls().find((body) => body.text?.body?.includes("[reminder_delivery_failed]"))?.text.body;
  expect(alert).toContain("131026");
  expect(alert).not.toContain(TEST_PHONE);
  expect(alert).not.toContain("Private provider text");
  await deliverReminderJob(env, job.id);
  expect(sends()).toHaveLength(1);
  expect(await row(job.id)).toEqual(acceptedJob);
  expect((await flag(task.id))?.status).toBe("completed");
  // A duplicate callback without errors must not erase the saved diagnostic.
  await handleReminderStatus(env, {
    id: delivery!.whatsapp_id, status: "failed", biz_opaque_callback_data: `r:${job.id}:${owner}`,
  });
  expect((await env.DB.prepare("SELECT error_code FROM reminder_delivery WHERE job_id=? AND user_id=?")
    .bind(job.id, owner).first<{ error_code: number }>())?.error_code).toBe(131026);
});

it.each([undefined, null, {}, [null, "error", { code: "131026" }, { code: 1.5 }, { code: -1 }]])(
  "handles absent or malformed failure errors (%j)", async (errors) => {
    const task = await due();
    const job = await ensureReminderJob(env, task);
    await deliverReminderJob(env, job.id);
    const delivery = await env.DB.prepare("SELECT whatsapp_id FROM reminder_delivery WHERE job_id=? AND user_id=?")
      .bind(job.id, owner).first<{ whatsapp_id: string }>();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleReminderStatus(env, {
      id: delivery!.whatsapp_id, status: "failed", biz_opaque_callback_data: `r:${job.id}:${owner}`, errors,
    });
    expect((await env.DB.prepare("SELECT error_code,delivery_status FROM reminder_delivery WHERE job_id=? AND user_id=?")
      .bind(job.id, owner).first())).toMatchObject({ error_code: null, delivery_status: "failed" });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "reminder_delivery_failed", job_id: job.id, user_id: owner, error_codes: [] }));
    expect(calls().find((body) => body.text?.body?.includes("[reminder_delivery_failed]"))?.text.body).toContain("not supplied");
  },
);
