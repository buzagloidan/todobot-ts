import type { Env } from "../types.ts";
import type { User } from "../db/schema.ts";
import { buildDb } from "../db/client.ts";
import { fernetEncrypt } from "../crypto/fernet.ts";
import {
  saveMessage,
} from "../db/queries.ts";
import { sendMessage, sendInteractiveButtons } from "./whatsapp.ts";
import { signControl, verifyControl } from "./controls.ts";
import { newUndoContext } from "./task_undo.ts";
import { sendTaskReply } from "./task_controls.ts";
import {
  calendarCommand,
  getCalendarConnection,
  digest,
} from "./google_calendar.ts";
import { showProjects } from "./projects.ts";
import { showTaskList } from "./task_browser.ts";
import { billingEnabled, billingReply, hasAccess } from "./billing.ts";
import { capture, type AnalyticsWaitUntil } from "./posthog.ts";

export const HELP_TEXT = `*טודו — המשימות שלך ב־WhatsApp* 📋

כתוב או הקלט מה צריך לעשות ומתי:
״תזכיר לי להתקשר לבנק מחר ב־10:00״

📅 /calendar — המשימות גם ביומן Google, עם סנכרון דו־כיווני
📋 ? — בחירת משימה ופעולות · ?1 — היום הקרוב
🗂️ # — פרויקטים וצ׳קליסטים
״צור צ׳קליסט למעבר דירה״

👆 להשלמה או לדחייה, לחץ על הכפתורים שמתחת למשימה.

🎁 7 ימי ניסיון חינם ללא כרטיס, ואז 20 ₪ לחודש. /billing
/help more — עוד כלים · /tos · /privacy`;

export const MORE_HELP_TEXT = `*עוד כלים בטודו* 🧰

*משימות*
״להתאמן כל ראשון ורביעי ב־18:00״ — חזרה לפי ימים
?2 — היומיים הקרובים · # <שם> — פרויקט
״סיימתי להתקשר לבנק״ — השלמה לפי שם
- חלב · -2 — השלמה לפי שם או מספר · -הכל — הכול
👍 על תזכורת — השלמה · 😴 — דחייה ב־15 דקות
דחה 30 / דחה שעה — דחייה לזמן אחר

*סדר היום והיומן*
/agenda now — היום ובאיחור · /agenda focus — עדיפויות
/calendar sync — סנכרון · /calendar disconnect — ניתוק

*ביחד*
/share — שתף את טודו עם חבר
/partner — שותף למשימות · /unpartner — ניתוק
/friend <כינוי> — הזמן חבר · /friends — חברים
/yes או /no — מענה · /cancel — ביטול הזמנה
/unfriend <כינוי> — הסרת חבר

*חשבון ועזרה*
/billing — מנוי וניסיון · /feedback — פידבק
/api — סקריפטים ואוטומציות · /delete — מחיקת חשבון
/tos · /privacy · /help — המדריך הקצר`;

export const WELCOME_TEXT = `היי, אני *טודו* 👋
משימות ותזכורות ב־WhatsApp, גם בהודעות קוליות.

נתחיל ממשהו קטן: ״תזכיר לי להתקשר לבנק מחר ב־10:00״.
אפשר גם לבדוק תזכורת בעוד דקה מהכפתור למטה.

📅 בהמשך אפשר לחבר את Google Calendar ולראות את המשימות גם ביומן.
🎁 7 ימי ניסיון חינם ללא כרטיס, ואז 20 ₪ לחודש. /billing
השימוש כפוף לתנאים ולפרטיות: /tos · /privacy`;

export function guideText(env: Env, text: string): string {
  if (billingEnabled(env)) return text;
  return text.replace(/🎁 7 ימי ניסיון חינם ללא כרטיס, ואז 20 ₪ לחודש\. \/billing\n?/g, "")
    .replace("/billing — מנוי וניסיון · ", "");
}

const START_TEXT =
  "⏰ מה צריך לעשות ומתי?\nכתוב או הקלט, למשל: ״תזכיר לי לקחת הפסקה בעוד שעה״.\n\n? — המשימות שלך · # — פרויקטים וצ׳קליסטים\nאפשר לבדוק תזכורת בעוד דקה מהכפתור למטה.";
const now = () => Math.floor(Date.now() / 1000);
type Action =
  | "demo"
  | "calendar"
  | "projects"
  | "list"
  | "help"
  | "more"
  | "start";
