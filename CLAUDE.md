# CLAUDE.md — WhatsApp Todo Bot

## What this is
A WhatsApp todo/reminder bot in Hebrew, built on Cloudflare Workers + TypeScript.
Users chat naturally in Hebrew and the bot manages tasks and fires reminders.
Previously ran on Python + Railway; migrated to this stack for edge performance.

## Stack
| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (edge, serverless) |
| Language | TypeScript, `nodejs_compat` flag |
| HTTP framework | Hono |
| Database | Cloudflare D1 (SQLite, HTTP-based) |
| Cache / locks | Cloudflare KV (`CACHE` binding) |
| Google Calendar | Optional two-way sync in a separate Todobot calendar; OAuth tokens encrypted in D1 |
| Message queues | Cloudflare Queues (`MSG_QUEUE` for chat, `REMINDER_QUEUE` for reminder delivery) |
| ORM | Drizzle ORM (SQLite dialect, `mode: "timestamp"` = Unix seconds) |
| AI | Google Gemini (`gemini-flash-lite-latest`) |
| STT | Google Gemini (`gemini-flash-lite-latest`) |
| Messaging API | Meta WhatsApp Cloud API (configurable version) |
| Analytics | PostHog |
| Crypto | Custom Fernet (AES-128-CBC + HMAC-SHA256) |
| CI/CD | GitHub Actions checks only; deployment is manual |

## Development and deployment

See `README.md` for setup and `CONTRIBUTING.md` for checks. CI never deploys.
Use only your own Cloudflare resources and provider credentials. Never commit
secrets, personal contact details, database exports or production logs.
Billing, Calendar, analytics, feedback and sharing are optional per-deployment settings.

## Project structure
```
src/
  index.ts              — Worker entry: fetch, queue consumer, scheduled cron
  reminder_scheduler.ts — Per-owner persistent due-time alarms and paged recovery
  types.ts              — Env, QueueMessage, DbUser, DbTask, ParsedTask types
  constants.ts          — TZ = "Asia/Jerusalem"
  routes/
    webhook.ts          — GET/POST /webhook (Meta verification + message handling)
  queue/
    consumer.ts         — Queue message dispatcher (text + voice processing)
    producer.ts         — enqueueText / enqueueVoice helpers
  db/
    schema.ts           — Drizzle schema: users, messages, tasks
    client.ts           — buildDb(env) factory
    queries.ts          — All DB access functions
  services/
    gemini.ts           — processMessage() + transcribeAudio()
    whatsapp.ts         — sendMessage, sendReaction, sendTemplateReminder, downloadMedia
    reminders.ts        — Reminder scheduler/delivery exports
    reminder_dispatch.ts — Durable reminder jobs, recipient receipts and retries
    task_browser.ts     — Paginated named task selection with current permission/revision checks
    task_schedule.ts    — Signed time choices and isolated custom-time drafts
    projects.ts         — Named projects, real-task checklists and progress
    recovery.ts         — Review overdue tasks with keep/reschedule/cancel choices
    guide.ts            — Short help, first reminder demo and contextual feature discovery
    posthog.ts          — capture() / identify()
  redis/
    client.ts           — KV-backed: QueryCache, acquireLock, checkUserRateLimit, checkDailyMessageLimit
  rate_limit.ts         — checkServiceRateLimit() for gemini + whatsapp API calls
  crypto/
    fernet.ts           — Fernet encrypt/decrypt for phone numbers and message content
    hash.ts             — hashPhone() — SHA-256 for phone lookup
```

## Message flow
```
WhatsApp → POST /webhook
  → verifySignature (HMAC-SHA256)
  → admit encrypted message into per-phone Conversation Durable Object inbox
  → return 200 after durable admission; alarm processes messages sequentially
  → persistent dedup by WhatsApp message ID (7 days)
  → getOrCreateUser
  → handleBasicCommand? → reply directly (no LLM, no 👀)
      Commands: ?, ?1, ?2, /help, /help more, /tos, /privacy, -N, N-, -הכל,
                - <name>, +<text>, <text>+, 👍, /undo, /agenda, /recover, #, # <name>, /projects, /project <name>
  → rate limit check (only for LLM requests)
  → sendReaction(👀) + processText() in parallel, within the conversation alarm
  → Text/voice consumer (legacy Queue deliveries also enter the conversation inbox)
      → getTaskStats + fresh conversation history from D1 (24 entries)
      → processMessage() → Gemini JSON-mode call + runtime schema validation → {tasks, intent, reply}
      → executeTask() for each task → returns {display, taskId}
      → sendTaskReply() with exact-task controls and encrypted Undo snapshot
      → sendReaction("") to clear 👀
      → saveMessage() with real task_id in parsedTasks
```

## Key design decisions

### Single Gemini call
`processMessage()` returns `{tasks, intent, reply}` in one JSON. Task results (with exact Jerusalem-formatted times from `executeTask`) override Gemini's reply for task operations.

### Timezone
All dates are stored as UTC in D1. Gemini always returns `YYYY-MM-DD HH:MM` in Jerusalem local time. `parseDueDate()` converts Jerusalem local → UTC via `jerusalemLocalToUtc()`.

### Encryption
Phone numbers: stored as Fernet-encrypted blob + SHA-256 hash (hash used for lookup, blob for decryption).
Messages: content and AI response both Fernet-encrypted at rest.

### 👍 reaction → complete task
`getTaskIdFromMessageId()` looks up `whatsapp_message_id` → `parsed_tasks.tasks[0].task_id`.
Works for: reminder messages (always have task_id) and LLM responses that added tasks (task_id now saved from `executeTask` return value).
Falls back to: last reminder message if reaction wasn't on a tracked message.

