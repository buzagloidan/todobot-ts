/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { dispatchQueueMessage } from "../src/queue/consumer.ts";
import { createTestUser, applySchema, clearData, makeMockFetch, TEST_PHONE } from "./helpers.ts";
let mockFetch: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await clearData();
  mockFetch = vi.fn().mockImplementation(makeMockFetch());
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queue consumer", () => {
  it("drops queued messages for deleted users without sending a fallback error", async () => {
    const userId = await createTestUser(TEST_PHONE);
    await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(userId).run();

    await dispatchQueueMessage(
      {
        type: "text_processing",
        userId,
        phone: TEST_PHONE,
        text: "hello after delete",
      },
      env
    );

    const waCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes("graph.facebook.com"));
    expect(waCalls).toHaveLength(0);
  });
});
