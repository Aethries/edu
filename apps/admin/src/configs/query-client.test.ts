import assert from "node:assert/strict";
import { test } from "node:test";
import { dehydrate } from "@tanstack/react-query";
import { createQueryClient, getQueryClient } from "./query-client";

test("server query clients isolate data; pending queries support streaming", async () => {
    const first = getQueryClient();
    const second = getQueryClient();
    assert.notEqual(first, second);
    first.setQueryData(["private"], "private");
    assert.equal(second.getQueryData(["private"]), undefined);
    const client = createQueryClient();
    let resolve!: (value: string) => void;
    const pending = client.prefetchQuery({
        queryKey: ["pending"],
        queryFn: () =>
            new Promise<string>((done) => {
                resolve = done;
            }),
    });
    assert.equal(dehydrate(client).queries[0].state.status, "pending");
    resolve("done");
    await pending;
    first.clear();
    second.clear();
    client.clear();
});
