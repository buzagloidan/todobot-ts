import type { Env } from "../types.ts";
import type { Task, User } from "../db/schema.ts";
import { buildDb } from "../db/client.ts";
import {
  getAccessibleUserIds,
  getAssignedTaskIds,
  getUserTasks,
  getUserById,
  decryptPhone,
  saveMessage,
} from "../db/queries.ts";
import {
  sendMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendAgendaTemplate,
} from "./whatsapp.ts";
import { hasAccess } from "./billing.ts";
import { signControl, verifyControl } from "./controls.ts";
import { sortTasksByDueDate } from "../task_format.ts";
import { taskPermissionSql } from "./task_undo.ts";
import { TZ } from "../constants.ts";

type Preferences = {
  user_id: number;
  enabled: number;
  time: string;
  days: string;
  next_send_at: number;
  last_sent_date: string | null;
  revision: number;
  last_error: string | null;
};
const now = () => Math.floor(Date.now() / 1000);
const localFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function localParts(seconds: number) {
  return Object.fromEntries(
    localFormatter
      .formatToParts(new Date(seconds * 1000))
      .map((p) => [p.type, p.value]),
  );
}
export function localDateKey(seconds = now()): string {
  const p = localParts(seconds);
  return `${p.year}-${p.month}-${p.day}`;
}
function wallTime(date: string, time: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const offsets = new Set<number>();
  for (const probe of [wall - 43200, wall + 43200]) {
    const p = localParts(probe);
    offsets.add(
      Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 1000 -
        probe,
    );
  }
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .sort((a, b) => a - b);
  const exact = candidates.filter((candidate) => {
    const p = localParts(candidate);
    return localDateKey(candidate) === date && `${p.hour}:${p.minute}` === time;
  });
  if (exact.length) return exact[0]; // First occurrence on the autumn clock change; daily dedup prevents a second send.
  const later = candidates.find((candidate) => {
    const p = localParts(candidate);
    return localDateKey(candidate) === date && `${p.hour}:${p.minute}` > time;
  });
  if (later !== undefined) return later; // Spring gap: shift to the valid later local time.
  throw new Error("Invalid agenda wall time");
}
export function nextAgendaAt(
  time: string,
  days: string,
  after = now(),
): number {
  const [year, month, day] = localDateKey(after).split("-").map(Number);
  for (let offset = 0; offset < 8; offset++) {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    if (days === "weekdays" && [5, 6].includes(date.getUTCDay())) continue; // Israel: Sunday–Thursday.
    const key = date.toISOString().slice(0, 10);
    const candidate = wallTime(key, time);
    if (candidate > after) return candidate;
  }
  throw new Error("Invalid agenda schedule");
}
const preferences = (env: Env, userId: number) =>
  env.DB.prepare("SELECT * FROM agenda_preferences WHERE user_id=?")
    .bind(userId)
    .first<Preferences>();
