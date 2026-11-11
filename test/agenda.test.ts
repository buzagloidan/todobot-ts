/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { buildDb } from "../src/db/client.ts";
import { addTask, getUserById, completeTask } from "../src/db/queries.ts";
import {
  agendaCommand,
  agendaText,
  nextAgendaAt,
  localDateKey,
  deliverAgenda,
  scheduleAgendas,
  handleAgendaControl,
  showPriorityPicker,
  normalizeAgendaCommand,
} from "../src/services/agenda.ts";
import { signControl, verifyControl } from "../src/services/controls.ts";
import {
  applySchema,
  clearData,
  createTestUser,
  TEST_ENC_KEY,
  TEST_PHONE,
  TEST_PHONE_2,
  makeMockFetch,
  drainConversation,
} from "./helpers.ts";
let db: ReturnType<typeof buildDb>,
  actorId: number,
  fetchMock: ReturnType<typeof vi.fn>;
beforeAll(async () => {
  await applySchema();
  db = buildDb(env);
});
beforeEach(async () => {
  await clearData();
  actorId = await createTestUser();
  fetchMock = vi.fn(makeMockFetch());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const user = async () => (await getUserById(db, actorId))!;
const wa = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes("graph.facebook.com"))
    .map(([, init]) => JSON.parse(init.body));
const pref = async () =>
  env.DB.prepare("SELECT * FROM agenda_preferences WHERE user_id=?")
    .bind(actorId)
    .first<{
      enabled: number;
      revision: number;
      next_send_at: number;
      last_sent_date: string | null;
      last_error: string | null;
    }>();
function clock(iso: string) {
  vi.spyOn(Date, "now").mockReturnValue(+new Date(iso));
}
async function enable() {
  await agendaCommand(env, await user(), "/agenda 08:00", TEST_PHONE);
}
async function tasks() {
  await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Today",
    new Date("2026-10-12T10:00:00Z"),
  );
  await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Overdue",
    new Date("2026-10-11T10:00:00Z"),
  );
}

