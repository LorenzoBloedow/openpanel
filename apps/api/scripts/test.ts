/**
 * Load generator: about 25,000 synthetic events a day since 2025-01-01 in the
 * `testing` project of DATABASE_URL's analytics schema, then its rollups.
 *
 *   pnpm --filter @openpanel/api exec dotenv -e ../../.env -- jiti scripts/test.ts
 */
import { rebuildRollups } from '@openpanel/db/src/analytics/rollups';
import {
  type EventWriteRow,
  insertEvents,
} from '@openpanel/db/src/analytics/writers';
import { disposeFallbackScope } from '@openpanel/runtime';

const PROJECT_ID = 'testing';
/** One statement per batch: its rows travel as a single JSON parameter. */
const BATCH_SIZE = 5000;

async function main() {
  const startDate = new Date('2025-01-01T00:00:00Z');
  const endDate = new Date();
  const eventsPerDay = 25_000;
  const variance = 3000;

  // Event names to randomly choose from
  const eventNames = ['click', 'purchase', 'signup', 'login', 'screen_view'];

  // Loop through each day
  for (
    let currentDate = startDate;
    currentDate <= endDate;
    currentDate.setDate(currentDate.getDate() + 1)
  ) {
    const events: EventWriteRow[] = [];
    // Calculate random number of events for this day
    const dailyEvents =
      eventsPerDay + Math.floor(Math.random() * variance * 2) - variance;

    // Create events for the day
    for (let i = 0; i < dailyEvents; i++) {
      const eventTime = new Date(currentDate);
      // Distribute events throughout the day
      eventTime.setHours(Math.floor(Math.random() * 24));
      eventTime.setMinutes(Math.floor(Math.random() * 60));
      eventTime.setSeconds(Math.floor(Math.random() * 60));

      events.push({
        id: crypto.randomUUID(),
        name: eventNames[Math.floor(Math.random() * eventNames.length)]!,
        device_id: `device_${Math.floor(Math.random() * 1000)}`,
        profile_id: `profile_${Math.floor(Math.random() * 1000)}`,
        project_id: PROJECT_ID,
        session_id: `session_${Math.floor(Math.random() * 10_000)}`,
        properties: {
          hash: 'test-hash',
          'query.utm_source': 'test',
        },
        created_at: eventTime.toISOString(),
        country: 'US',
        city: 'New York',
        region: 'NY',
        longitude: -74.006,
        latitude: 40.7128,
        os: 'macOS',
        os_version: '13.0',
        browser: 'Chrome',
        browser_version: '120.0',
        device: 'desktop',
        brand: 'Apple',
        model: 'MacBook Pro',
        duration: Math.floor(Math.random() * 300),
        path: `/page-${Math.floor(Math.random() * 20)}`,
        origin: 'https://example.com',
        referrer: 'https://google.com',
        referrer_name: 'Google',
        referrer_type: 'search',
        imported_at: null,
        sdk_name: 'test-script',
        sdk_version: '1.0.0',
        groups: [],
      });
    }

    for (let start = 0; start < events.length; start += BATCH_SIZE) {
      await insertEvents(events.slice(start, start + BATCH_SIZE));
    }

    // Log progress
    console.log(
      `Created ${dailyEvents} events for ${currentDate.toISOString().split('T')[0]}`,
    );
  }

  await rebuildRollups(PROJECT_ID);
}

main()
  .catch(console.error)
  .finally(() => disposeFallbackScope());