async function accessibleTasks(env: Env, user: User): Promise<Task[]> {
  const db = buildDb(env);
  return sortTasksByDueDate(
    await getUserTasks(
      db,
      env.ENCRYPTION_KEY,
      getAccessibleUserIds(user),
      "pending",
      await getAssignedTaskIds(db, user.id),
    ),
  );
}
function dayBounds(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return {
    start: wallTime(date, "00:00"),
    end: wallTime(
      new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10),
      "00:00",
    ),
  };
}
async function agendaData(env: Env, user: User, date = localDateKey()) {
  const tasks = await accessibleTasks(env, user);
  const bounds = dayBounds(date);
  const today = tasks.filter(
    (t) =>
      t.due_date &&
      +t.due_date >= bounds.start * 1000 &&
      +t.due_date < bounds.end * 1000,
  );
  const overdue = tasks.filter(
    (t) => t.due_date && +t.due_date < bounds.start * 1000,
  );
  const ids = (
    await env.DB.prepare(
      "SELECT task_id FROM agenda_priority WHERE user_id=? AND local_date=?",
    )
      .bind(user.id, date)
      .all<{ task_id: number }>()
  ).results.map((r) => r.task_id);
  const priorities = tasks.filter((t) => ids.includes(t.id));
  return { tasks, today, overdue, priorities };
}
function taskLine(task: Task) {
  const time = task.due_date
    ? task.due_date.toLocaleString("he-IL", {
        timeZone: TZ,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "ללא שעה";
  return `• ${task.description.replace(/\s+/g, " ").slice(0, 120)} — ${time}`;
}
export async function agendaText(env: Env, user: User): Promise<string> {
  const data = await agendaData(env, user);
  const lines = [
    "☀️ *סדר היום שלך*",
    `להיום: ${data.today.length} | באיחור: ${data.overdue.length}`,
  ];
  if (data.priorities.length)
    lines.push("\n⭐ *עדיפויות להיום*", ...data.priorities.map(taskLine));
  if (data.today.length)
    lines.push("\n📅 *היום*", ...data.today.slice(0, 10).map(taskLine));
  if (data.overdue.length)
    lines.push("\n⏳ *באיחור*", ...data.overdue.slice(0, 8).map(taskLine));
  if (!data.today.length && !data.overdue.length)
    lines.push("אין משימות מתוזמנות להיום או באיחור 🎉");
  const unscheduled = data.tasks.filter((t) => !t.due_date).length;
  if (unscheduled)
    lines.push(`\n${unscheduled} משימות ללא שעה — שלח ? לרשימה.`);
  if (data.today.length > 10 || data.overdue.length > 8)
    lines.push("\nלכל המשימות: ?");
  if(data.overdue.length)lines.push('\n⏳ /recover — בדיקת משימות באיחור: להשאיר, לקבוע מחדש או לבטל');
  lines.push(
    "\n/agenda focus — בחירת עד 3 עדיפויות\n/agenda clear — ניקוי העדיפויות להיום",
  );
  return lines.join("\n");
}
export async function showPriorityPicker(
  env: Env,
  user: User,
  phone: string,
  page = 0,
): Promise<void> {
  const data = await agendaData(env, user);
  const date = localDateKey();
  if (data.priorities.length >= 3) {
    await sendMessage(
      env,
      phone,
      "כבר נבחרו 3 עדיפויות להיום. /agenda clear — ניקוי ובחירה מחדש.",
    );
    return;
  }
  const selected = new Set(data.priorities.map((t) => t.id));
  const tasks = data.tasks.filter((t) => !selected.has(t.id));
  if (!tasks.length) {
    await sendMessage(env, phone, "אין עוד משימות ממתינות לבחירה.");
    return;
  }
  const start = page * 9;
  const rows = await Promise.all(
    tasks
      .slice(start, start + 9)
      .map(async (task) => ({
        id: await signControl(env, "agenda", user.id, date, "pick", task.id),
        title: task.description.replace(/\s+/g, " ").slice(0, 24),
        description: taskLine(task).slice(0, 72),
      })),
  );
  if (tasks.length > start + 9)
    rows.push({
      id: await signControl(env, "agenda", user.id, date, "page", page + 1),
      title: "עוד משימות",
      description: "מעבר למשימות נוספות",
    });
  if (!rows.length) {
    await showPriorityPicker(env, user, phone, 0);
    return;
  }
  await sendInteractiveList(
    env,
    phone,
    `⭐ בחר משימה להתמקד בה היום (${data.priorities.length}/3 נבחרו).`,
    rows,
  );
}
export async function handleAgendaControl(
  env: Env,
  user: User,
  phone: string,
  payload: string,
): Promise<boolean> {
  const control = await verifyControl(env, payload, user.id);
  if (control?.kind !== "agenda") return false;
  const [, date, action, value] = control.values;
  if (action === "off") {
    await sendMessage(
      env,
      phone,
      (await agendaCommand(env, user, "/agenda off", phone))!,
    );
    return true;
  }
  if (date !== localDateKey()) {
    await sendMessage(
      env,
      phone,
      "הסיכום הזה מתייחס ליום אחר. /agenda now — סדר היום העדכני.",
    );
    return true;
  }
  if (action === "show") {
    await sendMessage(env, phone, await agendaText(env, user));
    return true;
  }
  if (action === "focus" || action === "page") {
    if (
      action === "page" &&
      (!/^\d+$/.test(value ?? "") || Number(value) > 1000)
    )
      return false;
    await showPriorityPicker(
      env,
      user,
      phone,
      action === "page" ? Number(value) : 0,
    );
    return true;
  }
  if (action !== "pick" || !/^\d+$/.test(value ?? "")) return false;
  const tasks = await accessibleTasks(env, user);
  const task = tasks.find((t) => t.id === Number(value));
  if (!task) {
    await sendMessage(
      env,
      phone,
      "המשימה אינה זמינה כרגע. /agenda focus — בחירה מחדש.",
    );
    return true;
  }
  // All selection requests run in the same user inbox; SQL also enforces the three-task limit.
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO agenda_priority (user_id,local_date,task_id)
    SELECT ?,?,? WHERE (SELECT COUNT(*) FROM agenda_priority p JOIN task t ON t.id=p.task_id
      WHERE p.user_id=? AND p.local_date=? AND t.status='pending' AND ${taskPermissionSql("t")})<3
      AND EXISTS (SELECT 1 FROM task WHERE id=? AND status='pending' AND ${taskPermissionSql()})`,
  )
    .bind(user.id, date, task.id, user.id, date, user.id, task.id, user.id)
    .run();
  if (!result.meta.changes) {
    await sendMessage(
      env,
      phone,
      "המשימה כבר נבחרה, או שיש כבר 3 עדיפויות. /agenda clear — ניקוי הבחירה.",
    );
    return true;
  }
  await sendInteractiveButtons(
    env,
    phone,
    `⭐ *${task.description}* נוספה לעדיפויות להיום.`,
    [
      {
        id: await signControl(env, "agenda", user.id, date, "focus"),
        title: "בחירת משימה נוספת",
      },
      {
        id: await signControl(env, "agenda", user.id, date, "show"),
        title: "סדר היום שלי",
      },
    ],
  );
  return true;
}

export function normalizeAgendaCommand(text: string): string {
  const value = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (["סיכום בוקר", "סדר היום שלי", "סיכום יומי"].includes(value))
    return "/agenda";
  if (["כבה סיכום בוקר", "כבה סיכום יומי", "הפסק סיכום בוקר"].includes(value))
    return "/agenda off";
  const match = value.match(
    /^(?:הפעל )?סיכום (?:בוקר|יומי) (?:ב(?:שעה)?[- ]?)(\d{1,2}:\d{2})$/,
  );
  return match ? `/agenda ${match[1]}` : value;
}
export async function agendaCommand(
  env: Env,
  user: User,
  raw: string,
  phone: string,
): Promise<string | null> {
  const command = normalizeAgendaCommand(raw);
  if (!/^\/agenda(?: |$)/.test(command)) return null;
  if (command === "/agenda focus") {
    await showPriorityPicker(env, user, phone);
    return "__agenda_handled__";
  }
  if (command === "/agenda clear") {
    await env.DB.prepare(
      "DELETE FROM agenda_priority WHERE user_id=? AND local_date=?",
    )
      .bind(user.id, localDateKey())
      .run();
    return "⭐ העדיפויות להיום נוקו.";
  }
  if (command === "/agenda now") return agendaText(env, user);
  if (command === "/agenda off") {
    await env.DB.prepare(
      "UPDATE agenda_preferences SET enabled=0,revision=revision+1 WHERE user_id=?",
    )
      .bind(user.id)
      .run();
    return "☀️ סיכום הבוקר כובה. אפשר עדיין להציג סדר יום עם /agenda now.";
  }
  const match = command.match(
    /^\/agenda (?:on )?(\d{1,2}:\d{2})(?: (daily|weekdays))?$/,
  );
  if (match) {
    const [hour, minute] = match[1].split(":").map(Number);
    if (hour > 23 || minute > 59)
      return "השעה אינה תקפה. לדוגמה: /agenda 08:00";
    if (!env.AGENDA_TEMPLATE_NAME)
      return "סיכום הבוקר האוטומטי עדיין בהכנה. אפשר להציג סדר יום עכשיו: /agenda now";
    const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const days = match[2] ?? "daily";
    await env.DB.prepare(
      `INSERT INTO agenda_preferences (user_id,enabled,time,days,next_send_at) VALUES (?,1,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET enabled=1,time=excluded.time,days=excluded.days,next_send_at=excluded.next_send_at,revision=agenda_preferences.revision+1,last_error=NULL`,
    )
      .bind(user.id, time, days, nextAgendaAt(time, days))
      .run();
    return `☀️ סיכום הבוקר הופעל ל־${time} לפי שעון ישראל, ${days === "weekdays" ? "בימים ראשון–חמישי" : "בכל יום"}.\nימים ללא משימות להיום או באיחור ידולגו.\n/agenda off — כיבוי\n/agenda now — הצגה עכשיו`;
  }
  const pref = await preferences(env, user.id);
  return `${await agendaText(env, user)}\n\n☀️ סיכום אוטומטי: ${pref?.enabled ? `${pref.time}, ${pref.days === "weekdays" ? "ראשון–חמישי" : "כל יום"}` : "כבוי"}${pref?.last_error ? "\nהסיכום האחרון לא נשלח. אפשר להציגו עם /agenda now." : ""}\nלהפעלה: /agenda 08:00\nלראשון–חמישי: /agenda 08:00 weekdays\nלכיבוי: /agenda off`;
}

export async function scheduleAgendas(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM task_undo WHERE expires_at<=?").bind(now()),
    env.DB.prepare("DELETE FROM task_control_use WHERE expires_at<=?").bind(
      now(),
    ),
    env.DB.prepare("DELETE FROM agenda_priority WHERE local_date<?").bind(
      localDateKey(now() - 7 * 86400),
    ),
  ]);
  if (!env.AGENDA_TEMPLATE_NAME) return;
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM agenda_preferences WHERE enabled=1 AND next_send_at<=? ORDER BY next_send_at LIMIT 50",
    )
      .bind(now())
      .all<Preferences>()
  ).results;
  for (const row of rows) {
    const user = await getUserById(buildDb(env), row.user_id);
    if (!user) continue;
    const date = localDateKey(row.next_send_at);
    const claimed = await env.DB.prepare(
      "UPDATE agenda_preferences SET next_send_at=? WHERE user_id=? AND enabled=1 AND revision=? AND next_send_at=?",
    )
      .bind(now() + 120, row.user_id, row.revision, row.next_send_at)
      .run();
    if (!claimed.meta.changes) continue;
    try {
      await env.CONVERSATIONS.getByName(user.phone_number_hash).enqueue({
        kind: "agenda",
        userId: user.id,
        date,
        revision: row.revision,
        id: `agenda:${user.id}:${date}:${row.revision}`,
      });
    } catch {
      await env.DB.prepare(
        "UPDATE agenda_preferences SET next_send_at=? WHERE user_id=? AND revision=?",
      )
        .bind(row.next_send_at, user.id, row.revision)
        .run();
    }
  }
}
export async function deliverAgenda(
  env: Env,
  userId: number,
  date: string,
  revision: number,
): Promise<void> {
  const pref = await preferences(env, userId);
  const user = await getUserById(buildDb(env), userId);
  if (
    !pref?.enabled ||
    pref.revision !== revision ||
    !user ||
    !env.AGENDA_TEMPLATE_NAME
  )
    return;
  const next = nextAgendaAt(pref.time, pref.days);
  if (date !== localDateKey() || now() - wallTime(date, pref.time) > 5400) {
    await env.DB.prepare(
      "UPDATE agenda_preferences SET next_send_at=? WHERE user_id=? AND revision=?",
    )
      .bind(next, userId, revision)
      .run();
    return;
  }
  const claimed = await env.DB.prepare(
    `UPDATE agenda_preferences SET next_send_at=?,last_sent_date=?,last_error=NULL
    WHERE user_id=? AND enabled=1 AND revision=? AND (last_sent_date IS NULL OR last_sent_date!=?)`,
  )
    .bind(next, date, userId, revision, date)
    .run();
  if (!claimed.meta.changes) {
    await env.DB.prepare(
      "UPDATE agenda_preferences SET next_send_at=? WHERE user_id=? AND revision=?",
    )
      .bind(next, userId, revision)
      .run();
    return;
  }
  if (!(await hasAccess(env, user))) return;
  const data = await agendaData(env, user, date);
  if (!data.today.length && !data.overdue.length) return;
  const buttons = await Promise.all(
    [
      ["show", "הצג משימות"],
      ["focus", "בחר עדיפויות"],
      ["off", "הפסקת הסיכום"],
    ].map(async ([action, title]) => ({
      id: await signControl(env, "agenda", userId, date, action),
      title,
    })),
  );
  try {
    const phone = await decryptPhone(user, env.ENCRYPTION_KEY);
    const msgId = await sendAgendaTemplate(
      env,
      phone,
      date.split("-").reverse().join("/"),
      data.today.length,
      data.overdue.length,
      buttons,
    );
    await saveMessage(buildDb(env), env.ENCRYPTION_KEY, {
      userId,
      messageType: "system",
      content: null,
      aiResponse: `סיכום יומי: ${data.today.length} להיום, ${data.overdue.length} באיחור.`,
      parsedTasks: null,
      whatsappMessageId: msgId,
    });
  } catch {
    // Do not repeat an uncertain delivery; /agenda now always remains available.
    await env.DB.prepare(
      "UPDATE agenda_preferences SET last_error='delivery' WHERE user_id=? AND revision=?",
    )
      .bind(userId, revision)
      .run();
  }
}
