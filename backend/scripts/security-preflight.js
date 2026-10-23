'use strict';
const { initializeTlsTrust } = require('../services/tls_trust');
const { assertLiveIsolation } = require('../services/live_isolation');
const { loadServiceCredentials } = require('./start-isolated');
try {
    if (process.argv.includes('--tls-only')) {
        console.log(JSON.stringify({ tls: initializeTlsTrust() }));
    } else {
        loadServiceCredentials();
        const tls = initializeTlsTrust();
        const installation = assertLiveIsolation(process.env, { force: true, deep: true });
        console.log(JSON.stringify({ tls, installation, brokerRequests: 0 }));
    }
} catch (error) { console.error(error.code || 'SECURITY_PREFLIGHT_FAILED'); process.exitCode = 1; }
