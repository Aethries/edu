import { createRemoteJWKSet, jwtVerify } from "jose";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import {
    rolePermissions,
    type Permission,
    type OrganizationRole,
} from "@edu/common/iam";
import type { AppEnv, Bindings } from "../../types";
import type { RuntimeConfig } from "../../configs/env";
import { createDatabase } from "../../db/client";
import { memberships } from "../../db/schema";
import { and, eq } from "drizzle-orm";

let jwksCache:
    { url: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

export async function verifyAccessToken(token: string, config: RuntimeConfig) {
    if (!config.AUTH_ENABLED) throw new HTTPException(503);
    if (jwksCache?.url !== config.AUTH_JWKS_URL) {
        jwksCache = {
            url: config.AUTH_JWKS_URL,
            keys: createRemoteJWKSet(new URL(config.AUTH_JWKS_URL)),
        };
    }
    try {
        const { payload } = await jwtVerify(token, jwksCache.keys, {
            issuer: config.AUTH_ISSUER,
            audience: config.AUTH_AUDIENCE,
            algorithms: ["RS256", "ES256"],
            requiredClaims: ["sub", "exp", "iat"],
            clockTolerance: 5,
        });
        if (!payload.sub || payload.sub.length > 255)
            throw new Error("Invalid subject");
        return { subject: payload.sub, expiresAt: payload.exp! * 1000 };
    } catch {
        throw new HTTPException(401);
    }
}

export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get("config").AUTH_ENABLED) throw new HTTPException(503);
    const match = /^Bearer ([^\s]+)$/i.exec(
        c.req.header("Authorization") ?? "",
    );
    if (!match || match[1].length > 16_384) throw new HTTPException(401);
    const identity = await verifyAccessToken(match[1], c.get("config"));
    c.set("subject", identity.subject);
    c.set("accessTokenExpiresAt", identity.expiresAt);
    await next();
});

export async function requirePermission(
    env: Pick<Bindings, "DB">,
    subject: string,
    organizationId: string,
    permission: Permission,
) {
    const membership = await createDatabase(env.DB)
        .select({ role: memberships.role })
        .from(memberships)
        .where(
            and(
                eq(memberships.organizationId, organizationId),
                eq(memberships.subject, subject),
            ),
        )
        .get();
    const allowed =
        membership && Object.hasOwn(rolePermissions, membership.role)
            ? (rolePermissions[
                  membership.role as OrganizationRole
              ] as readonly Permission[])
            : [];
    if (!allowed.includes(permission)) throw new HTTPException(403);
}
