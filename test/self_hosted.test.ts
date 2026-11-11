/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import worker from '../src/index.ts';
import type { Env } from '../src/types.ts';
import { buildDb } from '../src/db/client.ts';
import { addTask, getUserById } from '../src/db/queries.ts';
import { hasAccess, billingReply, cancelSubscriptions } from '../src/services/billing.ts';
import { nextReminderAt, dispatchOwnerReminders, deliverReminderJob } from '../src/services/reminder_dispatch.ts';
import { guideText, HELP_TEXT, WELCOME_TEXT } from '../src/services/guide.ts';
import { shareContent, maybeOfferShare } from '../src/services/sharing.ts';
import { issueOrRotateToken } from '../src/api/token.ts';
import { sendFeedbackEmail } from '../src/services/email.ts';
import { applySchema, clearData, createTestUser, TEST_ENC_KEY, TEST_PHONE, makeMockFetch } from './helpers.ts';
const local: Env = { ...env, BILLING_ENABLED: 'false', LEMONSQUEEZY_API_KEY: undefined, BOT_WHATSAPP_NUMBER: '', POSTHOG_API_KEY: '' };
let userId: number;
let fetchMock: ReturnType<typeof vi.fn>;
beforeAll(applySchema);
beforeEach(async () => {
  await clearData(); userId = await createTestUser();
  await env.DB.prepare('DELETE FROM billing_account').run();
  fetchMock = vi.fn(makeMockFetch()); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const request = (req: Request, bindings = local) => worker.fetch(req, bindings, createExecutionContext());

it('sends a due reminder and API message without a trial, subscription, or billing key', async () => {
  const db = buildDb(local), user = (await getUserById(db, userId))!;
  expect(await hasAccess(local, user)).toBe(true);
  expect(await hasAccess({ ...local, BILLING_ENABLED: 'true' }, user)).toBe(false);
  const task = await addTask(db, TEST_ENC_KEY, userId, 'Self-hosted reminder', new Date(Date.now() - 1000));
  expect(await nextReminderAt(local, userId)).toBe(+task.due_date!);
  const jobs: string[] = [];
  expect(await dispatchOwnerReminders(local, userId, { sendBatch: async batch => { jobs.push(...batch.map(m => m.body.jobId)); } })).toBe(1);
  await deliverReminderJob(local, jobs[0]);
  expect(await env.DB.prepare('SELECT reminder_sent FROM task WHERE id=?').bind(task.id).first('reminder_sent')).toBe(1);
  const token = await issueOrRotateToken(db, local, userId);
  const response = await request(new Request(`https://bot.example.com/api/v1/${token}`, { method: 'POST', body: 'Self-hosted API message' }));
  expect(response.status).toBe(200);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('lemonsqueezy'))).toBe(false);
});

it('omits old pricing and disables unconfigured referral and feedback destinations', async () => {
  expect(guideText(local, HELP_TEXT)).not.toContain('20 ₪');
  expect(guideText(local, WELCOME_TEXT)).not.toContain('20 ₪');
  expect(await billingReply(local, (await getUserById(buildDb(local), userId))!)).not.toContain('20 ₪');
  for (const path of ['/', '/terms']) expect(await (await request(new Request(`https://bot.example.com${path}`))).text()).not.toContain('20 ₪');
  expect(shareContent(local)).toBeNull();
  await maybeOfferShare(local, (await getUserById(buildDb(local), userId))!, TEST_PHONE, { taskId: 1 });
  await expect(sendFeedbackEmail({ ...local, RESEND_API_KEY: undefined }, TEST_PHONE, 'private feedback')).rejects.toThrow('not configured');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('still cancels existing provider subscriptions after switching billing off', async () => {
  const user = (await getUserById(buildDb(local), userId))!;
  await env.DB.prepare('INSERT INTO billing_account VALUES (?,?,NULL)').bind(user.phone_number_hash, 'existing-billing').run();
  await env.DB.prepare("INSERT INTO billing_subscription(id,billing_key,status,renews_at,updated_at) VALUES ('existing-sub','existing-billing','active',?,'2026-01-01T00:00:00Z')").bind(Math.floor(Date.now()/1000)+86400).run();
  await expect(cancelSubscriptions(local, user)).rejects.toThrow('Billing API key missing');
  expect(await env.DB.prepare('SELECT status FROM billing_subscription').first('status')).toBe('active');
});

it('rejects missing webhook verification configuration, malformed signatures, and oversized bodies', async () => {
  expect((await request(new Request('https://bot.example.com/webhook?hub.challenge=hello'), { ...local, VERIFY_TOKEN: '' })).status).toBe(403);
  expect((await request(new Request('https://bot.example.com/webhook', { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=zz' }, body: '{}' }))).status).toBe(403);
  expect((await request(new Request('https://bot.example.com/webhook', { method: 'POST', body: 'x'.repeat(256*1024+1) }))).status).toBe(413);
  expect((await request(new Request('https://bot.example.com/api/v1/tdo_test_token_long', { method: 'POST', body: 'x'.repeat(16*1024+1) }))).status).toBe(413);
});
