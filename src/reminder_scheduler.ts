import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.ts";
import { hashPhone } from "./crypto/hash.ts";
import { billingAccessSql } from "./services/billing.ts";
import {
  dispatchOwnerReminders,
  nextReminderAt,
  nowSeconds,
} from "./services/reminder_dispatch.ts";

/** Per-owner timers are independent of conversation processing and every other user's reminders. */
export class ReminderScheduler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS schedule_version (id INTEGER PRIMARY KEY,n INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO schedule_version VALUES (1,0)",
    );
  }
  async refresh(ownerId: number): Promise<void> {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1)
      throw new Error("Invalid reminder owner");
    const version = this.ctx.storage.sql
      .exec<{
        n: number;
      }>("UPDATE schedule_version SET n=n+1 WHERE id=1 RETURNING n")
      .one().n;
    await this.ctx.storage.put("owner", ownerId);
    const next = await nextReminderAt(this.env, ownerId);
    if (
      this.ctx.storage.sql
        .exec<{ n: number }>("SELECT n FROM schedule_version WHERE id=1")
        .one().n !== version
    )
      return;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
  }
  async reconcile(): Promise<void> {
    await this.ctx.storage.put("recovery", true);
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + 1);
  }
  async alarm(): Promise<void> {
    try {
      if (await this.ctx.storage.get<boolean>("recovery")) {
        await this.recoverPage();
        return;
      }
      const owner = await this.ctx.storage.get<number>("owner");
      if (!owner) return;
      await dispatchOwnerReminders(this.env, owner);
      await this.refresh(owner);
    } catch {
      // Keep recovery alive through D1/Queue outages; platform retry exhaustion must not lose timers.
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      console.error(JSON.stringify({ event: "reminder_scheduler_retry" }));
    }
  }
  private async recoverPage(): Promise<void> {
    const cursor = (await this.ctx.storage.get<number>("cursor")) ?? 0;
    const rows = (
      await this.env.DB.prepare(
        `SELECT DISTINCT t.user_id FROM task t INDEXED BY idx_task_pending_unsent_due
      JOIN user u ON u.id=t.user_id WHERE t.status='pending' AND t.reminder_sent=0 AND t.due_date<=?1
      AND t.user_id>?2 AND ${billingAccessSql("u.phone_number_hash", "?3", this.env.BILLING_ENABLED !== "false")} ORDER BY t.user_id LIMIT 200`,
      )
        .bind(nowSeconds() + 120, cursor, nowSeconds())
        .all<{ user_id: number }>()
    ).results;
    // Bound RPC fan-out, rather than total work per minute. More pages continue on the next immediate alarm.
    for (let offset = 0; offset < rows.length; offset += 20) {
      const results = await Promise.allSettled(
        rows
          .slice(offset, offset + 20)
          .map((r) =>
            this.env.REMINDER_SCHEDULERS.getByName(
              `owner:${r.user_id}`,
            ).refresh(r.user_id),
          ),
      );
      if (results.some((r) => r.status === "rejected"))
        throw new Error("Reminder recovery fan-out failed");
    }
    if (rows.length === 200) {
      await this.ctx.storage.put("cursor", rows.at(-1)!.user_id);
      await this.ctx.storage.setAlarm(Date.now() + 1);
    } else {
      await this.ctx.storage.delete("cursor");
      await this.ctx.storage.deleteAlarm();
    }
    // Callback uncertainty never triggers resend. Surface it and stuck work using aggregate metrics only.
    if (!cursor) {
      await this.env.DB.prepare(
        "DELETE FROM reminder_job WHERE state IN ('done','stale') AND created_at<?",
      )
        .bind(nowSeconds() - 30 * 86400)
        .run();
      const stats = await this.env.DB.prepare(
        `SELECT COUNT(*) AS uncertain FROM reminder_job WHERE state='uncertain'`,
      ).first<{ uncertain: number }>();
      console.log(
        JSON.stringify({
          event: "reminder_recovery",
          armed: rows.length,
          uncertain: stats?.uncertain ?? 0,
        }),
      );
    }
  }
}
export async function recoverReminderSchedules(env: Env): Promise<void> {
  if (env.REMINDER_SCHEDULER_ENABLED === "true")
    await env.REMINDER_SCHEDULERS.getByName("recovery").reconcile();
}
export async function refreshRemindersForPhone(
  env: Env,
  phone: string,
): Promise<void> {
  if (env.REMINDER_SCHEDULER_ENABLED !== "true") return;
  const hash = await hashPhone(phone);
  const user = await env.DB.prepare(
    "SELECT id,partner_user_id FROM user WHERE phone_number_hash=?",
  )
    .bind(hash)
    .first<{ id: number; partner_user_id: number | null }>();
  if (!user) return;
  const rows = (
    await env.DB.prepare(
      `SELECT DISTINCT t.user_id FROM task t WHERE t.user_id=? OR t.user_id=? OR EXISTS
    (SELECT 1 FROM task_assignee a WHERE a.task_id=t.id AND a.assignee_user_id=?)`,
    )
      .bind(user.id, user.partner_user_id, user.id)
      .all<{ user_id: number }>()
  ).results;
  const ids = new Set([user.id, ...rows.map((r) => r.user_id)]);
  await Promise.all(
    [...ids].map((id) =>
      env.REMINDER_SCHEDULERS.getByName(`owner:${id}`).refresh(id),
    ),
  );
}
