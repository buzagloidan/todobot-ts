/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { buildDb } from "../src/db/client.ts";
import {
  addTask,
  getUserTasks,
  completeTask,
  completeTaskByDescription,
  updateTaskByDescription,
  getDueTasksForReminders,
} from "../src/db/queries.ts";
import {
  TEST_ENC_KEY,
  applySchema,
  clearData,
  createTestUser,
} from "./helpers.ts";

let db: ReturnType<typeof buildDb>;
let userId: number;

beforeAll(async () => {
  await applySchema();
  db = buildDb(env);
});

beforeEach(async () => {
  await clearData();
  userId = await createTestUser();
});

// ── addTask ───────────────────────────────────────────────────────────────────

describe("addTask", () => {
  it("returns the plaintext description to the caller", async () => {
    const task = await addTask(db, TEST_ENC_KEY, userId, "Buy milk", null);
    expect(task.description).toBe("Buy milk");
  });

  it("stores an encrypted blob in the DB, not the plaintext", async () => {
    const task = await addTask(db, TEST_ENC_KEY, userId, "Buy milk", null);
    const raw = await env.DB.prepare(
      "SELECT description FROM task WHERE id = ?"
    )
      .bind(task.id)
      .first<{ description: string }>();
    expect(raw!.description).not.toBe("Buy milk");
    expect(raw!.description.length).toBeGreaterThan(20);
  });
});

// ── getUserTasks ──────────────────────────────────────────────────────────────

describe("getUserTasks", () => {
  it("decrypts descriptions for multiple tasks", async () => {
    await addTask(db, TEST_ENC_KEY, userId, "Buy milk", null);
    await addTask(db, TEST_ENC_KEY, userId, "Call dentist", null);
    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId]);
    const descs = tasks.map((t) => t.description);
    expect(descs).toContain("Buy milk");
    expect(descs).toContain("Call dentist");
  });

  it("falls back gracefully for legacy plaintext descriptions", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO task (user_id, description, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)"
    )
      .bind(userId, "plain text task", now, now)
      .run();
    const tasks = await getUserTasks(db, TEST_ENC_KEY, [userId]);
    expect(tasks.some((t) => t.description === "plain text task")).toBe(true);
  });
});

// ── completeTaskByDescription ─────────────────────────────────────────────────

describe("completeTaskByDescription", () => {
  it("matches by exact description and marks as completed", async () => {
    await addTask(db, TEST_ENC_KEY, userId, "Buy milk", null);
    const result = await completeTaskByDescription(
      db, TEST_ENC_KEY, [userId], "Buy milk"
    );
    expect(result).not.toBeNull();
    expect(result!.description).toBe("Buy milk");
    expect(result!.status).toBe("completed");
  });

  it("matches by substring", async () => {
    await addTask(db, TEST_ENC_KEY, userId, "Buy milk from store", null);
    const result = await completeTaskByDescription(
      db, TEST_ENC_KEY, [userId], "Buy milk"
    );
    expect(result).not.toBeNull();
    expect(result!.description).toBe("Buy milk from store");
  });

  it("matches by 1-based numeric index", async () => {
    const task = await addTask(db, TEST_ENC_KEY, userId, "The only task", null);
    const result = await completeTaskByDescription(db, TEST_ENC_KEY, [userId], "1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(task.id);
  });

  it("returns null when no task matches", async () => {
    await addTask(db, TEST_ENC_KEY, userId, "Buy milk", null);
    const result = await completeTaskByDescription(
      db, TEST_ENC_KEY, [userId], "nonexistent xyz"
    );
    expect(result).toBeNull();
  });
});

describe("completeTask", () => {
  it("only completes a pending task once", async () => {
    const task = await addTask(db, TEST_ENC_KEY, userId, "Buy milk", null);
    const first = await completeTask(db, TEST_ENC_KEY, task.id, [userId]);
    const second = await completeTask(db, TEST_ENC_KEY, task.id, [userId]);
    expect(first).not.toBeNull();
    expect(first!.status).toBe("completed");
    expect(second).toBeNull();
  });
});

// ── updateTaskByDescription ───────────────────────────────────────────────────

describe("updateTaskByDescription", () => {
  it("updates the description and re-encrypts it in the DB", async () => {
    await addTask(db, TEST_ENC_KEY, userId, "Old name", null);
    const result = await updateTaskByDescription(
      db, TEST_ENC_KEY, [userId], "Old name", { description: "New name" }
    );
    expect(result).not.toBeNull();
    expect(result!.description).toBe("New name");

    const raw = await env.DB.prepare(
      "SELECT description FROM task WHERE id = ?"
    )
      .bind(result!.id)
      .first<{ description: string }>();
    expect(raw!.description).not.toBe("New name");
    expect(raw!.description.length).toBeGreaterThan(20);
  });

  it("returns null when the task cannot be found", async () => {
    const result = await updateTaskByDescription(
      db, TEST_ENC_KEY, [userId], "does not exist", { description: "X" }
    );
    expect(result).toBeNull();
  });
});

// ── getDueTasksForReminders ───────────────────────────────────────────────────

describe("getDueTasksForReminders", () => {
  it("returns past-due tasks with decrypted descriptions", async () => {
    const pastDate = new Date(Date.now() - 3_600_000);
    await addTask(db, TEST_ENC_KEY, userId, "Overdue meeting", pastDate);
    const rows = await getDueTasksForReminders(db, TEST_ENC_KEY);
    expect(rows.length).toBe(1);
    expect(rows[0].task.description).toBe("Overdue meeting");
  });

  it("does not return future tasks", async () => {
    const futureDate = new Date(Date.now() + 3_600_000);
    await addTask(db, TEST_ENC_KEY, userId, "Future task", futureDate);
    const rows = await getDueTasksForReminders(db, TEST_ENC_KEY);
    expect(rows.length).toBe(0);
  });

  it("does not return tasks where reminder_sent is already true", async () => {
    const pastDate = new Date(Date.now() - 3_600_000);
    const task = await addTask(db, TEST_ENC_KEY, userId, "Already reminded", pastDate);
    await env.DB.prepare("UPDATE task SET reminder_sent = 1 WHERE id = ?")
      .bind(task.id)
      .run();
    const rows = await getDueTasksForReminders(db, TEST_ENC_KEY);
    expect(rows.length).toBe(0);
  });
});
