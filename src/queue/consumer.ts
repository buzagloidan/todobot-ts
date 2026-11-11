import { shareCommand,maybeOfferShare } from "../services/sharing.ts";
import { firstRecurringOccurrence,recurrenceLabel } from "../services/recurrence.ts";
import type { Env, QueueMessage, ParsedTask } from "../types.ts";
import { buildDb } from "../db/client.ts";
import { sortTasksByDueDate, formatTaskLabel } from "../task_format.ts";
import {
  getUserById,
  decryptPhone,
  addTask,
  completeTask,
  completeTaskByDescription,
  clearRecurrenceByDescription,
  updateTaskByDescription,
  updateTaskById,
  getTaskStats,
  getConversationHistory,
  saveMessage,
  getUserTasks,
  getTaskById,
  getTaskIdFromMessageId,
  getAccessibleUserIds,
  getFriends,
  getAssignedTaskIds,
  getFriendByNickname,
  addTaskAssignees,
  getTaskAssigneesByTaskIds,
  getNicknameForUser,
  getBotReplyByMessageId,
} from "../db/queries.ts";
import { HISTORY_ENTRIES, conversationReply } from "../services/task_response.ts";
import { processMessage, transcribeAudio } from "../services/gemini.ts";
import { downloadMedia, sendMessage, sendReaction } from "../services/whatsapp.ts";
import { capture,type AnalyticsWaitUntil } from "../services/posthog.ts";
import { sendAlert } from "../services/alert.ts";
import { TZ } from "../constants.ts";
import type { Task } from "../db/schema.ts";
import { parseDueDate } from "../time.ts";
import { hasAccess, billingReply } from "../services/billing.ts";
import { newUndoContext, undoTasks, type UndoContext } from '../services/task_undo.ts';
import { sendTaskReply, undoCommands } from '../services/task_controls.ts';
import { agendaCommand } from '../services/agenda.ts';
import { projectCommand,visibleProjects,getOrCreateProject,resolveProject,createChecklist,projectText,showProjects,showProject } from '../services/projects.ts';
import { recoveryCommand,showRecovery,continueRecovery } from '../services/recovery.ts';
import { trackedTaskMutation } from '../services/task_undo.ts';
import { fernetEncrypt } from '../crypto/fernet.ts';
import { showTaskList,taskListCommand } from '../services/task_browser.ts';
import { continueTaskSchedule } from '../services/task_schedule.ts';
import { afterTaskChanges,guideCommand } from '../services/guide.ts';

export async function dispatchQueueMessage(msg: QueueMessage, env: Env, waitUntil?:AnalyticsWaitUntil): Promise<void> {
  const user = await getUserById(buildDb(env), msg.userId);
  if (!user) return;
  if (!(await hasAccess(env, user))) {
    await sendMessage(env, msg.phone, await billingReply(env, user));
    if (msg.incomingMsgId) await sendReaction(env, msg.phone, msg.incomingMsgId, "").catch(() => {});
    return;
  }
  switch (msg.type) {
    case "text_processing":
      await processText(msg, env,"text",waitUntil);
      break;
    case "voice_processing":
      await processVoice(msg, env,waitUntil);
      break;
    default:
      console.error("[QUEUE] Unknown message type:", (msg as QueueMessage).type);
  }
}

const MAX_MSG_CHARS = 1000;

