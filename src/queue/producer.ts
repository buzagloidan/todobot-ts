import type { Env, QueueMessage } from "../types.ts";

export async function enqueueText(
  env: Env, userId: number, phone: string, text: string, incomingMsgId?: string
): Promise<void> {
  const msg: QueueMessage = { type: "text_processing", userId, phone, text, incomingMsgId, enqueuedAt: Date.now() };
  await env.MSG_QUEUE.send(msg);
}

export async function enqueueVoice(
  env: Env, userId: number, phone: string,
  audioId: string, audioMimeType: string, incomingMsgId?: string
): Promise<void> {
  const msg: QueueMessage = { type: "voice_processing", userId, phone, audioId, audioMimeType, incomingMsgId, enqueuedAt: Date.now() };
  await env.MSG_QUEUE.send(msg);
}
