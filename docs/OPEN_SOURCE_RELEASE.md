# Publication and hosted-service shutdown

## Release provenance

This public repository starts from a reviewed source snapshot with a new Git history. The former hosted deployment's operational repository and history are kept private. No provider credentials, production data or original deployment identifiers are included. The source is MIT licensed; provider services retain their own terms and charges.

## Before future releases

- Confirm ownership/permission for contributed code and separately added assets. Direct runtime dependencies declare Apache-2.0 (Drizzle ORM) and MIT (Hono); they retain their own licenses.
- Run the contributor checks and a secret scan before pushing. To scan every reachable branch/tag, use `gitleaks git --config .gitleaks.toml --log-opts="--all" --redact`. A clean scanner result is not proof that sensitive content is absent.
- Revoke exposed credentials immediately. Removing a file in a later commit does not erase old commits, branches, pull-request diffs or Actions logs/artifacts. Coordinate any required history cleanup with existing clones.
- Keep secret scanning/push protection, private vulnerability reporting and dependency alerts enabled where available. Review issues, PRs, releases, attachments and workflow artifacts for private data.
- Never attach production D1 exports, KV data, message logs, OAuth tokens, contact lists or backups. CI checks source and local emulated services; it never deploys.

## Shutdown order for the service owner

1. Notify existing users of the shutdown and offer any intended export/deletion window **before** disabling their access. Prepare a private backup only if needed; keep the encryption key separately. No user notifications are sent by this repository review.
2. Disable new checkouts and cancel every active recurring subscription in Lemon Squeezy. Verify there are no future renewals, including subscriptions the bot never recorded because a webhook was missed. Decide refunds/remaining paid access with customers. Worker shutdown alone does not stop provider billing. Remove obsolete billing webhooks after reconciliation. Do not close an entire store if it also serves other products.
3. Disconnect/revoke Google Calendar refresh/access tokens while you can still decrypt them, then disable the bot's OAuth client/consent configuration. Rotating only an OAuth client secret is not equivalent to revoking user grants. User-created Calendar events may remain in their accounts.
4. Unsubscribe the Meta app's webhooks and revoke the bot's access token/app secret as appropriate. Remove the retired number's public signup/referral links and decide whether to retain the number. Do not delete unrelated WhatsApp assets.
5. In Cloudflare, remove the Worker routes/custom domains/preview access, cron triggers, Queue producers/consumers and dead-letter queues, and stop Durable Object alarms. Setting `REMINDER_SCHEDULER_ENABLED=false` alone does not stop already armed alarms or queued sends. Delete dedicated resources only after backup/export decisions; removing the Worker does not by itself settle your D1/KV/Queue/DO data-retention choices. Preserve unrelated account resources/DNS.
6. Revoke dedicated Gemini/Google API, Resend, PostHog, Cloudflare deployment and notification credentials. Check provider usage/billing and delete or retain data/projects explicitly. The original code's Redis-named client uses Cloudflare KV, not an external Redis service. Historical Railway/Neon and retired business R2 resources may exist outside the current deployment; check them manually if previously used.
7. Remove obsolete GitHub/Cloudflare deploy hooks, clean operational logs/artifacts and backups according to your retention choices, then verify the endpoint is offline, billing renewals are stopped, and provider activity has ceased.

Do not delete entire shared Cloudflare, Google, Meta or billing accounts just to retire this bot. Verify the dedicated resource scope in each dashboard.

References: [GitHub sensitive-history removal](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository), [Cloudflare cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Google OAuth revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke), [Lemon Squeezy cancellation](https://docs.lemonsqueezy.com/api/subscriptions/cancel-subscription).
