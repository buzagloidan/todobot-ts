import { TZ } from "./constants.ts";
import type { Task } from "./db/schema.ts";

export function sortTasksByDueDate<T extends { due_date: Date | null | undefined; created_at: Date }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.due_date && b.due_date) return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatTaskLabel(
  t: Task,
  userId: number,
  assigneeInfo?: { assigneeNicknames?: string[]; fromNickname?: string | null; projectName?:string }
): string {
  let due = "";
  if (t.due_date) {
    const d = new Date(new Date(t.due_date).toLocaleString("en-US", { timeZone: TZ }));
    const overdue = new Date(t.due_date) < new Date();
    due = ` ⏰ ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear())} ${pad(d.getHours())}:${pad(d.getMinutes())}${overdue ? " (באיחור)" : ""}`;
  }
  const rec = (t.recurrence ? " 🔁" : "")+(assigneeInfo?.projectName?` [פרויקט: ${assigneeInfo.projectName}]`:'');

  if (t.user_id !== userId) {
    // Viewer is the assignee — show who assigned it
    const fromLabel = assigneeInfo?.fromNickname ? `(מאת: ${assigneeInfo.fromNickname}) ` : "(שותף) ";
    return `${fromLabel}${t.description}${rec}${due}`;
  }

  // Viewer is the owner
  const assignedTo = assigneeInfo?.assigneeNicknames?.length
    ? ` (תויגו: ${assigneeInfo.assigneeNicknames.join(", ")})`
    : "";
  return `${t.description}${assignedTo}${rec}${due}`;
}

export function formatTaskList(
  tasks: Task[],
  userId: number,
  assigneesByTaskId?: Map<number, { id: number; nickname: string }[]>,
  ownerNicknameByTaskId?: Map<number, string | null>,
  projectNames?:Map<number,string>
): string {
  if (tasks.length === 0) return "אין לך משימות ממתינות כרגע! 🎉";
  const now = new Date();
  const lines = tasks.map((t, i) => {
    const overdue = t.due_date && new Date(t.due_date) < now;
    const icon = overdue ? "⚠️" : "📋";
    const assignees = assigneesByTaskId?.get(t.id);
    const assigneeNicknames = t.user_id === userId && assignees
      ? assignees.map((a) => a.nickname)
      : undefined;
    const fromNickname = t.user_id !== userId
      ? (ownerNicknameByTaskId?.get(t.id) ?? null)
      : null;
    return `${i + 1}. ${icon} ${formatTaskLabel(t, userId, { assigneeNicknames, fromNickname,projectName:t.project_id?projectNames?.get(t.project_id):undefined })}`;
  });
  return `📋 *רשימת המשימות שלך:*\n\n${lines.join("\n\n")}\n\nאפשר לכתוב ״סיימתי״ עם שם המשימה או מספרה 📝\n# — לפי פרויקט · /recover — משימות באיחור`;
}
