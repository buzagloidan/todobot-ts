import { nextRecurringOccurrence,normalizeRecurrence } from "../services/recurrence.ts";
import { eq, and, lte, isNull, or, desc, sql, count, inArray, gte } from "drizzle-orm";
import { TZ } from "../constants.ts";
import type { Db } from "./client.ts";
import { trackedTaskMutation, trackedCompleteAll, type UndoContext, type TaskPatch } from '../services/task_undo.ts';
import { billingAccessSql } from '../services/billing.ts';
import {
  users, messages, tasks, friendLinks, taskAssignees,
  type User, type Task, type NewMessage, type NewTask,
} from "./schema.ts";
import { fernetEncrypt, fernetDecrypt } from "../crypto/fernet.ts";
import { hashPhone } from "../crypto/hash.ts";

async function encryptParsedTasks(parsedTasks: object | null, encKey: string): Promise<string | null> {
  if (!parsedTasks) return null;
  return fernetEncrypt(JSON.stringify(parsedTasks), encKey);
}

async function decryptParsedTasks(value: string | null, encKey: string): Promise<any | null> {
  if (!value) return null;

  try {
    return JSON.parse(await fernetDecrypt(value, encKey));
  } catch {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
}

// ── User helpers ──────────────────────────────────────────────────────────────

export async function getOrCreateUser(db: Db, phone: string, encKey: string): Promise<User> {
  const hash = await hashPhone(phone);
  const existing = await db.query.users.findFirst({
    where: eq(users.phone_number_hash, hash),
  });
  if (existing) {
    // Fire-and-forget — last_active doesn't block the critical path
    db.update(users).set({ last_active: new Date() }).where(eq(users.id, existing.id)).catch(() => {});
    return existing;
  }
  const encrypted = await fernetEncrypt(phone, encKey);
  const [created] = await db
    .insert(users)
    .values({ phone_number_encrypted: encrypted, phone_number_hash: hash })
    .returning();
  return created;
}

export async function getUserById(db: Db, userId: number): Promise<User | null> {
  return (await db.query.users.findFirst({ where: eq(users.id, userId) })) ?? null;
}

export async function getUserByHash(db: Db, hash: string): Promise<User | null> {
  return (await db.query.users.findFirst({ where: eq(users.phone_number_hash, hash) })) ?? null;
}

export function getAccessibleUserIds(user: User): number[] {
  return user.partner_user_id ? [user.id, user.partner_user_id] : [user.id];
}

// Returns false if either user already has a partner (race-safe: uses WHERE partner_user_id IS NULL).
export async function linkPartners(db: Db, userAId: number, userBId: number): Promise<boolean> {
  const r1 = await db
    .update(users)
    .set({ partner_user_id: userBId })
    .where(and(eq(users.id, userAId), isNull(users.partner_user_id)))
    .run();
  if (r1.meta.changes === 0) return false;

  const r2 = await db
    .update(users)
    .set({ partner_user_id: userAId })
    .where(and(eq(users.id, userBId), isNull(users.partner_user_id)))
    .run();
  if (r2.meta.changes === 0) {
    // Roll back userA's update so we don't leave a one-sided link.
    await db.update(users).set({ partner_user_id: null })
      .where(and(eq(users.id, userAId), eq(users.partner_user_id, userBId))).run();
    return false;
  }
  return true;
}

// Returns false if the partnership no longer exists (already unlinked by a concurrent call).
export async function unlinkPartners(db: Db, userAId: number, userBId: number): Promise<boolean> {
  const r = await db
    .update(users)
    .set({ partner_user_id: null })
    .where(and(eq(users.id, userAId), eq(users.partner_user_id, userBId)))
    .run();
  if (r.meta.changes === 0) return false;
  await db.update(users).set({ partner_user_id: null }).where(eq(users.id, userBId)).run();
  return true;
}

// ── Friend helpers ─────────────────────────────────────────────────────────────

export const FRIEND_CAPACITY = 5;

export async function getFriends(db: Db, userId: number): Promise<{ friend: User; nickname: string }[]> {
  const rows = await db
    .select({ friend: users, nickname: friendLinks.nickname })
    .from(friendLinks)
    .innerJoin(users, eq(friendLinks.friend_user_id, users.id))
    .where(eq(friendLinks.user_id, userId));
  return rows;
}

export async function getFriendCount(db: Db, userId: number): Promise<number> {
  const [row] = await db.select({ n: count() }).from(friendLinks).where(eq(friendLinks.user_id, userId));
  return Number(row?.n ?? 0);
}

export async function getFriendByNickname(
  db: Db,
  userId: number,
  nickname: string
): Promise<{ friend: User; nickname: string } | null> {
  const rows = await db
    .select({ friend: users, nickname: friendLinks.nickname })
    .from(friendLinks)
    .innerJoin(users, eq(friendLinks.friend_user_id, users.id))
    .where(eq(friendLinks.user_id, userId));
  const lower = nickname.toLowerCase().trim();
  return rows.find((r) => r.nickname.toLowerCase() === lower) ?? null;
}

export async function friendshipExists(db: Db, userAId: number, userBId: number): Promise<boolean> {
  const row = await db.query.friendLinks.findFirst({
    where: and(eq(friendLinks.user_id, userAId), eq(friendLinks.friend_user_id, userBId)),
  });
  return row != null;
}

// Returns false if the friendship already exists (race-safe: uses INSERT OR IGNORE via the PK constraint).
export async function linkFriends(
  db: Db,
  userAId: number,
  userBId: number,
  nicknameAforB: string,
  nicknameBforA: string
): Promise<boolean> {
  const r1 = await db.insert(friendLinks)
    .values({ user_id: userAId, friend_user_id: userBId, nickname: nicknameAforB })
    .onConflictDoNothing()
    .run();
  if (r1.meta.changes === 0) return false;

  const r2 = await db.insert(friendLinks)
    .values({ user_id: userBId, friend_user_id: userAId, nickname: nicknameBforA })
    .onConflictDoNothing()
    .run();
  if (r2.meta.changes === 0) {
    await db.delete(friendLinks)
      .where(and(eq(friendLinks.user_id, userAId), eq(friendLinks.friend_user_id, userBId))).run();
    return false;
  }
  return true;
}

export async function unlinkFriends(db: Db, userAId: number, userBId: number): Promise<void> {
  await db.delete(friendLinks).where(and(eq(friendLinks.user_id, userAId), eq(friendLinks.friend_user_id, userBId)));
  await db.delete(friendLinks).where(and(eq(friendLinks.user_id, userBId), eq(friendLinks.friend_user_id, userAId)));

  // Drop assignee rows that link these two users' tasks
  const aTaskIds = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.user_id, userAId))).map((r) => r.id);
  const bTaskIds = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.user_id, userBId))).map((r) => r.id);
  if (aTaskIds.length > 0) {
    await db.delete(taskAssignees).where(and(inArray(taskAssignees.task_id, aTaskIds), eq(taskAssignees.assignee_user_id, userBId)));
  }
  if (bTaskIds.length > 0) {
    await db.delete(taskAssignees).where(and(inArray(taskAssignees.task_id, bTaskIds), eq(taskAssignees.assignee_user_id, userAId)));
  }
}

