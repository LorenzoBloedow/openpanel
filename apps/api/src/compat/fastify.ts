import type { IServiceClientWithProject } from '@openpanel/db/src/services/clients.service';
import type { ILogger } from '@openpanel/logger';
import { type Context, Hono } from 'hono';
import type { ZodType } from 'zod';

import type { AppEnv } from '@/env';
import { readJsonBody } from '@/ingest/body';
import { HttpError } from '@/utils/errors';

/**
 * A small Fastify-shaped surface over Hono, so the public API controllers
 * (export, insights, manage, misc) keep their bodies: `request.query /
 * params / body / headers / client / log`, `reply.status / header / send /
 * redirect`, `fastify.route({ schema })` with zod validation, and the
 * `preValidation` / `preHandler` hooks. New code is native Hono.
 */

export interface RouteGenericInterface {
  Body?: unknown;
  Querystring?: unknown;
  Params?: unknown;
  Headers?: unknown;
  Reply?: unknown;
}

export interface FastifyRequest<
  RouteGeneric extends RouteGenericInterface = RouteGenericInterface,
> {
  id: string;
  url: string;
  method: string;
  query: RouteGeneric['Querystring'];
  params: RouteGeneric['Params'];
  body: RouteGeneric['Body'];
  /** Lowercased names; repeated headers joined with ", ". */
  headers: Record<string, string | undefined>;
  client?: IServiceClientWithProject;
  clientIp: string;
  log: ILogger;
  timestamp: number;
  /** The underlying Hono context (escape hatch). */
  raw: Context<AppEnv>;
}

export class FastifyReply {
  statusCode = 200;
  sent = false;
  payload: unknown = undefined;
  readonly headersObject = new Headers();
  private redirectTo: string | undefined;

  constructor(readonly request: FastifyRequest) {}

  get log() {
    return this.request.log;
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  code(code: number) {
    return this.status(code);
  }

  header(name: string, value: string | number | boolean) {
    this.headersObject.set(name, String(value));
    return this;
  }

  headers(values: Record<string, string | number | boolean>) {
    for (const [name, value] of Object.entries(values)) {
      this.header(name, value);
    }
    return this;
  }

  getHeader(name: string) {
    return this.headersObject.get(name) ?? undefined;
  }

  type(contentType: string) {
    return this.header('content-type', contentType);
  }

  send(payload?: unknown) {
    this.payload = payload;
    this.sent = true;
    return this;
  }

  redirect(url: string, code = 302) {
    this.redirectTo = url;
    this.statusCode = code;
    this.sent = true;
    return this;
  }

  toResponse(): Response {
    const headers = this.headersObject;
    if (this.redirectTo) {
      headers.set('location', this.redirectTo);
      return new Response(null, { status: this.statusCode, headers });
    }
    const payload = this.payload;
    if (payload === undefined || payload === null) {
      return new Response(null, { status: this.statusCode, headers });
    }
    if (payload instanceof Response) {
      return payload;
    }
    if (
      typeof payload === 'string' ||
      payload instanceof ArrayBuffer ||
      ArrayBuffer.isView(payload) ||
      payload instanceof ReadableStream
    ) {
      if (!headers.has('content-type')) {
        headers.set(
          'content-type',
          typeof payload === 'string'
            ? 'text/plain; charset=utf-8'
            : 'application/octet-stream',
        );
      }
      return new Response(payload as BodyInit, {
        status: this.statusCode,
        headers,
      });
    }
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json; charset=utf-8');
    }
    return new Response(JSON.stringify(payload), {
      status: this.statusCode,
      headers,
    });
  }
}

export interface RouteSchema {
  querystring?: ZodType;
  body?: ZodType;
  params?: ZodType;
  response?: Record<number, ZodType>;
  tags?: readonly string[];
  description?: string;
  summary?: string;
  hide?: boolean;
}

type Handler = (
  request: FastifyRequest<any>,
  reply: FastifyReply,
) => unknown | Promise<unknown>;

type Hook = (
  request: FastifyRequest<any>,
  reply: FastifyReply,
) => unknown | Promise<unknown>;

type HookName = 'onRequest' | 'preValidation' | 'preHandler';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

export interface RouteOptions {
  method: Method | Method[];
  url: string;
  schema?: RouteSchema;
  handler: Handler;
}

/** One documented route, for the OpenAPI document. */
export interface DocumentedRoute {
  method: string;
  path: string;
  schema: RouteSchema;
}

const documentedRoutes: DocumentedRoute[] = [];

export function getDocumentedRoutes(): readonly DocumentedRoute[] {
  return documentedRoutes;
}

export function documentRoute(route: DocumentedRoute) {
  documentedRoutes.push(route);
}

