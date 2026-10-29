export async function hashTicket(ticket: string) {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(ticket),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
}
