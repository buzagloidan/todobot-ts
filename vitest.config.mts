import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      main: "./src/index.ts",
      miniflare: {
        bindings: {
          ENCRYPTION_KEY:
            "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ",
          BILLING_ENABLED: "true",
          ALERT_PHONE: "15550100101",
          PUBLIC_HOST: "bot.example.com",
          SUPPORT_EMAIL: "support@example.com",
          FEEDBACK_FROM: "Todo <feedback@example.com>",
          FEEDBACK_TO: "support@example.com",
          BOT_WHATSAPP_NUMBER: "15550100100",
          REMINDER_SCHEDULER_ENABLED: "false",
          APP_SECRET: "test_app_secret",
          ACCESS_TOKEN: "test_access_token",
          VERIFY_TOKEN: "test_verify_token",
          AGENDA_TEMPLATE_NAME: "todobot_morning_agenda",
          GEMINI_API_KEY: "test_gemini_key",
          POSTHOG_API_KEY: "", // empty → posthog.ts skips all calls
          RESEND_API_KEY: "test_resend_key",
          LEMONSQUEEZY_STORE_ID: "12345",
          LEMONSQUEEZY_VARIANT_ID: "123456",
          LEMONSQUEEZY_TEST_MODE: "false",
          LEMONSQUEEZY_API_KEY: "test-billing-key",
          LEMONSQUEEZY_WEBHOOK_SECRET: "test-webhook-secret",
          GOOGLE_CALENDAR_ENABLED: "true",
          GEMINI_CALENDAR_DATA_ALLOWED: "true",
          GOOGLE_CLIENT_ID: "test-google.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