async function processText(msg: QueueMessage, env: Env, messageType: "text" | "audio" = "text",waitUntil?:AnalyticsWaitUntil): Promise<void> {
  const { userId, phone } = msg;
  const t0 = Date.now();
  const queueDelay = msg.enqueuedAt ? t0 - msg.enqueuedAt : -1;
  const tag = `[TEXT u=${userId}]`;

  const rawText = msg.text ?? "";
  const text = rawText.length > MAX_MSG_CHARS ? rawText.slice(0, MAX_MSG_CHARS) : rawText;
  if (rawText.length > MAX_MSG_CHARS) {
    console.log(`${tag} message truncated: ${rawText.length} → ${MAX_MSG_CHARS} chars`);
  }

  console.log(`${tag} start | queue_delay=${queueDelay}ms`);

  const db = buildDb(env);

  const user = await getUserById(db, userId);
  if (!user) {
    console.error(`${tag} user not found`);
    // The user may have just deleted their account while this queue item was
    // waiting. Dropping it silently avoids sending a confusing post-delete
    // error message to a number we no longer own.
    return;
  }

  if(await shareCommand(env,user,phone,text,waitUntil))return;
  if(await guideCommand(env,user,phone,text,waitUntil))return;
  if(await taskListCommand(env,user,phone,text,waitUntil))return;
  if(await continueTaskSchedule(env,user,phone,text,msg.quotedMsgId))return;
  if(await continueRecovery(env,user,phone,text))return;
  const recovery=await recoveryCommand(env,user,text,phone);if(recovery!==null){if(recovery!=='__handled__')await sendMessage(env,phone,recovery);return;}
  const projectCommandReply=await projectCommand(env,user,text,phone);if(projectCommandReply!==null){if(projectCommandReply!=='__handled__')await sendMessage(env,phone,projectCommandReply);return;}

  const direct=undoCommands.has(text.trim().toLowerCase()) ? await undoTasks(env,user.id) : await agendaCommand(env,user,text,phone);
  if(direct!==null) {if(direct!=='__agenda_handled__')await sendMessage(env,phone,direct);return;}

  const accessible = getAccessibleUserIds(user);

  // Fetch task sharing and project context in parallel
  const [assignedTaskIds, friends, projects] = await Promise.all([
    getAssignedTaskIds(db, userId),
    getFriends(db, userId),
    visibleProjects(env,user),
  ]);
  const [stats, pendingTasks] = await Promise.all([
    getTaskStats(db, accessible, assignedTaskIds),
    getUserTasks(db, env.ENCRYPTION_KEY, accessible, "pending", assignedTaskIds),
  ]);

  const [histResult, quotedBotReply, quotedTaskId] = await Promise.all([
    getConversationHistory(db, env.ENCRYPTION_KEY, userId, HISTORY_ENTRIES),
    msg.quotedMsgId ? getBotReplyByMessageId(db, env.ENCRYPTION_KEY, userId, msg.quotedMsgId) : Promise.resolve(null),
    msg.quotedMsgId ? getTaskIdFromMessageId(db, env.ENCRYPTION_KEY, userId, msg.quotedMsgId) : Promise.resolve(null),
  ]);
  const quotedReminderTask = quotedTaskId
    ? await getTaskById(db, env.ENCRYPTION_KEY, quotedTaskId, accessible, assignedTaskIds)
    : null;
  const history = histResult;
  console.log(`${tag} db=${Date.now() - t0}ms quoted=${!!quotedBotReply} quoted_task=${!!quotedReminderTask}`);

  // Sort pending tasks by due date so Gemini's numbering matches what the user sees in the ? list
  const sortedPendingTasks = sortTasksByDueDate(pendingTasks);
  const pendingTaskIds = sortedPendingTasks.map((t) => t.id);
  const assigneesByTaskId = await getTaskAssigneesByTaskIds(db, pendingTaskIds, userId);

  // Build owner-nickname map for assigned tasks (for "מאת:" display)
  const ownerNicknameByTaskId = new Map<number, string | null>();
  for (const t of sortedPendingTasks) {
    if (t.user_id !== userId) {
      const nick = await getNicknameForUser(db, userId, t.user_id);
      ownerNicknameByTaskId.set(t.id, nick);
    }
  }

  const pendingTaskLabels = sortedPendingTasks.map((t) => {
    const assignees = assigneesByTaskId.get(t.id);
    const assigneeNicknames = t.user_id === userId && assignees ? assignees.map((a) => a.nickname) : undefined;
    const fromNickname = t.user_id !== userId ? (ownerNicknameByTaskId.get(t.id) ?? null) : null;
    const project=projects.find(p=>p.id===t.project_id);
    return formatTaskLabel(t, userId, { assigneeNicknames, fromNickname,projectName:project?.name });
  });

  const tGemini = Date.now();
  let parsed: { tasks: ParsedTask[]; intent: string; reply: string };
  try {
    parsed = await processMessage(env, {
      userMessage: text,
      stats,
      history,
      pendingTasks: pendingTaskLabels,
      friends: friends.map((f) => ({ nickname: f.nickname })),
      quotedBotReply: quotedBotReply ?? undefined,
      projects:projects.map(p=>p.name),
    });
  } catch (err) {
    console.error(`${tag} gemini_failed after ${Date.now() - tGemini}ms:`, err);
    await capture(env, `user_${userId}`, "llm_error", { error_type: "gemini_failure" });
    sendAlert(env, "gemini_error", String(err)).catch(() => {});
    await sendMessage(env, phone, "המודל לא מגיב כרגע 🤖 נסה שוב בעוד רגע");
    return;
  }
  console.log(`${tag} gemini=${Date.now() - tGemini}ms intent=${parsed.intent} tasks=${parsed.tasks.length}`);

  // Execute extracted tasks, collect display strings and DB task IDs
  const tTasks = Date.now();
  const taskResults: string[] = [];
  const handledResults:string[]=[];
  const executedTasks: { task_id: number; description: string }[] = [];
  const hasAdd = parsed.tasks.some((t) => t.action === "add" || t.action==='project_create');
  const undo=newUndoContext(userId);
  let handled=0;
  for (const t of parsed.tasks) {
    try {
      const { display, taskId,alreadySent } = await executeTask(
        db, userId, accessible, t, env,
        hasAdd ? undefined : pendingTasks,
        assignedTaskIds,
        friends,
        phone,
        quotedReminderTask,
        text,
        undo
      );
      if(alreadySent){handled++;if(display)handledResults.push(display);}
      else taskResults.push(display ?? "❌ לא ניתן לבצע את הפעולה. אפשר לנסח את הבקשה שוב?");
      if (taskId) {
        executedTasks.push({
          task_id: taskId,
          description: quotedReminderTask?.id === taskId ? quotedReminderTask.description : t.title,
        });
      }
    } catch (err) {
      console.error(`${tag} task_exec_error:`, err);
      taskResults.push("❌ שגיאה בביצוע המשימה");
    }
  }
  console.log(`${tag} tasks=${Date.now() - tTasks}ms`);

  // Task results take priority over Gemini's reply (they have exact formatted times)
  const aiReply = taskResults.length > 0 ? taskResults.join("\n") : handledResults.length ? handledResults.join('\n') : conversationReply(parsed.reply);

  const tSend = Date.now();
  let msgId: string | null = null;
  try {
    if (!aiReply) {
      console.error(`${tag} empty_ai_reply intent=${parsed.intent} task_count=${parsed.tasks.length}`);
      await capture(env, `user_${userId}`, "llm_error", { error_type: "empty_reply" });
    }
    if(!handled||taskResults.length)msgId = await sendTaskReply(env,userId,phone,aiReply || "המודל לא מגיב כרגע 🤖 נסה שוב בעוד רגע",undo,executedTasks.length===1?executedTasks[0].task_id:undefined);
    if (msg.incomingMsgId) await sendReaction(env, phone, msg.incomingMsgId, "").catch((e) => console.error(`${tag} reaction_clear_failed:`, e));
  } catch (err) {
    console.error(`${tag} whatsapp_send_failed after ${Date.now() - tSend}ms:`, err);
    await capture(env, `user_${userId}`, "whatsapp_send_failed", { stage: "text_reply" });
    sendAlert(env, "whatsapp_send_failed", String(err)).catch(() => {});
    if (taskResults.length === 0) throw err;
  }
  console.log(`${tag} send=${Date.now() - tSend}ms`);

  try {
    await saveMessage(db, env.ENCRYPTION_KEY, {
      userId,
      messageType,
      content: text,
      aiResponse: aiReply,
      // Use executedTasks (with real DB IDs) when available so 👍 can resolve the task
      parsedTasks: {
        tasks: executedTasks.length > 0 ? executedTasks : parsed.tasks,
        intent: parsed.intent,
      },
      whatsappMessageId: msgId,
    });
  } catch (err) {
    console.error(`${tag} db_save_failed:`, err);
    await capture(env, `user_${userId}`, "db_save_failed", { stage: "save_message" });
    sendAlert(env, "db_save_failed", String(err)).catch(() => {});
  }
  if(undo.changedTaskIds?.length){await afterTaskChanges(env,user,phone,undo.groupId,waitUntil).catch(()=>{});await maybeOfferShare(env,user,phone,{groupId:undo.groupId},waitUntil).catch(()=>{});}

  console.log(`${tag} total=${Date.now() - t0}ms`);
}

