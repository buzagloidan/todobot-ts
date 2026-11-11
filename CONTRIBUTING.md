# Contributing

Use Node.js 24+ and `npm ci`. Run `npm run check`, `npm test`, `npm run db:migrate:local` against a fresh local database, and `npm run build` before opening a pull request. CI runs these checks with fake credentials and never deploys.

Keep secrets, customer data, database exports and production logs out of commits and issue attachments. Copy `.dev.vars.example` or use `scripts/init-dev-vars.mjs`; `.dev.vars` is ignored. External HTTP calls in tests must be mocked.

Add ordered SQLite migrations to `migrations/` for new installations. Keep `drizzle/` as the historical migration archive. Do not regenerate a destructive diff for retired business/board tables or replay initial migrations against an existing database. Update setup docs and regenerate Worker bindings with `npm run types` when adding variables or bindings.

Preserve Jerusalem civil-time behavior, task permission checks, signed controls, encrypted storage, reminder deduplication and user-directed sharing. Changes to these paths should include behavioral regression coverage. Changes to API/provider versions need live verification by the deploying operator.

By submitting a contribution, you agree to license it under this project's MIT license. Report vulnerabilities privately using SECURITY.md, not in public issues.
