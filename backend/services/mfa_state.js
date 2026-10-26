'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const unavailable = () => Object.assign(new Error('Authenticator verification is temporarily unavailable. Contact the operator.'), { code: 'AUTH_MFA_UNAVAILABLE' });

// A short exclusive lock coordinates all app processes. A lock left by a killed
// process deliberately blocks MFA until the operator checks and removes it;
// never guess that an interrupted counter update did not happen.
function createMfaState(file, secret) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) throw unavailable();
    const directory = path.dirname(file);
    const keyId = crypto.createHash('sha256').update(secret).digest('hex');
    function checkDirectory() {
        const info = fs.lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)
            || fs.realpathSync(directory) !== directory) throw unavailable();
    }
    function read() {
        let existing;
        try { existing = fs.lstatSync(file); }
        catch (error) { if (error.code === 'ENOENT') return { version: 1, keyId, counter: -1 }; throw error; }
        if (!existing.isFile() || existing.isSymbolicLink()) throw unavailable();
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const info = fs.fstatSync(fd);
            if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 1024) throw unavailable();
            const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
            if (state.version !== 1 || state.keyId !== keyId || !Number.isSafeInteger(state.counter) || state.counter < -1) throw unavailable();
            return state;
        } finally { fs.closeSync(fd); }
    }
    // Validate existing state without creating files during auth construction.
    try { checkDirectory(); read(); } catch { throw unavailable(); }
    return {
        consume(counter) {
            if (!Number.isSafeInteger(counter) || counter < 0) return false;
            let lock, temporary;
            try {
                checkDirectory();
                lock = fs.openSync(file + '.lock', fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
                const current = read();
                if (counter <= current.counter) return false;
                temporary = path.join(directory, '.mfa-state-' + crypto.randomUUID());
                const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
                try {
                    fs.writeFileSync(fd, JSON.stringify({ version: 1, keyId, counter }) + '\n');
                    fs.fsyncSync(fd);
                } finally { fs.closeSync(fd); }
                fs.renameSync(temporary, file); temporary = null;
                const dirfd = fs.openSync(directory, fs.constants.O_RDONLY);
                try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
                return true;
            } catch { throw unavailable(); }
            finally {
                if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Preserve original failure. */ } }
                if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(file + '.lock'); }
            }
        },
    };
}

module.exports = { createMfaState };
