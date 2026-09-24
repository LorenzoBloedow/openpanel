import { chartColors } from '@openpanel/constants';
import { type IChartEventFilter, zChartEvent } from '@openpanel/validation';
import { z } from 'zod';
import { anQueryOne } from '../analytics/client';
import { eventFilterClauses } from '../analytics/filters';
import { type Sql, and, join, raw, sql } from '../analytics/sql';
import { EVENTS, dateRange } from './funnel-query';

export const zGetSankeyInput = z.object({
  projectId: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  steps: z.number().min(2).max(10).default(5),
  mode: z.enum(['between', 'after', 'before']),
  startEvent: zChartEvent,
  endEvent: zChartEvent.optional(),
  exclude: z.array(z.string()).default([]),
  include: z.array(z.string()).optional(),
});

export type IGetSankeyInput = z.infer<typeof zGetSankeyInput> & {
  timezone: string;
};

interface SankeyEntry {
  entry_event: string;
  count: number;
}

interface SankeyTransition {
  source: string;
  target: string;
  step: number;
  value: number;
}

/**
 * The path slice of a session: its deduplicated event names are
 * `events_deduped`, and `_first.start_index` is the 1-based position of the
 * first start event (0 when absent) where a mode needs it.
 */
const DEDUPED = raw('events_deduped');
const START_INDEX = raw('_first.start_index');

export class SankeyService {
  // biome-ignore lint/complexity/noUselessConstructor: callers still pass the ClickHouse client
  constructor(_client?: unknown) {
    // Ignored: the queries run on the analytics pool of the current scope.
  }

  /**
   * Report filters as a WHERE fragment on the events table (alias `e`), or
   * on the sessions table with the entry and UTM columns mapped.
   */
  getRawWhereClause(
    type: 'events' | 'sessions',
    filters: IChartEventFilter[],
    scope: { projectId: string; timezone: string; alias?: string },
  ): Sql {
    const mapped = filters.map((item) => {
      if (type === 'sessions') {
        if (item.name === 'path') {
          return { ...item, name: 'entry_path' };
        }
        if (item.name === 'origin') {
          return { ...item, name: 'entry_origin' };
        }
        if (item.name.startsWith('properties.__query.utm_')) {
          return {
            ...item,
            name: item.name.replace('properties.__query.utm_', 'utm_'),
          };
        }
        return item;
      }
      return item;
    });
    return and(
      eventFilterClauses(mapped, {
        alias: EVENTS,
        ...scope,
        table: type,
      }),
    );
  }

  private buildEventNameFilter(
    include: string[] | undefined,
    exclude: string[],
    startEventName: string | undefined,
    endEventName: string | undefined,
  ): Sql | null {
    if (include && include.length > 0) {
      const eventNames = [...include, startEventName, endEventName].filter(
        (item): item is string => item !== undefined,
      );
      return sql`${raw(EVENTS)}.name = ANY(${eventNames}::text[])`;
    }
    if (exclude.length > 0) {
      return sql`${raw(EVENTS)}.name <> ALL(${exclude}::text[])`;
    }
    return null;
  }

  /** Sessions with at least one `event` (its filters applied) in range. */
  private buildSessionEventCTE(
    event: z.infer<typeof zChartEvent>,
    projectId: string,
    range: Sql,
    timezone: string,
  ): Sql {
    return sql`SELECT DISTINCT ${raw(EVENTS)}.session_id
      FROM analytics.events AS ${raw(EVENTS)}
      WHERE ${raw(EVENTS)}.project_id = ${projectId}
        AND ${raw(EVENTS)}.name = ${event.name}::text
        AND ${range}
        AND ${this.getRawWhereClause('events', event.filters, { projectId, timezone })}`;
  }

