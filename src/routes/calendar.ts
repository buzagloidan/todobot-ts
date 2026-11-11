import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types.ts";
import { buildDb } from "../db/client.ts";
import { getUserById } from "../db/queries.ts";
import { billingEnabled, hasAccess } from "../services/billing.ts";
import { fernetEncrypt, fernetDecrypt } from "../crypto/fernet.ts";
import { CALENDAR_SCOPE, CALENDAR_CALLBACK_PATH, calendarConfigured, digest, randomToken, exchangeGoogleCode, CalendarError } from "../services/google_calendar.ts";

type CalendarContext = Context<{ Bindings: Env }>;
type OAuthState = { user_id: number; verifier_encrypted: string; cookie_hash: string | null; expires_at: number };
const COOKIE = "__Host-todobot-calendar";
const now = () => Math.floor(Date.now() / 1000);
const esc = (s: string) => s.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function calendarPage(c: CalendarContext, title: string, body: string, status: 200 | 400 | 403 | 503 = 200): Response {
  // HTML form POSTs under no-referrer send Origin: null, breaking our origin check.
  // strict-origin preserves that check without exposing link tokens or callback codes.
  c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "strict-origin");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'");
  return c.html(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Todobot</title><style>body{font:18px/1.6 system-ui;background:#f5f7fa;color:#172234;max-width:620px;margin:8vh auto;padding:28px}main{background:white;border-radius:18px;padding:30px;box-shadow:0 8px 35px #17223415}h1{font-size:28px}a{color:#245bc5}button{background:#245bc5;color:white;border:0;border-radius:10px;padding:14px 22px;font:inherit;cursor:pointer}footer{font-size:14px;margin-top:28px}code{direction:ltr;unicode-bidi:isolate}</style><main><h1>${esc(title)}</h1>${body}<footer><a href="/privacy">פרטיות</a> · <a href="/terms">תנאי שימוש</a> · ${c.env.SUPPORT_EMAIL ? `<a href="mailto:${esc(c.env.SUPPORT_EMAIL)}">עזרה</a>` : ""}</footer></main></html>`, status);
}

export async function calendarConnect(c: CalendarContext): Promise<Response> {
  if (!calendarConfigured(c.env)) return calendarPage(c, "Google Calendar", "<p>החיבור יהיה זמין בקרוב.</p>", 503);
  const token = c.req.query("token") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) return calendarPage(c, "הקישור אינו תקף", "<p>חזור לבוט ושלח <code>/calendar</code> לקבלת קישור חדש.</p>", 400);
  const state = await c.env.DB.prepare("SELECT * FROM google_calendar_oauth WHERE state_hash = ? AND purpose = 'link' AND expires_at > ?").bind(await digest(token), now()).first<OAuthState>();
  const user = state ? await getUserById(buildDb(c.env), state.user_id) : null;
  if (!user || !(await hasAccess(c.env, user))) return calendarPage(c, "הקישור אינו זמין", "<p>חזור לבוט ושלח <code>/calendar</code> לבדיקת החיבור.</p>", 403);
  return calendarPage(c, "חיבור Google Calendar", `<p>ניצור בחשבון שלך יומן בשם <b>Todobot</b> לסנכרון דו-כיווני של המשימות.</p><p>שינויים בשם או בזמן האירוע יעדכנו את המשימה בבוט. מחיקת אירוע תבטל את המשימה. סיום משימה בבוט יסיר את האירוע מהיומן.</p><p>אירועים רגילים שתוסיף ליומן Todobot יופיעו בבוט. אירועים של יום שלם יופיעו כמשימות ללא תזכורת בשעה מסוימת. סדרות חוזרות שנוצרו ב-Google אינן מיובאות כרגע.</p><p>ההרשאה מוגבלת ליומנים שנוצרו על ידי האפליקציה. אין צורך למסור סיסמה לבוט. אפשר לנתק בכל עת באמצעות <code>/calendar disconnect</code>.</p><form action="/calendar/authorize" method="post"><input type="hidden" name="token" value="${esc(token)}"><button type="submit">המשך לחיבור עם Google</button></form>`);
}