function stripPartnerPrefix(title: string): string {
  return title.replace(/^\(שותף\)\s*/u, "");
}

function stripAssignmentDecorations(title: string): string {
  return title
    .replace(/^\(שותף\)\s*/u, "")
    .replace(/^\(מאת:[^)]+\)\s*/u, "")
    .replace(/\s*\(תויגו:[^)]+\)/u, "")
    .replace(/\s*\[פרויקט:[^\]]+\]/u,'')
    .trim();
}


const CONCRETE_TASK_VERBS = [
  "לקנות", "להתקשר", "לעשות", "לשלוח", "לכתוב", "לבדוק", "להביא", "לקחת",
  "לסגור", "לפתוח", "לשלם", "לחדש", "להכין", "לפגוש", "לנקות", "לסדר",
  "למלא", "לתקן", "להזמין", "לקרוא", "לסיים", "להחזיר", "להוציא", "להכניס",
];

function normalizeForIntent(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstConcreteTaskVerb(value: string): string | null {
  const normalized = normalizeForIntent(value);
  return CONCRETE_TASK_VERBS.find((verb) => new RegExp(`(^|\\s)${verb}(\\s|$)`, "u").test(normalized)) ?? null;
}

function isLikelyQuotedReminderRescheduleReply(task: ParsedTask, userText: string, quotedTask: Task): boolean {
  if (task.action !== "add" || !task.due_date) return false;

  const normalizedTitle = normalizeForIntent(task.title);
  const normalizedText = normalizeForIntent(userText);
  const normalizedQuoted = normalizeForIntent(quotedTask.description);

  if (!normalizedTitle) return true;
  if (normalizedTitle === normalizedQuoted || normalizedTitle.includes(normalizedQuoted)) return true;

  const newTaskVerb = firstConcreteTaskVerb(userText);
  if (newTaskVerb && !normalizedQuoted.includes(newTaskVerb)) return false;

  const reminderish = /(תזכיר|הזכר|דחה|תדחה|שוב|remind|snooze)/iu.test(userText);
  const parsedLooksLikeCommand = normalizedTitle === normalizedText || /(תזכיר|הזכר|remind)/iu.test(task.title);
  return reminderish && parsedLooksLikeCommand;
}

function formatUpdatedTask(updated: Task): string {
  let display = `✏️ עודכנה: *${updated.description}*`;
  if (updated.due_date) {
    const d = new Date(new Date(updated.due_date).toLocaleString("en-US", { timeZone: TZ }));
    const p = (n: number) => String(n).padStart(2, "0");
    display += ` ⏰ ${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return display;
}

async function executeTask(
  db: ReturnType<typeof buildDb>,
  userId: number,
  accessible: number[],
  task: ParsedTask,
  env: Env,
  prefetchedPending?: Task[],
  assignedTaskIds: number[] = [],
  friends: { friend: { id: number; phone_number_encrypted: string; phone_number_hash: string; created_at: Date; last_active: Date; partner_user_id: number | null; api_token_encrypted: string | null; api_token_hash: string | null; api_token_created_at: Date | null }; nickname: string }[] = [],
  senderPhone = "",
  quotedReminderTask: Task | null = null,
  userText = "",
  undo?: UndoContext
): Promise<{ display: string | null; taskId: number | null; alreadySent?:boolean }> {
  const action = task.action;
  const user=await getUserById(db,userId);if(!user)return{display:'החשבון אינו זמין.',taskId:null};
  if(action==='recover'){await showRecovery(env,user,senderPhone);return{display:'בדיקת משימות באיחור נפתחה.',taskId:null,alreadySent:true};}
  if(action==='project_list'){await showProjects(env,user,senderPhone);return{display:'רשימת הפרויקטים נפתחה.',taskId:null,alreadySent:true};}
  if(action==='project_create'){
    const context=undo??newUndoContext(userId);const project=await createChecklist(env,user,task.project_name!,task.checklist_items??[],context);
    return{display:await projectText(env,user,project)+'\nלבחירת פריט: /project '+project.name,taskId:null};
  }
  if(action==='project_show'||(action==='list'&&task.project_name)){
    const project=await resolveProject(env,user,task.project_name!);
    if(!project)return{display:'לא נמצא פרויקט בשם הזה, או שיש כמה התאמות. /projects — בחירה לפי שם.',taskId:null};
    await showProject(env,user,senderPhone,project);return{display:await projectText(env,user,project),taskId:null,alreadySent:true};
  }
  if(['complete','delete','update','stop_recurrence'].includes(action)){
    let candidates=prefetchedPending??await getUserTasks(db,env.ENCRYPTION_KEY,accessible,'pending',assignedTaskIds);
    if(task.project_name){
      const project=await resolveProject(env,user,task.project_name);
      if(!project)return{display:'לא נמצא פרויקט מתאים. /projects — בחירה לפי שם.',taskId:null};
      candidates=candidates.filter(t=>t.project_id===project.id);
    }
    const key=stripAssignmentDecorations(task.title).toLowerCase().trim();
    const exact=candidates.filter(t=>t.description.toLowerCase().trim()===key);
    const matches=exact.length?exact:candidates.filter(t=>key && (t.description.toLowerCase().includes(key)||key.includes(t.description.toLowerCase())));
    if((task.project_name||task.new_project_name||matches.length>1)&&!quotedReminderTask){
      if(matches.length!==1)return{display:matches.length?'יש כמה משימות עם שם דומה. אפשר לציין את שם הפרויקט או לבחור דרך /projects.':'לא נמצאה משימה בשם הזה בפרויקט. לא בוצע שינוי.',taskId:null};
      quotedReminderTask=matches[0];
    }
    if(task.project_name&&quotedReminderTask&&!candidates.some(t=>t.id===quotedReminderTask!.id))return{display:'המשימה המצוטטת אינה בפרויקט שביקשת. לא בוצע שינוי.',taskId:null};
  }

  if(undo && quotedReminderTask)undo={...undo,expectedRevision:quotedReminderTask.revision};
  if (action === "add") {
    let dueDate = parseDueDate(task.due_date);
    if (quotedReminderTask && dueDate && isLikelyQuotedReminderRescheduleReply(task, userText, quotedReminderTask)) {
      const updated = await updateTaskById(db, env.ENCRYPTION_KEY, quotedReminderTask.id, accessible, { due_date: dueDate }, assignedTaskIds,undo);
      if (updated) {
        capture(env, `user_${userId}`, "task_rescheduled", { task_id: updated.id, update_method: "quoted_reminder_reply" }).catch(() => {});
        return { display: formatUpdatedTask(updated), taskId: updated.id };
      }
    }

    const recurrence = task.recurrence ?? null;
    if (recurrence && !dueDate) {
      return { display: `⚠️ משימה חוזרת דורשת שעה. באיזו שעה תרצה לקבל את התזכורת?`, taskId: null };
    }
    if(recurrence&&dueDate){dueDate=firstRecurringOccurrence(dueDate,recurrence);if(!dueDate)return{display:'לא נמצא מועד עתידי מתאים לחזרה. אפשר לציין ימים ושעה מחדש?',taskId:null};}
    const project=task.project_name?await getOrCreateProject(env,userId,task.project_name):null;
    const added = await addTask(db, env.ENCRYPTION_KEY, userId, task.title, dueDate, recurrence,undo,{projectId:project?.id});
    capture(env, `user_${userId}`, "task_created", { creation_method: "llm", has_due_date: !!dueDate, recurrence: recurrence ?? "none" }).catch(() => {});
    const recLabel = (recurrence ? ` 🔁 ${recurrenceLabel(recurrence)}` : "")+(project?` 📋 ${project.name}`:'');

    // Handle assignees
    const assigneeNicknames: string[] = [];
    if (task.assignees && task.assignees.length > 0) {
      const resolvedIds: number[] = [];
      for (const nick of task.assignees) {
        const found = await getFriendByNickname(db, userId, nick);
        if (found) {
          resolvedIds.push(found.friend.id);
          assigneeNicknames.push(found.nickname);
        }
      }
      if (resolvedIds.length > 0) {
        await addTaskAssignees(db, added.id, resolvedIds);
        capture(env, `user_${userId}`, "task_assigned", { task_id: added.id, assignee_count: resolvedIds.length }).catch(() => {});

        // Notify each assignee immediately
        const p = (n: number) => String(n).padStart(2, "0");
        const dueFmtShort = dueDate
          ? (() => {
              const d = new Date(dueDate.toLocaleString("en-US", { timeZone: TZ }));
              return ` ⏰ ${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
            })()
          : "";

        for (const friendId of resolvedIds) {
          const friendData = friends.find((f) => f.friend.id === friendId);
          if (!friendData) continue;

          const theirNicknameForMe = await getNicknameForUser(db, friendId, userId);
          const senderLabel = theirNicknameForMe ?? senderPhone.slice(-4);

          const assigneePhone = await decryptPhone(friendData.friend, env.ENCRYPTION_KEY).catch(() => "");
          if (!assigneePhone) continue;

          const notifyText = `👥 *${senderLabel}* שייך אותך למשימה: *${added.description}*${dueFmtShort}`;
          const notifyMsgId = await sendMessage(env, assigneePhone, notifyText).catch(() => null);

          // Save messages row so 👍 from assignee can resolve the task
          saveMessage(db, env.ENCRYPTION_KEY, {
            userId: friendId,
            messageType: "system",
            content: null,
            aiResponse: notifyText,
            parsedTasks: { tasks: [{ task_id: added.id, description: added.description }] },
            whatsappMessageId: notifyMsgId,
          }).catch(() => {});
        }
      }
    }

    const assignedLabel = assigneeNicknames.length > 0 ? ` (תויגו: ${assigneeNicknames.join(", ")})` : "";
    if (dueDate) {
      const d = new Date(dueDate.toLocaleString("en-US", { timeZone: TZ }));
      const p = (n: number) => String(n).padStart(2, "0");
      const dueFmt = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
      return { display: `✅ נוספה: *${added.description}*${assignedLabel}${recLabel} ⏰ ${dueFmt}`, taskId: added.id };
    }
    return { display: `✅ נוספה: *${added.description}*${assignedLabel}${recLabel}`, taskId: added.id };
  }

  if (action === "complete" || action === "delete") {
    if (quotedReminderTask) {
      const completed = await completeTask(db, env.ENCRYPTION_KEY, quotedReminderTask.id, accessible, assignedTaskIds,undo);
      if (completed) {
        capture(env, `user_${userId}`, "task_completed", { completion_method: "quoted_reminder_reply" }).catch(() => {});
        let display = `🎉 הושלמה: *${completed.description}*`;
        if (completed.due_date) {
          const d = new Date(new Date(completed.due_date).toLocaleString("en-US", { timeZone: TZ }));
          const p = (n: number) => String(n).padStart(2, "0");
          display += ` ⏰ ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
        }
        return { display, taskId: completed.id };
      }
    }

    const completed = await completeTaskByDescription(db, env.ENCRYPTION_KEY, accessible, stripAssignmentDecorations(task.title), assignedTaskIds,undo);
    if (completed) {
      capture(env, `user_${userId}`, "task_completed", { completion_method: "llm" }).catch(() => {});
      let display = `🎉 הושלמה: *${completed.description}*`;
      if (completed.due_date) {
        const d = new Date(new Date(completed.due_date).toLocaleString("en-US", { timeZone: TZ }));
        const p = (n: number) => String(n).padStart(2, "0");
        display += ` ⏰ ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
      }
      return { display, taskId: completed.id };
    }
    return { display: `❌ לא מצאתי משימה בשם "${task.title}". לא בוצע שינוי.`, taskId: null };
  }

  if (action === "update") {
    if(task.new_project_name){
      if(!quotedReminderTask||quotedReminderTask.user_id!==userId)return{display:'אפשר להעביר לפרויקט רק משימה שיצרת. לא בוצע שינוי.',taskId:null};
      const project=await getOrCreateProject(env,userId,task.new_project_name),context={...(undo??newUndoContext(userId)),expectedRevision:quotedReminderTask.revision};
      const patch:{project_id:number;description?:string;due_date?:number|null;reminder_sent?:number}={project_id:project.id};
      if(task.new_title)patch.description=await fernetEncrypt(task.new_title,env.ENCRYPTION_KEY);
      if(task.new_due_date!==undefined){const due=parseDueDate(task.new_due_date);patch.due_date=due?Math.floor(+due/1000):null;patch.reminder_sent=0;}
      const changed=await trackedTaskMutation(env.DB,env.ENCRYPTION_KEY,context,quotedReminderTask.id,patch);
      return{display:changed?`📋 *${task.new_title??quotedReminderTask.description}* הועברה לפרויקט *${project.name}*`:'המשימה השתנתה. לא בוצע שינוי.',taskId:changed?quotedReminderTask.id:null};
    }
    const updates: { description?: string; due_date?: Date | null } = {};
    if (task.new_title) updates.description = task.new_title;
    if (task.new_due_date !== undefined) updates.due_date = parseDueDate(task.new_due_date);
    if (quotedReminderTask && Object.keys(updates).length > 0) {
      const updated = await updateTaskById(db, env.ENCRYPTION_KEY, quotedReminderTask.id, accessible, updates, assignedTaskIds,undo);
      if (updated) {
        capture(env, `user_${userId}`, "task_updated", { update_method: "quoted_reminder_reply" }).catch(() => {});
        if (task.new_due_date) capture(env, `user_${userId}`, "task_rescheduled", { task_id: updated.id }).catch(() => {});
        return { display: formatUpdatedTask(updated), taskId: updated.id };
      }
    }

    const updated = await updateTaskByDescription(db, env.ENCRYPTION_KEY, accessible, stripAssignmentDecorations(task.title), updates,undo);
    if (updated) {
      capture(env, `user_${userId}`, "task_updated", { update_method: "llm" }).catch(() => {});
      if (task.new_due_date) capture(env, `user_${userId}`, "task_rescheduled", { task_id: updated.id }).catch(() => {});
      return { display: formatUpdatedTask(updated), taskId: updated.id };
    }
    return { display: `❌ לא מצאתי משימה בשם "${task.title}" לעדכון`, taskId: null };
  }

  if (action === "stop_recurrence") {
    if(task.project_name && quotedReminderTask){
      const changed=await trackedTaskMutation(env.DB,env.ENCRYPTION_KEY,{...(undo??newUndoContext(userId)),expectedRevision:quotedReminderTask.revision},quotedReminderTask.id,{recurrence:null});
      return{display:changed?`🔁 הוסרה החזרה מ: *${quotedReminderTask.description}* ✅`:'המשימה השתנתה. לא בוצע שינוי.',taskId:changed?quotedReminderTask.id:null};
    }
    const updated = await clearRecurrenceByDescription(db, env.ENCRYPTION_KEY, accessible, stripAssignmentDecorations(task.title),undo);
    if (updated) {
      capture(env, `user_${userId}`, "recurrence_stopped", { task_id: updated.id }).catch(() => {});
      return { display: `🔁 הוסרה החזרה מ: *${updated.description}* ✅`, taskId: updated.id };
    }
    return { display: `❌ לא מצאתי משימה חוזרת בשם "${task.title}"`, taskId: null };
  }

  if (action === "list") {
    await showTaskList(env,user,senderPhone);
    return {display:'רשימת המשימות נפתחה.',taskId:null,alreadySent:true};
  }

  return { display: "❌ לא ניתן לבצע את הפעולה. לא בוצע שינוי.", taskId: null };
}


