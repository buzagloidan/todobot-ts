import type { Env, ReminderQueueMessage } from "../types.ts";
import type { Task, User } from "../db/schema.ts";
import { buildDb } from "../db/client.ts";
import {
  getTaskById,
  getUserById,
  getTaskAssignees,
  decryptPhone,
  saveMessage,
} from "../db/queries.ts";
import { billingAccessSql, hasAccess } from "./billing.ts";
import {
  sendInteractiveButtons,
  sendTemplateReminder,
  WhatsAppSendError,
  type ReminderSendOptions,
} from "./whatsapp.ts";
import { reminderButtons } from "./task_controls.ts";
import { sendAlert } from "./alert.ts";
import { TZ } from "../constants.ts";
import { nextRecurringOccurrence } from "./recurrence.ts";

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const DISPATCH_BATCH = 100;
const ESCALATE_AFTER = 8;
export type ReminderJob = {
  id: string;
  task_id: number;
  owner_id: number;
  revision: number;
  due_at: number;
  state: string;
  attempt: number;
  next_attempt_at: number;
  lease_until: number;
  nonce: string | null;
  next_task_id: number | null;
  created_at: number;
  accepted_at: number | null;
};
type Delivery = {
  user_id: number;
  state: string;
  whatsapp_id: string | null;
  updated_at: number;
};

export async function ensureReminderJob(
  env: Env,
  task: {
    id: number;
    user_id: number;
    revision: number;
    due_date: Date | null;
  },
): Promise<ReminderJob> {
  if (!task.due_date) throw new Error("Untimed reminder");
  await env.DB.prepare(
    `INSERT OR IGNORE INTO reminder_job (id,task_id,owner_id,revision,due_at,created_at)
    VALUES (?,?,?,?,?,?)`,
  )
    .bind(
      crypto.randomUUID().replaceAll("-", ""),
      task.id,
      task.user_id,
      task.revision,
      Math.floor(+task.due_date / 1000),
      nowSeconds(),
    )
    .run();
  const job = await env.DB.prepare(
    "SELECT * FROM reminder_job WHERE task_id=? AND revision=? AND due_at=?",
  )
    .bind(task.id, task.revision, Math.floor(+task.due_date / 1000))
    .first<ReminderJob>();
  if (!job) throw new Error("Reminder job missing");
  return job;
}

