import type { Env } from "../types.ts";
import { fernetDecrypt, fernetEncrypt } from "../crypto/fernet.ts";

export type UndoContext = {
  actorId: number;
  groupId: string;
  expectedRevision?: number;
  changedTaskIds?: number[];
};
export type TaskSnapshot = {
  id: number;
  user_id: number;
  description: string;
  status: string;
  due_date: number | null;
  recurrence: string | null;
  reminder_sent: number | null;
  completed_at: number | null;
  revision: number;
  project_id?: number | null;
};
export type TaskPatch = Partial<
  Pick<
    TaskSnapshot,
    | "description"
    | "status"
    | "due_date"
    | "recurrence"
    | "reminder_sent"
    | "completed_at"
    | "project_id"
  >
>;
const seconds = () => Math.floor(Date.now() / 1000);
export const newUndoContext = (actorId: number): UndoContext => ({
  actorId,
  groupId: crypto.randomUUID().replaceAll("-", ""),
  changedTaskIds: [],
});
// Recheck current sharing/assignment permissions inside each atomic database batch.
export const taskPermissionSql = (
  alias = "task",
) => `EXISTS (SELECT 1 FROM user actor WHERE actor.id = ? AND
  (${alias}.user_id = actor.id OR ${alias}.user_id = actor.partner_user_id OR EXISTS
   (SELECT 1 FROM task_assignee a WHERE a.task_id = ${alias}.id AND a.assignee_user_id = actor.id)))`;

export async function trackedTaskMutation(
  db: D1Database,
  key: string,
  context: UndoContext,
  taskId: number,
  patch: TaskPatch,
): Promise<boolean> {
  const before = await db
    .prepare(
      `SELECT * FROM task WHERE id = ? AND status = 'pending' AND ${taskPermissionSql()}`,
    )
    .bind(taskId, context.actorId)
    .first<TaskSnapshot>();
  if (!before) return false;
  if (
    context.expectedRevision !== undefined &&
    before.revision !== context.expectedRevision
  )
    return false;
  const afterRevision = before.revision + 1;
  const encrypted = await fernetEncrypt(JSON.stringify(before), key);
  const entries = Object.entries(patch);
  const condition = `id = ? AND revision = ? AND status = 'pending' AND ${taskPermissionSql()}`;
  const results = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO task_undo (id, actor_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .bind(context.groupId, context.actorId, seconds(), seconds() + 600),
    db
      .prepare(
        `INSERT INTO task_undo_change (group_id, task_id, before_encrypted, after_revision)
      SELECT ?, id, ?, ? FROM task WHERE ${condition}
      ON CONFLICT(group_id, task_id) DO UPDATE SET after_revision = excluded.after_revision`,
      )
      .bind(
        context.groupId,
        encrypted,
        afterRevision,
        taskId,
        before.revision,
        context.actorId,
      ),
    db
      .prepare(
        `UPDATE task SET ${entries.map(([field]) => `${field} = ?`).join(", ")}, updated_at = ?, revision = ? WHERE ${condition}`,
      )
      .bind(
        ...entries.map(([, value]) => value),
        seconds(),
        afterRevision,
        taskId,
        before.revision,
        context.actorId,
      ),
  ]);
  if (results[2].meta.changes > 0 && !context.changedTaskIds?.includes(taskId))
    context.changedTaskIds?.push(taskId);
  return results[2].meta.changes > 0;
}

