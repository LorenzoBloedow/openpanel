import type { IChartEvent, IChartEventFilter, IChartRange } from '@openpanel/validation';

import { getUserFlowCore, sankeyService } from '../../../src/services/sankey.service';
import type { GoldenCase, GoldenProjectKey } from '../harness';
import { explicitWindow, window } from './common';

// Session paths are built from events ordered by created_at, and the dataset
// has a few same-second events inside a session (e.g. a button_click and the
// next screen_view); their order is undefined, and so are ties in the
// top-entry/top-destination cuts. The cases below were checked to give the
// same output under either order. Include-lists drawn from session_start,
// revenue, purchase, signup and session_end can never tie.

type Window = ReturnType<typeof window>;

function filter(
  name: string,
  operator: IChartEventFilter['operator'],
  value: IChartEventFilter['value'],
): IChartEventFilter {
  return { id: `${name}:${operator}`, name, operator, value };
}

function event(name: string, filters: IChartEventFilter[] = []): IChartEvent {
  return { id: name, name, displayName: name, segment: 'event', filters };
}

interface SankeyOptions {
  mode: 'after' | 'before' | 'between';
  startEvent: IChartEvent;
  endEvent?: IChartEvent;
  steps?: number;
  exclude?: string[];
  include?: string[];
}

/** The input the tRPC `chart.sankey` procedure hands to getSankey. */
function sankeyInput(win: Window, options: SankeyOptions) {
  return {
    ...win,
    steps: options.steps ?? 5,
    mode: options.mode,
    startEvent: options.startEvent,
    endEvent: options.endEvent,
    exclude: options.exclude ?? [],
    include: options.include,
  };
}

// Nodes are sorted by step and value and links come out in build order; both
// break ties by the (undefined) row order of the transition query.
const UNORDERED = ['nodes', 'links'];

function sankeyCase(
  name: string,
  project: GoldenProjectKey,
  range: IChartRange,
  options: SankeyOptions,
): GoldenCase {
  return {
    name,
    run: () => sankeyService.getSankey(sankeyInput(window(project, range), options)),
    unordered: UNORDERED,
  };
}

const SESSION_EVENTS = ['session_start', 'session_end'];

export const group = 'sankey';