it("is off by default and requires explicit opt-in with an approved template", async () => {
  expect(
    await agendaCommand(env, await user(), "/agenda", TEST_PHONE),
  ).toContain("כבוי");
  expect(await pref()).toBeNull();
  expect(
    await agendaCommand(
      { ...env, AGENDA_TEMPLATE_NAME: undefined },
      await user(),
      "/agenda 08:00",
      TEST_PHONE,
    ),
  ).toContain("בהכנה");
  expect(await pref()).toBeNull();
  await enable();
  expect((await pref())?.enabled).toBe(1);
});
it("validates time and supports Hebrew commands", async () => {
  expect(
    await agendaCommand(env, await user(), "/agenda 24:00", TEST_PHONE),
  ).toContain("אינה תקפה");
  expect(await pref()).toBeNull();
  expect(normalizeAgendaCommand("הפעל סיכום בוקר בשעה 8:30")).toBe(
    "/agenda 8:30",
  );
  expect(normalizeAgendaCommand("כבה סיכום בוקר")).toBe("/agenda off");
});
it("schedules weekdays Sunday–Thursday, crossing Israel DST correctly", () => {
  expect(
    new Date(
      nextAgendaAt(
        "08:00",
        "weekdays",
        +new Date("2026-10-15T05:00:00Z") / 1000,
      ) * 1000,
    ).toISOString(),
  ).toBe("2026-10-18T05:00:00.000Z");
  expect(
    new Date(
      nextAgendaAt("08:00", "daily", +new Date("2026-10-24T06:00:00Z") / 1000) *
        1000,
    ).toISOString(),
  ).toBe("2026-10-25T06:00:00.000Z");
  expect(
    new Date(
      nextAgendaAt("02:30", "daily", +new Date("2026-03-26T22:00:00Z") / 1000) *
        1000,
    ).toISOString(),
  ).toBe("2026-03-27T00:30:00.000Z");
  expect(
    new Date(
      nextAgendaAt("01:30", "daily", +new Date("2026-10-24T21:00:00Z") / 1000) *
        1000,
    ).toISOString(),
  ).toBe("2026-10-24T22:30:00.000Z");
});
it("groups tasks by Jerusalem date, including midnight boundaries", async () => {
  clock("2026-10-12T06:00:00Z");
  await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Midnight",
    new Date("2026-10-11T21:00:00Z"),
  );
  await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Before midnight",
    new Date("2026-10-11T20:59:00Z"),
  );
  await addTask(
    db,
    TEST_ENC_KEY,
    actorId,
    "Tomorrow",
    new Date("2026-10-12T21:00:00Z"),
  );
  await addTask(db, TEST_ENC_KEY, actorId, "Untimed", null);
  const text = await agendaText(env, await user());
  expect(text).toContain("להיום: 1 | באיחור: 1");
  expect(text).toContain("1 משימות ללא שעה");
  expect(text).not.toContain("Tomorrow");
});
it("allows at most three distinct pending priorities and clears them", async () => {
  clock("2026-10-12T06:00:00Z");
  const items = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      addTask(db, TEST_ENC_KEY, actorId, `Task ${i}`, null),
    ),
  );
  for (const t of items)
    await handleAgendaControl(
      env,
      await user(),
      TEST_PHONE,
      await signControl(env, "agenda", actorId, localDateKey(), "pick", t.id),
    );
  await handleAgendaControl(
    env,
    await user(),
    TEST_PHONE,
    await signControl(
      env,
      "agenda",
      actorId,
      localDateKey(),
      "pick",
      items[0].id,
    ),
  );
  expect(
    (await env.DB.prepare("SELECT task_id FROM agenda_priority").all()).results,
  ).toHaveLength(3);
  await agendaCommand(env, await user(), "/agenda clear", TEST_PHONE);
  expect(
    (await env.DB.prepare("SELECT task_id FROM agenda_priority").all()).results,
  ).toHaveLength(0);
});
it("completed priorities free a slot and inaccessible tasks cannot be selected", async () => {
  clock("2026-10-12T06:00:00Z");
  const items = [];
  for (let i = 0; i < 4; i++)
    items.push(await addTask(db, TEST_ENC_KEY, actorId, `Task ${i}`, null));
  for (const t of items.slice(0, 3))
    await handleAgendaControl(
      env,
      await user(),
      TEST_PHONE,
      await signControl(env, "agenda", actorId, localDateKey(), "pick", t.id),
    );
  await completeTask(db, TEST_ENC_KEY, items[0].id, [actorId]);
  await handleAgendaControl(
    env,
    await user(),
    TEST_PHONE,
    await signControl(
      env,
      "agenda",
      actorId,
      localDateKey(),
      "pick",
      items[3].id,
    ),
  );
  const other = await createTestUser(TEST_PHONE_2);
  const hidden = await addTask(db, TEST_ENC_KEY, other, "Hidden", null);
  await handleAgendaControl(
    env,
    await user(),
    TEST_PHONE,
    await signControl(
      env,
      "agenda",
      actorId,
      localDateKey(),
      "pick",
      hidden.id,
    ),
  );
  const text = await agendaText(env, await user());
  expect(text).not.toContain("Hidden");
  expect(
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM agenda_priority").first<{
        n: number;
      }>()
    )?.n,
  ).toBe(4);
});
it("paginates name-based selection within WhatsApp list limits", async () => {
  for (let i = 0; i < 12; i++)
    await addTask(
      db,
      TEST_ENC_KEY,
      actorId,
      "A long task description " + i,
      null,
    );
  await showPriorityPicker(env, await user(), TEST_PHONE);
  const rows = wa()[0].interactive.action.sections[0].rows;
  expect(rows).toHaveLength(10);
  expect(rows.every((r: { title: string }) => r.title.length <= 24)).toBe(true);
  expect((await verifyControl(env, rows[9].id, actorId))?.values[2]).toBe(
    "page",
  );
  await handleAgendaControl(env, await user(), TEST_PHONE, rows[9].id);
  expect(wa()[1].interactive.action.sections[0].rows).toHaveLength(3);
});
it("rejects yesterday’s priority selection but allows its Stop button", async () => {
  clock("2026-10-12T06:00:00Z");
  await enable();
  const t = await addTask(db, TEST_ENC_KEY, actorId, "Task", null);
  await handleAgendaControl(
    env,
    await user(),
    TEST_PHONE,
    await signControl(env, "agenda", actorId, "2026-10-11", "pick", t.id),
  );
  expect(
    (await env.DB.prepare("SELECT task_id FROM agenda_priority").all()).results,
  ).toHaveLength(0);
  await handleAgendaControl(
    env,
    await user(),
    TEST_PHONE,
    await signControl(env, "agenda", actorId, "2026-10-11", "off"),
  );
  expect((await pref())?.enabled).toBe(0);
});
it("sends one approved agenda per day with signed Show, Focus and Stop actions", async () => {
  clock("2026-10-12T05:00:00Z");
  await tasks();
  await enable();
  const revision = (await pref())!.revision;
  await deliverAgenda(env, actorId, "2026-10-12", revision);
  await deliverAgenda(env, actorId, "2026-10-12", revision);
  const templates = wa().filter((b) => b.type === "template");
  expect(templates).toHaveLength(1);
  const components = templates[0].template.components;
  expect(components[0].parameters.map((p: { text: string }) => p.text)).toEqual(
    ["12/10/2026", "1", "1"],
  );
  expect(components).toHaveLength(4);
  expect(
    (await verifyControl(env, components[3].parameters[0].payload, actorId))
      ?.values[2],
  ).toBe("off");
});
it("skips empty days and expired subscriptions", async () => {
  clock("2026-10-12T05:00:00Z");
  await enable();
  await deliverAgenda(env, actorId, "2026-10-12", (await pref())!.revision);
  expect(wa()).toHaveLength(0);
  await tasks();
  await env.DB.prepare("UPDATE billing_account SET trial_ends_at=?")
    .bind(Math.floor(Date.now() / 1000) - 1)
    .run();
  await env.DB.prepare(
    "UPDATE agenda_preferences SET last_sent_date=NULL WHERE user_id=?",
  )
    .bind(actorId)
    .run();
  await deliverAgenda(env, actorId, "2026-10-12", (await pref())!.revision);
  expect(wa()).toHaveLength(0);
});
it("ignores stale or disabled jobs after a preference change", async () => {
  clock("2026-10-12T05:00:00Z");
  await tasks();
  await enable();
  const revision = (await pref())!.revision;
  await agendaCommand(env, await user(), "/agenda 09:00", TEST_PHONE);
  await deliverAgenda(env, actorId, "2026-10-12", revision);
  expect(wa()).toHaveLength(0);
  await agendaCommand(env, await user(), "/agenda off", TEST_PHONE);
  await deliverAgenda(env, actorId, "2026-10-12", (await pref())!.revision);
  expect(wa()).toHaveLength(0);
});
it("skips old/outage agendas without overwriting a newer sent date", async () => {
  clock("2026-10-12T10:00:00Z");
  await tasks();
  await enable();
  await env.DB.prepare(
    "UPDATE agenda_preferences SET last_sent_date='2026-10-12' WHERE user_id=?",
  )
    .bind(actorId)
    .run();
  await deliverAgenda(env, actorId, "2026-10-11", (await pref())!.revision);
  expect((await pref())?.last_sent_date).toBe("2026-10-12");
  expect(wa()).toHaveLength(0);
  await deliverAgenda(env, actorId, "2026-10-12", (await pref())!.revision);
  expect(wa()).toHaveLength(0);
});
it("does not repeat an uncertain provider failure", async () => {
  clock("2026-10-12T05:00:00Z");
  await tasks();
  await enable();
  fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
  const revision = (await pref())!.revision;
  await deliverAgenda(env, actorId, "2026-10-12", revision);
  await deliverAgenda(env, actorId, "2026-10-12", revision);
  expect(wa()).toHaveLength(1);
  expect((await pref())?.last_error).toBe("delivery");
});
it("serializes and deduplicates scheduled agendas in the user inbox", async () => {
  // Real clock is used for the Durable Object alarm. Choose the current minute as the opted-in schedule.
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  await agendaCommand(env, await user(), `/agenda ${local}`, TEST_PHONE);
  await addTask(db, TEST_ENC_KEY, actorId, "Due", new Date(Date.now() - 60000));
  await env.DB.prepare(
    "UPDATE agenda_preferences SET next_send_at=? WHERE user_id=?",
  )
    .bind(Math.floor(Date.now() / 1000) - 1, actorId)
    .run();
  await Promise.all([scheduleAgendas(env), scheduleAgendas(env)]);
  await drainConversation();
  expect(wa().filter((b) => b.type === "template")).toHaveLength(1);
  expect((await pref())?.last_sent_date).toBe(localDateKey());
});
