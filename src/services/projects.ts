import type { Env } from "../types.ts";
import type { User, Task } from "../db/schema.ts";
import { buildDb } from "../db/client.ts";
import { fernetEncrypt, fernetDecrypt } from "../crypto/fernet.ts";
import {
  getAccessibleUserIds,
  getAssignedTaskIds,
  getUserTasks,
  getTaskById,
} from "../db/queries.ts";
import { trackedTaskMutation, type UndoContext } from "./task_undo.ts";
import { signControl, verifyControl } from "./controls.ts";
import {
  sendMessage,
  sendInteractiveList,
} from "./whatsapp.ts";
import { showTaskDetails } from "./task_controls.ts";
import { TZ } from "../constants.ts";

export type Project = { id: number; user_id: number; name: string };
const seconds = () => Math.floor(Date.now() / 1000);
const normalize = (name: string) =>
  name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
async function nameHash(
  env: Env,
  ownerId: number,
  name: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.ENCRYPTION_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${ownerId}:${normalize(name)}`),
      ),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function getOrCreateProject(
  env: Env,
  ownerId: number,
  name: string,
): Promise<Project> {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean || clean.length > 120) throw new Error("Invalid project name");
  const hash = await nameHash(env, ownerId, clean);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO project(user_id,name_encrypted,name_hash,created_at) VALUES (?,?,?,?)",
  )
    .bind(
      ownerId,
      await fernetEncrypt(clean, env.ENCRYPTION_KEY),
      hash,
      seconds(),
    )
    .run();
  const row = await env.DB.prepare(
    "SELECT id,user_id,name_encrypted FROM project WHERE user_id=? AND name_hash=?",
  )
    .bind(ownerId, hash)
    .first<{ id: number; user_id: number; name_encrypted: string }>();
  if (!row) throw new Error("Project missing");
  return {
    id: row.id,
    user_id: row.user_id,
    name: await fernetDecrypt(row.name_encrypted, env.ENCRYPTION_KEY),
  };
}
export async function visibleProjects(
  env: Env,
  user: User,
): Promise<Project[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT p.id,p.user_id,p.name_encrypted FROM project p JOIN user actor ON actor.id=?
    WHERE p.user_id=actor.id OR p.user_id=actor.partner_user_id OR EXISTS
    (SELECT 1 FROM task t JOIN task_assignee a ON a.task_id=t.id WHERE t.project_id=p.id AND a.assignee_user_id=actor.id)
    ORDER BY p.created_at DESC,p.id DESC`,
    )
      .bind(user.id)
      .all<{ id: number; user_id: number; name_encrypted: string }>()
  ).results;
  return Promise.all(
    rows.map(async (p) => ({
      id: p.id,
      user_id: p.user_id,
      name: await fernetDecrypt(p.name_encrypted, env.ENCRYPTION_KEY),
    })),
  );
}
export async function resolveProject(
  env: Env,
  user: User,
  name: string,
): Promise<Project | null> {
  const list = await visibleProjects(env, user),
    key = normalize(name);
  const exact = list.filter((p) => normalize(p.name) === key);
  if (exact.length === 1) return exact[0];
  const own = exact.filter((p) => p.user_id === user.id);
  if (own.length === 1) return own[0];
  if (exact.length) return null;
  const partial = list.filter((p) => normalize(p.name).includes(key));
  return key && partial.length === 1 ? partial[0] : null;
}
export async function tasksInProject(
  env: Env,
  user: User,
  id: number,
): Promise<Task[]> {
  if (!(await visibleProjects(env, user)).some((p) => p.id === id)) return [];
  const db = buildDb(env);
  return (
    await getUserTasks(
      db,
      env.ENCRYPTION_KEY,
      getAccessibleUserIds(user),
      undefined,
      await getAssignedTaskIds(db, user.id),
    )
  ).filter((t) => t.project_id === id);
}
export async function createChecklist(
  env: Env,
  user: User,
  name: string,
  items: string[],
  undo: UndoContext,
): Promise<Project> {
  if (items.length > 50 || items.some((i) => !i.trim() || i.length > 500))
    throw new Error("Invalid checklist");
  const project = await getOrCreateProject(env, user.id, name);
  const encrypted = await Promise.all(
    items.map((i) => fernetEncrypt(i.trim(), env.ENCRYPTION_KEY)),
  );
  const statements = [
    env.DB.prepare(
      "INSERT OR IGNORE INTO task_undo(id,actor_user_id,created_at,expires_at) VALUES (?,?,?,?)",
    ).bind(undo.groupId, user.id, seconds(), seconds() + 600),
  ];
  for (const description of encrypted) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO task(user_id,project_id,description,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?) RETURNING id",
      ).bind(user.id, project.id, description, seconds(), seconds()),
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO task_undo_change(group_id,task_id,before_encrypted,after_revision) SELECT ?,id,NULL,revision FROM task WHERE id=last_insert_rowid()",
      ).bind(undo.groupId),
    );
  }
  if (items.length) {
    const results = await env.DB.batch(statements);
    for (let i = 0; i < items.length; i++)
      undo.changedTaskIds?.push(
        (results[1 + i * 2].results[0] as { id: number }).id,
      );
  }
  return project;
}
export async function moveTaskToProject(
  env: Env,
  user: User,
  task: Task,
  project: Project,
  undo: UndoContext,
): Promise<boolean> {
  // Moving a shared task into somebody else's private project would leak its project membership.
  if (task.user_id !== user.id || project.user_id !== user.id) return false;
  return trackedTaskMutation(
    env.DB,
    env.ENCRYPTION_KEY,
    { ...undo, expectedRevision: task.revision },
    task.id,
    { project_id: project.id },
  );
}
const line = (task: Task) =>
  `${task.status === "completed" ? "✅" : task.status === "cancelled" ? "🚫" : "☐"} ${task.description.replace(/\s+/g, " ").slice(0, 130)}${task.due_date ? " — " + task.due_date.toLocaleString("he-IL", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}`;
