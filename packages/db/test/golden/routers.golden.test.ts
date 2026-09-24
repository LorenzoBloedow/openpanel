import { vi } from 'vitest';

import * as routers from './cases/routers.cases';
import { describeGoldenGroup } from './compare';

// The first case loads the whole tRPC router, which takes seconds.
vi.setConfig({ testTimeout: 60_000 });

describeGoldenGroup(routers.group, routers.cases);
