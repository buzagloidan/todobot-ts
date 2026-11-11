import { it, expect } from "vitest";
import {
  validRecurrence,
  normalizeRecurrence,
  recurrenceLabel,
  firstRecurringOccurrence,
  nextRecurringOccurrence,
} from "../src/services/recurrence.ts";
import { parseDueDate } from "../src/time.ts";
import { validateTaskResponse } from "../src/services/task_response.ts";
const local = (s: string) => parseDueDate(s)!;
const display = (d: Date | null) =>
  d?.toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" }).slice(0, 16);
const next = (start: string, rule: string, now?: string) =>
  display(
    nextRecurringOccurrence(
      local(start),
      rule,
      now ? +local(now) : +local(start),
    ),
  );
it("validates bounded recurrence grammar and canonical weekday order", () => {
  for (const r of [
    "daily",
    "weekly",
    "monthly",
    "weekdays",
    "weekly:0,3",
    "weekly:6",
    "weekly:0,1,2,3,4,5,6",
    "monthly:1",
    "monthly:31",
  ])
    expect(validRecurrence(r)).toBe(true);
  for (const r of [
    "weekly:",
    "weekly:0,0",
    "weekly:7",
    "weekly:01",
    "monthly:0",
    "monthly:32",
    "monthly:01",
    "hourly",
    {},
    ["daily"],
    "weekly:0;DELETE FROM task",
  ])
    expect(validRecurrence(r)).toBe(false);
  expect(normalizeRecurrence("weekly:3,0")).toBe("weekly:0,3");
});
it("alternates Sunday and Wednesday while preserving the local clock", () => {
  expect(next("2026-10-11 18:00", "weekly:0,3")).toBe("2026-10-14 18:00");
  expect(next("2026-10-14 18:00", "weekly:0,3")).toBe("2026-10-18 18:00");
});
it("normalizes the first date to selected weekdays and skips missed occurrences", () => {
  expect(
    display(
      firstRecurringOccurrence(
        local("2026-10-12 18:00"),
        "weekly:0,3",
        +local("2026-10-13 12:00"),
      ),
    ),
  ).toBe("2026-10-14 18:00");
  expect(next("2020-01-01 18:00", "weekly:0,3", "2026-10-13 12:00")).toBe(
    "2026-10-14 18:00",
  );
});
it("workdays use Sunday through Thursday without weekend reminders", () => {
  expect(next("2026-10-15 09:00", "weekdays")).toBe("2026-10-18 09:00");
  expect(
    display(
      firstRecurringOccurrence(
        local("2026-10-16 09:00"),
        "weekdays",
        +local("2026-10-15 12:00"),
      ),
    ),
  ).toBe("2026-10-18 09:00");
});
it("fixed month days do not inherit a postponed occurrence date", () => {
  expect(next("2026-10-03 09:00", "monthly:1")).toBe("2026-11-01 09:00");
  expect(next("2020-01-01 09:00", "monthly:1", "2026-10-13 12:00")).toBe(
    "2026-11-01 09:00",
  );
});
it("month-end rules skip nonexistent dates instead of rolling into another month", () => {
  expect(next("2027-01-31 09:00", "monthly:31")).toBe("2027-03-31 09:00");
  expect(next("2027-03-31 09:00", "monthly:31")).toBe("2027-05-31 09:00");
  expect(next("2027-01-31 09:00", "monthly")).toBe("2027-03-31 09:00");
  expect(next("2028-01-29 09:00", "monthly:29")).toBe("2028-02-29 09:00");
  expect(next("2027-01-29 09:00", "monthly:29")).toBe("2027-03-29 09:00");
});
it("legacy daily and weekly rules keep their Jerusalem hour across DST", () => {
  expect(next("2026-10-24 09:00", "daily")).toBe("2026-10-25 09:00");
  expect(
    nextRecurringOccurrence(
      local("2026-10-24 09:00"),
      "daily",
      +local("2026-10-24 09:00"),
    )!.getTime() - +local("2026-10-24 09:00"),
  ).toBe(25 * 3600000);
  expect(next("2026-10-18 09:00", "weekly")).toBe("2026-10-25 09:00");
});
it("nonexistent spring-clock occurrences are skipped without changing the series hour", () => {
  expect(next("2027-03-19 02:30", "weekly:5")).toBe("2027-04-02 02:30");
  expect(next("2027-03-25 02:30", "daily")).toBe("2027-03-27 02:30");
});
it("autumn overlap produces one occurrence at the first matching clock time", () => {
  const result = nextRecurringOccurrence(
    local("2026-10-18 01:30"),
    "weekly:0",
    +local("2026-10-18 01:30"),
  )!;
  expect(result.toISOString()).toBe("2026-10-24T22:30:00.000Z");
  expect(display(nextRecurringOccurrence(result, "weekly:0", +result))).toBe(
    "2026-11-01 01:30",
  );
});
it("invalid rules and dates do not create runaway recurrence loops", () => {
  expect(
    nextRecurringOccurrence(new Date(NaN), "daily", Date.now()),
  ).toBeNull();
  expect(nextRecurringOccurrence(new Date(), "garbage", Date.now())).toBeNull();
});
it("model validation accepts new rules only with a valid first due date", () => {
  const response = (
    recurrence: unknown,
    due_date: unknown = "2026-10-14 18:00",
  ) => ({
    tasks: [{ action: "add", title: "להתאמן", recurrence, due_date }],
    intent: "task_management",
    reply: "",
  });
  for (const r of ["weekly:0,3", "weekdays", "monthly:1"])
    expect(validateTaskResponse(response(r))).toBe(true);
  expect(validateTaskResponse(response("weekdays", null))).toBe(false);
  expect(validateTaskResponse(response({ days: [0, 3] }))).toBe(false);
  expect(validateTaskResponse(response("weekly:0,0"))).toBe(false);
});
it("customer labels describe the actual selected days without exposing internal grammar", () => {
  expect(recurrenceLabel("weekly:0,3")).toBe("בימי ראשון ורביעי");
  expect(recurrenceLabel("weekdays")).toBe("בימי ראשון–חמישי");
  expect(recurrenceLabel("monthly:1")).toBe("ביום הראשון בכל חודש");
  expect(recurrenceLabel("monthly:31")).toContain("התאריך קיים");
});
