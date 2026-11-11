/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { newUndoContext, undoTasks } from '../src/services/task_undo.ts';
import worker from "../src/index.ts";
import { buildDb } from "../src/db/client.ts";
import { addTask, updateTaskById, completeTask, getUserById, getUserTasks, deleteUserAndData } from "../src/db/queries.ts";
import { fernetEncrypt, fernetDecrypt } from "../src/crypto/fernet.ts";
import { calendarCommand, syncGoogleCalendar, getCalendarConnection, disconnectCalendar, connectGoogleCalendar, exchangeGoogleCode, googleJson, CALENDAR_SCOPE, type GoogleEvent } from "../src/services/google_calendar.ts";
import { applySchema, clearData, createTestUser, drainConversation, makeMockFetch, TEST_PHONE, TEST_ENC_KEY } from "./helpers.ts";

const db = buildDb(env);
let userId: number;
let mockFetch: ReturnType<typeof vi.fn>;
let events: Map<string, GoogleEvent>;
let version: number;
let expiredSync: boolean;
let revoked: boolean;
const future = () => Math.floor(Date.now() / 1000) + 3600;
const tokens = { access_token: "google-test-access", refresh_token: "google-test-refresh", expires_in: 3600, scope: CALENDAR_SCOPE };
const event = (id: string, title: string, due = future()): GoogleEvent => ({ id, summary: title, status: "confirmed", etag: `"${++version}"`, updated: new Date().toISOString(),
  start: { dateTime: new Date(due * 1000).toISOString() }, end: { dateTime: new Date((due + 1800) * 1000).toISOString() } });

beforeAll(applySchema);
beforeEach(async () => {
  await clearData(); userId = await createTestUser(); events = new Map(); version = 0; expiredSync = false; revoked = false;
  const base = makeMockFetch();
  mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const value = String(url);
    if (value === "https://oauth2.googleapis.com/revoke") { revoked = true; return new Response(null, { status: 200 }); }
    if (value === "https://oauth2.googleapis.com/token") return Response.json(tokens);
    if (!value.includes("googleapis.com/calendar/v3")) return base(url);
    const parsed = new URL(value);
    if (parsed.pathname === "/calendar/v3/calendars") return Response.json({ id: "todo-calendar@group.calendar.google.com" });
    const id = parsed.pathname.split("/events/")[1];
    if (!parsed.pathname.includes("/events")) return Response.json({ id: "todo-calendar@group.calendar.google.com" });
    if (!id && (!init.method || init.method === "GET")) {
      if (expiredSync && parsed.searchParams.has("syncToken")) { expiredSync = false; return Response.json({ error: {} }, { status: 410 }); }
      return Response.json({ items: [...events.values()], nextSyncToken: `sync-${version}` });
    }
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (init.method === "POST") {
      if (events.has(body.id)) return Response.json({ error: {} }, { status: 409 });
      const created = { ...body, etag: `"${++version}"`, updated: new Date().toISOString() };
      events.set(body.id, created); return Response.json(created);
    }
    const current = events.get(id);
    if (!current) return Response.json({ error: {} }, { status: 404 });
    const match = (init.headers as Record<string, string>)?.["If-Match"];
    if (match && match !== current.etag) return Response.json({ error: {} }, { status: 412 });
    if (init.method === "DELETE") {
      events.set(id, { ...current, status: "cancelled", etag: `"${++version}"`, updated: new Date().toISOString() });
      return new Response(null, { status: 204 });
    }
    if (init.method === "PATCH") {
      const updated = { ...current, ...body, etag: `"${++version}"`, updated: new Date().toISOString() };
      events.set(id, updated); return Response.json(updated);
    }
    return Response.json(current);
  });
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

