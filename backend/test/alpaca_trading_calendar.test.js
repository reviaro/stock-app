const { test } = require('node:test');
const assert = require('node:assert');
const { computeSessionDate, createSessionDateResolver } = require('../services/alpaca_trading_calendar');

const CALENDAR = [
    { date: '2026-09-16', open: '09:30', close: '16:00' },
    { date: '2026-09-17', open: '09:30', close: '16:00' },
    { date: '2026-09-18', open: '09:30', close: '16:00' },
    // No entry for 2026-09-19/20 (weekend) -- calendar entries are only ever real trading days.
    { date: '2026-09-21', open: '09:30', close: '16:00' },
];

test('computeSessionDate picks the session currently open, mid-day', () => {
    // 14:00 UTC = 10:00 ET on 2026-09-18 (EDT, UTC-4) -- during the 09:30 open.
    const now = new Date('2026-09-18T14:00:00.000Z');
    assert.strictEqual(computeSessionDate(CALENDAR, now), '2026-09-18');
});

test('computeSessionDate keeps reporting the prior session through the after-hours gap, not the next one preemptively', () => {
    // 23:00 UTC = 19:00 ET on 2026-09-18, well after the 16:00 close, well before 09-21's open.
    const afterClose = new Date('2026-09-18T23:00:00.000Z');
    assert.strictEqual(computeSessionDate(CALENDAR, afterClose), '2026-09-18');
});

test('computeSessionDate spans a weekend correctly to the prior Friday, never inventing Sat/Sun', () => {
    // Saturday 2026-09-19, mid-afternoon UTC -- no entry exists for this date at all.
    const saturday = new Date('2026-09-19T18:00:00.000Z');
    assert.strictEqual(computeSessionDate(CALENDAR, saturday), '2026-09-18');
});

test('computeSessionDate returns null when now precedes every entry in the given window (insufficient calendar data), rather than guessing', () => {
    const before = new Date('2026-09-01T12:00:00.000Z');
    assert.strictEqual(computeSessionDate(CALENDAR, before), null);
});

// The actual point of doing this in ET, not UTC: a UTC morning timestamp is still the *previous*
// ET calendar day's late evening -- a UTC-date-slice (the trap already rejected once this
// session for the entry-time daily-loss check) would misreport this by a full day.
test('computeSessionDate converts to America/New_York before comparing, not a UTC date slice', () => {
    // 02:00 UTC on 2026-09-19 is 22:00 ET on 2026-09-18 (EDT, UTC-4) -- still deep in the
    // 09-18 session's after-hours, a full session before 09-21 ever opens.
    const utcNextDayLocalStillPriorDay = new Date('2026-09-19T02:00:00.000Z');
    assert.strictEqual(computeSessionDate(CALENDAR, utcNextDayLocalStillPriorDay), '2026-09-18');
});

test('createSessionDateResolver caches the fetched calendar and does not refetch within the TTL', async () => {
    let calls = 0;
    const client = {
        getCalendar: async () => { calls += 1; return CALENDAR; },
    };
    const resolve = createSessionDateResolver({ client, cacheTtlMs: 60_000 });

    const first = await resolve(new Date('2026-09-18T14:00:00.000Z'));
    const second = await resolve(new Date('2026-09-18T14:00:30.000Z'));
    assert.strictEqual(first, '2026-09-18');
    assert.strictEqual(second, '2026-09-18');
    assert.strictEqual(calls, 1, 'a second call within the TTL must not refetch the calendar');
});

// The whole point of computeSessionDate reasoning in ET is defeated if the fetch window
// bounding it is computed in UTC instead -- the two would disagree right at the boundary this
// module exists to get correct.
test('createSessionDateResolver computes its fetch window boundaries in America/New_York, not UTC', async () => {
    let seenStart;
    let seenEnd;
    const client = {
        getCalendar: async ({ start, end }) => { seenStart = start; seenEnd = end; return CALENDAR; },
    };
    const resolve = createSessionDateResolver({ client, windowDaysBack: 14 });

    // 02:00 UTC on 2026-09-19 is 22:00 ET on 2026-09-18 (EDT, UTC-4) -- a UTC slice would read
    // this as the 19th.
    await resolve(new Date('2026-09-19T02:00:00.000Z'));
    assert.strictEqual(seenEnd, '2026-09-18');
    assert.strictEqual(seenStart, '2026-09-04');
});

test('createSessionDateResolver refetches once the cache has expired', async () => {
    let calls = 0;
    const client = {
        getCalendar: async () => { calls += 1; return CALENDAR; },
    };
    const resolve = createSessionDateResolver({ client, cacheTtlMs: 1_000 });

    await resolve(new Date('2026-09-18T14:00:00.000Z'));
    await resolve(new Date('2026-09-18T14:00:02.000Z'));
    assert.strictEqual(calls, 2, 'a call after the TTL has elapsed must refetch');
});