  /**
   * Which sessions a mode keeps and which part of their path it shows —
   * ClickHouse's `arraySlice` over the deduplicated path:
   * - after: `steps` events from the first start event;
   * - before: up to `steps` events ending with the first start event;
   * - between (and without a start event): the first `steps` events.
   */
  private getModeConfig(
    mode: 'after' | 'before' | 'between',
    startEvent: z.infer<typeof zChartEvent> | undefined,
    endEvent: z.infer<typeof zChartEvent> | undefined,
    hasStartEventCTE: boolean,
    hasEndEventCTE: boolean,
    steps: number,
  ): { sessionFilter: Sql; eventsSliceExpr: Sql; needsStartIndex: boolean } {
    const stepCount = sql`${steps}::int`;
    const defaultSliceExpr = sql`${DEDUPED}[1 : ${stepCount}]`;
    const inStartSessions = raw('session_id IN (SELECT session_id FROM start_event_sessions)');
    const inEndSessions = raw('session_id IN (SELECT session_id FROM end_event_sessions)');
    const pathHas = (event: z.infer<typeof zChartEvent>) =>
      sql`${event.name}::text = ANY(${DEDUPED})`;

    if (mode === 'after' && startEvent) {
      return {
        sessionFilter: hasStartEventCTE ? inStartSessions : pathHas(startEvent),
        // arraySlice from index 0 (no start event on the path) is empty.
        eventsSliceExpr: sql`CASE WHEN ${START_INDEX} = 0 THEN '{}'::text[]
          ELSE ${DEDUPED}[${START_INDEX} : ${START_INDEX} + ${stepCount} - 1] END`,
        needsStartIndex: true,
      };
    }

    if (mode === 'before' && startEvent) {
      return {
        sessionFilter: hasStartEventCTE ? inStartSessions : pathHas(startEvent),
        eventsSliceExpr: sql`${DEDUPED}[greatest(1, ${START_INDEX} - ${stepCount} + 1) : ${START_INDEX}]`,
        needsStartIndex: true,
      };
    }

    if (mode === 'between' && startEvent && endEvent) {
      return {
        sessionFilter: and([
          hasStartEventCTE ? inStartSessions : pathHas(startEvent),
          hasEndEventCTE ? inEndSessions : pathHas(endEvent),
        ]),
        eventsSliceExpr: defaultSliceExpr,
        needsStartIndex: false,
      };
    }

    return {
      sessionFilter: raw('TRUE'),
      eventsSliceExpr: defaultSliceExpr,
      needsStartIndex: false,
    };
  }

  /**
   * The flow's top entry events (at most three, by sessions) and the
   * transitions of the paths starting with one of them, from `paths`
   * (`events`, `entry_event`), in one round trip.
   */
  private async queryFlow(
    ctes: Sql[],
    paths: string,
  ): Promise<{ entries: SankeyEntry[]; transitions: SankeyTransition[] }> {
    const from = raw(paths);
    const row = await anQueryOne<{
      entries: SankeyEntry[];
      transitions: SankeyTransition[];
    }>(sql`WITH ${join([
      ...ctes,
      // ClickHouse broke count ties arbitrarily; these break them by name.
      sql`top_entries AS (
        SELECT entry_event, count(*) AS count FROM ${from}
        GROUP BY entry_event
        ORDER BY count DESC, entry_event COLLATE "C"
        LIMIT 3
      )`,
      sql`transitions AS (
        SELECT _path.events[_pair.i] AS source, _path.events[_pair.i + 1] AS target,
          _pair.i AS step, count(*) AS value
        FROM ${from} AS _path
        CROSS JOIN LATERAL generate_series(1, cardinality(_path.events) - 1) AS _pair(i)
        WHERE _path.events[1] IN (SELECT entry_event FROM top_entries)
        GROUP BY 1, 2, 3
      )`,
    ])}
    SELECT
      COALESCE((SELECT json_agg(json_build_object('entry_event', entry_event, 'count', count)
        ORDER BY count DESC, entry_event COLLATE "C") FROM top_entries), '[]') AS entries,
      COALESCE((SELECT json_agg(json_build_object('source', source, 'target', target, 'step', step, 'value', value)
        ORDER BY step, value DESC, source COLLATE "C", target COLLATE "C") FROM transitions), '[]') AS transitions`);
    return { entries: row?.entries ?? [], transitions: row?.transitions ?? [] };
  }