export async function nextReminderAt(
  env: Env,
  ownerId: number,
): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT MIN(CASE
    WHEN r.state IN ('done','stale','failed','uncertain') THEN NULL
    WHEN r.state IN ('queued','sending') THEN MAX(t.due_date,r.lease_until)
    ELSE MAX(t.due_date,COALESCE(r.next_attempt_at,0)) END) AS at
    FROM task t JOIN user u ON u.id=t.user_id LEFT JOIN reminder_job r
      ON r.task_id=t.id AND r.revision=t.revision AND r.due_at=t.due_date
    WHERE t.user_id=?1 AND t.status='pending' AND t.reminder_sent=0 AND t.due_date IS NOT NULL
      AND ${billingAccessSql("u.phone_number_hash", "?2", env.BILLING_ENABLED !== "false")}`,
  )
    .bind(ownerId, nowSeconds())
    .first<{ at: number | null }>();
  return row?.at === null || row?.at === undefined ? null : row.at * 1000;
}

/** One small dispatch page. The alarm immediately continues when more work is due. */
export async function dispatchOwnerReminders(
  env: Env,
  ownerId: number,
  queue: Pick<Queue<ReminderQueueMessage>, "sendBatch"> = env.REMINDER_QUEUE,
): Promise<number> {
  const rows = (
    await env.DB.prepare(
      `SELECT t.id,t.user_id,t.revision,t.due_date FROM task t JOIN user u ON u.id=t.user_id
    LEFT JOIN reminder_job r ON r.task_id=t.id AND r.revision=t.revision AND r.due_at=t.due_date
    WHERE t.user_id=?1 AND t.status='pending' AND t.reminder_sent=0 AND t.due_date<=?2
    AND ${billingAccessSql("u.phone_number_hash", "?2", env.BILLING_ENABLED !== "false")} AND (r.id IS NULL OR
      (r.state IN ('ready','retry','blocked') AND r.next_attempt_at<=?2) OR
      (r.state IN ('queued','sending') AND r.lease_until<=?2))
    ORDER BY t.due_date,t.id LIMIT ${DISPATCH_BATCH}`,
    )
      .bind(ownerId, nowSeconds())
      .all<{
        id: number;
        user_id: number;
        revision: number;
        due_date: number;
      }>()
  ).results;
  const jobs = await Promise.all(
    rows.map((t) =>
      ensureReminderJob(env, { ...t, due_date: new Date(t.due_date * 1000) }),
    ),
  );
  if (!jobs.length) return 0;
  // Persist admission intent before calling Queue. An interrupted/uncertain admission is safely retried.
  await env.DB.batch(
    jobs.map((job) =>
      env.DB.prepare(
        `UPDATE reminder_job SET state='queued',lease_until=?
    WHERE id=? AND (state IN ('ready','retry','blocked') OR (state IN ('queued','sending') AND lease_until<=?))`,
      ).bind(nowSeconds() + 120, job.id, nowSeconds()),
    ),
  );
  try {
    await queue.sendBatch(
      jobs.map((job) => ({
        body: {
          type: "reminder",
          jobId: job.id,
        } satisfies ReminderQueueMessage,
      })),
      { delaySeconds: 0 },
    );
  } catch (err) {
    await env.DB.batch(
      jobs.map((job) =>
        env.DB.prepare(
          "UPDATE reminder_job SET state='ready',lease_until=0,next_attempt_at=? WHERE id=? AND state='queued'",
        ).bind(nowSeconds() + 2, job.id),
      ),
    );
    throw err;
  }
  return jobs.length;
}

async function freshTask(env: Env, job: ReminderJob): Promise<Task | null> {
  const task = await getTaskById(
    buildDb(env),
    env.ENCRYPTION_KEY,
    job.task_id,
    [job.owner_id],
  );
  return task?.status === "pending" &&
    !task.reminder_sent &&
    task.revision === job.revision &&
    task.due_date &&
    Math.floor(+task.due_date / 1000) === job.due_at
    ? task
    : null;
}
async function currentRecipient(
  env: Env,
  taskId: number,
  userId: number,
): Promise<boolean> {
  return !!(await env.DB.prepare(
    `SELECT 1 FROM task t JOIN user u ON u.id=? WHERE t.id=? AND
    (t.user_id=u.id OR t.user_id=u.partner_user_id OR EXISTS(SELECT 1 FROM task_assignee a WHERE a.task_id=t.id AND a.assignee_user_id=u.id))`,
  )
    .bind(userId, taskId)
    .first());
}
async function finalizeReminder(
  env: Env,
  job: ReminderJob,
  task: Task,
): Promise<void> {
  const owner = await env.DB.prepare(
    "SELECT 1 FROM reminder_delivery WHERE job_id=? AND user_id=? AND state='accepted'",
  )
    .bind(job.id, job.owner_id)
    .first();
  if (!owner) return;
  const statements: D1PreparedStatement[] = [];
  const guard = `id=? AND revision=? AND due_date=? AND status='pending' AND reminder_sent=0 AND EXISTS
    (SELECT 1 FROM reminder_job WHERE id=? AND nonce=? AND state='sending')`;
  const args = [task.id, job.revision, job.due_at, job.id, job.nonce];
  const next =
    task.recurrence && task.due_date
      ? nextRecurringOccurrence(task.due_date, task.recurrence)
      : null;
  if (next) {
    // Copy encrypted description and assignments, complete the original, and record the successor atomically.
    statements.push(
      env.DB.prepare(
        `INSERT INTO task (user_id,description,status,due_date,recurrence,created_at,updated_at,project_id)
      SELECT user_id,description,'pending',?,recurrence,?,?,project_id FROM task WHERE ${guard}`,
      ).bind(Math.floor(+next / 1000), nowSeconds(), nowSeconds(), ...args),
    );
    statements.push(
      env.DB.prepare(
        "UPDATE reminder_job SET next_task_id=last_insert_rowid() WHERE id=? AND nonce=? AND changes()>0",
      ).bind(job.id, job.nonce),
    );
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO task_assignee(task_id,assignee_user_id)
      SELECT r.next_task_id,a.assignee_user_id FROM reminder_job r JOIN task_assignee a ON a.task_id=r.task_id
      WHERE r.id=? AND r.nonce=? AND r.next_task_id IS NOT NULL`,
      ).bind(job.id, job.nonce),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE task SET reminder_sent=1,updated_at=?${next ? ",status='completed',completed_at=?,revision=revision+1" : ""} WHERE ${guard}`,
    ).bind(nowSeconds(), ...(next ? [nowSeconds()] : []), ...args),
  );
  statements.push(
    env.DB.prepare(
      "UPDATE reminder_job SET state='done',lease_until=0,accepted_at=COALESCE(accepted_at,?) WHERE id=? AND nonce=? AND state='sending'",
    ).bind(nowSeconds(), job.id, job.nonce),
  );
  await env.DB.batch(statements);
  console.log(
    JSON.stringify({
      event: "reminder_accepted",
      task_id: job.task_id,
      job_id: job.id,
      lateness_ms: Math.max(0, Date.now() - job.due_at * 1000),
      attempt: job.attempt,
    }),
  );
}
async function sendReminder(
  env: Env,
  job: ReminderJob,
  task: Task,
  user: User,
): Promise<string | null> {
  const phone = await decryptPhone(user, env.ENCRYPTION_KEY);
  if (!phone) throw new WhatsAppSendError(400, 131009, 0);
  const due = task.due_date!.toLocaleString("he-IL", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const description = task.description.replace(/\s+/g, " ").slice(0, 900);
  const text = `🔔 תזכורת!\n\n📋 ${description}\n\n⏰ ${due}`;
  const options: ReminderSendOptions = {
    queuedReminder: true,
    callbackData: `r:${job.id}:${user.id}`,
  };
  if (env.REMINDER_ACTIONS_TEMPLATE_NAME) {
    try {
      return await sendTemplateReminder(
        env,
        phone,
        env.REMINDER_ACTIONS_TEMPLATE_NAME,
        description,
        due,
        await reminderButtons(env, user.id, task),
        options,
      );
    } catch (err) {
      if (!(err instanceof WhatsAppSendError) || err.retryable) throw err;
    }
  }
  if (Date.now() - user.last_active.getTime() < 23 * 3600000) {
    try {
      return await sendInteractiveButtons(
        env,
        phone,
        text,
        await reminderButtons(env, user.id, task),
        options,
      );
    } catch (err) {
      if (!(err instanceof WhatsAppSendError) || err.retryable) throw err;
    }
  }
  if (!env.REMINDER_TEMPLATE_NAME) throw new WhatsAppSendError(400, null, 0);
  return sendTemplateReminder(
    env,
    phone,
    env.REMINDER_TEMPLATE_NAME,
    description,
    due,
    [],
    options,
  );
}

/** Return a retry delay only for safe retries; accepted/uncertain sends are never blindly repeated. */
export async function deliverReminderJob(
  env: Env,
  id: string,
): Promise<number | null> {
  let job = await env.DB.prepare("SELECT * FROM reminder_job WHERE id=?")
    .bind(id)
    .first<ReminderJob>();
  if (!job || ["done", "stale", "failed", "uncertain"].includes(job.state))
    return null;
  if (job.state === "sending" && job.lease_until > nowSeconds())
    return Math.max(1, job.lease_until - nowSeconds());
  if (job.next_attempt_at > nowSeconds())
    return job.next_attempt_at - nowSeconds();
  let task = await freshTask(env, job);
  const user = await getUserById(buildDb(env), job.owner_id);
  if (!task || !user) {
    await env.DB.prepare(
      "UPDATE reminder_job SET state='stale',lease_until=0 WHERE id=?",
    )
      .bind(id)
      .run();
    return null;
  }
  if (job.due_at > nowSeconds()) return job.due_at - nowSeconds();
  if (!(await hasAccess(env, user))) {
    await env.DB.prepare(
      "UPDATE reminder_job SET state='blocked',lease_until=0,next_attempt_at=0 WHERE id=?",
    )
      .bind(id)
      .run();
    return null;
  }
  const nonce = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE reminder_job SET state='sending',nonce=?,lease_until=?,attempt=attempt+1 WHERE id=?
    AND (state IN ('ready','queued','retry','blocked') OR (state='sending' AND lease_until<=?))`,
  )
    .bind(nonce, nowSeconds() + 120, id, nowSeconds())
    .run();
  if (!claim.meta.changes) return 5;
  job = { ...job, nonce, attempt: job.attempt + 1 };
  const partner = user.partner_user_id
    ? await getUserById(buildDb(env), user.partner_user_id)
    : null;
  const recipients = [
    user,
    partner,
    ...(await getTaskAssignees(buildDb(env), task.id)),
  ].filter((u): u is User => !!u);
  const unique = [...new Map(recipients.map((u) => [u.id, u])).values()];
  await env.DB.batch(
    unique.map((u) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO reminder_delivery (job_id,user_id,updated_at) VALUES (?,?,?)",
      ).bind(id, u.id, nowSeconds()),
    ),
  );
  let delay = 0;
  for (const recipient of unique) {
    const delivery = await env.DB.prepare(
      "SELECT * FROM reminder_delivery WHERE job_id=? AND user_id=?",
    )
      .bind(id, recipient.id)
      .first<Delivery>();
    if (
      !delivery ||
      ["accepted", "failed", "uncertain", "skipped"].includes(delivery.state)
    )
      continue;
    if (delivery.state === "sending") {
      await env.DB.prepare(
        "UPDATE reminder_delivery SET state='uncertain',updated_at=? WHERE job_id=? AND user_id=? AND state='sending'",
      )
        .bind(nowSeconds(), id, recipient.id)
        .run();
      continue;
    }
    await env.DB.prepare(
      "UPDATE reminder_job SET lease_until=? WHERE id=? AND nonce=? AND state='sending'",
    )
      .bind(nowSeconds() + 120, id, nonce)
      .run();
    task = await freshTask(env, job);
    if (!task) {
      await env.DB.prepare(
        "UPDATE reminder_job SET state='stale',lease_until=0 WHERE id=? AND nonce=?",
      )
        .bind(id, nonce)
        .run();
      return null;
    }
    if (
      !(await currentRecipient(env, task.id, recipient.id)) ||
      !(await hasAccess(env, recipient))
    ) {
      await env.DB.prepare(
        "UPDATE reminder_delivery SET state='skipped',updated_at=? WHERE job_id=? AND user_id=?",
      )
        .bind(nowSeconds(), id, recipient.id)
        .run();
      continue;
    }
    const begun = await env.DB.prepare(
      "UPDATE reminder_delivery SET state='sending',updated_at=? WHERE job_id=? AND user_id=? AND state IN ('pending','retry')",
    )
      .bind(nowSeconds(), id, recipient.id)
      .run();
    if (!begun.meta.changes) continue;
    try {
      const msgId = await sendReminder(env, job, task, recipient);
      if (!msgId) throw new Error("No provider message id");
      await env.DB.prepare(
        "UPDATE reminder_delivery SET state='accepted',whatsapp_id=COALESCE(whatsapp_id,?),updated_at=? WHERE job_id=? AND user_id=?",
      )
        .bind(msgId, nowSeconds(), id, recipient.id)
        .run();
      await saveMessage(buildDb(env), env.ENCRYPTION_KEY, {
        userId: recipient.id,
        messageType: "reminder",
        content: null,
        aiResponse: `🔔 ${task.description}`,
        parsedTasks: {
          tasks: [{ task_id: task.id, description: task.description }],
        },
        whatsappMessageId: msgId,
      }).catch(() => {});
    } catch (err) {
      if (err instanceof WhatsAppSendError) {
        const retry = err.retryable;
        if (retry)
          delay = Math.max(
            delay,
            err.retryAfter,
            Math.min(300, 5 * 2 ** Math.min(job.attempt - 1, 6)) +
              (crypto.getRandomValues(new Uint8Array(1))[0] % 15),
          );
        await env.DB.prepare(
          "UPDATE reminder_delivery SET state=?,error_code=?,updated_at=? WHERE job_id=? AND user_id=?",
        )
          .bind(
            retry ? "retry" : "failed",
            err.code,
            nowSeconds(),
            id,
            recipient.id,
          )
          .run();
      } else {
        // The request may have reached Meta. Wait for its signed status callback instead of risking a duplicate.
        await env.DB.prepare(
          "UPDATE reminder_delivery SET state='uncertain',updated_at=? WHERE job_id=? AND user_id=? AND state='sending'",
        )
          .bind(nowSeconds(), id, recipient.id)
          .run();
      }
    }
  }
  const deliveries = (
    await env.DB.prepare("SELECT * FROM reminder_delivery WHERE job_id=?")
      .bind(id)
      .all<Delivery>()
  ).results;
  if (deliveries.some((d) => d.state === "retry")) {
    delay = Math.max(1, delay);
    await env.DB.prepare(
      "UPDATE reminder_job SET state='retry',lease_until=0,next_attempt_at=? WHERE id=? AND nonce=?",
    )
      .bind(nowSeconds() + delay, id, nonce)
      .run();
    if (job.attempt >= ESCALATE_AFTER)
      await sendAlert(
        env,
        "reminder_retry_backlog",
        `task ${job.task_id}: repeated provider failures; retrying safely`,
      ).catch(() => {});
    return delay;
  }
  if (deliveries.some((d) => ["uncertain", "sending"].includes(d.state))) {
    await env.DB.prepare(
      "UPDATE reminder_job SET state='uncertain',lease_until=0 WHERE id=? AND nonce=?",
    )
      .bind(id, nonce)
      .run();
    await sendAlert(
      env,
      "reminder_uncertain",
      `task ${job.task_id}: awaiting provider delivery status`,
    ).catch(() => {});
    return null;
  }
  const accepted =
    deliveries.find((d) => d.user_id === job!.owner_id)?.state === "accepted";
  if (accepted && task) await finalizeReminder(env, job, task);
  else {
    await env.DB.prepare(
      "UPDATE reminder_job SET state='failed',lease_until=0 WHERE id=? AND nonce=?",
    )
      .bind(id, nonce)
      .run();
    await sendAlert(
      env,
      "reminder_failed",
      `task ${job.task_id}: provider rejected owner delivery`,
    ).catch(() => {});
  }
  if (env.REMINDER_SCHEDULER_ENABLED === "true")
    await env.REMINDER_SCHEDULERS.getByName(`owner:${job.owner_id}`).refresh(
      job.owner_id,
    );
  return null;
}

