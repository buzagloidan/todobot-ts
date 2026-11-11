/// <reference types="@cloudflare/vitest-plugin" />
import { env, runDurableObjectAlarm, runInDurableObject, listDurableObjectIds } from "cloudflare:test";
import calendarMigration from "../drizzle/0013_google_calendar.sql?raw";
import reminderMigration from "../drizzle/0016_reminder_dispatch.sql?raw";
import shareMigration from "../drizzle/0019_user_share_offer.sql?raw";
import taskScheduleMigration from "../drizzle/0018_task_schedule_pending.sql?raw";
import projectsMigration from "../drizzle/0017_projects_and_recovery.sql?raw";
import { ensureReminderJob, deliverReminderJob } from "../src/services/reminder_dispatch.ts";
import { getDueTasksForReminders } from "../src/db/queries.ts";
import { buildDb } from "../src/db/client.ts";
import controlsMigration from '../drizzle/0014_task_controls_and_agenda.sql?raw';
import type { Env } from "../src/types.ts";
import { fernetEncrypt } from "../src/crypto/fernet.ts";
import { getBillingAccount } from "../src/services/billing.ts";
import { hashPhone } from "../src/crypto/hash.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

export const TEST_ENC_KEY =
  "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ";
export const TEST_APP_SECRET = "test_app_secret";
export const TEST_PHONE = "972501234567";
export const TEST_PHONE_2 = "972509876543";

// Retain legacy board/biz column fixtures to verify compatibility with existing production rows.
const SCHEMA_STATEMENTS = [
  'DROP TABLE IF EXISTS user_share_offer',
  'DROP TABLE IF EXISTS task_schedule_pending',
  'DROP TABLE IF EXISTS recovery_pending',
  'DROP TABLE IF EXISTS task_recovery',
  'DROP TABLE IF EXISTS reminder_delivery',
  'DROP TABLE IF EXISTS reminder_job',
  'DROP TABLE IF EXISTS agenda_priority',
  'DROP TABLE IF EXISTS agenda_preferences',
  'DROP TABLE IF EXISTS task_control_use',
  'DROP TABLE IF EXISTS task_undo_change',
  'DROP TABLE IF EXISTS task_undo',
  "DROP TABLE IF EXISTS google_calendar_event",
  "DROP TABLE IF EXISTS google_calendar_oauth",
  "DROP TABLE IF EXISTS google_calendar_connection",
  "DROP TABLE IF EXISTS `billing_subscription`",
  "DROP TABLE IF EXISTS `billing_account`",
  "DROP TABLE IF EXISTS `task_assignee`",
  "DROP TABLE IF EXISTS `friend_link`",
  "DROP TABLE IF EXISTS `board`",
  "DROP TABLE IF EXISTS `message`",
  "DROP TABLE IF EXISTS `task`",
  'DROP TABLE IF EXISTS project',
  "DROP TABLE IF EXISTS `user`",
  `CREATE TABLE IF NOT EXISTS \`user\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`phone_number_encrypted\` text NOT NULL,
    \`phone_number_hash\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`last_active\` integer NOT NULL,
    \`partner_user_id\` integer REFERENCES \`user\`(\`id\`) ON DELETE SET NULL,
    \`api_token_encrypted\` text,
    \`api_token_hash\` text,
    \`api_token_created_at\` integer,
    \`biz_setup_state\` text
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`user_phone_number_hash_unique\` ON \`user\` (\`phone_number_hash\`)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`idx_user_api_token_hash\` ON \`user\` (\`api_token_hash\`)`,
  `CREATE INDEX IF NOT EXISTS \`idx_user_phone_hash\` ON \`user\` (\`phone_number_hash\`)`,
  `CREATE INDEX IF NOT EXISTS \`idx_user_partner\` ON \`user\` (\`partner_user_id\`)`,
  `CREATE TABLE IF NOT EXISTS \`task\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`user_id\` integer NOT NULL REFERENCES \`user\`(\`id\`) ON DELETE CASCADE,
    \`description\` text NOT NULL,
    \`status\` text DEFAULT 'pending' NOT NULL,
    \`due_date\` integer,
    \`reminder_date\` integer,
    \`reminder_sent\` integer DEFAULT false,
    \`recurrence\` text,
    \`created_at\` integer NOT NULL,
    \`completed_at\` integer,
    \`updated_at\` integer NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS \`idx_task_user_status\` ON \`task\` (\`user_id\`, \`status\`)`,
  `CREATE INDEX IF NOT EXISTS \`idx_task_due_date\` ON \`task\` (\`due_date\`)`,
  `CREATE INDEX IF NOT EXISTS \`idx_task_status_due\` ON \`task\` (\`status\`, \`due_date\`)`,
  `CREATE INDEX IF NOT EXISTS \`idx_task_pending_unsent_due\` ON \`task\` (\`due_date\`, \`id\`) WHERE \`status\` = 'pending' AND \`reminder_sent\` = 0`,
  `CREATE TABLE IF NOT EXISTS \`message\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`user_id\` integer NOT NULL REFERENCES \`user\`(\`id\`) ON DELETE CASCADE,
    \`message_type\` text NOT NULL,
    \`content_encrypted\` text,
    \`ai_response_encrypted\` text,
    \`parsed_tasks\` text,
    \`whatsapp_message_id\` text,
    \`created_at\` integer NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS \`idx_message_whatsapp_id\` ON \`message\` (\`whatsapp_message_id\`)`,
  `CREATE TABLE IF NOT EXISTS \`friend_link\` (
    \`user_id\` integer NOT NULL REFERENCES \`user\`(\`id\`) ON DELETE CASCADE,
    \`friend_user_id\` integer NOT NULL REFERENCES \`user\`(\`id\`) ON DELETE CASCADE,
    \`nickname\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    PRIMARY KEY (\`user_id\`, \`friend_user_id\`)
  )`,
  `CREATE INDEX IF NOT EXISTS \`idx_friend_link_user\` ON \`friend_link\` (\`user_id\`)`,
  `CREATE TABLE IF NOT EXISTS \`task_assignee\` (
    \`task_id\` integer NOT NULL REFERENCES \`task\`(\`id\`) ON DELETE CASCADE,
    \`assignee_user_id\` integer NOT NULL REFERENCES \`user\`(\`id\`) ON DELETE CASCADE,
    PRIMARY KEY (\`task_id\`, \`assignee_user_id\`)
  )`,
  `CREATE INDEX IF NOT EXISTS \`idx_task_assignee_user\` ON \`task_assignee\` (\`assignee_user_id\`)`,
  `CREATE TABLE IF NOT EXISTS \`board\` (
    \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    \`user_id\` integer NOT NULL REFERENCES \`user\`(\`id\`) ON DELETE CASCADE,
    \`name_encrypted\` text NOT NULL,
    \`columns_encrypted\` text NOT NULL,
    \`rows_encrypted\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`board_user_id_unique\` ON \`board\` (\`user_id\`)`,
  `CREATE INDEX IF NOT EXISTS \`idx_board_user\` ON \`board\` (\`user_id\`)`,
];

