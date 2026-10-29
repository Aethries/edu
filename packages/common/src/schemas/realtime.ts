import { z } from "zod";

export const realtimeEventSchema = z
    .object({
        id: z.uuid(),
        type: z.string().min(1).max(100),
        data: z.unknown(),
    })
    .strict();

export const realtimeTicketResponseSchema = z.object({
    ticket: z.string(),
    expiresAt: z.number(),
});
export type RealtimeTicketResponse = z.infer<
    typeof realtimeTicketResponseSchema
>;
