import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });
const schema = z
    .object({
        ENVIRONMENT: z.enum(["development", "staging", "production"]),
        CORS_ORIGINS: z.string().transform((value, ctx) => {
            const origins = value.split(",").map((origin) => origin.trim());
            if (
                origins.some((origin) => {
                    try {
                        const url = new URL(origin);
                        return (
                            !["http:", "https:"].includes(url.protocol) ||
                            url.origin !== origin
                        );
                    } catch {
                        return true;
                    }
                })
            ) {
                ctx.addIssue({
                    code: "custom",
                    message: "Use exact HTTP(S) origins",
                });
                return z.NEVER;
            }
            return origins;
        }),
        AUTH_ENABLED: z
            .enum(["true", "false"])
            .default("false")
            .transform((value) => value === "true"),
        AUTH_ISSUER: z.union([httpUrl, z.literal("")]).default(""),
        AUTH_AUDIENCE: z.string().default(""),
        AUTH_JWKS_URL: z.union([httpUrl, z.literal("")]).default(""),
        MAX_UPLOAD_BYTES: z.coerce
            .number()
            .int()
            .min(1)
            .max(10 * 1024 * 1024)
            .default(5 * 1024 * 1024),
        REALTIME_TICKET_TTL_SECONDS: z.coerce
            .number()
            .int()
            .min(10)
            .max(60)
            .default(30),
        OUTBOX_RETENTION_DAYS: z.coerce
            .number()
            .int()
            .min(1)
            .max(3650)
            .default(30),
        // ponytail: preserve deduplication forever until the job replay window is defined.
        PROCESSED_JOBS_RETENTION_DAYS: z.coerce
            .number()
            .int()
            .refine((days) => days === 0 || (days >= 30 && days <= 3650))
            .default(0),
    })
    .superRefine((config, ctx) => {
        if (
            config.AUTH_ENABLED &&
            (!config.AUTH_ISSUER ||
                !config.AUTH_AUDIENCE ||
                !config.AUTH_JWKS_URL)
        ) {
            ctx.addIssue({
                code: "custom",
                message:
                    "Enabled authentication requires issuer, audience, JWKS URL",
            });
        }
        if (config.ENVIRONMENT !== "development") {
            if (
                !config.AUTH_ENABLED ||
                config.CORS_ORIGINS.some(
                    (origin) => !origin.startsWith("https://"),
                )
            ) {
                ctx.addIssue({
                    code: "custom",
                    message:
                        "Deployed environments require authentication and HTTPS origins",
                });
            }
            if (
                !config.AUTH_ISSUER.startsWith("https://") ||
                !config.AUTH_JWKS_URL.startsWith("https://")
            ) {
                ctx.addIssue({
                    code: "custom",
                    message: "Deployed identity endpoints require HTTPS",
                });
            }
        }
    });

export type RuntimeConfig = z.output<typeof schema>;
const configCache = new WeakMap<object, RuntimeConfig>();
export function parseEnv(env: unknown): RuntimeConfig {
    if (typeof env !== "object" || env === null) return schema.parse(env);
    let config = configCache.get(env);
    if (!config) {
        config = schema.parse(env);
        configCache.set(env, config);
    }
    return config;
}
