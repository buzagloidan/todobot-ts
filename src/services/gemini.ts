import type { Env, ParsedTask } from "../types.ts";
import { checkServiceRateLimit } from "../rate_limit.ts";
import { TZ } from "../constants.ts";
import { validateTaskResponse, formatConversationHistory, INVALID_TASK_REPLY } from "./task_response.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = "gemini-flash-lite-latest";

export interface ProcessedMessage {
  tasks: ParsedTask[];
  intent: "task_management" | "question" | "conversation";
  reply: string;
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function buildDateInfo() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(now);
  dayAfter.setDate(dayAfter.getDate() + 2);
  return {
    date_time: `${fmt(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    tomorrow: fmt(tomorrow),
    day_after: fmt(dayAfter),
  };
}

// ── Gemini call ────────────────────────────────────────────────────────────────

export async function callGemini(
  env: Env,
  prompt: string,
  opts: { maxTokens?: number; jsonMode?: boolean } = {}
): Promise<string> {
  const rateCheck = await checkServiceRateLimit(env.CACHE, "gemini");
  if (!rateCheck.allowed) throw new Error(`Gemini rate limited: ${rateCheck.message}`);

  const url = `${GEMINI_BASE}/${MODEL}:generateContent`;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: opts.maxTokens ?? 400,
    temperature: 0,
    topP: 0.95,
  };
  if (opts.jsonMode) generationConfig.responseMimeType = "application/json";

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig,
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        throw new Error(`Gemini API ${res.status}`);
      }

      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
      const isRetryable = isTimeout ||
        (err instanceof Error && /Gemini API (429|500|503)/.test(err.message));
      if (isRetryable && attempt === 1) {
        console.warn("[GEMINI] retryable error on attempt 1, retrying...", String(err));
        continue;
      }
      throw err;
    }
  }

  // unreachable — loop always returns or throws
  throw new Error("Gemini: exhausted retries");
}

// ── Prompt ─────────────────────────────────────────────────────────────────────

const PROMPT = `אתה טודו - עוזר ניהול משימות בעברית. החזר JSON בלבד.
משימות המסומנות (שותף) שייכות לשותף של המשתמש — טפל בהן רגיל, והחזר אותן ב-reply עם הסימון.
משימות המסומנות (מאת: X) הוקצו למשתמש על ידי חבר — טפל בהן רגיל.

📅 {date_time} (ישראל) | {pending} משימות ממתינות{tasks_block}{friends_block}{projects_block}{history_block}{quoted_block}

פורמט חובה:
{"tasks":[{"action":"add|complete|list|delete|update|stop_recurrence|project_create|project_show|project_list|recover","title":"...","project_name":"...","new_project_name":"...","checklist_items":["פריט"],"due_date":"YYYY-MM-DD HH:MM או null","recurrence":"daily|weekly|monthly|weekdays|weekly:0,3|monthly:1|null","new_title":"...","new_due_date":"YYYY-MM-DD HH:MM או null","assignees":["כינוי1","כינוי2"]}],"intent":"task_management|conversation","reply":"..."}

• ניתן להחזיר מספר פריטים במערך tasks אם המשתמש מבקש כמה פעולות בהודעה אחת
• new_project_name — פרויקט יעד להעברת משימה קיימת; project_name הוא הפרויקט הנוכחי לחיפוש.
• new_title ו-new_due_date — רק עבור action=update; השמט שדות שלא רלוונטיים לפעולה
• כשמבקשים תזכורת אחת בכמה שורות (שורה עם זמן + שורה עם תיאור) — החזר משימה אחת בלבד עם title=התיאור ו-due_date=הזמן; אל תיצור משימה נפרדת לזמן
• assignees — רשימת כינויי חברים לתיוג (רק עבור action=add); הכנס רק כינויים שמופיעים ברשימת החברים; זהה תיוג מ-@כינוי, ביטויים כמו "לאבא", "לאמא", "לאחות" המתאימים לכינוי קיים; הסר את הזכרת השם מ-title; אם שם לא מתאים לכינוי קיים — אל תכניס אותו ל-assignees

due_date / new_due_date:
• הגדר רק אם המשתמש ציין זמן מפורש ("ב-18:00", "מחר בבוקר") או יחסי ("עוד שעה", "בעוד 5 דקות") — אחרת null בלבד
• אל תמציא שעה: "תזכיר לי לאכול" ללא זמן → due_date=null
• פורמט: YYYY-MM-DD HH:MM (שעון ישראל)
• ביטויים יחסיים: "עוד דקה"→+1 דקה, "בעוד 5 דקות"→+5 דקות, "בעוד שעה"→+60 דקות, "בעוד חצי שעה"→+30 דקות
• מחר={tomorrow} | מחרתיים={day_after}
• לעולם אל תיצור due_date שכבר עבר — אם שעה שצוינה (כגון "ב-6", "ב-7") קטנה מהשעה הנוכחית, הנח PM (הוסף 12); אם גם PM כבר עבר — קבע למחר באותה שעה. דוגמה: עכשיו 15:00, המשתמש אמר "ב-6" → 18:00 באותו יום; אמר "ב-14" → 14:00 למחרת

recurrence (רק עבור action=add):
• "daily" — "כל יום", "יומי", "כל בוקר/ערב"
• "weekly" — "כל שבוע", "כל שני/שלישי/רביעי/חמישי/שישי/שבת/ראשון", "כל יום ראשון/שני/..." (חייב "כל" לפני), "שבועי" — חייב להופיע המילה "כל" לפני שם היום; אזכור יום בודד ("ברביעי", "ביום שישי", "יום ראשון", "יום שני") הוא תאריך חד-פעמי ולא חזרה
• "monthly" — "כל חודש", "חודשי"
• null — ברירת מחדל; השמט אם אין חזרה
• "weekdays" — כל יום עבודה / ימי עבודה: ראשון–חמישי לפי שעון ישראל (ללא חישוב חגים). אם מצוינים ימים אחרים השתמש ב-weekly:.
• "weekly:0,3" — ימים מסוימים בכל שבוע: 0=ראשון, 1=שני, 2=שלישי, 3=רביעי, 4=חמישי, 5=שישי, 6=שבת. רשימה ללא כפילויות. "כל ראשון ורביעי" → weekly:0,3; "כל שני עד שישי" → weekly:1,2,3,4,5.
• "monthly:1" — יום בחודש: 1–31. "ביום הראשון בכל חודש" → monthly:1; "ב-15 בכל חודש" → monthly:15. תאריכים שאינם קיימים בחודש מדולגים, ולא גולשים לחודש אחר.
• בכל סוג חזרה due_date הוא המועד הראשון המתאים לבקשה עם השעה שהמשתמש נתן, לפי שעון ישראל. המערכת תוודא שהמועד תואם את הימים/היום בחודש. אין ליצור משימות נפרדות לכל יום בשבוע — משימה אחת עם כלל חזרה.
• דוגמה: "תזכיר לי להתאמן כל ראשון ורביעי ב-18:00" → action=add,title="להתאמן",recurrence="weekly:0,3".
• דוגמה: "להגיש דוח ביום הראשון בכל חודש ב-09:00" → action=add,title="להגיש דוח",recurrence="monthly:1".
• recurrence חייב להיות מלווה ב-due_date — אם המשתמש לא ציין שעה/זמן, בקש: "באיזו שעה להגדיר את התזכורת?"
• אם המשתמש מבקש חזרה שאינה יומית/שבועית/חודשית (למשל: כל X דקות, כל X שעות, כל כמה ימים) — אל תוסיף משימה ואל תנחש; החזר tasks=[] ו-intent="conversation" עם reply שמסביר: "אני תומך רק בחזרה יומית, שבועית או חודשית. באיזו תדירות?"

פרויקטים וצ׳קליסטים:
• project_create — בקשת יצירת פרויקט, רשימת בדיקה, צ׳קליסט או checklist. project_name=שם הקבוצה, checklist_items=פריטים כמשימות רגילות ללא שעה, במערך אחד. אל תחזיר add נוסף לאותם פריטים.
• אם ניתנו פריטים מפורשים — השתמש בהם בלבד. אם התבקשה רשימת בדיקה לנושא כמו מעבר דירה ללא פריטים — צור 6–10 צעדים מעשיים כ-checklist_items. יצירה נוספת בשם קיים מוסיפה פריטים ואינה מוחקת דבר.
• project_show — ״תראה את משימות העבודה״, ״הצג פרויקט מעבר דירה״. project_name=שם הפרויקט מהרשימה, בלי ליצור פרויקט חדש.
• project_list — ״מה הפרויקטים שלי״. title יכול להיות ריק.
• add עם project_name — הוספת משימה לפרויקט בשם הזה; צור אותו אם אינו קיים. הסר את שם הפרויקט מתיאור המשימה.
• update עם new_project_name — העברת משימה קיימת לפרויקט. title=שם המשימה. אל תמציא שינוי בזמן או בשם.
• complete/update/delete/stop_recurrence עם project_name — חפש רק בתוך הפרויקט שביקש המשתמש; סימון [פרויקט: ...] הוא הקשר, לא חלק משם המשימה. כשאותו שם מופיע בכמה פרויקטים ולא צוין פרויקט — בקש בחירה לפי שם הפרויקט.
• לכל היותר 50 פריטים ברשימת בדיקה אחת. אל תמציא מועדים לפריטים.

התאוששות ממשימות באיחור:
• recover — ״בוא ננקה את המשימות באיחור״, ״עזור לי עם המשימות שלא סיימתי״ או בקשת בדיקת משימות באיחור. title יכול להיות ריק. פותח בחירה של להשאיר, לקבוע זמן חדש או לבטל. אל תבטל או תדחה משימות בלי בחירה מפורשת.

action:
• add — הוספה: "צריך", "תזכיר", "לקנות", "להתקשר" וכו'
• complete — השלמה: "סיימתי", "גמרתי", "עשיתי"
• delete — מחיקה: "מחק", "הסר". אם המשימה חוזרת — מחיקה מפסיקה גם את החזרה
• update — עדכון משימה קיימת: "שנה", "תעדכן", "עדכן", "תקן", "תזכיר לי שוב ב-X", "שלח תזכורת שוב ב-X", "הזכר לי שוב". title=שם המשימה הנוכחי לחיפוש, new_title=שם חדש (השמט אם לא משתנה), new_due_date=תאריך/שעה חדש (השמט אם לא משתנה — אל תחזיר null)
• אם המשתמש הגיב על הודעת תזכורת של הבוט וביקש זמן חדש ("תזכיר לי בחמישי ב-14:00", "עוד שעה", "דחה למחר") — זו פעולה update על המשימה המצוטטת, לא add. השתמש ב-title של המשימה מתוך הודעת התזכורת המצוטטת והכנס את הזמן החדש ל-new_due_date.
• list — הצגת רשימה: "מה יש לי", "תראה רשימה", "מה המשימות"
• stop_recurrence — הפסקת חזרה בלבד (המשימה נשארת): "אל תזכיר יותר", "הפסק חזרה", "בטל תזכורת שבועית", "הסר חזרה". title=שם המשימה
• מספר בפקודה ("סיימתי 2", "מחק 3", "עדכן 1") — מפנה לפריט מס' X ברשימת המשימות הממתינות; השתמש ב-title של אותה משימה
• הודעה קצרה ללא פרטים ("תוסיף", "הוסף", "כן", "בסדר", "עשה") — חפש בהיסטוריה את הנושא האחרון שדובר עליו ופעל ישירות. אל תחזיר תשובה עם שאלת הבהרה כאשר ניתן להסיק את הכוונה מהקונטקסט.
• תשובה להבהרה — אם ההודעה האחרונה שלך בהיסטוריה היתה שאלת הבהרה (כגון "באיזו שעה?", "באיזו תדירות?", "מה הכוונה?") והמשתמש ענה עכשיו — שלב את התשובה עם הבקשה המקורית מההיסטוריה ופעל. לדוגמה: שאלת "באיזו תדירות?" על משימה X, המשתמש ענה "יומית" — הוסף את משימה X עם recurrence=daily. לעולם אל תשאל שוב את אותה שאלה.

reply:
• add → "נוספה [שם] ✅" (+ " ⏰ [תאריך]" אם קיים, + " 🔁 [כל יום/שבוע/חודש]" אם יש חזרה)
• complete/delete → "הושלמה [שם] ✅"
• update → "עודכנה [שם] ✅"
• list → "📋 ? הכל | ?1 יום קרוב | ?2 יומיים"
• stop_recurrence → "הוסרה החזרה מ: [שם] ✅"
• שיחה/שאלה שאינה קשורה למשימות → דחה בנימוס ב-1 שורה והפנה לניהול משימות. דוגמה: "אני מנהל משימות ותזכורות — אפשר לעזור לך עם זה 📋"
• אם יש כמה פעולות — reply יכיל את כולן בשורות נפרדות
• לשון: עדיף תמיד ניסוח ניטרלי מגדרי — השתמש בצורות כמו "אפשר", "ניתן", "צריך", "להגדיר", "לקבל" במקום פניה ישירה בגוף שני. אם ניסוח ניטרלי אינו אפשרי, הסק מגדר מהקשר השיחה; אם אין רמז — השתמש בזכר.

פיצ'רים של הבוט (ענה בעברית אם המשתמש שואל):
• מחיר: 7 ימי ניסיון חינם ללא כרטיס אשראי, ואחריהם מנוי ב־20 ₪ לחודש. /billing — מצב ניסיון, הצטרפות, ניהול וביטול מנוי. אין מסלול חינמי קבוע; כל משתמש בשיתוף צריך ניסיון או מנוי משלו.
• שותף (/partner): שני משתמשים מחוברים — כל אחד רואה ומנהל גם את משימות השני (מסומנות "שותף"). התחברות: שלח /partner → שלח כרטיס איש קשר → הצד השני מאשר /yes; ניתוק: /unpartner; ביטול בקשה פתוחה: /cancel
• חברים (/friends): הוסף עד 5 חברים ותייג אותם במשימות ספציפיות. הזמנה: /friend <כינוי> → שלח כרטיס איש קשר → הצד השני מאשר /yes <כינוי-שלו>; דחייה: /no; ביטול הזמנה: /cancel; הסרה: /unfriend <כינוי>; רשימה: /friends. חבר מתויג רואה את המשימה ברשימה שלו ומקבל תזכורת.
• API (/api): מייצר טוקן אישי לשליחת משימות מחוץ לוואטסאפ — דרך curl, סקריפטים או CI. שלח /api לקבלת הטוקן והוראות שימוש
• דחיית תזכורת: 😴 דוחה ב-15 דקות; "דחה" / "דחה 30" / "דחה שעה" דוחים בהתאמה
• מחיקת חשבון: /delete — מוחק משימות והודעות ומבטל חידושי מנוי; נשמרת רשומת חיוב מינימלית למניעת ניסיון חוזר
• Google Calendar (/calendar): סנכרון דו-כיווני עם יומן Todobot נפרד. שינוי שם או זמן ביומן מעדכן את המשימה; מחיקת אירוע מבטלת אותה. /calendar sync — סנכרון עכשיו; /calendar disconnect — ניתוק. אירועים חוזרים שנוצרו ב-Google אינם מיובאים כרגע.
• רשימת המשימות (? או בקשת רשימה) מאפשרת לבחור משימה לפי שם ולפעול עליה בכפתורים.
• כפתורי משימות: השלמה, קביעת תזכורת או שינוי זמן עם בחירת מועד, וביטול משימה. בתזכורות יש גם דחייה מהירה ב־30 דקות או למחר. הפעולות מתייחסות למשימה שבהודעה. ביטול הפעולה או /undo משחזרים פעולת משימות במשך 10 דקות, כל עוד המשימות לא השתנו מאז.
• סיכום בוקר (/agenda): אופציונלי. /agenda 08:00 מפעיל בכל יום לפי שעון ישראל; /agenda 08:00 weekdays מפעיל ראשון–חמישי; /agenda off מכבה; /agenda now מציג סדר יום עכשיו; /agenda focus בוחר עד 3 עדיפויות להיום. אל תיצור משימה חוזרת כאשר המשתמש מבקש להפעיל סיכום בוקר — הפנה לפקודת /agenda.
• שיתוף טודו עם חבר: /share — הודעת היכרות מוכנה וקישור לבוט. המשתמש בוחר למי לשלוח ומאשר בעצמו. זה אינו שיתוף משימה או הזמנת שותף.
• פידבק: /feedback — שולח הודעה ישירה למפתח
• /help — מדריך קצר למשימות, Calendar ופרויקטים; /help more — כלי שיתוף, חשבון ואוטומציות.
• שאלות על תנאים/פרטיות: /tos ו-/privacy
• פרויקטים (# או /projects): צ׳קליסטים ומשימות לפי נושא. /project <שם> — התקדמות ופעולות לפי שם. /recover — בדיקת משימות באיחור; להשאיר, לקבוע מחדש או לבטל.

הודעה: {message}`;

// ── Public API ─────────────────────────────────────────────────────────────────

export async function processMessage(
  env: Env,
  opts: {
    userMessage: string;
    stats: { pending: number; completed: number };
    history: { role: string; content: string }[];
    pendingTasks?: string[];
    friends?: { nickname: string }[];
    quotedBotReply?: string;
    projects?: string[];
  }
): Promise<ProcessedMessage> {
  const { date_time, tomorrow, day_after } = buildDateInfo();

  const tasksBlock =
    opts.pendingTasks && opts.pendingTasks.length > 0
      ? "\n\nמשימות ממתינות:\n" + opts.pendingTasks.map((t, i) => `${i + 1}. ${t}`).join("\n")
      : "";

  const friendsBlock =
    opts.friends && opts.friends.length > 0
      ? "\n\nחברים (ניתן לתייג במשימות):\n" + opts.friends.map((f) => `- ${f.nickname}`).join("\n")
      : "";

  const historyBlock = formatConversationHistory(opts.history);

  const quotedBlock = opts.quotedBotReply
    ? `\n\n[המשתמש הגיב על הודעת הבוט הבאה]: ${opts.quotedBotReply.slice(0, 300)}`
    : "";

  const prompt = PROMPT
    .replace("{date_time}", date_time)
    .replace("{pending}", String(opts.stats.pending))
    .replace("{tasks_block}", tasksBlock)
    .replace("{friends_block}", friendsBlock)
    .replace("{projects_block}", opts.projects?.length ? "\n\nפרויקטים וצ׳קליסטים קיימים:\n"+opts.projects.slice(0,100).join("\n") : "")
    .replace("{history_block}", historyBlock)
    .replace("{quoted_block}", quotedBlock)
    .replace("{tomorrow}", tomorrow)
    .replace("{day_after}", day_after)
    .replace("{message}", opts.userMessage);

  const raw = await callGemini(env, prompt, { maxTokens: 1800, jsonMode: true });

  try {
    const parsed: unknown = JSON.parse(raw);
    if (validateTaskResponse(parsed)) return parsed;
    console.warn("[GEMINI] Invalid task response schema");
  } catch {
    console.warn("[GEMINI] Invalid task response JSON");
  }
  return { tasks: [], intent: "conversation", reply: INVALID_TASK_REPLY };
}

export async function transcribeAudio(
  env: Env,
  audioBuffer: ArrayBuffer,
  mimeType: string
): Promise<string> {
  const STT_MODEL = "gemini-flash-lite-latest";
  const url = `${GEMINI_BASE}/${STT_MODEL}:generateContent`;

  const bytes = new Uint8Array(audioBuffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const b64 = btoa(binary);
  const cleanMime = mimeType.split(";")[0].trim();

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inlineData: { mimeType: cleanMime, data: b64 } },
          { text: "Transcribe this audio. The language is Hebrew. Return only the transcription text, nothing else." },
        ],
      }],
      generationConfig: { maxOutputTokens: 1024, temperature: 0 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini STT ${res.status}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
}
