import { runWithScope } from '@openpanel/runtime';

import { createApp } from './app';

export { LiveHub } from './durable/live-hub';

// Route registration does no I/O; the promise settles before the first
// request is served.
const appPromise = createApp();

export default {
  async fetch(request, env, ctx) {
    const app = await appPromise;
    // A user waits on every API response: Hyperdrive is the default route.
    return runWithScope({ env, ctx, route: 'hyperdrive' }, () =>
      app.fetch(request, env, ctx),
    );
  },
} satisfies ExportedHandler<Env>;
