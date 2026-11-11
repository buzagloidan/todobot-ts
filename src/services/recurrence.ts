import { TZ } from "../constants.ts";
import { jerusalemLocalToUtc } from "../time.ts";
import type { RecurrenceRule } from "../types.ts";
const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
export function validRecurrence(
  value: unknown,
): value is Exclude<RecurrenceRule, null> {
  if (typeof value !== "string") return false;
  if (["daily", "weekly", "monthly", "weekdays"].includes(value)) return true;
  if (/^monthly:(?:[1-9]|[12]\d|3[01])$/.test(value)) return true;
  if (!/^weekly:[0-6](?:,[0-6]){0,6}$/.test(value)) return false;
  const days = value.slice(7).split(",");
  return new Set(days).size === days.length;
}
export function normalizeRecurrence(value: string): string {
  if (!validRecurrence(value)) throw new Error("Invalid recurrence");
  return value.startsWith("weekly:")
    ? "weekly:" +
        value
          .slice(7)
          .split(",")
          .map(Number)
          .sort((a, b) => a - b)
          .join(",")
    : value;
}
export function recurrenceLabel(value: string): string {
  if (value === "daily") return "כל יום";
  if (value === "weekly") return "כל שבוע";
  if (value === "monthly") return "כל חודש";
  if (value === "weekdays") return "בימי ראשון–חמישי";
  if (/^monthly:/.test(value) && validRecurrence(value)) {
    const day = +value.slice(8);
    return day === 1
      ? "ביום הראשון בכל חודש"
      : `ב־${day} בכל חודש${day > 28 ? " (בחודשים שבהם התאריך קיים)" : ""}`;
  }
  if (value.startsWith("weekly:") && validRecurrence(value)) {
    const days = value
      .slice(7)
      .split(",")
      .map(Number)
      .sort((a, b) => a - b)
      .map((d) => DAYS[d]);
    return (
      "בימי " +
      (days.length === 1
        ? days[0]
        : days.slice(0, -1).join(", ") + " ו" + days.at(-1))
    );
  }
  return "בחזרה קבועה";
}
const civilFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function civil(date: Date) {
  const p = Object.fromEntries(
    civilFormatter.formatToParts(date).map((v) => [v.type, v.value]),
  );
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
  };
}
function instant(day: Date, clock: ReturnType<typeof civil>): Date | null {
  const year = day.getUTCFullYear(),
    month = day.getUTCMonth(),
    date = day.getUTCDate();
  const local = new Date(0);
  local.setFullYear(year, month, date);
  local.setHours(clock.hour, clock.minute, clock.second, 0);
  // A runtime whose timezone is Jerusalem may itself normalize a spring-gap clock.
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month ||
    local.getDate() !== date ||
    local.getHours() !== clock.hour ||
    local.getMinutes() !== clock.minute
  )
    return null;
  const due = new Date(+jerusalemLocalToUtc(local) + clock.second * 1000);
  const matches = (d: Date) => {
    const c = civil(d);
    return (
      c.year === year &&
      c.month === month + 1 &&
      c.day === date &&
      c.hour === clock.hour &&
      c.minute === clock.minute &&
      c.second === clock.second
    );
  };
  if (!matches(due)) return null; // RFC-style skip: nonexistent dates/times never roll into another day.
  const first = new Date(+due - 3600000);
  return matches(first) ? first : due; // One occurrence at the first autumn overlap.
}
/** Select by civil calendar date, preserving Jerusalem's wall clock rather than adding UTC days. */
function findOccurrence(
  due: Date,
  rule: string,
  floor: number,
  inclusive: boolean,
): Date | null {
  if (
    !validRecurrence(rule) ||
    !Number.isFinite(+due) ||
    !Number.isFinite(floor)
  )
    return null;
  const clock = civil(due),
    start = civil(new Date(floor));
  const valid = (candidate: Date | null) =>
    candidate && (inclusive ? +candidate >= floor : +candidate > floor);
  if (rule === "monthly" || rule.startsWith("monthly:")) {
    const monthDay = rule === "monthly" ? clock.day : +rule.slice(8);
    for (let n = 0; n < 24; n++) {
      const month = new Date(Date.UTC(start.year, start.month - 1 + n, 1));
      if (month.getUTCFullYear() > 2100) return null;
      const last = new Date(
        Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0),
      ).getUTCDate();
      if (monthDay > last) continue;
      month.setUTCDate(monthDay);
      const candidate = instant(month, clock);
      if (valid(candidate)) return candidate;
    }
    return null;
  }
  const selected =
    rule === "weekdays"
      ? [0, 1, 2, 3, 4]
      : rule.startsWith("weekly:")
        ? rule.slice(7).split(",").map(Number)
        : rule === "weekly"
          ? [
              new Date(
                Date.UTC(clock.year, clock.month - 1, clock.day),
              ).getUTCDay(),
            ]
          : [0, 1, 2, 3, 4, 5, 6];
  const day = new Date(Date.UTC(start.year, start.month - 1, start.day));
  for (let n = 0; n < 15; n++, day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCFullYear() > 2100) return null;
    if (!selected.includes(day.getUTCDay())) continue;
    const candidate = instant(day, clock);
    if (valid(candidate)) return candidate;
  }
  return null;
}
export function firstRecurringOccurrence(
  due: Date,
  rule: string,
  now = Date.now(),
): Date | null {
  return findOccurrence(due, rule, Math.max(+due, now + 1), true);
}
export function nextRecurringOccurrence(
  due: Date,
  rule: string,
  now = Date.now(),
): Date | null {
  return findOccurrence(due, rule, Math.max(+due, now), false);
}
