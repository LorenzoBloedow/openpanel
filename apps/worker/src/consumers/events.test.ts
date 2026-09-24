/**
 * Control flow of the op-events consumer: one transaction per batch, and a
 * per-message fallback that isolates a poison message (retried → DLQ) while
 * the rest of the batch is acked. The transaction itself is covered by
 * packages/db/src/ingest/consumer.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const applyEnvelopes = vi.fn();
const markFirstEvent = vi.fn();
const getNotificationRuleKinds = vi.fn();
const publish = vi.fn();
const addJob = vi.fn();

vi.mock('@openpanel/db/src/ingest/consumer', () => ({
  applyEnvelopes: (...args: unknown[]) => applyEnvelopes(...args),
}));
vi.mock('@openpanel/db/src/ingest/effects', () => ({
  isExcludedByProjectFilter: vi.fn(),
  markFirstEvent: (...args: unknown[]) => markFirstEvent(...args),
  getNotificationRuleKinds: (...args: unknown[]) =>
    getNotificationRuleKinds(...args),
}));
vi.mock('@openpanel/queue/src/live', () => ({
  getLiveHub: () => ({ publish: (...args: unknown[]) => publish(...args) }),
}));
vi.mock('@openpanel/queue/src/queues', () => ({
  notificationQueue: { add: (...args: unknown[]) => addJob(...args) },
}));

const { consumeEvents } = await import('./events');

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as never;
const env = { LIVE_HUB: {} } as unknown as Env;

function makeEnvelope(projectId: string, marker: string) {
  return {
    v: 1,
    projectId,
    records: [
      {
        type: 'group',
        id: '0199a5a4-7c00-7000-8000-000000000001',
        group: {
          id: marker,
          projectId,
          type: 'company',
          name: marker,
          properties: {},
        },
      },
    ],
  };
}

function makeMessage(body: unknown, id: string) {
  return {
    id,
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

const EMPTY_RESULT = {
  appliedRecords: 1,
  skippedRecords: 0,
  insertedEvents: [],
  closedSessions: [],
};

beforeEach(() => {
  applyEnvelopes.mockReset();
  markFirstEvent.mockReset();
  getNotificationRuleKinds.mockReset();
  publish.mockReset();
  addJob.mockReset();
  getNotificationRuleKinds.mockResolvedValue({ projectId: 'p', events: false, funnel: false });
});

describe('consumeEvents', () => {
  it('applies a batch in one call and acks every message', async () => {
    applyEnvelopes.mockResolvedValue(EMPTY_RESULT);
    const messages = [
      makeMessage(makeEnvelope('p1', 'a'), 'm1'),
      makeMessage(makeEnvelope('p1', 'b'), 'm2'),
    ];

    await consumeEvents(messages, env, logger);

    expect(applyEnvelopes).toHaveBeenCalledTimes(1);
    expect(applyEnvelopes.mock.calls[0]![0]).toHaveLength(2);
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it('isolates a poison message: the rest is acked, it alone is retried', async () => {
    applyEnvelopes.mockImplementation(async (envelopes: { records: { group: { id: string } }[] }[]) => {
      if (envelopes.some((envelope) => envelope.records[0]!.group.id === 'poison')) {
        throw new Error('invalid input syntax');
      }
      return EMPTY_RESULT;
    });
    const good1 = makeMessage(makeEnvelope('p1', 'a'), 'm1');
    const poison = makeMessage(makeEnvelope('p1', 'poison'), 'm2');
    const good2 = makeMessage(makeEnvelope('p1', 'b'), 'm3');

    await consumeEvents([good1, poison, good2], env, logger);

    // The batch, then each message alone.
    expect(applyEnvelopes).toHaveBeenCalledTimes(4);
    expect(good1.ack).toHaveBeenCalled();
    expect(good2.ack).toHaveBeenCalled();
    expect(poison.ack).not.toHaveBeenCalled();
    expect(poison.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
  });

  it('retries an envelope it cannot parse instead of dropping it', async () => {
    applyEnvelopes.mockResolvedValue(EMPTY_RESULT);
    const invalid = makeMessage({ v: 99, projectId: 'p1', records: [] }, 'm1');
    const valid = makeMessage(makeEnvelope('p1', 'a'), 'm2');

    await consumeEvents([invalid, valid], env, logger);

    expect(invalid.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(invalid.ack).not.toHaveBeenCalled();
    expect(valid.ack).toHaveBeenCalled();
    expect(applyEnvelopes.mock.calls[0]![0]).toHaveLength(1);
  });

  it('publishes counts and queues rule checks after the commit', async () => {
    getNotificationRuleKinds.mockResolvedValue({ projectId: 'p1', events: true, funnel: true });
    applyEnvelopes.mockResolvedValue({
      ...EMPTY_RESULT,
      insertedEvents: [
        {
          payload: {
            id: 'e1',
            name: 'screen_view',
            projectId: 'p1',
            deviceId: 'd',
            profileId: '',
            sessionId: 's',
            properties: {},
            createdAt: new Date('2026-06-08T12:00:00Z'),
            path: '/',
            origin: '',
            groups: [],
          },
        },
      ],
      closedSessions: [{ id: 's0', project_id: 'p1' }],
    });

    await consumeEvents([makeMessage(makeEnvelope('p1', 'a'), 'm1')], env, logger);

    expect(publish).toHaveBeenCalledWith({ type: 'events', projectId: 'p1', count: 1 });
    expect(markFirstEvent).toHaveBeenCalledWith('p1');
    expect(addJob).toHaveBeenCalledWith(
      'checkEventRules',
      expect.objectContaining({
        type: 'checkEventRules',
        payload: expect.objectContaining({ projectId: 'p1' }),
      }),
    );
    expect(addJob).toHaveBeenCalledWith('checkFunnelRules', {
      type: 'checkFunnelRules',
      payload: { projectId: 'p1', sessionIds: ['s0'] },
    });
  });

  it('never fails the batch when a side effect fails', async () => {
    applyEnvelopes.mockResolvedValue({
      ...EMPTY_RESULT,
      insertedEvents: [
        {
          payload: {
            id: 'e1',
            name: 'screen_view',
            projectId: 'p1',
            deviceId: 'd',
            profileId: '',
            sessionId: 's',
            properties: {},
            createdAt: new Date('2026-06-08T12:00:00Z'),
            path: '/',
            origin: '',
            groups: [],
          },
        },
      ],
    });
    publish.mockRejectedValue(new Error('hub unavailable'));
    const message = makeMessage(makeEnvelope('p1', 'a'), 'm1');

    await consumeEvents([message], env, logger);

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