async function processVoice(msg: QueueMessage, env: Env,waitUntil?:AnalyticsWaitUntil): Promise<void> {
  const { userId, phone, audioId, audioMimeType = "audio/ogg" } = msg;
  const t0 = Date.now();
  const queueDelay = msg.enqueuedAt ? t0 - msg.enqueuedAt : -1;
  const tag = `[VOICE u=${userId}]`;
  console.log(`${tag} start | queue_delay=${queueDelay}ms audio=${audioId}`);

  if (!audioId) {
    await sendMessage(env, phone, "לא הצלחתי לעבד את ההקלטה 🎙️ נסה שוב");
    return;
  }

  let audioBuffer: ArrayBuffer;
  try {
    audioBuffer = await downloadMedia(env, audioId);
  } catch (err) {
    console.error(`${tag} download_failed after ${Date.now() - t0}ms:`, err);
    await capture(env, `user_${userId}`, "voice_download_failed");
    await sendMessage(env, phone, "לא הצלחתי להוריד את ההקלטה 🎙️ נסה שוב");
    return;
  }
  console.log(`${tag} download=${Date.now() - t0}ms`);

  const tStt = Date.now();
  let transcript: string;
  try {
    transcript = await transcribeAudio(env, audioBuffer, audioMimeType);
    console.log(`${tag} stt=${Date.now() - tStt}ms transcript_len=${transcript.length}`);
  } catch (err) {
    console.error(`${tag} stt_failed after ${Date.now() - tStt}ms:`, err);
    await capture(env, `user_${userId}`, "voice_transcription_failed");
    await sendMessage(env, phone, "לא הצלחתי להבין את ההקלטה 🎙️ אפשר לנסות הודעת טקסט?");
    return;
  }

  if (!transcript) {
    await sendMessage(env, phone, "לא שמעתי כלום בהקלטה 🎙️ נסה לשלוח שוב");
    return;
  }

  await processText({ ...msg, type: "text_processing", text: transcript }, env, "audio",waitUntil);
}
