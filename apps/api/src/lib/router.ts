import { OpenAPIHono } from "@hono/zod-openapi";
import type { ApiErrorResponse } from "@edu/common/http";
import type { AppEnv } from "../types";

export function createRouter() {
    return new OpenAPIHono<AppEnv>({
        defaultHook: (result, c) => {
            if (!result.success)
                return c.json(
                    {
                        error: {
                            code: "VALIDATION_ERROR",
                            requestId: c.get("requestId"),
                        },
                    } satisfies ApiErrorResponse,
                    400,
                );
        },
    });
}
