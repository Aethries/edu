import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const memberships = sqliteTable(
    "memberships",
    {
        organizationId: text("organization_id").notNull(),
        subject: text("subject").notNull(),
        role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    },
    (table) => [primaryKey({ columns: [table.organizationId, table.subject] })],
);
