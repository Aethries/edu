import type { Bindings } from "../../types";

export function failedJobStatement(
    db: D1Database,
    source: string,
    messageId: string,
    body: string,
    reason: string,
    attempts: number,
) {
    return db
        .prepare(
            `INSERT INTO failed_jobs (id, source, message_id, body, reason, attempts, failed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
            JSON.stringify([source, messageId]),
            source,
            messageId,
            body,
            reason,
            attempts,
            Date.now(),
        );
}

export async function archiveMessage(
    env: Bindings,
    source: string,
    message: Message<unknown>,
    reason: string,
) {
    // Queue producers use JSON. An unexpected non-JSON body must retry, never disappear.
    const body = JSON.stringify(message.body);
    if (body === undefined) throw new Error("Queue body is not JSON");
    await failedJobStatement(
        env.DB,
        source,
        message.id,
        body,
        reason,
        message.attempts,
    ).run();
}
