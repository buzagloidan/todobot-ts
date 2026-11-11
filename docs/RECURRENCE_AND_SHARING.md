# Flexible recurring reminders and optional sharing

## Recurrence

Natural-language reminders may repeat on specific weekdays (`כל ראשון ורביעי ב־18:00`), workdays (`כל יום עבודה ב־09:00`), or a fixed day of the month (`ביום הראשון בכל חודש ב־09:00`). Workdays mean Sunday–Thursday, matching the bot's Israeli locale; holidays are not calculated. An explicit Monday–Friday request remains possible through selected weekdays. The user must provide a reminder time, or the bot asks for one.

The existing text `task.recurrence` column stores backwards-compatible values:

- `daily`, `weekly`, `monthly`: legacy rules.
- `weekdays`: Sunday–Thursday.
- `weekly:0,3`: selected weekdays, where Sunday is 0 and Saturday is 6. Values are unique and normalized to ascending order.
- `monthly:1`: a fixed calendar month day from 1 through 31.

The model schema validates these strings before executing any actions. An executor verifies the initial occurrence belongs to the chosen schedule and is in the future. A multi-day schedule creates one task with one recurrence rule, rather than several independent task chains. Confirmations and task details display Hebrew recurrence labels.

The same `recurrence.ts` engine handles manual completion and queued reminder delivery. It preserves Jerusalem wall time across daylight-saving changes, selects the first autumn-overlap occurrence, and skips nonexistent spring times. Month days unavailable in a particular month are skipped rather than rolled forward (for example, January 31 → March 31). Dates 29–31 are labelled as applying only in months where that date exists. Old monthly rules derive their day from the current due date.

Missed occurrences advance directly to the next future matching date. There is no replay burst of old reminders. Manual completion ahead of time advances beyond the scheduled occurrence. Completing by name or in bulk also retains future occurrences. Delivery continues to atomically finish a recurring occurrence and create one successor with its existing project and assignees. Undo includes manually generated successors. Cancellation and stop-recurrence remain supported.

Google Calendar still receives one event per task occurrence. No Google recurring series import or new scopes are added. Rescheduling preserves explicit weekday/month-day selection and uses the revised occurrence's local clock for future occurrences.

## Sharing

Set `BOT_WHATSAPP_NUMBER` to your own bot number (international digits only). `/share` prepares an introduction with that deployment’s link. With no number configured, sharing offers are disabled. No former hosted-service number or pricing is included.

A CTA URL opens `https://wa.me/?text=...` with that public intro. The user's own WhatsApp client chooses a recipient and requires the user to confirm sending. The bot does not request contacts, choose recipients, or send referral messages to other phone numbers. If Meta explicitly rejects CTA support, a plain ready-to-forward message and share link are supplied instead. Uncertain transport failures are not resent automatically.

An optional one-time offer follows a human acknowledgment/completion of a task for which that actor has an accepted reminder delivery. Provider failure receipts do not qualify, and API acceptance alone never starts a sharing campaign. Offers respect the existing discovery cooldown and set it for another day. Claiming an offer in D1 before sending prevents duplicate growth messages on concurrent hooks or crashes. Declining suppresses future automatic offers; `/share` remains available. Explicitly opening a draft also suppresses later offers. Expired accounts can still access this public information.

Migration `0019_user_share_offer.sql` stores only user ID, offered time and offered/opened/dismissed state, with account-deletion cascade. Reminder/task content is absent. Analytics track `share_offer_shown`, `share_draft_opened` and `share_offer_dismissed` under existing pseudonymous user IDs; an opened draft is not reported as a sent invitation or successful referral.

## Deployment and checks

Apply additive migration 0019 before merging the release for manual deployment. Recurrence needs no destructive task migration or new bindings/secrets. Test selected days, month ends, leap years, DST gaps/overlaps, missed occurrences, manual/automatic completion, Undo and assignment/project inheritance. Sharing tests cover its success milestone, one-time concurrency guard, cooldown, decline/open controls, billing expiry, provider fallback, privacy and user-controlled recipient selection.
