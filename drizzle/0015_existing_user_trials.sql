-- Premium first became live on 2026-10-12 at about 08:30:30 UTC.
-- Existing users must keep reminder access during the seven-day rollout trial,
-- even if they have not sent another message since the release.
-- Fill only missing/unstarted trials; retain billing keys, subscriptions and
-- every recorded expiry (including the owner's intentionally ended test trial).
-- A fixed deadline makes reruns safe and cannot restart an expired trial.
INSERT INTO billing_account (phone_hash, billing_key, trial_ends_at)
SELECT u.phone_number_hash, lower(hex(randomblob(16))), unixepoch('2026-10-19 08:30:30')
FROM user u LEFT JOIN billing_account b ON b.phone_hash = u.phone_number_hash
WHERE u.created_at <= unixepoch('2026-10-12 08:30:30')
  AND (b.phone_hash IS NULL OR b.trial_ends_at IS NULL)
ON CONFLICT(phone_hash) DO UPDATE SET trial_ends_at = excluded.trial_ends_at
WHERE billing_account.trial_ends_at IS NULL;
