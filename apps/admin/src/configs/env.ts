import { z } from "zod";

const schema = z.object({
    NEXT_PUBLIC_API_URL: z.url().refine((value) => {
        const url = new URL(value);
        return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
        );
    }),
});

export function getPublicEnv() {
    // Explicit access is required for Next.js build-time public variable replacement.
    return schema.parse({
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    });
}
