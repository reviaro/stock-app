'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { initializeTlsTrust } = require('../services/tls_trust');
const { assertLiveIsolation } = require('../services/live_isolation');

function loadServiceCredentials(env = process.env) {
    const directory = env.CREDENTIALS_DIRECTORY;
    if (!directory || !path.isAbsolute(directory)) throw new Error('The isolated launcher requires systemd LoadCredential.');
    const values = require('dotenv').parse(fs.readFileSync(path.join(directory, 'app.env')));
    // Do not let credential content redirect the root-owned installation policy,
    // executable/module loading, state path, or systemd credential mount.
    const prohibited = /^(?:NODE_|LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|DB_PATH_OVERRIDE$|CREDENTIALS_DIRECTORY$|OAKLINE_SECURITY_MANIFEST$|STOCK_DASHBOARD_MFA_STATE_FILE$|SAMPLE_DATA$)/;
    for (const key of Object.keys(values)) if (prohibited.test(key)) throw new Error('Credential file contains a reserved runtime setting.');
    Object.assign(env, values);
    return env;
}

async function main() {
    process.umask(0o077);
    loadServiceCredentials();
    initializeTlsTrust();
    assertLiveIsolation(process.env, { force: true, deep: true });
    if (process.argv.includes('--check')) {
        console.log(JSON.stringify({ installation: 'verified', tls: 'verified', credentials: 'loaded privately', brokerRequests: 0 }));
        return;
    }
    if (process.argv.includes('--paper-monitor')) {
        await require('../workers/alpaca_day_trading_v2_monitor').startMonitor();
    } else {
        await require('../server').start();
    }
}
if (require.main === module) main().catch(error => { console.error(error.code || 'ISOLATED_START_FAILED'); process.exitCode = 1; });
module.exports = { loadServiceCredentials };
