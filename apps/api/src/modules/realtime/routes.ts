import { createRoute } from "@hono/zod-openapi";
import { organizationParamsSchema } from "@edu/common/organizations";
import { HTTPException } from "hono/http-exception";
import { authenticate, requirePermission } from "../middleware/auth";
import { hashTicket } from "./tickets";
import { getUserRoom } from "./namespace";
import { createRouter } from "../../lib/router";
import { realtimeTicketResponseSchema } from "@edu/common/realtime";
import { realtimeTickets } from "../../db/schema";
import { and, eq, gt } from "drizzle-orm";

export const realtimeRoutes = createRouter();

realtimeRoutes.openapi(
    createRoute({
        method: "post",
        path: "/orgs/{organizationId}/realtime/tickets",
        tags: ["Realtime"],
        security: [{ bearerAuth: [] }],
        middleware: [authenticate],
        request: { params: organizationParamsSchema },
        responses: {
            201: {
                description: "Single-use WebSocket ticket",
                content: {
                    "application/json": {
                        schema: realtimeTicketResponseSchema,
                    },
                },
            },
        },
    }),
    async (c) => {
        const { organizationId } = c.req.valid("param");
        await requirePermission(
            c.env,
            c.get("subject"),
            organizationId,
            "realtime:connect",
        );
        const origin = c.req.header("Origin") ?? "";
        if (
            c.req.header("Origin") !== undefined &&
            !c.get("config").CORS_ORIGINS.includes(origin)
        )
            throw new HTTPException(403);
        const ticket = crypto.randomUUID() + crypto.randomUUID();
        const expiresAt =
            Date.now() + c.get("config").REALTIME_TICKET_TTL_SECONDS * 1000;
        await c
            .get("db")
            .insert(realtimeTickets)
            .values({
                hash: await hashTicket(ticket),
                subject: c.get("subject"),
                organizationId,
                origin,
                expiresAt,
                sessionExpiresAt: c.get("accessTokenExpiresAt"),
            });
        return c.json({ ticket, expiresAt }, 201);
    },
);

realtimeRoutes.get("/orgs/:organizationId/realtime", async (c) => {
    if (!c.get("config").AUTH_ENABLED) throw new HTTPException(503);
    const parsed = organizationParamsSchema.safeParse(c.req.param());
    if (!parsed.success) throw new HTTPException(400);
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
        throw new HTTPException(426);
    const origin = c.req.header("Origin") ?? "";
    if (
        c.req.header("Origin") !== undefined &&
        !c.get("config").CORS_ORIGINS.includes(origin)
    )
        throw new HTTPException(403);
    const protocols = (c.req.header("Sec-WebSocket-Protocol") ?? "")
        .split(",")
        .map((value) => value.trim());
    const ticket = protocols
        .find((value) => value.startsWith("edu-ticket."))
        ?.slice(11);
    if (
        !protocols.includes("edu.v1") ||
        !ticket ||
        !/^[a-f0-9-]{72}$/.test(ticket)
    )
        throw new HTTPException(401);
    const { organizationId } = parsed.data;
    const stored = await c
        .get("db")
        .delete(realtimeTickets)
        .where(
            and(
                eq(realtimeTickets.hash, await hashTicket(ticket)),
                eq(realtimeTickets.organizationId, organizationId),
                eq(realtimeTickets.origin, origin),
                gt(realtimeTickets.expiresAt, Date.now()),
            ),
        )
        .returning({
            subject: realtimeTickets.subject,
            sessionExpiresAt: realtimeTickets.sessionExpiresAt,
        })
        .get();
    if (!stored || stored.sessionExpiresAt <= Date.now())
        throw new HTTPException(401);
    await requirePermission(
        c.env,
        stored.subject,
        organizationId,
        "realtime:connect",
    );
    const room = getUserRoom(c.env, organizationId, stored.subject);
    // Construct internal headers; never forward user-supplied identity headers.
    return room.fetch(
        new Request("https://realtime.internal/", {
            headers: {
                Upgrade: "websocket",
                "X-Subject": stored.subject,
                "X-Session-Expires-At": String(stored.sessionExpiresAt),
                "X-Organization": organizationId,
            },
        }),
    );
});