async function buttons(env: Env, userId: number, choices: [Action, string][]) {
  return Promise.all(
    choices.map(async ([action, title]) => ({
      id: await signControl(env, "guide", userId, action, now() + 604800),
      title,
    })),
  );
}
export async function sendWelcomeMessage(
  env: Env,
  phone: string,
  userId: number,
): Promise<string | null> {
  return sendInteractiveButtons(
    env,
    phone,
    guideText(env, WELCOME_TEXT),
    await buttons(env, userId, [
      ["demo", "תזכורת בעוד דקה"],
      ["calendar", "Google Calendar"],
      ["start", "איך מתחילים?"],
    ]),
  );
}
export async function sendGuide(
  env: Env,
  user: User,
  phone: string,
  view: "help" | "more" | "start",
  waitUntil?: AnalyticsWaitUntil,
): Promise<void> {
  const text = guideText(env,
    view === "more"
      ? MORE_HELP_TEXT
      : view === "start"
        ? START_TEXT
        : HELP_TEXT);
  const choices: [Action, string][] =
    view === "start"
      ? [
          ["demo", "תזכורת בעוד דקה"],
          ["calendar", "Google Calendar"],
          ["projects", "פרויקטים וצ׳קליסטים"],
        ]
      : [
          ["calendar", "Google Calendar"],
          ["list", "המשימות שלי"],
          ["projects", "פרויקטים וצ׳קליסטים"],
        ];
  const id = await sendInteractiveButtons(
    env,
    phone,
    text,
    await buttons(env, user.id, choices),
  );
  await saveMessage(buildDb(env), env.ENCRYPTION_KEY, {
    userId: user.id,
    messageType: "system",
    content: "/help" + (view === "more" ? " more" : ""),
    aiResponse: text,
    parsedTasks: null,
    whatsappMessageId: id,
  });
  await capture(
    env,
    `user_${user.id}`,
    "guide_shown",
    { surface: view },
    { waitUntil },
  );
}
export async function guideCommand(
  env: Env,
  user: User,
  phone: string,
  text: string,
  waitUntil?: AnalyticsWaitUntil,
): Promise<boolean> {
  const cmd = text.trim().toLowerCase();
  if (!["/help", "/help more"].includes(cmd)) return false;
  await sendGuide(
    env,
    user,
    phone,
    cmd === "/help more" ? "more" : "help",
    waitUntil,
  );
  return true;
}
export async function handleGuideControl(
  env: Env,
  user: User,
  phone: string,
  payload: string,
  waitUntil?: AnalyticsWaitUntil,
): Promise<boolean> {
  const c = await verifyControl(env, payload, user.id);
  if (c?.kind !== "guide") return false;
  const [, action, expiry] = c.values;
  if (
    !["demo", "calendar", "projects", "list", "help", "more", "start"].includes(
      action,
    ) ||
    !/^\d+$/.test(expiry ?? "")
  )
    return false;
  if (+expiry <= now()) {
    await sendMessage(env, phone, "הכפתור פג. /help — המדריך העדכני.");
    return true;
  }
  await capture(
    env,
    `user_${user.id}`,
    "guide_clicked",
    { feature: action },
    { waitUntil },
  );
  if (["help", "more", "start"].includes(action)) {
    await sendGuide(
      env,
      user,
      phone,
      action as "help" | "more" | "start",
      waitUntil,
    );
    return true;
  }
  if (!(await hasAccess(env, user))) {
    await sendMessage(env, phone, await billingReply(env, user));
    return true;
  }
  if (action === "calendar") {
    await sendMessage(
      env,
      phone,
      await calendarCommand(env, user, "/calendar"),
    );
    return true;
  }
  if (action === "projects") {
    await showProjects(env, user, phone);
    return true;
  }
  if (action === "list") {
    await showTaskList(env,user,phone,'all',0,waitUntil);return true;
  }
  const key = `guide-demo:${await digest(payload)}`;
  const undo = newUndoContext(user.id),
    due = new Date(Date.now() + 60000);
  undo.groupId = (await digest(key)).slice(0, 32);
  const description = "בדיקת התזכורת הראשונה";
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO task_control_use(key,actor_user_id,expires_at) VALUES (?,?,?)",
    ).bind(key, user.id, +expiry),
    env.DB.prepare(
      "INSERT OR IGNORE INTO task_undo(id,actor_user_id,created_at,expires_at) SELECT ?,?,?,? WHERE changes()>0",
    ).bind(undo.groupId, user.id, now(), now() + 600),
    env.DB.prepare(
      "INSERT INTO task(user_id,description,due_date,status,created_at,updated_at) SELECT ?,?,?,'pending',?,? WHERE changes()>0 RETURNING id",
    ).bind(
      user.id,
      await fernetEncrypt(description, env.ENCRYPTION_KEY),
      Math.floor(+due / 1000),
      now(),
      now(),
    ),
    env.DB.prepare(
      "INSERT INTO task_undo_change(group_id,task_id,before_encrypted,after_revision) SELECT ?,id,NULL,revision FROM task WHERE id=last_insert_rowid() AND changes()>0",
    ).bind(undo.groupId),
  ]);
  const created = results[2].results[0] as { id: number } | undefined;
  if (!created) {
    await sendMessage(
      env,
      phone,
      "כבר נוצרה תזכורת מהכפתור הזה. ? — המשימות שלך.",
    );
    return true;
  }
  const task = { id: created.id, description };
  undo.changedTaskIds?.push(task.id);
  const text =
    "✅ התזכורת לדוגמה מוכנה — בעוד דקה.\nאחרי שתגיע, אפשר ללחוץ ״הושלם״. לתזכורת משלך פשוט כתוב או הקלט מה צריך לעשות ומתי.";
  const id = await sendTaskReply(env, user.id, phone, text, undo, task.id);
  await saveMessage(buildDb(env), env.ENCRYPTION_KEY, {
    userId: user.id,
    messageType: "button",
    content: "guide demo",
    aiResponse: text,
    parsedTasks: {
      tasks: [{ task_id: task.id, description: task.description }],
    },
    whatsappMessageId: id,
  });
  await afterTaskChanges(env, user, phone, undo.groupId, waitUntil);
  return true;
}

