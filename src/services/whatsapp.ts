import type { Env } from "../types.ts";
import { checkServiceRateLimit } from "../rate_limit.ts";

const graphApi = (env: Env) => `https://graph.facebook.com/${env.WHATSAPP_API_VERSION || "v25.0"}`;

export type ReminderSendOptions = { callbackData: string; queuedReminder: true };
export class WhatsAppSendError extends Error {
  constructor(public status: number, public code: number | null, public retryAfter: number) {
    super(`WhatsApp rejected message (${status}, ${code ?? 'unknown'})`);
  }
  get retryable(): boolean { return this.status === 429 || this.status >= 500 || [130429, 131056, 131048].includes(this.code ?? 0); }
}

async function doSend(env: Env, payload: object, options?: ReminderSendOptions): Promise<string | null> {
  // Durable queue concurrency/backoff controls reminder throughput; the old KV soft cap must not throttle it.
  if (!options?.queuedReminder) {
    const rateCheck = await checkServiceRateLimit(env.CACHE, "whatsapp");
    if (!rateCheck.allowed) throw new Error(`WhatsApp rate limit: ${rateCheck.message}`);
  }

  const url = `${graphApi(env)}/${env.PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...payload, ...(options ? { biz_opaque_callback_data: options.callbackData } : {}) }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    // Read only a bounded error prefix and retain numeric codes, never provider descriptions or phone data.
    const reader = res.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) try { while (size < 4096) { const value = await reader.read(); if (value.done) break; const chunk = value.value.slice(0, 4096-size); chunks.push(chunk); size += chunk.length; } } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let code: number | null = null; try { const error = JSON.parse(new TextDecoder().decode(bytes)).error; if (Number.isInteger(error?.code)) code = error.code; } catch { /* numeric code remains unknown */ }
    const delay = Number(res.headers.get('Retry-After'));
    throw new WhatsAppSendError(res.status, code, Number.isFinite(delay) ? Math.max(0, Math.min(delay, 3600)) : 0);
  }

  const data = (await res.json()) as { messages?: { id: string }[] };
  return data.messages?.[0]?.id ?? null;
}

export async function sendMessage(env: Env, to: string, text: string): Promise<string | null> {
  return doSend(env, {
    messaging_product: "whatsapp",
    to,
    text: { body: text },
  });
}

export async function sendInteractiveButtons(
  env: Env,
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[],
  options?: ReminderSendOptions
): Promise<string | null> {
  return doSend(env, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  }, options);
}

export async function sendTemplateReminder(
  env: Env,
  to: string,
  templateName: string,
  taskDescription: string,
  dueInfo: string,
  buttons: {id: string; title: string}[] = [],
  options?: ReminderSendOptions
): Promise<string | null> {
  return doSend(env, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: "he" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: taskDescription },
            { type: "text", text: dueInfo },
          ],
        },
        ...buttons.map((button, index) => ({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: button.id }] })),
      ],
    },
  }, options);
}

export async function sendAgendaTemplate(env: Env, to: string, date: string, today: number, overdue: number, buttons: {id:string;title:string}[]): Promise<string | null> {
  return doSend(env, { messaging_product:'whatsapp', to, type:'template', template: {
    name:env.AGENDA_TEMPLATE_NAME, language:{code:'he'}, components:[
      {type:'body',parameters:[date,String(today),String(overdue)].map(text => ({type:'text',text}))},
      ...buttons.map((button,index) => ({type:'button',sub_type:'quick_reply',index:String(index),parameters:[{type:'payload',payload:button.id}]})),
    ],
  }});
}

export async function sendInteractiveList(env: Env, to: string, body: string, rows: {id:string;title:string;description?:string}[], options?:{button:string;sectionTitle:string}): Promise<string | null> {
  return doSend(env, {messaging_product:'whatsapp',to,type:'interactive',interactive:{type:'list',body:{text:body},
    action:{button:options?.button??'בחירת משימה',sections:[{title:options?.sectionTitle??'משימות',rows}]}}});
}

export async function sendApiTemplate(
  env: Env,
  to: string,
  message: string
): Promise<string | null> {
  return doSend(env, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "todo_api",
      language: { code: "he" },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: message }],
        },
      ],
    },
  });
}

export async function markRead(env: Env, messageId: string): Promise<void> {
  const url = `${graphApi(env)}/${env.PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  });
}


export async function sendReaction(env: Env, to: string, messageId: string, emoji: string): Promise<void> {
  // Reactions bypass the service rate limiter — they're UI-only and cheap
  const url = `${graphApi(env)}/${env.PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "reaction",
      reaction: { message_id: messageId, emoji },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp reaction API ${res.status}: ${body}`);
  }
}

export async function downloadMedia(env: Env, mediaId: string): Promise<ArrayBuffer> {
  const metaRes = await fetch(`${graphApi(env)}/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.ACCESS_TOKEN}` },
  });
  if (!metaRes.ok) throw new Error(`Media metadata fetch failed: ${metaRes.status}`);
  const meta = (await metaRes.json()) as { url: string };

  const dlRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${env.ACCESS_TOKEN}` },
  });
  if (!dlRes.ok) throw new Error(`Media download failed: ${dlRes.status}`);
  return dlRes.arrayBuffer();
}

/** A public draft link only; WhatsApp lets the user choose a recipient and press Send. */
export async function sendInteractiveUrl(env:Env,to:string,text:string,title:string,url:string):Promise<string|null>{
  return doSend(env,{messaging_product:'whatsapp',to,type:'interactive',interactive:{type:'cta_url',body:{text},action:{name:'cta_url',parameters:{display_text:title,url}}}});
}
