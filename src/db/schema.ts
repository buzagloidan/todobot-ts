import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { relations, sql } from "drizzle-orm";

export const users = sqliteTable(
  "user",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    phone_number_encrypted: text("phone_number_encrypted").notNull(),
    phone_number_hash: text("phone_number_hash").notNull().unique(),
    created_at: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    last_active: integer("last_active", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    partner_user_id: integer("partner_user_id").references((): any => users.id, { onDelete: "set null" }),
    api_token_encrypted: text("api_token_encrypted"),
    api_token_hash: text("api_token_hash").unique(),
    api_token_created_at: integer("api_token_created_at", { mode: "timestamp" }),
  },
  (t) => [
    index("idx_user_phone_hash").on(t.phone_number_hash),
    index("idx_user_created").on(t.created_at),
    index("idx_user_active").on(t.last_active),
    index("idx_user_partner").on(t.partner_user_id),
  ]
);

export const friendLinks = sqliteTable(
  "friend_link",
  {
    user_id: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    friend_user_id: integer("friend_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    nickname: text("nickname").notNull(),
    created_at: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.friend_user_id] }),
    index("idx_friend_link_user").on(t.user_id),
  ]
);

// Billing is retained independently of a deletable user row, so a phone cannot restart its trial.
export const billingAccounts = sqliteTable("billing_account", {
  phone_hash: text("phone_hash").primaryKey(),
  billing_key: text("billing_key").notNull().unique(),
  trial_ends_at: integer("trial_ends_at", { mode: "timestamp" }),
});
export const billingSubscriptions = sqliteTable("billing_subscription", {
  id: text("id").primaryKey(),
  billing_key: text("billing_key").notNull().references(() => billingAccounts.billing_key),
  status: text("status").notNull(),
  trial_ends_at: integer("trial_ends_at", { mode: "timestamp" }),
  renews_at: integer("renews_at", { mode: "timestamp" }),
  ends_at: integer("ends_at", { mode: "timestamp" }),
  updated_at: text("updated_at").notNull(),
  last_checked_at: integer("last_checked_at").notNull().default(0),
}, t => [index("idx_billing_subscription_account").on(t.billing_key)]);

export const taskAssignees = sqliteTable(
  "task_assignee",
  {
    task_id: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    assignee_user_id: integer("assignee_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.task_id, t.assignee_user_id] }),
    index("idx_task_assignee_user").on(t.assignee_user_id),
  ]
);

export const messages = sqliteTable(
  "message",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message_type: text("message_type").notNull(),
    content_encrypted: text("content_encrypted"),
    ai_response_encrypted: text("ai_response_encrypted"),
    parsed_tasks: text("parsed_tasks"),
    whatsapp_message_id: text("whatsapp_message_id"),
    created_at: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_message_user_created").on(t.user_id, t.created_at),
    index("idx_message_user_type_created").on(t.user_id, t.message_type, t.created_at),
    index("idx_message_whatsapp_id").on(t.whatsapp_message_id),
    index("idx_message_created").on(t.created_at),
  ]
);

export const projects = sqliteTable('project', {
  id: integer('id').primaryKey({autoIncrement:true}),
  user_id: integer('user_id').notNull().references(()=>users.id,{onDelete:'cascade'}),
  name_encrypted: text('name_encrypted').notNull(), name_hash: text('name_hash').notNull(),
  created_at: integer('created_at').notNull(),
},t=>[uniqueIndex('project_owner_name').on(t.user_id,t.name_hash)]);

export const tasks = sqliteTable(
  "task",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    revision: integer("revision").notNull().default(0),
    project_id: integer('project_id').references(()=>projects.id,{onDelete:'set null'}),
    google_event_key: text("google_event_key"),
    status: text("status").notNull().default("pending"),
    due_date: integer("due_date", { mode: "timestamp" }),
    reminder_sent: integer("reminder_sent", { mode: "boolean" }).default(false),
    recurrence: text("recurrence"),
    created_at: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    completed_at: integer("completed_at", { mode: "timestamp" }),
    updated_at: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_task_user_status").on(t.user_id, t.status, t.created_at),
    index('idx_task_project').on(t.project_id,t.status,t.created_at),
    uniqueIndex("idx_task_google_event_key").on(t.google_event_key).where(sql`${t.google_event_key} IS NOT NULL`),
    index("idx_task_user_created").on(t.user_id, t.created_at),
    index("idx_task_due_date").on(t.due_date),
    index("idx_task_status_due").on(t.status, t.due_date),
    index("idx_task_pending_unsent_due")
      .on(t.due_date, t.id)
      .where(sql`${t.status} = 'pending' AND ${t.reminder_sent} = 0`),
    index("idx_task_created").on(t.created_at),
  ]
);

