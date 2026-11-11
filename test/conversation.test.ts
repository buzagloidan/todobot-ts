/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { SELF, env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { Conversation } from "../src/conversation.ts";
import { hashPhone } from "../src/crypto/hash.ts";
import { fernetDecrypt, fernetEncrypt } from "../src/crypto/fernet.ts";
import { buildDb } from "../src/db/client.ts";
import { getUserTasks } from "../src/db/queries.ts";
import { applySchema, clearData, createTestUser, drainConversation, makeMockFetch, makeSignedWebhookRequest, makeSignedWebhookRequestFromMessage, makeSignedWebhookRequestFromBody, TEST_PHONE, TEST_PHONE_2, TEST_ENC_KEY } from "./helpers.ts";

const db = buildDb(env);
let mockFetch: ReturnType<typeof vi.fn>;
beforeAll(applySchema);
beforeEach(async () => {
  await clearData();
  mockFetch = vi.fn().mockImplementation(makeMockFetch());
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

function geminiResponse(tasks: object[], reply = "בוצע ✅"): Response {
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ tasks, intent: "task_management", reply }) }] } }] });
}

describe("per-user conversation inbox", () => {
  it("finishes the first message before reading context for the second, while another user proceeds", async () => {
    const userId = await createTestUser();
    const otherId = await createTestUser(TEST_PHONE_2);
    const base = makeMockFetch();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    let secondPrompt = "";
    mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (!String(url).includes("generativelanguage.googleapis.com")) return base(url);
      const prompt = JSON.parse(init.body as string).contents[0].parts[0].text as string;
      const current = prompt.split("הודעה: ").at(-1)!;
      started.push(current);
      if (current === "FIRST") {
        await blocked;
        return geminiResponse([{ action: "add", title: "להתקשר לבנק" }]);
      }
      if (current === "SECOND") {
        secondPrompt = prompt;
        return geminiResponse([{ action: "update", title: "להתקשר לבנק", new_title: "להתקשר לבנק לגבי משכנתה" }]);
      }
      return geminiResponse([{ action: "add", title: "לקנות חלב" }]);
    });

    await SELF.fetch(await makeSignedWebhookRequest("FIRST"));
    await vi.waitFor(() => expect(started).toContain("FIRST"));
    await SELF.fetch(await makeSignedWebhookRequest("SECOND"));
    await SELF.fetch(await makeSignedWebhookRequest("OTHER", TEST_PHONE_2));
    try {
      await vi.waitFor(() => expect(started).toContain("OTHER"));
      expect(started).not.toContain("SECOND");
      await drainConversation(TEST_PHONE_2);
      expect((await getUserTasks(db, TEST_ENC_KEY, [otherId]))[0].description).toBe("לקנות חלב");
      const stub = env.CONVERSATIONS.getByName(await hashPhone(TEST_PHONE));
      await runInDurableObject(stub, async (_instance: Conversation, state) => {
        const rows = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM inbox WHERE payload IS NOT NULL").toArray();
        expect(rows).toHaveLength(2);
        expect(rows.every(row => !row.payload.includes("FIRST") && !row.payload.includes("SECOND"))).toBe(true);
        expect(await fernetDecrypt(rows[1].payload, TEST_ENC_KEY)).toContain("SECOND");
      });
    } finally {
      release();
    }
    await drainConversation();
    await vi.waitFor(() => expect(started).toContain("SECOND"));
    expect(secondPrompt).toContain("נוספה: *להתקשר לבנק*");
    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toBe("להתקשר לבנק לגבי משכנתה");
  });

  it("deduplicates webhook retries, including after the original action finished", async () => {
    const userId = await createTestUser();
    const base = makeMockFetch();
    mockFetch.mockImplementation(async (url: string) => String(url).includes("generativelanguage.googleapis.com")
      ? geminiResponse([{ action: "add", title: "חלב" }]) : base(url));
    const message = { from: TEST_PHONE, id: "same-delivery", type: "text", text: { body: "תוסיף חלב" } };
    await SELF.fetch(await makeSignedWebhookRequestFromMessage(message));
    await SELF.fetch(await makeSignedWebhookRequestFromMessage(message));
    await drainConversation();
    await SELF.fetch(await makeSignedWebhookRequestFromMessage(message));
    await drainConversation();
    expect(mockFetch.mock.calls.filter(([url]) => String(url).includes("generativelanguage.googleapis.com"))).toHaveLength(1);
    expect(await getUserTasks(db, TEST_ENC_KEY, [userId])).toHaveLength(1);
    await runInDurableObject(env.CONVERSATIONS.getByName(await hashPhone(TEST_PHONE)), (_instance: Conversation, state) => {
      expect(state.storage.sql.exec<{ payload: string | null; state: string }>("SELECT payload, state FROM inbox").toArray()).toEqual([{ payload: null, state: "done" }]);
    });
  });

  it("admits every message in a provider batch in order", async () => {
    const userId = await createTestUser();
    const messages = ["+ראשונה", "+שנייה"].map((text, i) => ({ from: TEST_PHONE, id: `batch-${i}`, type: "text", text: { body: text } }));
    await SELF.fetch(await makeSignedWebhookRequestFromBody({ entry: [{ changes: [{ value: { messages } }] }] }));
    await drainConversation();
    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId]);
    expect(tasks.map(task => task.description).sort()).toEqual(["ראשונה", "שנייה"].sort());
    const textReplies = mockFetch.mock.calls.filter(([url]) => String(url).includes("graph.facebook.com"))
      .map(([,init]) => (JSON.parse(init.body).text?.body ?? JSON.parse(init.body).interactive?.body?.text)).filter(Boolean);
    expect(textReplies[0]).toContain("ראשונה");
    expect(textReplies[1]).toContain("שנייה");
  });

  it("does not replay an interrupted action, and continues to the next message", async () => {
    const userId = await createTestUser();
    const stub = env.CONVERSATIONS.getByName(await hashPhone(TEST_PHONE));
    const uncertain = await fernetEncrypt(JSON.stringify({ kind: "webhook", message: { from: TEST_PHONE, id: "interrupted", type: "text", text: { body: "+do not repeat" } } }), TEST_ENC_KEY);
    const next = await fernetEncrypt(JSON.stringify({ kind: "webhook", message: { from: TEST_PHONE, id: "next", type: "text", text: { body: "+next task" } } }), TEST_ENC_KEY);
    await runInDurableObject(stub, async (_instance: Conversation, state) => {
      state.storage.sql.exec("INSERT INTO inbox (message_id, payload, state, created_at) VALUES (?, ?, 'started', ?)", "interrupted", uncertain, Date.now());
      state.storage.sql.exec("INSERT INTO inbox (message_id, payload, state, created_at) VALUES (?, ?, 'pending', ?)", "next", next, Date.now());
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await runDurableObjectAlarm(stub);
    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toBe("next task");
  });

  it.each([false, true])("repairs interrupted admission on provider retry (encrypted=%s)", async (alreadyEncrypted) => {
    const userId = await createTestUser();
    const stub = env.CONVERSATIONS.getByName(await hashPhone(TEST_PHONE));
    const message = { from: TEST_PHONE, id: "incomplete-admission", type: "text", text: { body: "+recovered task" } };
    const payload = alreadyEncrypted ? await fernetEncrypt(JSON.stringify({ kind: "webhook", message }), TEST_ENC_KEY) : null;
    await runInDurableObject(stub, (_instance: Conversation, state) => {
      state.storage.sql.exec("INSERT INTO inbox (message_id, payload, created_at) VALUES (?, ?, ?)", message.id, payload, Date.now());
    });
    await SELF.fetch(await makeSignedWebhookRequestFromMessage(message));
    await drainConversation();
    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toBe("recovered task");
  });
});