  async getSankey({
    projectId,
    startDate,
    endDate,
    steps = 5,
    mode,
    startEvent,
    endEvent,
    exclude = [],
    include,
    timezone,
  }: IGetSankeyInput): Promise<{
    nodes: Array<{
      id: string;
      label: string;
      nodeColor: string;
      percentage?: number;
      value?: number;
      step?: number;
    }>;
    links: Array<{ source: string; target: string; value: number }>;
  }> {
    const COLORS = chartColors.map((color) => color.main);
    const range = dateRange(startDate, endDate, { timezone });

    // 1. Build event name filter
    const eventNameFilter = this.buildEventNameFilter(
      include,
      exclude,
      startEvent?.name,
      endEvent?.name,
    );

    // 2. Build session event CTEs
    const startEventCTE = startEvent
      ? this.buildSessionEventCTE(startEvent, projectId, range, timezone)
      : null;
    const endEventCTE =
      mode === 'between' && endEvent
        ? this.buildSessionEventCTE(endEvent, projectId, range, timezone)
        : null;

    // 3. Get mode-specific config
    const { sessionFilter, eventsSliceExpr, needsStartIndex } =
      this.getModeConfig(
        mode,
        startEvent,
        endEvent,
        startEventCTE !== null,
        endEventCTE !== null,
        steps,
      );

    // 4. Paths are cut at the first event that repeats, except in 'before'
    // mode (ClickHouse's arrayEnumerateUniq check).
    const firstRepeat = raw(
      '(SELECT min(_u.i) FROM unnest(events_sliced) WITH ORDINALITY AS _u(x, i) WHERE _u.x = ANY(events_sliced[1 : _u.i - 1]))',
    );
    const eventsExpr =
      mode === 'before'
        ? raw('events_sliced')
        : sql`COALESCE(events_sliced[1 : ${firstRepeat} - 1], events_sliced)`;

    // 5. The session paths: events ordered by time with consecutive
    // duplicates removed (ClickHouse's arrayFilter over groupArray), sliced
    // per mode, at least two events long.
    const ctes: Sql[] = [];
    if (startEventCTE) {
      ctes.push(sql`start_event_sessions AS (${startEventCTE})`);
    }
    if (endEventCTE) {
      ctes.push(sql`end_event_sessions AS (${endEventCTE})`);
    }
    ctes.push(
      sql`ordered_events AS (
        SELECT ${raw(EVENTS)}.session_id, ${raw(EVENTS)}.name AS event_name, ${raw(EVENTS)}.created_at,
          lag(${raw(EVENTS)}.name) OVER (PARTITION BY ${raw(EVENTS)}.session_id ORDER BY ${raw(EVENTS)}.created_at, ${raw(EVENTS)}.name) AS previous_name
        FROM analytics.events AS ${raw(EVENTS)}
        WHERE ${and([sql`${raw(EVENTS)}.project_id = ${projectId}`, range, eventNameFilter])}
      )`,
      sql`events_deduped_cte AS (
        SELECT session_id, array_agg(event_name ORDER BY created_at, event_name) AS events_deduped
        FROM ordered_events
        WHERE previous_name IS NULL OR previous_name <> event_name
        GROUP BY session_id
      )`,
      sql`events_sliced_cte AS (
        SELECT session_id, ${eventsSliceExpr} AS events_sliced
        FROM events_deduped_cte
        ${needsStartIndex && startEvent ? sql`CROSS JOIN LATERAL (SELECT COALESCE(array_position(${DEDUPED}, ${startEvent.name}::text), 0) AS start_index) AS _first` : raw('')}
        WHERE ${sessionFilter}
      )`,
      sql`session_paths AS (
        SELECT session_id, events, events[1] AS entry_event
        FROM (SELECT session_id, ${eventsExpr} AS events FROM events_sliced_cte) AS _paths
        WHERE cardinality(events) >= 2
      )`,
    );

    // 6. Execute mode-specific logic
    let paths = 'session_paths';
    if (mode === 'between' && startEvent && endEvent) {
      // Sessions where the start event comes before the end event, cut to
      // the part between them.
      ctes.push(
        sql`between_sessions AS (
          SELECT * FROM (
            SELECT session_id, events,
              COALESCE(array_position(events, ${startEvent.name}::text), 0) AS start_index,
              COALESCE(array_position(events, ${endEvent.name}::text), 0) AS end_index
            FROM session_paths
          ) AS _positions
          WHERE start_index > 0 AND end_index > 0 AND start_index < end_index
        )`,
        // ClickHouse read the entry event as `events[start_index]` of the
        // already sliced path (the alias shadowed the column), which is the
        // start event only when it opens the path; otherwise no transition
        // starts with the entries found and the flow comes back empty.
        sql`between_paths AS (
          SELECT session_id, events, COALESCE(events[start_index], '') AS entry_event
          FROM (
            SELECT session_id, start_index, events[start_index : end_index] AS events
            FROM between_sessions
          ) AS _between
        )`,
      );
      paths = 'between_paths';
    }

    const { entries, transitions } = await this.queryFlow(ctes, paths);
    if (entries.length === 0) {
      return { nodes: [], links: [] };
    }
    const totalSessions = entries.reduce((sum, e) => sum + e.count, 0);
    return this.buildSankeyFromTransitions(
      transitions,
      entries,
      totalSessions,
      steps,
      COLORS,
    );
  }

