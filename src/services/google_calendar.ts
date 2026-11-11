import type { Env } from "../types.ts";
import type { User } from "../db/schema.ts";
import { fernetEncrypt, fernetDecrypt } from "../crypto/fernet.ts";
import { buildDb } from "../db/client.ts";
import { getUserById } from "../db/queries.ts";
import { hasAccess } from "./billing.ts";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
export const CALENDAR_CALLBACK_PATH = "/calendar/callback";
const API = "https://www.googleapis.com/calendar/v3";
const TOKEN = "https://oauth2.googleapis.com/token";
const now = () => Math.floor(Date.now() / 1000);

export type CalendarConnection = {
  user_id: number; connection_id: string; calendar_id_encrypted: string;
  refresh_token_encrypted: string | null; access_token_encrypted: string | null;
  token_expires_at: number; sync_token_encrypted: string | null; status: string;
  last_sync_at: number; next_sync_at: number; last_error: string | null;
};
type TaskRow = { id: number; user_id: number; description: string; due_date: number | null; status: string; recurrence: string | null; updated_at: number };
type EventTime = { dateTime?: string; date?: string; timeZone?: string };
export type GoogleEvent = { id: string; etag?: string; status?: string; summary?: string; updated?: string; start?: EventTime; end?: EventTime; recurrence?: string[]; recurringEventId?: string };
type EventMap = { user_id: number; event_id: string; task_id: number | null; local_hash: string; etag: string | null; remote_updated: string | null; snapshot_encrypted: string | null; is_deleted: number };
export class CalendarError extends Error {
  constructor(public status: number, public category: string) { super(`Google Calendar ${category} (${status})`); }
}

export function calendarConfigured(env: Env): boolean {
  return env.GOOGLE_CALENDAR_ENABLED === "true" && env.GEMINI_CALENDAR_DATA_ALLOWED === "true" && !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET;
}
export async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(b => b.toString(16).padStart(2, "0")).join("");
}
export const randomToken = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
export async function getCalendarConnection(env: Env, userId: number): Promise<CalendarConnection | null> {
  return env.DB.prepare("SELECT * FROM google_calendar_connection WHERE user_id = ?").bind(userId).first<CalendarConnection>();
}

export async function googleJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new CalendarError(res.status, "unexpected_redirect");
  }
  const errorCategory = res.status === 401 ? "authorization" : "api";
  if (res.status === 204) return undefined as T;
  // Bound provider responses, and never include token/code bodies in errors or logs.
  const reader = res.body?.getReader();
  if (!reader) throw new CalendarError(res.ok ? 502 : res.status, res.ok ? "empty_response" : errorCategory);
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new CalendarError(502, "large_response"); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new CalendarError(res.ok ? 502 : res.status, res.ok ? "invalid_response" : errorCategory); }
  if (!res.ok) {
    // Only fixed OAuth error codes are diagnostic-safe; never log provider bodies/descriptions.
    const code = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : undefined;
    const known = ["invalid_client", "invalid_grant", "invalid_request", "unauthorized_client", "unsupported_grant_type", "access_denied"];
    throw new CalendarError(res.status, url === TOKEN && typeof code === "string" && known.includes(code) ? `oauth_${code}` : errorCategory);
  }
  return parsed as T;
}

export async function exchangeGoogleCode(env: Env, code: string, verifier: string): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }> {
  const token = await googleJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>(TOKEN, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, code, code_verifier: verifier,
      grant_type: "authorization_code", redirect_uri: `https://${env.PUBLIC_HOST}${CALENDAR_CALLBACK_PATH}` }),
  });
  if (!token.access_token) throw new CalendarError(400, "missing_access_token");
  if (!token.refresh_token) throw new CalendarError(400, "missing_refresh_token");
  if (!token.expires_in) throw new CalendarError(400, "missing_expiry");
  if (!token.scope?.split(" ").includes(CALENDAR_SCOPE)) throw new CalendarError(400, "missing_scope");
  return { access_token: token.access_token, refresh_token: token.refresh_token, expires_in: token.expires_in, scope: token.scope };
}

