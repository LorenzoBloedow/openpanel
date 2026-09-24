# public

The openpanel.dev marketing and documentation site. It is a Next.js App Router
application built with [vinext](https://vinext.dev) (Next.js APIs on Vite) and
deployed to Cloudflare Workers through `@cloudflare/vite-plugin`. Content comes
from [Fumadocs](https://fumadocs.dev).

```bash
pnpm dev          # vinext dev server on http://localhost:9090 (runs in workerd)
pnpm build        # vinext build -> dist/ (Worker + static assets)
pnpm preview      # serve the built Worker locally
pnpm run deploy   # build, then `wrangler deploy` the generated dist/server/wrangler.json
```

Worker settings live in `wrangler.jsonc`.

## Explore

In the project, you can see:

- `lib/source.ts`: Code for content source adapter, [`loader()`](https://fumadocs.dev/docs/headless/source-api) provides the interface to access your content.
- `lib/layout.shared.tsx`: Shared options for layouts, optional but preferred to keep.

| Route                     | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `app/(home)`              | The route group for your landing page and other pages. |
| `app/docs`                | The documentation layout and pages.                    |
| `app/api/search/route.ts` | The Route Handler for search.                          |

### Fumadocs MDX

A `source.config.ts` config file has been included, you can customise different options like frontmatter schema.

Read the [Introduction](https://fumadocs.dev/docs/mdx) for further details.

## Learn More

To learn more about Next.js and Fumadocs, take a look at the following
resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [vinext Documentation](https://vinext.dev/docs) - what vinext supports.
- [Fumadocs](https://fumadocs.dev) - learn about Fumadocs
