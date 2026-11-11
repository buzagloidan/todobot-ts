import type { Env } from "../types.ts";
import type { User } from "../db/schema.ts";
import { buildDb } from "../db/client.ts";
import {
  getAccessibleUserIds,
  getAssignedTaskIds,
  getUserTasks,
  getTaskById,
  getTaskAssigneesByTaskIds,
  getNicknameForUser,
  saveMessage,
} from "../db/queries.ts";
import { sortTasksByDueDate, formatTaskLabel } from "../task_format.ts";
import {
  sendInteractiveList,
  sendMessage,
  WhatsAppSendError,
} from "./whatsapp.ts";
import { signControl, verifyControl } from "./controls.ts";
import { showTaskDetails } from "./task_controls.ts";
import { visibleProjects } from "./projects.ts";
import { capture, type AnalyticsWaitUntil } from "./posthog.ts";
export type TaskFilter = "all" | "1d" | "2d";
const now = () => Math.floor(Date.now() / 1000);
const compact = (s: string, max: number) =>
  s.replace(/\s+/g, " ").trim().slice(0, max);
const PAGE_SIZE = 8;
export async function showTaskList(
  env: Env,
  user: User,
  phone: string,
  filter: TaskFilter = "all",
  page = 0,
  waitUntil?: AnalyticsWaitUntil,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM task_schedule_pending WHERE actor_id=?").bind(
      user.id,
    ),
    env.DB.prepare("DELETE FROM recovery_pending WHERE actor_id=?").bind(
      user.id,
    ),
  ]);
  const db = buildDb(env);
  const all = sortTasksByDueDate(
    await getUserTasks(
      db,
      env.ENCRYPTION_KEY,
      getAccessibleUserIds(user),
      "pending",
      await getAssignedTaskIds(db, user.id),
    ),
  );
  const cutoff = Date.now() + (filter === "1d" ? 1 : 2) * 86400000;
  const list =
    filter === "all"
      ? all
      : all.filter((t) => t.due_date && +t.due_date <= cutoff);
  if (!list.length) {
    await sendMessage(
      env,
      phone,
      filter === "all"
        ? "אין לך משימות ממתינות כרגע! 🎉"
        : `אין משימות ל${filter === "1d" ? "יום הקרוב" : "יומיים הקרובים"}.`,
    );
    return;
  }
  if (
    !Number.isSafeInteger(page) ||
    page < 0 ||
    page * PAGE_SIZE >= list.length
  )
    page = 0;
  const visible = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    expiry = now() + 3600;
  const [projects, assignees, owners] = await Promise.all([
    visibleProjects(env, user),
    getTaskAssigneesByTaskIds(
      db,
      visible.map((t) => t.id),
      user.id,
    ),
    Promise.all(
      visible
        .filter((t) => t.user_id !== user.id)
        .map(
          async (t) =>
            [t.id, await getNicknameForUser(db, user.id, t.user_id)] as const,
        ),
    ).then((v) => new Map(v)),
  ]);
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const labels = visible.map((t) =>
    formatTaskLabel(t, user.id, {
      assigneeNicknames: assignees.get(t.id)?.map((a) => a.nickname),
      fromNickname: owners.get(t.id),
      projectName: t.project_id ? projectNames.get(t.project_id) : undefined,
    }),
  );
  const rows = await Promise.all(
    visible.map(async (t, i) => ({
      id: await signControl(
        env,
        "browse",
        user.id,
        "task",
        filter,
        t.id,
        t.revision,
        expiry,
      ),
      title: compact(t.description, 24) || "משימה",
      description: compact(labels[i], 72),
    })),
  );
  if (page > 0)
    rows.push({
      id: await signControl(
        env,
        "browse",
        user.id,
        "page",
        filter,
        page - 1,
        0,
        expiry,
      ),
      title: "העמוד הקודם",
      description: "חזרה ברשימה",
    });
  if ((page + 1) * PAGE_SIZE < list.length)
    rows.push({
      id: await signControl(
        env,
        "browse",
        user.id,
        "page",
        filter,
        page + 1,
        0,
        expiry,
      ),
      title: "עוד משימות",
      description: "המשך הרשימה",
    });
  // Keep legacy numbers aligned with the complete ? list, including filtered pages.
  const body = `📋 *רשימת המשימות שלך:*\n${filter === "all" ? "" : filter === "1d" ? "ליום הקרוב\n" : "ליומיים הקרובים\n"}${list.length} משימות · עמוד ${page + 1}/${Math.ceil(list.length / PAGE_SIZE)}\n\n${labels.map((l, i) => `${all.findIndex((t) => t.id === visible[i].id) + 1}. ${compact(l, 95)}`).join("\n")}\n\nלחץ על ״בחירת משימה״ להשלמה, שינוי זמן או ביטול.\n# — לפי פרויקט`;
  let id: string | null;
  try {
    id = await sendInteractiveList(env, phone, body, rows);
  } catch (err) {
    // Fall back only for an explicit permanent rejection, never resend an uncertain network request.
    if (!(err instanceof WhatsAppSendError) || err.retryable) throw err;
    id = await sendMessage(
      env,
      phone,
      body + "\nאפשר גם לכתוב ״סיימתי״ עם שם המשימה.",
    );
  }
  await saveMessage(db, env.ENCRYPTION_KEY, {
    userId: user.id,
    messageType: "system",
    content: filter === "all" ? "?" : filter === "1d" ? "?1" : "?2",
    aiResponse: body,
    parsedTasks: null,
    whatsappMessageId: id,
  });
  await capture(
    env,
    `user_${user.id}`,
    "task_listed",
    { method: "interactive", task_count: list.length, filter, page },
    { waitUntil },
  );
}
export async function taskListCommand(
  env: Env,
  user: User,
  phone: string,
  text: string,
  waitUntil?: AnalyticsWaitUntil,
): Promise<boolean> {
  const cmd = text.trim();
  if (!["?", "?1", "?2", "/list"].includes(cmd)) return false;
  await showTaskList(
    env,
    user,
    phone,
    cmd === "?1" ? "1d" : cmd === "?2" ? "2d" : "all",
    0,
    waitUntil,
  );
  return true;
}
export async function handleTaskBrowser(
  env: Env,
  user: User,
  phone: string,
  payload: string,
): Promise<boolean> {
  const c = await verifyControl(env, payload, user.id);
  if (c?.kind !== "browse") return false;
  const [, action, filter, id, revision, expiry] = c.values;
  if (
    c.values.length !== 6 ||
    !["task", "page"].includes(action) ||
    !["all", "1d", "2d"].includes(filter) ||
    ![id, revision, expiry].every(
      (v) => /^\d+$/.test(v ?? "") && Number.isSafeInteger(+v),
    )
  )
    return false;
  if (+expiry <= now()) {
    await sendMessage(env, phone, "הבחירה פגה. שלח ? לרשימה העדכנית.");
    return true;
  }
  if (action === "page") {
    await showTaskList(env, user, phone, filter as TaskFilter, +id);
    return true;
  }
  const db = buildDb(env),
    task = await getTaskById(
      db,
      env.ENCRYPTION_KEY,
      +id,
      getAccessibleUserIds(user),
      await getAssignedTaskIds(db, user.id),
    );
  if (!task || task.status !== "pending" || task.revision !== +revision) {
    await sendMessage(
      env,
      phone,
      "המשימה השתנתה או אינה זמינה. שלח ? לבחירה עדכנית.",
    );
    return true;
  }
  const name = task.project_id
    ? (await visibleProjects(env, user)).find((p) => p.id === task.project_id)
        ?.name
    : undefined;
  await showTaskDetails(env, user, phone, task, name);
  return true;
}
