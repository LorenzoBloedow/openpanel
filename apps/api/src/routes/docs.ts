import { swaggerUI } from '@hono/swagger-ui';
import { Hono } from 'hono';
import { z } from 'zod';

import { type DocumentedRoute, getDocumentedRoutes } from '@/compat/fastify';
import type { AppEnv } from '@/env';

/**
 * The public API's OpenAPI document (`/documentation/json`, read by the docs
 * site) and Swagger UI (`/documentation`), generated from the zod schemas
 * the routes validate with.
 */

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    target: 'openapi-3.0',
  }) as JsonSchema;
  delete json.$schema;
  return json;
}

function parameters(schema: z.ZodType | undefined, location: 'query' | 'path') {
  if (!schema) {
    return [];
  }
  const json = toJsonSchema(schema);
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === 'path' || required.has(name),
    ...(property.description ? { description: property.description } : {}),
    schema: property,
  }));
}

function operation(route: DocumentedRoute) {
  const { schema } = route;
  const responses: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(schema.response ?? {})) {
    responses[status] = {
      description: 'Response',
      content: { 'application/json': { schema: toJsonSchema(response) } },
    };
  }
  if (Object.keys(responses).length === 0) {
    responses['200'] = { description: 'Success' };
  }
  return {
    ...(schema.tags ? { tags: [...schema.tags] } : {}),
    ...(schema.summary ? { summary: schema.summary } : {}),
    ...(schema.description ? { description: schema.description } : {}),
    parameters: [
      ...parameters(schema.params, 'path'),
      ...parameters(schema.querystring, 'query'),
    ],
    ...(schema.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: toJsonSchema(schema.body) } },
          },
        }
      : {}),
    responses,
  };
}

export function buildOpenApiDocument(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of getDocumentedRoutes()) {
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    paths[path] ??= {};
    try {
      paths[path]![route.method.toLowerCase()] = operation(route);
    } catch {
      // A schema zod can't express in JSON Schema: document the route bare.
      paths[path]![route.method.toLowerCase()] = {
        ...(route.schema.tags ? { tags: [...route.schema.tags] } : {}),
        responses: { '200': { description: 'Success' } },
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'OpenPanel API', version: '1.0.0' },
    servers: [{ url: serverUrl }],
    tags: [
      { name: 'Track', description: 'Track events and sessions' },
      { name: 'Profile', description: 'Identify and update user profiles' },
      { name: 'Export', description: 'Export data' },
      { name: 'Import', description: 'Import historical data' },
      { name: 'Insights', description: 'Query analytics data' },
      { name: 'Manage', description: 'Manage projects and clients' },
      { name: 'Event', description: 'Legacy event ingestion (deprecated, use /track)' },
    ],
    paths,
  };
}

export const docsRoutes = new Hono<AppEnv>();

let cachedDocument: ReturnType<typeof buildOpenApiDocument> | undefined;

docsRoutes.get('/json', (c) => {
  cachedDocument ??= buildOpenApiDocument(c.env.API_URL);
  return c.json(cachedDocument);
});

docsRoutes.get('/', swaggerUI({ url: '/documentation/json' }));
