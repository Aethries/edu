import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types";
import { parseEnv } from "../../configs/env";
import { createDatabase } from "../../db/client";

export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
    c.set("config", parseEnv(c.env));
    c.set("db", createDatabase(c.env.DB));
    await next();
});

export const requestLogging = createMiddleware<AppEnv>(async (c, next) => {
    const start = performance.now();
    c.header("Cache-Control", "no-store");
    await next();
    console.log(
        JSON.stringify({
            event: "http.request",
            requestId: c.get("requestId"),
            method: c.req.method,
            status: c.res.status,
            durationMs: Math.round(performance.now() - start),
        }),
    );
});

export const rateLimit = createMiddleware<AppEnv>(async (c, next) => {
    // Cloudflare overwrites this header at the edge. Local fallback is intentionally shared.
    const key = c.req.header("CF-Connecting-IP") ?? "local";
    const { success } = await c.env.API_RATE_LIMITER.limit({ key });
    if (!success) {
        c.header("Retry-After", "60");
        throw new HTTPException(429);
    }
    await next();
});
