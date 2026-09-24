# CLAUDE.md

NEVER CALL FORMAT! WE'LL FORMAT IN THE FUTURE WHEN WE HAVE MERGED ALL BIG PRS!

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Openpanel is an open-source web/product analytics platform (Mixpanel alternative). It's a **pnpm monorepo** with apps, packages, tooling, and SDKs. This branch (`cloudflare`) runs it entirely on Cloudflare Workers with Neon Postgres as the only database; see `tooling/cloudflare/DEPLOY.md`.

## Common Commands

```bash
# Development
pnpm dev                    # API + worker (wrangler dev) and the dashboard (Vite)
pnpm dev:public             # Public/docs site only (vinext)
pnpm dock:up / dock:down    # Start/stop local Postgres (Docker Compose)
pnpm dock:psql              # Postgres shell

# Code quality
pnpm check                  # Lint check (Biome via Ultracite)
pnpm typecheck              # Typecheck all packages

# Testing
pnpm test                   # Run all tests (vitest; needs local Postgres)
pnpm vitest run <path>      # Run a single test file
# Workspace: packages/*, apps/* (excluding apps/start) and tooling/cloudflare

# Database
pnpm codegen                # Generate Prisma types
pnpm migrate                # Prisma migrations (dev)
pnpm migrate:deploy         # Prisma + analytics schema migrations (never run against production by hand)

# Cloudflare (tooling/cloudflare)
pnpm cf:setup / cf:deploy   # Provision an account / migrate and deploy the Workers
pnpm cf:backup / cf:restore # Backups in the R2 format, and restoring them
```

## Architecture

### Apps

| App | Stack | Dev port | Purpose |
|-----|-------|------|---------|
| `apps/api` | Hono on Workers | 3333 | Ingestion (`/track`), tRPC, public API, OAuth, the `LiveHub` Durable Object (WebSockets) |
| `apps/worker` | Workers | 9999 | Queue consumers (`op-events`, `op-jobs`), crons, Workflows (Backup, ProjectDelete, GscBackfill) |
| `apps/start` | TanStack Start on Workers | 3000 | Dashboard (calls the API through a service binding) |
| `apps/public` | vinext (Next.js on Vite) + Fumadocs | 9090 | Marketing/docs site |

### Key Packages

| Package | Purpose |
|---------|---------|
| `packages/db` | Prisma (engine-less, `public` schema) and the analytics layer on Postgres (`src/analytics/*`, `analytics` schema, migrations in `analytics-migrations/`) |
| `packages/runtime` | Per-invocation scope: env, `waitUntil`, and the database route (`hyperdrive` / `direct`) |
| `packages/trpc` | tRPC router definitions, context, middleware |
| `packages/auth` | Authentication (Arctic OAuth, Oslo sessions, argon2 WASM) |
| `packages/queue` | Cloudflare Queues producers (`JOBS_QUEUE`) and the LiveHub client |
| `packages/redis` | Historical name: a per-isolate memo (`cacheable`), no Redis |
| `packages/validation` | Zod schemas shared across apps |
| `packages/common` | Shared utilities (date-fns, ua-parser, nanoid) |
| `packages/email` | React Email templates, sent through Cloudflare Email Service |
| `packages/sdks/*` | Client SDKs (web, react, next, express, react-native, etc.) |

### Data Flow

1. **Event ingestion**: SDKs → `apps/api` `/track` (one Hyperdrive round trip for dedupe and the live session) → `op-events` queue (replay chunks are inserted directly)
2. **Processing**: `apps/worker` applies each queue batch in one Postgres transaction (events, sessions, profiles, rollups); a minute cron closes idle sessions
3. **Dashboard queries**: `apps/start` → tRPC → `apps/api` → Postgres via Hyperdrive
4. **Real-time**: WebSockets on the `LiveHub` Durable Object; the worker publishes to it after each batch

### One database

- **Neon Postgres** holds everything: Prisma models in `public`, events/sessions/profiles/rollups in `analytics`, and short-lived state (live sessions, dedupe, rate-limit lockouts, cron slots).
- **Hyperdrive** serves paths where a user waits; background work connects to Neon's pooled endpoint directly (`packages/db/src/db-routing.ts`).
- **R2** holds nightly backups. There is no Redis, ClickHouse or D1.

### Dashboard (apps/start)

Uses TanStack Router with file-based routing (`src/routes/`). State management via Redux Toolkit. UI built on Radix primitives + Tailwind v4. Charts via Recharts. Modals in `src/modals/`. Features compiled out on Cloudflare (AI, integrations, importers, MCP, billing) are hidden via `useAppContext().features`.

### API (apps/api)

Hono on Workers with tRPC over the fetch adapter. Route files in `src/routes/`; the export/insights/manage controllers keep their Fastify style through `src/compat/fastify.ts`. Built and bundled by wrangler.
---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)
