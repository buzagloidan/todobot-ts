/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { buildDb } from "../src/db/client.ts";
import { addTask, getDueTasksForReminders } from "../src/db/queries.ts";
import { sendDueRemindersForTest as scanAndSendReminders } from "./helpers.ts";
import { billingAccessSql, subscriptionAllowsAccess } from "../src/services/billing.ts";
import {
  TEST_ENC_KEY,
  TEST_PHONE_2,
  applySchema,
  clearData,
  createTestUser,
  makeMockFetch,
} from "./helpers.ts";

let db: ReturnType<typeof buildDb>;
let userId: number;
let mockFetch: ReturnType<typeof vi.fn>;

function whatsAppCalls() {
  return mockFetch.mock.calls.filter(([url]: [string]) =>
    url.toString().includes("graph.facebook.com")
  );
}

function reminderCalls() {
  return whatsAppCalls().filter(([, init]: [string, RequestInit]) => {
    const body = JSON.parse(init.body as string) as { type?: string };
    return body.type === "template" || body.type === "interactive";
  });
}

beforeAll(async () => {
  await applySchema();
  db = buildDb(env);
});

beforeEach(async () => {
  await clearData();
  await Promise.all([
    env.CACHE.delete("alert:reminder_task_failed"),
    env.CACHE.delete("alert:reminder_cron"),
  ]);
  userId = await createTestUser();
  mockFetch = vi.fn().mockImplementation(makeMockFetch());
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scanAndSendReminders", () => {
  it("sends a WhatsApp message for a past-due task", async () => {
    const past = new Date(Date.now() - 3_600_000);
    await addTask(db, TEST_ENC_KEY, userId, "Doctor appointment", past);

    await scanAndSendReminders(env);

    const waCall = mockFetch.mock.calls.find(([url]: [string]) =>
      url.includes("graph.facebook.com")
    );
    expect(waCall).toBeDefined();
    // The decrypted description must appear somewhere in the request body
    const bodyStr = waCall![1].body as string;
    expect(bodyStr).toContain("Doctor appointment");
  });

  it("marks the task as reminder_sent after a successful send", async () => {
    const past = new Date(Date.now() - 3_600_000);
    const task = await addTask(db, TEST_ENC_KEY, userId, "Doctor appointment", past);

    await scanAndSendReminders(env);

    const row = await env.DB.prepare(
      "SELECT reminder_sent FROM task WHERE id = ?"
    )
      .bind(task.id)
      .first<{ reminder_sent: number }>();
    expect(row!.reminder_sent).toBe(1);
  });

  it("does not send a reminder for a future task", async () => {
    const future = new Date(Date.now() + 3_600_000);
    await addTask(db, TEST_ENC_KEY, userId, "Future task", future);

    await scanAndSendReminders(env);

    const waCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      url.includes("graph.facebook.com")
    );
    expect(waCalls.length).toBe(0);
  });

  it("does not re-send when reminder_sent is already true", async () => {
    const past = new Date(Date.now() - 3_600_000);
    const task = await addTask(db, TEST_ENC_KEY, userId, "Already reminded", past);
    await env.DB.prepare("UPDATE task SET reminder_sent = 1 WHERE id = ?")
      .bind(task.id)
      .run();

    await scanAndSendReminders(env);

    const waCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      url.includes("graph.facebook.com")
    );
    expect(waCalls.length).toBe(0);
  });

  it("does not send the same reminder twice across successive scans", async () => {
    const past = new Date(Date.now() - 3_600_000);
    await addTask(db, TEST_ENC_KEY, userId, "One-shot reminder", past);

    await scanAndSendReminders(env);
    mockFetch.mockClear();

    await scanAndSendReminders(env);

    const waCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      url.includes("graph.facebook.com")
    );
    expect(waCalls.length).toBe(0);
  });

  it("uses the partial reminder index for the production-shaped scan", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      WITH RECURSIVE seq(x) AS (
        SELECT 1
        UNION ALL
        SELECT x + 1 FROM seq WHERE x < 200
      )
      INSERT INTO task (
        user_id, description, status, due_date, reminder_sent,
        recurrence, created_at, completed_at, updated_at
      )
      SELECT ?, 'already-sent', 'pending', ? - x, 1, NULL, ?, NULL, ?
      FROM seq
    `).bind(userId, now, now, now).run();
    await addTask(db, TEST_ENC_KEY, userId, "Indexed task", new Date((now - 1) * 1000));
    await env.DB.prepare("ANALYZE").run();

    const plan = await env.DB.prepare(`
      EXPLAIN QUERY PLAN
      SELECT task.*, user.id
      FROM task INDEXED BY idx_task_pending_unsent_due
      INNER JOIN user ON task.user_id = user.id
      WHERE task.due_date <= ?1
        AND task.status = 'pending'
        AND task.reminder_sent = 0
        AND ${billingAccessSql('user.phone_number_hash', '?1')}
      ORDER BY task.due_date ASC, task.id ASC
      LIMIT 1000
    `)
      .bind(now)
      .all<{ detail: string }>();

    expect(
      plan.results.some((row) => row.detail.includes("idx_task_pending_unsent_due")),
      JSON.stringify(plan.results)
    ).toBe(true);
  });

  it("processes more than 20 due tasks without waiting another minute", async () => {
    const past = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < 21; i++) {
      await addTask(db, TEST_ENC_KEY, userId, `Batch task ${i}`, past);
    }

    await scanAndSendReminders(env);

    expect(reminderCalls()).toHaveLength(21);
    const firstBatchDescriptions = reminderCalls().map(([, init]: [string, RequestInit]) => {
      const body = JSON.parse(init.body as string) as {
        template?: { components: { parameters: { text: string }[] }[] };
        interactive?: { body: { text: string } };
      };
      return body.template?.components[0].parameters[0].text ?? body.interactive?.body.text.match(/📋 ([^\n]+)/)?.[1];
    });
    expect(new Set(firstBatchDescriptions)).toEqual(new Set(Array.from({ length: 21 }, (_, i) => `Batch task ${i}`)));

    mockFetch.mockClear();
    await scanAndSendReminders(env);

    expect(reminderCalls()).toHaveLength(0);
  });

  it("skips a large history of already-sent pending reminders", async () => {
    const past = new Date(Date.now() - 7_200_000);
    for (let i = 0; i < 25; i++) {
      const task = await addTask(db, TEST_ENC_KEY, userId, `Sent task ${i}`, past);
      await env.DB.prepare("UPDATE task SET reminder_sent = 1 WHERE id = ?")
        .bind(task.id)
        .run();
    }
    await addTask(db, TEST_ENC_KEY, userId, "Only unsent task", new Date(past.getTime() + 1_000));

    await scanAndSendReminders(env);

    expect(reminderCalls()).toHaveLength(1);
    expect((reminderCalls()[0][1].body as string)).toContain("Only unsent task");
  });

  it("retries explicit provider throttling without repeating an accepted send", async () => {
    const task=await addTask(db,TEST_ENC_KEY,userId,"Retry task",new Date(Date.now()-60000));
    mockFetch.mockResolvedValueOnce(Response.json({error:{code:130429}},{status:429}));
    await scanAndSendReminders(env);
    expect((await env.DB.prepare('SELECT state FROM reminder_job WHERE task_id=?').bind(task.id).first<{state:string}>())?.state).toBe('retry');
    await env.DB.prepare('UPDATE reminder_job SET next_attempt_at=0').run();
    await scanAndSendReminders(env);
    expect((await env.DB.prepare('SELECT reminder_sent FROM task WHERE id=?').bind(task.id).first<{reminder_sent:number}>())?.reminder_sent).toBe(1);
    await scanAndSendReminders(env);expect(reminderCalls()).toHaveLength(2);
  });

  it("a permanent provider rejection does not prevent another task's reminder", async () => {
    const failed=await addTask(db,TEST_ENC_KEY,userId,"Failed task",new Date(Date.now()-60000));
    const good=await addTask(db,TEST_ENC_KEY,userId,"Good task",new Date(Date.now()-60000));
    const base=makeMockFetch();mockFetch.mockImplementation((url:string,init:RequestInit)=>String(init.body).includes('Failed task')?Promise.resolve(Response.json({error:{code:131009}},{status:400})):base(url));
    await scanAndSendReminders(env);
    expect((await env.DB.prepare('SELECT state FROM reminder_job WHERE task_id=?').bind(failed.id).first<{state:string}>())?.state).toBe('failed');
    expect((await env.DB.prepare('SELECT reminder_sent FROM task WHERE id=?').bind(good.id).first<{reminder_sent:number}>())?.reminder_sent).toBe(1);
  });

  it("does not duplicate delivery when scans overlap", async () => {
    const past = new Date(Date.now() - 3_600_000);
    await addTask(db, TEST_ENC_KEY, userId, "Concurrent task", past);

    await Promise.all([
      scanAndSendReminders(env),
      scanAndSendReminders(env),
    ]);

    expect(reminderCalls()).toHaveLength(1);
  });

  it("completes a recurring task and schedules its next occurrence", async () => {
    const past = new Date(Date.now() - 3_600_000);
    await addTask(db, TEST_ENC_KEY, userId, "Daily task", past, "daily");

    await scanAndSendReminders(env);

    const rows = await env.DB.prepare(
      "SELECT status, reminder_sent, recurrence, due_date FROM task ORDER BY id"
    ).all<{ status: string; reminder_sent: number; recurrence: string; due_date: number }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({ status: "completed", reminder_sent: 1, recurrence: "daily" });
    expect(rows.results[1]).toMatchObject({ status: "pending", reminder_sent: 0, recurrence: "daily" });
    expect(rows.results[1].due_date).toBeGreaterThan(rows.results[0].due_date);
  });
});


describe("reminder scan billing eligibility", () => {
  it("reaches paid reminders behind more than a full batch of ineligible tasks", async () => {
    const expired = userId;
    await env.DB.prepare("UPDATE billing_account SET trial_ends_at=1").run();
    for (let i=0; i<25; i++) await addTask(db, TEST_ENC_KEY, expired, `Expired task ${i}`, new Date(Date.now()-7200000));
    const paid = await createTestUser(TEST_PHONE_2);
    const account = await env.DB.prepare("SELECT b.billing_key FROM billing_account b JOIN user u ON u.phone_number_hash=b.phone_hash WHERE u.id=?").bind(paid).first<{billing_key:string}>();
    await env.DB.prepare("UPDATE billing_account SET trial_ends_at=1").run();
    await env.DB.prepare("INSERT INTO billing_subscription (id,billing_key,status,renews_at,updated_at) VALUES ('paid',?,'active',?,'2026-10-13')").bind(account!.billing_key,Math.floor(Date.now()/1000)+86400).run();
    const due = await addTask(db, TEST_ENC_KEY, paid, "Paid reminder after backlog", new Date(Date.now()-60000));
    await scanAndSendReminders(env);
    expect(reminderCalls()).toHaveLength(1);
    expect(String(reminderCalls()[0][1].body)).toContain("Paid reminder after backlog");
    expect((await env.DB.prepare("SELECT reminder_sent FROM task WHERE id=?").bind(due.id).first<{reminder_sent:number}>())?.reminder_sent).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM task WHERE user_id=? AND reminder_sent=0 AND status='pending'").bind(expired).first<{n:number}>())?.n).toBe(25);
  });

  it("legacy accounts without a billing row cannot block a trial user's reminder", async () => {
    for (let i=0; i<21; i++) await addTask(db,TEST_ENC_KEY,userId,`Legacy ${i}`,new Date(Date.now()-7200000));
    await env.DB.prepare("DELETE FROM billing_account").run();
    const trial = await createTestUser(TEST_PHONE_2);
    const due = await addTask(db,TEST_ENC_KEY,trial,"Trial reminder",new Date(Date.now()-60000));
    expect((await getDueTasksForReminders(db,TEST_ENC_KEY)).map(r=>r.task.id)).toEqual([due.id]);
    await scanAndSendReminders(env);
    expect(reminderCalls()).toHaveLength(1);
    expect(String(reminderCalls()[0][1].body)).toContain("Trial reminder");
  });

  it("preserves an unpaid reminder and resumes it when its owner gets access", async () => {
    await env.DB.prepare("UPDATE billing_account SET trial_ends_at=1").run();
    const due=await addTask(db,TEST_ENC_KEY,userId,"Resume reminder",new Date(Date.now()-60000));
    expect(await getDueTasksForReminders(db,TEST_ENC_KEY)).toHaveLength(0);
    await env.DB.prepare("UPDATE billing_account SET trial_ends_at=?").bind(Math.floor(Date.now()/1000)+86400).run();
    expect((await getDueTasksForReminders(db,TEST_ENC_KEY)).map(r=>r.task.id)).toEqual([due.id]);
  });

  it.each([
    {status:'active',renews:86400,trial:null,ends:null,allowed:true},
    {status:'active',renews:-1,trial:null,ends:null,allowed:false},
    {status:'active',renews:86400,trial:null,ends:-1,allowed:false},
    {status:'on_trial',renews:null,trial:86400,ends:null,allowed:true},
    {status:'on_trial',renews:null,trial:-1,ends:null,allowed:false},
    {status:'cancelled',renews:-1,trial:null,ends:86400,allowed:true},
    {status:'cancelled',renews:86400,trial:null,ends:-1,allowed:false},
    {status:'paused',renews:86400,trial:null,ends:null,allowed:false},
    {status:'past_due',renews:86400,trial:null,ends:null,allowed:false},
    {status:'unknown',renews:86400,trial:null,ends:null,allowed:false},
  ])("keeps the SQL admission policy consistent with entitlement: $status $allowed",async({status,renews,trial,ends,allowed})=>{
    const now=Math.floor(Date.now()/1000);
    const account=await env.DB.prepare("SELECT billing_key FROM billing_account").first<{billing_key:string}>();
    await env.DB.prepare("UPDATE billing_account SET trial_ends_at=1").run();
    const sub={id:'test',billing_key:account!.billing_key,status,renews_at:renews===null?null:now+renews,trial_ends_at:trial===null?null:now+trial,ends_at:ends===null?null:now+ends,updated_at:'2026-10-13'};
    await env.DB.prepare("INSERT INTO billing_subscription (id,billing_key,status,renews_at,trial_ends_at,ends_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(sub.id,sub.billing_key,status,sub.renews_at,sub.trial_ends_at,sub.ends_at,sub.updated_at).run();
    await addTask(db,TEST_ENC_KEY,userId,"Eligibility case",new Date((now-60)*1000));
    expect(subscriptionAllowsAccess(sub,now)).toBe(allowed);
    expect(await getDueTasksForReminders(db,TEST_ENC_KEY)).toHaveLength(allowed?1:0);
  });
});
