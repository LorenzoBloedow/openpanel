import { runWithScope } from '@openpanel/runtime';

import { app } from './app';

export { LiveHub } from './durable/live-hub';

export default {
  fetch(request, env, ctx) {
    // A user waits on every API response: Hyperdrive is the default route.
    return runWithScope({ env, ctx, route: 'hyperdrive' }, () =>
      app.fetch(request, env, ctx),
    );
  },
} satisfies ExportedHandler<Env>;