export async function calendarAuthorize(c: CalendarContext): Promise<Response> {
  if (!calendarConfigured(c.env)) return calendarPage(c, "החיבור אינו זמין", "<p>נסה שוב בהמשך.</p>", 503);
  if (c.req.header("Origin") !== `https://${c.env.PUBLIC_HOST}`) return calendarPage(c, "בקשה לא תקפה", "<p>פתח שוב את הקישור מהבוט.</p>", 403);
  const body = await c.req.parseBody(); const token = typeof body.token === "string" ? body.token : "";
  if (!/^[a-f0-9]{64}$/.test(token)) return calendarPage(c, "הקישור אינו תקף", "<p>שלח <code>/calendar</code> בבוט.</p>", 400);
  const state = await c.env.DB.prepare("DELETE FROM google_calendar_oauth WHERE state_hash = ? AND purpose = 'link' AND expires_at > ? RETURNING *").bind(await digest(token), now()).first<OAuthState>();
  const user = state ? await getUserById(buildDb(c.env), state.user_id) : null;
  if (!state || !user || !(await hasAccess(c.env, user))) return calendarPage(c, "הקישור פג", "<p>שלח <code>/calendar</code> לקבלת קישור חדש.</p>", 403);
  const callbackState = randomToken(); const cookie = randomToken();
  await c.env.DB.prepare("INSERT INTO google_calendar_oauth (state_hash, user_id, verifier_encrypted, cookie_hash, purpose, expires_at) VALUES (?, ?, ?, ?, 'callback', ?)")
    .bind(await digest(callbackState), user.id, state.verifier_encrypted, await digest(cookie), now() + 900).run();
  setCookie(c, COOKIE, cookie, { secure: true, httpOnly: true, sameSite: "Lax", path: "/", maxAge: 900 });
  c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer");
  const verifier = await fernetDecrypt(state.verifier_encrypted, c.env.ENCRYPTION_KEY);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...hash)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const params = new URLSearchParams({ client_id: c.env.GOOGLE_CLIENT_ID!, redirect_uri: `https://${c.env.PUBLIC_HOST}${CALENDAR_CALLBACK_PATH}`,
    response_type: "code", scope: CALENDAR_SCOPE, access_type: "offline", prompt: "consent", state: callbackState, code_challenge: challenge, code_challenge_method: "S256" });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

export async function calendarCallback(c: CalendarContext): Promise<Response> {
  if (!calendarConfigured(c.env)) return calendarPage(c, "החיבור אינו זמין", "<p>נסה שוב בהמשך.</p>", 503);
  const stateToken = c.req.query("state") ?? ""; const cookie = getCookie(c, COOKIE) ?? "";
  if (!/^[a-f0-9]{64}$/.test(stateToken) || !/^[a-f0-9]{64}$/.test(cookie)) return calendarPage(c, "לא ניתן לאמת את החיבור", "<p>פתח את הקישור החדש מהבוט באותו דפדפן.</p>", 400);
  const state = await c.env.DB.prepare("DELETE FROM google_calendar_oauth WHERE state_hash = ? AND cookie_hash = ? AND purpose = 'callback' AND expires_at > ? RETURNING *")
    .bind(await digest(stateToken), await digest(cookie), now()).first<OAuthState>();
  deleteCookie(c, COOKIE, { secure: true, path: "/" });
  if (!state) return calendarPage(c, "הקישור פג או כבר נוצל", "<p>שלח <code>/calendar</code> בבוט לחיבור חדש.</p>", 400);
  if (c.req.query("error")) return calendarPage(c, "החיבור בוטל", "<p>לא חובר יומן. אפשר לחזור לבוט ולשלוח <code>/calendar</code> כשמתאים.</p>");
  const user = await getUserById(buildDb(c.env), state.user_id);
  if (!user || !(await hasAccess(c.env, user))) return calendarPage(c, "החשבון אינו זמין", "<p>חזור לבוט לבדיקת החשבון.</p>", 403);
  let stage = "token_exchange";
  try {
    const code = c.req.query("code"); if (!code || code.length > 4096) throw new CalendarError(400, "missing_code");
    const token = await exchangeGoogleCode(c.env, code, await fernetDecrypt(state.verifier_encrypted, c.env.ENCRYPTION_KEY));
    stage = "inbox_admission";
    await c.env.CONVERSATIONS.getByName(user.phone_number_hash).enqueue({ kind: "calendar_connect", userId: user.id, tokens: token, id: `calendar-connect:${await digest(stateToken)}` });
    await c.env.CACHE.delete(`calendar_oauth_error:${user.id}`).catch(() => {});
    return calendarPage(c, "ההרשאה ל-Google אושרה", "<p>אנחנו מסיימים את חיבור יומן <b>Todobot</b>. זה עשוי לקחת כמה רגעים.</p><p>חזור לשיחת WhatsApp ושלח <code>/calendar</code> לבדיקת החיבור. אפשר לשלוח <code>/calendar sync</code> לסנכרון מיד כשהחיבור מוכן.</p>");
  } catch (err) {
    const failure = { stage, category: err instanceof CalendarError ? err.category : "temporary", status: err instanceof CalendarError ? err.status : 0, at: now() };
    console.error("[CALENDAR] OAuth connection failed", failure.stage, failure.category, failure.status);
    // Temporary diagnostic metadata only: no codes, tokens, URLs, or provider descriptions.
    await c.env.CACHE.put(`calendar_oauth_error:${user.id}`, JSON.stringify(failure), { expirationTtl: 900 }).catch(() => {});
    return calendarPage(c, "החיבור לא הושלם", "<p>חזור לבוט ושלח <code>/calendar</code> לקבלת קישור חדש. אם הבעיה נמשכת, פנה לעזרה.</p>", 400);
  }
}

