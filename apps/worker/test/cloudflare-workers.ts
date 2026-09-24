/**
 * `cloudflare:workers` for Node tests: the base classes the Worker's
 * entrypoints extend, holding `ctx` and `env` as workerd's do. Workflows
 * are driven with a fake `step` (see src/workflows/workflows.test.ts).
 */
export class WorkflowEntrypoint<E = unknown, _Params = unknown> {
  protected ctx: ExecutionContext;
  protected env: E;

  constructor(ctx: ExecutionContext, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject<E = unknown> {
  protected ctx: DurableObjectState;
  protected env: E;

  constructor(ctx: DurableObjectState, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const env = {};
