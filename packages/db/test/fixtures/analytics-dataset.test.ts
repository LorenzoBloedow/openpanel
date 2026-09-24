import { describe, expect, it } from 'vitest';
import { generateDataset } from './analytics-dataset';

describe('analytics dataset', () => {
  const anchor = new Date('2026-09-20T12:00:00Z');
  const dataset = generateDataset({ projectId: 'proj-a', anchor });

  it('is deterministic', () => {
    expect(generateDataset({ projectId: 'proj-a', anchor })).toEqual(dataset);
    expect(generateDataset({ projectId: 'proj-a', anchor, seed: 7 }).events).not.toEqual(dataset.events);
  });

  it('has sessions consistent with their events', () => {
    const bySession = new Map<string, number>();
    for (const event of dataset.events) {
      if (event.name !== 'session_start' && event.name !== 'session_end') {
        bySession.set(event.session_id, (bySession.get(event.session_id) ?? 0) + 1);
      }
    }
    for (const session of dataset.sessions) {
      expect(session.screen_view_count + session.event_count).toBe(bySession.get(session.id));
      expect(session.duration).toBeGreaterThanOrEqual(0);
    }
    expect(dataset.sessions.length).toBeGreaterThan(200);
    expect(dataset.events.length).toBeGreaterThan(1000);
  });

  it('never places events after the anchor', () => {
    const last = dataset.events[dataset.events.length - 1]!;
    expect(new Date(`${last.created_at.replace(' ', 'T')}Z`).getTime()).toBeLessThanOrEqual(anchor.getTime());
  });

  it('covers identified and anonymous profiles', () => {
    expect(dataset.profiles.some((profile) => profile.is_external)).toBe(true);
    expect(dataset.profiles.some((profile) => !profile.is_external)).toBe(true);
    expect(dataset.events.some((event) => event.revenue > 0)).toBe(true);
  });
});