### 👀 emoji lifecycle
Set: while handling the message in its conversation alarm, in parallel with text/voice processing.
Cleared: in queue consumer after `sendMessage` completes, via `sendReaction("")`.
`sendReaction` bypasses the service rate limiter (direct fetch, not through `doSend`).

### WhatsApp template reminders
Reminders use the approved `todo_reminder` template, or `REMINDER_ACTIONS_TEMPLATE_NAME` after approval (bypasses 24h messaging window).
Template has two body variables: `{{1}}` = task description, `{{2}}` = due time string.
Interactive fallback is restricted to the active customer-service window. New action and agenda template setup is documented in `docs/TASK_CONTROLS_AND_AGENDA.md`.

### Conversation history
Read the latest 24 user/assistant entries from D1 on every request, ordered by timestamp and ID. Context includes up to 1000 characters per entry, bounded to 16,000 content characters. Per-phone inbox ordering ensures the earlier request saves its history before the next starts. See `docs/CONVERSATIONS.md` for crash handling and deduplication.

## Database schema
Projects and recovery: tasks optionally belong to an encrypted named project. Checklist items are ordinary tasks with completion, reminders, sharing and Calendar sync. Named mutations in a project select the exact task; ambiguous names require clarification. Recovery is requested by the user or linked from the agenda. Keep acknowledges a task revision, reschedule reuses the task, and cancel stops recurrence with Undo support. See `docs/PROJECTS_AND_RECOVERY.md`; apply migration 0017 before deploying.

```
users       id, phone_number_encrypted, phone_number_hash, created_at, last_active
messages    id, user_id, message_type, content_encrypted, ai_response_encrypted,
            parsed_tasks (JSON), whatsapp_message_id, created_at
tasks       id, user_id, description, status, due_date, reminder_sent,
            created_at, completed_at, updated_at, revision
```
`message_type` values: `"text"`, `"audio"`, `"reminder"`, `"system"`, `"button"`

## Rate limits
- Per-user: 20 messages/minute, 100/day (KV counters, only for LLM requests)
- WhatsApp chat/API service: 900/min, 50k/hr, 1M/day (soft limit via `rate_limit.ts`). Queued reminders use independent provider-aware retries and bypass this legacy soft cap.
- Gemini service: 60/min, 1k/hr, 10k/day

## Cron
- `*/1 * * * *` wakes paged reminder recovery, billing reconciliation, Calendar sync and agendas independently.
- Reminders normally start from each owner's persistent due-time alarm. Internal pages of 100 jobs continue immediately; `wa-reminders` scales its delivery consumers automatically. There is no global 20-reminders/minute cap. See `docs/REMINDERS.md` for retries, uncertain sends and production setup.

## Common commands
```bash
npm ci                    # verify a clean install after dependency/lockfile changes
npx tsc --noEmit          # type check before committing
npx wrangler tail         # stream live logs from production
npx wrangler d1 execute bot-db --remote --command "SELECT * FROM task LIMIT 10"
```

## Things NOT to touch
- STT model: `gemini-flash-lite-latest` — this exact string, do not change
- Task list sort order: newest-first (`desc(created_at)`) — intentional
- Gemini model: `gemini-flash-lite-latest` — user's choice, friendly error if it fails

## Known limitations
- Google Calendar setup/activation is documented in `docs/GOOGLE_CALENDAR.md`. Keep its activation flags false until OAuth credentials and Gemini paid-service data handling are verified. Apply the additive Calendar D1 migration before deploying the new task schema.
- Cloudflare D1 queries are HTTP-based (~10–30ms each) — avoid adding new sequential queries to the hot path
- KV has no atomic compare-and-set — reminder claims and recipient deduplication use atomic D1 updates instead.
- `reminder_date` column exists in D1 but is removed from Drizzle schema — harmless dead column

## Focused UX
`/help` is a short guide; `/help more` holds less-used commands. `#` lists projects, and `# <name>` opens one. New users can start immediately in text or voice, or explicitly click a one-minute reminder demo. Calendar and project discovery follow successful task creation, with a welcome cooldown and at most one discovery message per day. See `docs/ONBOARDING.md`.

Boards and business mode are retired from the runtime. Historical tables, columns, migrations and document files remain archived; do not generate or apply a destructive schema cleanup merely because Drizzle no longer declares them. There are no browser/PDF or business R2 bindings. `biz_opaque_callback_data` is Meta's reminder delivery correlation field and must remain supported.

Task selection and adaptive time buttons are documented in `docs/TASK_BROWSER.md`. Apply the additive `0018_task_schedule_pending.sql` migration before this release. Custom times edit only the selected task, preserve project/recurrence, and use the existing Undo and reminder/Calendar lifecycle.

## Flexible recurrence and sharing
Recurrence is stored in the existing task text column: legacy daily/weekly/monthly, weekdays (Sunday–Thursday), weekly:0,3 (selected JS weekdays), and monthly:1 (fixed month day). One shared Jerusalem civil-date engine calculates initial/next occurrences for both delivery and manual completion; no UTC-duration drift across DST or catch-up bursts. See `docs/RECURRENCE_AND_SHARING.md`.

`/share` prepares a public intro and the configured `BOT_WHATSAPP_NUMBER` link. A one-time optional prompt follows a human completion/acknowledgment of an accepted reminder, respecting the feature-discovery cooldown. The sender chooses the recipient and confirms sending in their own WhatsApp client. Never send invites to contacts automatically. Apply additive migration 0019 before deployment; it stores only offer state per user.
