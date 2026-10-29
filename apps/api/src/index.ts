import { app } from "./app";
import { consumeJobs } from "./modules/queue/consumer";
import { runScheduled } from "./modules/cron/handler";
import type { Bindings } from "./types";

export { RealtimeRoom } from "./modules/realtime/room";

export default {
    fetch: app.fetch,
    queue: consumeJobs,
    scheduled: runScheduled,
} satisfies ExportedHandler<Bindings>;
