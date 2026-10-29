import { z } from "zod";
import { organizationParamsSchema } from "./organizations";

export const fileParamsSchema = organizationParamsSchema.extend({
    fileId: z.uuid(),
});
