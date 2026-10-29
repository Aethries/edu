import type { RealtimeRoom } from "./modules/realtime/room";
import type { Database } from "./db/client";
import type { RuntimeConfig } from "./configs/env";

export type Bindings = Omit<Cloudflare.Env, "JOBS" | "REALTIME"> & {
    JOBS: Queue<unknown>;
    REALTIME: DurableObjectNamespace<RealtimeRoom>;
};

export type AppEnv = {
    Bindings: Bindings;
    Variables: {
        requestId: string;
        db: Database;
        config: RuntimeConfig;
        subject: string;
        accessTokenExpiresAt: number;
    };
};
