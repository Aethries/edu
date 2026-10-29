import axios from "axios";
import { getPublicEnv } from "./env";

// Create per SSR request; a browser may keep one instance. Never use global auth defaults.
export function createApiClient(getAccessToken: () => Promise<string | null>) {
    const client = axios.create({
        baseURL: getPublicEnv().NEXT_PUBLIC_API_URL,
        timeout: 15_000,
        withCredentials: false,
        maxRedirects: 0,
        headers: { Accept: "application/json" },
    });
    client.interceptors.request.use(async (config) => {
        // Prevent accidental bearer-token disclosure to absolute or protocol-relative URLs.
        if (
            !config.url?.startsWith("/") ||
            config.url.startsWith("//") ||
            config.url.includes("\\")
        ) {
            throw new Error(
                "API requests require an absolute path, not an external URL",
            );
        }
        const expected = new URL(getPublicEnv().NEXT_PUBLIC_API_URL).origin;
        const target = new URL(client.getUri(config));
        if (target.origin !== expected)
            throw new Error("External API origins are forbidden");
        const token = await getAccessToken();
        if (token) config.headers.set("Authorization", `Bearer ${token}`);
        else config.headers.delete("Authorization");
        return config;
    });
    // No automatic mutation retries or token refresh loops; the identity SDK owns refresh.
    return client;
}
