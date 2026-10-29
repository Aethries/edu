import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiClient } from "./http";

test("Axios attaches current bearer tokens and prevents external URL leaks", async () => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:8787";
    let token: string | null = "first";
    const client = createApiClient(async () => token);
    client.defaults.adapter = async (config) => ({
        data: config.headers.get("Authorization"),
        status: 200,
        statusText: "OK",
        headers: {},
        config,
    });
    assert.equal((await client.get("/health")).data, "Bearer first");
    token = "second";
    assert.equal((await client.get("/health")).data, "Bearer second");
    token = null;
    assert.equal((await client.get("/health")).data, undefined);
    await assert.rejects(client.get("https://untrusted.example/"));
    await assert.rejects(client.get("//untrusted.example/"));
    await assert.rejects(
        client.get("/health", { baseURL: "https://untrusted.example" }),
    );
});