async function accessToken(env: Env, conn: CalendarConnection): Promise<string> {
  if (conn.access_token_encrypted && conn.token_expires_at > now() + 60) return fernetDecrypt(conn.access_token_encrypted, env.ENCRYPTION_KEY);
  if (!conn.refresh_token_encrypted) throw new CalendarError(401, "authorization");
  try {
    const response = await googleJson<{ access_token?: string; expires_in?: number }>(TOKEN, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, grant_type: "refresh_token",
        refresh_token: await fernetDecrypt(conn.refresh_token_encrypted, env.ENCRYPTION_KEY) }),
    });
    if (!response.access_token || !response.expires_in) throw new CalendarError(502, "invalid_token");
    await env.DB.prepare("UPDATE google_calendar_connection SET access_token_encrypted = ?, token_expires_at = ? WHERE user_id = ? AND connection_id = ? AND status = 'connected'")
      .bind(await fernetEncrypt(response.access_token, env.ENCRYPTION_KEY), now() + response.expires_in, conn.user_id, conn.connection_id).run();
    return response.access_token;
  } catch (err) {
    if (err instanceof CalendarError && [400, 401].includes(err.status)) {
      await env.DB.prepare("UPDATE google_calendar_connection SET status = 'reconnect', access_token_encrypted = NULL, refresh_token_encrypted = NULL, last_error = 'authorization' WHERE user_id = ? AND connection_id = ?")
        .bind(conn.user_id, conn.connection_id).run();
    }
    throw err;
  }
}

export async function createTodobotCalendar(access: string): Promise<string> {
  const result = await googleJson<{ id?: string }>(`${API}/calendars`, { method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({ summary: "Todobot", description: "משימות ותזכורות מטודובוט — סנכרון דו-כיווני", timeZone: "Asia/Jerusalem" }) });
  if (!result.id || result.id === "primary") throw new CalendarError(502, "invalid_calendar");
  return result.id;
}

export async function disconnectCalendar(env: Env, userId: number): Promise<void> {
  const conn = await getCalendarConnection(env, userId);
  await env.DB.batch([
    env.DB.prepare("UPDATE google_calendar_connection SET status = 'disconnected', refresh_token_encrypted = NULL, access_token_encrypted = NULL, sync_token_encrypted = NULL, last_error = NULL WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM google_calendar_oauth WHERE user_id = ?").bind(userId),
  ]);
  if (conn?.refresh_token_encrypted) {
    const token = await fernetDecrypt(conn.refresh_token_encrypted, env.ENCRYPTION_KEY);
    // Revocation removes app access. Google keeps the user's calendar/events.
    await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }).catch(() => {});
  }
}

