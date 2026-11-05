'use strict';
const { createLongTermStore } = require('./alpaca_long_term_store');
module.exports = createLongTermStore({ environment: 'live' });