/** Contextual discovery only after real successful task creation, never a scheduled campaign. */
export async function afterTaskChanges(
  env: Env,
  user: User,
  phone: string,
  groupId: string,
  waitUntil?: AnalyticsWaitUntil,
): Promise<void> {
  const created = (
    await env.DB.prepare(
      `SELECT t.id,t.due_date FROM task_undo_change c JOIN task t ON t.id=c.task_id
    WHERE c.group_id=? AND c.before_encrypted IS NULL AND t.user_id=? AND t.status='pending'`,
    )
      .bind(groupId, user.id)
      .all<{ id: number; due_date: number | null }>()
  ).results;
  if (!created.length) return;
  const total = (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM task WHERE user_id=?",
  )
    .bind(user.id)
    .first<{ n: number }>())!.n;
  const activatedKey = `guide:v2:${user.id}:activated`;
  if (total === created.length && !(await env.CACHE.get(activatedKey))) {
    await env.CACHE.put(activatedKey, "1", { expirationTtl: 365 * 86400 });
    await capture(
      env,
      `user_${user.id}`,
      "first_task_created",
      {
        task_count: created.length,
        has_due_date: created.some((t) => t.due_date !== null),
      },
      { waitUntil },
    );
  }
  // At most one discovery message per day; connected/used features are not promoted again.
  const cooldown = `guide:v2:${user.id}:cooldown`;
  if (await env.CACHE.get(cooldown)) return;
  const calendarKey = `guide:v2:${user.id}:calendar`,
    projectsKey = `guide:v2:${user.id}:projects`;
  let feature: "calendar" | "projects" | undefined;
  if (
    created.some((t) => t.due_date !== null) &&
    !(await env.CACHE.get(calendarKey))
  ) {
    const conn = await getCalendarConnection(env, user.id);
    if (!conn || conn.status !== "connected") feature = "calendar";
  }
  if (!feature && total >= 3 && !(await env.CACHE.get(projectsKey))) {
    const row = await env.DB.prepare(
      "SELECT 1 FROM project WHERE user_id=? LIMIT 1",
    )
      .bind(user.id)
      .first();
    if (!row) feature = "projects";
  }
  if (!feature) return;
  const text =
    feature === "calendar"
      ? "📅 רוצה לראות את המשימות גם ביומן Google?\nחיבור קצר יוצר יומן Todobot ומסנכרן את המשימות בשני הכיוונים. אפשר להמשיך גם בלי לחבר."
      : "🗂️ אפשר לקבץ משימות לפרויקטים וצ׳קליסטים.\nלמשל: ״צור צ׳קליסט למעבר דירה״. # מציג את הפרויקטים וההתקדמות שלך.";
  await sendInteractiveButtons(
    env,
    phone,
    text,
    await buttons(env, user.id, [
      [feature, feature === "calendar" ? "Google Calendar" : "הפרויקטים שלי"],
      ["help", "המדריך הקצר"],
    ]),
  );
  await Promise.all([
    env.CACHE.put(feature === "calendar" ? calendarKey : projectsKey, "1", {
      expirationTtl: 365 * 86400,
    }),
    env.CACHE.put(cooldown, "1", { expirationTtl: 86400 }),
  ]);
  await capture(
    env,
    `user_${user.id}`,
    "feature_discovery_shown",
    { feature },
    { waitUntil },
  );
}
