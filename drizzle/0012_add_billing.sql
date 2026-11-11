-- A trial belongs to a phone hash, rather than a deletable user id.
-- Retain this minimal ledger on account deletion to prevent repeated free trials.
CREATE TABLE IF NOT EXISTS billing_account (
  phone_hash TEXT PRIMARY KEY NOT NULL,
  billing_key TEXT NOT NULL UNIQUE,
  trial_ends_at INTEGER
);
CREATE TABLE IF NOT EXISTS billing_subscription (
  id TEXT PRIMARY KEY NOT NULL,
  billing_key TEXT NOT NULL REFERENCES billing_account(billing_key),
  status TEXT NOT NULL,
  trial_ends_at INTEGER,
  renews_at INTEGER,
  ends_at INTEGER,
  updated_at TEXT NOT NULL,
  last_checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_billing_subscription_account ON billing_subscription(billing_key);