export type GoogleTokens = { access_token: string; refresh_token: string; expires_in: number; scope: string };
export async function connectGoogleCalendar(env: Env, userId: number, token: GoogleTokens): Promise<void> {
  const user = await getUserById(buildDb(env), userId);
  if (!user || !(await hasAccess(env, user)) || !token.scope.split(" ").includes(CALENDAR_SCOPE)) throw new CalendarError(403, "authorization");
  const previous = await getCalendarConnection(env, userId);
  let calendarId: string | undefined;
  if (previous) {
    const oldId = await fernetDecrypt(previous.calendar_id_encrypted, env.ENCRYPTION_KEY);
    try {
      const calendar = await googleJson<{ id?: string }>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(oldId)}`, { headers: { Authorization: `Bearer ${token.access_token}` } });
      if (calendar.id === oldId && oldId !== "primary") calendarId = oldId;
    } catch (err) { if (!(err instanceof CalendarError) || ![403, 404].includes(err.status)) throw err; }
  }
  const reuse = !!calendarId;
  calendarId ??= await createTodobotCalendar(token.access_token);
  if (!reuse) await env.DB.prepare("DELETE FROM google_calendar_event WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare(`INSERT INTO google_calendar_connection (user_id, connection_id, calendar_id_encrypted, refresh_token_encrypted, access_token_encrypted, token_expires_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET connection_id = excluded.connection_id, calendar_id_encrypted = excluded.calendar_id_encrypted,
    refresh_token_encrypted = excluded.refresh_token_encrypted, access_token_encrypted = excluded.access_token_encrypted, token_expires_at = excluded.token_expires_at,
    status = 'connected', sync_token_encrypted = NULL, last_sync_at = 0, next_sync_at = 0, last_error = NULL`)
    .bind(userId, crypto.randomUUID(), await fernetEncrypt(calendarId, env.ENCRYPTION_KEY), await fernetEncrypt(token.refresh_token, env.ENCRYPTION_KEY),
    await fernetEncrypt(token.access_token, env.ENCRYPTION_KEY), now() + token.expires_in).run();
}

async function plainTask(env: Env, task: TaskRow): Promise<TaskRow> {
  let description: string;
  try { description = await fernetDecrypt(task.description, env.ENCRYPTION_KEY); } catch { description = task.description; }
  return { ...task, description };
}
const taskHash = (task: TaskRow) => digest(JSON.stringify([task.description, task.due_date, task.status, task.recurrence]));
function eventDue(event: GoogleEvent): number | null | undefined {
  if (event.start?.date) return null; // All-day events become tasks without an invented reminder time.
  const start = event.start?.dateTime;
  if (!start || !/(?:Z|[+-]\d{2}:\d{2})$/.test(start)) return undefined;
  const time = Date.parse(start);
  return Number.isFinite(time) ? Math.floor(time / 1000) : undefined;
}
function snapshot(event: GoogleEvent): object {
  return { start: event.start, end: event.end };
}
async function saveMap(env: Env, map: EventMap, task: TaskRow | null, event: GoogleEvent, deleted = false): Promise<void> {
  await env.DB.prepare("UPDATE google_calendar_event SET local_hash = ?, etag = ?, remote_updated = ?, snapshot_encrypted = ?, is_deleted = ? WHERE user_id = ? AND event_id = ?")
    .bind(task ? await taskHash(task) : "", event.etag ?? null, event.updated ?? null, await fernetEncrypt(JSON.stringify(snapshot(event)), env.ENCRYPTION_KEY), deleted ? 1 : 0, map.user_id, map.event_id).run();
}

export async function syncGoogleCalendar(env: Env, userId: number, expectedConnection?: string): Promise<void> {
  if (!calendarConfigured(env)) return;
  const conn = await getCalendarConnection(env, userId);
  if (!conn || conn.status !== "connected" || (expectedConnection && conn.connection_id !== expectedConnection)) return;
  const user = await getUserById(buildDb(env), userId);
  if (!user || !(await hasAccess(env, user))) return;
  try {
    let access = await accessToken(env, conn);
    const calendarId = await fernetDecrypt(conn.calendar_id_encrypted, env.ENCRYPTION_KEY);
    if (calendarId === "primary") throw new CalendarError(400, "invalid_calendar");
    const eventsUrl = `${API}/calendars/${encodeURIComponent(calendarId)}/events`;
    let refreshed = false;
    const api = async <T>(suffix: string, init: RequestInit = {}): Promise<T> => {
      const request = () => googleJson<T>(eventsUrl + suffix, { ...init,
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", ...init.headers } });
      try { return await request(); } catch (err) {
        if (!(err instanceof CalendarError) || err.status !== 401 || refreshed) throw err;
        refreshed = true;
        access = await accessToken(env, { ...conn, token_expires_at: 0 });
        return request();
      }
    };
    let syncToken = conn.sync_token_encrypted ? await fernetDecrypt(conn.sync_token_encrypted, env.ENCRYPTION_KEY) : undefined;
    let nextToken: string | undefined;
    let pageToken: string | undefined;
    const remote: GoogleEvent[] = [];
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ maxResults: "250", showDeleted: "true", singleEvents: "false" });
      if (syncToken) params.set("syncToken", syncToken);
      if (pageToken) params.set("pageToken", pageToken);
      let result: { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
      try { result = await api(`?${params}`); } catch (err) {
        if (err instanceof CalendarError && err.status === 410 && syncToken) { syncToken = undefined; pageToken = undefined; remote.length = 0; page--; continue; }
        throw err;
      }
      remote.push(...(result.items ?? []));
      pageToken = result.nextPageToken;
      if (!pageToken) { nextToken = result.nextSyncToken; break; }
    }
    if (pageToken || !nextToken) throw new CalendarError(502, "incomplete_sync");

    for (const event of remote) {
      if (!event.id) continue;
      // Bot recurrence remains one event per occurrence. Do not expand/import Google series as duplicate reminders.
      if (event.recurrence?.length || event.recurringEventId) continue;
      let map = await env.DB.prepare("SELECT * FROM google_calendar_event WHERE user_id = ? AND event_id = ?").bind(userId, event.id).first<EventMap>();
      if (!map) {
        const due = eventDue(event);
        if (event.status === "cancelled" || due === undefined || !event.summary?.trim()) continue;
        const key = await digest(`${userId}:${event.id}`);
        const encrypted = await fernetEncrypt(event.summary.slice(0, 1000), env.ENCRYPTION_KEY);
        await env.DB.prepare("INSERT OR IGNORE INTO task (user_id, description, due_date, status, created_at, updated_at, google_event_key) VALUES (?, ?, ?, 'pending', ?, ?, ?)")
          .bind(userId, encrypted, due, now(), now(), key).run();
        const task = await env.DB.prepare("SELECT * FROM task WHERE google_event_key = ? AND user_id = ?").bind(key, userId).first<TaskRow>();
        if (!task) throw new CalendarError(409, "import_conflict");
        await env.DB.prepare("INSERT OR IGNORE INTO google_calendar_event (user_id, event_id, task_id) VALUES (?, ?, ?)").bind(userId, event.id, task.id).run();
        map = (await env.DB.prepare("SELECT * FROM google_calendar_event WHERE user_id = ? AND event_id = ?").bind(userId, event.id).first<EventMap>())!;
        await saveMap(env, map, await plainTask(env, task), event);
        continue;
      }
      const raw = map.task_id ? await env.DB.prepare("SELECT * FROM task WHERE id = ? AND user_id = ?").bind(map.task_id, userId).first<TaskRow>() : null;
      if (!raw) continue; // Deleted task: the outbound pass removes its event.
      const task = await plainTask(env, raw);
      const localChanged = (await taskHash(task)) !== map.local_hash;
      if (event.etag === map.etag || (event.status === "cancelled" && map.is_deleted)) continue;
      // Last write wins when both sides changed since the last successful sync; ties favor Google.
      if (localChanged && task.updated_at * 1000 > Date.parse(event.updated ?? "1970-01-01")) {
        await env.DB.prepare("UPDATE google_calendar_event SET etag = ?, remote_updated = ?, snapshot_encrypted = ? WHERE user_id = ? AND event_id = ?")
          .bind(event.etag ?? null, event.updated ?? null, await fernetEncrypt(JSON.stringify(snapshot(event)), env.ENCRYPTION_KEY), userId, event.id).run();
        continue;
      }
      const due = event.status === "cancelled" ? task.due_date : eventDue(event);
      if (due === undefined || (event.status !== "cancelled" && !event.summary?.trim())) continue;
      const title = event.status === "cancelled" ? task.description : event.summary!.slice(0, 1000);
      const status = event.status === "cancelled" ? "cancelled" : "pending";
      const result = await env.DB.prepare(`UPDATE task SET description = ?, due_date = ?, status = ?, reminder_sent = CASE WHEN due_date IS ? THEN reminder_sent ELSE 0 END, updated_at = ?
        WHERE id = ? AND user_id = ? AND description = ? AND due_date IS ? AND status = ? AND recurrence IS ? AND updated_at = ?`)
        .bind(await fernetEncrypt(title, env.ENCRYPTION_KEY), due, status, due, now(), raw.id, userId, raw.description, raw.due_date, raw.status, raw.recurrence, raw.updated_at).run();
      if (!result.meta.changes) throw new CalendarError(409, "local_conflict");
      await saveMap(env, map, { ...task, description: title, due_date: due, status }, event, status === "cancelled");
    }

    // Include retained mappings for completed/deleted tasks so those calendar events are removed.
    const { results: mappings } = await env.DB.prepare("SELECT * FROM google_calendar_event WHERE user_id = ?").bind(userId).all<EventMap>();
    const { results: rawTasks } = await env.DB.prepare("SELECT * FROM task WHERE user_id = ? AND (status = 'pending' OR id IN (SELECT task_id FROM google_calendar_event WHERE user_id = ?))").bind(userId, userId).all<TaskRow>();
    const tasks = await Promise.all(rawTasks.map(task => plainTask(env, task)));
    for (const task of tasks) {
      if (task.status !== "pending" || task.due_date === null || mappings.some(m => m.task_id === task.id)) continue;
      const id = "td" + await digest(`${conn.connection_id}:${task.id}`);
      await env.DB.prepare("INSERT OR IGNORE INTO google_calendar_event (user_id, event_id, task_id) VALUES (?, ?, ?)").bind(userId, id, task.id).run();
      mappings.push({ user_id: userId, event_id: id, task_id: task.id, local_hash: "", etag: null, remote_updated: null, snapshot_encrypted: null, is_deleted: 0 });
    }
    for (const map of mappings) {
      const task = tasks.find(t => t.id === map.task_id) ?? null;
      const hash = task ? await taskHash(task) : "";
      if (map.local_hash === hash && (map.etag || map.is_deleted)) continue;
      const previous = map.snapshot_encrypted ? JSON.parse(await fernetDecrypt(map.snapshot_encrypted, env.ENCRYPTION_KEY)) as { start?: EventTime; end?: EventTime } : {};
      if (!task || task.status !== "pending" || (task.due_date === null && !previous.start?.date)) {
        if (!map.is_deleted) {
          try { await api(`/${encodeURIComponent(map.event_id)}?sendUpdates=none`, { method: "DELETE", headers: map.etag ? { "If-Match": map.etag } : {} }); }
          catch (err) { if (!(err instanceof CalendarError) || ![404, 410].includes(err.status)) throw err; }
        }
        await saveMap(env, map, task, { id: map.event_id, status: "cancelled" }, true);
        continue;
      }
      let start: EventTime; let end: EventTime;
      if (task.due_date === null) { start = previous.start!; end = previous.end!; }
      else {
        const duration = previous.start?.dateTime && previous.end?.dateTime ? (Date.parse(previous.end.dateTime) - Date.parse(previous.start.dateTime)) / 1000 : 900;
        const seconds = duration > 0 && duration <= 7 * 86400 ? duration : 900;
        start = { dateTime: new Date(task.due_date * 1000).toISOString(), timeZone: "Asia/Jerusalem" };
        end = { dateTime: new Date((task.due_date + seconds) * 1000).toISOString(), timeZone: "Asia/Jerusalem" };
      }
      const fields = { summary: task.description, start, end, status: "confirmed" };
      let event: GoogleEvent;
      if (map.etag && !map.is_deleted) {
        event = await api(`/${encodeURIComponent(map.event_id)}?sendUpdates=none`, { method: "PATCH", headers: { "If-Match": map.etag }, body: JSON.stringify(fields) });
      } else {
        try {
          event = await api("?sendUpdates=none", { method: "POST", body: JSON.stringify({ id: map.event_id, ...fields, transparency: "transparent", reminders: { useDefault: false } }) });
        } catch (err) {
          if (!(err instanceof CalendarError) || err.status !== 409) throw err;
          // An earlier insert may have succeeded even if its HTTP response was lost.
          event = await api(`/${encodeURIComponent(map.event_id)}`);
          event = await api(`/${encodeURIComponent(map.event_id)}?sendUpdates=none`, { method: "PATCH", headers: event.etag ? { "If-Match": event.etag } : {}, body: JSON.stringify(fields) });
        }
      }
      if (!event.etag) throw new CalendarError(502, "invalid_event");
      await saveMap(env, map, task, event);
    }
    await env.DB.prepare("UPDATE google_calendar_connection SET sync_token_encrypted = ?, last_sync_at = ?, next_sync_at = ?, last_error = NULL WHERE user_id = ? AND connection_id = ? AND status = 'connected'")
      .bind(await fernetEncrypt(nextToken, env.ENCRYPTION_KEY), now(), now() + 60, userId, conn.connection_id).run();
  } catch (err) {
    const category = err instanceof CalendarError ? err.category : "temporary";
    console.error("[CALENDAR] Sync failed", { category, status: err instanceof CalendarError ? err.status : null });
    await env.DB.prepare("UPDATE google_calendar_connection SET last_error = ?, next_sync_at = ? WHERE user_id = ? AND connection_id = ?")
      .bind(category, now() + 60, userId, conn.connection_id).run();
    if (err instanceof CalendarError && err.status === 401) {
      await env.DB.prepare("UPDATE google_calendar_connection SET status = 'reconnect', access_token_encrypted = NULL WHERE user_id = ? AND connection_id = ?").bind(userId, conn.connection_id).run();
    }
    throw err;
  }
}

export async function scheduleCalendarSync(env: Env): Promise<void> {
  if (!calendarConfigured(env)) return;
  await env.DB.prepare("DELETE FROM google_calendar_oauth WHERE expires_at < ?").bind(now()).run();
  const { results } = await env.DB.prepare(`SELECT c.user_id, c.connection_id, u.phone_number_hash FROM google_calendar_connection c JOIN user u ON u.id = c.user_id
    WHERE c.status = 'connected' AND c.next_sync_at <= ? ORDER BY c.next_sync_at LIMIT 50`).bind(now()).all<{ user_id: number; connection_id: string; phone_number_hash: string }>();
  await Promise.all(results.map(async row => {
    await env.DB.prepare("UPDATE google_calendar_connection SET next_sync_at = ? WHERE user_id = ? AND connection_id = ?").bind(now() + 60, row.user_id, row.connection_id).run();
    try {
      await env.CONVERSATIONS.getByName(row.phone_number_hash).enqueue({ kind: "calendar", userId: row.user_id, connectionId: row.connection_id, id: `calendar:${row.connection_id}:${Math.floor(now() / 60)}` });
    } catch (err) {
      await env.DB.prepare("UPDATE google_calendar_connection SET next_sync_at = 0 WHERE user_id = ? AND connection_id = ?").bind(row.user_id, row.connection_id).run();
      throw err;
    }
  }));
}

export async function calendarCommand(env: Env, user: User, command: string): Promise<string> {
  if (command === "/calendar disconnect") {
    await disconnectCalendar(env, user.id);
    return "📅 החיבור ל-Google Calendar נותק. היומן והאירועים הקיימים נשארו בחשבון Google שלך.";
  }
  if (!calendarConfigured(env)) return "📅 חיבור Google Calendar יהיה זמין בקרוב. ההגדרה עדיין בתהליך.";
  const conn = await getCalendarConnection(env, user.id);
  if (command === "/calendar sync" && conn?.status === "connected") {
    try { await syncGoogleCalendar(env, user.id, conn.connection_id); return "📅 הסנכרון עם Google Calendar הושלם."; }
    catch { return "📅 הסנכרון לא הושלם כרגע. שלח /calendar לבדיקת החיבור ונסה שוב בעוד רגע."; }
  }
  if (conn?.status === "connected" && command !== "/calendar connect") {
    const status = conn.last_error ? "הסנכרון האחרון נתקל בבעיה. אפשר לנסות /calendar sync." : "שינויים מסתנכרנים בשני הכיוונים, בדרך כלל בתוך דקה.";
    return `📅 Google Calendar מחובר ליומן *Todobot*.\n${status}\nשינוי שם או זמן ביומן מעדכן את המשימה; מחיקת אירוע מבטלת אותה בבוט.\nמשימות חוזרות בבוט נוצרות כאירוע נפרד בכל הופעה. אירועים חוזרים שנוצרו ב-Google אינם מיובאים כרגע.\n/calendar sync — סנכרון עכשיו\n/calendar disconnect — ניתוק`;
  }
  const token = randomToken();
  await env.DB.prepare("INSERT INTO google_calendar_oauth (state_hash, user_id, verifier_encrypted, purpose, expires_at) VALUES (?, ?, ?, 'link', ?)")
    .bind(await digest(token), user.id, await fernetEncrypt(randomToken(), env.ENCRYPTION_KEY), now() + 900).run();
  return `📅 ${conn?.status === "reconnect" ? "יש לחבר מחדש את Google Calendar." : "לחיבור Google Calendar:"}\nhttps://${env.PUBLIC_HOST}/calendar/connect?token=${token}\n\nייווצר יומן Todobot לסנכרון דו-כיווני של המשימות שלך. הקישור אישי ותקף ל-15 דקות.`;
}
