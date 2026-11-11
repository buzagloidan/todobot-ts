# Optional subscription billing

Self-hosted mode is the default: `BILLING_ENABLED = "false"`. Task management, reminders, sharing and API notifications do not require a subscription. No Lemon Squeezy account is needed. Switching this flag off never cancels subscriptions already created at the provider; operators must cancel them separately.

The original billing implementation remains available for operators who explicitly enable `BILLING_ENABLED = "true"`. It implements one seven-day trial and a fixed **₪20 monthly ILS subscription**. Prices, currency, Hebrew copy and provider validations are coupled; changing only a product price is insufficient.

## Setup

1. Create your own Lemon Squeezy store and published subscription variant: ILS, one-month interval, 2000 agorot, no provider trial, setup fee, usage billing or pay-what-you-want. Verify tax-inclusive pricing and checkout totals in the regions you serve.
2. Set your `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`, and explicit `LEMONSQUEEZY_TEST_MODE`. Use test mode and test credentials while validating; switch to live only after checking your own provider configuration.
3. Set `LEMONSQUEEZY_API_KEY` and a random 32–40 character `LEMONSQUEEZY_WEBHOOK_SECRET` through `wrangler secret put`.
4. Register `https://YOUR_HOST/billing/webhook` with the same signing secret and events: `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_resumed`, `subscription_expired`, `subscription_paused`, `subscription_unpaused`. `scripts/setup-billing-webhook.mjs` is an **explicit live mutation helper**, accepts secrets through environment variables, and refuses disabled/test billing or placeholder hosts. Never run it as an install/CI check.
5. Apply schema using the README instructions and test checkout, webhook signature validation, cancellation and renewal in your own provider account. CI validates configuration shape only.

## Behavior

A user's first incoming message starts the local trial. API sends and background scans do not start/extend trials. Expired accounts retain their tasks but cannot mutate them or receive reminders. Each partner/assignee requires their own access. `active` subscriptions need a future renewal, `on_trial` a future trial end, and `cancelled` a future end date; paused/past-due/unpaid/unknown states block access.

`/billing` refreshes known subscriptions and returns the provider's portal or a validated checkout. Checkout redirects never grant access. Webhooks use HMAC verification, a 64 KiB body limit, store/variant/test-mode filtering and monotonic updates. Custom data uses a random billing key, not a phone number.

`/delete` then `/confirm` cancels known subscriptions before deleting user data. A cancellation failure stops deletion so users retain their billing controls. The minimal phone-hash/trial/subscription ledger survives deletion to prevent a new trial. Provider records have their own retention. Missing subscription-creation webhooks must be resent from the provider; the bot does not match accounts by email or phone.

The archived `drizzle/0015_existing_user_trials.sql` is a date-specific repair for the retired hosted service. It is intentionally excluded from the new-install migration chain.

Provider references: [checkouts](https://docs.lemonsqueezy.com/api/checkouts/create-checkout), [subscriptions](https://docs.lemonsqueezy.com/help/products/subscriptions), [webhook signatures](https://docs.lemonsqueezy.com/guides/developer-guide/webhooks).
