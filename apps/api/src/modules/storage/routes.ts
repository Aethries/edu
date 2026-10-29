import { createRoute, z } from "@hono/zod-openapi";
import { fileParamsSchema } from "@edu/common/storage";
import { HTTPException } from "hono/http-exception";
import { authenticate, requirePermission } from "../middleware/auth";
import { storageKey, streamUpload } from "./service";
import { createRouter } from "../../lib/router";

export const storageRoutes = createRouter();
storageRoutes.use("/orgs/:organizationId/files/*", authenticate);
const security = [{ bearerAuth: [] }];
const path = "/orgs/{organizationId}/files/{fileId}";

storageRoutes.openapi(
    createRoute({
        method: "put",
        path,
        security,
        tags: ["Storage"],
        request: {
            params: fileParamsSchema,
            body: {
                required: true,
                content: {
                    "image/png": {
                        schema: z.string().openapi({ format: "binary" }),
                    },
                    "image/jpeg": {
                        schema: z.string().openapi({ format: "binary" }),
                    },
                    "application/pdf": {
                        schema: z.string().openapi({ format: "binary" }),
                    },
                },
            },
        },
        responses: {
            201: {
                description:
                    "Created; IDs are immutable, uploads cannot overwrite files",
            },
        },
    }),
    async (c) => {
        const { organizationId, fileId } = c.req.valid("param");
        await requirePermission(
            c.env,
            c.get("subject"),
            organizationId,
            "files:write",
        );
        const contentType =
            c.req.header("Content-Type")?.split(";")[0].trim() ?? "";
        const upload = streamUpload(
            c.req.raw.body,
            c.req.header("Content-Length"),
            contentType,
            c.get("config").MAX_UPLOAD_BYTES,
        );
        const [piped, stored] = await Promise.allSettled([
            upload.completed,
            c.env.FILES.put(storageKey(organizationId, fileId), upload.body, {
                onlyIf: { etagDoesNotMatch: "*" },
                httpMetadata: { contentType, contentDisposition: "attachment" },
            })
                .then((result) => {
                    if (!result) upload.abort.abort(new HTTPException(409));
                    return result;
                })
                .catch((error: unknown) => {
                    upload.abort.abort(error);
                    throw error;
                }),
        ]);
        if (piped.status === "rejected") throw piped.reason;
        if (stored.status === "rejected") throw stored.reason;
        const result = stored.value;
        if (!result) throw new HTTPException(409);
        return c.body(null, 201);
    },
);

storageRoutes.openapi(
    createRoute({
        method: "get",
        path,
        security,
        tags: ["Storage"],
        request: { params: fileParamsSchema },
        responses: {
            200: { description: "Private file attachment" },
            304: { description: "Not modified; authorization rechecked" },
        },
    }),
    async (c) => {
        const { organizationId, fileId } = c.req.valid("param");
        await requirePermission(
            c.env,
            c.get("subject"),
            organizationId,
            "files:read",
        );
        const object = await c.env.FILES.get(
            storageKey(organizationId, fileId),
        );
        if (!object) throw new HTTPException(404);
        // Recheck authorization before conditional caching; never use a shared cache.
        c.header("Cache-Control", "private, no-cache");
        c.header("ETag", object.httpEtag);
        const etags = c.req
            .header("If-None-Match")
            ?.split(",")
            .map((value) => value.trim().replace(/^W\//, ""));
        if (etags?.includes(object.httpEtag) || etags?.includes("*"))
            return c.body(null, 304);
        c.header(
            "Content-Type",
            object.httpMetadata?.contentType ?? "application/octet-stream",
        );
        c.header("Content-Disposition", `attachment; filename="${fileId}"`);
        c.header("ETag", object.httpEtag);
        return c.body(object.body);
    },
);

storageRoutes.openapi(
    createRoute({
        method: "delete",
        path,
        security,
        tags: ["Storage"],
        request: { params: fileParamsSchema },
        responses: { 204: { description: "Deleted or already absent" } },
    }),
    async (c) => {
        const { organizationId, fileId } = c.req.valid("param");
        await requirePermission(
            c.env,
            c.get("subject"),
            organizationId,
            "files:write",
        );
        await c.env.FILES.delete(storageKey(organizationId, fileId));
        return c.body(null, 204);
    },
);