  private buildSankeyFromTransitions(
    transitions: Array<{
      source: string;
      target: string;
      step: number;
      value: number;
    }>,
    topEntries: Array<{ entry_event: string; count: number }>,
    totalSessions: number,
    steps: number,
    COLORS: string[],
  ) {
    if (transitions.length === 0) {
      return { nodes: [], links: [] };
    }

    const TOP_DESTINATIONS_PER_NODE = 3;

    // Build the sankey progressively step by step
    const nodes = new Map<
      string,
      { event: string; value: number; step: number; color: string }
    >();
    const links: Array<{ source: string; target: string; value: number }> = [];

    // Helper to create unique node ID
    const getNodeId = (event: string, step: number) => `${event}::step${step}`;

    // Group transitions by step
    const transitionsByStep = new Map<number, typeof transitions>();
    for (const t of transitions) {
      if (!transitionsByStep.has(t.step)) {
        transitionsByStep.set(t.step, []);
      }
      transitionsByStep.get(t.step)!.push(t);
    }

    // Initialize with entry events (step 1)
    const activeNodes = new Map<string, string>(); // event -> nodeId
    topEntries.forEach((entry, idx) => {
      const nodeId = getNodeId(entry.entry_event, 1);
      nodes.set(nodeId, {
        event: entry.entry_event,
        value: entry.count,
        step: 1,
        color: COLORS[idx % COLORS.length]!,
      });
      activeNodes.set(entry.entry_event, nodeId);
    });

    // Process each step: from active nodes, find top destinations
    for (let step = 1; step < steps; step++) {
      const stepTransitions = transitionsByStep.get(step) || [];
      const nextActiveNodes = new Map<string, string>();

      // For each currently active node, find its top destinations
      for (const [sourceEvent, sourceNodeId] of activeNodes) {
        // Get transitions FROM this source event
        const fromSource = stepTransitions
          .filter((t) => t.source === sourceEvent)
          .sort((a, b) => b.value - a.value)
          .slice(0, TOP_DESTINATIONS_PER_NODE);

        for (const t of fromSource) {
          // Skip self-loops
          if (t.source === t.target) continue;

          const targetNodeId = getNodeId(t.target, step + 1);

          // Add link using unique node IDs
          links.push({
            source: sourceNodeId,
            target: targetNodeId,
            value: t.value,
          });

          // Add/update target node
          const existing = nodes.get(targetNodeId);
          if (existing) {
            existing.value += t.value;
          } else {
            // Inherit color from source or assign new
            const sourceData = nodes.get(sourceNodeId);
            nodes.set(targetNodeId, {
              event: t.target,
              value: t.value,
              step: step + 1,
              color: sourceData?.color || COLORS[nodes.size % COLORS.length]!,
            });
          }

          nextActiveNodes.set(t.target, targetNodeId);
        }
      }

      // Update active nodes for next iteration
      activeNodes.clear();
      for (const [event, nodeId] of nextActiveNodes) {
        activeNodes.set(event, nodeId);
      }

      // Stop if no more nodes to process
      if (activeNodes.size === 0) break;
    }

    // Filter links by threshold (0.25% of total sessions)
    const MIN_LINK_PERCENT = 0.25;
    const minLinkValue = Math.ceil((totalSessions * MIN_LINK_PERCENT) / 100);
    const filteredLinks = links.filter((link) => link.value >= minLinkValue);

    // Find all nodes referenced by remaining links
    const referencedNodeIds = new Set<string>();
    filteredLinks.forEach((link) => {
      referencedNodeIds.add(link.source);
      referencedNodeIds.add(link.target);
    });

    // Recompute node values from filtered links
    const nodeValuesFromLinks = new Map<string, number>();
    filteredLinks.forEach((link) => {
      const current = nodeValuesFromLinks.get(link.target) || 0;
      nodeValuesFromLinks.set(link.target, current + link.value);
    });

    // For entry nodes (step 1), only keep them if they have outgoing links after filtering
    nodes.forEach((nodeData, nodeId) => {
      if (nodeData.step === 1) {
        const hasOutgoing = filteredLinks.some((l) => l.source === nodeId);
        if (!hasOutgoing) {
          referencedNodeIds.delete(nodeId);
        }
      }
    });

    // Build final nodes array sorted by step then value
    const finalNodes = Array.from(nodes.entries())
      .filter(([id]) => referencedNodeIds.has(id))
      .map(([id, data]) => {
        const value =
          data.step === 1
            ? data.value
            : nodeValuesFromLinks.get(id) || data.value;
        return {
          id,
          label: data.event,
          nodeColor: data.color,
          percentage: (value / totalSessions) * 100,
          value,
          step: data.step,
        };
      })
      .sort((a, b) => {
        if (a.step !== b.step) return a.step - b.step;
        return b.value - a.value;
      });

    // Sanity check: Ensure all link endpoints exist in nodes
    const nodeIds = new Set(finalNodes.map((n) => n.id));
    const validLinks = filteredLinks.filter(
      (link) => nodeIds.has(link.source) && nodeIds.has(link.target),
    );

    // Combine final nodes with the same event name
    // A final node is one that has no outgoing links
    const nodesWithOutgoing = new Set(validLinks.map((l) => l.source));
    const finalNodeIds = new Set(
      finalNodes.filter((n) => !nodesWithOutgoing.has(n.id)).map((n) => n.id),
    );

    // Group final nodes by event name
    const finalNodesByEvent = new Map<string, typeof finalNodes>();
    finalNodes.forEach((node) => {
      if (finalNodeIds.has(node.id)) {
        if (!finalNodesByEvent.has(node.label)) {
          finalNodesByEvent.set(node.label, []);
        }
        finalNodesByEvent.get(node.label)!.push(node);
      }
    });

    // Create merged nodes and remap links
    const nodeIdRemap = new Map<string, string>(); // old nodeId -> new merged nodeId
    const mergedNodes = new Map<string, (typeof finalNodes)[0]>(); // merged nodeId -> node data

    finalNodesByEvent.forEach((nodesToMerge, eventName) => {
      if (nodesToMerge.length > 1) {
        // Merge multiple final nodes with same event name
        const maxStep = Math.max(...nodesToMerge.map((n) => n.step || 0));
        const totalValue = nodesToMerge.reduce(
          (sum, n) => sum + (n.value || 0),
          0,
        );
        const mergedNodeId = `${eventName}::final`;
        const firstNode = nodesToMerge[0]!;

        // Create merged node at the maximum step
        mergedNodes.set(mergedNodeId, {
          id: mergedNodeId,
          label: eventName,
          nodeColor: firstNode.nodeColor,
          percentage: (totalValue / totalSessions) * 100,
          value: totalValue,
          step: maxStep,
        });

        // Map all old node IDs to the merged node ID
        nodesToMerge.forEach((node) => {
          nodeIdRemap.set(node.id, mergedNodeId);
        });
      }
    });

    // Update links to point to merged nodes
    const remappedLinks = validLinks.map((link) => {
      const newSource = nodeIdRemap.get(link.source) || link.source;
      const newTarget = nodeIdRemap.get(link.target) || link.target;
      return {
        source: newSource,
        target: newTarget,
        value: link.value,
      };
    });

    // Combine merged nodes with non-final nodes
    const nonFinalNodes = finalNodes.filter((n) => !finalNodeIds.has(n.id));
    const finalNodesList = Array.from(mergedNodes.values());

    // Remove old final nodes that were merged
    const mergedOldNodeIds = new Set(nodeIdRemap.keys());
    const remainingNodes = nonFinalNodes.filter(
      (n) => !mergedOldNodeIds.has(n.id),
    );

    // Combine all nodes and sort
    const allNodes = [...remainingNodes, ...finalNodesList].sort((a, b) => {
      if (a.step !== b.step) return a.step! - b.step!;
      return b.value! - a.value!;
    });

    // Aggregate links that now point to the same merged target
    const linkMap = new Map<string, number>(); // "source->target" -> value
    remappedLinks.forEach((link) => {
      const key = `${link.source}->${link.target}`;
      linkMap.set(key, (linkMap.get(key) || 0) + link.value);
    });

    const aggregatedLinks = Array.from(linkMap.entries())
      .map(([key, value]) => {
        const parts = key.split('->');
        if (parts.length !== 2) return null;
        return { source: parts[0]!, target: parts[1]!, value };
      })
      .filter(
        (link): link is { source: string; target: string; value: number } =>
          link !== null,
      );

    // Final sanity check: Ensure all link endpoints exist in nodes
    const finalNodeIdsSet = new Set(allNodes.map((n) => n.id));
    const finalValidLinks: Array<{
      source: string;
      target: string;
      value: number;
    }> = aggregatedLinks.filter(
      (link) =>
        finalNodeIdsSet.has(link.source) && finalNodeIdsSet.has(link.target),
    );

    return {
      nodes: allNodes,
      links: finalValidLinks,
    };
  }
}

