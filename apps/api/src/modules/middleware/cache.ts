import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../../types";

// Opt-in public GET routes only. Cache API is per data center.
export function publicCache(seconds: number) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
        throw new Error("Cache TTL must be 1–3600 seconds");
    return createMiddleware<AppEnv>(async (c, next) => {
        if (
            c.req.method !== "GET" ||
            c.req.header("Authorization") !== undefined ||
            c.req.header("Cookie") !== undefined
        )
            return next();
        // Cache API does not partition by Vary: Origin. Encode the variant in its key.
        const url = new URL(c.req.url);
        const origin = c.req.header("Origin") ?? "";
        if (origin && !c.get("config").CORS_ORIGINS.includes(origin))
            return next();
        url.searchParams.set(
            "__edu_public_cache",
            JSON.stringify([c.req.url, origin]),
        );
        const key = new Request(url);
        const cached = await caches.default.match(key);
        if (cached) {
            c.res = new Response(cached.body, cached);
            c.header("X-Request-Id", c.get("requestId"));
            return;
        }
        c.header("Cache-Control", `public, max-age=${seconds}`);
        await next();
        if (
            c.res.status !== 200 ||
            c.res.headers.has("Set-Cookie") ||
            (c.res.headers.get("Vary") ?? "")
                .split(",")
                .some(
                    (value) =>
                        value.trim() !== "" &&
                        value.trim().toLowerCase() !== "origin",
                )
        ) {
            c.header("Cache-Control", "no-store");
            return;
        }
        const control = c.res.headers.get("Cache-Control") ?? "";
        if (/private|no-store/i.test(control)) return;
        c.header("Cache-Control", `public, max-age=${seconds}`);
        const response = c.res.clone();
        response.headers.delete("X-Request-Id");
        c.executionCtx.waitUntil(caches.default.put(key, response));
    });
}