export const userShareOffers=sqliteTable('user_share_offer',{
  user_id:integer('user_id').primaryKey().references(()=>users.id,{onDelete:'cascade'}),
  offered_at:integer('offered_at').notNull(),state:text('state').notNull(),
});
export const taskUndo = sqliteTable('task_undo', {
  id: text('id').primaryKey(),
  actor_user_id: integer('actor_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  created_at: integer('created_at').notNull(), expires_at: integer('expires_at').notNull(), claim_nonce: text('claim_nonce'),
}, t => [index('idx_task_undo_actor').on(t.actor_user_id, t.created_at)]);
export const taskUndoChanges = sqliteTable('task_undo_change', {
  group_id: text('group_id').notNull().references(() => taskUndo.id, { onDelete: 'cascade' }),
  // Deliberately retain missing task IDs: Undo must reject the whole action if any task was deleted.
  task_id: integer('task_id').notNull(), before_encrypted: text('before_encrypted'), after_revision: integer('after_revision').notNull(),
}, t => [primaryKey({ columns: [t.group_id, t.task_id] })]);
export const taskControlUses = sqliteTable('task_control_use', {
  key: text('key').primaryKey(), actor_user_id: integer('actor_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires_at: integer('expires_at').notNull(),
});

export const taskRecovery = sqliteTable('task_recovery', {
  actor_id: integer('actor_id').notNull().references(()=>users.id,{onDelete:'cascade'}),
  task_id: integer('task_id').notNull().references(()=>tasks.id,{onDelete:'cascade'}),
  revision: integer('revision').notNull(), reviewed_at: integer('reviewed_at').notNull(),
},t=>[primaryKey({columns:[t.actor_id,t.task_id]})]);
export const recoveryPending = sqliteTable('recovery_pending', {
  actor_id: integer('actor_id').primaryKey().references(()=>users.id,{onDelete:'cascade'}),
  task_id: integer('task_id').notNull().references(()=>tasks.id,{onDelete:'cascade'}),
  revision: integer('revision').notNull(), expires_at: integer('expires_at').notNull(),
});
export const taskSchedulePending = sqliteTable('task_schedule_pending', {
  actor_id: integer('actor_id').primaryKey().references(()=>users.id,{onDelete:'cascade'}),
  task_id: integer('task_id').notNull().references(()=>tasks.id,{onDelete:'cascade'}),
  revision: integer('revision').notNull(), request_id:text('request_id').notNull(),
  prompt_message_id:text('prompt_message_id'), expires_at:integer('expires_at').notNull(),
});
export const agendaPreferences = sqliteTable('agenda_preferences', {
  user_id: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  enabled: integer('enabled').notNull().default(0), time: text('time').notNull().default('08:00'), days: text('days').notNull().default('daily'),
  next_send_at: integer('next_send_at').notNull().default(0), last_sent_date: text('last_sent_date'),
  revision: integer('revision').notNull().default(0), last_error: text('last_error'),
}, t => [index('idx_agenda_due').on(t.enabled, t.next_send_at)]);
export const agendaPriorities = sqliteTable('agenda_priority', {
  user_id: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  local_date: text('local_date').notNull(), task_id: integer('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
}, t => [primaryKey({ columns: [t.user_id, t.local_date, t.task_id] })]);

export const reminderJobs = sqliteTable('reminder_job', {
  id:text('id').primaryKey(),task_id:integer('task_id').notNull().references(()=>tasks.id,{onDelete:'cascade'}),
  owner_id:integer('owner_id').notNull().references(()=>users.id,{onDelete:'cascade'}),revision:integer('revision').notNull(),due_at:integer('due_at').notNull(),
  state:text('state').notNull().default('ready'),attempt:integer('attempt').notNull().default(0),next_attempt_at:integer('next_attempt_at').notNull().default(0),
  lease_until:integer('lease_until').notNull().default(0),nonce:text('nonce'),next_task_id:integer('next_task_id'),created_at:integer('created_at').notNull(),accepted_at:integer('accepted_at'),
},t=>[uniqueIndex('reminder_job_task_generation').on(t.task_id,t.revision,t.due_at),index('idx_reminder_job_owner').on(t.owner_id,t.state,t.next_attempt_at),index('idx_reminder_job_cleanup').on(t.created_at).where(sql`${t.state} IN ('done','stale')`)]);
export const reminderDeliveries = sqliteTable('reminder_delivery', {
  job_id:text('job_id').notNull().references(()=>reminderJobs.id,{onDelete:'cascade'}),user_id:integer('user_id').notNull().references(()=>users.id,{onDelete:'cascade'}),
  state:text('state').notNull().default('pending'),whatsapp_id:text('whatsapp_id'),error_code:integer('error_code'),delivery_status:text('delivery_status'),updated_at:integer('updated_at').notNull(),
},t=>[primaryKey({columns:[t.job_id,t.user_id]})]);

// ── Relations ─────────────────────────────────────────────────────────────────
export const googleCalendarConnections = sqliteTable("google_calendar_connection", {
  user_id: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  connection_id: text("connection_id").notNull().unique(),
  calendar_id_encrypted: text("calendar_id_encrypted").notNull(),
  refresh_token_encrypted: text("refresh_token_encrypted"),
  access_token_encrypted: text("access_token_encrypted"),
  token_expires_at: integer("token_expires_at").notNull().default(0),
  sync_token_encrypted: text("sync_token_encrypted"),
  status: text("status").notNull().default("connected"),
  last_sync_at: integer("last_sync_at").notNull().default(0),
  next_sync_at: integer("next_sync_at").notNull().default(0),
  last_error: text("last_error"),
}, t => [index("idx_google_calendar_due").on(t.status, t.next_sync_at)]);

export const googleCalendarOAuth = sqliteTable("google_calendar_oauth", {
  state_hash: text("state_hash").primaryKey(),
  user_id: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  verifier_encrypted: text("verifier_encrypted").notNull(),
  cookie_hash: text("cookie_hash"),
  purpose: text("purpose").notNull(),
  expires_at: integer("expires_at").notNull(),
}, t => [index("idx_google_calendar_oauth_expiry").on(t.expires_at)]);

export const googleCalendarEvents = sqliteTable("google_calendar_event", {
  user_id: integer("user_id").notNull().references(() => googleCalendarConnections.user_id, { onDelete: "cascade" }),
  event_id: text("event_id").notNull(),
  task_id: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
  local_hash: text("local_hash").notNull().default(""),
  etag: text("etag"),
  remote_updated: text("remote_updated"),
  snapshot_encrypted: text("snapshot_encrypted"),
  is_deleted: integer("is_deleted").notNull().default(0),
}, t => [primaryKey({ columns: [t.user_id, t.event_id] }), uniqueIndex("idx_google_calendar_task").on(t.user_id, t.task_id)]);

export const usersRelations = relations(users, ({ many }) => ({
  messages: many(messages),
  tasks: many(tasks),
  friendLinks: many(friendLinks, { relationName: "owner" }),
  taskAssignees: many(taskAssignees),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  user: one(users, { fields: [messages.user_id], references: [users.id] }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  user: one(users, { fields: [tasks.user_id], references: [users.id] }),
  assignees: many(taskAssignees),
}));

export const friendLinksRelations = relations(friendLinks, ({ one }) => ({
  owner: one(users, { fields: [friendLinks.user_id], references: [users.id], relationName: "owner" }),
  friend: one(users, { fields: [friendLinks.friend_user_id], references: [users.id] }),
}));

export const taskAssigneesRelations = relations(taskAssignees, ({ one }) => ({
  task: one(tasks, { fields: [taskAssignees.task_id], references: [tasks.id] }),
  assignee: one(users, { fields: [taskAssignees.assignee_user_id], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type FriendLink = typeof friendLinks.$inferSelect;
export type NewFriendLink = typeof friendLinks.$inferInsert;
export type TaskAssignee = typeof taskAssignees.$inferSelect;
