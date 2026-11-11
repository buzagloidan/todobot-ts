import { shareCommand,handleShareControl,maybeOfferShare } from "../services/sharing.ts";
import { recurrenceLabel } from "../services/recurrence.ts";
import type { Context } from "hono";
import type { Env } from "../types.ts";
import { buildDb } from "../db/client.ts";
import { checkUserRateLimit, checkDailyMessageLimit } from "../redis/client.ts";
import {
  getOrCreateUser,
  saveMessage,
  getLastReminderMessageId,
  getTaskIdFromMessageId,
  addTask,
  completeTask,
  completeAllPendingTasks,
  completeTaskByDescription,
  getTaskById,
  getUserTasks,
  getAccessibleUserIds,
  getUserByHash,
  getUserById,
  decryptPhone,
  linkPartners,
  unlinkPartners,
  scheduleNextRecurrence,
  snoozeTask,
  deleteUserAndData,
  getFriends,
  getFriendCount,
  getFriendByNickname,
  linkFriends,
  unlinkFriends,
  friendshipExists,
  FRIEND_CAPACITY,
  getAssignedTaskIds,
} from "../db/queries.ts";
import { sendMessage, sendReaction, markRead } from "../services/whatsapp.ts";
import { dispatchQueueMessage } from "../queue/consumer.ts";
import { enqueueConversation } from "../conversation.ts";
import { capture, identify, type AnalyticsWaitUntil, type EventProperties } from "../services/posthog.ts";
import { hashPhone } from "../crypto/hash.ts";
import { TZ } from "../constants.ts";
import type { User } from "../db/schema.ts";
import { sortTasksByDueDate } from "../task_format.ts";
import { sendFeedbackEmail } from "../services/email.ts";
import { issueOrRotateToken, getActiveToken } from "../api/token.ts";
import { calendarCommand, disconnectCalendar } from "../services/google_calendar.ts";
import { billingEnabled, getBillingAccount, hasAccess, billingReply, BILLING_COMMANDS, PUBLIC_COMMANDS, cancelSubscriptions } from "../services/billing.ts";
import { newUndoContext, undoTasks, type UndoContext } from '../services/task_undo.ts';
import { sendTaskReply, handleTaskControl, undoCommands } from '../services/task_controls.ts';
import { agendaCommand, normalizeAgendaCommand, handleAgendaControl } from '../services/agenda.ts';
import { handleReminderStatus } from "../services/reminder_dispatch.ts";
import { verifyControl } from '../services/controls.ts';
import { guideText,sendWelcomeMessage,handleGuideControl,guideCommand,sendGuide,WELCOME_TEXT,afterTaskChanges } from '../services/guide.ts';
import { projectCommand,handleProjectControl } from '../services/projects.ts';
import { taskListCommand,handleTaskBrowser } from '../services/task_browser.ts';
import { handleTaskSchedule,continueTaskSchedule } from '../services/task_schedule.ts';
import { recoveryCommand,handleRecoveryControl } from '../services/recovery.ts';

const THUMBS_UP_EMOJIS = new Set(["👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"]);
const SNOOZE_EMOJI = "😴";
const ROTATE_API_EMOJI = "🗑️";
const DEFAULT_SNOOZE_MINUTES = 15;
const COMPLETE_ALL_COMMANDS = new Set(["-הכל", "-כולן", "-all", "-כל"]);

// ── GET /webhook ──────────────────────────────────────────────────────────────
export async function webhookGet(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (c.env.VERIFY_TOKEN && token === c.env.VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Verification token mismatch", { status: 403 });
}

// ── POST /webhook ─────────────────────────────────────────────────────────────
export async function webhookPost(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawBody = await c.req.text();

  const sig = c.req.header("x-hub-signature-256") ?? "";
  if (!(await verifySignature(rawBody, sig, c.env.APP_SECRET))) {
    console.warn("[WEBHOOK] Signature mismatch — rejecting request");
    return c.json({ error: "Forbidden" }, 403);
  }

  let data: unknown;
  try { data = JSON.parse(rawBody); } catch { return c.json({ status: "ok" }); }

  // Acknowledge only after every message is durably admitted. Provider retries are deduplicated in the inbox.
  const entries = (data as { entry?: { changes?: { value?: { messages?: Record<string, unknown>[]; statuses?: Record<string, unknown>[] } }[] }[] })?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value?.statuses ?? []) await handleReminderStatus(c.env,status);
      for (const message of change.value?.messages ?? []) {
        await enqueueConversation(c.env, { kind: "webhook", message });
      }
    }
  }
  return c.json({ status: "received" });
}