/** Bulk completion keeps D1 round trips bounded while recording each successfully changed revision. */
export async function trackedCompleteAll(
  db: D1Database,
  key: string,
  context: UndoContext,
  userIds: number[],
): Promise<number> {
  if (!userIds.length) return 0;
  const rows = (
    await db
      .prepare(
        `SELECT * FROM task WHERE user_id IN (${userIds.map(() => "?").join(",")})
    AND status='pending' AND ${taskPermissionSql()}`,
      )
      .bind(...userIds, context.actorId)
      .all<TaskSnapshot>()
  ).results;
  let count = 0;
  for (let offset = 0; offset < rows.length; offset += 40) {
    const snapshots = await Promise.all(
      rows
        .slice(offset, offset + 40)
        .map(async (task) => ({
          task,
          encrypted: await fernetEncrypt(JSON.stringify(task), key),
        })),
    );
    const statements = [
      db
        .prepare(
          "INSERT OR IGNORE INTO task_undo (id, actor_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .bind(context.groupId, context.actorId, seconds(), seconds() + 600),
    ];
    for (const { task, encrypted } of snapshots) {
      const condition = `id=? AND revision=? AND status='pending' AND ${taskPermissionSql()}`;
      statements.push(
        db
          .prepare(
            `INSERT INTO task_undo_change (group_id,task_id,before_encrypted,after_revision)
        SELECT ?,id,?,revision+1 FROM task WHERE ${condition}
        ON CONFLICT(group_id,task_id) DO UPDATE SET after_revision=excluded.after_revision`,
          )
          .bind(
            context.groupId,
            encrypted,
            task.id,
            task.revision,
            context.actorId,
          ),
      );
      statements.push(
        db
          .prepare(
            `UPDATE task SET status='completed',completed_at=?,updated_at=?,revision=revision+1 WHERE ${condition}`,
          )
          .bind(seconds(), seconds(), task.id, task.revision, context.actorId),
      );
    }
    const results = await db.batch(statements);
    for (let i = 0; i < snapshots.length; i++)
      if (results[i * 2 + 2].meta.changes) {
        count++;
        const id = snapshots[i].task.id;
        if (!context.changedTaskIds?.includes(id))
          context.changedTaskIds?.push(id);
      }
  }
  return count;
}

export async function availableUndo(
  env: Env,
  actorId: number,
  groupId?: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT u.id FROM task_undo u WHERE u.actor_user_id = ? AND u.expires_at > ?
    AND u.claim_nonce IS NULL ${groupId ? "AND u.id = ?" : ""}
    AND EXISTS (SELECT 1 FROM task_undo_change c WHERE c.group_id = u.id)
    ORDER BY u.created_at DESC, u.rowid DESC LIMIT 1`,
  )
    .bind(actorId, seconds(), ...(groupId ? [groupId] : []))
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function undoTasks(
  env: Env,
  actorId: number,
  groupId?: string,
): Promise<string> {
  const id = await availableUndo(env, actorId, groupId);
  if (!id) return "אין פעולה שניתן לבטל כרגע. ביטול זמין ל־10 דקות.";
  const changes = (
    await env.DB.prepare(
      "SELECT * FROM task_undo_change WHERE group_id = ? LIMIT 501",
    )
      .bind(id)
      .all<{
        task_id: number;
        before_encrypted: string | null;
        after_revision: number;
      }>()
  ).results;
  if (changes.length > 500)
    return "הפעולה כוללת יותר מדי משימות לביטול אוטומטי. אפשר לעדכן אותן לפי שם.";
  const restored = await Promise.all(
    changes.map(async (change) => ({
      ...change,
      before: change.before_encrypted
        ? (JSON.parse(
            await fernetDecrypt(change.before_encrypted, env.ENCRYPTION_KEY),
          ) as TaskSnapshot)
        : null,
    })),
  );
  const nonce = crypto.randomUUID();
  // Claim succeeds only if EVERY affected task is unchanged and still accessible. Batch is atomic.
  const statements = [
    env.DB.prepare(
      `UPDATE task_undo SET claim_nonce = ? WHERE id = ? AND actor_user_id = ?
    AND claim_nonce IS NULL AND expires_at > ? AND NOT EXISTS
    (SELECT 1 FROM task_undo_change c LEFT JOIN task t ON t.id = c.task_id WHERE c.group_id = task_undo.id
      AND (t.id IS NULL OR t.revision != c.after_revision OR NOT ${taskPermissionSql("t")}))`,
    ).bind(nonce, id, actorId, seconds(), actorId),
  ];
  for (const change of restored) {
    const patch: TaskPatch = change.before
      ? {
          description: change.before.description,
          status: change.before.status,
          due_date: change.before.due_date,
          recurrence: change.before.recurrence,
          reminder_sent: change.before.reminder_sent,
          completed_at: change.before.completed_at,
          ...(change.before.project_id !== undefined ? {project_id:change.before.project_id} : {}),
        }
      : { status: "cancelled", recurrence: null, completed_at: seconds() };
    const entries = Object.entries(patch);
    statements.push(
      env.DB.prepare(
        `UPDATE task SET ${entries.map(([field]) => `${field} = ?`).join(", ")},
      updated_at = ?, revision = revision + 1 WHERE id = ? AND EXISTS
      (SELECT 1 FROM task_undo WHERE id = ? AND claim_nonce = ?)`,
      ).bind(
        ...entries.map(([, value]) => value),
        seconds(),
        change.task_id,
        id,
        nonce,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `DELETE FROM task_undo_change WHERE group_id = ? AND EXISTS
    (SELECT 1 FROM task_undo WHERE id = ? AND claim_nonce = ?)`,
    ).bind(id, id, nonce),
  );
  const results = await env.DB.batch(statements);
  if (!results[0].meta.changes)
    return "לא בוצע ביטול: אחת המשימות השתנתה מאז, או שהגישה אליה הוסרה. שלח ? לבדיקת המצב.";
  return `↩️ הפעולה בוטלה${changes.length > 1 ? ` (${changes.length} משימות)` : ""}. המשימות חזרו למצבן הקודם.`;
}
