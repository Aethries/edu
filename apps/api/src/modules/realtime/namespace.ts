import type { Bindings } from "../../types";

export function getUserRoom(
    env: Pick<Bindings, "REALTIME">,
    organizationId: string,
    subject: string,
) {
    // Tuple encoding avoids collisions when subjects contain ':' or other delimiters.
    return env.REALTIME.get(
        env.REALTIME.idFromName(JSON.stringify([organizationId, subject])),
    );
}