function fmtCompleted(description: string, due_date: Date | null | undefined): string {
  let msg = `🎉 הושלמה: *${description}* ✅`;
  if (due_date) {
    const d = new Date(new Date(due_date).toLocaleString("en-US", { timeZone: TZ }));
    const p = (n: number) => String(n).padStart(2, "0");
    msg += ` ⏰ ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return msg;
}

async function verifySignature(body: string, signature: string, appSecret: string): Promise<boolean> {
  if (!appSecret || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const hexStr = signature.slice(7);
  const sigBytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(body));
}

type TrackEvent = (distinctId: string, event: string, properties?: EventProperties) => Promise<void>;

function createTracker(env: Env, waitUntil?: AnalyticsWaitUntil): TrackEvent {
  return (distinctId: string, event: string, properties: EventProperties = {}) =>
    capture(env, distinctId, event, properties, waitUntil ? { waitUntil } : {});
}

export async function processWebhookMessage(message: Record<string, unknown>, env: Env, waitUntil?: AnalyticsWaitUntil): Promise<void> {
  try {
    const track = createTracker(env, waitUntil);
    const phone = message.from as string;
    if (!phone) return;

    const db = buildDb(env);

    const user = await getOrCreateUser(db, phone, env.ENCRYPTION_KEY);

    const billingAccount = await getBillingAccount(env, user, billingEnabled(env));
    const billingText = message.type === "text"
      ? normalizeAgendaCommand((((message.text as Record<string, unknown>)?.body as string) ?? "")) : "";
    const interactive = message.interactive as Record<string, unknown> | undefined;
    const controlPayload = ((interactive?.button_reply as Record<string,unknown>)?.id ?? (interactive?.list_reply as Record<string,unknown>)?.id ??
      (message.button as Record<string,unknown> | undefined)?.payload) as string | undefined;
    // Stop notifications and undo a recent paid action even when access has just expired.
    if(controlPayload?.startsWith('td:')) {
      const control=await verifyControl(env,controlPayload,user.id);
      if(control?.kind==='share' && await handleShareControl(env,user,phone,controlPayload,waitUntil))return;
      if(control?.kind==='guide' && ['help','more','start'].includes(control.values[1]) && await handleGuideControl(env,user,phone,controlPayload,waitUntil))return;
      if(control?.kind==='timecancel' && await handleTaskSchedule(env,user,phone,controlPayload))return;
      if(control?.kind==='undo' && await handleTaskControl(env,user,phone,controlPayload))return;
      if(control?.kind==='agenda' && control.values[2]==='off' && await handleAgendaControl(env,user,phone,controlPayload))return;
    }
    if (BILLING_COMMANDS.has(billingText)) {
      await sendMessage(env, phone, await billingReply(env, user));
      return;
    }
    if (!PUBLIC_COMMANDS.has(billingText) && !(await hasAccess(env, user))) {
      await sendMessage(env, phone, await billingReply(env, user));
      return;
    }

    // Welcome new users — created_at within last 60s means genuinely new.
    // KV key prevents double-send if two messages arrive simultaneously.
    const isNewUser = Date.now() - new Date(user.created_at).getTime() < 60_000;
    if (billingEnabled(env) && !isNewUser && billingAccount.trial_ends_at !== null && billingAccount.trial_ends_at > Math.floor(Date.now() / 1000)) {
      const noticeKey = `trial_notice:${billingAccount.billing_key}`;
      if (!(await env.CACHE.get(noticeKey))) {
        await env.CACHE.put(noticeKey, "1", { expirationTtl: 7 * 86400 });
        await sendMessage(env, phone, await billingReply(env, user));
      }
    }
    let welcomeSent=false;
    if (isNewUser) {
      const welcomedKey = `welcomed:${user.id}`;
      const alreadyWelcomed = await env.CACHE.get(welcomedKey);
      if (!alreadyWelcomed) {
        const welcomeMsgId = await sendWelcomeMessage(env, phone,user.id).catch(() => null);
        welcomeSent=!!welcomeMsgId;
        if(welcomeMsgId)await Promise.all([
          env.CACHE.put(welcomedKey,'1',{expirationTtl:86400*30}),
          env.CACHE.put(`trial_notice:${billingAccount.billing_key}`,'1',{expirationTtl:7*86400}),
          env.CACHE.put(`guide:v2:${user.id}:cooldown`,'1',{expirationTtl:300}),
        ]);
        await saveMessage(db, env.ENCRYPTION_KEY, {
          userId: user.id,
          messageType: "system",
          content: "Welcome message",
          aiResponse: guideText(env, WELCOME_TEXT),
          parsedTasks: null,
          whatsappMessageId: welcomeMsgId,
        });
        identify(env, `user_${user.id}`, { created_at: new Date().toISOString(), platform: "whatsapp" }, { waitUntil }).catch(() => {});
        track(`user_${user.id}`, "user_signed_up").catch(() => {});
      }
    }

    const msgType = message.type as string;
    if(isNewUser && msgType==='text' && /^(?:שלום|היי|הי|hi|hey|hello)[.!\s]*$/iu.test(String((message.text as Record<string,unknown>)?.body??'').trim())){
      if(!welcomeSent)await sendGuide(env,user,phone,'start',waitUntil);
      return;
    }

    if(controlPayload?.startsWith('td:')) {
      if(await handleTaskBrowser(env,user,phone,controlPayload) || await handleTaskSchedule(env,user,phone,controlPayload) || await handleTaskControl(env,user,phone,controlPayload) || await handleAgendaControl(env,user,phone,controlPayload) || await handleProjectControl(env,user,phone,controlPayload) || await handleRecoveryControl(env,user,phone,controlPayload) || await handleGuideControl(env,user,phone,controlPayload,waitUntil))return;
      await sendMessage(env,phone,'הכפתור אינו תקף לחשבון הזה. שלח ? להצגת המשימות.');return;
    }

    // ── Interactive button ────────────────────────────────────────────────────
    if (msgType === "interactive") {
      const interactive = message.interactive as Record<string, unknown>;
      const buttonId = (interactive?.button_reply as Record<string, unknown>)?.id as string;
      if (buttonId === "agree_btn") {
        await sendGuide(env,user,phone,'start',waitUntil);
        track(`user_${user.id}`, "welcome_accepted").catch(() => {});
      }
      return;
    }

    // ── Reaction ──────────────────────────────────────────────────────────────
    if (msgType === "reaction") {
      const reaction = message.reaction as Record<string, unknown>;
      const emoji = (reaction?.emoji as string) ?? "";
      const reactedToMsgId = (reaction?.message_id as string) || undefined;
      const accessible = getAccessibleUserIds(user);
      const assignedIds = await getAssignedTaskIds(db, user.id);
      if (THUMBS_UP_EMOJIS.has(emoji)) {
        await handleThumbsUp(db, env, user.id, phone, accessible, reactedToMsgId, track, assignedIds);
      }
      else if (emoji === SNOOZE_EMOJI) await handleSnoozeReaction(db, env, user.id, phone, accessible, reactedToMsgId, track, assignedIds);
      else if (emoji === ROTATE_API_EMOJI) await handleRotateApiReaction(db, env, user, phone, reactedToMsgId, track);
      return;
    }

    const incomingMsgId = message.id as string | undefined;
    track(`user_${user.id}`, "message_received", { message_type: msgType }).catch(() => {});

    // ── Contact card ──────────────────────────────────────────────────────────
    if (msgType === "contacts") {
      const partnerAwaitingKey = `partner_awaiting_contact:${user.id}`;
      const friendAwaitingKey = `friend_awaiting_contact:${user.id}`;

      const [partnerAwaiting, friendNickname] = await Promise.all([
        env.CACHE.get(partnerAwaitingKey),
        env.CACHE.get(friendAwaitingKey),
      ]);

      if (!partnerAwaiting && !friendNickname) return; // not expecting a contact card

      const contacts = message.contacts as Record<string, unknown>[] | undefined;
      const phones = (contacts?.[0]?.phones as Record<string, unknown>[] | undefined) ?? [];
      let targetPhone = ((phones[0]?.wa_id as string) || (phones[0]?.phone as string) || "").replace(/^\+/, "");
      if (targetPhone.startsWith("0")) targetPhone = "972" + targetPhone.slice(1);

      if (!targetPhone) {
        await sendMessage(env, phone, "😕 לא הצלחתי לקרוא מספר מהאיש קשר. נסה שוב.");
        return;
      }

      if (partnerAwaiting) {
        await env.CACHE.delete(partnerAwaitingKey);
        const reply = await sendPartnerInvite(buildDb(env), env, user, phone, targetPhone, track);
        await sendMessage(env, phone, reply).catch(() => {});
      } else if (friendNickname) {
        await env.CACHE.delete(friendAwaitingKey);
        const reply = await sendFriendInvite(buildDb(env), env, user, phone, targetPhone, friendNickname, track);
        await sendMessage(env, phone, reply).catch(() => {});
      }
      return;
    }

    // ── Text ──────────────────────────────────────────────────────────────────
    if (msgType === "text") {
      const textBody = ((message.text as Record<string, unknown>)?.body as string) ?? "";
      const contextMsgId = ((message.context as Record<string, unknown> | undefined)?.id as string) || undefined;
      const undo = newUndoContext(user.id);

      // Basic commands bypass rate limits entirely
      const basicReply = await handleBasicCommand(db, env, user, PUBLIC_COMMANDS.has(billingText) ? billingText : textBody, phone, contextMsgId, track, undo,waitUntil);
      if (basicReply === "__account_deleted__" || basicReply === '__agenda_handled__' || basicReply==='__handled__') return;
      if (basicReply !== null) {
        const changed=undo.changedTaskIds??[];
        const msgId = await sendTaskReply(env,user.id,phone,basicReply,undo,changed.length===1?changed[0]:undefined).catch(() => null);
        await saveMessage(db, env.ENCRYPTION_KEY, {
          userId: user.id, messageType: "text", content: textBody,
          aiResponse: basicReply, parsedTasks: changed.length===1 ? {tasks:[{task_id:changed[0]}]} : null, whatsappMessageId: msgId,
        });
        if(changed.length){await afterTaskChanges(env,user,phone,undo.groupId,waitUntil).catch(()=>{});await maybeOfferShare(env,user,phone,{groupId:undo.groupId},waitUntil).catch(()=>{});}
        if (msgId && textBody.trim() === "/api") {
          await env.CACHE.put(`api_msg:${user.id}`, msgId, { expirationTtl: 60 * 60 * 24 * 365 });
        }
        return;
      }

      if (THUMBS_UP_EMOJIS.has(textBody.trim())) {
        const assignedIds = await getAssignedTaskIds(db, user.id);
        await handleThumbsUp(db, env, user.id, phone, getAccessibleUserIds(user), undefined, track, assignedIds);
        return;
      }

      // Rate limits only apply to LLM requests
      const rateResult = await checkUserRateLimit(env.CACHE, user.id);
      if (!rateResult.allowed) {
        track(`user_${user.id}`, "rate_limit_hit", { limit_type: "per_minute" }).catch(() => {});
        await sendMessage(env, phone, rateResult.message ?? "יותר מדי הודעות");
        return;
      }
      const dailyResult = await checkDailyMessageLimit(env.CACHE, user.id);
      if (!dailyResult.allowed) {
        track(`user_${user.id}`, "rate_limit_hit", { limit_type: "daily" }).catch(() => {});
        await sendMessage(env, phone, dailyResult.message ?? "הגעת למגבלה היומית");
        return;
      }
      await Promise.all([
        incomingMsgId
          ? sendReaction(env, phone, incomingMsgId, "👀").catch((e) => console.error("[REACTION] failed:", e))
          : Promise.resolve(),
        incomingMsgId
          ? markRead(env, incomingMsgId).catch((e) => console.error("[MARK_READ] failed:", e))
          : Promise.resolve(),
        dispatchQueueMessage({ type: "text_processing", userId: user.id, phone, text: textBody, incomingMsgId, quotedMsgId: contextMsgId, enqueuedAt: Date.now() }, env,waitUntil),
      ]);
      console.log(`[WEBHOOK] Processed text for user ${user.id}, msgId=${incomingMsgId}`);
      return;
    }

    // ── Audio ─────────────────────────────────────────────────────────────────
    if (msgType === "audio") {
      const rateResult = await checkUserRateLimit(env.CACHE, user.id);
      if (!rateResult.allowed) {
        track(`user_${user.id}`, "rate_limit_hit", { limit_type: "per_minute" }).catch(() => {});
        await sendMessage(env, phone, rateResult.message ?? "יותר מדי הודעות");
        return;
      }
      const dailyResult = await checkDailyMessageLimit(env.CACHE, user.id);
      if (!dailyResult.allowed) {
        track(`user_${user.id}`, "rate_limit_hit", { limit_type: "daily" }).catch(() => {});
        await sendMessage(env, phone, dailyResult.message ?? "הגעת למגבלה היומית");
        return;
      }
      const audio = message.audio as Record<string, unknown>;
      const audioId = audio?.id as string;
      if (!audioId) return;
      await Promise.all([
        incomingMsgId
          ? sendReaction(env, phone, incomingMsgId, "👀").catch((e) => console.error("[REACTION] failed:", e))
          : Promise.resolve(),
        incomingMsgId
          ? markRead(env, incomingMsgId).catch((e) => console.error("[MARK_READ] failed:", e))
          : Promise.resolve(),
        dispatchQueueMessage({ type: "voice_processing", userId: user.id, phone, audioId, audioMimeType: (audio?.mime_type as string) ?? "audio/ogg", incomingMsgId, enqueuedAt: Date.now() }, env,waitUntil),
      ]);
      console.log(`[WEBHOOK] Processed voice for user ${user.id}, audioId=${audioId}`);
      return;
    }
  } catch (err) {
    console.error("[WEBHOOK] Unhandled error:", err);
    throw err;
  }
}

async function sendPartnerInvite(
  db: ReturnType<typeof buildDb>,
  env: Env,
  user: User,
  senderPhone: string,
  targetPhone: string,
  track: TrackEvent
): Promise<string> {
  const userId = user.id;

  const selfHash = await hashPhone(senderPhone);
  const targetHash = await hashPhone(targetPhone);
  if (targetHash === selfHash) return "😄 אי אפשר להיות שותף של עצמך.";
  if (user.partner_user_id) return "🤝 כבר יש לך שותף. שלח /unpartner קודם.";

  const target = await getUserByHash(db, targetHash);
  if (!target) return "😕 לא מצאתי משתמש עם המספר הזה. בקש ממנו לשלוח הודעה לבוט קודם.";

  const twentyFourHoursAgo = new Date(Date.now() - 86_400_000);
  if (target.last_active < twentyFourHoursAgo) {
    return "😕 חברך לא פעיל בבוט כרגע — בקש ממנו לשלוח לבוט הודעה ואז נסה שוב.";
  }

  if (target.partner_user_id) return "😕 למספר הזה כבר יש שותף.";

  const existingFrom = await env.CACHE.get(`pend_invite_from:${userId}`);
  if (existingFrom) return "📨 יש לך בקשה פתוחה. שלח /cancel להחלפה.";

  await env.CACHE.put(`pend_invite:${target.id}`, JSON.stringify({ from_user_id: userId }), { expirationTtl: 3600 });
  await env.CACHE.put(`pend_invite_from:${userId}`, JSON.stringify({ to_user_id: target.id }), { expirationTtl: 3600 });

  const myLast4 = senderPhone.slice(-4);
  const decryptedTargetPhone = await decryptPhone(target, env.ENCRYPTION_KEY);
  await sendMessage(env, decryptedTargetPhone,
    `🤝 *...${myLast4}* הזמין אותך לשתף משימות.\n\n• /yes — לאישור\n• /no — לדחייה\n\nאחרי אישור, שניכם תראו ותקבלו תזכורות על כל המשימות.`
  ).catch(() => {});

  track(`user_${userId}`, "partner_invite_sent", { target_user_id: target.id }).catch(() => {});
  return `📨 בקשת שותפות נשלחה ל-*...${targetPhone.slice(-4)}*.\nנחכה שיאשרו עם /yes.`;
}

async function sendFriendInvite(
  db: ReturnType<typeof buildDb>,
  env: Env,
  user: User,
  senderPhone: string,
  targetPhone: string,
  proposedNickname: string,
  track: TrackEvent
): Promise<string> {
  const userId = user.id;

  const selfHash = await hashPhone(senderPhone);
  const targetHash = await hashPhone(targetPhone);
  if (targetHash === selfHash) return "😄 אי אפשר להוסיף את עצמך כחבר.";

  const target = await getUserByHash(db, targetHash);
  if (!target) return "😕 לא מצאתי משתמש עם המספר הזה. בקש ממנו לשלוח הודעה לבוט קודם.";

  const twentyFourHoursAgo = new Date(Date.now() - 86_400_000);
  if (target.last_active < twentyFourHoursAgo) {
    return "😕 חברך לא פעיל בבוט כרגע — בקש ממנו לשלוח לבוט הודעה ואז נסה שוב.";
  }

  if (await friendshipExists(db, userId, target.id)) {
    return `😕 כבר יש לך חבר בשם *${proposedNickname}* (או אותו משתמש תחת שם אחר).`;
  }

  const [senderCount, targetCount] = await Promise.all([
    getFriendCount(db, userId),
    getFriendCount(db, target.id),
  ]);
  if (senderCount >= FRIEND_CAPACITY) {
    track(`user_${userId}`, "friend_capacity_exceeded", { capacity: FRIEND_CAPACITY }).catch(() => {});
    return `😕 הגעת למגבלת ${FRIEND_CAPACITY} חברים. שלח /unfriend <שם> כדי לפנות מקום.`;
  }
  if (targetCount >= FRIEND_CAPACITY) {
    return "😕 לחבר שלך יש כבר רשימת חברים מלאה.";
  }

  // Check for existing invite in either direction
  const existingFrom = await env.CACHE.get(`friend_pend_invite_from:${userId}`);
  if (existingFrom) return "📨 יש לך בקשת חברות פתוחה. שלח /cancel להחלפה.";

  const existingTo = await env.CACHE.get(`friend_pend_invite:${target.id}`);
  if (existingTo) return "😕 לחבר הזה כבר יש בקשה ממתינה. נסה שוב מאוחר יותר.";

  await env.CACHE.put(`friend_pend_invite:${target.id}`, JSON.stringify({ from_user_id: userId, sender_nickname: proposedNickname }), { expirationTtl: 3600 });
  await env.CACHE.put(`friend_pend_invite_from:${userId}`, JSON.stringify({ to_user_id: target.id, sender_nickname: proposedNickname }), { expirationTtl: 3600 });

  const myLast4 = senderPhone.slice(-4);
  const decryptedTargetPhone = await decryptPhone(target, env.ENCRYPTION_KEY);
  await sendMessage(env, decryptedTargetPhone,
    `👥 *...${myLast4}* רוצה להוסיף אותך לחברים, וקוראים לך אצלו *${proposedNickname}*.\n\n• /yes <שם שתקרא לו> — לאישור\n• /no — לדחייה`
  ).catch(() => {});

  track(`user_${userId}`, "friend_invite_sent", { target_user_id: target.id }).catch(() => {});
  return `📨 בקשת חברות נשלחה ל-*...${targetPhone.slice(-4)}* בשם *${proposedNickname}*.\nנחכה שיאשרו עם /yes <השם שלהם לי>.`;
}

type InviteTarget = "partner" | "friend";

function parseInviteTargetArg(arg: string): { target: InviteTarget | null; rest: string } {
  const value = arg.trim();
  const lower = value.toLowerCase();
  const aliases: { target: InviteTarget; values: string[] }[] = [
    { target: "partner", values: ["partner", "שותף", "שותפות"] },
    { target: "friend", values: ["friend", "friends", "חבר", "חברה", "חברים", "חברות"] },
  ];

  for (const { target, values } of aliases) {
    for (const alias of values) {
      if (lower === alias) return { target, rest: "" };
      if (lower.startsWith(`${alias} `)) return { target, rest: value.slice(alias.length).trim() };
    }
  }

  return { target: null, rest: value };
}

async function getInviteState(env: Env, userId: number) {
  const [
    partnerIncoming,
    friendIncoming,
    partnerOutgoing,
    friendOutgoing,
    partnerAwaitingContact,
    friendAwaitingContact,
  ] = await Promise.all([
    env.CACHE.get(`pend_invite:${userId}`, "json") as Promise<{ from_user_id: number } | null>,
    env.CACHE.get(`friend_pend_invite:${userId}`, "json") as Promise<{ from_user_id: number; sender_nickname: string } | null>,
    env.CACHE.get(`pend_invite_from:${userId}`, "json") as Promise<{ to_user_id: number } | null>,
    env.CACHE.get(`friend_pend_invite_from:${userId}`, "json") as Promise<{ to_user_id: number; sender_nickname?: string } | null>,
    env.CACHE.get(`partner_awaiting_contact:${userId}`),
    env.CACHE.get(`friend_awaiting_contact:${userId}`),
  ]);

  return {
    partnerIncoming,
    friendIncoming,
    partnerOutgoing,
    friendOutgoing,
    partnerAwaitingContact,
    friendAwaitingContact,
  };
}

async function cancelPartnerInvite(env: Env, userId: number, track?: TrackEvent): Promise<string> {
  const [awaitingContact, fromData] = await Promise.all([
    env.CACHE.get(`partner_awaiting_contact:${userId}`),
    env.CACHE.get(`pend_invite_from:${userId}`, "json") as Promise<{ to_user_id: number } | null>,
  ]);

  await env.CACHE.delete(`partner_awaiting_contact:${userId}`);
  if (!fromData) {
    return awaitingContact ? "בקשת השותפות בוטלה." : "אין לך בקשת שותפות פתוחה.";
  }

  await Promise.all([
    env.CACHE.delete(`pend_invite:${fromData.to_user_id}`),
    env.CACHE.delete(`pend_invite_from:${userId}`),
  ]);
  track?.(`user_${userId}`, "partner_invite_cancelled", { target_user_id: fromData.to_user_id });
  return "בקשת השותפות בוטלה.";
}

async function cancelFriendInvite(env: Env, userId: number, track?: TrackEvent): Promise<string> {
  const [awaitingContact, fromData] = await Promise.all([
    env.CACHE.get(`friend_awaiting_contact:${userId}`),
    env.CACHE.get(`friend_pend_invite_from:${userId}`, "json") as Promise<{ to_user_id: number } | null>,
  ]);

  await env.CACHE.delete(`friend_awaiting_contact:${userId}`);
  if (!fromData) {
    return awaitingContact ? "בקשת החברות בוטלה." : "אין לך בקשת חברות פתוחה.";
  }

  await Promise.all([
    env.CACHE.delete(`friend_pend_invite:${fromData.to_user_id}`),
    env.CACHE.delete(`friend_pend_invite_from:${userId}`),
  ]);
  track?.(`user_${userId}`, "friend_invite_cancelled", { target_user_id: fromData.to_user_id });
  return "בקשת החברות בוטלה.";
}

async function acceptPartnerInvite(
  db: ReturnType<typeof buildDb>,
  env: Env,
  userId: number,
  track?: TrackEvent
): Promise<string> {
  const inviteData = await env.CACHE.get(`pend_invite:${userId}`, "json") as { from_user_id: number } | null;
  console.log(`[PARTNER] /yes from user ${userId}`);
  if (!inviteData) return "אין לך בקשת שותפות ממתינה.";

  const fromId = inviteData.from_user_id;

  try {
    const fromUser = await getUserById(db, fromId);
    if (!fromUser) {
      await Promise.all([
        env.CACHE.delete(`pend_invite:${userId}`),
        env.CACHE.delete(`pend_invite_from:${fromId}`),
      ]);
      return "המשתמש ששלח את הבקשה כבר לא קיים.";
    }

    const linked = await linkPartners(db, userId, fromId);
    if (!linked) return "אחד הצדדים כבר מחובר לשותף אחר.";

    await Promise.all([
      env.CACHE.delete(`pend_invite:${userId}`),
      env.CACHE.delete(`pend_invite_from:${fromId}`),
    ]);

    const fromPhone = await decryptPhone(fromUser, env.ENCRYPTION_KEY);
    await sendMessage(env, fromPhone, "🎉 מחוברים! מעכשיו תראו ותקבלו תזכורות על משימות משותפות.").catch((e) => console.error("[PARTNER] sendMessage to inviter failed:", e));
    track?.(`user_${userId}`, "partner_linked", { partner_user_id: fromId });
    track?.(`user_${fromId}`, "partner_linked", { partner_user_id: userId });
  } catch (err) {
    console.error(`[PARTNER] /yes failed for user ${userId}:`, err);
    return "משהו השתבש, נסה שוב 😕";
  }

  return "🎉 מחוברים! מעכשיו תראו ותקבלו תזכורות על משימות משותפות.";
}

async function declinePartnerInvite(
  db: ReturnType<typeof buildDb>,
  env: Env,
  userId: number,
  track?: TrackEvent
): Promise<string> {
  const inviteData = await env.CACHE.get(`pend_invite:${userId}`, "json") as { from_user_id: number } | null;
  if (!inviteData) return "אין לך בקשת שותפות ממתינה.";

  const fromId = inviteData.from_user_id;
  await Promise.all([
    env.CACHE.delete(`pend_invite:${userId}`),
    env.CACHE.delete(`pend_invite_from:${fromId}`),
  ]);

  const fromUser = await getUserById(db, fromId);
  if (fromUser) {
    const fromPhone = await decryptPhone(fromUser, env.ENCRYPTION_KEY);
    await sendMessage(env, fromPhone, "🙅 השותפות נדחתה.").catch(() => {});
  }
  track?.(`user_${userId}`, "partner_invite_declined", { partner_user_id: fromId });

  return "נדחתה.";
}

async function acceptFriendInvite(
  db: ReturnType<typeof buildDb>,
  env: Env,
  userId: number,
  myNickname: string,
  track?: TrackEvent
): Promise<string> {
  if (!myNickname) return "שימוש: /yes <השם שאתה תקרא לו> — לדוגמה: /yes בן";

  const inviteData = await env.CACHE.get(`friend_pend_invite:${userId}`, "json") as { from_user_id: number; sender_nickname: string } | null;
  if (!inviteData) return "אין לך בקשת חברות ממתינה.";

  const fromId = inviteData.from_user_id;
  const senderNickname = inviteData.sender_nickname;

  try {
    const fromUser = await getUserById(db, fromId);
    if (!fromUser) {
      await Promise.all([
        env.CACHE.delete(`friend_pend_invite:${userId}`),
        env.CACHE.delete(`friend_pend_invite_from:${fromId}`),
      ]);
      return "המשתמש ששלח את הבקשה כבר לא קיים.";
    }

    const [selfCount, fromCount] = await Promise.all([getFriendCount(db, userId), getFriendCount(db, fromId)]);
    if (selfCount >= FRIEND_CAPACITY) return `😕 הגעת למגבלת ${FRIEND_CAPACITY} חברים. שלח /unfriend <שם> כדי לפנות מקום.`;
    if (fromCount >= FRIEND_CAPACITY) return "😕 לחבר שלך מלאה רשימת חברים.";

    const existingNick = await getFriendByNickname(db, userId, myNickname);
    if (existingNick) return `😕 כבר יש לך חבר בשם *${myNickname}*. בחר שם אחר.`;

    const linked = await linkFriends(db, userId, fromId, myNickname, senderNickname);
    if (!linked) return "החברות כבר קיימת.";

    await Promise.all([
      env.CACHE.delete(`friend_pend_invite:${userId}`),
      env.CACHE.delete(`friend_pend_invite_from:${fromId}`),
    ]);

    const fromPhone = await decryptPhone(fromUser, env.ENCRYPTION_KEY);
    await sendMessage(env, fromPhone, `👥 *${senderNickname}* אישר את בקשת החברות שלך! מעכשיו תוכלו לתייג אחד את השני במשימות.`).catch(() => {});
    track?.(`user_${userId}`, "friend_linked", { friend_user_id: fromId });
    track?.(`user_${fromId}`, "friend_linked", { friend_user_id: userId });
  } catch (err) {
    console.error(`[FRIENDS] /yes failed for user ${userId}:`, err);
    return "משהו השתבש, נסה שוב 😕";
  }

  return `👥 חוברתם! תוכלו לתייג אחד את השני במשימות.`;
}

async function declineFriendInvite(
  db: ReturnType<typeof buildDb>,
  env: Env,
  userId: number,
  track?: TrackEvent
): Promise<string> {
  const inviteData = await env.CACHE.get(`friend_pend_invite:${userId}`, "json") as { from_user_id: number } | null;
  if (!inviteData) return "אין לך בקשת חברות ממתינה.";
  const fromId = inviteData.from_user_id;
  await Promise.all([
    env.CACHE.delete(`friend_pend_invite:${userId}`),
    env.CACHE.delete(`friend_pend_invite_from:${fromId}`),
  ]);
  const fromUser = await getUserById(db, fromId);
  if (fromUser) {
    const fromPhone = await decryptPhone(fromUser, env.ENCRYPTION_KEY);
    await sendMessage(env, fromPhone, "🙅 בקשת החברות שלך נדחתה.").catch(() => {});
  }
  track?.(`user_${userId}`, "friend_invite_declined", { from_user_id: fromId });
  return "נדחתה.";
}

// Returns minutes to snooze, or null if text is not a snooze command.
function parseSnoozeMinutes(text: string): number | null {
  const t = text.trim().toLowerCase();

  // Standalone keywords → default duration
  if (t === "דחה" || t === "snooze") return DEFAULT_SNOOZE_MINUTES;

  let body: string;
  if (t.startsWith("דחה ")) {
    body = t.slice(4).trim();
  } else if (t.startsWith("עוד ")) {
    // "עוד X דקות / שעה / חצי שעה" — require explicit time unit to avoid false positives
    body = t.slice(4).trim();
    // bare "עוד 5" without a unit is not a snooze command
    if (/^\d+$/.test(body)) return null;
  } else if (t.startsWith("snooze ")) {
    body = t.slice(7).trim();
  } else {
    return null;
  }

  if (!body) return DEFAULT_SNOOZE_MINUTES;
  if (body === "חצי שעה") return 30;
  if (body === "רבע שעה") return 15;
  if (body === "שעה") return 60;

  const hourMatch = body.match(/^(\d+)\s*(h|hr|hours?|שעות?)$/);
  if (hourMatch) return parseInt(hourMatch[1], 10) * 60;

  const minMatch = body.match(/^(\d+)\s*(m|min|minutes?|דקות?)$/);
  if (minMatch) return parseInt(minMatch[1], 10);

  // "דחה" with unrecognised body → default
  if (t.startsWith("דחה ") || t.startsWith("snooze ")) return DEFAULT_SNOOZE_MINUTES;
  return null;
}

async function handleBasicCommand(
  db: ReturnType<typeof buildDb>,
  env: Env,
  user: User,
  text: string,
  phone: string,
  contextMsgId?: string,
  track?: TrackEvent,
  undo?: UndoContext,
  waitUntil?:AnalyticsWaitUntil,
): Promise<string | null> {
  const userId = user.id;
  if(await shareCommand(env,user,phone,text,waitUntil))return'__handled__';
  if(await guideCommand(env,user,phone,text,waitUntil))return'__handled__';
  if(await taskListCommand(env,user,phone,text,waitUntil))return'__handled__';
  if(await continueTaskSchedule(env,user,phone,text,contextMsgId))return'__handled__';
  const recovery=await recoveryCommand(env,user,text,phone);if(recovery!==null)return recovery;
  const project=await projectCommand(env,user,text,phone);if(project!==null)return project;
  if(undoCommands.has(text.trim().toLowerCase()))return undoTasks(env,user.id);
  const agenda=await agendaCommand(env,user,text,phone);if(agenda!==null)return agenda;
  if (/^\/calendar(?: (?:connect|disconnect|sync))?$/.test(text.trim().toLowerCase())) return calendarCommand(env, user, text.trim().toLowerCase());
  const accessible = getAccessibleUserIds(user);
  const trimmed = text.trim();
  // Lazy-fetched on first task command that needs it
  let _assignedTaskIds: number[] | null = null;
  const getAssigned = async () => {
    if (_assignedTaskIds === null) _assignedTaskIds = await getAssignedTaskIds(db, userId);
    return _assignedTaskIds;
  };

  // If user is in feedback-awaiting state and this isn't a slash command, treat as feedback
  const feedbackKey = `feedback_awaiting:${userId}`;
  if (!trimmed.startsWith("/") && await env.CACHE.get(feedbackKey)) {
    await env.CACHE.delete(feedbackKey);
    try {
      await sendFeedbackEmail(env, phone, trimmed);
      track?.(`user_${userId}`, "feedback_sent");
      return "תודה על הפידבק! 🙏";
    } catch (err) {
      console.error("[FEEDBACK] email failed:", err);
      return "לא הצלחתי לשלוח את הפידבק, נסה שוב 😕";
    }
  }

  if (trimmed === "/api") {
    let token = await getActiveToken(db, env, user);
    const isNew = !token;
    if (!token) token = await issueOrRotateToken(db, env, userId);
    track?.(`user_${userId}`, "command_used", { command: "api", first_issue: isNew });
    const host = env.PUBLIC_HOST;
    return `🔌 *התראות דרך API*\n\nשלח לעצמך הודעות WhatsApp מכל מקום — סקריפט, אוטומציה, שרת או טרמינל.\n\n📋 *הטוקן שלך:*\n\`${token}\`\n\n*דוגמה:*\n\`\`\`\ncurl -X POST https://${host}/api/v1/${token} \\\n  -d 'הדיפלוי לפרודקשן הסתיים בהצלחה 🚀'\n\`\`\`\n\n🗑️ *רוצה להחליף סוד?* הגב על ההודעה הזו עם 🗑️ — הסוד הישן יימחק ואשלח חדש.`;
  }

  if (trimmed === "/tos" && !billingEnabled(env)) return `*תנאי שימוש*\nמופע עצמאי לניהול משימות ותזכורות ב־WhatsApp. השירות ניתן כפי שהוא; אין להסתמך עליו לפעולות קריטיות. יש להשתמש בו כחוק. למחיקת נתונים: /delete. פרטיות: /privacy.\nיצירת קשר: ${env.SUPPORT_EMAIL || "/help"}`;
  if (trimmed === "/tos") {
    track?.(`user_${userId}`, "command_used", { command: "tos" });
    return `*תנאי שימוש* — עדכון אחרון: 12.10.2026

השימוש בשירות מהווה הסכמה לתנאים אלו.

*השירות*
ניהול משימות ותזכורות אוטומטיות דרך WhatsApp, מופעל על ידי Gemini AI.

*ניסיון ומנוי*
7 ימי ניסיון חינם ללא כרטיס אשראי. לאחר מכן השירות מחייב מנוי ב־20 ₪ לחודש, בחיוב חודשי מתחדש דרך Lemon Squeezy. לא מתבצע חיוב ללא הצטרפות מפורשת בתשלום.
בסיום הניסיון ללא מנוי פעיל, ניהול משימות, תזכורות ושליחת הודעות API נעצרים והמשימות נשמרות.
לניהול המנוי או ביטול החיובים הבאים: */billing*. ביטול שומר גישה עד סוף התקופה ששולמה. מחיקת חשבון מבטלת גם חידושים עתידיים.
פרטי החיוב והתשלום מוצגים במסך התשלום. כל משתתף בשיתוף משימות צריך ניסיון או מנוי פעיל משלו.

*חובות המשתמש*
— שימוש חוקי בלבד
— אין לשלוח תוכן פוגעני, ספאם, או לנסות לפגוע במערכת

*זמינות*
השירות ניתן כפי שהוא (as-is). ייתכנו הפסקות תחזוקה. אנו לא אחראים לנזקים עקיפים כתוצאה מאי-זמינות.

*סיום*
אנו רשאים להפסיק גישה במקרה של הפרת תנאים. תוכלו להפסיק שימוש ולמחוק את כל הנתונים שלכם בכל עת באמצעות הפקודה */delete*.

*יצירת קשר*
${env.SUPPORT_EMAIL || "/help"}`;
  }

  if (trimmed === "/privacy") {
    track?.(`user_${userId}`, "command_used", { command: "privacy" });
    return `*מדיניות פרטיות* — עדכון אחרון: 13.10.2026

*מה אנו אוספים*
— מספר טלפון: נשמר מוצפן, ובנוסף נשמר hash לצורכי איתור משתמש
— הודעות שיחה, תשובות הבוט, משימות ותזכורות
— הקשר שיחה קצר לצורך המשכיות
— מצב קודם של משימות מוצפן לביטול פעולה למשך 10 דקות, והעדפות סיכום בוקר ועדיפויות להיום אם בחרת להשתמש בהם
— שמות פרויקטים מוצפנים וקישור לפריטי הצ׳קליסט; החלטות להשאיר משימות באיחור ובחירת משימה לקביעת זמן חדש (תקפה ל־15 דקות)
${env.POSTHOG_API_KEY ? "— נתוני שימוש פסאודונימיים דרך PostHog" : ""}
— טוקן API מוצפן (אם הופעל) — לאימות בקשות נכנסות
— חיבור Google Calendar אופציונלי: אסימוני גישה מוצפנים וקישור בין משימות לאירועים ביומן Todobot
${billingEnabled(env) ? "— תאריך סיום ניסיון, מזהה מנוי ומצב תשלום; פרטי כרטיס אינם נשמרים אצלנו" : ""}

*שימוש במידע*
המידע משמש אך ורק להפעלת השירות. אנו לא מוכרים מידע לצדדים שלישיים.

*תשתית וצדדים שלישיים*
— Cloudflare Workers & D1 — אחסון ועיבוד
— Cloudflare KV — מטמון קצר-טווח מוצפן לצורך הקשר
— Google Calendar — סנכרון דו-כיווני של כותרות וזמני אירועים ביומן Todobot בלבד, לאחר אישור שלך; ניתוק באמצעות /calendar disconnect
— Google Gemini — עיבוד תוכן ההודעות והקלטות כדי להבין בקשות ולתמלל אודיו
— Meta WhatsApp Cloud API — קבלה ושליחה של הודעות WhatsApp
${billingEnabled(env) ? "— Lemon Squeezy — עיבוד תשלום וניהול המנוי. מזהה חיוב אקראי מקשר בין התשלום לחשבון; מספר הטלפון והתוכן אינם נשלחים אליו" : ""}
${env.RESEND_API_KEY && env.FEEDBACK_FROM && env.FEEDBACK_TO ? "— Resend — שליחת פידבק שיזמת למפעיל, כולל ארבע הספרות האחרונות של מספר הטלפון" : ""}

*אבטחה*
מספרי טלפון, תוכן הודעות ומשימות נשמרים מוצפנים במנוחה. מזהים, זמנים, קשרים ו־hash של מספר טלפון נשמרים כמטא־נתונים ואינם אנונימיים.
כדי לספק את השירות, תוכן ההודעות עובר דרך Meta WhatsApp Cloud API ונשלח ל-Google Gemini לעיבוד. לכן השירות אינו הצפנה מקצה לקצה מול ספקי התשתית.

*זכויותיכם*
למחיקת החשבון, המשימות וההודעות: שלחו */delete* בכל עת. נשמרת רשומת חיוב מינימלית הכוללת hash של מספר הטלפון ותאריך סיום הניסיון כדי למנוע ניסיון חוזר; רשומות תשלום אצל Lemon Squeezy כפופות למדיניות שלו.
לפניות נוספות: ${env.SUPPORT_EMAIL || "/help"}`;
  }

  // ── Partner commands ─────────────────────────────────────────────────────────
  const lowerTrimmed = trimmed.toLowerCase();

  // /partner — request contact card to invite
  if (lowerTrimmed === "/partner") {
    if (user.partner_user_id) return "🤝 כבר יש לך שותף. שלח /unpartner קודם.";
    const existingFrom = await env.CACHE.get(`pend_invite_from:${userId}`);
    if (existingFrom) return "📨 יש לך בקשה פתוחה. שלח /cancel להחלפה.";
    await env.CACHE.put(`partner_awaiting_contact:${userId}`, "1", { expirationTtl: 300 });
    track?.(`user_${userId}`, "command_used", { command: "partner" });
    return "👤 שלח לי את כרטיס הקשר של השותף שלך.";
  }

  // /cancel — cancel outgoing partner/friend invite or contact-card flow.
  // Rare ambiguity is handled explicitly instead of guessing which flow to cancel.
  if (lowerTrimmed === "/cancel" || lowerTrimmed.startsWith("/cancel ") || lowerTrimmed === "/cancel-friend") {
    const rawArg = lowerTrimmed === "/cancel-friend" ? "friend" : trimmed.slice("/cancel".length).trim();
    const { target } = parseInviteTargetArg(rawArg);
    track?.(`user_${userId}`, "command_used", { command: target ? `cancel_${target}` : "cancel" });

    if (target === "partner") return cancelPartnerInvite(env, userId, track);
    if (target === "friend") return cancelFriendInvite(env, userId, track);

    const state = await getInviteState(env, userId);
    const openTargets: InviteTarget[] = [];
    if (state.partnerOutgoing || state.partnerAwaitingContact) openTargets.push("partner");
    if (state.friendOutgoing || state.friendAwaitingContact) openTargets.push("friend");
    if (openTargets.length === 0) return "אין לך בקשה פתוחה.";
    if (openTargets.length > 1) return "יש לך גם בקשת שותפות וגם בקשת חברות פתוחות. שלח /cancel partner או /cancel friend.";
    return openTargets[0] === "partner"
      ? cancelPartnerInvite(env, userId, track)
      : cancelFriendInvite(env, userId, track);
  }

  // /yes — accept incoming partner invite, or friend invite with /yes <nickname>.
  // Backward-compatible: /yes-friend <nickname> still works.
  if (lowerTrimmed === "/yes" || lowerTrimmed.startsWith("/yes ") || lowerTrimmed === "/yes-friend" || lowerTrimmed.startsWith("/yes-friend ")) {
    const isFriendAlias = lowerTrimmed.startsWith("/yes-friend");
    const rawArg = isFriendAlias ? trimmed.slice("/yes-friend".length).trim() : trimmed.slice("/yes".length).trim();
    if (isFriendAlias) {
      track?.(`user_${userId}`, "command_used", { command: "yes_friend" });
      return acceptFriendInvite(db, env, userId, rawArg, track);
    }

    const { target, rest } = parseInviteTargetArg(rawArg);
    track?.(`user_${userId}`, "command_used", { command: target ? `yes_${target}` : "yes" });

    if (target === "partner") return acceptPartnerInvite(db, env, userId, track);
    if (target === "friend") return acceptFriendInvite(db, env, userId, rest, track);

    const state = await getInviteState(env, userId);
    if (state.partnerIncoming && state.friendIncoming && !rest) {
      return "יש לך גם בקשת שותפות וגם בקשת חברות. שלח /yes partner לשותפות, או /yes <כינוי> לחברות.";
    }
    if (state.friendIncoming && rest) return acceptFriendInvite(db, env, userId, rest, track);
    if (state.friendIncoming && !state.partnerIncoming) {
      return "כדי לאשר חברות צריך לבחור כינוי: /yes <השם שאתה תקרא לו>";
    }
    if (state.partnerIncoming && !rest) return acceptPartnerInvite(db, env, userId, track);
    if (state.partnerIncoming && rest) {
      return "לבקשת שותפות מאשרים עם /yes בלי כינוי. אם זו בקשת חברות, ודא שיש לך הזמנה פתוחה.";
    }
    return "אין לך בקשה ממתינה.";
  }

  // /no — reject incoming partner/friend invite. /no-friend remains an alias.
  if (lowerTrimmed === "/no" || lowerTrimmed.startsWith("/no ") || lowerTrimmed === "/no-friend") {
    const rawArg = lowerTrimmed === "/no-friend" ? "friend" : trimmed.slice("/no".length).trim();
    const { target } = parseInviteTargetArg(rawArg);
    track?.(`user_${userId}`, "command_used", { command: target ? `no_${target}` : "no" });

    if (target === "partner") return declinePartnerInvite(db, env, userId, track);
    if (target === "friend") return declineFriendInvite(db, env, userId, track);

    const state = await getInviteState(env, userId);
    const incomingTargets: InviteTarget[] = [];
    if (state.partnerIncoming) incomingTargets.push("partner");
    if (state.friendIncoming) incomingTargets.push("friend");
    if (incomingTargets.length === 0) return "אין לך בקשה ממתינה.";
    if (incomingTargets.length > 1) return "יש לך גם בקשת שותפות וגם בקשת חברות. שלח /no partner או /no friend.";
    return incomingTargets[0] === "partner"
      ? declinePartnerInvite(db, env, userId, track)
      : declineFriendInvite(db, env, userId, track);
  }

  // /unpartner — unlink partners
  if (lowerTrimmed === "/unpartner") {
    track?.(`user_${userId}`, "command_used", { command: "unpartner" });
    if (!user.partner_user_id) return "אין לך שותף.";

    const partnerId = user.partner_user_id;
    const unlinked = await unlinkPartners(db, userId, partnerId);
    if (!unlinked) return "אין לך שותף.";

    const partnerUser = await getUserById(db, partnerId);
    if (partnerUser) {
      const partnerPhone = await decryptPhone(partnerUser, env.ENCRYPTION_KEY);
      await sendMessage(env, partnerPhone, "👋 נותקתם. כל אחד שומר על המשימות שיצר.").catch(() => {});
    }
    track?.(`user_${userId}`, "partner_unlinked", { partner_user_id: partnerId });

    return "👋 נותקתם. כל אחד שומר על המשימות שיצר.";
  }

  // ── Friends commands ──────────────────────────────────────────────────────────

  // /friends — list my friends
  if (lowerTrimmed === "/friends") {
    track?.(`user_${userId}`, "command_used", { command: "friends" });
    const myFriends = await getFriends(db, userId);
    if (myFriends.length === 0) return `👥 אין לך חברים עדיין (0/${FRIEND_CAPACITY}).\n\nלהוספת חבר: /friend <כינוי>`;
    const lines = myFriends.map((f, i) => `${i + 1}. ${f.nickname} (...${f.friend.phone_number_hash.slice(-4)})`);
    return `👥 *החברים שלך* (${myFriends.length}/${FRIEND_CAPACITY}):\n\n${lines.join("\n")}\n\nלהסרה: /unfriend <כינוי>`;
  }

  // /friend <nickname> — start friend invite flow
  if (lowerTrimmed.startsWith("/friend ") || lowerTrimmed === "/friend") {
    const nickname = trimmed.slice("/friend".length).trim();
    if (!nickname) return "שימוש: /friend <כינוי> — לדוגמה: /friend אבא";
    track?.(`user_${userId}`, "command_used", { command: "friend" });

    const count = await getFriendCount(db, userId);
    if (count >= FRIEND_CAPACITY) {
      track?.(`user_${userId}`, "friend_capacity_exceeded", { capacity: FRIEND_CAPACITY });
      return `😕 הגעת למגבלת ${FRIEND_CAPACITY} חברים. שלח /unfriend <שם> כדי לפנות מקום.`;
    }
    const existing = await getFriendByNickname(db, userId, nickname);
    if (existing) return `😕 כבר יש לך חבר בשם *${nickname}*.`;

    const existingFrom = await env.CACHE.get(`friend_pend_invite_from:${userId}`);
    if (existingFrom) return "📨 יש לך בקשת חברות פתוחה. שלח /cancel להחלפה.";

    await env.CACHE.put(`friend_awaiting_contact:${userId}`, nickname, { expirationTtl: 300 });
    return `👤 שלח לי את כרטיס הקשר של *${nickname}*.`;
  }

  // /unfriend <nickname> — remove friend symmetrically
  if (lowerTrimmed.startsWith("/unfriend ") || lowerTrimmed === "/unfriend") {
    const nickname = trimmed.slice("/unfriend".length).trim();
    track?.(`user_${userId}`, "command_used", { command: "unfriend" });
    if (!nickname) return "שימוש: /unfriend <כינוי>";
    const found = await getFriendByNickname(db, userId, nickname);
    if (!found) return `😕 לא מצאתי חבר בשם *${nickname}*.`;
    await unlinkFriends(db, userId, found.friend.id);
    const friendPhone = await decryptPhone(found.friend, env.ENCRYPTION_KEY);
    await sendMessage(env, friendPhone, "👋 הוסרת מרשימת החברים.").catch(() => {});
    track?.(`user_${userId}`, "friend_unlinked", { friend_user_id: found.friend.id });
    return `👋 *${found.nickname}* הוסר מרשימת החברים שלך.`;
  }

  // /delete — request account deletion (requires /confirm within 5 min)
  if (lowerTrimmed === "/delete") {
    const deleteKey = `delete_pending:${userId}`;
    await env.CACHE.put(deleteKey, "1", { expirationTtl: 300 });
    track?.(`user_${userId}`, "command_used", { command: "delete" });
    return `⚠️ *מחיקת חשבון*

פעולה זו תמחק לצמיתות:
• כל המשימות שלך (כולל ממתינות)
• כל היסטוריית ההודעות שלך
• פרטי החשבון שלך

גם חידושי המנוי העתידיים יבוטלו. רשומת חיוב מינימלית (hash טלפון, סיום ניסיון ומזהי מנוי) נשמרת למניעת ניסיון חוזר; תשלומי עבר אצל Lemon Squeezy אינם נמחקים.

לאישור שלח */confirm* תוך 5 דקות.
לביטול — פשוט התעלם.`;
  }

  // /confirm — execute pending account deletion
  if (lowerTrimmed === "/confirm") {
    track?.(`user_${userId}`, "command_used", { command: "confirm" });
    const deleteKey = `delete_pending:${userId}`;
    const pending = await env.CACHE.get(deleteKey);
    if (!pending) {
      return "אין פעולה ממתינה לאישור. לביטול חשבון שלח /delete.";
    }

    const partnerId = user.partner_user_id ?? null;
    try {
      await cancelSubscriptions(env, user);
    } catch {
      return "לא הצלחנו לבטל את חידוש המנוי כרגע ולכן החשבון עדיין לא נמחק. נסה /confirm שוב או בטל דרך /billing לפני המחיקה.";
    }
    await disconnectCalendar(env, userId);
    await deleteUserAndData(db, userId, partnerId);

    // Clean up all KV keys for this user
    const deleteByPrefix = async (prefix: string) => {
      let cursor: string | undefined;
      do {
        const list = await env.CACHE.list({ prefix, cursor });
        await Promise.all(list.keys.map((k) => env.CACHE.delete(k.name)));
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
    };
    await Promise.all([
      env.CACHE.delete(deleteKey),
      env.CACHE.delete(`hist:${userId}`),
      env.CACHE.delete(`feedback_awaiting:${userId}`),
      env.CACHE.delete(`partner_awaiting_contact:${userId}`),
      env.CACHE.delete(`friend_awaiting_contact:${userId}`),
      env.CACHE.delete(`welcomed:${userId}`),
      env.CACHE.delete(`pend_invite:${userId}`),
      env.CACHE.delete(`pend_invite_from:${userId}`),
      env.CACHE.delete(`friend_pend_invite:${userId}`),
      env.CACHE.delete(`friend_pend_invite_from:${userId}`),
      deleteByPrefix(`rl:user:${userId}:`),
      deleteByPrefix(`daily:${userId}:`),
    ].map((p) => p.catch(() => {})));

    // Notify partner their connection was removed
    if (partnerId) {
      const partnerUser = await getUserById(db, partnerId).catch(() => null);
      if (partnerUser) {
        const partnerPhone = await decryptPhone(partnerUser, env.ENCRYPTION_KEY).catch(() => "");
        if (partnerPhone) {
          sendMessage(env, partnerPhone, "👋 השותף שלך מחק את חשבונו. כל אחד שומר על המשימות שיצר.").catch(() => {});
        }
      }
    }

    track?.(`user_${userId}`, "account_deleted");
    // Send farewell directly — the user row is gone so we cannot saveMessage afterward
    await sendMessage(env, phone, "🗑️ החשבון, המשימות וההודעות נמחקו וחידושי המנוי בוטלו. נשמרה רשומת חיוב מינימלית כמפורט במדיניות הפרטיות. להתראות! 👋").catch(() => {});
    return "__account_deleted__";
  }

  // /feedback — send feedback email
  if (lowerTrimmed.startsWith("/feedback")) {
    const body = trimmed.slice("/feedback".length).trim();
    if (body) {
      try {
        await sendFeedbackEmail(env, phone, body);
        track?.(`user_${userId}`, "feedback_sent");
        return "תודה על הפידבק! 🙏";
      } catch (err) {
        console.error("[FEEDBACK] email failed:", err);
        return "לא הצלחתי לשלוח את הפידבק, נסה שוב 😕";
      }
    }
    // No text — ask for it
    await env.CACHE.put(feedbackKey, "1", { expirationTtl: 300 });
    return "כתוב את הפידבק שלך ואני אעביר אותו 🙏";
  }

  // ── Task commands ─────────────────────────────────────────────────────────────

  if (COMPLETE_ALL_COMMANDS.has(trimmed)) {
    const n = await completeAllPendingTasks(db, accessible, env.ENCRYPTION_KEY, undo);
    if (n > 0) {
      track?.(`user_${userId}`, "task_completed", { completion_method: "command_all", count: n });
      return (undo?.changedTaskIds?.length??0)>n?`🎉 הושלמו ${n} משימות ✅\nהחזרות הבאות נשמרו.`:`🎉 כל המשימות (${n}) הושלמו! ✅`;
    }
    return "אין משימות ממתינות.";
  }

  // Quick complete by number: -1, -2, 1-, 2-, etc.
  const numMatch = trimmed.match(/^-(\d+)$/) ?? trimmed.match(/^(\d+)-$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    const assigned = await getAssigned();
    const pending = sortTasksByDueDate(await getUserTasks(db, env.ENCRYPTION_KEY, accessible, "pending", assigned));
    if (idx >= 0 && idx < pending.length) {
      const target = pending[idx];
      const completed = await completeTask(db, env.ENCRYPTION_KEY, target.id, accessible, assigned, undo);
      if (completed?.recurrence) await scheduleNextRecurrence(db, env.ENCRYPTION_KEY, completed, undo);
      if (completed) {
        track?.(`user_${userId}`, "task_completed", { completion_method: "command" });
        return fmtCompleted(completed.description, completed.due_date);
      }
      const current = await getTaskById(db, env.ENCRYPTION_KEY, target.id, accessible, assigned);
      if (current?.status === "completed") {
        return `🎉 המשימה *${current.description}* כבר הושלמה.`;
      }
      return "לא מצאתי משימה במספר הזה 🤔 שלח ? לרשימה";
    }
    return "לא מצאתי משימה במספר הזה 🤔 שלח ? לרשימה";
  }

  // Quick complete by name: "- task name"
  const nameMatch = trimmed.match(/^-\s+(.+)$/);
  if (nameMatch) {
    const title = nameMatch[1].trim();
    const assigned = await getAssigned();
    const completed = await completeTaskByDescription(db, env.ENCRYPTION_KEY, accessible, title, assigned, undo);
    if (completed) {
      if(completed.recurrence)await scheduleNextRecurrence(db,env.ENCRYPTION_KEY,completed,undo);
      track?.(`user_${userId}`, "task_completed", { completion_method: "command" });
      return fmtCompleted(completed.description, completed.due_date);
    }
    return `לא מצאתי משימה בשם "${title}" 🤔 שלח ? לרשימה`;
  }

  // Quick add: +task or task+
  const addMatch = trimmed.match(/^\+(.+)$/) ?? trimmed.match(/^(.+)\+$/);
  if (addMatch) {
    const description = addMatch[1].trim();
    if (description) {
      const added = await addTask(db, env.ENCRYPTION_KEY, userId, description, null, null, undo);
      track?.(`user_${userId}`, "task_created", { creation_method: "command", has_due_date: false });
      return `✅ נוספה: ${added.description}`;
    }
  }

  // Snooze: reschedules the last reminder without completing the task
  const snoozeMinutes = parseSnoozeMinutes(trimmed);
  if (snoozeMinutes !== null) {
    let taskId: number | null = null;
    if (contextMsgId) {
      taskId = await getTaskIdFromMessageId(db, env.ENCRYPTION_KEY, userId, contextMsgId);
    }
    if (!taskId) {
      const last = await getLastReminderMessageId(db, env.ENCRYPTION_KEY, userId);
      taskId = last?.taskId ?? null;
    }
    if (!taskId) return "לא מצאתי תזכורת אחרונה לדחייה 🤔 שלח ? לרשימה";

    const newDueDate = new Date(Date.now() + snoozeMinutes * 60_000);
    const assigned = await getAssigned();
    const snoozed = await snoozeTask(db, env.ENCRYPTION_KEY, taskId, accessible, newDueDate, assigned, undo);
    if (!snoozed) return "לא הצלחתי לדחות את המשימה 😕";

    track?.(`user_${userId}`, "task_snoozed", { snooze_minutes: snoozeMinutes, task_id: taskId });
    const d = new Date(newDueDate.toLocaleString("en-US", { timeZone: TZ }));
    const p = (n: number) => String(n).padStart(2, "0");
    const today = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
    const timeFmt = d.toDateString() === today.toDateString()
      ? `${p(d.getHours())}:${p(d.getMinutes())}`
      : `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return `⏰ *${snoozed.description}* נדחתה ל-${timeFmt}`;
  }

  return trimmed.startsWith("/") ? "לא זיהיתי את הפקודה. /help — המדריך הקצר." : null;
}

async function handleRotateApiReaction(
  db: ReturnType<typeof buildDb>,
  env: Env,
  user: User,
  phone: string,
  reactedToMsgId?: string,
  track?: TrackEvent
): Promise<void> {
  if (!reactedToMsgId) return;
  const lastApiMsg = await env.CACHE.get(`api_msg:${user.id}`);
  if (!lastApiMsg || lastApiMsg !== reactedToMsgId) return;

  const newToken = await issueOrRotateToken(db, env, user.id);
  const host = env.PUBLIC_HOST;
  const reply = `♻️ *הסוד הקודם נמחק.*\n\n📋 *הטוקן החדש שלך:*\n\`${newToken}\`\n\n*דוגמה:*\n\`\`\`\ncurl -X POST https://${host}/api/v1/${newToken} \\\n  -d 'בדיקה אחרי החלפת סוד ✅'\n\`\`\`\n\n🗑️ הגב 🗑️ כאן כדי להחליף שוב.`;
  const newMsgId = await sendMessage(env, phone, reply);
  if (newMsgId) {
    await Promise.all([
      env.CACHE.put(`api_msg:${user.id}`, newMsgId, { expirationTtl: 60 * 60 * 24 * 365 }),
      saveMessage(db, env.ENCRYPTION_KEY, {
        userId: user.id, messageType: "text", content: null,
        aiResponse: reply, parsedTasks: null, whatsappMessageId: newMsgId,
      }),
    ]);
  }
  track?.(`user_${user.id}`, "api_token_rotated");
}

async function handleSnoozeReaction(
  db: ReturnType<typeof buildDb>,
  env: Env,
  userId: number,
  phone: string,
  accessible: number[],
  reactedToMsgId?: string,
  track?: TrackEvent,
  assignedTaskIds: number[] = []
): Promise<void> {
  let taskId: number | null = null;
  if (reactedToMsgId) {
    taskId = await getTaskIdFromMessageId(db, env.ENCRYPTION_KEY, userId, reactedToMsgId);
  }
  if (!taskId) {
    const last = await getLastReminderMessageId(db, env.ENCRYPTION_KEY, userId);
    taskId = last?.taskId ?? null;
  }
  if (!taskId) {
    await sendMessage(env, phone, "לא מצאתי תזכורת לדחייה 🤔 שלח ? לרשימה");
    return;
  }
  const newDueDate = new Date(Date.now() + DEFAULT_SNOOZE_MINUTES * 60_000);
  const undo=newUndoContext(userId);
  const snoozed = await snoozeTask(db, env.ENCRYPTION_KEY, taskId, accessible, newDueDate, assignedTaskIds, undo);
  if (!snoozed) {
    await sendMessage(env, phone, "לא הצלחתי לדחות את המשימה 😕");
    return;
  }
  track?.(`user_${userId}`, "task_snoozed", { snooze_minutes: DEFAULT_SNOOZE_MINUTES, task_id: taskId, method: "emoji" });
  const d = new Date(newDueDate.toLocaleString("en-US", { timeZone: TZ }));
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const timeFmt = d.toDateString() === today.toDateString()
    ? `${p(d.getHours())}:${p(d.getMinutes())}`
    : `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  await sendTaskReply(env,userId,phone,`⏰ *${snoozed.description}* נדחתה ל-${timeFmt}`,undo,snoozed.id);
}

async function handleThumbsUp(
  db: ReturnType<typeof buildDb>,
  env: Env,
  userId: number,
  phone: string,
  accessible: number[],
  reactedToMsgId?: string,
  track?: TrackEvent,
  assignedTaskIds: number[] = []
): Promise<void> {
  // Prefer the task tied to the exact message reacted to
  let taskId: number | null = null;
  if (reactedToMsgId) {
    taskId = await getTaskIdFromMessageId(db, env.ENCRYPTION_KEY, userId, reactedToMsgId);
  }
  // Fall back to last reminder if reaction wasn't on a known message
  if (!taskId) {
    const last = await getLastReminderMessageId(db, env.ENCRYPTION_KEY, userId);
    taskId = last?.taskId ?? null;
  }
  if (!taskId) {
    await sendMessage(env, phone, "אין משימות פתוחות להשלמה 😊 שלח ? לרשימה");
    return;
  }
  const undo=newUndoContext(userId);
  const completed = await completeTask(db, env.ENCRYPTION_KEY, taskId, accessible, assignedTaskIds,undo);
  if (completed) {
    track?.(`user_${userId}`, "task_completed", { completion_method: "thumbs_up" });
    if (completed.recurrence) {
      await scheduleNextRecurrence(db, env.ENCRYPTION_KEY, completed,undo);
      const recHebrew = recurrenceLabel(completed.recurrence);
      await sendTaskReply(
        env,
        userId,
        phone,
        `🎉 הושלמה: *${completed.description}* ✅\n🔁 המשימה חוזרת ${recHebrew} — נתראה בפעם הבאה!\nלהפסקה מוחלטת שלח: _הפסק חזרה_`,undo
      );
    } else {
      await sendTaskReply(env,userId,phone,fmtCompleted(completed.description, completed.due_date),undo);
    }
  } else {
    const task = await getTaskById(db, env.ENCRYPTION_KEY, taskId, accessible, assignedTaskIds);
    if (!task || task.status !== "completed") {
      await sendMessage(env, phone, "לא מצאתי את המשימה 🤔 שלח ? לרשימה");
    } else if (task.recurrence) {
      const recHebrew = recurrenceLabel(task.recurrence);
      await sendMessage(
        env,
        phone,
        `🎉 הושלמה: *${task.description}* ✅\n🔁 המשימה חוזרת ${recHebrew} — נתראה בפעם הבאה!\nלהפסקה מוחלטת שלח: _הפסק חזרה_`
      );
    }
  }
  const shareUser=await getUserById(db,userId);
  if(shareUser)await maybeOfferShare(env,shareUser,phone,{taskId}).catch(()=>{});

}
