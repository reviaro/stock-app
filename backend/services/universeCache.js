const cron = require('node-cron');
const { updateUniverse } = require('./pybridge');
const { getDb } = require('../database/db');

function isUniverseCacheEmpty() {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.get('SELECT COUNT(*) as count FROM universe_cache', [], (err, row) => {
            db.close();
            if (err) resolve(true); // assume empty on error
            else resolve(!row || row.count === 0);
        });
    });
}

async function initUniverseScheduler() {
    // Schedule nightly refresh at 6 PM ET Mon-Fri
    // 0 18 * * 1-5 = At 18:00 (6 PM) on every day-of-week from Monday through Friday
    cron.schedule('0 18 * * 1-5', async () => {
        console.log('[Universe Cache] Starting nightly refresh...');
        try {
            await updateUniverse();
            console.log('[Universe Cache] Refresh complete.');
        } catch (err) {
            console.error('[Universe Cache] Refresh failed:', err.message);
        }
    }, {
        scheduled: true,
        timezone: "America/New_York"
    });

    // Warm-up on first boot if cache is empty
    try {
        const empty = await isUniverseCacheEmpty();
        if (empty) {
            console.log('[Universe Cache] Empty cache detected — running initial population...');
            // Non-blocking warm-up
            updateUniverse()
                .then(() => console.log('[Universe Cache] Initial population complete.'))
                .catch(err => console.error('[Universe Cache] Startup warm-up failed:', err.message));
        } else {
            console.log('[Universe Cache] Cache already populated, skipping warm-up.');
        }
    } catch (err) {
        console.error('[Universe Cache] Cache check failed:', err.message);
    }
}

module.exports = { initUniverseScheduler };