// ── Task assignee helpers ──────────────────────────────────────────────────────

export async function addTaskAssignees(db: Db, taskId: number, userIds: number[]): Promise<void> {
  for (const uid of userIds) {
    await db.insert(taskAssignees).values({ task_id: taskId, assignee_user_id: uid }).onConflictDoNothing();
  }
}

export async function getTaskAssignees(db: Db, taskId: number): Promise<User[]> {
  const rows = await db
    .select({ user: users })
    .from(taskAssignees)
    .innerJoin(users, eq(taskAssignees.assignee_user_id, users.id))
    .where(eq(taskAssignees.task_id, taskId));
  return rows.map((r) => r.user);
}

export async function getAssignedTaskIds(db: Db, userId: number): Promise<number[]> {
  const rows = await db
    .select({ task_id: taskAssignees.task_id })
    .from(taskAssignees)
    .where(eq(taskAssignees.assignee_user_id, userId));
  return rows.map((r) => r.task_id);
}

export async function getTaskAssigneesByTaskIds(
  db: Db,
  taskIds: number[],
  viewerUserId: number
): Promise<Map<number, { id: number; nickname: string }[]>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select({
      task_id: taskAssignees.task_id,
      assignee_id: taskAssignees.assignee_user_id,
      nickname: friendLinks.nickname,
    })
    .from(taskAssignees)
    .leftJoin(
      friendLinks,
      and(
        eq(friendLinks.user_id, viewerUserId),
        eq(friendLinks.friend_user_id, taskAssignees.assignee_user_id)
      )
    )
    .where(inArray(taskAssignees.task_id, taskIds));

  const map = new Map<number, { id: number; nickname: string }[]>();
  for (const r of rows) {
    const entry = { id: r.assignee_id, nickname: r.nickname ?? `user_${r.assignee_id}` };
    const existing = map.get(r.task_id);
    if (existing) existing.push(entry);
    else map.set(r.task_id, [entry]);
  }
  return map;
}

// Returns the nickname the owner (taskOwnerId) calls the viewer, for "מאת:" display
export async function getNicknameForUser(
  db: Db,
  viewerUserId: number,
  targetUserId: number
): Promise<string | null> {
  const row = await db.query.friendLinks.findFirst({
    where: and(eq(friendLinks.user_id, viewerUserId), eq(friendLinks.friend_user_id, targetUserId)),
  });
  return row?.nickname ?? null;
}

