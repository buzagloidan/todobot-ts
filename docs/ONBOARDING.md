# Focused help and onboarding

The short `/help` guide leads with a natural-language reminder example, Google Calendar, `?` for tasks, `#` for projects/checklists, and completing or postponing through task buttons. Three signed buttons open Calendar connection, the clickable task list and projects directly. `/help more` contains less-used task shortcuts, sharing, account and developer tools. Both guides remain available after trial expiry. Pricing stays seven free days without a card, then ₪20/month; terms and privacy remain accessible.

New users receive one concise welcome. A greeting does not invoke Gemini or send a second introduction. The user can immediately create their own task in text or voice, or explicitly select a one-minute example reminder. There is no setup questionnaire or mandatory Calendar connection. Legacy `agree_btn` replies open one short start guide.

## Reminder demonstration

The demo button is HMAC-signed for its actor and expiry. Clicking it requires trial or paid access. A single atomic D1 batch consumes the button, creates the encrypted task and records its Undo snapshot. A retry of the same button cannot create another task, including concurrent delivery. Failed transactions do not consume the button. It uses the ordinary task controls, persistent reminder scheduler, Calendar sync and Undo lifecycle. Opening help or receiving a welcome never creates a demo task automatically.

## Contextual discovery and measurement

Successful task creation is checked through the actual Undo change records, not the model's requested action count. This includes natural-language, voice and quick-add tasks. The first created task records activation. After a timed task, offer Calendar if it is not connected. After at least three tasks, offer projects if the user has not created one. Each feature is offered once with a one-year cache lifetime, with at most one discovery message per day. A five-minute welcome cooldown avoids an immediate extra introduction. Discovery messages follow user activity; there is no new scheduled campaign or WhatsApp template.

Analytics record `guide_shown`, `guide_clicked`, `first_task_created`, `feature_discovery_shown` and `calendar_connected`, using the existing pseudonymous user ID, counts, surfaces and feature flags. Task text, phone numbers, OAuth codes and private connection links are excluded. Analytics failures cannot block task handling and use the conversation's `waitUntil` when available.

## Retired features

Boards and business mode have no active handlers, model actions, prompt context, UI, queries, PDF renderer or bindings. `#` and `# <name>` now select projects; `/projects` and `/project <name>` remain aliases. Old business setup columns and cache flags cannot intercept normal task messages or completion reactions. Retired slash commands direct users to help.

Previously stored board/business records and document files are preserved, without a runtime interface. Historical migrations remain intact. Their existing foreign-key cascades still apply to account deletion. The browser and business R2 bindings, plus the Puppeteer dependency, are removed from the Worker; the bucket itself is not deleted. No destructive database migration is part of this change.

Validation covers provider message/button limits, signed controls, transaction rollback, concurrent duplicate clicks, reminder alarms, Undo, trial expiry, actual activation, discovery frequency, existing features and legacy session behavior.
