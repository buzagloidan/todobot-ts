import { readFileSync } from "node:fs";
const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const value = key => config.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
for (const key of ["GOOGLE_CALENDAR_ENABLED", "GEMINI_CALENDAR_DATA_ALLOWED"]) {
  if (!["true", "false"].includes(value(key))) throw new Error(`${key} must be explicitly true or false.`);
}
if (value("GOOGLE_CALENDAR_ENABLED") === "true" && value("GEMINI_CALENDAR_DATA_ALLOWED") !== "true") {
  throw new Error("Confirm Gemini paid-service data handling before enabling Google Calendar data in AI context.");
}
console.log(value("GOOGLE_CALENDAR_ENABLED") === "true" ? "Calendar activation configured; verify Worker OAuth secrets and live OAuth before claiming availability." : "Calendar remains disabled until OAuth and Gemini data handling are verified.");