export async function decryptPhone(user: { phone_number_encrypted: string }, encKey: string): Promise<string> {
  try {
    return await fernetDecrypt(user.phone_number_encrypted, encKey);
  } catch {
    return "";
  }
}

export async function setUserApiToken(
  db: Db,
  userId: number,
  encrypted: string,
  hash: string
): Promise<void> {
  await db
    .update(users)
    .set({ api_token_encrypted: encrypted, api_token_hash: hash, api_token_created_at: new Date() })
    .where(eq(users.id, userId));
}

export async function getUserByApiTokenHash(db: Db, hash: string): Promise<User | null> {
  return (await db.query.users.findFirst({ where: eq(users.api_token_hash, hash) })) ?? null;
}

export async function getUserMessageCount(db: Db, userId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(eq(messages.user_id, userId));
  return Number(row?.n ?? 0);
}

// ── Message helpers ───────────────────────────────────────────────────────────

export async function saveMessage(
  db: Db,
  encKey: string,
  opts: {
    userId: number;
    messageType: string;
    content: string | null;
    aiResponse: string | null;
    parsedTasks: object | null;
    whatsappMessageId: string | null;
  }
): Promise<void> {
  const values: NewMessage = {
    user_id: opts.userId,
    message_type: opts.messageType,
    content_encrypted: opts.content ? await fernetEncrypt(opts.content, encKey) : null,
    ai_response_encrypted: opts.aiResponse ? await fernetEncrypt(opts.aiResponse, encKey) : null,
    parsed_tasks: await encryptParsedTasks(opts.parsedTasks, encKey),
    whatsapp_message_id: opts.whatsappMessageId,
  };
  await db.insert(messages).values(values);
}

export async function getConversationHistory(
  db: Db,
  encKey: string,
  userId: number,
  limit = 10
): Promise<{ role: string; content: string }[]> {
  const rows = await db.query.messages.findMany({
    where: and(
      eq(messages.user_id, userId),
      or(eq(messages.message_type, "text"), eq(messages.message_type, "audio"))
    ),
    orderBy: [desc(messages.created_at), desc(messages.id)],
    limit: limit * 2,
  });

  const history: { role: string; content: string }[] = [];
  for (const row of rows.reverse()) {
    try {
      if (row.content_encrypted) {
        history.push({ role: "user", content: await fernetDecrypt(row.content_encrypted, encKey) });
      }
      if (row.ai_response_encrypted) {
        history.push({ role: "assistant", content: await fernetDecrypt(row.ai_response_encrypted, encKey) });
      }
    } catch {
      // skip messages that fail to decrypt
    }
  }
  return history.slice(-limit);
}

export async function getBotReplyByMessageId(
  db: Db,
  encKey: string,
  userId: number,
  waMessageId: string
): Promise<string | null> {
  const row = await db.query.messages.findFirst({
    where: and(eq(messages.user_id, userId), eq(messages.whatsapp_message_id, waMessageId)),
  });
  if (!row?.ai_response_encrypted) return null;
  try {
    return await fernetDecrypt(row.ai_response_encrypted, encKey);
  } catch {
    return null;
  }
}

export async function getTaskIdFromMessageId(
  db: Db,
  encKey: string,
  userId: number,
  waMessageId: string
): Promise<number | null> {
  const row = await db.query.messages.findFirst({
    where: and(eq(messages.user_id, userId), eq(messages.whatsapp_message_id, waMessageId)),
  });
  const parsed = await decryptParsedTasks(row?.parsed_tasks ?? null, encKey);
  return parsed?.tasks?.[0]?.task_id ?? null;
}

export async function getLastReminderMessageId(
  db: Db,
  encKey: string,
  userId: number
): Promise<{ msgId: string; taskId: number } | null> {
  const row = await db.query.messages.findFirst({
    where: and(eq(messages.user_id, userId), eq(messages.message_type, "reminder")),
    orderBy: [desc(messages.created_at)],
  });
  if (!row || !row.whatsapp_message_id || !row.parsed_tasks) return null;
  const parsed = await decryptParsedTasks(row.parsed_tasks, encKey);
  const taskId = parsed?.tasks?.[0]?.task_id;
  if (!taskId) return null;
  return { msgId: row.whatsapp_message_id, taskId };
}

// ── Task helpers ──────────────────────────────────────────────────────────────

async function decryptDescription(value: string, encKey: string): Promise<string> {
  try {
    return await fernetDecrypt(value, encKey);
  } catch {
    return value; // legacy plaintext row
  }
}

export async function getUserTasks(
  db: Db,
  encKey: string,
  userIds: number[],
  status?: string,
  assignedTaskIds: number[] = []
): Promise<Task[]> {
  const ownerWhere = status
    ? and(inArray(tasks.user_id, userIds), eq(tasks.status, status))
    : inArray(tasks.user_id, userIds);

  const where =
    assignedTaskIds.length > 0
      ? or(
          ownerWhere,
          status
            ? and(inArray(tasks.id, assignedTaskIds), eq(tasks.status, status))
            : inArray(tasks.id, assignedTaskIds)
        )
      : ownerWhere;

  const rows = await db.query.tasks.findMany({ where, orderBy: [desc(tasks.created_at)] });
  return Promise.all(rows.map(async (t) => ({ ...t, description: await decryptDescription(t.description, encKey) })));
}

