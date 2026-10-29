import assert from "node:assert/strict";
import { test } from "node:test";
import { getUserRoom } from "../src/modules/realtime/namespace";
import type { Bindings } from "../src/types";

test("realtime rooms isolate organization/subject without delimiter collisions", () => {
    const env = {
        REALTIME: {
            idFromName: (name: string) => name,
            get: (id: string) => id,
        },
    } as unknown as Bindings;
    assert.equal(
        getUserRoom(env, "org", "user"),
        getUserRoom(env, "org", "user"),
    );
    assert.notEqual(
        getUserRoom(env, "org", "user"),
        getUserRoom(env, "org", "other"),
    );
    assert.notEqual(
        getUserRoom(env, "org", "user"),
        getUserRoom(env, "other", "user"),
    );
    assert.notEqual(getUserRoom(env, "a:b", "c"), getUserRoom(env, "a", "b:c"));
});
