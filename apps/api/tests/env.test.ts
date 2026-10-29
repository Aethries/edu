import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "../src/configs/env";
import { readFile } from "node:fs/promises";
import ts from "typescript";

test("Wrangler environments keep variables, bindings, queues and schedules aligned", async () => {
    const configs = await Promise.all(
        [
            "wrangler.jsonc",
            "wrangler.staging.jsonc",
            "wrangler.production.jsonc",
        ].map(async (file) => {
            const parsed = ts.parseConfigFileTextToJson(
                file,
                await readFile(file, "utf8"),
            );
            assert.equal(parsed.error, undefined, `${file}: invalid JSONC`);
            return parsed.config as Record<string, unknown> & {
                vars: Record<string, string>;
            };
        }),
    );
    const shape = (config: (typeof configs)[number]) => {
        const suffix =
            config.vars.ENVIRONMENT === "development"
                ? ""
                : `-${config.vars.ENVIRONMENT}`;
        const normalize = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(normalize);
            if (value && typeof value === "object")
                return Object.fromEntries(
                    Object.entries(value)
                        .filter(
                            ([key]) =>
                                !["database_id", "namespace_id"].includes(key),
                        )
                        .map(([key, item]) => [
                            key,
                            [
                                "database_name",
                                "bucket_name",
                                "queue",
                                "dead_letter_queue",
                            ].includes(key) &&
                            typeof item === "string" &&
                            suffix &&
                            item.endsWith(suffix)
                                ? item.slice(0, -suffix.length)
                                : normalize(item),
                        ]),
                );
            return value;
        };
        return {
            vars: Object.keys(config.vars).sort(),
            ...Object.fromEntries(
                [
                    "d1_databases",
                    "r2_buckets",
                    "queues",
                    "triggers",
                    "durable_objects",
                    "exports",
                    "ratelimits",
                    "compatibility_date",
                ].map((key) => [key, normalize(config[key])]),
            ),
        };
    };
    for (const config of configs) {
        parseEnv(config.vars);
        assert.deepEqual(shape(config), shape(configs[0]));
    }
});

test("configuration is cached per binding object, isolated across deployments", () => {
    const env = {
        ENVIRONMENT: "development",
        CORS_ORIGINS: "http://localhost:3000",
    };
    assert.equal(parseEnv(env), parseEnv(env));
    assert.notEqual(parseEnv(env), parseEnv({ ...env }));
    assert.deepEqual(
        parseEnv({ ...env, CORS_ORIGINS: "http://localhost:3001" })
            .CORS_ORIGINS,
        ["http://localhost:3001"],
    );
});

test("production configuration rejects disabled identity and insecure origins", () => {
    assert.throws(() =>
        parseEnv({
            ENVIRONMENT: "production",
            CORS_ORIGINS: "https://admin.example.com",
            AUTH_ENABLED: "false",
        }),
    );
    const valid = {
        ENVIRONMENT: "production",
        CORS_ORIGINS: "https://admin.example.com",
        AUTH_ENABLED: "true",
        AUTH_ISSUER: "https://identity.example.com/",
        AUTH_AUDIENCE: "edu-api",
        AUTH_JWKS_URL: "https://identity.example.com/jwks",
    };
    assert.equal(parseEnv(valid).AUTH_ENABLED, true);
    assert.throws(() =>
        parseEnv({ ...valid, CORS_ORIGINS: "http://admin.example.com" }),
    );
    assert.throws(() =>
        parseEnv({
            ...valid,
            AUTH_JWKS_URL: "http://identity.example.com/jwks",
        }),
    );
});