export async function applySchema(): Promise<void> {
  await env.DB.batch(
    [...SCHEMA_STATEMENTS,
      "CREATE TABLE billing_account (phone_hash TEXT PRIMARY KEY, billing_key TEXT UNIQUE NOT NULL, trial_ends_at INTEGER)",
      "CREATE TABLE billing_subscription (id TEXT PRIMARY KEY, billing_key TEXT NOT NULL REFERENCES billing_account(billing_key), status TEXT NOT NULL, trial_ends_at INTEGER, renews_at INTEGER, ends_at INTEGER, updated_at TEXT NOT NULL, last_checked_at INTEGER NOT NULL DEFAULT 0)"
    ].map((sql) => env.DB.prepare(sql))
  );
  await env.DB.batch(calendarMigration.split("--> statement-breakpoint").map(sql => env.DB.prepare(sql)));
  await env.DB.batch(controlsMigration.split('--> statement-breakpoint').map(sql=>env.DB.prepare(sql)));
  await env.DB.batch(reminderMigration.split('--> statement-breakpoint').map(sql=>env.DB.prepare(sql)));
  await env.DB.batch(projectsMigration.split('--> statement-breakpoint').map(sql=>env.DB.prepare(sql)));
  await env.DB.batch(taskScheduleMigration.split('--> statement-breakpoint').map(sql=>env.DB.prepare(sql)));
  await env.DB.batch(shareMigration.split('--> statement-breakpoint').map(sql=>env.DB.prepare(sql)));
}

