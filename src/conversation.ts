import { DurableObject } from "cloudflare:workers";
import type { Env, QueueMessage } from "./types.ts";
import { fernetDecrypt, fernetEncrypt } from "./crypto/fernet.ts";
import { hashPhone } from "./crypto/hash.ts";
import { processWebhookMessage } from "./routes/webhook.ts";
import { dispatchQueueMessage } from "./queue/consumer.ts";
import { syncGoogleCalendar, connectGoogleCalendar, type GoogleTokens } from "./services/google_calendar.ts";
import { sendMessage } from "./services/whatsapp.ts";
import { refreshRemindersForPhone } from "./reminder_scheduler.ts";
import { getUserById, decryptPhone } from "./db/queries.ts";
import { buildDb } from "./db/client.ts";
import { capture } from "./services/posthog.ts";
import { deliverAgenda } from './services/agenda.ts';

type ConversationJob =
  | { kind: "webhook"; message: Record<string, unknown> }
  | { kind: "queue"; message: QueueMessage }
  | { kind: "calendar"; userId: number; connectionId: string; id: string }
  | { kind: "calendar_connect"; userId: number; tokens: GoogleTokens; id: string };
// The same inbox orders agenda delivery with settings changes and task actions.
type AgendaJob = { kind:'agenda';userId:number;date:string;revision:number;id:string };
type InboxRow = { seq: number; payload: string | null; state: string; created_at: number };
const RETENTION_MS = 7 * 86400_000;

export async function enqueueConversation(env: Env, job: ConversationJob): Promise<void> {
  const phone = job.kind === "webhook" ? job.message.from : job.kind === "queue" ? job.message.phone : undefined;
  if (typeof phone !== "string" || !phone) return;
  await env.CONVERSATIONS.getByName(await hashPhone(phone)).enqueue(job);
}

/** One persistent inbox per phone. Only the alarm executes jobs, in admission order. */
export class Conversation extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS inbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE NOT NULL,
      payload TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    )`);
  }

  async enqueue(job: ConversationJob | AgendaJob): Promise<void> {
    const messageId = job.kind === "webhook" ? job.message.id : job.kind === "queue" ? job.message.incomingMsgId : job.id;
    // Reserve the sequence before encryption yields, so simultaneous admissions cannot overtake.
    const id = typeof messageId === "string" && messageId ? messageId : crypto.randomUUID();
    const reserved = this.ctx.storage.sql.exec<InboxRow>(
      "INSERT OR IGNORE INTO inbox (message_id, created_at) VALUES (?, ?) RETURNING seq, payload, state, created_at",
      id, Date.now()
    ).toArray()[0];
    const row = reserved ?? this.ctx.storage.sql.exec<InboxRow>(
      "SELECT seq, payload, state, created_at FROM inbox WHERE message_id = ?", id
    ).one();
    if (row.state === "done") return;
    if (row.payload === null && row.state === "pending") {
      // A provider retry can repair admission interrupted between reservation and encryption.
      const encrypted = await fernetEncrypt(JSON.stringify(job), this.env.ENCRYPTION_KEY);
      this.ctx.storage.sql.exec("UPDATE inbox SET payload = ? WHERE seq = ? AND state = 'pending' AND payload IS NULL", encrypted, row.seq);
    }
    // Also repairs an alarm not scheduled before a previous admission crashed.
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM inbox WHERE state = 'done' AND finished_at <= ?", Date.now() - RETENTION_MS);
    for (let count = 0; count < 10; count++) {
      const row = this.ctx.storage.sql.exec<InboxRow>(
        "SELECT seq, payload, state, created_at FROM inbox WHERE state != 'done' ORDER BY seq LIMIT 1"
      ).toArray()[0];
      if (!row) break;
      if (!row.payload) {
        // An admission may still be encrypting. A crashed admission must not block the inbox forever.
        if (Date.now() - row.created_at < 120_000) {
          await this.ctx.storage.setAlarm(Date.now() + 250);
          return;
        }
        this.ctx.storage.sql.exec("DELETE FROM inbox WHERE seq = ?", row.seq);
        continue;
      }
      let job: ConversationJob | AgendaJob | undefined;
      try {
        job = JSON.parse(await fernetDecrypt(row.payload, this.env.ENCRYPTION_KEY));
        if (!job) throw new Error("Empty conversation job");
        if (row.state === "started") {
          // Alarm delivery is at-least-once. Never repeat an action whose earlier outcome is unknown.
          this.finish(row.seq);
          await this.reportFailure(job);
          continue;
        }
        this.ctx.storage.sql.exec("UPDATE inbox SET state = 'started' WHERE seq = ?", row.seq);
        await this.ctx.storage.sync();
        if (job.kind === "webhook") {
          await processWebhookMessage(job.message, this.env, this.ctx.waitUntil.bind(this.ctx));
        } else if (job.kind === "queue") {
          await dispatchQueueMessage(job.message, this.env,this.ctx.waitUntil.bind(this.ctx));
        } else if (job.kind === "calendar") {
          await syncGoogleCalendar(this.env, job.userId, job.connectionId);
        } else if(job.kind === 'agenda') {
          await deliverAgenda(this.env,job.userId,job.date,job.revision);
        } else {
          await connectGoogleCalendar(this.env, job.userId, job.tokens);
          this.ctx.waitUntil(capture(this.env,`user_${job.userId}`,'calendar_connected',{calendar_type:'todobot'}));
        }
        this.finish(row.seq);
      } catch (err) {
        // A failure can happen after a database change. Do not replay the entire message.
        this.finish(row.seq);
        console.error("[CONVERSATION] Message processing failed", err instanceof Error ? err.name : "unknown");
        if (job) await this.reportFailure(job);
      } finally {
        if(job && this.env.REMINDER_SCHEDULER_ENABLED === 'true') {
          try {
            const phone=job.kind === 'webhook' ? job.message.from : job.kind === 'queue' ? job.message.phone : await (async()=>{
              const user=await getUserById(buildDb(this.env),job.userId);return user?decryptPhone(user,this.env.ENCRYPTION_KEY):null;
            })();
            if(typeof phone==='string')await refreshRemindersForPhone(this.env,phone);
          } catch { console.error('[CONVERSATION] Reminder timer refresh failed; recovery scan will repair it'); }
        }
      }
    }
    const remaining = this.ctx.storage.sql.exec("SELECT seq FROM inbox WHERE state != 'done' LIMIT 1").toArray();
    if (remaining.length) {
      await this.ctx.storage.setAlarm(Date.now() + 1);
    } else {
      const oldest = this.ctx.storage.sql.exec<{ oldest: number | null }>("SELECT MIN(finished_at) AS oldest FROM inbox").one().oldest;
      if (oldest === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, oldest + RETENTION_MS + 1));
    }
  }

  private finish(seq: number): void {
    // Remove all encrypted content immediately after processing; keep only short-lived dedup metadata.
    this.ctx.storage.sql.exec("UPDATE inbox SET state = 'done', payload = NULL, finished_at = ? WHERE seq = ?", Date.now(), seq);
  }

  private async reportFailure(job: ConversationJob | AgendaJob): Promise<void> {
    const phone = job.kind === "webhook" ? job.message.from : job.kind === "queue" ? job.message.phone : undefined;
    if (typeof phone === "string") {
      await sendMessage(this.env, phone, "לא הצלחתי לסיים את הטיפול בהודעה. כדאי לבדוק את רשימת המשימות (?) לפני שליחה חוזרת.").catch(() => {});
    }
  }
}
