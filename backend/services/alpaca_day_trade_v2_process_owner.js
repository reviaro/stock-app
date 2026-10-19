'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

// A live or unidentifiable sender must retain its admission. Time passing is not
// evidence that a paused process can no longer send an order.
function createProcessIdentity({ pid = process.pid, platform = process.platform, kill = process.kill, readFile = fs.readFileSync } = {}) {
    function startId(processId) {
        if (platform !== 'linux') return null;
        try {
            const stat = readFile(`/proc/${processId}/stat`, 'utf8');
            // comm may contain spaces and parentheses; field 22 follows its last ')'.
            const value = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
            return /^\d+$/.test(value || '') ? value : null;
        } catch (_error) {
            return null;
        }
    }

    function isAlive(owner) {
        if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return true;
        try { kill(owner.pid, 0); } catch (error) {
            // EPERM, an unsupported probe, or any other failure is not proof of exit.
            return error.code !== 'ESRCH';
        }
        const currentStart = owner.start == null ? null : startId(owner.pid);
        return currentStart == null || currentStart === owner.start;
    }

    return { owner: { pid, start: startId(pid) }, isAlive };
}

const identity = createProcessIdentity();
const activeAttempts = new Set();

function beginEntryAttempt() {
    const owner = { ...identity.owner, attempt: crypto.randomUUID() };
    activeAttempts.add(owner.attempt);
    return owner;
}

function endEntryAttempt(owner) {
    activeAttempts.delete(owner.attempt);
}

function isEntrySenderActive(owner) {
    if (owner?.attempt && owner.pid === identity.owner.pid && owner.start === identity.owner.start) {
        return activeAttempts.has(owner.attempt);
    }
    return identity.isAlive(owner);
}

module.exports = { createProcessIdentity, beginEntryAttempt, endEntryAttempt, isEntrySenderActive };
