import { maybeOfferShare } from "./sharing.ts";
import { recurrenceLabel } from "./recurrence.ts";
import type { Env } from "../types.ts";
import type { Task, User } from "../db/schema.ts";
import { buildDb } from "../db/client.ts";
import {
  getAccessibleUserIds,
  getAssignedTaskIds,
  getTaskById,
  completeTask,
  snoozeTask,
  scheduleNextRecurrence,
  addTask,
  saveMessage,
} from "../db/queries.ts";
import { sendMessage, sendInteractiveButtons } from "./whatsapp.ts";
import {
  newUndoContext,
  availableUndo,
  undoTasks,
  type UndoContext,
} from "./task_undo.ts";
import { signControl, verifyControl } from "./controls.ts";
import { nowInJerusalem, jerusalemLocalToUtc } from "../time.ts";
import { TZ } from "../constants.ts";

export const undoCommands = new Set([
  "/undo",
  "undo",
  "בטל פעולה אחרונה",
  "בטל את הפעולה האחרונה",
]);
export async function reminderButtons(
  env: Env,
  actorId: number,
  task: Pick<Task, "id" | "revision">,
) {
  return Promise.all(
    [
      ["done", "הושלם ✅"],
      ["snooze", "עוד 30 דקות"],
      ["tomorrow", "מחר"],
    ].map(async ([action, title]) => ({
      id: await signControl(
        env,
        "task",
        actorId,
        task.id,
        task.revision,
        action,
        Math.floor(Date.now() / 1000) + 604800,
      ),
      title,
    })),
  );
}

export async function sendTaskReply(
  env: Env,
  userId: number,
  phone: string,
  text: string,
  context?: UndoContext,
  taskId?: number,
): Promise<string | null> {
  const groupId = context?.changedTaskIds?.length
    ? await availableUndo(env, userId, context.groupId)
    : null;
  if (!groupId) return sendMessage(env, phone, text);
  const buttons = [
    {
      id: await signControl(env, "undo", userId, groupId),
      title: "ביטול הפעולה ↩️",
    },
  ];
  if (taskId) {
    const user = await buildDb(env).query.users.findFirst({
      where: (u, { eq }) => eq(u.id, userId),
    });
    if (user) {
      const task = await getTaskById(
        buildDb(env),
        env.ENCRYPTION_KEY,
        taskId,
        getAccessibleUserIds(user),
        await getAssignedTaskIds(buildDb(env), userId),
      );
      if (task?.status === "pending") {
        buttons.unshift(
          ...(await taskActionButtons(env, userId, task)).slice(0, 2),
        );
      }
    }
  }
  // Keep the complete result readable while respecting the interactive body's 1024-character limit.
  let buttonText = text;
  if (text.length > 1024) {
    const fullId = await sendMessage(env, phone, text);
    await saveMessage(buildDb(env), env.ENCRYPTION_KEY, {
      userId,
      messageType: "system",
      content: "task result",
      aiResponse: text,
      parsedTasks: taskId ? { tasks: [{ task_id: taskId }] } : null,
      whatsappMessageId: fullId,
    });
    buttonText =
      "אפשר להשתמש בכפתורים למטה כדי לנהל את המשימה או לבטל את הפעולה.";
  }
  // Free-form buttons are sent only in direct response to an inbound message.
  try {
    return await sendInteractiveButtons(env, phone, buttonText, buttons);
  } catch {
    return sendMessage(
      env,
      phone,
      `${text}\n↩️ /undo — ביטול הפעולה האחרונה (10 דקות)`,
    );
  }
}

