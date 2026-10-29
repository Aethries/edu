import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import ts from "typescript";

test(
    "R2 commits uploads only after clean EOF, never after trailing errors or excess bytes",
    { timeout: 30_000 },
    async () => {
        // Run the real helper inside workerd, without HTTP framing hiding trailing bytes/errors.
        const source = await readFile("src/modules/storage/service.ts", "utf8");
        const service = ts.transpileModule(
            source.replace('"hono/http-exception"', '"./exception.js"'),
            {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.ESNext,
                },
            },
        ).outputText;
        const mf = new Miniflare(
            convertV4MiniflareOptions({
                compatibilityDate: "2026-10-29",
                modules: [
                    {
                        type: "ESModule",
                        path: "upload-test.js",
                        contents: `
                import { streamUpload } from './service.js';
                export default { async fetch(request, env) {
                    const mode = new URL(request.url).pathname.slice(1);
                    const key = mode === 'retry' ? 'error' : mode;
                    const png = [137, 80, 78, 71, 13, 10, 26, 10, 0];
                    const bytes = new Uint8Array(mode.includes('jpeg') ? [255, 216, 255]
                        : mode.includes('pdf') ? [37, 80, 68, 70, 45]
                        : mode.includes('png8') ? png.slice(0, 8) : png);
                    const contentType = mode.includes('jpeg') ? 'image/jpeg' : mode.includes('pdf') ? 'application/pdf' : 'image/png';
                    let offset = 0;
                    let extraSent = false;
                    const source = new ReadableStream({ async pull(controller) {
                        const end = mode === 'short' ? bytes.length - 1 : bytes.length;
                        if (offset < end) {
                            const next = mode.includes('fragmented') ? offset + 1 : end;
                            controller.enqueue(bytes.subarray(offset, next));
                            offset = next;
                            return;
                        }
                        // Let R2 consume the declared body before the source completes.
                        await new Promise(resolve => setTimeout(resolve, 20));
                        if (mode.startsWith('error')) controller.error(new Error('source failed after declared length'));
                        else if (mode.startsWith('extra') && !extraSent) { extraSent = true; controller.enqueue(new Uint8Array([1])); }
                        else controller.close();
                    }});
                    const upload = streamUpload(source, String(bytes.length), contentType, 10);
                    const results = await Promise.allSettled([
                        upload.completed,
                        env.FILES.put(key, upload.body, { onlyIf: { etagDoesNotMatch: '*' } }),
                    ]);
                    return Response.json({ statuses: results.map(result => result.status) });
                }};
            `,
                    },
                    { type: "ESModule", path: "service.js", contents: service },
                    {
                        type: "ESModule",
                        path: "exception.js",
                        contents: await readFile(
                            "../../node_modules/hono/dist/http-exception.js",
                            "utf8",
                        ),
                    },
                ],
                r2Buckets: ["FILES"],
            }),
        );
        try {
            const bucket = (await mf.getR2Bucket(
                "FILES",
            )) as unknown as R2Bucket;
            for (const mode of [
                "error",
                "extra",
                "short",
                "error-fragmented",
                "extra-fragmented",
                "error-png8",
                "extra-jpeg",
                "error-pdf",
            ]) {
                const response = await mf.dispatchFetch(
                    `http://localhost/${mode}`,
                );
                const result = (await response.json()) as {
                    statuses: string[];
                };
                assert.deepEqual(
                    result.statuses,
                    ["rejected", "rejected"],
                    mode,
                );
                assert.equal(
                    await bucket.head(mode),
                    null,
                    `${mode}: failed upload left an object`,
                );
            }
            for (const [mode, size] of [
                ["valid", 9],
                ["retry", 9],
                ["valid-fragmented", 9],
                ["valid-png8-fragmented", 8],
                ["valid-jpeg-fragmented", 3],
                ["valid-pdf-fragmented", 5],
            ] as const) {
                const response = await mf.dispatchFetch(
                    `http://localhost/${mode}`,
                );
                assert.deepEqual(await response.json(), {
                    statuses: ["fulfilled", "fulfilled"],
                });
                assert.equal(
                    (await bucket.head(mode === "retry" ? "error" : mode))
                        ?.size,
                    size,
                    mode,
                );
                const object = await bucket.get(
                    mode === "retry" ? "error" : mode,
                );
                assert.ok(object);
                const expected = mode.includes("jpeg")
                    ? [255, 216, 255]
                    : mode.includes("pdf")
                      ? [37, 80, 68, 70, 45]
                      : [137, 80, 78, 71, 13, 10, 26, 10, 0].slice(0, size);
                assert.deepEqual(
                    [...new Uint8Array(await object.arrayBuffer())],
                    expected,
                    mode,
                );
            }
        } finally {
            await mf.dispose();
        }
    },
);
