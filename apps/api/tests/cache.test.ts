import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { publicCache } from "../src/modules/middleware/cache";
import type { AppEnv } from "../src/types";
import { requestContext, requestLogging } from "../src/modules/middleware/http";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";

test("public cache reuses safe responses, bypasses credentials, excludes private data", async () => {
    const saved = new Map<string, Response>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
    Object.defineProperty(globalThis, "caches", {
        configurable: true,
        value: {
            default: {
                match: async (request: Request) =>
                    saved.get(request.url)?.clone(),
                put: async (request: Request, response: Response) => {
                    saved.set(request.url, response);
                },
            },
        },
    });
    try {
        const app = new Hono<AppEnv>();
        let calls = 0;
        app.use("*", requestId());
        app.use("*", requestLogging);
        app.use("*", requestContext);
        app.use(
            "*",
            cors({
                origin: (origin, c) =>
                    c.get("config").CORS_ORIGINS.includes(origin)
                        ? origin
                        : undefined,
            }),
        );
        app.use("*", publicCache(60));
        app.get("/public", (c) => c.json({ calls: ++calls }));
        app.get("/private", (c) => {
            c.header("Cache-Control", "private, no-store");
            return c.text("private");
        });
        app.get("/vary", (c) => {
            c.header("Vary", "Accept-Language");
            return c.text("varies");
        });
        app.get("/cookie", (c) => {
            c.header("Set-Cookie", "session=private");
            return c.text("private");
        });
        const pending: Promise<unknown>[] = [];
        const context = {
            waitUntil: (promise: Promise<unknown>) => {
                pending.push(promise);
            },
            passThroughOnException() {},
            props: {},
        };
        const request = (path: string, headers?: Record<string, string>) =>
            app.request(
                path,
                { headers },
                {
                    ENVIRONMENT: "development",
                    CORS_ORIGINS: "http://localhost:3000,http://localhost:3001",
                    DB: {},
                } as AppEnv["Bindings"],
                context,
            );
        assert.deepEqual(await (await request("/public")).json(), { calls: 1 });
        await Promise.all(pending);
        assert.deepEqual(await (await request("/public")).json(), { calls: 1 });
        assert.deepEqual(
            await (
                await request("/public", { Authorization: "Bearer token" })
            ).json(),
            { calls: 2 },
        );
        assert.deepEqual(
            await (
                await request("/public", { Cookie: "session=private" })
            ).json(),
            { calls: 3 },
        );
        await request("/private");
        await request("/vary");
        await request("/cookie");
        assert.equal(saved.size, 1);
        const first = await request("/public", {
            Origin: "http://localhost:3000",
        });
        assert.equal(
            first.headers.get("Access-Control-Allow-Origin"),
            "http://localhost:3000",
        );
        assert.equal(first.headers.get("Cache-Control"), "public, max-age=60");
        const firstId = first.headers.get("X-Request-Id");
        assert.deepEqual(await first.json(), { calls: 4 });
        await Promise.all(pending);
        const hit = await request("/public", {
            Origin: "http://localhost:3000",
        });
        assert.deepEqual(await hit.json(), { calls: 4 });
        assert.notEqual(hit.headers.get("X-Request-Id"), firstId);
        assert.equal(
            hit.headers.get("Access-Control-Allow-Origin"),
            "http://localhost:3000",
        );
        assert.deepEqual(
            await (
                await request("/public", { Origin: "http://localhost:3001" })
            ).json(),
            { calls: 5 },
        );
        const denied = await request("/public", {
            Origin: "https://evil.example",
        });
        assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
        assert.equal(denied.headers.get("Cache-Control"), "no-store");
    } finally {
        if (original) Object.defineProperty(globalThis, "caches", original);
        else Reflect.deleteProperty(globalThis, "caches");
    }
});
