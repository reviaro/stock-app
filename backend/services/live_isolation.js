'use strict';

const fs = require('node:fs');
const path = require('node:path');

const error = () => Object.assign(new Error('Live credentials require a verified isolated service installation. Run the deployment security preflight.'), { code: 'LIVE_ISOLATION_REQUIRED', status: 503 });
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const hasLiveCredentials = env => Boolean(env.ALPACA_LIVE_API_KEY || env.ALPACA_LIVE_SECRET_KEY || env.ALPACA_LIVE_TRADING_ENABLED === 'true');
const PRIVILEGED_GROUPS = new Set(['root','sudo','wheel','docker','lxd','incus-admin','disk']);

// These checks verify filesystem facts, rather than accepting an "isolated=true"
// environment switch. The root-owned manifest is deployment configuration and
// must never contain a broker key or an operator authentication secret.
function verifyInstallation(manifest, { fileSystem = fs, uid = process.getuid?.(), gid = process.getgid?.(), executable = process.execPath,
    groups = process.getgroups?.() || [], releaseRoot = path.resolve(__dirname, '../..'), databasePath, credentialsDirectory, manifestPath, mfaStateFile, deep = false } = {}) {
    if (!manifest || manifest.version !== 1 || !Number.isSafeInteger(manifest.serviceUid) || manifest.serviceUid <= 0
        || !Number.isSafeInteger(manifest.serviceGid) || manifest.serviceGid <= 0 || uid !== manifest.serviceUid || gid !== manifest.serviceGid
        || !Array.isArray(manifest.agentUids)
        || manifest.agentUids.some(id => !Number.isSafeInteger(id) || id <= 0 || id === uid)) throw error();
    const users = fileSystem.readFileSync('/etc/passwd','utf8').split('\n').map(line=>line.split(':'));
    const groupRecords = fileSystem.readFileSync('/etc/group','utf8').split('\n').map(line=>line.split(':'));
    for (const identity of [uid,...manifest.agentUids]) {
        const user = users.find(row=>row.length>=4 && Number(row[2])===identity);
        if (!user) throw error();
        const privileged = groupRecords.some(row=>PRIVILEGED_GROUPS.has(row[0]) &&
            (Number(row[2])===Number(user[3]) || row[3]?.split(',').includes(user[0]) || (identity===uid && groups.includes(Number(row[2])))));
        if (privileged) throw error();
    }
    const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
    if (![manifest.releaseRoot, manifest.stateDirectory, databasePath, manifestPath, credentialsDirectory].every(absolute)
        || manifest.releaseRoot !== releaseRoot || !inside(manifest.stateDirectory, databasePath) || databasePath === manifest.stateDirectory
        || inside(releaseRoot, manifest.stateDirectory) || inside(manifest.stateDirectory, releaseRoot)) throw error();

    function stat(target) {
        const info = fileSystem.lstatSync(target);
        if (info.isSymbolicLink()) throw error();
        return info;
    }
    function rootProtected(target) {
        for (let current = target;; current = path.dirname(current)) {
            const info = stat(current);
            if (info.uid !== 0 || (info.mode & 0o022)) throw error();
            if (current === path.dirname(current)) break;
        }
    }
    rootProtected(manifestPath);
    rootProtected(releaseRoot);
    rootProtected(executable);
    rootProtected(path.dirname(manifest.stateDirectory));
    // LoadCredential protects its mounted copy, not the original source file.
    // The root-managed manifest must enumerate every source used by the units.
    if (!Array.isArray(manifest.credentialSources) || !manifest.credentialSources.length) throw error();
    for (const source of manifest.credentialSources) {
        if (!absolute(source)) throw error();
        rootProtected(source);
        const info = stat(source);
        if (!info.isFile() || (info.mode & 0o077)) throw error();
    }
    const state = stat(manifest.stateDirectory);
    if (!state.isDirectory() || state.uid !== uid || state.gid !== gid || (state.mode & 0o077)) throw error();
    const dbParent = path.dirname(databasePath);
    for (let current = dbParent; current !== manifest.stateDirectory; current = path.dirname(current)) {
        const info = stat(current);
        if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077)) throw error();
    }
    if (fileSystem.existsSync(databasePath)) {
        const db = stat(databasePath);
        if (!db.isFile() || db.uid !== uid || (db.mode & 0o077)) throw error();
    }
    if (mfaStateFile) {
        if (!absolute(mfaStateFile) || path.dirname(mfaStateFile) !== manifest.stateDirectory || mfaStateFile === databasePath) throw error();
        if (fileSystem.existsSync(mfaStateFile)) {
            const mfaState = stat(mfaStateFile);
            if (!mfaState.isFile() || mfaState.uid !== uid || (mfaState.mode & 0o077)) throw error();
        }
    }
    const credential = stat(path.join(credentialsDirectory, 'app.env'));
    if (!credential.isFile() || ![0, uid].includes(credential.uid) || (credential.mode & 0o277)) throw error();
    // systemd LoadCredential provides a read-only mount inaccessible to other
    // users. A same-UID writable .env copied into a fake directory is insufficient.
    const mountInfo = fileSystem.readFileSync('/proc/self/mountinfo', 'utf8');
    const decode = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const readOnlyCredentialMount = mountInfo.split('\n').some(line => {
        const fields = line.split(' ');
        return fields.length > 6 && decode(fields[4]) === credentialsDirectory && fields[5].split(',').includes('ro');
    });
    if (!readOnlyCredentialMount) throw error();
    if (deep) {
        const visited = new Set();
        function protectedRealPath(target, links = 0) {
            let current = path.parse(target).root;
            rootProtected(current);
            for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
                current = path.join(current, component);
                const info = fileSystem.lstatSync(current);
                if (info.uid !== 0) throw error();
                if (info.isSymbolicLink()) {
                    if (links >= 40) throw error();
                    // Validate each link and its lexical parents, not just the
                    // final target: an intermediate link must not be replaceable.
                    const link = fileSystem.readlinkSync(current);
                    // Preserve '..' until earlier symlinks are resolved, as the
                    // kernel does. path.resolve here would check the wrong file.
                    const lexicalTarget = path.isAbsolute(link) ? link : path.dirname(current) + path.sep + link;
                    current = protectedRealPath(lexicalTarget, links + 1);
                } else if (info.mode & 0o022) throw error();
            }
            return current;
        }
        function walk(directory) {
            if (visited.has(directory)) return;
            visited.add(directory);
            for (const name of fileSystem.readdirSync(directory)) {
                const target = path.join(directory, name);
                const info = fileSystem.lstatSync(target);
                if (info.isSymbolicLink()) {
                    const resolved = protectedRealPath(target);
                    const destination = fileSystem.lstatSync(resolved);
                    if (destination.isDirectory()) walk(resolved);
                    else if (!destination.isFile()) throw error();
                } else {
                    if (info.uid !== 0 || (info.mode & 0o022)) throw error();
                    if (info.isDirectory()) walk(target);
                    else if (!info.isFile()) throw error();
                }
            }
        }
        walk(releaseRoot);
    }
    return { isolated: true, serviceUid: uid, agentIdentities: manifest.agentUids.length };
}

function assertLiveIsolation(env = process.env, options = {}) {
    if (!hasLiveCredentials(env) && !options.force) return { required: false };
    try {
        if ((options.platform || process.platform) !== 'linux') throw error();
        if (hasLiveCredentials(env) && (!env.STOCK_DASHBOARD_TOTP_SECRET || !env.STOCK_DASHBOARD_MFA_STATE_FILE)) throw error();
        const fileSystem = options.fileSystem || fs;
        const manifestPath = env.OAKLINE_SECURITY_MANIFEST;
        if (!manifestPath) throw error();
        // Validate ownership before parsing deployment configuration.
        for (let current = manifestPath;; current = path.dirname(current)) {
            const info = fileSystem.lstatSync(current);
            if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw error();
            if (current === path.dirname(current)) break;
        }
        const manifest = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'));
        return verifyInstallation(manifest, { ...options, fileSystem, manifestPath,
            databasePath: env.DB_PATH_OVERRIDE, credentialsDirectory: env.CREDENTIALS_DIRECTORY,
            mfaStateFile: env.STOCK_DASHBOARD_MFA_STATE_FILE });
    } catch { throw error(); }
}

module.exports = { assertLiveIsolation, verifyInstallation, hasLiveCredentials };
