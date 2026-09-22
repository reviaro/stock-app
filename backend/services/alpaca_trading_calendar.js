// "YYYY-MM-DD HH:MM" in America/New_York wall-clock time. Comparable lexicographically against
// itself since every field is fixed-width and zero-padded -- no Date parsing or UTC-offset math
// needed on either side of a comparison, which sidesteps the DST-transition-day ambiguity that
// converting an exchange-local "HH:MM" string into a precise UTC instant would otherwise create.
function easternWallClock(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

// Pure: the trading day whose session is current, or the most recently completed one -- never
// the next day's, until that day's own session has actually opened. `calendarEntries` must be
// sorted ascending by date (Alpaca's GET /v2/calendar already returns them that way) and are
// assumed to already be genuine NYSE trading days only (holidays/weekends never appear at all),
// so no separate holiday check is needed here.
function computeSessionDate(calendarEntries, now) {
    const nowEt = easternWallClock(now);
    let sessionDate = null;
    for (const entry of calendarEntries) {
        const openEt = `${entry.date} ${entry.open}`;
        if (openEt > nowEt) break;
        sessionDate = entry.date;
    }
    return sessionDate;
}

// The calendar changes only a handful of times a year (new holidays published); caching it
// avoids a broker round trip on every 60s tick for data that is effectively static. Cache state
// lives in the closure, not module scope, so each worker/test instance owns its own -- mirrors
// createWorker/createPaperClient's own factory shape rather than shared mutable module state.
//
// In addition to TTL expiration, the cache tracks coverage through the requested ET end date
// (`coversThroughEt`). When wall-clock time advances to a new ET calendar day, the cache refetches
// so that today's trading session is included. Coverage is keyed on the requested end date,
// never on the last entry's date, so non-trading days (weekends/holidays) without entries do
// not cause a refetch on every tick.
function createSessionDateResolver({ client, cacheTtlMs = 24 * 60 * 60 * 1000, windowDaysBack = 14 } = {}) {
    let cache = null; // { entries, fetchedAtMs, coversThroughEt }

    return async function resolveSessionDate(now = new Date()) {
        const nowMs = now.getTime();
        const todayEt = easternWallClock(now).slice(0, 10);
        if (!cache || (nowMs - cache.fetchedAtMs) > cacheTtlMs || todayEt > cache.coversThroughEt) {
            // Both bounds computed in the same frame computeSessionDate reasons in (ET) --
            // mixing a UTC-sliced bound with ET-based comparison is exactly the disagreement
            // this module exists to avoid, and would only show up right at the UTC/ET boundary
            // a naive fixture is unlikely to happen to exercise.
            const start = easternWallClock(new Date(nowMs - windowDaysBack * 24 * 60 * 60 * 1000)).slice(0, 10);
            const end = todayEt;
            const entries = await client.getCalendar({ start, end });
            cache = { entries, fetchedAtMs: nowMs, coversThroughEt: end };
        }
        return computeSessionDate(cache.entries, now);
    };
}

module.exports = { computeSessionDate, createSessionDateResolver };
