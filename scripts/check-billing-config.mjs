import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const enabled = config.match(/^BILLING_ENABLED\s*=\s*"([^"]*)"/m)?.[1];
if (!["true", "false"].includes(enabled)) throw new Error("BILLING_ENABLED must be explicitly true or false");
if (enabled === "false") { console.log("Self-hosted mode: billing disabled."); process.exit(0); }
for (const name of ["LEMONSQUEEZY_STORE_ID", "LEMONSQUEEZY_VARIANT_ID"]) {
  const value = config.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be configured before releasing billing`);
}
if (!/^LEMONSQUEEZY_TEST_MODE\s*=\s*"(?:true|false)"/m.test(config)) throw new Error("Set LEMONSQUEEZY_TEST_MODE explicitly");
console.log("Billing configuration is present; verify provider setup before accepting payments.");
