/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { buildDb } from "../src/db/client.ts";
import { addTask, getUserTasks } from "../src/db/queries.ts";
import { hashPhone } from "../src/crypto/hash.ts";
import { sendDueRemindersForTest as scanAndSendReminders } from "./helpers.ts";
import {
  TEST_ENC_KEY,
  TEST_PHONE,
  TEST_PHONE_2,
  applySchema,
  clearData,
  createTestUser,
  makeSignedWebhookRequest,
  makeSignedWebhookRequestFromMessage,
  makeMockFetch,
  drainConversation,
} from "./helpers.ts";

let db: ReturnType<typeof buildDb>;
let mockFetch: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await applySchema();
  db = buildDb(env);
});

beforeEach(async () => {
  await clearData();
  mockFetch = vi.fn().mockImplementation(makeMockFetch());
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function send(text: string): Promise<void> {
  await SELF.fetch(await makeSignedWebhookRequest(text, TEST_PHONE));
  await drainConversation();
}

async function sendMessage(message: Record<string, unknown>): Promise<void> {
  await SELF.fetch(await makeSignedWebhookRequestFromMessage(message));
  await drainConversation(message.from as string);
}

// Poll until a text WhatsApp reply appears in mock calls (waitUntil runs async).
async function waTextReply(timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const [url, init] of mockFetch.mock.calls as [string, RequestInit][]) {
      if (!url.includes("graph.facebook.com")) continue;
      try {
        const body = JSON.parse(init.body as string);
        const ids=body.interactive?.action?.buttons?.map((b:{reply:{id:string}})=>b.reply.id)??[];
        if(ids.includes('agree_btn')||ids.some((id:string)=>/^td:guide:\d+:start:/.test(id)))continue;
        if (typeof (body.text?.body ?? body.interactive?.body?.text) === "string") return (body.text?.body ?? body.interactive?.body?.text) as string;
      } catch { /* skip */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("No text WhatsApp API call found within timeout");
}

function waTextBodies(): string[] {
  return (mockFetch.mock.calls as [string, RequestInit][])
    .filter(([url]) => url.includes("graph.facebook.com"))
    .flatMap(([, init]) => {
      try {
        const body = JSON.parse(init.body as string);
        return typeof (body.text?.body ?? body.interactive?.body?.text) === "string" ? [(body.text?.body ?? body.interactive?.body?.text) as string] : [];
      } catch {
        return [];
      }
    });
}

function makeMockFetchWithGeminiResponse(response: object) {
  const base = makeMockFetch();
  return (url: string | URL | Request): Promise<Response> => {
    const urlStr = url.toString();
    if (urlStr.includes("generativelanguage.googleapis.com")) {
      return Promise.resolve(new Response(JSON.stringify({
        candidates: [
          { content: { parts: [{ text: JSON.stringify(response) }] } },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return base(url);
  };
}

// Seed a task via "+task" command. Waits for the worker's confirmation message
// (i.e. waitUntil drains) before clearing mock calls so test noise is isolated.
async function seedTask(text: string): Promise<void> {
  await send(`+${text}`);
  await waTextReply(); // blocks until worker is fully done
  mockFetch.mockClear();
}

// Get userId of the test user from DB (populated after first webhook call).
async function getTestUserId(): Promise<number> {
  const hash = await hashPhone(TEST_PHONE);
  const row = await env.DB.prepare(
    "SELECT id FROM user WHERE phone_number_hash = ?"
  ).bind(hash).first<{ id: number }>();
  if (!row) throw new Error("Test user not found in DB");
  return row.id;
}

// ── GET /webhook ──────────────────────────────────────────────────────────────

describe("GET /webhook verification", () => {
  it("returns the challenge when the token matches", async () => {
    const res = await SELF.fetch(
      "https://worker.example.com/webhook?hub.verify_token=test_verify_token&hub.challenge=abc123"
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });

  it("returns 403 when the token does not match", async () => {
    const res = await SELF.fetch(
      "https://worker.example.com/webhook?hub.verify_token=wrong_token&hub.challenge=abc123"
    );
    expect(res.status).toBe(403);
  });
});

// ── POST /webhook — basic commands ────────────────────────────────────────────

describe("POST /webhook — '+task' quick-add", () => {
  it("replies with a confirmation that includes the task name", async () => {
    await send("+Buy milk");
    const reply = await waTextReply();
    expect(reply).toContain("✅ נוספה");
    expect(reply).toContain("Buy milk");
  });

  it("after adding, the task appears in the DB with decrypted description", async () => {
    await send("+Buy milk");
    await waTextReply(); // wait for worker to finish
    const userId = await getTestUserId();
    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId], "pending");
    expect(tasks.length).toBe(1);
    expect(tasks[0].description).toBe("Buy milk");
  });
});

describe("POST /webhook — '?' task list", () => {
  it("replies listing all pending tasks", async () => {
    await seedTask("Buy milk");
    await seedTask("Call dentist");
    await send("?");
    const reply = await waTextReply();
    expect(reply).toContain("Buy milk");
    expect(reply).toContain("Call dentist");
  });

  it("tells the user there are no tasks when the list is empty", async () => {
    await send("+dummy task");
    await waTextReply(); // wait for worker
    const userId = await getTestUserId();
    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId], "pending");
    for (const t of tasks) {
      await env.DB.prepare("UPDATE task SET status = 'completed' WHERE id = ?").bind(t.id).run();
    }
    mockFetch.mockClear();

    await send("?");
    const reply = await waTextReply();
    expect(reply).toContain("אין");
  });
});

describe("POST /webhook — '-N' complete by number", () => {
  it("marks the task as completed and sends a confirmation", async () => {
    await seedTask("Buy milk");
    await send("-1");
    const reply = await waTextReply();
    expect(reply).toContain("🎉 הושלמה");
    expect(reply).toContain("Buy milk");
  });

  it("replies with a not-found message when the index is out of range", async () => {
    await seedTask("Buy milk"); // only 1 task → index 99 is out of range
    await send("-99");
    const reply = await waTextReply();
    expect(reply).toContain("לא מצאתי");
  });
});

describe("POST /webhook — '-הכל' complete all", () => {
  it("completes every pending task and reports the count", async () => {
    await seedTask("Task one");
    await seedTask("Task two");
    await send("-הכל");
    const reply = await waTextReply();
    expect(reply).toContain("הושלמו");
  });
});

describe("POST /webhook — '- name' complete by name", () => {
  it("finds the task by name and sends a completion confirmation", async () => {
    await seedTask("Buy milk");
    await send("- Buy milk");
    const reply = await waTextReply();
    expect(reply).toContain("🎉 הושלמה");
    expect(reply).toContain("Buy milk");
  });
});

describe("POST /webhook — duplicate delivery", () => {
  it("deduplicates the same incoming webhook payload", async () => {
    await createTestUser(TEST_PHONE);
    const message = {
      from: TEST_PHONE,
      id: "dup_msg_1",
      type: "text",
      text: { body: "+Duplicate task" },
    };

    await sendMessage(message);
    const firstReply = await waTextReply();
    expect(firstReply).toContain("Duplicate task");

    mockFetch.mockClear();
    await sendMessage(message);
    await new Promise((r) => setTimeout(r, 200));

    const userId = await getTestUserId();
    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId], "pending");
    expect(tasks.filter((t) => t.description === "Duplicate task").length).toBe(1);

    const waCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      url.includes("graph.facebook.com")
    );
    expect(waCalls.length).toBe(0);
  });
});

describe("POST /webhook — partner invite/accept", () => {
  it("links both users after invite and /yes", async () => {
    await createTestUser(TEST_PHONE);
    const partnerId = await createTestUser(TEST_PHONE_2);

    await send("/partner");
    const partnerPrompt = await waTextReply();
    expect(partnerPrompt).toContain("כרטיס הקשר");
    mockFetch.mockClear();

    await sendMessage({
      from: TEST_PHONE,
      id: "contact_msg_1",
      type: "contacts",
      contacts: [{ phones: [{ wa_id: TEST_PHONE_2 }] }],
    });
    await waTextReply();
    mockFetch.mockClear();

    await SELF.fetch(await makeSignedWebhookRequest("/yes", TEST_PHONE_2));
    await drainConversation(TEST_PHONE_2);
    const acceptReply = await waTextReply();
    expect(acceptReply).toContain("מחוברים");

    const user1 = await getTestUserId();
    const row1 = await env.DB.prepare("SELECT partner_user_id FROM user WHERE id = ?")
      .bind(user1)
      .first<{ partner_user_id: number | null }>();
    const row2 = await env.DB.prepare("SELECT partner_user_id FROM user WHERE id = ?")
      .bind(partnerId)
      .first<{ partner_user_id: number | null }>();
    expect(row1!.partner_user_id).toBe(partnerId);
    expect(row2!.partner_user_id).toBe(user1);
  });
});

describe("POST /webhook — friend invite/accept", () => {
  it("links friends using generic /yes <nickname>", async () => {
    const user1 = await createTestUser(TEST_PHONE);
    const user2 = await createTestUser(TEST_PHONE_2);

    await send("/friend אבא");
    const friendPrompt = await waTextReply();
    expect(friendPrompt).toContain("כרטיס הקשר");
    mockFetch.mockClear();

    await sendMessage({
      from: TEST_PHONE,
      id: "friend_contact_msg_1",
      type: "contacts",
      contacts: [{ phones: [{ wa_id: TEST_PHONE_2 }] }],
    });
    await waTextReply();
    expect(waTextBodies().join("\n")).toContain("/yes <");
    mockFetch.mockClear();

    await SELF.fetch(await makeSignedWebhookRequest("/yes בן", TEST_PHONE_2));
    await drainConversation(TEST_PHONE_2);
    await waTextReply();
    const acceptNotifications = waTextBodies().join("\n");
    expect(acceptNotifications).toContain("*אבא* אישר את בקשת החברות שלך");
    expect(acceptNotifications).not.toContain("*בן* אישר את בקשת החברות שלך");

    const links = await env.DB.prepare(
      "SELECT user_id, friend_user_id, nickname FROM friend_link ORDER BY user_id"
    ).all<{ user_id: number; friend_user_id: number; nickname: string }>();

    expect(links.results).toEqual([
      { user_id: user1, friend_user_id: user2, nickname: "אבא" },
      { user_id: user2, friend_user_id: user1, nickname: "בן" },
    ]);
  });
});

describe("POST /webhook — thumbs up lifecycle", () => {
  it("completes the reminder task once and ignores duplicate reactions", async () => {
    const userId = await createTestUser(TEST_PHONE);
    const past = new Date(Date.now() - 3_600_000);
    const task = await addTask(db, TEST_ENC_KEY, userId, "Thumbs up task", past);

    await scanAndSendReminders(env);

    const reminder = await env.DB.prepare(
      "SELECT whatsapp_message_id FROM message WHERE user_id = ? AND message_type = 'reminder' ORDER BY id DESC LIMIT 1"
    ).bind(userId).first<{ whatsapp_message_id: string }>();
    expect(reminder?.whatsapp_message_id).toBeTruthy();

    mockFetch.mockClear();
    await sendMessage({
      from: TEST_PHONE,
      id: "reaction_msg_1",
      type: "reaction",
      reaction: { emoji: "👍", message_id: reminder!.whatsapp_message_id },
    });
    const firstReply = await waTextReply();
    expect(firstReply).toContain("הושלמה");

    const row = await env.DB.prepare("SELECT status FROM task WHERE id = ?")
      .bind(task.id)
      .first<{ status: string }>();
    expect(row!.status).toBe("completed");

    mockFetch.mockClear();
    await sendMessage({
      from: TEST_PHONE,
      id: "reaction_msg_1_dup",
      type: "reaction",
      reaction: { emoji: "👍", message_id: reminder!.whatsapp_message_id },
    });
    await new Promise((r) => setTimeout(r, 200));

    const waCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      url.includes("graph.facebook.com")
    );
    expect(waCalls.length).toBe(0);
  });
});

describe("POST /webhook — reminder reply actions", () => {
  it("reschedules the quoted reminder instead of adding the user's reply as a new task", async () => {
    const userId = await createTestUser(TEST_PHONE);
    const past = new Date(Date.now() - 3_600_000);
    const task = await addTask(db, TEST_ENC_KEY, userId, "לסגור את החור בתיק הכתום", past);

    await scanAndSendReminders(env);

    const reminder = await env.DB.prepare(
      "SELECT whatsapp_message_id FROM message WHERE user_id = ? AND message_type = 'reminder' ORDER BY id DESC LIMIT 1"
    ).bind(userId).first<{ whatsapp_message_id: string }>();
    expect(reminder?.whatsapp_message_id).toBeTruthy();

    mockFetch = vi.fn().mockImplementation(makeMockFetchWithGeminiResponse({
      tasks: [
        {
          action: "add",
          title: "תזכיר לי בחמישי בשעה 14:00",
          due_date: "2099-07-02 14:00",
          recurrence: null,
        },
      ],
      intent: "task_management",
      reply: "נוספה ✅",
    }));
    vi.stubGlobal("fetch", mockFetch);

    await sendMessage({
      from: TEST_PHONE,
      id: "reply_to_reminder_1",
      type: "text",
      context: { id: reminder!.whatsapp_message_id },
      text: { body: "תזכיר לי בחמישי בשעה 14:00" },
    });

    const reply = await waTextReply();
    expect(reply).toContain("עודכנה");
    expect(reply).toContain("לסגור את החור בתיק הכתום");
    expect(reply).not.toContain("תזכיר לי בחמישי");

    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId], "pending");
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(task.id);
    expect(tasks[0].description).toBe("לסגור את החור בתיק הכתום");
    expect(tasks[0].reminder_sent).toBe(false);
    expect(tasks[0].due_date!.getTime()).toBeGreaterThan(past.getTime());

    const dueLocal = new Date(tasks[0].due_date!.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    expect(dueLocal.getFullYear()).toBe(2099);
    expect(dueLocal.getMonth()).toBe(6);
    expect(dueLocal.getDate()).toBe(2);
  });
});

describe("POST /webhook — invalid signature", () => {
  it("rejects a bad HMAC signature", async () => {
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: TEST_PHONE, id: "bad_sig_1", type: "text", text: { body: "+Bad sig" } },
                ],
              },
            },
          ],
        },
      ],
    });
    const req = new Request("https://worker.example.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body,
    });
    const res = await SELF.fetch(req);
    expect(res.status).toBe(403);
  });
});
