# Admin

Next.js App Router, TypeScript, Tailwind CSS v4, Animate UI (Base UI only).

From the repository root:

```sh
npm run dev --workspace @edu/admin
npm run lint
npm run typecheck
npm run test --workspace @edu/admin
npm run build
```

## Structure

- `src/app`: route entry points, global CSS. Keep routes thin.
- `src/components`: shared components and providers; `ui/` contains UI primitives.
- `src/types`: shared types.
- `src/utils`: shared helpers.
- `src/constants`: shared constants; define routes in `routes.ts`.
- `src/configs`: app-specific configuration.
- `src/features`: feature-private `components/`, `hooks/`, `constants/`, `pages/`, `types/`, `schemas/`. Create only what a feature needs.
- `src/hooks`: shared hooks.

## Conventions

- Use Base UI variants only. Animate UI primitives import from `@animate-ui/react/primitives/base-ui`; do not add Radix UI.
- `components.json` configures Base UI's `base-nova` style. Add only components needed by a feature, then use Animate UI's CLI to animate them.
- Tailwind configuration lives in `src/app/globals.css`; no JavaScript Tailwind configuration.
- Prefer `animate-fade-in` / `animate-slide-in` for simple entrances. Global Motion configuration uses short tweens; Animate UI has its own primitive-specific motion. Reduced motion is respected.
- React Hook Form + Zod handle forms; schemas belong to their feature.
- nuqs handles URL state. TanStack Query handles client-side server state; do not duplicate Server Component fetching without a reason.
- Query clients follow [TanStack's Next.js advanced SSR guide](https://tanstack.com/query/latest/docs/framework/react/guides/advanced-ssr): fresh instances on the server, one browser instance, and pending-query dehydration for streaming. For server prefetching, use `getQueryClient()` and pass `dehydrate(queryClient)` through a route-level `HydrationBoundary`. Never dehydrate server-only secrets; clear the browser cache when changing authenticated users.
- Use native `fetch`, `Intl.NumberFormat`, Day.js, selective `lodash-es` imports, and `@reactuses/core` hooks.
- ESLint configuration and dependencies belong to this app. Formatting inherits the root Prettier and EditorConfig settings.

The home page is intentionally blank. No authentication, Supabase, sample feature, or backend is configured.
