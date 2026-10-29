import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
    commitJobOnce,
    dispatchOutbox,
    outboxStatement,
} from "../src/modules/queue/outbox";
import type { Bindings } from "../src/types";
import { cleanupRecords } from "../src/modules/cron/handler";
import { createDatabase } from "../src/db/client";
import { memberships } from "../src/db/schema";
import { sql } from "drizzle-orm";
import { consumeJobs } from "../src/modules/queue/consumer";

test(
    "Workers integration: JWT, tenant permissions, R2, D1, WebSockets, outbox",
    { timeout: 60_000 },
    async () => {
        const { publicKey, privateKey } = await generateKeyPair("RS256");
        const jwk = {
            ...(await exportJWK(publicKey)),
            kid: "test",
            alg: "RS256",
            use: "sig",
        };
        const identity = createServer((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ keys: [jwk] }));
        });
        await new Promise<void>((resolve) =>
            identity.listen(0, "127.0.0.1", resolve),
        );
        const address = identity.address();
        assert.ok(address && typeof address === "object");
        const issuer = `http://127.0.0.1:${address.port}/`;
        const mf = new Miniflare(
            convertV4MiniflareOptions({
                modules: true,
                scriptPath: "dist/index.js",
                compatibilityDate: "2026-10-29",
                bindings: {
                    ENVIRONMENT: "development",
                    CORS_ORIGINS: "http://localhost:3000",
                    AUTH_ENABLED: "true",
                    AUTH_ISSUER: issuer,
                    AUTH_AUDIENCE: "edu-api",
                    AUTH_JWKS_URL: `${issuer}jwks`,
                    MAX_UPLOAD_BYTES: "5242880",
                    REALTIME_TICKET_TTL_SECONDS: "30",
                },
                d1Databases: ["DB"],
                r2Buckets: ["FILES"],
                queueProducers: { JOBS: "jobs" },
                durableObjects: {
                    REALTIME: { className: "RealtimeRoom", useSQLite: true },
                },
                ratelimits: {
                    API_RATE_LIMITER: {
                        namespace_id: "1001",
                        simple: { limit: 120, period: 60 },
                    },
                },
            }),
        );
        try {
            const db = await mf.getD1Database("DB");
            const orm = createDatabase(db as unknown as D1Database);
            for (const file of (await readdir("drizzle"))
                .filter((name) => name.endsWith(".sql"))
                .sort()) {
                const sql = await readFile(`drizzle/${file}`, "utf8");
                for (const statement of sql.split("--> statement-breakpoint")) {
                    if (statement.trim()) await db.prepare(statement).run();
                }
            }
            const organizationId = crypto.randomUUID();
            const fileId = crypto.randomUUID();
            await db
                .prepare(
                    "INSERT INTO memberships (organization_id, subject, role) VALUES (?, ?, ?)",
                )
                .bind(organizationId, "user-1", "owner")
                .run();
            const token = await new SignJWT({})
                .setProtectedHeader({ alg: "RS256", kid: "test" })
                .setSubject("user-1")
                .setIssuer(issuer)
                .setAudience("edu-api")
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(privateKey);
            const headers = {
                Authorization: `Bearer ${token}`,
                Origin: "http://localhost:3000",
            };
            const path = `http://localhost/v1/orgs/${organizationId}/files/${fileId}`;
            assert.equal((await mf.dispatchFetch(path)).status, 401);
            assert.equal(
                (
                    await mf.dispatchFetch(path, {
                        headers: { Authorization: "Bearer invalid" },
                    })
                ).status,
                401,
            );
            const wrongTenant = path.replace(
                organizationId,
                crypto.randomUUID(),
            );
            assert.equal(
                (await mf.dispatchFetch(wrongTenant, { headers })).status,
                403,
            );
            const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
            assert.equal(
                (
                    await mf.dispatchFetch(path, {
                        method: "PUT",
                        headers: { ...headers, "Content-Type": "image/png" },
                        body: bytes,
                    })
                ).status,
                201,
            );
            assert.equal(
                (
                    await mf.dispatchFetch(path, {
                        method: "PUT",
                        headers: { ...headers, "Content-Type": "image/png" },
                        body: bytes,
                    })
                ).status,
                409,
            );
            const download = await mf.dispatchFetch(path, { headers });
            assert.equal(download.status, 200);
            const conditional = await mf.dispatchFetch(path, {
                headers: {
                    ...headers,
                    "If-None-Match": download.headers.get("ETag")!,
                },
            });
            assert.equal(conditional.status, 304);
            assert.equal(
                conditional.headers.get("Cache-Control"),
                "private, no-cache",
            );
            assert.deepEqual(
                new Uint8Array(await download.arrayBuffer()),
                bytes,
            );
            const badPath = path.replace(fileId, crypto.randomUUID());
            const fragmented = () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        for (const byte of bytes)
                            controller.enqueue(new Uint8Array([byte]));
                        controller.close();
                    },
                });
            assert.equal(
                (
                    await mf.dispatchFetch(badPath, {
                        method: "PUT",
                        headers: { ...headers, "Content-Type": "image/png" },
                        body: fragmented(),
                        duplex: "half",
                    })
                ).status,
                411,
            );
            assert.equal(
                (
                    await mf.dispatchFetch(badPath, {
                        method: "PUT",
                        headers: {
                            ...headers,
                            "Content-Type": "image/png",
                            "Content-Length": String(bytes.length),
                        },
                        body: fragmented(),
                        duplex: "half",
                    })
                ).status,
                201,
            );
            await mf.dispatchFetch(badPath, { method: "DELETE", headers });
            for (const [body, contentType, status] of [
                [new Uint8Array(9), "image/png", 415],
                [bytes, "text/html", 415],
                [new Uint8Array(5 * 1024 * 1024 + 1), "image/png", 413],
            ] as const) {
                assert.equal(
                    (
                        await mf.dispatchFetch(badPath, {
                            method: "PUT",
                            headers: {
                                ...headers,
                                "Content-Type": contentType,
                            },
                            body,
                        })
                    ).status,
                    status,
                );
                assert.equal(
                    (await mf.dispatchFetch(badPath, { headers })).status,
                    404,
                );
            }
            assert.equal(
                (
                    await mf.dispatchFetch("http://localhost/openapi.json", {
                        headers,
                    })
                ).status,
                200,
            );
            const invalidParams = await mf.dispatchFetch(
                "http://localhost/v1/orgs/not-a-uuid/files/invalid",
                { headers },
            );
            assert.equal(invalidParams.status, 400);

            const ticketResponse = await mf.dispatchFetch(
                `http://localhost/v1/orgs/${organizationId}/realtime/tickets`,
                { method: "POST", headers },
            );
            assert.equal(ticketResponse.status, 201);
            const { ticket } = (await ticketResponse.json()) as {
                ticket: string;
            };
            const ticketSession = await db
                .prepare(
                    "SELECT session_expires_at AS expiry FROM realtime_tickets WHERE subject = 'user-1'",
                )
                .first<{ expiry: number }>();
            assert.ok(
                ticketSession &&
                    ticketSession.expiry > Date.now() + 50 * 60_000,
            );
            const socketUrl = `http://localhost/v1/orgs/${organizationId}/realtime`;
            const upgradeHeaders = {
                Origin: headers.Origin,
                Upgrade: "websocket",
                "Sec-WebSocket-Protocol": `edu.v1, edu-ticket.${ticket}`,
            };
            const upgrade = await mf.dispatchFetch(socketUrl, {
                headers: upgradeHeaders,
            });
            assert.equal(upgrade.status, 101);
            const socket = upgrade.webSocket;
            assert.ok(socket);
            socket.accept();
            assert.equal(
                (await mf.dispatchFetch(socketUrl, { headers: upgradeHeaders }))
                    .status,
                401,
            );
            socket.close(1000);

            // Native clients omit Origin; browser tickets cannot be downgraded to no-Origin tickets.
            const ticketUrl = `http://localhost/v1/orgs/${organizationId}/realtime/tickets`;
            assert.equal(
                (
                    await mf.dispatchFetch(ticketUrl, {
                        method: "POST",
                        headers: { ...headers, Origin: "https://evil.example" },
                    })
                ).status,
                403,
            );
            const nativeTicketResponse = await mf.dispatchFetch(ticketUrl, {
                method: "POST",
                headers: { Authorization: headers.Authorization },
            });
            assert.equal(nativeTicketResponse.status, 201);
            const nativeTicket = (
                (await nativeTicketResponse.json()) as { ticket: string }
            ).ticket;
            const nativeProtocols = {
                Upgrade: "websocket",
                "Sec-WebSocket-Protocol": `edu.v1, edu-ticket.${nativeTicket}`,
            };
            assert.equal(
                (
                    await mf.dispatchFetch(socketUrl, {
                        headers: { ...nativeProtocols, Origin: headers.Origin },
                    })
                ).status,
                401,
            );
            const nativeUpgrade = await mf.dispatchFetch(socketUrl, {
                headers: nativeProtocols,
            });
            assert.equal(nativeUpgrade.status, 101);
            nativeUpgrade.webSocket!.accept();
            nativeUpgrade.webSocket!.close(1000);

            const job = {
                version: 1 as const,
                id: crypto.randomUUID(),
                type: "integration",
                payload: {},
            };
            await orm.batch([outboxStatement(orm, job)]);
            const sent: unknown[] = [];
            await dispatchOutbox({
                DB: db,
                JOBS: {
                    sendBatch: async (messages: { body: unknown }[]) => {
                        sent.push(...messages.map((message) => message.body));
                    },
                },
            } as unknown as Bindings);
            await dispatchOutbox({
                DB: db,
                JOBS: {
                    sendBatch: async () => {
                        throw new Error("should not resend");
                    },
                },
            } as unknown as Bindings);
            assert.equal(sent.length, 1);

            // 100 small jobs produce one Queue batch, even when two crons overlap.
            const jobs = Array.from({ length: 100 }, () => ({
                ...job,
                id: crypto.randomUUID(),
            }));
            await orm.batch([
                outboxStatement(orm, jobs[0]),
                ...jobs.slice(1).map((item) => outboxStatement(orm, item)),
            ]);
            let batches = 0;
            let started!: () => void;
            let release!: () => void;
            const sending = new Promise<void>((resolve) => {
                started = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const dispatchEnv = {
                DB: db,
                JOBS: {
                    sendBatch: async (messages: unknown[]) => {
                        assert.equal(messages.length, 100);
                        batches++;
                        started();
                        await gate;
                    },
                },
            } as unknown as Bindings;
            const firstDispatch = dispatchOutbox(dispatchEnv);
            await sending;
            try {
                await dispatchOutbox(dispatchEnv);
                assert.equal(batches, 1);
            } finally {
                release();
            }
            await firstDispatch;
            assert.equal(
                (
                    await db
                        .prepare(
                            "SELECT count(*) AS n FROM outbox WHERE sent_at IS NULL",
                        )
                        .first<{ n: number }>()
                )?.n,
                0,
            );

            const retryJob = { ...job, id: crypto.randomUUID() };
            await orm.batch([outboxStatement(orm, retryJob)]);
            await assert.rejects(
                dispatchOutbox({
                    DB: db,
                    JOBS: {
                        sendBatch: async () => {
                            throw new Error("Queue unavailable");
                        },
                    },
                } as unknown as Bindings),
            );
            assert.equal(
                (
                    await db
                        .prepare(
                            "SELECT count(*) AS n FROM outbox WHERE sent_at IS NULL",
                        )
                        .first<{ n: number }>()
                )?.n,
                1,
            );
            assert.equal(
                (
                    await db
                        .prepare("SELECT count(*) AS n FROM dispatch_leases")
                        .first<{ n: number }>()
                )?.n,
                0,
            );

            const largeJobs = Array.from({ length: 3 }, () => ({
                ...job,
                id: crypto.randomUUID(),
                payload: "x".repeat(100_000),
            }));
            await db
                .prepare("UPDATE outbox SET next_attempt_at = 0 WHERE id = ?")
                .bind(retryJob.id)
                .run();
            await orm.batch([
                outboxStatement(orm, largeJobs[0]),
                ...largeJobs.slice(1).map((item) => outboxStatement(orm, item)),
            ]);
            let largeBatches = 0;
            await dispatchOutbox({
                DB: db,
                JOBS: {
                    sendBatch: async (messages: { body: unknown }[]) => {
                        largeBatches++;
                        assert.ok(
                            messages.reduce(
                                (sum, message) =>
                                    sum +
                                    new TextEncoder().encode(
                                        JSON.stringify(message.body),
                                    ).byteLength,
                                0,
                            ) <= 240_000,
                        );
                    },
                },
            } as unknown as Bindings);
            assert.equal(largeBatches, 2);
            // A failed first batch must not prevent a later batch from being sent.
            const partialJobs = largeJobs.map((item) => ({
                ...item,
                id: crypto.randomUUID(),
            }));
            await orm.batch([
                outboxStatement(orm, partialJobs[0]),
                ...partialJobs
                    .slice(1)
                    .map((item) => outboxStatement(orm, item)),
            ]);
            let partialBatches = 0;
            await assert.rejects(
                dispatchOutbox({
                    DB: db,
                    JOBS: {
                        sendBatch: async () => {
                            if (++partialBatches === 1)
                                throw new Error("transient failure");
                        },
                    },
                } as unknown as Bindings),
            );
            assert.equal(partialBatches, 2);
            const delayed = await db
                .prepare(
                    "SELECT count(*) AS n FROM outbox WHERE sent_at IS NULL AND next_attempt_at > ? AND attempts = 1 AND last_error = 'queue_send_failed'",
                )
                .bind(Date.now())
                .first<{ n: number }>();
            assert.equal(delayed?.n, 2);
            // Finish this isolated scenario without affecting subsequent retention assertions.
            await db
                .prepare(
                    "UPDATE outbox SET next_attempt_at = 0 WHERE sent_at IS NULL",
                )
                .run();
            await dispatchOutbox({
                DB: db,
                JOBS: { sendBatch: async () => {} },
            } as unknown as Bindings);
            assert.throws(() =>
                outboxStatement(orm, {
                    ...job,
                    payload: "x".repeat(128_000),
                }),
            );
            await db
                .prepare("UPDATE outbox SET sent_at = NULL WHERE id = ?")
                .bind(retryJob.id)
                .run();

            // Malformed/old-schema/oversized rows cannot block valid successors.
            const poisons = [
                "{",
                JSON.stringify({ ...job, id: crypto.randomUUID(), version: 2 }),
                JSON.stringify({ ...job, payload: "x".repeat(128_000) }),
            ];
            await db.batch(
                poisons.map((body) =>
                    db
                        .prepare(
                            "INSERT INTO outbox (id, body, created_at) VALUES (?, ?, 0)",
                        )
                        .bind(crypto.randomUUID(), body),
                ),
            );
            const survivor = { ...job, id: crypto.randomUUID() };
            await orm.batch([outboxStatement(orm, survivor)]);
            const delivered: unknown[] = [];
            await dispatchOutbox({
                DB: db,
                JOBS: {
                    sendBatch: async (messages: { body: unknown }[]) => {
                        delivered.push(...messages.map((m) => m.body));
                    },
                },
            } as unknown as Bindings);
            assert.ok(
                delivered.some(
                    (item) => (item as { id: string }).id === survivor.id,
                ),
            );
            assert.equal(
                (
                    await db
                        .prepare(
                            "SELECT count(*) AS n FROM outbox WHERE quarantined_at IS NOT NULL",
                        )
                        .first<{ n: number }>()
                )?.n,
                3,
            );
            assert.equal(
                (
                    await db
                        .prepare("SELECT count(*) AS n FROM failed_jobs")
                        .first<{ n: number }>()
                )?.n,
                3,
            );
            // Preserve a pending row for the retention assertion below.
            await db
                .prepare("UPDATE outbox SET sent_at = NULL WHERE id = ?")
                .bind(retryJob.id)
                .run();

            let acknowledged = 0;
            let retried = 0;
            const message = {
                id: "poison-message",
                body: { version: 2 },
                attempts: 1,
                ack: () => {
                    acknowledged++;
                },
                retry: () => {
                    retried++;
                },
            };
            const queueEnv = { DB: db } as unknown as Bindings;
            for (const queue of [
                "edu-jobs",
                "edu-jobs",
                "edu-jobs-dlq-production",
            ]) {
                await consumeJobs(
                    {
                        queue,
                        messages: [message],
                    } as unknown as MessageBatch<unknown>,
                    queueEnv,
                );
            }
            assert.equal(acknowledged, 3);
            assert.equal(retried, 0);
            assert.equal(
                (
                    await db
                        .prepare(
                            "SELECT count(*) AS n FROM failed_jobs WHERE message_id = ?",
                        )
                        .bind(message.id)
                        .first<{ n: number }>()
                )?.n,
                2,
            );
            await consumeJobs(
                {
                    queue: "edu-jobs",
                    messages: [message],
                } as unknown as MessageBatch<unknown>,
                {
                    DB: {
                        prepare: () => {
                            throw new Error("D1 unavailable");
                        },
                    },
                } as unknown as Bindings,
            );
            assert.equal(retried, 1);

            const atomicId = crypto.randomUUID();
            await assert.rejects(
                orm.batch([
                    orm.insert(memberships).values({
                        organizationId,
                        subject: "atomic-rollback",
                        role: "member",
                    }),
                    outboxStatement(orm, { ...job, id: atomicId }),
                    orm.run(sql`INSERT INTO missing_table VALUES (1)`),
                ]),
            );
            assert.equal(
                await db
                    .prepare("SELECT id FROM outbox WHERE id = ?")
                    .bind(atomicId)
                    .first(),
                null,
            );
            assert.equal(
                await db
                    .prepare(
                        "SELECT subject FROM memberships WHERE subject = 'atomic-rollback'",
                    )
                    .first(),
                null,
            );

            const day = 86_400_000;
            const old = Date.now() - 90 * day;
            const oldSentId = crypto.randomUUID();
            const oldProcessedId = crypto.randomUUID();
            await db.batch([
                db
                    .prepare(
                        "INSERT INTO outbox (id, body, created_at, sent_at) VALUES (?, '{}', ?, ?)",
                    )
                    .bind(oldSentId, old, old),
                db
                    .prepare(
                        "INSERT INTO processed_jobs (id, processed_at) VALUES (?, ?)",
                    )
                    .bind(oldProcessedId, old),
            ]);
            const maintenanceEnv = {
                ENVIRONMENT: "development",
                CORS_ORIGINS: "http://localhost:3000",
                DB: db,
            } as unknown as Bindings;
            await cleanupRecords(maintenanceEnv);
            assert.equal(
                await db
                    .prepare("SELECT id FROM outbox WHERE id = ?")
                    .bind(oldSentId)
                    .first(),
                null,
            );
            assert.ok(
                await db
                    .prepare(
                        "SELECT id FROM outbox WHERE id = ? AND sent_at IS NULL",
                    )
                    .bind(retryJob.id)
                    .first(),
            );
            assert.ok(
                await db
                    .prepare("SELECT id FROM processed_jobs WHERE id = ?")
                    .bind(oldProcessedId)
                    .first(),
            );
            await cleanupRecords({
                ...maintenanceEnv,
                PROCESSED_JOBS_RETENTION_DAYS: "60",
            });
            assert.equal(
                await db
                    .prepare("SELECT id FROM processed_jobs WHERE id = ?")
                    .bind(oldProcessedId)
                    .first(),
                null,
            );
            const effect = () =>
                orm.insert(memberships).values({
                    organizationId,
                    subject: "job-user",
                    role: "member",
                });
            await commitJobOnce(orm, job.id, [effect()]);
            await commitJobOnce(orm, job.id, [effect()]);
            assert.equal(
                (
                    await db
                        .prepare(
                            "SELECT count(*) AS n FROM memberships WHERE subject = 'job-user'",
                        )
                        .first<{ n: number }>()
                )?.n,
                1,
            );
            await assert.rejects(
                commitJobOnce(orm, crypto.randomUUID(), [
                    orm.run(sql`INSERT INTO missing_table VALUES (1)`),
                ]),
            );
            assert.equal(
                (
                    await db
                        .prepare("SELECT count(*) AS n FROM processed_jobs")
                        .first<{ n: number }>()
                )?.n,
                1,
            );
            assert.equal(
                (await mf.dispatchFetch(path, { method: "DELETE", headers }))
                    .status,
                204,
            );
            assert.equal(
                (await mf.dispatchFetch(path, { headers })).status,
                404,
            );
        } finally {
            await mf.dispose();
            await new Promise<void>((resolve, reject) =>
                identity.close((error) => (error ? reject(error) : resolve())),
            );
        }
    },
);
