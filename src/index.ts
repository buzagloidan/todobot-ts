import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env, QueueMessage, ReminderQueueMessage } from "./types.ts";
import { webhookGet, webhookPost } from "./routes/webhook.ts";
import { apiHandler } from "./routes/api.ts";
import { enqueueConversation } from "./conversation.ts";
export { Conversation } from "./conversation.ts";
export { ReminderScheduler } from "./reminder_scheduler.ts";
import { recoverReminderSchedules } from "./reminder_scheduler.ts";
import { deliverReminderJob } from "./services/reminder_dispatch.ts";
import { billingWebhook, billingSuccess } from "./routes/billing.ts";
import { calendarConnect, calendarAuthorize, calendarCallback, publicHome, publicPrivacy, publicTerms } from "./routes/calendar.ts";
import { scheduleCalendarSync } from "./services/google_calendar.ts";
import { reconcileBilling } from "./services/billing.ts";
import { scheduleAgendas } from './services/agenda.ts';

const app = new Hono<{ Bindings: Env }>();

app.get("/", publicHome);
app.get("/privacy", publicPrivacy);
app.get("/terms", publicTerms);
app.get("/calendar/connect", calendarConnect);
app.post("/calendar/authorize", bodyLimit({ maxSize: 4096 }), calendarAuthorize);
app.get("/calendar/callback", calendarCallback);
app.get("/webhook", webhookGet);
app.post("/webhook", bodyLimit({ maxSize: 256 * 1024 }), webhookPost);
app.post("/api/v1/:secret", bodyLimit({ maxSize: 16 * 1024 }), apiHandler);
app.post("/billing/webhook", billingWebhook);
app.get("/billing/success", billingSuccess);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<QueueMessage | ReminderQueueMessage>, env: Env): Promise<void> {
    await Promise.all(
      batch.messages.map(async (msg) => {
        try {
          if(msg.body.type === 'reminder') {
            const delay=await deliverReminderJob(env,msg.body.jobId);
            if(delay!==null){msg.retry({delaySeconds:delay});return;}
          } else await enqueueConversation(env, { kind: "queue", message: msg.body });
          msg.ack();
        } catch (err) {
          console.error("Queue processing error:", err);
          msg.retry({ delaySeconds: 10 });
        }
      })
    );
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "*/1 * * * *") {
      // Reminder recovery cannot wait behind billing, Calendar or agenda work.
      ctx.waitUntil(recoverReminderSchedules(env));
      ctx.waitUntil(reconcileBilling(env));
      ctx.waitUntil(scheduleCalendarSync(env));
      ctx.waitUntil(scheduleAgendas(env));
    }
  },
};
