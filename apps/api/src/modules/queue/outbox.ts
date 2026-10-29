import { jobSchema, type Job } from "./consumer";
import type { Bindings } from "../../types";
import { failedJobStatement } from "./failed";
import type { Database } from "../../db/client";
import { outbox, processedJobs } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

// Include this query in the SAME Drizzle db.batch() as the business write.
export function outboxStatement(db: Database, input: Job) {
    const job = jobSchema.parse(input);
    if (new TextEncoder().encode(JSON.stringify(job)).byteLength > 127_000)
        throw new Error("Outbox message exceeds 127000 bytes");
    return db.insert(outbox).values({
        id: job.id,
        body: JSON.stringify(job),
        createdAt: Date.now(),
    });
}

export async function dispatchOutbox(env: Bindings) {
    const owner = crypto.randomUUID();
    const leaseMs = 5 * 60_000;
    const acquired = await env.DB.prepare(
        `INSERT INTO dispatch_leases (name, owner, expires_at) VALUES ('outbox', ?, ?)
         ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE dispatch_leases.expires_at <= ? RETURNING owner`,
    )
        .bind(owner, Date.now() + leaseMs, Date.now())
        .first();
    if (!acquired) return;
    try {
        const rows = await env.DB.prepare(
            "SELECT id, body, attempts FROM outbox WHERE sent_at IS NULL AND quarantined_at IS NULL AND next_attempt_at <= ? ORDER BY created_at, id LIMIT 100",
        )
            .bind(Date.now())
            .all<{ id: string; body: string; attempts: number }>();
        // Queue limits: 100 messages / 256000 bytes; leave room for metadata.
        const chunks: { id: string; job: Job }[][] = [];
        let bytes = 0;
        for (const row of rows.results) {
            let job: Job;
            try {
                job = jobSchema.parse(JSON.parse(row.body));
                if (job.id !== row.id) throw new Error("Outbox ID mismatch");
                if (
                    new TextEncoder().encode(JSON.stringify(job)).byteLength >
                    127_000
                )
                    throw new Error("Outbox message exceeds 127000 bytes");
            } catch {
                await env.DB.batch([
                    failedJobStatement(
                        env.DB,
                        "outbox",
                        row.id,
                        row.body,
                        "invalid_outbox",
                        row.attempts + 1,
                    ),
                    env.DB.prepare(
                        "UPDATE outbox SET quarantined_at = ?, attempts = attempts + 1, last_error = 'invalid_outbox' WHERE id = ?",
                    ).bind(Date.now(), row.id),
                ]);
                continue;
            }
            const size = new TextEncoder().encode(
                JSON.stringify(job),
            ).byteLength;
            if (!chunks.length || bytes + size > 240_000) {
                chunks.push([]);
                bytes = 0;
            }
            chunks[chunks.length - 1].push({ id: row.id, job });
            bytes += size;
        }
        let sendFailed = false;
        for (const chunk of chunks) {
            const renewed = await env.DB.prepare(
                "UPDATE dispatch_leases SET expires_at = ? WHERE name = 'outbox' AND owner = ? AND expires_at > ? RETURNING owner",
            )
                .bind(Date.now() + leaseMs, owner, Date.now())
                .first();
            if (!renewed) throw new Error("Outbox dispatch lease expired");
            try {
                await env.JOBS.sendBatch(
                    chunk.map(({ job }) => ({
                        body: job,
                        contentType: "json" as const,
                    })),
                );
            } catch {
                sendFailed = true;
                await env.DB.batch(
                    chunk.map(({ id }) =>
                        env.DB.prepare(
                            "UPDATE outbox SET attempts = attempts + 1, last_error = 'queue_send_failed', next_attempt_at = ? WHERE id = ? AND sent_at IS NULL",
                        ).bind(Date.now() + 60_000, id),
                    ),
                );
                continue;
            }
            const sentAt = Date.now();
            // Send and mark are not atomic. A crash can duplicate delivery; consumers stay idempotent.
            await env.DB.batch(
                chunk.map(({ id }) =>
                    env.DB.prepare(
                        "UPDATE outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ? AND sent_at IS NULL",
                    ).bind(sentAt, id),
                ),
            );
        }
        if (sendFailed) throw new Error("One or more outbox batches failed");
    } finally {
        // Never release a successor's lease if this invocation outlives its own lease.
        await env.DB.prepare(
            "DELETE FROM dispatch_leases WHERE name = 'outbox' AND owner = ?",
        )
            .bind(owner)
            .run();
    }
}

export async function commitJobOnce(
    db: Database,
    id: string,
    statements: BatchItem<"sqlite">[],
) {
    jobSchema.shape.id.parse(id);
    if (
        await db
            .select({ id: processedJobs.id })
            .from(processedJobs)
            .where(eq(processedJobs.id, id))
            .get()
    )
        return;
    try {
        await db.batch([
            db.insert(processedJobs).values({ id, processedAt: Date.now() }),
            ...statements,
        ]);
    } catch (error) {
        // Concurrent delivery may win the primary key; its batch committed all effects.
        if (
            !(await db
                .select({ id: processedJobs.id })
                .from(processedJobs)
                .where(eq(processedJobs.id, id))
                .get())
        )
            throw error;
    }
}
