# Conversation processing

WhatsApp messages are admitted to a SQLite Durable Object inbox named by the normalized phone's SHA-256 hash. The webhook returns 200 only after admission; it handles every message in a provider batch. Existing Cloudflare Queue deliveries enter the same inbox.

The inbox reserves a sequence before encryption, then stores a Fernet-encrypted payload. A single alarm processes messages in admission order, including commands, reactions, voice messages and signed feature controls. Separate phones use separate objects and can proceed concurrently. Ordering follows server admission, not WhatsApp timestamps; different people sharing a task list can still act concurrently.

Completed jobs immediately discard their payload. Only message IDs and processing timestamps remain for seven days to deduplicate provider retries. An alarm clears expired metadata and stops once the inbox is empty. If execution was interrupted after starting, the alarm does not repeat potentially completed changes: it reports an uncertain outcome and advises checking the task list before resending. This avoids automatic duplicate mutations; it is not an exactly-once transaction spanning D1 and WhatsApp.

## Context

Each text request reads the latest 24 user/assistant history entries from D1, ordered by message time and row ID. Up to 1000 characters per entry and 16,000 content characters total are passed to the model. The most recent entries take precedence. History no longer reads the eventually consistent KV cache, so saved commands and corrections are available to the next message.

## Task output

The existing model and prompt remain in use. Gemini uses JSON mode with the previously working request format. The complete action batch is validated against the application schema before execution: supported actions, field types, valid calendar dates/times, recurrence requirements, update requirements, projects and checklist limits. An invalid batch performs no actions and produces a retry/clarification message. Malformed JSON never supplies an extracted success reply.

Task confirmations come from executor results. A missing task or unsupported operation produces an explicit failure instead of falling back to the model's success text. Mixed batches show each actual result. Model text remains available for conversation and clarification, with a guard against common unsupported success claims when no actions were returned. Task lookup by name is unchanged; users do not need internal IDs.

Run `npm test` and `npx tsc --noEmit`. The regression tests cover overlapping messages, independent users, persistent deduplication, interrupted alarms, provider batches, malformed output, failed lookup, partial execution and longer fresh history. Deploy using the README deployment steps; `conversation-v1` creates the SQLite Durable Object class without modifying the D1 schema.
