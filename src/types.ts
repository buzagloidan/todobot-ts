/// <reference path="../worker-configuration.d.ts" />
export interface Env extends Omit<CloudflareBindings, "MSG_QUEUE" | "REMINDER_QUEUE" | "ALERT_PHONE" | "REMINDER_TEMPLATE_NAME"> {
  // Bindings
  DB: D1Database;
  MSG_QUEUE: Queue<QueueMessage>;
  CACHE: KVNamespace;
  REMINDER_QUEUE: Queue<ReminderQueueMessage>;
  REMINDER_SCHEDULER_ENABLED: string;

  // Secrets
  ACCESS_TOKEN: string;
  APP_SECRET: string;
  GEMINI_API_KEY: string;
  ENCRYPTION_KEY: string;
  VERIFY_TOKEN: string;
  POSTHOG_API_KEY: string;
  RESEND_API_KEY?: string;
  SUPPORT_EMAIL: string;
  FEEDBACK_FROM: string;
  FEEDBACK_TO: string;
  BOT_WHATSAPP_NUMBER: string;
  BILLING_ENABLED: string;
  WHATSAPP_API_VERSION: string;
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  ALERT_PHONE?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CALENDAR_ENABLED: string;
  GEMINI_CALENDAR_DATA_ALLOWED: string;

  // Vars
  PHONE_NUMBER_ID: string;
  REMINDER_TEMPLATE_NAME?: string;
  REMINDER_ACTIONS_TEMPLATE_NAME?: string;
  AGENDA_TEMPLATE_NAME?: string;
  PUBLIC_HOST: string;
  LEMONSQUEEZY_STORE_ID: string;
  LEMONSQUEEZY_VARIANT_ID: string;
  LEMONSQUEEZY_TEST_MODE: string;
}

export type ReminderQueueMessage = { type: "reminder"; jobId: string };

export type QueueMessageType =
  | "text_processing"
  | "voice_processing";

export interface QueueMessage {
  type: QueueMessageType;
  userId: number;
  phone: string;
  incomingMsgId?: string;
  quotedMsgId?: string;
  enqueuedAt?: number;
  // text_processing
  text?: string;
  // voice_processing
  audioId?: string;
  audioMimeType?: string;
}

export interface DbUser {
  id: number;
  phone_number_encrypted: string;
  phone_number_hash: string;
  created_at: Date;
  last_active: Date;
}

export interface DbMessage {
  id: number;
  user_id: number;
  message_type: string;
  content_encrypted: string | null;
  ai_response_encrypted: string | null;
  parsed_tasks: string | null;
  whatsapp_message_id: string | null;
  created_at: Date;
}

export type RecurrenceRule = "daily" | "weekly" | "monthly" | "weekdays" | `weekly:${string}` | `monthly:${number}` | null;

export interface DbTask {
  id: number;
  user_id: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  due_date: Date | null;
  reminder_sent: boolean | null;
  recurrence: RecurrenceRule;
  created_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

export interface ParsedTask {
  action:
    | "add" | "complete" | "list" | "update" | "delete" | "stop_recurrence"
    | "project_create" | "project_show" | "project_list" | "recover";
  title: string;
  project_name?: string;
  new_project_name?: string;
  checklist_items?: string[];
  due_date?: string | null;
  new_title?: string | null;
  new_due_date?: string | null;
  status?: string;
  recurrence?: RecurrenceRule;
  assignees?: string[];
}
