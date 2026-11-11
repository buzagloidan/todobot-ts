# Google Calendar integration

Two-way sync uses a secondary calendar named **Todobot**. Google access is limited to `https://www.googleapis.com/auth/calendar.app.created`; the user's primary and unrelated calendars are outside this permission.

## Behaviour

- `/calendar` shows status or a personal, 15-minute connection link. `/calendar connect` reconnects; `/calendar sync` runs a sync now; `/calendar disconnect` removes stored credentials and requests Google token revocation while retaining the user's calendar and events.
- Pending tasks with a scheduled time become 15-minute, transparent calendar events with Google reminders disabled. WhatsApp retains its existing reminder behaviour. Google duration edits are preserved when the bot reschedules an event.
- Titles, times and deletions sync both ways. Completing/cancelling a bot task removes its event; deleting a Google event cancels the task. New ordinary Google events in Todobot become tasks. All-day Google events become tasks without a timed WhatsApp reminder; their dates survive bot renames.
- Only tasks owned by the connected user are exported. Shared/assigned tasks remain in WhatsApp unless their owner connects their own calendar.
- Native bot recurrence continues as separate events for successive task occurrences. Google-created recurring series and instances are not imported in this release.
- Cron admits up to 50 due connections per minute into each user's existing conversation inbox. This preserves ordering with chat messages. Sync normally occurs within a minute; backlogs or provider errors can delay it. Sync pauses when trial/subscription access expires; disconnect remains available.
- Concurrent edits use last-write-wins based on task and Google timestamps, favoring Google on ties. Google writes use `If-Match` etags; incoming edits compare-and-set the task snapshot to avoid overwriting a concurrent API edit. Sync tokens commit only after a successful pass.
- Deterministic Google event IDs and unique import keys prevent duplicate events/tasks after retries or lost responses. An expired Google sync token triggers a full sync. Token revocation requires reconnect; transient errors remain retryable and visible through `/calendar`.

## OAuth and storage

The connection page requires an explicit POST before redirecting to Google. Origin checks, a single-use state record, PKCE, and a Secure/HttpOnly/SameSite cookie bind the callback to the WhatsApp account's connection link and browser. The callback exchanges the code and admits connection setup into the same conversation inbox. Tokens, calendar IDs, sync tokens and event snapshots are Fernet-encrypted in D1. Logs exclude codes, token values and calendar content. Account deletion cascades credentials, pending grants and event mappings; events already stored in Google remain under the user's control.

## Activation

Create a dedicated Google Cloud project under your own account.

1. Apply the new-install SQLite migrations using the README instructions before enabling Calendar. For existing installations, reconcile the additive Calendar migration against the applied schema first. CI uses only local emulated storage and has no production D1 access.
2. Enable Google Calendar API in the project and prepare a **Web application** OAuth client for Todobot. Authorized redirect URI: `https://bot.example.com/calendar/callback`. Use only the app-created scope. OAuth branding links: homepage `https://bot.example.com/`, privacy `https://bot.example.com/privacy`, terms `https://bot.example.com/terms`; authorized parent domain `example.com`.
3. Store `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as encrypted Worker secrets. Never put them in Git or command arguments. Confirm the bot's Gemini key uses paid-service data handling before setting `GEMINI_CALENDAR_DATA_ALLOWED = "true"`: imported Calendar tasks can enter AI context, and Google Workspace data must not be used to train/improve generalized models.
4. Set `GOOGLE_CALENDAR_ENABLED = "true"` and deploy using the README deployment steps. Until the credentials and both flags are ready, connection routes fail closed and `/calendar` reports setup in progress. Disconnect works independently of the activation flags.
5. Google testing-mode OAuth grants may expire after seven days and are limited to test users. Production release may require Google's branding verification; do not claim customer availability until audience/scopes/redirects are checked and a live OAuth plus create/edit/delete sync flow succeeds.

Run `npx tsc --noEmit` and `npm test`. The Google API tests use mocks; they do not replace live OAuth/API verification. Provider references: [OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), [incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync), [Google Workspace data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy), [Gemini data handling](https://ai.google.dev/gemini-api/terms).