export const sankeyService = new SankeyService();

import { getSettingsForProject } from './organization.service';

function toChartEvent(name: string) {
  return {
    id: name,
    name,
    displayName: name,
    type: 'event' as const,
    segment: 'event' as const,
    filters: [],
  };
}

export async function getUserFlowCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  startEvent: string;
  endEvent?: string;
  mode: 'after' | 'before' | 'between';
  steps?: number;
  exclude?: string[];
  include?: string[];
}) {
  if (input.mode === 'between' && !input.endEvent) {
    throw new Error('endEvent is required when mode is "between"');
  }

  const { timezone } = await getSettingsForProject(input.projectId);
  const result = await sankeyService.getSankey({
    projectId: input.projectId,
    startDate: input.startDate,
    endDate: input.endDate,
    steps: input.steps ?? 5,
    mode: input.mode,
    startEvent: toChartEvent(input.startEvent),
    endEvent: input.endEvent ? toChartEvent(input.endEvent) : undefined,
    exclude: input.exclude ?? [],
    include: input.include,
    timezone,
  });

  return {
    mode: input.mode,
    startEvent: input.startEvent,
    endEvent: input.endEvent,
    node_count: result.nodes.length,
    link_count: result.links.length,
    nodes: result.nodes,
    links: result.links,
  };
}
