import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { ApiErrorResponse } from "@edu/common/http";
import {
    requestContext,
    requestLogging,
    rateLimit,
} from "./modules/middleware/http";
import { storageRoutes } from "./modules/storage/routes";
import { realtimeRoutes } from "./modules/realtime/routes";
import { authenticate } from "./modules/middleware/auth";
import type { RuntimeConfig } from "./configs/env";
import { createRouter } from "./lib/router";
import { healthResponseSchema } from "@edu/common/http";

export const app = createRouter();

app.use(
    "*",
    requestId({
        generator: () => crypto.randomUUID(),
        headerName: "X-Request-Id",
    }),
);
app.use("*", requestLogging);
app.use("*", secureHeaders());
app.use("*", requestContext);
app.use(
    "*",
    cors({
        origin: (origin, c) =>
            c.get("config").CORS_ORIGINS.includes(origin) ? origin : undefined,
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: [
            "Content-Type",
            "Authorization",
            "Idempotency-Key",
            "If-None-Match",
        ],
        exposeHeaders: ["X-Request-Id", "ETag", "Retry-After"],
        maxAge: 600,
    }),
);
app.use("/v1/*", rateLimit);
const bodyLimits = new WeakMap<RuntimeConfig, ReturnType<typeof bodyLimit>>();
app.use("*", async (c, next) => {
    // Uploads enforce length while streaming; Hono's no-length fallback buffers bodies.
    if (
        c.req.method === "PUT" &&
        /^\/v1\/orgs\/[^/]+\/files\/[^/]+$/.test(c.req.path)
    )
        return next();
    const config = c.get("config");
    let limit = bodyLimits.get(config);
    if (!limit) {
        limit = bodyLimit({
            maxSize: config.MAX_UPLOAD_BYTES,
            onError: () => {
                throw new HTTPException(413);
            },
        });
        bodyLimits.set(config, limit);
    }
    return limit(c, next);
});

app.openapi(
    createRoute({
        method: "get",
        path: "/health",
        tags: ["Operations"],
        responses: {
            200: {
                description: "Liveness",
                content: {
                    "application/json": {
                        schema: healthResponseSchema,
                    },
                },
            },
        },
    }),
    (c) => c.json({ status: "ok" as const }, 200),
);
app.route("/v1", storageRoutes);
app.route("/v1", realtimeRoutes);
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
});
app.use("/openapi.json", authenticate);
app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Edu API", version: "1.0.0" },
});

app.notFound((c) =>
    c.json(
        {
            error: { code: "NOT_FOUND", requestId: c.get("requestId") },
        } satisfies ApiErrorResponse,
        404,
    ),
);
app.onError((error, c) => {
    const status = error instanceof HTTPException ? error.status : 500;
    if (status >= 500)
        console.error(
            JSON.stringify({
                event: "http.error",
                requestId: c.get("requestId"),
                errorType: error.name,
            }),
        );
    return c.json(
        {
            error: {
                code: status >= 500 ? "INTERNAL_ERROR" : `HTTP_${status}`,
                requestId: c.get("requestId"),
            },
        } satisfies ApiErrorResponse,
        status,
    );
});
