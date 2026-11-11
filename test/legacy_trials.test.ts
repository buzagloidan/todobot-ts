/// <reference types="@cloudflare/vitest-plugin" />
import { beforeAll,beforeEach,afterEach,it,expect,vi } from 'vitest';
import { env,SELF } from 'cloudflare:test';
import migration from '../drizzle/0015_existing_user_trials.sql?raw';
import { buildDb } from '../src/db/client.ts';
import { addTask,getUserById,getDueTasksForReminders } from '../src/db/queries.ts';
import { getBillingAccount,hasAccess } from '../src/services/billing.ts';
import { applySchema,clearData,createTestUser,TEST_PHONE,TEST_PHONE_2,TEST_ENC_KEY,makeMockFetch,makeSignedWebhookRequest,drainConversation } from './helpers.ts';
const LAUNCH=Date.parse('2026-10-12T08:30:30Z')/1000;
const DEADLINE=LAUNCH+7*86400;
let db:ReturnType<typeof buildDb>,fetchMock:ReturnType<typeof vi.fn>;
beforeAll(async()=>{await applySchema();db=buildDb(env);});
beforeEach(async()=>{
  await clearData();vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-13T06:00:00Z'));
  fetchMock=vi.fn(makeMockFetch());vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const migrate=()=>env.DB.prepare(migration).run();
async function legacy(phone=TEST_PHONE,kind:'missing'|'null'|'recorded'='missing') {
  const id=await createTestUser(phone);const user=(await getUserById(db,id))!;
  await env.DB.prepare('UPDATE user SET created_at=? WHERE id=?').bind(LAUNCH-86400,id).run();
  if(kind==='missing')await env.DB.prepare('DELETE FROM billing_account WHERE phone_hash=?').bind(user.phone_number_hash).run();
  if(kind==='null')await env.DB.prepare('UPDATE billing_account SET trial_ends_at=NULL WHERE phone_hash=?').bind(user.phone_number_hash).run();
  return user;
}
it('backfills a missing trial from launch and unblocks existing reminders without a new message',async()=>{
  const user=await legacy();const task=await addTask(db,TEST_ENC_KEY,user.id,'Existing reminder',new Date(Date.now()-60000));
  expect(await getDueTasksForReminders(db,TEST_ENC_KEY)).toHaveLength(0);
  await migrate();const account=await getBillingAccount(env,user);
  expect(account.trial_ends_at).toBe(DEADLINE);expect(account.billing_key).toMatch(/^[a-f0-9]{32}$/);
  expect(await hasAccess(env,user)).toBe(true);
  expect((await getDueTasksForReminders(db,TEST_ENC_KEY)).map(r=>r.task.id)).toEqual([task.id]);
});
it('preserves an existing billing key and subscription while filling only a null trial',async()=>{
  const user=await legacy(TEST_PHONE,'null');const account=await getBillingAccount(env,user);
  await env.DB.prepare("INSERT INTO billing_subscription (id,billing_key,status,renews_at,updated_at) VALUES ('sub',?,'active',?,'2026-10-13')").bind(account.billing_key,DEADLINE+86400).run();
  await migrate();const after=await getBillingAccount(env,user);
  expect(after.billing_key).toBe(account.billing_key);expect(after.trial_ends_at).toBe(DEADLINE);
  expect((await env.DB.prepare("SELECT billing_key FROM billing_subscription WHERE id='sub'").first<{billing_key:string}>())?.billing_key).toBe(account.billing_key);
});
it('never overwrites recorded trials, including an intentionally ended test trial',async()=>{
  const active=await legacy(TEST_PHONE,'recorded');const oldActive=await getBillingAccount(env,active);
  const ended=await legacy(TEST_PHONE_2,'recorded');await env.DB.prepare('UPDATE billing_account SET trial_ends_at=1 WHERE phone_hash=?').bind(ended.phone_number_hash).run();
  await migrate();expect((await getBillingAccount(env,active)).trial_ends_at).toBe(oldActive.trial_ends_at);
  expect((await getBillingAccount(env,ended)).trial_ends_at).toBe(1);expect(await hasAccess(env,ended)).toBe(false);
});
it('is idempotent and cannot restart the rollout trial after its fixed deadline',async()=>{
  const user=await legacy();await migrate();const first=await getBillingAccount(env,user);
  vi.spyOn(Date,'now').mockReturnValue((DEADLINE+1)*1000);
  await migrate();expect(await getBillingAccount(env,user)).toMatchObject(first);expect(await hasAccess(env,user)).toBe(false);
});
it('leaves new accounts on their normal first-message trial policy',async()=>{
  const id=await createTestUser();const user=(await getUserById(db,id))!;
  await env.DB.prepare('DELETE FROM billing_account WHERE phone_hash=?').bind(user.phone_number_hash).run();
  await migrate();expect(await env.DB.prepare('SELECT phone_hash FROM billing_account WHERE phone_hash=?').bind(user.phone_number_hash).first()).toBeNull();
  const account=await getBillingAccount(env,user,true);
  expect(account.trial_ends_at).toBe(Math.floor(Date.now()/1000)+7*86400);
});
it('shows the pricing notice once on the next interaction after backfill',async()=>{
  const user=await legacy();await migrate();const account=await getBillingAccount(env,user);await env.CACHE.delete(`trial_notice:${account.billing_key}`);
  await SELF.fetch(await makeSignedWebhookRequest('/help'));await drainConversation();
  const textBodies=()=>fetchMock.mock.calls.filter(([url])=>String(url).includes('graph.facebook.com')).map(([,init])=>JSON.parse(init.body).text?.body).filter(Boolean);
  expect(textBodies().some(body=>body.startsWith('🎁 הניסיון שלך פעיל'))).toBe(true);
  fetchMock.mockClear();await SELF.fetch(await makeSignedWebhookRequest('/help'));await drainConversation();
  expect(textBodies().some(body=>body.startsWith('🎁 הניסיון שלך פעיל'))).toBe(false);
});
