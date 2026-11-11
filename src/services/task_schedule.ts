import type { Env } from "../types.ts";
import type { User, Task } from "../db/schema.ts";
import { buildDb } from "../db/client.ts";
import {
  getAccessibleUserIds,
  getAssignedTaskIds,
  getTaskById,
  saveMessage,
} from "../db/queries.ts";
import { signControl, verifyControl } from "./controls.ts";
import {
  sendMessage,
  sendInteractiveList,
  sendInteractiveButtons,
} from "./whatsapp.ts";
import { newUndoContext, trackedTaskMutation } from "./task_undo.ts";
import { sendTaskReply } from "./task_controls.ts";
import { nowInJerusalem, jerusalemLocalToUtc, parseDueDate } from "../time.ts";
import { processMessage } from "./gemini.ts";
import { TZ } from "../constants.ts";
const now = () => Math.floor(Date.now() / 1000);
const format = (due: Date) =>
  due.toLocaleString("he-IL", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
type Pending = {
  task_id: number;
  revision: number;
  request_id: string;
  prompt_message_id: string | null;
  expires_at: number;
};
function localDue(local: Date): Date | null {
  const due = jerusalemLocalToUtc(local),
    roundtrip = new Date(due.toLocaleString("en-US", { timeZone: TZ }));
  return local.getFullYear() === roundtrip.getFullYear() &&
    local.getMonth() === roundtrip.getMonth() &&
    local.getDate() === roundtrip.getDate() &&
    local.getHours() === roundtrip.getHours() &&
    local.getMinutes() === roundtrip.getMinutes()
    ? due
    : null;
}
export function presetDue(action: string): Date | null {
  if (action === "half" || action === "hour")
    return new Date(Date.now() + (action === "half" ? 30 : 60) * 60000);
  const local = nowInJerusalem();
  if (action === "morning") local.setDate(local.getDate() + 1);
  else if (action !== "evening") return null;
  local.setHours(action === "morning" ? 9 : 20, 0, 0, 0);
  return localDue(local);
}
export async function showTimeChoices(
  env: Env,
  user: User,
  phone: string,
  task: Task,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM task_schedule_pending WHERE actor_id=?").bind(
      user.id,
    ),
    env.DB.prepare("DELETE FROM recovery_pending WHERE actor_id=?").bind(
      user.id,
    ),
  ]);
  const choices = [
    ["evening", "היום בערב · 20:00"],
    ["morning", "מחר בבוקר · 09:00"],
    ["half", "בעוד 30 דקות"],
    ["hour", "בעוד שעה"],
    ["custom", "זמן אחר"],
  ];
  const expiry = now() + 900;
  const rows = [];
  for (const [action, title] of choices) {
    const due = presetDue(action);
    if (action !== "custom" && (!due || +due <= Date.now())) continue;
    // Absolute UTC seconds bind presets to the date shown, even if a user clicks after midnight.
    rows.push({
      id: await signControl(
        env,
        "schedule",
        user.id,
        task.id,
        task.revision,
        action === "custom" ? "custom" : String(Math.floor(+due! / 1000)),
        expiry,
      ),
      title,
      description: due ? format(due) : "כתוב או הקלט מתי להזכיר",
    });
  }
  await sendInteractiveList(
    env,
    phone,
    `⏰ ${task.due_date ? "שינוי זמן" : "קביעת תזכורת"} ל־*${task.description.slice(0, 800)}*\nבחר מועד. המשימה תשתנה רק לאחר הבחירה.`,
    rows,
    { button: "בחירת זמן", sectionTitle: "מתי להזכיר?" },
  );
}
async function currentTask(
  env: Env,
  user: User,
  phone: string,
  id: number,
  revision: number,
): Promise<Task | null> {
  const db = buildDb(env),
    task = await getTaskById(
      db,
      env.ENCRYPTION_KEY,
      id,
      getAccessibleUserIds(user),
      await getAssignedTaskIds(db, user.id),
    );
  if (!task || task.status !== "pending" || task.revision !== revision) {
    await sendMessage(
      env,
      phone,
      "המשימה השתנתה או אינה זמינה. שלח ? לבחירה עדכנית.",
    );
    return null;
  }
  return task;
}
async function changeTask(
  env: Env,
  user: User,
  phone: string,
  task: Task,
  due: Date | null,
  content: string,
  pending?: Pending,
): Promise<void> {
  const undo = { ...newUndoContext(user.id), expectedRevision: task.revision };
  const changed = await trackedTaskMutation(
    env.DB,
    env.ENCRYPTION_KEY,
    undo,
    task.id,
    due
      ? { due_date: Math.floor(+due / 1000), reminder_sent: 0 }
      : { status: "cancelled", recurrence: null, completed_at: now() },
  );
  if (changed)
    await env.DB.prepare(
      "DELETE FROM task_schedule_pending WHERE actor_id=?" +
        (pending ? " AND request_id=?" : ""),
    )
      .bind(...(pending ? [user.id, pending.request_id] : [user.id]))
      .run();
  const text = changed
    ? due
      ? `⏰ *${task.description}* ${task.due_date ? "נקבעה מחדש" : "תוזכר"} ב־${format(due)}`
      : `🚫 בוטלה: *${task.description}*`
    : "המשימה השתנתה בזמן הפעולה. לא בוצע שינוי.";
  const id = await sendTaskReply(
    env,
    user.id,
    phone,
    text,
    undo,
    changed ? task.id : undefined,
  );
  await saveMessage(buildDb(env), env.ENCRYPTION_KEY, {
    userId: user.id,
    messageType: "button",
    content,
    aiResponse: text,
    parsedTasks: changed
      ? { tasks: [{ task_id: task.id, description: task.description }] }
      : null,
    whatsappMessageId: id,
  });
}
export async function handleTaskSchedule(
  env: Env,
  user: User,
  phone: string,
  payload: string,
): Promise<boolean> {
  const c = await verifyControl(env, payload, user.id);
  if (!c || !["schedule", "timecancel"].includes(c.kind)) return false;
  if (c.kind === "timecancel") {
    const [, request, expiry] = c.values;
    if (
      c.values.length !== 3 ||
      !/^\w{32}$/.test(request ?? "") ||
      !/^\d+$/.test(expiry ?? "")
    )
      return false;
    if (+expiry <= now()) {
      await sendMessage(env, phone, "בחירת הזמן פגה. שלח ? לבחירה חדשה.");
      return true;
    }
    const result = await env.DB.prepare(
      "DELETE FROM task_schedule_pending WHERE actor_id=? AND request_id=?",
    )
      .bind(user.id, request)
      .run();
    await sendMessage(
      env,
      phone,
      result.meta.changes
        ? "בחירת הזמן בוטלה. המשימה לא השתנתה."
        : "בחירת הזמן הזו כבר הסתיימה.",
    );
    return true;
  }
  const [, id, revision, action, expiry] = c.values;
  if (
    c.values.length !== 5 ||
    ![id, revision, expiry].every(
      (v) => /^\d+$/.test(v ?? "") && Number.isSafeInteger(+v),
    ) ||
    (!["choose", "custom", "cancel"].includes(action) &&
      !/^\d{1,12}$/.test(action ?? ""))
  )
    return false;
  if (+expiry <= now()) {
    await sendMessage(env, phone, "הבחירה פגה. שלח ? לבחירה עדכנית.");
    return true;
  }
  const task = await currentTask(env, user, phone, +id, +revision);
  if (!task) return true;
  if (action === "choose") {
    await showTimeChoices(env, user, phone, task);
    return true;
  }
  if (action === "custom") {
    const request = crypto.randomUUID().replaceAll("-", "");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM recovery_pending WHERE actor_id=?").bind(
        user.id,
      ),
      env.DB.prepare(
        "INSERT INTO task_schedule_pending(actor_id,task_id,revision,request_id,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET task_id=excluded.task_id,revision=excluded.revision,request_id=excluded.request_id,prompt_message_id=NULL,expires_at=excluded.expires_at",
      ).bind(user.id, task.id, task.revision, request, now() + 900),
    ]);
    const text = `⏰ מתי להזכיר לך *${task.description.slice(0, 750)}*?\nכתוב או הקלט רק את הזמן, למשל ״מחר ב־10:00״ או ״בעוד שעתיים״.\nהמשימה לא תשתנה עד לקביעת הזמן. הבחירה תקפה ל־15 דקות.`;
    const promptId = await sendInteractiveButtons(env, phone, text, [
      {
        id: await signControl(env, "timecancel", user.id, request, now() + 900),
        title: "ביטול בחירת הזמן",
      },
    ]);
    await env.DB.prepare(
      "UPDATE task_schedule_pending SET prompt_message_id=? WHERE actor_id=? AND request_id=?",
    )
      .bind(promptId, user.id, request)
      .run();
    return true;
  }
  const due = action === "cancel" ? null : new Date(+action * 1000);
  if (
    action !== "cancel" &&
    (!due ||
      !Number.isFinite(+due) ||
      +due <= Date.now() ||
      due.getUTCFullYear() > 2100)
  ) {
    await sendMessage(
      env,
      phone,
      "המועד כבר עבר. לחץ על ״שנה זמן״ או שלח ? לבחירה חדשה.",
    );
    return true;
  }
  await changeTask(env, user, phone, task, due, action);
  return true;
}
// Only time-only replies may enter a selected task's draft. Task names or action requests stay in normal chat.
export function isTimeOnlyReply(text: string): boolean {
  const clean = text
    .trim()
    .replace(/ב[־–-]/g, "ב ")
    .replace(/\s+/g, " ");
  if (!clean || clean.length > 160) return false;
  const words = new Set(
    "היום מחר מחרתיים יום ביום ראשון שני שלישי רביעי חמישי שישי שבת בעוד עוד דקה דקות שעה שעות שעתיים יום ימים יומיים שבוע שבועות חצי רבע אחת אחד שתיים שתי שניים שלוש שלושה ארבע ארבעה חמש חמישה שש שישה שבע שבעה שמונה תשע תשעה עשר עשרה אחתעשרה שתיםעשרה וחצי ורבע ב בבוקר בצהריים בערב בלילה חצות".split(
      " ",
    ),
  );
  return clean
    .split(" ")
    .every(
      (w) =>
        /^\d{1,4}(?::\d{2}|\/\d{1,2}(?:\/\d{4})?)?$/.test(
          w.replace(/^ב/, ""),
        ) ||
        words.has(w) ||
        words.has(w.replace(/^[בל]/, "")),
    );
}
export function parseSimpleTime(text: string): Date | null {
  const clean = text
    .trim()
    .replace(/ב[־–-]/g, "ב ")
    .replace(/\s+/g, " ");
  const relative = clean.match(
    /^(?:בעוד|עוד) ?(?:(\d+) (דקה|דקות|שעה|שעות|יום|ימים)|(דקה|שעה|שעתיים|יום|יומיים|שבוע|חצי שעה|רבע שעה))$/u,
  );
  if (relative) {
    const singles: Record<string, number> = {
      דקה: 60,
      שעה: 3600,
      שעתיים: 7200,
      יום: 86400,
      שבוע: 604800,
      יומיים: 172800,
      "חצי שעה": 1800,
      "רבע שעה": 900,
    };
    const seconds = relative[3]
      ? singles[relative[3]]
      : +relative[1] *
        (relative[2].startsWith("דק")
          ? 60
          : relative[2].startsWith("שע")
            ? 3600
            : 86400);
    return seconds > 0 && seconds < 2.3e9
      ? new Date(Date.now() + seconds * 1000)
      : null;
  }
  const date = clean.match(
    /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))? (?:ב ?)?(\d{1,2}):(\d{2})$/u,
  );
  if (date) {
    const local = nowInJerusalem(),
      year = date[3] ? +date[3] : local.getFullYear();
    const day = +date[1],
      month = +date[2],
      hour = +date[4],
      minute = +date[5];
    if (year < 2000 || year > 2100 || hour > 23 || minute > 59) return null;
    local.setFullYear(year, month - 1, day);
    local.setHours(hour, minute, 0, 0);
    if (
      local.getFullYear() !== year ||
      local.getMonth() !== month - 1 ||
      local.getDate() !== day ||
      local.getHours() !== hour ||
      local.getMinutes() !== minute
    )
      return null;
    return localDue(local);
  }
  const clock = clean.match(
    /^(?:(היום|מחר|מחרתיים) )?(?:ב ?)?(\d{1,2})(?::(\d{2}))?$/u,
  );
  if (!clock || +clock[2] > 23 || +(clock[3] ?? 0) > 59) return null;
  const local = nowInJerusalem();
  local.setDate(
    local.getDate() + (clock[1] === "מחר" ? 1 : clock[1] === "מחרתיים" ? 2 : 0),
  );
  local.setHours(+clock[2], +(clock[3] ?? 0), 0, 0);
  if (local.getHours() !== +clock[2] || local.getMinutes() !== +(clock[3] ?? 0))
    return null;
  let due = localDue(local);
  if (!clock[1] && due && +due <= Date.now()) {
    local.setDate(local.getDate() + 1);
    due = localDue(local);
  }
  return due;
}
export async function continueTaskSchedule(
  env: Env,
  user: User,
  phone: string,
  text: string,
  quotedMsgId?: string,
): Promise<boolean> {
  const cancel = /^(?:ביטול|עזוב)$/u.test(text.trim());
  if (!cancel && !isTimeOnlyReply(text)) return false;
  const pending = await env.DB.prepare(
    "SELECT * FROM task_schedule_pending WHERE actor_id=?",
  )
    .bind(user.id)
    .first<Pending>();
  if (!pending) return false;
  if (quotedMsgId && quotedMsgId !== pending.prompt_message_id) return false;
  if (pending.expires_at <= now()) {
    await env.DB.prepare(
      "DELETE FROM task_schedule_pending WHERE actor_id=? AND request_id=?",
    )
      .bind(user.id, pending.request_id)
      .run();
    await sendMessage(env, phone, "בחירת הזמן פגה. שלח ? ובחר שוב את המשימה.");
    return true;
  }
  if (cancel) {
    await env.DB.prepare(
      "DELETE FROM task_schedule_pending WHERE actor_id=? AND request_id=?",
    )
      .bind(user.id, pending.request_id)
      .run();
    await sendMessage(env, phone, "בחירת הזמן בוטלה. המשימה לא השתנתה.");
    return true;
  }
  const task = await currentTask(
    env,
    user,
    phone,
    pending.task_id,
    pending.revision,
  );
  if (!task) {
    await env.DB.prepare(
      "DELETE FROM task_schedule_pending WHERE actor_id=? AND request_id=?",
    )
      .bind(user.id, pending.request_id)
      .run();
    return true;
  }
  let due = parseSimpleTime(text);
  // Malformed numeric times never fall through to a model that could guess a correction.
  const invalidClock = Array.from(text.matchAll(/(\d{1,2}):(\d{2})/g)).some(
    (m) => +m[1] > 23 || +m[2] > 59,
  );
  const explicitDate = /\d{1,2}\/\d{1,2}/.test(text);
  const invalidRelative = /^(?:בעוד|עוד)\s*\d/u.test(text) && !due;
  const simpleClock =
    /^(?:(?:היום|מחר|מחרתיים) )?(?:ב ?)?\d{1,2}(?::\d{2})?$/.test(
      text
        .trim()
        .replace(/ב[־–-]/g, "ב ")
        .replace(/\s+/g, " "),
    );
  const explicitTime =
    /(?:בעוד|עוד)|\d{1,2}:\d{2}|(?:ב|בשעה )(?:אחת|שתיים|שלוש|ארבע|חמש|שש|שבע|שמונה|תשע|עשר)|חצות/u.test(
      text,
    );
  if (
    !due &&
    !simpleClock &&
    !invalidClock &&
    !explicitDate &&
    !invalidRelative &&
    explicitTime
  ) {
    try {
      const parsed = await processMessage(env, {
        userMessage: text,
        stats: { pending: 1, completed: 0 },
        history: [],
        pendingTasks: [task.description],
        quotedBotReply:
          "המשתמש קובע זמן למשימה שנבחרה. החזר רק update עם new_due_date, ללא שינוי בשם או בחזרה. אם אין שעה ברורה, בקש שעה. אל תניח שעה לבוקר או לערב.",
      });
      if (
        parsed.tasks.length === 1 &&
        ["add", "update"].includes(parsed.tasks[0].action)
      ) {
        const raw = parsed.tasks[0].new_due_date ?? parsed.tasks[0].due_date;
        due = parseDueDate(raw);
        if (
          due &&
          due.toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16) !== raw
        )
          due = null;
      }
    } catch {
      await sendMessage(
        env,
        phone,
        "לא ניתן להבין את הזמן כרגע. אפשר לנסות ״מחר ב־10:00״ או ללחוץ על ביטול בחירת הזמן.",
      );
      return true;
    }
  }
  if (!due || +due <= Date.now() || due.getUTCFullYear() > 2100) {
    await sendMessage(
      env,
      phone,
      "יש לציין שעה עתידית ברורה, למשל ״מחר ב־10:00״. המשימה עדיין לא השתנתה.",
    );
    return true;
  }
  await changeTask(env, user, phone, task, due, text, pending);
  return true;
}
