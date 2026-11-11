import type { Env } from "../types.ts";
import type { User } from "../db/schema.ts";
import { buildDb } from "../db/client.ts";
import { saveMessage } from "../db/queries.ts";
import { signControl, verifyControl } from "./controls.ts";
import {
  sendInteractiveButtons,
  sendInteractiveUrl,
  sendMessage,
  WhatsAppSendError,
} from "./whatsapp.ts";
import { capture, type AnalyticsWaitUntil } from "./posthog.ts";
export function shareContent(env: Env): { message: string; url: string } | null {
  if (!/^\d{7,15}$/.test(env.BOT_WHATSAPP_NUMBER || "")) return null;
  const message = `הכירו את טודו 🤖\nמשימות ותזכורות בתוך WhatsApp, גם בהודעות קוליות, עם Google Calendar וצ׳קליסטים.\n\nמתחילים כאן 👇\nhttps://wa.me/${env.BOT_WHATSAPP_NUMBER}`;
  return { message, url: "https://wa.me/?text=" + encodeURIComponent(message) };
}
const now = () => Math.floor(Date.now() / 1000);
export async function sendShareDraft(
  env: Env,
  user: User,
  phone: string,
  waitUntil?: AnalyticsWaitUntil,
): Promise<void> {
  const share = shareContent(env);
  if (!share) { await sendMessage(env, phone, "השיתוף אינו מוגדר במופע הזה."); return; }
  const { message: SHARE_MESSAGE, url: SHARE_URL } = share;
  const text =
    SHARE_MESSAGE +
    "\n\nלחץ על הכפתור לבחירת איש קשר. ההודעה תישלח רק אחרי שתאשר ב־WhatsApp.";
  let id: string | null;
  try {
    id = await sendInteractiveUrl(env, phone, text, "שתף עם חבר", SHARE_URL);
  } catch (error) {
    if (!(error instanceof WhatsAppSendError) || error.retryable) throw error;
    id = await sendMessage(
      env,
      phone,
      SHARE_MESSAGE +
        "\n\nאפשר להעביר את ההודעה הזו לחבר, או להכין הודעת WhatsApp כאן:\n" +
        SHARE_URL,
    );
  }
  await env.DB.prepare(
    "INSERT INTO user_share_offer(user_id,offered_at,state) VALUES (?,?,'opened') ON CONFLICT(user_id) DO UPDATE SET state='opened'",
  )
    .bind(user.id, now())
    .run();
  await saveMessage(buildDb(env), env.ENCRYPTION_KEY, {
    userId: user.id,
    messageType: "system",
    content: "/share",
    aiResponse: text,
    parsedTasks: null,
    whatsappMessageId: id,
  });
  await capture(
    env,
    `user_${user.id}`,
    "share_draft_opened",
    {},
    { waitUntil },
  );
}
export async function shareCommand(
  env: Env,
  user: User,
  phone: string,
  text: string,
  waitUntil?: AnalyticsWaitUntil,
): Promise<boolean> {
  if (text.trim().toLowerCase() !== "/share") return false;
  await sendShareDraft(env, user, phone, waitUntil);
  return true;
}
export async function handleShareControl(
  env: Env,
  user: User,
  phone: string,
  payload: string,
  waitUntil?: AnalyticsWaitUntil,
): Promise<boolean> {
  const c = await verifyControl(env, payload, user.id);
  if (c?.kind !== "share") return false;
  const [, action, expiry] = c.values;
  if (
    c.values.length !== 3 ||
    !["open", "later"].includes(action) ||
    !/^\d+$/.test(expiry ?? "")
  )
    return false;
  if (+expiry <= now()) {
    await sendMessage(
      env,
      phone,
      "הכפתור פג. אפשר להכין הודעה לשיתוף באמצעות /share.",
    );
    return true;
  }
  if (action === "open") {
    await sendShareDraft(env, user, phone, waitUntil);
    return true;
  }
  await env.DB.prepare(
    "UPDATE user_share_offer SET state='dismissed' WHERE user_id=?",
  )
    .bind(user.id)
    .run();
  await sendMessage(env, phone, "בטח 🙂 אפשר לשתף בכל זמן באמצעות /share.");
  await capture(
    env,
    `user_${user.id}`,
    "share_offer_dismissed",
    {},
    { waitUntil },
  );
  return true;
}
/** Contextual, one-time offer only after the actor acknowledges a successfully sent reminder. */
export async function maybeOfferShare(
  env: Env,
  user: User,
  phone: string,
  source: { taskId: number } | { groupId: string },
  waitUntil?: AnalyticsWaitUntil,
): Promise<void> {
  if (!shareContent(env)) return;
  const cooldown = `guide:v2:${user.id}:cooldown`;
  if (await env.CACHE.get(cooldown)) return;
  const individual = "taskId" in source;
  const from = individual
    ? "task t"
    : "task_undo_change c JOIN task t ON t.id=c.task_id JOIN task_undo u ON u.id=c.group_id";
  const condition = individual
    ? "t.id=?"
    : "c.group_id=? AND u.actor_user_id=?";
  const qualified = await env.DB.prepare(
    `SELECT 1 FROM ${from} WHERE ${condition} AND t.status='completed'
    AND EXISTS(SELECT 1 FROM reminder_job j JOIN reminder_delivery d ON d.job_id=j.id AND d.user_id=?
      WHERE j.task_id=t.id AND d.state='accepted' AND d.whatsapp_id IS NOT NULL AND COALESCE(d.delivery_status,'sent') IN ('sent','delivered','read')) LIMIT 1`,
  )
    .bind(
      ...(individual
        ? [source.taskId, user.id]
        : [source.groupId, user.id, user.id]),
    )
    .first();
  if (!qualified) return;
  // Claim before sending: retries/crashes must never duplicate an optional growth prompt.
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO user_share_offer(user_id,offered_at,state) VALUES (?,?,'offered')",
  )
    .bind(user.id, now())
    .run();
  if (!claim.meta.changes) return;
  const expiry = now() + 604800;
  await sendInteractiveButtons(
    env,
    phone,
    "טודו עזר לך לזכור? 🙂\nאפשר לשתף עם חבר הודעה מוכנה וקישור לבוט.",
    [
      {
        id: await signControl(env, "share", user.id, "open", expiry),
        title: "שתף עם חבר",
      },
      {
        id: await signControl(env, "share", user.id, "later", expiry),
        title: "אולי בהמשך",
      },
    ],
  );
  await env.CACHE.put(cooldown, "1", { expirationTtl: 86400 });
  await capture(env, `user_${user.id}`, "share_offer_shown", {}, { waitUntil });
}
