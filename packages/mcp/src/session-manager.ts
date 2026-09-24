import { randomUUID } from 'node:crypto';
import { createLogger } from '@openpanel/logger';
import type { McpAuthContext } from './auth';

const logger = createLogger({ name: 'mcp:sessions' });

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface StoredSession {
  context: McpAuthContext;
  expiresAt: number;
}

/**
 * Session auth contexts, kept in process memory with a sliding TTL.
 *
 * They used to live in Redis so any API instance could serve any session.
 * Redis is gone on this branch and MCP isn't served on Cloudflare yet, so
 * this is the single-process stand-in; a multi-instance deployment needs a
 * shared store again (a Durable Object or a Postgres table).
 */
export class SessionManager {
  private readonly sessions = new Map<string, StoredSession>();

  generateId(): string {
    return randomUUID();
  }

  async setContext(id: string, context: McpAuthContext): Promise<void> {
    this.sessions.set(id, { context, expiresAt: Date.now() + SESSION_TTL_MS });
    logger.info(
      {
        sessionId: id,
        clientType: context.clientType,
        organizationId: context.organizationId,
        projectId: context.projectId,
      },
      'MCP session context stored',
    );
  }

  async getContext(id: string): Promise<McpAuthContext | null> {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session.context;
  }

  async touchContext(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      session.expiresAt = Date.now() + SESSION_TTL_MS;
    }
  }

  async deleteContext(id: string): Promise<void> {
    this.sessions.delete(id);
    logger.info({ sessionId: id }, 'MCP session deleted');
  }

  async close(id: string): Promise<void> {
    await this.deleteContext(id);
  }

  async destroy(): Promise<void> {
    this.sessions.clear();
  }
}
