import { dispatchOutbox } from "../queue/outbox";
import type { Bindings } from "../../types";
import { parseEnv } from "../../configs/env";

export async function cleanupRecords(env: Bindings) {
    const config = parseEnv(env);
    const now = Date.now();
    const statements = [
        env.DB.prepare(
            "DELETE FROM realtime_tickets WHERE hash IN (SELECT hash FROM realtime_tickets WHERE expires_at <= ? LIMIT 1000)",
        ).bind(now),
        env.DB.prepare(
            "DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ? ORDER BY sent_at LIMIT 1000)",
        ).bind(now - config.OUTBOX_RETENTION_DAYS * 86_400_000),
    ];
    if (config.PROCESSED_JOBS_RETENTION_DAYS > 0) {
        statements.push(
            env.DB.prepare(
                "DELETE FROM processed_jobs WHERE id IN (SELECT id FROM processed_jobs WHERE processed_at < ? ORDER BY processed_at LIMIT 1000)",
            ).bind(now - config.PROCESSED_JOBS_RETENTION_DAYS * 86_400_000),
        );
    }
    await env.DB.batch(statements);
}

// Real infrastructure maintenance; business schedules remain feature-owned.
export async function runScheduled(
    controller: ScheduledController,
    env: Bindings,
) {
    if (controller.cron !== "* * * * *")
        throw new Error("Unregistered cron schedule");
    await Promise.all([dispatchOutbox(env), cleanupRecords(env)]);
}