export async function projectText(
  env: Env,
  user: User,
  project: Project,
): Promise<string> {
  const tasks = await tasksInProject(env, user, project.id),
    active = tasks.filter((t) => t.status !== "cancelled"),
    completed = active.filter((t) => t.status === "completed").length;
  return [
    `📋 *${project.name}*`,
    `${completed}/${active.length} הושלמו`,
    ...active.slice(0, 20).map(line),
    ...(active.length > 20
      ? ["להצגת הפריטים ולפעולות: /project " + project.name]
      : []),
    ...(!active.length
      ? ["הפרויקט ריק. אפשר להוסיף משימה עם שם הפרויקט."]
      : []),
  ].join("\n");
}
export async function showProject(
  env: Env,
  user: User,
  phone: string,
  project: Project,
  page = 0,
): Promise<void> {
  const tasks = await tasksInProject(env, user, project.id),
    pending = tasks.filter((t) => t.status === "pending");
  if (!pending.length) {
    await sendMessage(env, phone, await projectText(env, user, project));
    return;
  }
  if (page * 9 >= pending.length) page = 0;
  const expiry = seconds() + 3600;
  const rows = await Promise.all(
    pending
      .slice(page * 9, page * 9 + 9)
      .map(async (t) => ({
        id: await signControl(
          env,
          "project",
          user.id,
          "task",
          project.id,
          t.id,
          expiry,
        ),
        title: t.description.replace(/\s+/g, " ").slice(0, 24),
        description: line(t).slice(0, 72),
      })),
  );
  if (pending.length > page * 9 + 9)
    rows.push({
      id: await signControl(
        env,
        "project",
        user.id,
        "page",
        project.id,
        page + 1,
        expiry,
      ),
      title: "עוד פריטים",
      description: "המשך הרשימה",
    });
  await sendInteractiveList(
    env,
    phone,
    `📋 *${project.name}*\n${tasks.filter((t) => t.status === "completed").length}/${tasks.filter((t) => t.status !== "cancelled").length} הושלמו · ${pending.length} ממתינים\nבחירת פריט מציגה את שמו המלא ואת הפעולות.`,
    rows,
  );
}
export async function showProjects(
  env: Env,
  user: User,
  phone: string,
  page = 0,
): Promise<void> {
  const list = await visibleProjects(env, user);
  if (!list.length) {
    await sendMessage(
      env,
      phone,
      "📋 אין פרויקטים עדיין. למשל: ״צור צ׳קליסט למעבר דירה״ או ״הוסף לשלוח הצעה לפרויקט עבודה״.",
    );
    return;
  }
  if (page * 9 >= list.length) page = 0;
  const rows = await Promise.all(
    list
      .slice(page * 9, page * 9 + 9)
      .map(async (p) => ({
        id: await signControl(
          env,
          "project",
          user.id,
          "show",
          p.id,
          0,
          seconds() + 3600,
        ),
        title: p.name.slice(0, 24),
        description:
          p.user_id === user.id
            ? "הפרויקט שלי"
            : "פרויקט משותף — הפריטים שיש גישה אליהם",
      })),
  );
  if (list.length > page * 9 + 9)
    rows.push({
      id: await signControl(
        env,
        "project",
        user.id,
        "list",
        0,
        page + 1,
        seconds() + 3600,
      ),
      title: "עוד פרויקטים",
      description: "המשך הרשימה",
    });
  await sendInteractiveList(env, phone, "📋 בחירת פרויקט או צ׳קליסט", rows);
}
export async function projectCommand(
  env: Env,
  user: User,
  text: string,
  phone: string,
): Promise<string | null> {
  const command = text.trim();
  if (command === "/projects" || command === "/project" || command === "#") {
    await showProjects(env, user, phone);
    return "__handled__";
  }
  const named=command.match(/^(?:\/project|#)\s+(.+)$/u);
  if (named) {
    const p = await resolveProject(env, user, named[1]);
    if (!p)
      return "לא נמצא פרויקט בשם הזה, או שיש כמה התאמות. # — בחירה לפי שם.";
    await showProject(env, user, phone, p);
    return "__handled__";
  }
  return null;
}
export async function handleProjectControl(
  env: Env,
  user: User,
  phone: string,
  payload: string,
): Promise<boolean> {
  const c = await verifyControl(env, payload, user.id);
  if (c?.kind !== "project") return false;
  const [, action, id, value, expiry] = c.values;
  if (
    !["show", "page", "list", "task"].includes(action) ||
    ![id, value, expiry].every((v) => /^\d+$/.test(v ?? ""))
  )
    return false;
  if (+expiry <= seconds()) {
    await sendMessage(env, phone, "הבחירה פגה. # — בחירה עדכנית.");
    return true;
  }
  if (action === "list") {
    await showProjects(env, user, phone, Math.min(+value, 10000));
    return true;
  }
  const project = (await visibleProjects(env, user)).find((p) => p.id === +id);
  if (!project) {
    await sendMessage(env, phone, "הפרויקט אינו זמין לחשבון הזה.");
    return true;
  }
  if (action === "show" || action === "page") {
    await showProject(
      env,
      user,
      phone,
      project,
      action === "page" ? Math.min(+value, 10000) : 0,
    );
    return true;
  }
  const db = buildDb(env),
    task = await getTaskById(
      db,
      env.ENCRYPTION_KEY,
      +value,
      getAccessibleUserIds(user),
      await getAssignedTaskIds(db, user.id),
    );
  if (!task || task.project_id !== project.id || task.status !== "pending") {
    await sendMessage(
      env,
      phone,
      "הפריט השתנה. /project " + project.name + " — הרשימה העדכנית.",
    );
    return true;
  }
  await showTaskDetails(env,user,phone,task,project.name);
  return true;
}
