import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

export const realtimeTickets = sqliteTable(
    "realtime_tickets",
    {
        hash: text("hash").primaryKey(),
        subject: text("subject").notNull(),
        organizationId: text("organization_id").notNull(),
        origin: text("origin").notNull(),
        expiresAt: integer("expires_at").notNull(),
        sessionExpiresAt: integer("session_expires_at").notNull(),
    },
    (table) => [index("realtime_tickets_expiry_idx").on(table.expiresAt)],
);

export const processedJobs = sqliteTable(
    "processed_jobs",
    {
        id: text("id").primaryKey(),
        processedAt: integer("processed_at").notNull(),
    },
    (table) => [index("processed_jobs_time_idx").on(table.processedAt)],
);

export const dispatchLeases = sqliteTable("dispatch_leases", {
    name: text("name").primaryKey(),
    owner: text("owner").notNull(),
    expiresAt: integer("expires_at").notNull(),
});

export const outbox = sqliteTable(
    "outbox",
    {
        id: text("id").primaryKey(),
        body: text("body").notNull(),
        createdAt: integer("created_at").notNull(),
        sentAt: integer("sent_at"),
        attempts: integer("attempts").notNull().default(0),
        lastError: text("last_error"),
        nextAttemptAt: integer("next_attempt_at").notNull().default(0),
        quarantinedAt: integer("quarantined_at"),
    },
    (table) => [
        index("outbox_pending_idx").on(
            table.sentAt,
            table.quarantinedAt,
            table.nextAttemptAt,
            table.createdAt,
        ),
    ],
);

export const failedJobs = sqliteTable("failed_jobs", {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    messageId: text("message_id").notNull(),
    body: text("body").notNull(),
    reason: text("reason").notNull(),
    attempts: integer("attempts").notNull(),
    failedAt: integer("failed_at").notNull(),
});
