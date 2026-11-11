# Task controls, Undo, and morning agenda

Users continue to identify tasks by name. Button payloads contain signed internal task IDs, actor IDs, revisions, and expiry; no IDs appear in customer-facing button labels.

## Commands and behavior

- Task confirmations: Done, Set reminder (untimed) or Change time (timed), and Undo for a single pending task; Undo for a multi-task operation or completion. `?` opens a paginated name picker with completion, scheduling and cancellation actions. See `docs/TASK_BROWSER.md`.
- Reminder actions: Done, 30-minute snooze, Tomorrow. Tomorrow keeps the task's Jerusalem-local time; an untimed task defaults to 09:00.
- `/undo` or `בטל פעולה אחרונה`: restore the most recent task action within 10 minutes. A button targets that specific action. Creation is undone by cancelling the created task. Completion, rename, reschedule, cancellation, recurrence changes, and grouped operations restore the previous state. Completing a recurring task also records its newly generated occurrence.
- `/agenda` or `סיכום בוקר`: current agenda and settings. `/agenda now` shows today's tasks and overdue tasks on demand.
- `/agenda 08:00`: explicitly opt in to daily delivery at 08:00 Israel time. `/agenda 08:00 weekdays`: Sunday–Thursday. `/agenda off` disables it, including queued jobs. All existing and new users start with automatic delivery disabled.
- `/agenda focus`: select up to three pending accessible tasks by name using a paginated WhatsApp list. `/agenda clear` clears today's priorities. Priorities do not change task dates or sync into Google Calendar.

Automatic summaries skip empty days, expired subscriptions, and sends more than 90 minutes late. They contain counts and Show tasks / Choose priorities / Stop buttons; opening them retrieves current task names. An uncertain delivery is not retried, and `/agenda now` remains available.

The existing recurring reminder behavior is retained: delivery completes the occurrence and schedules its next occurrence. Snoozing that delivered occurrence creates at most one personal one-off task, without duplicating the recurring chain.

## Safety and storage

`0014_task_controls_and_agenda.sql` must be applied before deployment. The task revision trigger covers meaningful edits through every path, including Calendar and API. Reminder delivery metadata does not change the revision. Button actions and Undo recheck current owner/partner/assignment permissions. Later task edits invalidate old actions.

Undo snapshots are encrypted with the existing encryption key and retained for ten minutes. An atomic D1 batch claims the action only when every affected task still exists, is accessible, and has the expected revision. Undo refuses partial restoration or overwriting a later change. Created tasks and their Undo records are committed atomically. Bulk snapshots use bounded batches. Automatic Undo is limited to 500 affected tasks. Account deletion also removes other actors' Undo groups containing the deleted account's tasks.

Agenda delivery and inbound settings changes use the same per-phone Durable Object inbox. Preferences have a revision; job IDs include it. `last_sent_date` enforces one agenda per local date. Israel's spring gap shifts to the next valid wall time; the first occurrence is used during the autumn overlap. Expired records and priorities older than seven days are pruned by cron.

## WhatsApp template activation

Template definitions and examples are in `scripts/whatsapp-engagement-templates.json`. Submit them in WhatsApp Manager for the production WhatsApp Business Account and wait for APPROVED status:

- `todobot_reminder_actions` (Hebrew, Utility): two body variables (task, due time), three quick replies (Done, 30 minutes, Tomorrow).
- `todobot_morning_agenda` (Hebrew, Utility): three body variables (date, today's count, overdue count), three quick replies (Show, Focus, Stop).

Only after approval, set these non-secret Worker vars through the manual deployment:

```toml
REMINDER_ACTIONS_TEMPLATE_NAME = "todobot_reminder_actions"
AGENDA_TEMPLATE_NAME = "todobot_morning_agenda"
```

Until activation, task confirmations and on-demand agenda work. Reminders use interactive action buttons during an active customer-service window and retain the approved `todo_reminder` template outside it. After activation, the action template provides buttons outside the service window too. Automatic agenda opt-in is unavailable until its template is configured. Do not enable these bindings for pending or rejected templates.

Verify with an opted-in test user: create a named task, use Tomorrow, Undo, Done, Undo; check the linked Calendar after sync; run `/agenda focus`, select three tasks; set an agenda time; use Show/Stop after its delivery. Live test messages and agenda opt-in require the user's explicit action.
