# Clickable task management

`?` and `/list` open a named task picker; `?1` and `?2` retain the upcoming-day filters, including overdue tasks. Natural-language list requests and the Help task button open the same picker. Pages contain up to eight tasks plus next/previous navigation, respecting WhatsApp's ten-row limit. There is no new limit on total tasks or reminders. Task dates, project and existing sharing context remain visible. Legacy completion shortcuts remain supported; numbers align with the complete due-sorted task list.

Selecting a name shows its full description, reminder time and project before offering Done, Set reminder or Change time, and Cancel task. Long descriptions appear in full before a bounded button message. The same controls appear when selecting a project item. Creation/rescheduling confirmations retain Undo as their third button. Delivered reminder/template buttons keep their existing payloads and labels.

## Choosing a reminder time

The time picker offers today at 20:00 when still future, tomorrow at 09:00, 30 minutes, an hour, and a custom time. Each preset displays its date and time and signs the corresponding absolute UTC instant, so clicking across midnight does not change the displayed date. Opening the picker changes no task dates.

Custom selection creates a fifteen-minute draft for the actor and exact task revision. Users can type or record a time such as `מחר ב־10:00` or `בעוד שעתיים`. Numeric clock, date and common relative forms resolve directly. Spoken time forms may use the existing Gemini model, but only a single validated action's future date is used; its task title, recurrence and other fields are never executed. Vague or invalid times ask for clarification. Time conversion uses explicit Jerusalem civil fields and round-trip checks; nonexistent spring-clock times are refused.

Only time-only replies can enter this flow. Ordinary task requests remain in regular chat. A reply quoted to another message does not consume the draft. Selecting another task or opening the general task list clears the draft; entering recovery's custom-time flow replaces it. The Cancel time button is signed for that particular draft, so an old cancel button cannot erase a newer draft. Expired drafts do not modify tasks.

## Permissions and lifecycle

Selection and action tokens bind the actor, exact task, revision and expiry. Every action rechecks current ownership, partnership or assignment. Renames, Calendar edits, removed assignments and completed tasks invalidate old controls. Task mutations recheck permissions/revisions inside the existing atomic Undo batch, preventing duplicate or concurrent clicks from applying twice.

Rescheduling changes the same task, resets its reminder state and preserves project/recurrence, including selected weekdays and fixed month-day rules. Cancelling stops recurrence and cancels the task with Undo support. The conversation's existing finalization hook refreshes reminder-owner alarms. Existing Calendar synchronization observes the normal task change; no new Google scopes or time-planning feature is introduced. Expired accounts cannot schedule or cancel tasks, but may cancel a pending time draft.

## Deployment and validation

Apply `drizzle/0018_task_schedule_pending.sql` before deploying using the README deployment steps. It adds only a metadata table referencing users/tasks with deletion cascades; there is no task-content storage or destructive schema cleanup. Existing migrations and archived board/business records remain intact. No bindings or secrets change.

The Worker integration tests cover direct/LLM/Help list flows, paging and filters, long names, sharing/privacy, stale and forged controls, duplicate clicks, time presets across midnight/DST, custom times and unrelated messages, voice transcription, invalid dates, concurrent Calendar edits, trial expiry, Undo, cancellation and reminder alarms. Existing reminder and Calendar regression suites remain required.
