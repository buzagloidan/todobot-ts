# Reminder scheduling and delivery

Each task owner's `ReminderScheduler` Durable Object stores the next due-time alarm. Conversation processing refreshes it after chat, task controls, Undo, API jobs and Calendar changes. These timers are independent of Gemini calls and other users' conversations.

At the due time, the alarm admits jobs to `wa-reminders` in pages of 100. More due jobs schedule an immediate continuation, rather than waiting for the next minute. The queue uses batch size 1, timeout 0 and automatic consumer concurrency. The legacy global 20/minute scan and the chat sender's 900/minute KV soft cap do not constrain queued reminders.

The minute cron only wakes a recovery coordinator. It finds eligible owners with tasks overdue or due within two minutes, refreshes their timers in pages of 200, and immediately continues pages until complete. Billing, Calendar and agenda jobs run independently of this recovery request. Failed D1/queue/RPC operations re-arm the scheduler five seconds later. Newly created tasks normally get their timer immediately; recovery repairs missed refreshes and picks up pre-existing tasks after deployment or restored billing access.

Alarms and Queues have at-least-once execution. `reminder_job` uniquely identifies a task revision and due timestamp; `reminder_delivery` records each recipient's attempt. Atomic claims with a renewable 120-second lease prevent concurrent workers from sending the same recipient. Before delivery the worker checks the current task revision, status, due time, recipient membership and billing access. Completed, cancelled or edited tasks invalidate old jobs. An accepted owner message is not repeated while another recipient retries.

## Failures and timing

- Explicit transient provider rejection (429, 5xx and supported throttling codes) retries independently with exponential backoff and jitter, respecting numeric `Retry-After`. The D1 journal and timers continue recovery beyond the queue's retry budget. Repeated failures generate an operational alert.
- An interrupted send or lost response is **uncertain**: Meta may already have accepted the message. Do not blindly resend it. The HMAC-verified Meta status webhook uses opaque job/recipient IDs to resolve the attempt and resume finalization. Unresolved uncertainty alerts the operator and remains recorded for investigation.
- Permanent provider rejection is recorded and alerted without blocking other tasks. A later asynchronous `failed` receipt also alerts the operator; it does not automatically repeat an already accepted message. Investigate its provider error before deciding whether another attempt is appropriate.
- API acceptance sets `reminder_sent`; status receipts separately track sent/delivered/read. Queue latency, provider limits, downtime and the recipient's network still affect arrival. Timers eliminate deliberate minute polling for ordinary new tasks, but cannot guarantee exact phone delivery at the scheduled second.
- Recurring reminders atomically finish the original and create one successor with the same assignments. The shared recurrence engine supports selected weekdays, Sunday–Thursday workdays and fixed month days in Jerusalem civil time; see `docs/RECURRENCE_AND_SHARING.md`. Overdue recurrence recovery advances directly to the next future occurrence, avoiding a burst of missed daily reminders.

Failed status callbacks save the first valid numeric Meta error code in `reminder_delivery.error_code` and include up to five codes with the job/recipient IDs in structured logs and operator alerts. Provider text and raw callback payloads are not logged. Missing error codes are reported explicitly and do not erase an earlier saved code. A failure after API acceptance does not automatically replay the reminder or undo an already-created recurring successor; investigate the code before choosing recovery.

Structured logs include job/task IDs, attempt counts and `lateness_ms` at acceptance. Recovery logs aggregate unresolved uncertainty. Queue messages contain only the job ID. Descriptions and phones remain encrypted in the existing task/user tables. Finished/stale journals are removed after 30 days; unresolved failed/uncertain entries remain for investigation, and account/task deletion cascades to their journals.

## Production setup

1. Create `wa-reminders-dlq`, then `wa-reminders` with delivery delay zero in the same Cloudflare account.
2. Apply the additive `drizzle/0016_reminder_dispatch.sql` D1 schema before deploying. This creates job/recipient tables and indexes without rewriting tasks or subscriptions.
3. Deploy using the README deployment steps. Wrangler adds the SQLite Durable Object class using migration `reminder-scheduler-v1`, binds the new queues, and enables `REMINDER_SCHEDULER_ENABLED`.
4. Verify deployment success, queue settings, persisted jobs and acceptance latency. Ask an account owner to create a short reminder and verify its receipt. Do not manufacture production messages as part of a read-only smoke check.

Setting `REMINDER_SCHEDULER_ENABLED=false` stops new timer refreshes and recovery admission; already armed alarms and admitted queue jobs can still finish. For a full rollback, deploy the previous code through Actions and pause the new queue consumer. Keep the additive D1 tables until recovery/audit is complete.

After correcting a permanent provider/configuration error, an operator may reset only unaccepted recipients of the affected current-generation job to `retry`, then reset that job to `retry`, `lease_until=0`, `next_attempt_at=0`. Preserve accepted recipient records. Never reset an uncertain send without verifying its actual provider outcome. Editing/rescheduling a task creates a new revision and normal scheduling resumes; it does not replay an old accepted attempt.

## Verification

Run `npx tsc --noEmit`, `npm test`, both billing/Calendar configuration scripts and `npx wrangler deploy --dry-run`. Scheduler tests cover timestamp arming, edits/Undo, 250 simultaneous jobs, paged recovery past 200 owners, queue admission failures, duplicate/crash recovery, stale jobs, entitlement, transient errors, callback authentication, recurrence/assignments and independent per-message acknowledgements/retries.
