import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app";
import { parseEnv } from "../src/configs/env";
import { consumeJobs } from "../src/modules/queue/consumer";
import { runScheduled } from "../src/modules/cron/handler";
import { streamUpload } from "../src/modules/storage/service";
import type { Bindings } from "../src/types";

const env = {
    ENVIRONMENT: "development",
    CORS_ORIGINS: "http://localhost:3000",
    DB: {},
    API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    MAX_UPLOAD_BYTES: "1048576",
} as unknown as Bindings;

test("protected routes fail closed when authentication is disabled", async () => {
    const response = await app.request(
        `/v1/orgs/${crypto.randomUUID()}/files/${crypto.randomUUID()}`,
        {},
        env,
    );
    assert.equal(response.status, 503);
});

test("native rate limits return 429 with retry instructions", async () => {
    const response = await app.request("/v1/anything", {}, {
        ...env,
        API_RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as Bindings);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
});

test("streaming uploads require bounded valid length and supported content type", () => {
    const body = () => new ReadableStream<Uint8Array>();
    for (const length of [
        undefined,
        "",
        "-1",
        "abc",
        "0",
        "11",
        "9007199254740992",
    ]) {
        assert.throws(() => streamUpload(body(), length, "image/png", 10));
    }
    assert.throws(() => streamUpload(body(), "8", "text/html", 10));
    assert.throws(() => streamUpload(null, "8", "image/png", 10));
});

test("health has security headers, request correlation, and allowlisted CORS", async () => {
    const response = await app.request(
        "/health",
        { headers: { Origin: "http://localhost:3000" } },
        env,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.equal(
        response.headers.get("Access-Control-Allow-Origin"),
        "http://localhost:3000",
    );
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.ok(response.headers.get("X-Request-Id"));
});

test("untrusted origins are not allowed by CORS", async () => {
    const response = await app.request(
        "/health",
        { headers: { Origin: "https://untrusted.example" } },
        env,
    );
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("errors have a consistent shape without exposing internals", async () => {
    const response = await app.request("/missing", {}, env);
    assert.equal(response.status, 404);
    const body = (await response.json()) as {
        error: { code: string; requestId: string };
    };
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(body.error.requestId, response.headers.get("X-Request-Id"));
    const invalid = await app.request("/health", {}, {
        ...env,
        ENVIRONMENT: "invalid",
    } as unknown as Bindings);
    assert.equal(invalid.status, 500);
    assert.equal(
        ((await invalid.json()) as { error: { code: string } }).error.code,
        "INTERNAL_ERROR",
    );
});

test("oversized request bodies are rejected", async () => {
    const response = await app.request(
        "/missing",
        {
            method: "POST",
            body: "x".repeat(1024 * 1024 + 1),
        },
        env,
    );
    assert.equal(response.status, 413);
});

test("environment rejects wildcard and malformed origins", () => {
    for (const origin of ["*", "https://admin.example/path", "", "not-a-url"]) {
        assert.throws(() => parseEnv({ ...env, CORS_ORIGINS: origin }));
    }
});

test("failed poison-message archival retries instead of losing messages", async () => {
    let retries = 0;
    let acknowledgements = 0;
    const bodies = [
        null,
        {
            version: 1,
            id: crypto.randomUUID(),
            type: "unregistered",
            payload: {},
        },
    ];
    const batch = {
        queue: "edu-jobs",
        messages: bodies.map((body) => ({
            id: crypto.randomUUID(),
            body,
            retry: () => {
                retries++;
            },
            ack: () => {
                acknowledgements++;
            },
        })),
    } as unknown as MessageBatch<unknown>;
    await consumeJobs(batch, env);
    assert.equal(retries, 2);
    assert.equal(acknowledgements, 0);
});

test("unknown cron schedules fail visibly", async () => {
    await assert.rejects(
        runScheduled(
            {
                cron: "0 0 * * *",
                scheduledTime: Date.now(),
            } as ScheduledController,
            env,
        ),
        /Unregistered/,
    );
});
