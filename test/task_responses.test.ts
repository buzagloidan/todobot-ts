/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { dispatchQueueMessage } from "../src/queue/consumer.ts";
import { buildDb } from "../src/db/client.ts";
import { addTask, getUserTasks, saveMessage } from "../src/db/queries.ts";
import { applySchema, clearData, createTestUser, makeMockFetch, TEST_PHONE, TEST_ENC_KEY } from "./helpers.ts";

let mockFetch: ReturnType<typeof vi.fn>;
let userId: number;
const db = buildDb(env);
beforeAll(applySchema);
beforeEach(async () => {
  await clearData();
  userId = await createTestUser();
  mockFetch = vi.fn().mockImplementation(makeMockFetch());
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

function response(raw: string | object): void {
  const base = makeMockFetch();
  mockFetch.mockImplementation((url: string, init: RequestInit) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return Promise.resolve(Response.json({ candidates: [{ content: { parts: [{ text: typeof raw === "string" ? raw : JSON.stringify(raw) }] } }] }));
    }
    return base(url);
  });
}
async function send(text = "סיימתי את המשימה"): Promise<string> {
  await dispatchQueueMessage({ type: "text_processing", userId, phone: TEST_PHONE, text }, env);
  return mockFetch.mock.calls.filter(([url]) => String(url).includes("graph.facebook.com"))
    .map(([,init]) => (JSON.parse(init.body).text?.body ?? JSON.parse(init.body).interactive?.body?.text)).filter(Boolean)[0];
}

describe("task confirmations", () => {
  it("creates a task when the provider rejects the unsupported response schema setting", async () => {
    const base = makeMockFetch();
    mockFetch.mockImplementation((url: string, init: RequestInit) => {
      if (String(url).includes("generativelanguage.googleapis.com")) {
        const request = JSON.parse(init.body as string);
        if (request.generationConfig.responseSchema) {
          return Promise.resolve(Response.json({ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } }, { status: 400 }));
        }
        return Promise.resolve(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ tasks: [{ action: "add", title: "להתקשר לבנק" }], intent: "task_management", reply: "נוספה ✅" }) }] } }] }));
      }
      return base(url);
    });
    const reply = await send("תזכיר לי להתקשר לבנק");
    expect(reply).toContain("נוספה: *להתקשר לבנק*");
    expect(await getUserTasks(db, TEST_ENC_KEY, [userId], "pending")).toHaveLength(1);
    expect(mockFetch.mock.calls.filter(([url]) => String(url).includes("generativelanguage.googleapis.com"))).toHaveLength(1);
  });

  it("does not report completion when a named task was not found", async () => {
    await addTask(db, TEST_ENC_KEY, userId, "להתקשר לבנק", null);
    response({ tasks: [{ action: "complete", title: "לקנות חלב" }], intent: "task_management", reply: "הושלמה לקנות חלב ✅" });
    const reply = await send();
    expect(reply).toContain("לא מצאתי");
    expect(reply).not.toContain("✅");
    expect((await getUserTasks(db, TEST_ENC_KEY, [userId], "pending"))).toHaveLength(1);
  });

  it("never extracts a success reply from malformed JSON", async () => {
    response('{"tasks":[invalid],"intent":"task_management","reply":"נוספה חלב ✅"}');
    const reply = await send("תוסיף חלב");
    expect(reply).not.toContain("נוספה");
    expect(reply).not.toContain("✅");
    expect(await getUserTasks(db, TEST_ENC_KEY, [userId])).toHaveLength(0);
  });

  it.each([
    { action: "invented_action", title: "חלב" },
    { action: ["add"], title: "חלב" },
    { action: "add", title: "חלב", due_date: "2026-02-30 12:00" },
    { action: "add", title: "חלב", due_date: "2026-10-15 27:80" },
    { action: "add", title: "" },
    { action: "update", title: "חלב" },
  ])("rejects invalid actions before any mutation: %j", async (task) => {
    response({ tasks: [task], intent: "task_management", reply: "בוצע ✅" });
    expect(await send()).not.toContain("✅");
    expect(await getUserTasks(db, TEST_ENC_KEY, [userId])).toHaveLength(0);
  });

  it("rejects the entire invalid batch before running its valid first action", async () => {
    response({ tasks: [{ action: "add", title: "חלב" }, { action: "complete", title: 42 }], intent: "task_management", reply: "בוצע ✅" });
    await send();
    expect(await getUserTasks(db, TEST_ENC_KEY, [userId])).toHaveLength(0);
  });

  it("shows actual success and actual failure for a mixed batch", async () => {
    response({ tasks: [{ action: "add", title: "חלב" }, { action: "complete", title: "משימה שאינה קיימת" }], intent: "task_management", reply: "הכל הושלם ✅" });
    const reply = await send();
    expect(reply).toContain("נוספה: *חלב*");
    expect(reply).toContain("לא מצאתי");
    expect(reply).not.toContain("הכל הושלם");
    expect(await getUserTasks(db, TEST_ENC_KEY, [userId], "pending")).toHaveLength(1);
  });

  it("does not claim a change when the model returned no actions", async () => {
    response({ tasks: [], intent: "conversation", reply: "הוספתי את המשימה ✅" });
    expect(await send()).not.toContain("✅");
    expect(await getUserTasks(db, TEST_ENC_KEY, [userId])).toHaveLength(0);
  });

  it("keeps ordinary clarifications conversational", async () => {
    response({ tasks: [], intent: "conversation", reply: "באיזו שעה להזכיר?" });
    expect(await send()).toBe("באיזו שעה להזכיר?");
  });

  it("does not confuse explanatory wording with a success claim", async () => {
    response({ tasks: [], intent: "conversation", reply: "אפשר ליצור משימות. בנוסף, אפשר לשתף עם שותף ✅" });
    expect(await send()).toContain("בנוסף");
  });
});

describe("conversation context", () => {
  it("preserves older and longer context, and ignores stale cached history", async () => {
    const original = "תזכיר לי להתקשר לבנק " + "פרטים נוספים ".repeat(15) + "בנוגע למשכנתה";
    await saveMessage(db, TEST_ENC_KEY, { userId, messageType: "text", content: original, aiResponse: "באיזה יום?", parsedTasks: null, whatsappMessageId: null });
    for (let i = 0; i < 5; i++) {
      await saveMessage(db, TEST_ENC_KEY, { userId, messageType: "text", content: `עוד הודעה ${i}`, aiResponse: `תשובה ${i}`, parsedTasks: null, whatsappMessageId: null });
    }
    await saveMessage(db, TEST_ENC_KEY, { userId, messageType: "text", content: "תיקון: ביום חמישי", aiResponse: "באיזו שעה?", parsedTasks: null, whatsappMessageId: null });
    await env.CACHE.put(`hist:${userId}`, JSON.stringify([{ role: "user", content: "מידע מיושן" }]));
    response({ tasks: [], intent: "conversation", reply: "איזו שעה ביום חמישי?" });
    await send("בבוקר");
    const call = mockFetch.mock.calls.find(([url]) => String(url).includes("generativelanguage.googleapis.com"))!;
    const body = JSON.parse(call[1].body);
    const prompt = body.contents[0].parts[0].text;
    expect(prompt).toContain(original);
    expect(prompt).toContain("תיקון: ביום חמישי");
    expect(prompt).not.toContain("מידע מיושן");
    expect(prompt.indexOf(original)).toBeLessThan(prompt.indexOf("תיקון: ביום חמישי"));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });
});
