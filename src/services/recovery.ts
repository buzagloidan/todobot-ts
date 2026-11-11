import type { Env } from "../types.ts";
import type { User, Task } from "../db/schema.ts";
import { buildDb } from "../db/client.ts";
import {
  getAccessibleUserIds,
  getAssignedTaskIds,
  getUserTasks,
  getTaskById,
  updateTaskById,
  saveMessage,
} from "../db/queries.ts";
import { signControl, verifyControl } from "./controls.ts";
import {
  sendMessage,
  sendInteractiveButtons,
  sendInteractiveList,
} from "./whatsapp.ts";
import {
  newUndoContext,
  trackedTaskMutation,
  taskPermissionSql,
} from "./task_undo.ts";
import { sendTaskReply } from "./task_controls.ts";
import { processMessage } from "./gemini.ts";
import { nowInJerusalem, jerusalemLocalToUtc, parseDueDate } from "../time.ts";
import { TZ } from "../constants.ts";
const now = () => Math.floor(Date.now() / 1000);
const format = (date: Date) =>
  date.toLocaleString("he-IL", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
export async function overdueTasks(
  env: Env,
  user: User,
  includeReviewed = false,
): Promise<Task[]> {
  const db = buildDb(env),
    tasks = await getUserTasks(
      db,
      env.ENCRYPTION_KEY,
      getAccessibleUserIds(user),
      "pending",
      await getAssignedTaskIds(db, user.id),
    );
  const reviewed = (
    await env.DB.prepare(
      "SELECT task_id,revision FROM task_recovery WHERE actor_id=?",
    )
      .bind(user.id)
      .all<{ task_id: number; revision: number }>()
  ).results;
  const ignored = new Map(reviewed.map((r) => [r.task_id, r.revision]));
  return tasks
    .filter(
      (t) =>
        t.due_date &&
        +t.due_date < Date.now() &&
        (includeReviewed || ignored.get(t.id) !== t.revision),
    )
    .sort((a, b) => +a.due_date! - +b.due_date! || a.id - b.id);
}
async function recoveryCard(
  env: Env,
  user: User,
  phone: string,
  task: Task,
  count: number,
  prefix = "",
): Promise<void> {
  const expiry = now() + 3600;
  const buttons = await Promise.all(
    [
      ["keep", "להשאיר"],
      ["reschedule", "לקבוע מחדש"],
      ["cancel", "לבטל משימה"],
    ].map(async ([action, title]) => ({
      id: await signControl(
        env,
        "recover",
        user.id,
        action,
        task.id,
        task.revision,
        expiry,
      ),
      title,
    })),
  );
  await sendInteractiveButtons(
    env,
    phone,
    `${prefix ? prefix + "\n\n" : ""}⏳ ${count} משימות עברו את הזמן ועדיין לא הושלמו.\n\n*${task.description}*\nהמועד שהיה: ${format(task.due_date!)}\n\nלהשאיר, לקבוע זמן חדש או לבטל?\nלבחירה מתוך הרשימה: /recover list`,
    buttons,
  );
}
export async function showRecovery(
  env: Env,
  user: User,
  phone: string,
  includeReviewed = false,
  prefix = "",
): Promise<void> {
  const tasks = await overdueTasks(env, user, includeReviewed);
  if (!tasks.length) {
    await sendMessage(
      env,
      phone,
      `${prefix ? prefix + "\n\n" : ""}אין משימות באיחור שדורשות בדיקה כרגע 🎉\n/recover all — גם משימות שכבר הוחלט להשאיר.`,
    );
    return;
  }
  await recoveryCard(env, user, phone, tasks[0], tasks.length, prefix);
}
async function recoveryList(
  env: Env,
  user: User,
  phone: string,
  page = 0,
  includeReviewed = false,
): Promise<void> {
  const tasks = await overdueTasks(env, user, includeReviewed);
  if (!tasks.length) {
    await showRecovery(env, user, phone);
    return;
  }
  if (page * 9 >= tasks.length) page = 0;
  const rows = await Promise.all(
    tasks.slice(page * 9, page * 9 + 9).map(async (t) => ({
      id: await signControl(
        env,
        "recover",
        user.id,
        "show",
        t.id,
        t.revision,
        now() + 3600,
      ),
      title: t.description.replace(/\s+/g, " ").slice(0, 24),
      description: format(t.due_date!),
    })),
  );
  if (tasks.length > page * 9 + 9)
    rows.push({
      id: await signControl(
        env,
        "recover",
        user.id,
        includeReviewed ? "pageall" : "page",
        page + 1,
        0,
        now() + 3600,
      ),
      title: "עוד משימות",
      description: "המשך הרשימה",
    });
  await sendInteractiveList(
    env,
    phone,
    `⏳ ${tasks.length} משימות באיחור — בחירת משימה לבדיקה`,
    rows,
  );
}
export async function recoveryCommand(
  env: Env,
  user: User,
  text: string,
  phone: string,
): Promise<string | null> {
  const cmd = text.trim().toLowerCase();
  if (["/recover", "/overdue", "משימות באיחור", "מה באיחור"].includes(cmd)) {
    await env.DB.prepare("DELETE FROM recovery_pending WHERE actor_id=?")
      .bind(user.id)
      .run();
    await showRecovery(env, user, phone);
    return "__handled__";
  }
  if (cmd === "/recover all") {
    await recoveryList(env, user, phone, 0, true);
    return "__handled__";
  }
  if (cmd === "/recover list") {
    await recoveryList(env, user, phone);
    return "__handled__";
  }
  if (cmd === "/recover cancel") {
    await env.DB.prepare("DELETE FROM recovery_pending WHERE actor_id=?")
      .bind(user.id)
      .run();
    return "קביעת הזמן בוטלה. המשימה נשארה כפי שהייתה.";
  }
  return null;
}
export async function handleRecoveryControl(
  env: Env,
  user: User,
  phone: string,
  payload: string,
): Promise<boolean> {
  const c = await verifyControl(env, payload, user.id);
  if (c?.kind !== "recover") return false;
  const [, action, id, revision, expiry] = c.values;
  if (
    ![
      "show",
      "page",
      "pageall",
      "keep",
      "reschedule",
      "cancel",
      "tomorrow",
      "week",
      "custom",
    ].includes(action) ||
    ![id, revision, expiry].every((v) => /^\d+$/.test(v ?? ""))
  )
    return false;
  if (+expiry <= now()) {
    await sendMessage(env, phone, "הבחירה פגה. /recover — בדיקה עדכנית.");
    return true;
  }
  if (action === "page" || action === "pageall") {
    await recoveryList(
      env,
      user,
      phone,
      Math.min(+id, 10000),
      action === "pageall",
    );
    return true;
  }
  const db = buildDb(env),
    assigned = await getAssignedTaskIds(db, user.id),
    task = await getTaskById(
      db,
      env.ENCRYPTION_KEY,
      +id,
      getAccessibleUserIds(user),
      assigned,
    );
  if (
    !task ||
    task.status !== "pending" ||
    task.revision !== +revision ||
    !task.due_date ||
    +task.due_date >= Date.now()
  ) {
    await sendMessage(
      env,
      phone,
      "המשימה השתנתה או שכבר אינה באיחור. /recover — בדיקה עדכנית.",
    );
    return true;
  }
  if (action === "show") {
    await recoveryCard(
      env,
      user,
      phone,
      task,
      (await overdueTasks(env, user, true)).length,
    );
    return true;
  }
  if (action === "keep") {
    const result = await env.DB.prepare(
      `INSERT INTO task_recovery(actor_id,task_id,revision,reviewed_at)
      SELECT ?,id,revision,? FROM task WHERE id=? AND revision=? AND status='pending' AND ${taskPermissionSql()}
      ON CONFLICT(actor_id,task_id) DO UPDATE SET revision=excluded.revision,reviewed_at=excluded.reviewed_at`,
    )
      .bind(user.id, now(), task.id, task.revision, user.id)
      .run();
    if (!result.meta.changes) {
      await sendMessage(env, phone, "המשימה השתנתה. לא בוצע שינוי.");
      return true;
    }
    await env.DB.prepare(
      "DELETE FROM recovery_pending WHERE actor_id=? AND task_id=?",
    )
      .bind(user.id, task.id)
      .run();
    await showRecovery(
      env,
      user,
      phone,
      false,
      `נשמרה ברשימה: *${task.description}*. המועד לא השתנה ולא נקבעה תזכורת חדשה.`,
    );
    return true;
  }
  if (action === "reschedule") {
    const buttons = await Promise.all(
      [
        ["tomorrow", "מחר ב־09:00"],
        ["week", "בעוד שבוע ב־09:00"],
        ["custom", "זמן אחר"],
      ].map(async ([a, title]) => ({
        id: await signControl(
          env,
          "recover",
          user.id,
          a,
          task.id,
          task.revision,
          +expiry,
        ),
        title,
      })),
    );
    await sendInteractiveButtons(
      env,
      phone,
      `📅 זמן חדש ל־*${task.description}*`,
      buttons,
    );
    return true;
  }
  if (action === "custom") {
    await env.DB.prepare("DELETE FROM task_schedule_pending WHERE actor_id=?").bind(user.id).run();
    await env.DB.prepare(
      "INSERT INTO recovery_pending(actor_id,task_id,revision,expires_at) VALUES (?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET task_id=excluded.task_id,revision=excluded.revision,expires_at=excluded.expires_at",
    )
      .bind(user.id, task.id, task.revision, now() + 900)
      .run();
    await sendMessage(
      env,
      phone,
      `📅 מתי לקבוע את *${task.description}*?\nיש להשיב בזמן בלבד, למשל ״מחר ב־10:00״ או ״בעוד שעתיים״.\nלביטול: /recover cancel. הבחירה תקפה ל־15 דקות.`,
    );
    return true;
  }
  const undo = { ...newUndoContext(user.id), expectedRevision: task.revision };
  let changed = false,
    text: string;
  if (action === "cancel") {
    changed = await trackedTaskMutation(
      env.DB,
      env.ENCRYPTION_KEY,
      undo,
      task.id,
      { status: "cancelled", recurrence: null, completed_at: now() },
    );
    text = `🚫 בוטלה: *${task.description}*`;
  } else {
    const local = nowInJerusalem();
    local.setDate(local.getDate() + (action === "week" ? 7 : 1));
    local.setHours(9, 0, 0, 0);
    const due = jerusalemLocalToUtc(local);
    changed = !!(await updateTaskById(
      db,
      env.ENCRYPTION_KEY,
      task.id,
      getAccessibleUserIds(user),
      { due_date: due },
      assigned,
      undo,
    ));
    text = `📅 *${task.description}* נקבעה ל־${format(due)}`;
  }
  if (changed)
    await env.DB.prepare(
      "DELETE FROM recovery_pending WHERE actor_id=? AND task_id=?",
    )
      .bind(user.id, task.id)
      .run();
  const msgId = await sendTaskReply(
    env,
    user.id,
    phone,
    changed
      ? text + "\nלהמשך הבדיקה: /recover"
      : "המשימה השתנתה. לא בוצע שינוי.",
    undo,
    changed ? task.id : undefined,
  );
  await saveMessage(db, env.ENCRYPTION_KEY, {
    userId: user.id,
    messageType: "button",
    content: action,
    aiResponse: changed ? text : "לא בוצע שינוי",
    parsedTasks: changed
      ? { tasks: [{ task_id: task.id, description: task.description }] }
      : null,
    whatsappMessageId: msgId,
  });
  return true;
}
export async function continueRecovery(
  env: Env,
  user: User,
  phone: string,
  text: string,
): Promise<boolean> {
  if (
    !/^(?:היום|מחר|מחרתיים|בעוד|עוד|ביום|יום |ב[-־ ]?\d|\d{1,2}[:/.-]|דחה |תזכיר (?:לי )?שוב)/u.test(
      text.trim(),
    )
  )
    return false;
  const pending = await env.DB.prepare(
    "SELECT * FROM recovery_pending WHERE actor_id=? AND expires_at>?",
  )
    .bind(user.id, now())
    .first<{ task_id: number; revision: number }>();
  if (!pending) return false;
  const db = buildDb(env),
    assigned = await getAssignedTaskIds(db, user.id),
    task = await getTaskById(
      db,
      env.ENCRYPTION_KEY,
      pending.task_id,
      getAccessibleUserIds(user),
      assigned,
    );
  if (
    !task ||
    task.status !== "pending" ||
    task.revision !== pending.revision
  ) {
    await env.DB.prepare("DELETE FROM recovery_pending WHERE actor_id=?")
      .bind(user.id)
      .run();
    await sendMessage(
      env,
      phone,
      "המשימה השתנתה מאז הבחירה. /recover — בחירה מחדש.",
    );
    return true;
  }
  let due: Date | null = null;
  try {
    const parsed = await processMessage(env, {
      userMessage: text,
      stats: { pending: 1, completed: 0 },
      history: [],
      pendingTasks: [task.description],
      quotedBotReply: `קביעת זמן חדש למשימה: ${task.description}. החזר רק update עם new_due_date; הזמן החדש הוא תשובת המשתמש.`,
    });
    if (
      parsed.tasks.length === 1 &&
      ["add", "update"].includes(parsed.tasks[0].action)
    )
      due = parseDueDate(
        parsed.tasks[0].new_due_date ?? parsed.tasks[0].due_date,
      );
  } catch {
    await sendMessage(
      env,
      phone,
      "לא ניתן להבין את הזמן כרגע. אפשר לנסות שוב או /recover cancel.",
    );
    return true;
  }
  if (!due || +due <= Date.now()) {
    await sendMessage(
      env,
      phone,
      "יש לציין זמן עתידי, למשל ״מחר ב־10:00״. המשימה עדיין לא השתנתה.",
    );
    return true;
  }
  const undo = {
    ...newUndoContext(user.id),
    expectedRevision: pending.revision,
  };
  const changed = await updateTaskById(
    db,
    env.ENCRYPTION_KEY,
    task.id,
    getAccessibleUserIds(user),
    { due_date: due },
    assigned,
    undo,
  );
  if (changed)
    await env.DB.prepare(
      "DELETE FROM recovery_pending WHERE actor_id=? AND task_id=? AND revision=?",
    )
      .bind(user.id, task.id, pending.revision)
      .run();
  const reply = changed
    ? `📅 *${task.description}* נקבעה ל־${format(due)}\nלהמשך הבדיקה: /recover`
    : "המשימה השתנתה בזמן הפעולה. לא בוצע שינוי.";
  const msgId = await sendTaskReply(
    env,
    user.id,
    phone,
    reply,
    undo,
    changed?.id,
  );
  await saveMessage(db, env.ENCRYPTION_KEY, {
    userId: user.id,
    messageType: "text",
    content: text,
    aiResponse: reply,
    parsedTasks: changed
      ? { tasks: [{ task_id: task.id, description: task.description }] }
      : null,
    whatsappMessageId: msgId,
  });
  return true;
}