export const cases: GoldenCase[] = [
  // --- after ------------------------------------------------------------------
  sankeyCase('getSankey sthlm 30d after session_start 5', 'sthlm', '30d', {
    mode: 'after',
    startEvent: event('session_start'),
  }),
  sankeyCase('getSankey ny 30d after session_start 5', 'ny', '30d', {
    mode: 'after',
    startEvent: event('session_start'),
  }),
  sankeyCase('getSankey ny 30d after session_start 2', 'ny', '30d', {
    mode: 'after',
    startEvent: event('session_start'),
    steps: 2,
  }),
  sankeyCase('getSankey sthlm 30d after screen_view 3 exclude session events', 'sthlm', '30d', {
    mode: 'after',
    startEvent: event('screen_view'),
    steps: 3,
    exclude: SESSION_EVENTS,
  }),
  sankeyCase('getSankey sthlm 30d after screen_view 10', 'sthlm', '30d', {
    mode: 'after',
    startEvent: event('screen_view'),
    steps: 10,
  }),
  sankeyCase('getSankey sthlm 30d after pricing view (filtered start)', 'sthlm', '30d', {
    mode: 'after',
    startEvent: event('screen_view', [filter('path', 'is', ['/pricing'])]),
    steps: 4,
  }),
  sankeyCase('getSankey sthlm 30d after session_start 4 desktop (filtered start)', 'sthlm', '30d', {
    mode: 'after',
    startEvent: event('session_start', [filter('device', 'is', ['desktop'])]),
    steps: 4,
  }),
  sankeyCase('getSankey sthlm 30d after missing event', 'sthlm', '30d', {
    mode: 'after',
    startEvent: event('does_not_exist'),
  }),

  // --- before -----------------------------------------------------------------
  sankeyCase('getSankey ny 30d before link_out 3', 'ny', '30d', {
    mode: 'before',
    startEvent: event('link_out'),
    steps: 3,
  }),
  sankeyCase('getSankey sthlm 30d before session_end 4 include revenue,purchase', 'sthlm', '30d', {
    mode: 'before',
    startEvent: event('session_end'),
    steps: 4,
    include: ['revenue', 'purchase'],
  }),
  sankeyCase('getSankey utc 3m before session_end include revenue,purchase,signup', 'utc', '3m', {
    mode: 'before',
    startEvent: event('session_end'),
    include: ['revenue', 'purchase', 'signup'],
  }),

  // --- between ----------------------------------------------------------------
  sankeyCase('getSankey sthlm 30d between session_start>purchase 6', 'sthlm', '30d', {
    mode: 'between',
    startEvent: event('session_start'),
    endEvent: event('purchase'),
    steps: 6,
  }),
  // Paths keep session_start first, so screen_view is never the first event:
  // ClickHouse then reads `events[start_index]` from the already sliced
  // `events` alias and finds no entry event, returning an empty flow.
  sankeyCase('getSankey sthlm 30d between screen_view>revenue (start not first)', 'sthlm', '30d', {
    mode: 'between',
    startEvent: event('screen_view'),
    endEvent: event('revenue'),
  }),
  sankeyCase('getSankey sthlm 30d between screen_view>revenue exclude session_start', 'sthlm', '30d', {
    mode: 'between',
    startEvent: event('screen_view'),
    endEvent: event('revenue'),
    steps: 7,
    exclude: ['session_start'],
  }),
  sankeyCase('getSankey ny 30d between session_start>big revenue (filtered end)', 'ny', '30d', {
    mode: 'between',
    startEvent: event('session_start'),
    endEvent: event('revenue', [filter('revenue', 'gt', [1000])]),
  }),
  sankeyCase('getSankey sthlm 30d between without endEvent', 'sthlm', '30d', {
    mode: 'between',
    startEvent: event('screen_view'),
    steps: 3,
  }),

  // --- DST windows ----------------------------------------------------------------
  {
    name: 'getSankey sthlm DST weekend after session_start',
    run: () =>
      sankeyService.getSankey(
        sankeyInput(explicitWindow('sthlm', '2026-03-28 00:00:00', '2026-03-30 23:59:59'), {
          mode: 'after',
          startEvent: event('session_start'),
        }),
      ),
    unordered: UNORDERED,
  },
  {
    name: 'getSankey ny DST weekend after session_start',
    run: () =>
      sankeyService.getSankey(
        sankeyInput(explicitWindow('ny', '2026-03-07 00:00:00', '2026-03-09 23:59:59'), {
          mode: 'after',
          startEvent: event('session_start'),
        }),
      ),
    unordered: UNORDERED,
  },

  // --- getUserFlowCore (insights API / agent tools) --------------------------------------
  {
    name: 'getUserFlowCore sthlm 30d after session_start',
    run: () =>
      getUserFlowCore({ ...window('sthlm', '30d'), startEvent: 'session_start', mode: 'after' }),
    unordered: UNORDERED,
  },
  {
    name: 'getUserFlowCore ny 3m between session_start>purchase include revenue,signup',
    run: () =>
      getUserFlowCore({
        ...window('ny', '3m'),
        startEvent: 'session_start',
        endEvent: 'purchase',
        mode: 'between',
        steps: 8,
        include: ['revenue', 'signup'],
      }),
    unordered: UNORDERED,
  },
  {
    name: 'getUserFlowCore utc 30d before session_end include',
    run: () =>
      getUserFlowCore({
        ...window('utc', '30d'),
        startEvent: 'session_end',
        mode: 'before',
        steps: 4,
        include: ['screen_view', 'button_click', 'purchase'],
      }),
    unordered: UNORDERED,
  },
  {
    name: 'getUserFlowCore error between without endEvent',
    run: () =>
      getUserFlowCore({ ...window('sthlm', '30d'), startEvent: 'screen_view', mode: 'between' }),
  },
];
