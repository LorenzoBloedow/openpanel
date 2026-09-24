import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import mdx from 'fumadocs-mdx/vite';
import vinext, { type NextConfig } from 'vinext';
import { defineConfig } from 'vite';
import * as sourceConfig from './source.config.ts';

// What used to be next.config.mjs. It is handed to vinext inline rather than
// kept as a next.config.* file, because fumadocs-mdx picks its codegen target
// from that file's presence: with one on disk its CLI (postinstall, typecheck)
// would emit webpack-style collection imports instead of Vite's import.meta.glob.
const nextConfig: NextConfig = {
  reactStrictMode: false,
  images: {
    unoptimized: true,
    domains: ['localhost', 'openpanel.dev', 'api.openpanel.dev'],
  },
  // Must be a function: vinext calls it, and Next.js silently ignored the
  // plain array this used to be, so these redirects were never live before.
  async redirects() {
    return [
      {
        source: '/articles/top-7-open-source-web-analytics-tools',
        destination: '/articles/self-hosted-web-analytics',
        permanent: true,
      },
      {
        source: '/articles/alternatives-to-mixpanel',
        destination: '/articles/mixpanel-alternatives',
        permanent: true,
      },
      {
        source: '/articles/vs-mixpanel',
        destination: '/compare/mixpanel-alternative',
        permanent: true,
      },
      {
        // Note: content/articles/open-source-web-analytics.mdx still exists,
        // so this redirect hides that article now that redirects work.
        source: '/articles/open-source-web-analytics',
        destination: '/articles/self-hosted-web-analytics',
        permanent: true,
      },
      {
        source: '/open-source-analytics',
        destination: '/articles/self-hosted-web-analytics',
        permanent: true,
      },
    ];
  },
};

// fumadocs-mdx compiles every .mdx file - the content collections, but also the
// snippets under src/components that content imports directly. vinext only
// recognizes an MDX plugin named "mdx" (or "@mdx-js/rollup") and would try to
// compile those plain .mdx imports a second time, so register it by that name.
const mdxPlugin = { ...(await mdx(sourceConfig)), name: 'mdx' };

export default defineConfig({
  plugins: [
    // Tailwind's own Vite plugin rather than @tailwindcss/postcss: under Vite,
    // PostCSS @import inlining runs first and drops the @imports in
    // fumadocs-ui/css/preset.css that follow its @plugin line, so the docs
    // layout classes were never generated.
    tailwindcss(),
    // Compiles content/**/*.mdx and generates .source/; has to run before vinext.
    mdxPlugin,
    vinext({ nextConfig }),
    // Runs the RSC environment (with SSR as its child) in workerd, both in dev
    // and in the production build, which is emitted as a Worker.
    cloudflare({
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
    }),
  ],
  resolve: {
    // Workspace packages such as @openpanel/sdk-info resolve their own copy of
    // React; hooks and context (fumadocs' providers included) need exactly one.
    dedupe: ['fumadocs-core', 'fumadocs-ui', 'react', 'react-dom'],
  },
  // Dev server only (dependency pre-bundling); vinext applies this to the rsc,
  // ssr and client environments alike.
  // - fumadocs: a pre-bundled copy would give its client components a second
  //   module instance next to the one RSC client references load, splitting
  //   its React contexts. Its CommonJS dependencies still need pre-bundling.
  // - next/script: a pre-bundled copy of vinext's Script shim misses the
  //   context vinext's SSR entry provides, so beforeInteractive scripts (the
  //   JSON-LD blocks) were rendered inline and failed hydration.
  optimizeDeps: {
    exclude: ['fumadocs-ui', 'fumadocs-core', 'next/script'],
    include: [
      'fumadocs-ui > debug',
      'fumadocs-core > extend',
      'fumadocs-core > style-to-js',
    ],
  },
});
