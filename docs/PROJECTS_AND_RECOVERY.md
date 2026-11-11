# Projects, checklists and overdue recovery

## User flows

- `צור צ׳קליסט למעבר דירה` generates practical checklist items in a named project. Explicitly supplied items are used instead of generated suggestions. Creating another checklist with an existing name adds items without replacing earlier tasks.
- `הוסף לשלוח הצעה לפרויקט עבודה` adds a regular task to that project, creating the project if needed. A time is set only when explicitly requested.
- `#` (or `/projects`) lists projects by name; `# עבודה` (or `/project עבודה`) shows pending items and completion progress. Selecting an item shows its full title before offering the existing task buttons. Completed items remain in the project and count toward progress.
- `סיימתי לשלוח הצעה בפרויקט עבודה` selects only that project's matching task. `העבר לשלוח הצעה לפרויקט בית` moves an owned task; `/undo` restores its former group. If the same task name matches multiple tasks, the bot asks for the project instead of choosing arbitrarily.
- `/recover` or a natural request to review overdue tasks presents the oldest unfinished overdue task with **keep**, **reschedule** and **cancel** buttons. `/recover list` offers a paged name picker. `/recover all` also includes previously kept tasks.
- Keep leaves the task, due time and reminder state intact. It records that this actor reviewed this exact task revision. A later task change makes it eligible for review again.
- Reschedule offers tomorrow at 09:00, one week later at 09:00, or a custom time in Jerusalem. It changes the existing task, clears `reminder_sent` and re-arms its timer through the conversation hook. Custom-time selection expires after 15 minutes, accepts a time-only reply, and never chooses a different task from the model's title. `/recover cancel` abandons that prompt.
- Cancel marks the task cancelled and stops its recurrence. It is reversible through `/undo` for 10 minutes, subject to the existing revision/permission safeguards.

Recovery is on demand. The agenda links to it when there are overdue tasks; it does not introduce a new unsolicited-message schedule or a new WhatsApp template. Calendar time planning remains deferred and Google scopes are unchanged.

## Storage and permissions

Migration `drizzle/0017_projects_and_recovery.sql` adds `project`, optional `task.project_id`, `task_recovery` and `recovery_pending`, and extends the task revision trigger to include project membership. Existing tasks remain ungrouped. Apply it before deploying using the README deployment steps.

Project names are Fernet encrypted, with an owner-specific HMAC name lookup for normalized-name uniqueness. Checklist creation inserts its tasks and Undo records in one D1 batch. Undo of checklist creation cancels its new items; it retains the project container, which may also hold older items. Moving tasks records their previous project in the encrypted Undo snapshot. Older snapshots without this field remain supported.

Partners see shared project tasks using existing task permissions. A tagged friend sees only their assigned items, even if those items belong to a larger project; private sibling tasks and total counts are not exposed. Moving a shared task into another owner's private project is refused. Interactive controls bind the actor, selected task/project and expiry through HMAC, and task mutations recheck revision and current sharing permissions atomically.

Recurring successors keep their project in both ordinary completion and durable reminder delivery. Calendar imports remain ungrouped unless assigned by the user; later Calendar edits preserve task project membership. Project metadata alone does not rewrite Google event titles or request broader Google access.

New model actions (`project_create`, `project_show`, `project_list`, `recover`) are validated before any actions execute. Checklist items are bounded to 50 per creation request and 500 characters each; project names to 120. These limits bound a single model response and D1 transaction, not total tasks or reminder throughput. The output budget accommodates checklist JSON while keeping the existing Gemini model.

## Validation

Run TypeScript, the full Vitest Worker suite, billing/Calendar configuration checks and a Worker dry run. Tests cover encrypted lookups, checklist Undo and progress, 50-item batches, sharing/privacy, signed controls, duplicate names, moves, recurrence, keep/cancel/reschedule, timer rearming, stale/expired/revoked controls, custom-time isolation and direct webhook commands.