export async function getTaskStats(
  db: Db,
  userIds: number[],
  assignedTaskIds: number[] = []
): Promise<{ pending: number; completed: number }> {
  const where =
    assignedTaskIds.length > 0
      ? or(inArray(tasks.user_id, userIds), inArray(tasks.id, assignedTaskIds))
      : inArray(tasks.user_id, userIds);
  const [row] = await db
    .select({
      pending: count(sql`CASE WHEN ${tasks.status} = 'pending' THEN 1 END`),
      completed: count(sql`CASE WHEN ${tasks.status} = 'completed' THEN 1 END`),
    })
    .from(tasks)
    .where(where);
  return { pending: Number(row?.pending ?? 0), completed: Number(row?.completed ?? 0) };
}

export async function getTaskById(
  db: Db,
  encKey: string,
  taskId: number,
  userIds: number[],
  assignedTaskIds: number[] = []
): Promise<Task | null> {
  const where =
    assignedTaskIds.includes(taskId)
      ? eq(tasks.id, taskId)
      : and(eq(tasks.id, taskId), inArray(tasks.user_id, userIds));
  const row = await db.query.tasks.findFirst({ where });
  if (!row) return null;
  return { ...row, description: await decryptDescription(row.description, encKey) };
}

export async function addTask(
  db: Db,
  encKey: string,
  userId: number,
  description: string,
  dueDate: Date | null,
  recurrence?: string | null,
  undo?: UndoContext,
  details?: { projectId?: number | null },
): Promise<Task> {
  if(recurrence)recurrence=normalizeRecurrence(recurrence);
  const projectId=details?.projectId??null;
  if(projectId && !await db.$client.prepare('SELECT 1 FROM project WHERE id=? AND user_id=?').bind(projectId,userId).first())throw new Error('Project is not owned by task owner');
  const encDesc = await fernetEncrypt(description, encKey);
  if (undo) {
    const now = Math.floor(Date.now() / 1000);
    const results = await db.$client.batch([
      db.$client.prepare('INSERT OR IGNORE INTO task_undo (id, actor_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(undo.groupId, undo.actorId, now, now + 600),
      db.$client.prepare(`INSERT INTO task (user_id, description, due_date, status, recurrence, created_at, updated_at,project_id)
        VALUES (?, ?, ?, 'pending', ?, ?, ?,?) RETURNING id`).bind(userId, encDesc, dueDate ? Math.floor(+dueDate / 1000) : null, recurrence ?? null, now, now,projectId),
      db.$client.prepare(`INSERT INTO task_undo_change (group_id, task_id, before_encrypted, after_revision)
        SELECT ?, id, NULL, revision FROM task WHERE id=last_insert_rowid()`).bind(undo.groupId),
    ]);
    const id = (results[1].results[0] as { id: number }).id;
    undo.changedTaskIds?.push(id);
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    if (!task) throw new Error('Created task missing');
    return { ...task, description };
  }
  const [task] = await db
    .insert(tasks)
    .values({ user_id: userId, description: encDesc, due_date: dueDate, status: "pending", recurrence: recurrence ?? null,project_id:projectId })
    .returning();
  return { ...task, description };
}

export async function scheduleNextRecurrence(db: Db, encKey: string, task: Task, undo?: UndoContext): Promise<Task | null> {
  if (!task.recurrence || !task.due_date) return null;
  const nextDue=nextRecurringOccurrence(task.due_date,task.recurrence);
  if(!nextDue)return null;
  const newTask = await addTask(db, encKey, task.user_id, task.description, nextDue, task.recurrence, undo,{projectId:task.project_id});
  // Copy assignees from original task to new recurrence instance
  const assignees = await getTaskAssignees(db, task.id);
  if (assignees.length > 0) {
    await addTaskAssignees(db, newTask.id, assignees.map((a) => a.id));
  }
  return newTask;
}

export async function completeTask(
  db: Db,
  encKey: string,
  taskId: number,
  userIds: number[],
  assignedTaskIds: number[] = [],
  undo?: UndoContext
): Promise<Task | null> {
  if (undo) {
    const changed = await trackedTaskMutation(db.$client, encKey, undo, taskId, { status: 'completed', completed_at: Math.floor(Date.now() / 1000) });
    return changed ? getTaskById(db, encKey, taskId, userIds, assignedTaskIds) : null;
  }
  const isAssigned = assignedTaskIds.includes(taskId);
  const where = isAssigned
    ? and(eq(tasks.id, taskId), eq(tasks.status, "pending"))
    : and(eq(tasks.id, taskId), inArray(tasks.user_id, userIds), eq(tasks.status, "pending"));
  const rows = await db
    .update(tasks)
    .set({ status: "completed", completed_at: new Date(), updated_at: new Date() })
    .where(where)
    .returning();
  const row = rows[0];
  if (!row) return null;
  return { ...row, description: await decryptDescription(row.description, encKey) };
}

export async function updateTaskByDescription(
  db: Db,
  encKey: string,
  userIds: number[],
  description: string,
  updates: { description?: string; due_date?: Date | null },
  undo?: UndoContext
): Promise<Task | null> {
  const rawPending = await db.query.tasks.findMany({
    where: and(inArray(tasks.user_id, userIds), eq(tasks.status, "pending")),
    orderBy: [desc(tasks.created_at)],
  });
  const pending = await Promise.all(
    rawPending.map(async (t) => ({ ...t, description: await decryptDescription(t.description, encKey) }))
  );

  const lower = description.toLowerCase().trim();
  let match = pending.find((t) => t.description.toLowerCase() === lower);
  if (!match) {
    match = pending.find(
      (t) => t.description.toLowerCase().includes(lower) || lower.includes(t.description.toLowerCase())
    );
  }
  if (!match && /^\d+$/.test(lower)) {
    match = pending[parseInt(lower, 10) - 1];
  }
  if (!match) return null;

  if (undo) return updateTaskById(db, encKey, match.id, userIds, updates, [], undo);

  const setValues: Record<string, unknown> = { updated_at: new Date() };
  if (updates.description !== undefined) setValues.description = await fernetEncrypt(updates.description, encKey);
  if (updates.due_date !== undefined) {
    setValues.due_date = updates.due_date;
    setValues.reminder_sent = false;
  }

  const [updated] = await db
    .update(tasks)
    .set(setValues)
    .where(eq(tasks.id, match.id))
    .returning();
  if (!updated) return null;
  const plainDesc = updates.description !== undefined ? updates.description : match.description;
  return { ...updated, description: plainDesc };
}

export async function updateTaskById(
  db: Db,
  encKey: string,
  taskId: number,
  userIds: number[],
  updates: { description?: string; due_date?: Date | null },
  assignedTaskIds: number[] = [],
  undo?: UndoContext
): Promise<Task | null> {
  if (undo) {
    const patch: TaskPatch = {};
    if (updates.description !== undefined) patch.description = await fernetEncrypt(updates.description, encKey);
    if (updates.due_date !== undefined) { patch.due_date = updates.due_date ? Math.floor(updates.due_date.getTime() / 1000) : null; patch.reminder_sent = 0; }
    if (!Object.keys(patch).length) return null;
    const changed = await trackedTaskMutation(db.$client, encKey, undo, taskId, patch);
    return changed ? getTaskById(db, encKey, taskId, userIds, assignedTaskIds) : null;
  }
  const isAssigned = assignedTaskIds.includes(taskId);
  const where = isAssigned
    ? and(eq(tasks.id, taskId), eq(tasks.status, "pending"))
    : and(eq(tasks.id, taskId), inArray(tasks.user_id, userIds), eq(tasks.status, "pending"));

  const setValues: Record<string, unknown> = { updated_at: new Date() };
  if (updates.description !== undefined) setValues.description = await fernetEncrypt(updates.description, encKey);
  if (updates.due_date !== undefined) {
    setValues.due_date = updates.due_date;
    setValues.reminder_sent = false;
  }

  const [updated] = await db
    .update(tasks)
    .set(setValues)
    .where(where)
    .returning();
  if (!updated) return null;

  const description = updates.description !== undefined
    ? updates.description
    : await decryptDescription(updated.description, encKey);
  return { ...updated, description };
}

export async function completeTaskByDescription(
  db: Db,
  encKey: string,
  userIds: number[],
  description: string,
  assignedTaskIds: number[] = [],
  undo?: UndoContext
): Promise<Task | null> {
  const where =
    assignedTaskIds.length > 0
      ? or(
          and(inArray(tasks.user_id, userIds), eq(tasks.status, "pending")),
          and(inArray(tasks.id, assignedTaskIds), eq(tasks.status, "pending"))
        )
      : and(inArray(tasks.user_id, userIds), eq(tasks.status, "pending"));
  const rawPending = await db.query.tasks.findMany({
    where,
    orderBy: [desc(tasks.created_at)],
  });
  const pending = await Promise.all(
    rawPending.map(async (t) => ({ ...t, description: await decryptDescription(t.description, encKey) }))
  );

  const lower = description.toLowerCase().trim();
  let match = pending.find((t) => t.description.toLowerCase() === lower);
  if (!match) {
    match = pending.find(
      (t) => t.description.toLowerCase().includes(lower) || lower.includes(t.description.toLowerCase())
    );
  }
  if (!match && /^\d+$/.test(lower)) {
    match = pending[parseInt(lower, 10) - 1];
  }
  if (!match) return null;

  if (undo) return completeTask(db, encKey, match.id, userIds, assignedTaskIds, undo);

  const [updated] = await db
    .update(tasks)
    .set({ status: "completed", completed_at: new Date(), updated_at: new Date() })
    .where(and(eq(tasks.id, match.id), eq(tasks.status, "pending")))
    .returning();
  if (!updated) return null;
  return { ...updated, description: match.description }; // already decrypted
}

export async function clearRecurrenceByDescription(db: Db, encKey: string, userIds: number[], description: string, undo?: UndoContext): Promise<Task | null> {
  const rawPending = await db.query.tasks.findMany({
    where: and(inArray(tasks.user_id, userIds), eq(tasks.status, "pending")),
    orderBy: [desc(tasks.created_at)],
  });
  const pending = await Promise.all(
    rawPending.map(async (t) => ({ ...t, description: await decryptDescription(t.description, encKey) }))
  );

  const recurring = pending.filter((t) => t.recurrence);
  const lower = description.toLowerCase().trim();
  let match = recurring.find((t) => t.description.toLowerCase() === lower);
  if (!match) match = recurring.find((t) => t.description.toLowerCase().includes(lower) || lower.includes(t.description.toLowerCase()));
  if (!match && /^\d+$/.test(lower)) match = pending[parseInt(lower, 10) - 1]?.recurrence ? pending[parseInt(lower, 10) - 1] : undefined;
  if (!match) return null;

  if (undo) {
    const changed = await trackedTaskMutation(db.$client, encKey, undo, match.id, { recurrence: null });
    return changed ? getTaskById(db, encKey, match.id, userIds) : null;
  }

  const [updated] = await db
    .update(tasks)
    .set({ recurrence: null, updated_at: new Date() })
    .where(eq(tasks.id, match.id))
    .returning();
  if (!updated) return null;
  return { ...updated, description: match.description };
}

export async function completeAllPendingTasks(db: Db, userIds: number[], encKey?: string, undo?: UndoContext): Promise<number> {
  if (undo && encKey) {
    const count=await trackedCompleteAll(db.$client,encKey,undo,userIds);
    const completed=await db.$client.prepare(`SELECT t.id FROM task t JOIN task_undo_change c ON c.task_id=t.id
      WHERE c.group_id=? AND c.before_encrypted IS NOT NULL AND t.status='completed' AND t.recurrence IS NOT NULL AND t.revision=c.after_revision`).bind(undo.groupId).all<{id:number}>();
    for(const row of completed.results){const task=await getTaskById(db,encKey,row.id,userIds);if(task)await scheduleNextRecurrence(db,encKey,task,undo);}
    return count;
  }
  const rows = await db
    .update(tasks)
    .set({ status: "completed", completed_at: new Date(), updated_at: new Date() })
    .where(and(inArray(tasks.user_id, userIds), eq(tasks.status, "pending")))
    .returning({ id: tasks.id });
  return rows.length;
}

export async function getDueTasksForReminders(db: Db, encKey: string): Promise<
  { task: Task; user: User }[]
> {
  type DueReminderRow = {
    task_id: number;
    task_user_id: number;
    task_description: string;
    task_google_event_key: string | null;
    task_status: string;
    task_revision: number;
    task_project_id: number | null;
    task_due_date: number | null;
    task_reminder_sent: number | null;
    task_recurrence: string | null;
    task_created_at: number;
    task_completed_at: number | null;
    task_updated_at: number;
    owner_id: number;
    owner_phone_number_encrypted: string;
    owner_phone_number_hash: string;
    owner_created_at: number;
    owner_last_active: number;
    owner_partner_user_id: number | null;
    owner_api_token_encrypted: string | null;
    owner_api_token_hash: string | null;
    owner_api_token_created_at: number | null;
  };

  // INDEXED BY is intentional: SQLite otherwise prefers the broader
  // idx_task_status_due index and scans already-sent pending reminders.
  const { results } = await db.$client.prepare(`
    SELECT
      t.id AS task_id,
      t.user_id AS task_user_id,
      t.description AS task_description,
      t.google_event_key AS task_google_event_key,
      t.status AS task_status,
      t.revision AS task_revision,
      t.project_id AS task_project_id,
      t.due_date AS task_due_date,
      t.reminder_sent AS task_reminder_sent,
      t.recurrence AS task_recurrence,
      t.created_at AS task_created_at,
      t.completed_at AS task_completed_at,
      t.updated_at AS task_updated_at,
      u.id AS owner_id,
      u.phone_number_encrypted AS owner_phone_number_encrypted,
      u.phone_number_hash AS owner_phone_number_hash,
      u.created_at AS owner_created_at,
      u.last_active AS owner_last_active,
      u.partner_user_id AS owner_partner_user_id,
      u.api_token_encrypted AS owner_api_token_encrypted,
      u.api_token_hash AS owner_api_token_hash,
      u.api_token_created_at AS owner_api_token_created_at
    FROM task AS t INDEXED BY idx_task_pending_unsent_due
    INNER JOIN user AS u ON t.user_id = u.id
    WHERE t.due_date <= ?1
      AND t.status = 'pending'
      AND t.reminder_sent = 0
      AND ${billingAccessSql('u.phone_number_hash', '?1')}
    ORDER BY t.due_date ASC, t.id ASC
    LIMIT 1000
  `).bind(Math.floor(Date.now() / 1000)).all<DueReminderRow>();

  return Promise.all(
    results.map(async (row) => ({
      task: {
        id: row.task_id,
        user_id: row.task_user_id,
        description: await decryptDescription(row.task_description, encKey),
        google_event_key: row.task_google_event_key,
        status: row.task_status,
        revision: row.task_revision,
        project_id: row.task_project_id,
        due_date: row.task_due_date === null ? null : new Date(row.task_due_date * 1000),
        reminder_sent: row.task_reminder_sent === null ? null : row.task_reminder_sent !== 0,
        recurrence: row.task_recurrence,
        created_at: new Date(row.task_created_at * 1000),
        completed_at: row.task_completed_at === null ? null : new Date(row.task_completed_at * 1000),
        updated_at: new Date(row.task_updated_at * 1000),
      },
      user: {
        id: row.owner_id,
        phone_number_encrypted: row.owner_phone_number_encrypted,
        phone_number_hash: row.owner_phone_number_hash,
        created_at: new Date(row.owner_created_at * 1000),
        last_active: new Date(row.owner_last_active * 1000),
        partner_user_id: row.owner_partner_user_id,
        api_token_encrypted: row.owner_api_token_encrypted,
        api_token_hash: row.owner_api_token_hash,
        api_token_created_at: row.owner_api_token_created_at === null
          ? null
          : new Date(row.owner_api_token_created_at * 1000),
      },
    }))
  );
}

export async function markReminderSent(db: Db, taskId: number): Promise<boolean> {
  const result = await db
    .update(tasks)
    .set({ reminder_sent: true, updated_at: new Date() })
    .where(and(eq(tasks.id, taskId), sql`${tasks.reminder_sent} = 0`))
    .run();
  return result.meta.changes > 0;
}

export async function clearReminderSent(db: Db, taskId: number): Promise<void> {
  await db
    .update(tasks)
    .set({ reminder_sent: false, updated_at: new Date() })
    .where(eq(tasks.id, taskId))
    .run();
}

export async function snoozeTask(
  db: Db,
  encKey: string,
  taskId: number,
  userIds: number[],
  newDueDate: Date,
  assignedTaskIds: number[] = [],
  undo?: UndoContext
): Promise<Task | null> {
  if (undo) return updateTaskById(db, encKey, taskId, userIds, { due_date: newDueDate }, assignedTaskIds, undo);
  const isAssigned = assignedTaskIds.includes(taskId);
  const where = isAssigned
    ? and(eq(tasks.id, taskId), eq(tasks.status, "pending"))
    : and(eq(tasks.id, taskId), inArray(tasks.user_id, userIds), eq(tasks.status, "pending"));
  const rows = await db
    .update(tasks)
    .set({ due_date: newDueDate, reminder_sent: false, updated_at: new Date() })
    .where(where)
    .returning();
  const row = rows[0];
  if (!row) return null;
  return { ...row, description: await decryptDescription(row.description, encKey) };
}

// ── Account deletion ─────────────────────────────────────────────────────────

export async function deleteUserAndData(db: Db, userId: number, partnerId: number | null): Promise<void> {
  await db.$client.prepare(`DELETE FROM task_undo WHERE actor_user_id = ? OR id IN
    (SELECT c.group_id FROM task_undo_change c JOIN task t ON t.id=c.task_id WHERE t.user_id = ?)`).bind(userId, userId).run();
  // Unlink partner before deletion to avoid dangling foreign key
  if (partnerId) {
    await db.update(users).set({ partner_user_id: null }).where(eq(users.id, partnerId));
  }
  // Remove friend_link rows pointing at this user from both sides
  await db.delete(friendLinks).where(eq(friendLinks.friend_user_id, userId));
  // Remove this user from task_assignee rows for other people's tasks
  await db.delete(taskAssignees).where(eq(taskAssignees.assignee_user_id, userId));
  // Foreign-key cascades also remove retained legacy records for this account.
  await db.delete(messages).where(eq(messages.user_id, userId));
  await db.delete(tasks).where(eq(tasks.user_id, userId));
  await db.delete(users).where(eq(users.id, userId));
}

// ── Dashboard stats ───────────────────────────────────────────────────────────

export async function getStatsData(db: Db, encKey: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [mainStats] = await db
    .select({
      total_users: count(sql`DISTINCT ${users.id}`),
      total_messages: count(sql`DISTINCT ${messages.id}`),
      total_tasks: count(sql`DISTINCT ${tasks.id}`),
      pending_tasks: count(sql`DISTINCT CASE WHEN ${tasks.status} = 'pending' THEN ${tasks.id} END`),
      completed_tasks: count(sql`DISTINCT CASE WHEN ${tasks.status} = 'completed' THEN ${tasks.id} END`),
      in_progress_tasks: count(sql`DISTINCT CASE WHEN ${tasks.status} = 'in_progress' THEN ${tasks.id} END`),
    })
    .from(users)
    .leftJoin(messages, eq(messages.user_id, users.id))
    .leftJoin(tasks, eq(tasks.user_id, users.id));

  const [todayStats] = await db
    .select({
      tasks_today: count(sql`DISTINCT CASE WHEN DATE(${tasks.created_at}, 'unixepoch') = DATE('now') THEN ${tasks.id} END`),
      new_users_today: count(sql`DISTINCT CASE WHEN DATE(${users.created_at}, 'unixepoch') = DATE('now') THEN ${users.id} END`),
      whatsapp_users_today: count(sql`DISTINCT CASE WHEN DATE(${messages.created_at}, 'unixepoch') = DATE('now') THEN ${users.id} END`),
    })
    .from(users)
    .leftJoin(tasks, eq(tasks.user_id, users.id))
    .leftJoin(messages, eq(messages.user_id, users.id));

  // Weekly activity (last 7 days) — 3 parallel GROUP BY queries instead of 7 serial ones
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

  const [tasksByDay, messagesByDay, usersByDay] = await Promise.all([
    db
      .select({ day: sql<string>`DATE(${tasks.created_at}, 'unixepoch')`, n: count() })
      .from(tasks)
      .where(gte(tasks.created_at, sevenDaysAgo))
      .groupBy(sql`DATE(${tasks.created_at}, 'unixepoch')`),
    db
      .select({ day: sql<string>`DATE(${messages.created_at}, 'unixepoch')`, n: count() })
      .from(messages)
      .where(gte(messages.created_at, sevenDaysAgo))
      .groupBy(sql`DATE(${messages.created_at}, 'unixepoch')`),
    db
      .select({ day: sql<string>`DATE(${users.created_at}, 'unixepoch')`, n: count() })
      .from(users)
      .where(gte(users.created_at, sevenDaysAgo))
      .groupBy(sql`DATE(${users.created_at}, 'unixepoch')`),
  ]);

  const taskMap = new Map(tasksByDay.map((r) => [r.day, Number(r.n)]));
  const msgMap = new Map(messagesByDay.map((r) => [r.day, Number(r.n)]));
  const userMap = new Map(usersByDay.map((r) => [r.day, Number(r.n)]));

  const weeklyActivity = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(day.getDate() - i);
    const dayStr = day.toISOString().slice(0, 10);
    weeklyActivity.push({
      date: dayStr,
      day: day.toLocaleDateString("en-US", { weekday: "short" }),
      tasks: taskMap.get(dayStr) ?? 0,
      messages: msgMap.get(dayStr) ?? 0,
      users: userMap.get(dayStr) ?? 0,
    });
  }

  // Recent messages
  const recentMsgs = await db.query.messages.findMany({
    with: { user: true },
    orderBy: [desc(messages.created_at)],
    limit: 20,
  });

  const recentMessages = await Promise.all(
    recentMsgs.map(async (msg) => {
      let content: string | null = null;
      try {
        content = msg.content_encrypted
          ? (await fernetDecrypt(msg.content_encrypted, encKey)).slice(0, 100)
          : null;
      } catch {
        content = null;
      }
      const phone = await decryptPhone(msg.user, encKey);
      return {
        id: msg.id,
        user_phone: phone ? "***" + phone.slice(-4) : "***",
        type: msg.message_type,
        content,
        created_at: msg.created_at
          ? new Date(msg.created_at).toLocaleString("he-IL", { timeZone: TZ })
          : null,
      };
    })
  );

  return {
    total_users: Number(mainStats?.total_users ?? 0),
    total_messages: Number(mainStats?.total_messages ?? 0),
    total_tasks: Number(mainStats?.total_tasks ?? 0),
    pending_tasks: Number(mainStats?.pending_tasks ?? 0),
    completed_tasks: Number(mainStats?.completed_tasks ?? 0),
    in_progress_tasks: Number(mainStats?.in_progress_tasks ?? 0),
    tasks_today: Number(todayStats?.tasks_today ?? 0),
    new_users_today: Number(todayStats?.new_users_today ?? 0),
    whatsapp_users_today: Number(todayStats?.whatsapp_users_today ?? 0),
    weekly_activity: weeklyActivity,
    recent_messages: recentMessages,
  };
}
