const cron = require('node-cron');
const { updateUniverse } = require('./pybridge');
let initialized=false;
const { getDb } = require('../database/db');

function isUniverseCacheEmpty() {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.get("SELECT COUNT(*) as count, MIN(updated_at) as oldest, MAX(updated_at) as newest,SUM(CASE WHEN price_date IS NULL OR universe_version IS NULL THEN 1 ELSE 0 END) as incomplete FROM universe_cache", [], (err, row) => {
            db.close();
            if (err) resolve(true); // assume empty on error
            else {
                const stamp=value=>Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value||'')?value:(value||'').replace(' ','T')+'Z');
                resolve(!row || row.incomplete>0 || row.count<10 || !Number.isFinite(stamp(row.oldest)) || Date.now()-stamp(row.oldest)>96*3600_000 || stamp(row.newest)-stamp(row.oldest)>3600_000);
            }
        });
    });
}

async function initUniverseScheduler() {
    if(initialized)return;initialized=true;
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
            console.log('[Universe Cache] Empty or stale cache detected — running initial population...');
            // Non-blocking warm-up
            updateUniverse()
                .then(() => console.log('[Universe Cache] Initial population complete.'))
                .catch(err => console.error('[Universe Cache] Startup warm-up failed:', err.message));
        } else {
            console.log('[Universe Cache] Coherent, current cache present; skipping warm-up.');
        }
    } catch (err) {
        console.error('[Universe Cache] Cache check failed:', err.message);
    }
}

module.exports = { initUniverseScheduler };
