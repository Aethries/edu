import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { realtimeEventSchema } from "@edu/common/realtime";
import { requirePermission } from "../middleware/auth";
import type { Bindings } from "../../types";

const sessionSchema = z.object({
    subject: z.string().min(1).max(255),
    organizationId: z.uuid(),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export class RealtimeRoom extends DurableObject<Bindings> {
    private permissionCache: { key: string; expiresAt: number } | undefined;

    private async checkPermission(subject: string, organizationId: string) {
        const key = JSON.stringify([organizationId, subject]);
        if (
            this.permissionCache?.key === key &&
            this.permissionCache.expiresAt > Date.now()
        )
            return;
        // Set freshness from BEFORE the query, never extend it across database latency.
        const expiresAt = Date.now() + 30_000;
        await requirePermission(
            this.env,
            subject,
            organizationId,
            "realtime:connect",
        );
        this.permissionCache = { key, expiresAt };
    }
    async fetch(request: Request): Promise<Response> {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
            return new Response(null, { status: 426 });
        const session = sessionSchema.safeParse({
            subject: request.headers.get("X-Subject"),
            organizationId: request.headers.get("X-Organization"),
            // Internal header comes from the redeemed ticket's verified JWT expiry.
            expiresAt: Number(request.headers.get("X-Session-Expires-At")),
        });
        if (!session.success || session.data.expiresAt <= Date.now())
            return new Response(null, { status: 403 });
        await this.checkPermission(
            session.data.subject,
            session.data.organizationId,
        );
        const sockets = this.ctx.getWebSockets();
        if (
            sockets.length >= 5 ||
            this.ctx.getWebSockets(session.data.subject).length >= 5
        ) {
            return new Response(null, { status: 429 });
        }
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [session.data.subject]);
        pair[1].serializeAttachment(session.data);
        if ((await this.ctx.storage.getAlarm()) === null)
            await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return new Response(null, {
            status: 101,
            webSocket: pair[0],
            headers: { "Sec-WebSocket-Protocol": "edu.v1" },
        });
    }

    // Internal binding RPC only; user input never calls publish directly.
    async publish(input: unknown): Promise<void> {
        const event = realtimeEventSchema.parse(input);
        const message = JSON.stringify(event);
        if (new TextEncoder().encode(message).byteLength > 16_384)
            throw new Error("Realtime event exceeds 16 KiB");
        for (const socket of this.ctx.getWebSockets()) {
            if (!(await this.isAuthorized(socket))) continue;
            try {
                socket.send(message);
            } catch {
                socket.close(1011, "Delivery failed");
            }
        }
    }

    private async isAuthorized(socket: WebSocket) {
        const session = sessionSchema.safeParse(socket.deserializeAttachment());
        if (!session.success || session.data.expiresAt <= Date.now()) {
            socket.close(1008, "Session expired");
            return false;
        }
        try {
            await this.checkPermission(
                session.data.subject,
                session.data.organizationId,
            );
            return true;
        } catch {
            socket.close(1008, "Authorization required");
            return false;
        }
    }

    async alarm(): Promise<void> {
        this.permissionCache = undefined;
        for (const socket of this.ctx.getWebSockets())
            await this.isAuthorized(socket);
        if (this.ctx.getWebSockets().length)
            await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }

    async webSocketMessage(socket: WebSocket): Promise<void> {
        socket.close(1008, "Client messages are not supported");
    }
    async webSocketClose(socket: WebSocket): Promise<void> {
        socket.close(1000, "Connection closed");
    }
    async webSocketError(socket: WebSocket): Promise<void> {
        socket.close(1011, "Connection error");
    }
}