export async function handleReminderStatus(
  env: Env,
  status: Record<string, unknown>,
): Promise<void> {
  const data = status.biz_opaque_callback_data;
  if (
    typeof data !== "string" ||
    typeof status.id !== "string" ||
    typeof status.status !== "string"
  )
    return;
  const match = data.match(/^r:([a-f0-9]{32}):(\d+)$/);
  if (
    !match ||
    !["sent", "delivered", "read", "failed"].includes(status.status)
  )
    return;
  const row = await env.DB.prepare(
    "SELECT * FROM reminder_delivery WHERE job_id=? AND user_id=?",
  )
    .bind(match[1], Number(match[2]))
    .first<Delivery>();
  if (!row || (row.whatsapp_id && row.whatsapp_id !== status.id)) return;
  const accepted = status.status !== "failed";
  // Retain numeric diagnostics only: provider descriptions can contain phone or task data.
  const errorCodes =
    !accepted && Array.isArray(status.errors)
      ? status.errors.slice(0, 5).flatMap((error: unknown) => {
          if (!error || typeof error !== "object") return [];
          const code = (error as Record<string, unknown>).code;
          return typeof code === "number" && Number.isSafeInteger(code) && code > 0
            ? [code]
            : [];
        })
      : [];
  await env.DB.prepare(
    `UPDATE reminder_delivery SET state=CASE WHEN ? THEN 'accepted' WHEN state IN ('sending','uncertain') THEN 'failed' ELSE state END,
    whatsapp_id=COALESCE(whatsapp_id,?),delivery_status=CASE WHEN delivery_status='read' OR (delivery_status='delivered' AND ?='sent') THEN delivery_status ELSE ? END,
    error_code=COALESCE(?,error_code),updated_at=? WHERE job_id=? AND user_id=?`,
  )
    .bind(
      accepted ? 1 : 0,
      status.id,
      status.status,
      status.status,
      errorCodes[0] ?? null,
      nowSeconds(),
      match[1],
      Number(match[2]),
    )
    .run();
  const resumed = await env.DB.prepare(
    "UPDATE reminder_job SET state='retry',next_attempt_at=0,lease_until=0 WHERE id=? AND state='uncertain'",
  )
    .bind(match[1])
    .run();
  if (resumed.meta.changes)
    await env.REMINDER_QUEUE.send(
      { type: "reminder", jobId: match[1] },
      { delaySeconds: 0 },
    );
  if (status.status === "failed") {
    console.error(
      JSON.stringify({
        event: "reminder_delivery_failed",
        job_id: match[1],
        user_id: Number(match[2]),
        error_codes: errorCodes,
      }),
    );
    await sendAlert(
      env,
      "reminder_delivery_failed",
      `job ${match[1]}, recipient ${match[2]}: Meta reported delivery failure; error codes: ${errorCodes.join(", ") || "not supplied"}`,
    ).catch(() => {});
  }
}
