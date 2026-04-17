const cron = require('node-cron');
const { snapshotWatchlist } = require('./snapshotService');

let initialized = false;

function initSnapshotScheduler() {
    if (initialized) return;
    initialized = true;

    const schedules = [
        { expr: '45 9 * * 1-5', slot: 'openish' },
        { expr: '30 12 * * 1-5', slot: 'midday' },
        { expr: '45 15 * * 1-5', slot: 'closeish' },
    ];

    for (const schedule of schedules) {
        cron.schedule(
            schedule.expr,
            async () => {
                try {
                    const result = await snapshotWatchlist(schedule.slot);
                    console.log(`[snapshotScheduler] Captured ${result.data.count} snapshots for ${schedule.slot}`);
                } catch (error) {
                    console.error(`[snapshotScheduler] Failed ${schedule.slot}:`, error);
                }
            },
            {
                timezone: 'America/New_York',
            }
        );
    }

    console.log('[snapshotScheduler] Scheduled watchlist snapshots at 9:45, 12:30, and 15:45 America/New_York');
}

module.exports = {
    initSnapshotScheduler,
};
