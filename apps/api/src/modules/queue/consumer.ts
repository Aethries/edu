import { z } from "zod";
import type { Bindings } from "../../types";
import { archiveMessage } from "./failed";

export const jobSchema = z
    .object({
        version: z.literal(1),
        id: z.uuid(),
        type: z.string().min(1).max(100),
        payload: z.unknown(),
    })
    .strict();

export type Job = z.infer<typeof jobSchema>;
type Handler = (job: Job, env: Bindings) => Promise<void>;

// Register real feature handlers here. Handlers must tolerate duplicate delivery.
export const jobHandlers: ReadonlyMap<string, Handler> = new Map();

export async function consumeJobs(batch: MessageBatch<unknown>, env: Bindings) {
    for (const message of batch.messages) {
        if (/-dlq(?:-|$)/.test(batch.queue)) {
            try {
                await archiveMessage(
                    env,
                    batch.queue,
                    message,
                    "retries_exhausted",
                );
                message.ack();
            } catch {
                message.retry();
            }
            continue;
        }
        const parsed = jobSchema.safeParse(message.body);
        const handler = parsed.success
            ? jobHandlers.get(parsed.data.type)
            : undefined;
        if (!parsed.success || !handler) {
            // Permanent errors go directly to durable storage, not repeated execution.
            console.error(
                JSON.stringify({
                    event: "queue.rejected",
                    messageId: message.id,
                }),
            );
            try {
                await archiveMessage(
                    env,
                    batch.queue,
                    message,
                    parsed.success ? "unsupported_type" : "invalid_schema",
                );
                message.ack();
            } catch {
                message.retry();
            }
            continue;
        }
        try {
            await handler(parsed.data, env);
            message.ack();
        } catch {
            console.error(
                JSON.stringify({
                    event: "queue.failed",
                    messageId: message.id,
                    jobId: parsed.data.id,
                }),
            );
            message.retry();
        }
    }
}

export async function enqueueJob(env: Bindings, job: Job) {
    const parsed = jobSchema.parse(job);
    if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 127_000)
        throw new Error("Queue message exceeds 127000 bytes");
    await env.JOBS.send(parsed, { contentType: "json" });
}
