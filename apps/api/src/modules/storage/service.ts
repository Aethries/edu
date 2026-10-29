import { HTTPException } from "hono/http-exception";

const signatures: Record<string, (bytes: Uint8Array) => boolean> = {
    "image/png": (b) =>
        [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => b[i] === value),
    "image/jpeg": (b) => b[0] === 255 && b[1] === 216 && b[2] === 255,
    "application/pdf": (b) =>
        new TextDecoder().decode(b.slice(0, 5)) === "%PDF-",
};

export function storageKey(organizationId: string, fileId: string) {
    return `organizations/${organizationId}/files/${fileId}`;
}

export function streamUpload(
    body: ReadableStream<Uint8Array> | null,
    contentLength: string | undefined,
    contentType: string,
    maxBytes: number,
) {
    // ponytail: known-length uploads up to 10 MiB; add direct multipart for larger/unknown-length files.
    if (contentLength === undefined) throw new HTTPException(411);
    if (!/^\d+$/.test(contentLength)) throw new HTTPException(400);
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 1 || length > maxBytes)
        throw new HTTPException(413);
    if (!body) throw new HTTPException(400);
    if (!Object.hasOwn(signatures, contentType)) throw new HTTPException(415);
    const prefix = new Uint8Array(Math.min(8, length));
    let prefixBytes = 0;
    let received = 0;
    let lastByte: Uint8Array | undefined;
    const validated = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                received += chunk.byteLength;
                if (received > length) throw new HTTPException(413);
                if (prefixBytes < prefix.length) {
                    const take = Math.min(
                        prefix.length - prefixBytes,
                        chunk.byteLength,
                    );
                    prefix.set(chunk.subarray(0, take), prefixBytes);
                    prefixBytes += take;
                    if (prefixBytes < prefix.length) return;
                    if (!signatures[contentType](prefix))
                        throw new HTTPException(415);
                    if (length <= prefix.length) {
                        controller.enqueue(prefix.subarray(0, -1));
                        lastByte = prefix.slice(-1);
                    } else controller.enqueue(prefix);
                    chunk = chunk.subarray(take);
                }
                if (chunk.byteLength) {
                    if (received === length) {
                        controller.enqueue(chunk.subarray(0, -1));
                        lastByte = chunk.slice(-1);
                    } else controller.enqueue(chunk);
                }
            },
            flush(controller) {
                if (received !== length) throw new HTTPException(400);
                // R2 can commit as soon as it receives the declared length. Release
                // the final byte only after clean EOF, never from transform().
                if (lastByte) controller.enqueue(lastByte);
            },
        }),
    );
    // R2 requires a known-length stream; retain the commit byte until validation completes.
    const fixed = new FixedLengthStream(length);
    const abort = new AbortController();
    return {
        body: fixed.readable,
        completed: validated.pipeTo(fixed.writable, { signal: abort.signal }),
        abort,
    };
}
