import {
    defaultShouldDehydrateQuery,
    environmentManager,
    QueryClient,
} from "@tanstack/react-query";

export function createQueryClient() {
    return new QueryClient({
        defaultOptions: {
            queries: { staleTime: 60_000 },
            dehydrate: {
                shouldDehydrateQuery: (query) =>
                    defaultShouldDehydrateQuery(query) ||
                    query.state.status === "pending",
                // Let Next.js handle server errors and redact production details.
                shouldRedactErrors: () => false,
            },
        },
    });
}

let browserQueryClient: QueryClient | undefined;

export function getQueryClient() {
    // Never share cached data between server requests.
    if (environmentManager.isServer()) return createQueryClient();

    // Survive an initial render that suspends before the provider mounts.
    return (browserQueryClient ??= createQueryClient());
}
