'use strict';
const { createLongTermInvesting, orderObservation, cleanOrder } = require('./alpaca_long_term_investing');
const store = require('./alpaca_live_store');
const { configuration, createLiveClient } = require('./alpaca_live_client');
function createLiveInvesting(options = {}) {
    const env = options.env || process.env;
    return createLongTermInvesting({store, env, configuration, clientFactory:()=>createLiveClient({env}), ...options});
}
module.exports = { createLiveInvesting, orderObservation, cleanOrder };