function joinPath(prefix: string, url: string) {
  const path = `${prefix}${url === '/' ? '' : url}` || '/';
  return path.replace(/\/{2,}/g, '/');
}

/** Fastify's querystring: repeated keys become arrays. */
function parseQuery(c: Context<AppEnv>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    out[key] = values.length === 1 ? values[0]! : values;
  }
  return out;
}

function validationError(part: string, schema: ZodType, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) {
    return { value: result.data, error: null };
  }
  const message = result.error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('/');
      return `${part}${path ? `/${path}` : ''} ${issue.message}`;
    })
    .join(', ');
  return {
    value,
    error: new HttpError(message, { status: 400, error: 'Bad Request' }),
  };
}

export class FastifyInstance {
  readonly hooks: Record<HookName, Hook[]> = {
    onRequest: [],
    preValidation: [],
    preHandler: [],
  };

  constructor(
    readonly app: Hono<AppEnv>,
    readonly prefix: string,
  ) {}

  addHook(name: HookName, hook: Hook) {
    this.hooks[name].push(hook);
    return this;
  }

  route(options: RouteOptions) {
    const methods = Array.isArray(options.method)
      ? options.method
      : [options.method];
    const schema = options.schema ?? {};
    // Fastify's `:param` syntax is Hono's too.
    const path = options.url === '/' ? '/' : options.url;
    for (const method of methods) {
      if (!schema.hide) {
        documentRoute({
          method,
          path: joinPath(this.prefix, options.url),
          schema,
        });
      }
      this.app.on(method, path, (c) => this.handle(c, schema, options.handler));
    }
    return this;
  }

  get(url: string, optionsOrHandler: { schema?: RouteSchema } | Handler, maybeHandler?: Handler) {
    return this.shorthand('GET', url, optionsOrHandler, maybeHandler);
  }

  post(url: string, optionsOrHandler: { schema?: RouteSchema } | Handler, maybeHandler?: Handler) {
    return this.shorthand('POST', url, optionsOrHandler, maybeHandler);
  }

  private shorthand(
    method: Method,
    url: string,
    optionsOrHandler: { schema?: RouteSchema } | Handler,
    maybeHandler?: Handler,
  ) {
    if (typeof optionsOrHandler === 'function') {
      return this.route({ method, url, handler: optionsOrHandler });
    }
    return this.route({
      method,
      url,
      schema: optionsOrHandler.schema,
      handler: maybeHandler!,
    });
  }

  private async handle(c: Context<AppEnv>, schema: RouteSchema, handler: Handler) {
    const method = c.req.method;
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const request: FastifyRequest<any> = {
      id: c.get('requestId'),
      url: new URL(c.req.url).pathname + new URL(c.req.url).search,
      method,
      query: parseQuery(c),
      params: c.req.param(),
      body: hasBody ? await readJsonBody(c) : undefined,
      headers: Object.fromEntries(c.req.raw.headers),
      client: c.get('client'),
      clientIp: c.get('clientIp'),
      log: c.get('logger'),
      timestamp: c.get('timestamp'),
      raw: c,
    };
    const reply = new FastifyReply(request);

    for (const hook of this.hooks.onRequest) {
      await hook(request, reply);
      if (reply.sent) {
        return reply.toResponse();
      }
    }
    for (const hook of this.hooks.preValidation) {
      await hook(request, reply);
      if (reply.sent) {
        return reply.toResponse();
      }
    }

    for (const [part, key] of [
      ['querystring', 'query'],
      ['params', 'params'],
      ['body', 'body'],
    ] as const) {
      const partSchema = schema[part];
      if (!partSchema) {
        continue;
      }
      const result = validationError(part, partSchema, request[key]);
      if (result.error) {
        throw result.error;
      }
      request[key] = result.value;
    }

    for (const hook of this.hooks.preHandler) {
      await hook(request, reply);
      if (reply.sent) {
        return reply.toResponse();
      }
    }

    const returned = await handler(request, reply);
    if (!reply.sent && returned !== undefined && returned !== reply) {
      reply.send(returned);
    }
    return reply.toResponse();
  }
}

/** A Fastify plugin (the routers' `async (fastify) => { … }`). */
export type FastifyPluginAsyncZodOpenApi = (
  fastify: FastifyInstance,
) => void | Promise<void>;
export type FastifyPluginCallback = FastifyPluginAsyncZodOpenApi;

/** Mount a Fastify-style router plugin under `prefix`. */
export async function mountFastifyPlugin(
  app: Hono<AppEnv>,
  prefix: string,
  plugin: FastifyPluginAsyncZodOpenApi,
) {
  const sub = new Hono<AppEnv>();
  const instance = new FastifyInstance(sub, prefix);
  await plugin(instance);
  app.route(prefix, sub);
}
