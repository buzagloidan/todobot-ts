import type { Env } from "../types.ts";

export async function sendFeedbackEmail(env: Env, phone: string, feedback: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.FEEDBACK_FROM || !env.FEEDBACK_TO) throw new Error("Feedback email is not configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FEEDBACK_FROM,
      to: [env.FEEDBACK_TO],
      subject: "פידבק חדש מהבוט",
      text: `טלפון: ...${phone.slice(-4)}\n\n${feedback}`,
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend error ${res.status}`);
  }
}
