import { validRecurrence } from "./recurrence.ts";
import type { ParsedTask } from "../types.ts";

export const HISTORY_ENTRIES = 24;
export const HISTORY_MESSAGE_CHARS = 1000;
const HISTORY_CHAR_BUDGET = 16_000;
export const INVALID_TASK_REPLY = "לא הצלחתי להבין את הבקשה. אפשר לנסח אותה שוב?";

const ACTIONS = ["add", "complete", "list", "delete", "update", "stop_recurrence", "project_create", "project_show", "project_list", "recover"];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shortString(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1000;
}
function nonempty(value: unknown): value is string {
  return shortString(value) && value.trim().length > 0;
}
function stringArray(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(shortString);
}
function validDate(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return false;
  const [year, month, day, hour, minute] = value.split(/[- :]/).map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return year >= 2000 && year <= 2100 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day && d.getUTCHours() === hour && d.getUTCMinutes() === minute;
}
function validTask(value: unknown): value is ParsedTask {
  if (!record(value) || typeof value.action !== "string" || !ACTIONS.includes(value.action) || !shortString(value.title)) return false;
  if(value.project_name!==undefined && (!nonempty(value.project_name)||value.project_name.length>120))return false;
  if(value.new_project_name!==undefined && (!nonempty(value.new_project_name)||value.new_project_name.length>120))return false;
  if(value.checklist_items!==undefined && (!stringArray(value.checklist_items,50)||value.checklist_items.some(i=>!nonempty(i)||i.length>500)))return false;
  if(value.checklist_items!==undefined && value.action!=='project_create')return false;
  if(value.new_project_name!==undefined && value.action!=='update')return false;
  for (const field of ["due_date", "new_due_date"]) if (value[field] !== undefined && !validDate(value[field])) return false;
  for (const field of ["new_title"]) {
    if (value[field] !== undefined && !nonempty(value[field])) return false;
  }
  if (value.recurrence !== undefined && value.recurrence !== null && !validRecurrence(value.recurrence)) return false;
  if (value.assignees !== undefined && !stringArray(value.assignees, 5)) return false;
  switch (value.action) {
    case "add": return nonempty(value.title) && (!value.recurrence || (typeof value.due_date === "string" && validDate(value.due_date)));
    case "complete": case "delete": case "stop_recurrence": return nonempty(value.title);
    case "update": return nonempty(value.title) && (value.new_title !== undefined || value.new_due_date !== undefined || value.new_project_name!==undefined);
    case "project_create": case "project_show": return nonempty(value.project_name);
    default: return true;
  }
}

export function validateTaskResponse(value: unknown): value is { tasks: ParsedTask[]; intent: "task_management" | "question" | "conversation"; reply: string } {
  return record(value) && Array.isArray(value.tasks) && value.tasks.length <= 20 && value.tasks.every(validTask) &&
    typeof value.intent === "string" && ["task_management", "question", "conversation"].includes(value.intent) && typeof value.reply === "string" && value.reply.length <= 4000;
}

export function conversationReply(reply: string): string {
  // Only executor results may assert a successful change, including when the model returned no actions.
  const success = /(?<![\u0590-\u05ff])(?:נוספה|נוספו|הושלמה|הושלמו|עודכנה|עודכנו|נמחקה|נמחקו|הוספתי|מחקתי|עדכנתי|סימנתי|דחיתי|קבעתי|ביטלתי|יצרתי|שיניתי|הסרתי|בוצע|בוצעה|בוצעו|נוסף|הושלם|עודכן|נמחק|נקבעה|נקבע)(?![\u0590-\u05ff])/;
  if (success.test(reply) || /^[\s✅🎉]+$/u.test(reply)) return INVALID_TASK_REPLY;
  return reply || INVALID_TASK_REPLY;
}

export function formatConversationHistory(history: { role: string; content: string }[]): string {
  const lines: string[] = [];
  let budget = HISTORY_CHAR_BUDGET;
  for (const message of history.slice(-HISTORY_ENTRIES).reverse()) {
    const content = message.content.slice(0, Math.min(HISTORY_MESSAGE_CHARS, budget));
    if (!content) break;
    lines.unshift(`[${message.role === "user" ? "משתמש" : "בוט"}]: ${content}`);
    budget -= content.length;
    if (budget <= 0) break;
  }
  return lines.length ? "\n\nהיסטוריית שיחה (מהישן לחדש):\n" + lines.join("\n") : "";
}
