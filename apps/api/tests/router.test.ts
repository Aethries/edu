import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoute, z } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import { createRouter } from "../src/lib/router";
import { realtimeTicketResponseSchema } from "@edu/common/realtime";

test("router factory preserves validation errors across mounted modules", async () => {
    const app = createRouter();
    const module = createRouter();
    app.use("*", requestId());
    module.openapi(
        createRoute({
            method: "post",
            path: "/tickets",
            request: {
                body: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: z.object({ organizationId: z.uuid() }),
                        },
                    },
                },
            },
            responses: {
                201: {
                    description: "Ticket",
                    content: {
                        "application/json": {
                            schema: realtimeTicketResponseSchema,
                        },
                    },
                },
            },
        }),
        (c) => c.json({ ticket: "test", expiresAt: 123 }, 201),
    );
    app.route("/module", module);
    const send = (body: unknown) =>
        app.request("/module/tickets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    const invalid = await send({ organizationId: "invalid" });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {
        error: {
            code: "VALIDATION_ERROR",
            requestId: invalid.headers.get("X-Request-Id"),
        },
    });
    const valid = await send({ organizationId: crypto.randomUUID() });
    assert.equal(valid.status, 201);
    assert.deepEqual(realtimeTicketResponseSchema.parse(await valid.json()), {
        ticket: "test",
        expiresAt: 123,
    });
});
