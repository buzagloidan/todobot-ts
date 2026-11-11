import { TZ } from "./constants.ts";

// Convert civil Jerusalem fields without depending on the runtime's default timezone.
export function jerusalemLocalToUtc(localDate: Date): Date {
  const desired = Date.UTC(
    localDate.getFullYear(),
    localDate.getMonth(),
    localDate.getDate(),
    localDate.getHours(),
    localDate.getMinutes(),
  );
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
    );
    const represented = Date.UTC(
      +parts.year,
      +parts.month - 1,
      +parts.day,
      +parts.hour,
      +parts.minute,
    );
    const correction = desired - represented;
    if (!correction) break;
    guess += correction;
  }
  return new Date(guess);
}

export function nowInJerusalem(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}

export function parseDueDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    year < 2000 ||
    year > 2100 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  )
    return null;
  const local = new Date(0);
  local.setFullYear(year, month - 1, day);
  local.setHours(hour, minute, 0, 0);
  return jerusalemLocalToUtc(local);
}