export function publicPrivacy(c: CalendarContext): Response {
  return calendarPage(c, "מדיניות פרטיות", `<p>Todobot מנהל משימות ותזכורות ב-WhatsApp. מספרי טלפון, תוכן המשימות, שמות פרויקטים והודעות נשמרים בהצפנה. צ׳קליסטים מקשרים בין פרויקט למשימותיו; בדיקת משימות באיחור שומרת את ההחלטה להשאיר את אותה גרסה של המשימה. בחירת משימה לקביעת זמן חדש תקפה ל־15 דקות. לצורך ביטול פעולה נשמר מצב קודם מוצפן של המשימות למשך 10 דקות. אם בחרת בסיכום בוקר, נשמרות ההעדפות שלך ועדיפויות יומיות; אפשר לכבותו באמצעות <code>/agenda off</code>. מידע הנדרש לשליחת הודעות מועבר ל-Meta, והודעות לעיבוד שפה או קול מועברות ל-Google Gemini. השירות נעזר ב-Cloudflare לאחסון ${billingEnabled(c.env) ? "וב-Lemon Squeezy לניהול מנויים" : ""}.</p><p>חיבור Google Calendar הוא בחירה שלך. האפליקציה מבקשת גישה ליומנים שהיא יוצרת בלבד, ושומרת אסימוני גישה מוצפנים כדי לסנכרן כותרות, זמנים ומצב של משימות ואירועים ביומן Todobot. נתוני Google Calendar משמשים רק לסנכרון המבוקש ואינם נמכרים, משמשים לפרסום או מועברים לאימון מודלים. אירוע שיובא כמשימה עשוי להיכלל בהקשר המשימות שנשלח ל-Gemini לצורך ניהול המשימות שלך.</p><p>אפשר לנתק באמצעות <code>/calendar disconnect</code>, או להסיר את ההרשאה בחשבון Google. מחיקת חשבון בבוט מוחקת את הנתונים ואסימוני החיבור ומבטלת חידושי מנוי. אירועים שכבר נשמרו ביומן Google נשארים בשליטתך. מזהים, זמנים, קשרים ו־hash של מספר הטלפון נשמרים כמטא־נתונים ואינם אנונימיים. רשומות חיוב קיימות עשויות להישמר בנפרד. ${c.env.POSTHOG_API_KEY ? "נתוני שימוש פסאודונימיים מועברים ל-PostHog." : ""} ${c.env.RESEND_API_KEY && c.env.FEEDBACK_FROM && c.env.FEEDBACK_TO ? "פידבק שיזמת נשלח למפעיל באמצעות Resend עם ארבע הספרות האחרונות של מספר הטלפון." : ""}</p><p>בכל שאלה או בקשת מחיקה: ${esc(c.env.SUPPORT_EMAIL || "/help")}.</p>`);
}
export function publicTerms(c: CalendarContext): Response {
  if (!billingEnabled(c.env)) return calendarPage(c, "תנאי שימוש", "<p>מופע עצמאי לניהול משימות ותזכורות ב־WhatsApp. השירות ניתן כפי שהוא ואין להסתמך עליו לפעולות קריטיות. יש להשתמש בו כחוק. פרטים: <code>/tos</code>, פרטיות: <code>/privacy</code>, מחיקת נתונים: <code>/delete</code>.</p>");
  return calendarPage(c, "תנאי שימוש", "<p>Todobot הוא שירות לניהול משימות ותזכורות באמצעות WhatsApp ו-Gemini AI. מוצעים 7 ימי ניסיון חינם ללא כרטיס, ולאחריהם מנוי של 20 ₪ לחודש בחיוב חודשי מתחדש. אין חיוב בלי הצטרפות מפורשת. אפשר לנהל או לבטל את המנוי באמצעות <code>/billing</code>.</p><p>חיבור Google Calendar מסנכרן משימות עם יומן Todobot בשני הכיוונים. שינוי או מחיקת אירוע עשויים לשנות או לבטל את המשימה המתאימה. השירות ניתן כפי שהוא; ייתכנו עיכובים, תקלות והפסקות תחזוקה. אין להסתמך על תזכורות לפעולות קריטיות.</p><p>יש להשתמש בשירות באופן חוקי ולהימנע מספאם ותוכן פוגעני. פרטים מלאים זמינים בבוט באמצעות <code>/tos</code> ו-<code>/privacy</code>.</p>");
}
export function publicHome(c: CalendarContext): Response {
  return calendarPage(c, "Todobot — משימות ב-WhatsApp", `<p>משימות, תזכורות, הודעות קוליות ושיתוף משימות בעברית — ישירות ב-WhatsApp.</p>${billingEnabled(c.env) ? "<p>7 ימי ניסיון חינם, ולאחריהם 20 ₪ לחודש.</p>" : ""}<p>לחיבור דו-כיווני עם יומן Google, שלח <code>/calendar</code> בבוט.</p>`);
}
