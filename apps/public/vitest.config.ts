// The root vitest workspace treats every apps/* folder as a project and, with
// no vitest.config here, would load vite.config.ts instead - whose vinext and
// Cloudflare plugins require Vite 8, while vitest runs on Vite 6. This app has
// no unit tests, so an empty project config is all that is needed.
export default {};