async function request(req: Request): Promise<Response> {
  const ctx = createExecutionContext(); const res = await worker.fetch(req, env, ctx); await waitOnExecutionContext(ctx); return res;
}
async function connect(): Promise<void> { await connectGoogleCalendar(env, userId, tokens); }
async function oauth() {
  const user = (await getUserById(db, userId))!;
  const text = await calendarCommand(env, user, "/calendar");
  const link = text.match(/https:\/\/[^\s]+/)![0];
  const token = new URL(link).searchParams.get("token")!;
  const response = await request(new Request("https://bot.example.com/calendar/authorize", { method: "POST", headers: { Origin: "https://bot.example.com", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }));
  return { link, token, response, location: new URL(response.headers.get("Location")!), cookie: response.headers.get("Set-Cookie")!.split(";")[0] };
}

describe("calendar OAuth", () => {
  it("uses Workers-supported manual redirect handling and never follows provider redirects", async () => {
    await exchangeGoogleCode(env, "private-code", "private-verifier");
    const init = mockFetch.mock.calls[0][1];
    expect(init.redirect).toBe("manual");
    expect(() => new Request("https://oauth2.googleapis.com/token", init)).not.toThrow();
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://attacker.example" } }));
    await expect(googleJson("https://oauth2.googleapis.com/token")).rejects.toMatchObject({ status: 302, category: "unexpected_redirect" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
  it("reports only allowlisted OAuth error codes without provider descriptions", async () => {
    mockFetch.mockResolvedValue(Response.json({ error: "invalid_grant", error_description: "private-authorization-code" }, { status: 400 }));
    await expect(exchangeGoogleCode(env, "private-code", "private-verifier")).rejects.toMatchObject({ status: 400, category: "oauth_invalid_grant" });
    mockFetch.mockResolvedValue(Response.json({ error: "private-authorization-code" }, { status: 400 }));
    await expect(exchangeGoogleCode(env, "private-code", "private-verifier")).rejects.toMatchObject({ status: 400, category: "api", message: "Google Calendar api (400)" });
  });

  it("identifies an offline grant without its refresh token", async () => {
    mockFetch.mockResolvedValue(Response.json({ access_token: "private-access", expires_in: 3600, scope: CALENDAR_SCOPE }));
    await expect(exchangeGoogleCode(env, "private-code", "private-verifier")).rejects.toMatchObject({ category: "missing_refresh_token" });
  });

  it("retains only safe failure metadata temporarily and clears it after a successful connection", async () => {
    const flow = await oauth();
    mockFetch.mockResolvedValue(Response.json({ error: "invalid_grant", error_description: "private-code" }, { status: 400 }));
    const callback = await request(new Request(`https://bot.example.com/calendar/callback?state=${flow.location.searchParams.get("state")}&code=private-code`, { headers: { Cookie: flow.cookie } }));
    expect(callback.status).toBe(400);
    const key = `calendar_oauth_error:${userId}`;
    const failure = JSON.parse((await env.CACHE.get(key))!);
    expect(failure).toEqual({ stage: "token_exchange", category: "oauth_invalid_grant", status: 400, at: expect.any(Number) });
    const fresh = await oauth();
    mockFetch.mockResolvedValue(Response.json(tokens));
    expect((await request(new Request(`https://bot.example.com/calendar/callback?state=${fresh.location.searchParams.get("state")}&code=test-code`, { headers: { Cookie: fresh.cookie } }))).status).toBe(200);
    expect(await env.CACHE.get(key)).toBeNull();
    await drainConversation();
  });

  it("keeps browser form origins while hiding connection tokens from referrer URLs", async () => {
    const user = (await getUserById(db, userId))!;
    const link = (await calendarCommand(env, user, "/calendar")).match(/https:\/\/[^\s]+/)![0];
    const page = await request(new Request(link));
    expect(page.status).toBe(200);
    expect(page.headers.get("Referrer-Policy")).toBe("strict-origin");
    expect(page.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://accounts.google.com;");
    expect(await page.text()).toContain('action="/calendar/authorize"');
    for (const origin of ["null", "https://attacker.example"]) {
      const rejected = await request(new Request("https://bot.example.com/calendar/authorize", {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: new URL(link).searchParams.get("token")! }),
      }));
      expect(rejected.status).toBe(403);
    }
    // Origin rejection must not consume the link; the real form can still use it.
    const authorized = await request(new Request("https://bot.example.com/calendar/authorize", {
      method: "POST", headers: { Origin: "https://bot.example.com", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: new URL(link).searchParams.get("token")! }),
    }));
    expect(authorized.status).toBe(302);
    expect(authorized.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(new URL(authorized.headers.get("Location")!).hostname).toBe("accounts.google.com");
  });

  it("uses scoped, offline authorization, PKCE and an HttpOnly cookie; stores tokens encrypted", async () => {
    const flow = await oauth();
    expect(flow.location.searchParams.get("scope")).toBe(CALENDAR_SCOPE);
    expect(flow.location.searchParams.get("access_type")).toBe("offline");
    expect(flow.location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(await request(new Request(flow.link))).toHaveProperty("status", 403);
    const state = flow.location.searchParams.get("state")!;
    const url = `https://bot.example.com/calendar/callback?state=${state}&code=test-code`;
    const response = await request(new Request(url, { headers: { Cookie: flow.cookie } }));
    expect(response.status).toBe(200);
    await drainConversation();
    const conn = (await getCalendarConnection(env, userId))!;
    expect(conn.status).toBe("connected");
    expect(conn.refresh_token_encrypted).not.toContain(tokens.refresh_token);
    expect(await fernetDecrypt(conn.refresh_token_encrypted!, TEST_ENC_KEY)).toBe(tokens.refresh_token);
    expect(await request(new Request(url, { headers: { Cookie: flow.cookie } }))).toHaveProperty("status", 400);
  });

  it("rejects cross-origin authorization and callbacks without the bound cookie", async () => {
    const flow = await oauth();
    const callback = await request(new Request(`https://bot.example.com/calendar/callback?state=${flow.location.searchParams.get("state")}&code=test-code`));
    expect(callback.status).toBe(400);
    const crossOrigin = await request(new Request("https://bot.example.com/calendar/authorize", { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: flow.token }) }));
    expect(crossOrigin.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles denied consent without creating a calendar", async () => {
    const flow = await oauth();
    const result = await request(new Request(`https://bot.example.com/calendar/callback?state=${flow.location.searchParams.get("state")}&error=access_denied`, { headers: { Cookie: flow.cookie } }));
    expect(await result.text()).toContain("החיבור בוטל");
    expect(await getCalendarConnection(env, userId)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks expired links and unavailable paid-service configuration", async () => {
    const user = (await getUserById(db, userId))!;
    const link = (await calendarCommand(env, user, "/calendar")).match(/https:\/\/[^\s]+/)![0];
    await env.DB.prepare("UPDATE google_calendar_oauth SET expires_at = 1").run();
    expect((await request(new Request(link))).status).toBe(403);
    const ctx = createExecutionContext();
    const disabled = await worker.fetch(new Request(link), { ...env, GEMINI_CALENDAR_DATA_ALLOWED: "false" }, ctx);
    expect(disabled.status).toBe(503);
  });
});

describe("two-way calendar synchronization", () => {
  it("exports timed tasks, updates them, and removes events after completion", async () => {
    await connect();
    const task = await addTask(db, TEST_ENC_KEY, userId, "להתקשר לבנק", new Date(future() * 1000));
    await addTask(db, TEST_ENC_KEY, userId, "ללא זמן", null);
    await syncGoogleCalendar(env, userId);
    expect(events.size).toBe(1);
    const first = [...events.values()][0];
    expect(first.summary).toBe("להתקשר לבנק");
    await updateTaskById(db, TEST_ENC_KEY, task.id, [userId], { description: "להתקשר לבנק לגבי משכנתה", due_date: new Date((future() + 600) * 1000) });
    await syncGoogleCalendar(env, userId);
    expect(events.get(first.id)!.summary).toContain("משכנתה");
    expect(events.size).toBe(1);
    await completeTask(db, TEST_ENC_KEY, task.id, [userId]);
    await syncGoogleCalendar(env, userId);
    expect(events.get(first.id)!.status).toBe("cancelled");
    await syncGoogleCalendar(env, userId);
    expect((await getUserTasks(db, TEST_ENC_KEY, [userId], "completed"))).toHaveLength(1);
  });

  it("imports Google event edits and deletions without recreating the event", async () => {
    await connect();
    const task = await addTask(db, TEST_ENC_KEY, userId, "ישן", new Date(future() * 1000));
    await syncGoogleCalendar(env, userId);
    const first = [...events.values()][0];
    const edited = event(first.id, "חדש", future() + 1200); events.set(first.id, edited);
    await syncGoogleCalendar(env, userId);
    const updated = (await getUserTasks(db, TEST_ENC_KEY, [userId]))[0];
    expect(updated.id).toBe(task.id); expect(updated.description).toBe("חדש");
    expect(updated.due_date!.toISOString()).toBe(edited.start!.dateTime);
    events.set(first.id, { ...edited, status: "cancelled", etag: `"${++version}"` });
    await syncGoogleCalendar(env, userId);
    expect(await getUserTasks(db, TEST_ENC_KEY, [userId], "pending")).toHaveLength(0);
    expect(events.size).toBe(1);
  });

  it("imports new timed and all-day Google events only once, with no invented all-day reminder", async () => {
    await connect(); events.set("external1", event("external1", "אירוע חדש"));
    events.set("allday1", { id: "allday1", summary: "יום שלם", status: "confirmed", etag: '"all"', start: { date: "2026-12-01" }, end: { date: "2026-12-02" } });
    await syncGoogleCalendar(env, userId); await syncGoogleCalendar(env, userId);
    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId], "pending");
    expect(tasks).toHaveLength(2); expect(tasks.find(t => t.description === "יום שלם")!.due_date).toBeNull();
    expect(mockFetch.mock.calls.filter(([url, init]) => String(url).includes("/events") && init?.method === "POST")).toHaveLength(0);
  });

  it("does not import Google recurring series as duplicate WhatsApp reminders", async () => {
    await connect(); events.set("series1", { ...event("series1", "חוזר"), recurrence: ["RRULE:FREQ=DAILY"] });
    await syncGoogleCalendar(env, userId);
    expect(await getUserTasks(db, TEST_ENC_KEY, [userId])).toHaveLength(0);
    expect(events.get("series1")!.status).toBe("confirmed");
  });

  it("performs a full resync after an expired sync token without duplicate tasks", async () => {
    await connect(); events.set("external1", event("external1", "אירוע חדש"));
    await syncGoogleCalendar(env, userId); expiredSync = true;
    await syncGoogleCalendar(env, userId);
    expect(await getUserTasks(db, TEST_ENC_KEY, [userId])).toHaveLength(1);
    expect(expiredSync).toBe(false);
  });

  it("keeps a newer bot edit when both sides changed, using the current remote etag", async () => {
    await connect(); const task = await addTask(db, TEST_ENC_KEY, userId, "מקורי", new Date(future() * 1000));
    await syncGoogleCalendar(env, userId); const first = [...events.values()][0];
    events.set(first.id, { ...event(first.id, "עריכת יומן"), updated: "2025-01-01T00:00:00Z" });
    await updateTaskById(db, TEST_ENC_KEY, task.id, [userId], { description: "עריכה חדשה בבוט" });
    await syncGoogleCalendar(env, userId);
    expect(events.get(first.id)!.summary).toBe("עריכה חדשה בבוט");
  });

  it("keeps a newer Google edit when both sides changed", async () => {
    await connect(); const task = await addTask(db, TEST_ENC_KEY, userId, "מקורי", new Date(future() * 1000));
    await syncGoogleCalendar(env, userId); const first = [...events.values()][0];
    await updateTaskById(db, TEST_ENC_KEY, task.id, [userId], { description: "עריכת בוט" });
    events.set(first.id, { ...event(first.id, "עריכת יומן חדשה"), updated: "2099-01-01T00:00:00Z" });
    await syncGoogleCalendar(env, userId);
    expect((await getUserTasks(db, TEST_ENC_KEY, [userId]))[0].description).toBe("עריכת יומן חדשה");
  });

  it("removes an event when its task is hard-deleted, and respects revoked consent", async () => {
    await connect(); const task = await addTask(db, TEST_ENC_KEY, userId, "מחיקה", new Date(future() * 1000));
    await syncGoogleCalendar(env, userId); const first = [...events.values()][0];
    await env.DB.prepare("DELETE FROM task WHERE id = ?").bind(task.id).run();
    await syncGoogleCalendar(env, userId); expect(events.get(first.id)!.status).toBe("cancelled");
    await disconnectCalendar(env, userId); expect(revoked).toBe(true); expect((await getCalendarConnection(env, userId))!.refresh_token_encrypted).toBeNull();
    mockFetch.mockClear(); await syncGoogleCalendar(env, userId); expect(mockFetch).not.toHaveBeenCalled();
  });

  it("cleans up OAuth credentials and event mappings when the account is deleted", async () => {
    await connect(); await addTask(db, TEST_ENC_KEY, userId, "מחיקה", new Date(future() * 1000)); await syncGoogleCalendar(env, userId);
    await deleteUserAndData(db, userId, null);
    expect(await getCalendarConnection(env, userId)).toBeNull();
    expect((await env.DB.prepare("SELECT * FROM google_calendar_event").all()).results).toHaveLength(0);
  });

  it("recovers a committed insert whose response was lost without duplicate events", async () => {
    await connect(); await addTask(db, TEST_ENC_KEY, userId, "תגובה שאבדה", new Date(future() * 1000));
    const base = mockFetch.getMockImplementation()!; let dropped = false;
    mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await base(url, init);
      if (!dropped && String(url).includes("/events") && init?.method === "POST") { dropped = true; throw new Error("Response lost"); }
      return response;
    });
    await expect(syncGoogleCalendar(env, userId)).rejects.toThrow();
    await syncGoogleCalendar(env, userId);
    expect(events.size).toBe(1);
    expect((await getCalendarConnection(env, userId))!.last_error).toBeNull();
  });

  it("refreshes an unexpectedly expired access token once", async () => {
    await connect(); const base = mockFetch.getMockImplementation()!; let unauthorized = true;
    mockFetch.mockImplementation((url: string, init: RequestInit) => {
      if (unauthorized && String(url).includes("/events")) { unauthorized = false; return Promise.resolve(Response.json({ error: {} }, { status: 401 })); }
      return base(url, init);
    });
    await syncGoogleCalendar(env, userId);
    expect((await getCalendarConnection(env, userId))!.status).toBe("connected");
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
  });

  it("requires reconnect after the refresh grant is revoked", async () => {
    await connect(); await env.DB.prepare("UPDATE google_calendar_connection SET token_expires_at = 0 WHERE user_id = ?").bind(userId).run();
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init: RequestInit) => String(url).endsWith("/token")
      ? Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 })) : base(url, init));
    await expect(syncGoogleCalendar(env, userId)).rejects.toThrow();
    const conn = (await getCalendarConnection(env, userId))!;
    expect(conn.status).toBe("reconnect"); expect(conn.refresh_token_encrypted).toBeNull();
  });

  it("keeps all-day dates when a task is renamed in the bot", async () => {
    await connect(); events.set("allday1", { id: "allday1", summary: "יום שלם", status: "confirmed", etag: '"all"', start: { date: "2026-12-01" }, end: { date: "2026-12-02" } });
    await syncGoogleCalendar(env, userId); const task = (await getUserTasks(db, TEST_ENC_KEY, [userId]))[0];
    await updateTaskById(db, TEST_ENC_KEY, task.id, [userId], { description: "שם חדש" });
    await syncGoogleCalendar(env, userId);
    expect(events.get("allday1")!.start).toEqual({ date: "2026-12-01" });
    expect(events.get("allday1")!.summary).toBe("שם חדש");
  });
});

it("Undo restores a completed task to its Google Calendar after synchronization", async () => {
  const task = await addTask(db, TEST_ENC_KEY, userId, "Undo calendar completion", new Date(future() * 1000));
  await connect();
  const connection = (await getCalendarConnection(env, userId))!;
  await syncGoogleCalendar(env, userId, connection.connection_id);
  const googleId = [...events.keys()][0];
  const undo = newUndoContext(userId);
  await completeTask(db, TEST_ENC_KEY, task.id, [userId], [], undo);
  await syncGoogleCalendar(env, userId, connection.connection_id);
  expect(events.get(googleId)?.status).toBe("cancelled");
  expect(await undoTasks(env, userId)).toContain("הפעולה בוטלה");
  await syncGoogleCalendar(env, userId, connection.connection_id);
  expect(events.get(googleId)?.status).toBe("confirmed");
});
