'use strict';

// Use the patched dependency for application requests even when Node bundles an
// older Undici. Leave global fetch intact: the AI SDK detects Node's native fetch
// to enable its separate, DNS-validated download path (also patched in the lock).
module.exports = { fetch: require('undici').fetch };