export async function handleTaskControl(
  env: Env,
  user: User,
  phone: string,
  payload: string,
): Promise<boolean> {
  const control = await verifyControl(env, payload, user.id);
  if (!control || !["task", "undo"].includes(control.kind)) return false;
  if (control.kind === "undo") {
    if (!/^[a-f0-9]{32}$/.test(control.values[1] ?? "")) return false;
    await sendMessage(
      env,
      phone,
      await undoTasks(env, user.id, control.values[1]),
    );
    return true;
  }
  const [, id, revision, action, expiry] = control.values;
  if (
    !/^\d+$/.test(id ?? "") ||
    !/^\d+$/.test(revision ?? "") ||
    !["done", "snooze", "tomorrow"].includes(action)
  )
    return false;
  if (
    !/^\d+$/.test(expiry ?? "") ||
    Number(expiry) <= Math.floor(Date.now() / 1000)
  ) {
    await sendMessage(env, phone, "הכפתור פג. שלח ? להצגת המשימות העדכניות.");
    return true;
  }
  const db = buildDb(env);
  const assigned = await getAssignedTaskIds(db, user.id);
  const accessible = getAccessibleUserIds(user);
  const task = await getTaskById(
    db,
    env.ENCRYPTION_KEY,
    Number(id),
    accessible,
    assigned,
  );
  const recurringOccurrence =
    task?.status === "completed" &&
    !!task.recurrence &&
    task.revision === Number(revision) + 1;
  if (!task || (task.revision !== Number(revision) && !recurringOccurrence)) {
    await sendMessage(
      env,
      phone,
      "המשימה השתנתה מאז ההודעה, או שאינה זמינה. שלח ? לבדיקת המשימות.",
    );
    return true;
  }
  if (task.status !== "pending" && !recurringOccurrence) {
    await sendMessage(
      env,
      phone,
      `המשימה *${task.description}* כבר אינה ממתינה.`,
    );
    return true;
  }
  const context = {
    ...newUndoContext(user.id),
    expectedRevision: task.revision,
  };
  let result: Task | null = null;
  let text: string;
  if (action === "done") {
    if (recurringOccurrence) {
      await sendMessage(
        env,
        phone,
        `ההופעה הזו של *${task.description}* כבר הושלמה; החזרה הבאה נשארת כרגיל.`,
      );
      await maybeOfferShare(env,user,phone,{taskId:task.id}).catch(()=>{});
      return true;
    }
    result = await completeTask(
      db,
      env.ENCRYPTION_KEY,
      task.id,
      accessible,
      assigned,
      context,
    );
    if (result?.recurrence)
      await scheduleNextRecurrence(db, env.ENCRYPTION_KEY, result, context);
    text = result
      ? `✅ הושלמה: *${result.description}*`
      : "המשימה השתנתה בזמן הפעולה. לא בוצע שינוי.";
  } else {
    if (recurringOccurrence) {
      const claim = await env.DB.prepare(
        "INSERT OR IGNORE INTO task_control_use (key, actor_user_id, expires_at) VALUES (?, ?, ?)",
      )
        .bind(
          `recurring:${user.id}:${task.id}:${revision}`,
          user.id,
          Number(expiry),
        )
        .run();
      if (!claim.meta.changes) {
        await sendMessage(
          env,
          phone,
          "כבר נקבעה תזכורת נוספת להופעה הזו. שלח ? לבדיקת המשימות.",
        );
        return true;
      }
    }
    let due = new Date(Date.now() + 30 * 60000);
    if (action === "tomorrow") {
      const local = nowInJerusalem();
      local.setDate(local.getDate() + 1);
      if (task.due_date) {
        const old = new Date(
          task.due_date.toLocaleString("en-US", { timeZone: TZ }),
        );
        local.setHours(old.getHours(), old.getMinutes(), 0, 0);
      } else local.setHours(9, 0, 0, 0);
      due = jerusalemLocalToUtc(local);
    }
    // Auto-completed recurring reminders can be postponed once without duplicating the recurrence chain.
    result = recurringOccurrence
      ? await addTask(
          db,
          env.ENCRYPTION_KEY,
          user.id,
          task.description,
          due,
          null,
          context,
        )
      : await snoozeTask(
          db,
          env.ENCRYPTION_KEY,
          task.id,
          accessible,
          due,
          assigned,
          context,
        );
    text = result
      ? `⏰ *${result.description}* ${recurringOccurrence ? "תוזכר שוב" : "נדחתה"} ב־${due.toLocaleString("he-IL", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
      : "המשימה השתנתה בזמן הפעולה. לא בוצע שינוי.";
  }
  const msgId = await sendTaskReply(
    env,
    user.id,
    phone,
    text,
    context,
    result?.id,
  );
  await saveMessage(db, env.ENCRYPTION_KEY, {
    userId: user.id,
    messageType: "button",
    content: action,
    aiResponse: text,
    parsedTasks: result
      ? { tasks: [{ task_id: result.id, description: result.description }] }
      : null,
    whatsappMessageId: msgId,
  });
  if(action==='done')await maybeOfferShare(env,user,phone,{taskId:task.id}).catch(()=>{});
  return true;
}

/** Management buttons adapt to the task; delivered reminder/template buttons stay compatible. */
export async function taskActionButtons(
  env: Env,
  actorId: number,
  task: Pick<Task, "id" | "revision" | "due_date">,
) {
  const expiry = Math.floor(Date.now() / 1000) + 604800;
  return [
    {
      id: await signControl(
        env,
        "task",
        actorId,
        task.id,
        task.revision,
        "done",
        expiry,
      ),
      title: "הושלם ✅",
    },
    {
      id: await signControl(
        env,
        "schedule",
        actorId,
        task.id,
        task.revision,
        "choose",
        expiry,
      ),
      title: task.due_date ? "שנה זמן" : "קבע תזכורת",
    },
    {
      id: await signControl(
        env,
        "schedule",
        actorId,
        task.id,
        task.revision,
        "cancel",
        expiry,
      ),
      title: "בטל משימה",
    },
  ];
}
export async function showTaskDetails(
  env: Env,
  user: User,
  phone: string,
  task: Task,
  projectName?: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM task_schedule_pending WHERE actor_id=?").bind(
      user.id,
    ),
    env.DB.prepare("DELETE FROM recovery_pending WHERE actor_id=?").bind(
      user.id,
    ),
  ]);
  const text = `📋 *${task.description}*${projectName ? "\n🗂️ " + projectName : ""}\n${task.due_date ? "⏰ " + task.due_date.toLocaleString("he-IL", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "ללא תזכורת בשעה מסוימת"}${task.recurrence ? "\n🔁 "+recurrenceLabel(task.recurrence) : ""}`;
  if (text.length > 1024) {
    const fullId = await sendMessage(env, phone, text);
    await saveMessage(buildDb(env), env.ENCRYPTION_KEY, {
      userId: user.id,
      messageType: "button",
      content: "task selected",
      aiResponse: text,
      parsedTasks: {
        tasks: [{ task_id: task.id, description: task.description }],
      },
      whatsappMessageId: fullId,
    });
  }
  const id = await sendInteractiveButtons(
    env,
    phone,
    text.length <= 1024
      ? text
      : "פעולות למשימה: " + task.description.slice(0, 180) + "…",
    await taskActionButtons(env, user.id, task),
  );
  await saveMessage(buildDb(env), env.ENCRYPTION_KEY, {
    userId: user.id,
    messageType: "button",
    content: "task selected",
    aiResponse: text,
    parsedTasks: {
      tasks: [{ task_id: task.id, description: task.description }],
    },
    whatsappMessageId: id,
  });
}