export async function clearData(): Promise<void> {
  for (const id of await listDurableObjectIds(env.CONVERSATIONS)) {
    await runInDurableObject(env.CONVERSATIONS.get(id), async (_instance, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec("DELETE FROM inbox");
    });
  }
  for(const id of await listDurableObjectIds(env.REMINDER_SCHEDULERS)) await runInDurableObject(env.REMINDER_SCHEDULERS.get(id),async(_instance,state)=>{await state.storage.deleteAlarm();await state.storage.deleteAll();state.storage.sql.exec('CREATE TABLE IF NOT EXISTS schedule_version (id INTEGER PRIMARY KEY,n INTEGER NOT NULL)');state.storage.sql.exec('INSERT OR IGNORE INTO schedule_version VALUES (1,0)');});
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_share_offer'),
    env.DB.prepare('DELETE FROM task_schedule_pending'),
    env.DB.prepare('DELETE FROM recovery_pending'),
    env.DB.prepare('DELETE FROM task_recovery'),
    env.DB.prepare('DELETE FROM reminder_delivery'),
    env.DB.prepare('DELETE FROM reminder_job'),
    env.DB.prepare('DELETE FROM agenda_priority'),
    env.DB.prepare('DELETE FROM agenda_preferences'),
    env.DB.prepare('DELETE FROM task_control_use'),
    env.DB.prepare('DELETE FROM task_undo_change'),
    env.DB.prepare('DELETE FROM task_undo'),
    env.DB.prepare("DELETE FROM google_calendar_event"),
    env.DB.prepare("DELETE FROM google_calendar_oauth"),
    env.DB.prepare("DELETE FROM google_calendar_connection"),
    env.DB.prepare("DELETE FROM billing_subscription"),
    env.DB.prepare("DELETE FROM billing_account"),
    env.DB.prepare("DELETE FROM task_assignee"),
    env.DB.prepare("DELETE FROM friend_link"),
    env.DB.prepare("DELETE FROM board"),
    env.DB.prepare("DELETE FROM message"),
    env.DB.prepare("DELETE FROM task"),
    env.DB.prepare('DELETE FROM project'),
    env.DB.prepare("DELETE FROM user"),
  ]);
}

export async function createTestUser(phone: string = TEST_PHONE): Promise<number> {
  const hash = await hashPhone(phone);
  const encrypted = await fernetEncrypt(phone, TEST_ENC_KEY);
  const twoMinutesAgo = Math.floor(Date.now() / 1000) - 120;
  await env.DB.prepare(
    "INSERT INTO user (phone_number_encrypted, phone_number_hash, created_at, last_active) VALUES (?, ?, ?, ?)"
  )
    .bind(encrypted, hash, twoMinutesAgo, twoMinutesAgo)
    .run();
  const row = await env.DB.prepare(
    "SELECT id FROM user WHERE phone_number_hash = ?"
  )
    .bind(hash)
    .first<{ id: number }>();
  const billing = await getBillingAccount(env, { phone_number_hash: hash }, true);
  // This fixture represents an existing trial user who already received their pricing notice.
  await env.CACHE.put(`trial_notice:${billing.billing_key}`, "1", { expirationTtl: 7 * 86400 });
  return row!.id;
}

export async function signWebhookBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TEST_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

export async function makeSignedWebhookRequest(
  text: string,
  phone: string = TEST_PHONE
): Promise<Request> {
  const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return makeSignedWebhookRequestFromMessage({
    from: phone,
    id: msgId,
    type: "text",
    text: { body: text },
  });
}

export async function makeSignedWebhookRequestFromMessage(message: Record<string, unknown>): Promise<Request> {
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: { messages: [message] },
          },
        ],
      },
    ],
  });
  const sig = await signWebhookBody(body);
  return new Request("https://worker.example.com/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": sig,
    },
    body,
  });
}

export async function makeSignedWebhookRequestFromBody(body: unknown): Promise<Request> {
  const json = JSON.stringify(body);
  const sig = await signWebhookBody(json);
  return new Request("https://worker.example.com/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": sig,
    },
    body: json,
  });
}

export function makeMockFetch() {
  return (url: string | URL | Request): Promise<Response> => {
    const urlStr = url.toString();
    if (urlStr.includes("graph.facebook.com")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ messages: [{ id: `wa_${Date.now()}` }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
}

export async function drainConversation(phone: string = TEST_PHONE): Promise<void> {
  const stub = env.CONVERSATIONS.getByName(await hashPhone(phone));
  for (let i = 0; i < 300; i++) {
    const states = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ state: string }>("SELECT state FROM inbox WHERE state != 'done'").toArray());
    if (!states.length) return;
    // The manual alarm helper bypasses platform scheduling; never overlap an active alarm.
    if (!states.some(row => row.state === 'started')) await runDurableObjectAlarm(stub);
    // A scheduled alarm may already be running; wait for that invocation instead of racing assertions.
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Conversation did not finish processing");
}

/** Deterministically drive the same durable delivery implementation, without waiting on real Queue latency. */
export async function sendDueRemindersForTest(bindings:Env=env):Promise<void> {
  const rows=await getDueTasksForReminders(buildDb(bindings),bindings.ENCRYPTION_KEY);
  for(let offset=0;offset<rows.length;offset+=10)await Promise.all(rows.slice(offset,offset+10).map(async({task})=>{
    const job=await ensureReminderJob(bindings,task);await deliverReminderJob(bindings,job.id);
  }));
}
