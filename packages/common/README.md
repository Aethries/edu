# Common

Public contracts shared by `apps/api`, `apps/admin`, and future mobile clients.

```ts
import type { ApiErrorResponse } from "@edu/common/http";
import { realtimeTicketResponseSchema } from "@edu/common/realtime";

// At an Axios caller boundary; do not duplicate the response type.
const ticket = realtimeTicketResponseSchema.parse(response.data);
```

Add `"@edu/common": "*"` to a consuming npm workspace's dependencies.
Keep exports platform-neutral: no Cloudflare, Next.js, Node.js globals, DB entities, credentials, or server-only imports.
Shared schemas cover organization/file IDs, realtime event envelopes, and public permission names. Runtime TypeScript exports require consumer bundling; Next.js `transpilePackages` is configured in admin. Future mobile consumers need Metro workspace configuration.

Schemas are split by existing domain: `http`, `organizations`, `storage`, `realtime`, `iam`. Import their explicit subpaths; root exports remain compatible. Add a domain file/export only when that domain exists. Backend OpenAPI imports these same JSON response schemas; callers infer types from schemas and validate responses at runtime. Shared contracts do not statically verify handwritten URLs/methods or force every consumer to use renamed fields. There are no admin feature API calls yet; add endpoint generation when that surface grows rather than maintaining a duplicate handwritten client registry.
