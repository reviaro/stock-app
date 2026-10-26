'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyInstallation, assertLiveIsolation } = require('../services/live_isolation');
const { createLiveClient } = require('../services/alpaca_live_client');
const { researchEnvironment } = require('../services/pybridge');

function fixture() {
    const manifest = { version: 1, serviceUid: 991, serviceGid: 991, agentUids: [1001], releaseRoot: '/opt/oakline/app', stateDirectory: '/var/lib/oakline', credentialSources:['/etc/oakline/app.env','/etc/oakline/paper.env'] };
    const entries = new Map();
    const item = (uid, mode, kind = 'directory') => ({ uid, gid: uid, mode, isSymbolicLink: () => kind === 'symlink', isDirectory: () => kind === 'directory', isFile: () => kind === 'file' });
    for (const name of ['/','/etc','/etc/oakline','/opt','/opt/oakline','/opt/oakline/app','/opt/oakline/runtime','/var','/var/lib']) entries.set(name,item(0,0o755));
    entries.set('/etc/oakline/security.json',item(0,0o644,'file'));
    entries.set('/etc/oakline/app.env',item(0,0o600,'file'));
    entries.set('/etc/oakline/paper.env',item(0,0o600,'file'));
    entries.set('/opt/oakline/runtime/node',item(0,0o755,'file'));
    entries.set('/var/lib/oakline',item(991,0o700));
    entries.set('/var/lib/oakline/stocks.db',item(991,0o600,'file'));
    entries.set('/run/credentials/oakline.service/app.env',item(991,0o400,'file'));
    const fileSystem = {
        lstatSync: name => { if (!entries.has(name)) throw new Error('missing fixture path'); return entries.get(name); },
        existsSync: name => entries.has(name),
        readFileSync: name => name === '/proc/self/mountinfo' ? '42 1 0:1 / /run/credentials/oakline.service ro,nosuid - tmpfs tmpfs ro\n'
            : name === '/etc/passwd' ? 'oakline:x:991:991::/var/lib/oakline:/usr/sbin/nologin\nagent:x:1001:1001::/home/agent:/bin/false\n'
            : name === '/etc/group' ? 'oakline:x:991:\nagent:x:1001:\nlxd:x:990:\n' : JSON.stringify(manifest),
        readdirSync: () => [],
    };
    const options = { fileSystem, uid:991, gid:991, groups:[991], executable:'/opt/oakline/runtime/node', releaseRoot:'/opt/oakline/app',
        databasePath:'/var/lib/oakline/stocks.db', credentialsDirectory:'/run/credentials/oakline.service', manifestPath:'/etc/oakline/security.json', deep:true };
    return { manifest, options, entries, item };
}

test('an isolated root-managed service verifies actual identity, state and credential mount', () => {
    const f = fixture();
    assert.deepEqual(verifyInstallation(f.manifest,f.options),{ isolated:true,serviceUid:991,agentIdentities:1 });
});

for (const [name, change] of [
    ['agent sharing service uid', f => { f.manifest.agentUids = [991]; }],
    ['unexpected service identity', f => { f.options.uid = 1001; }],
    ['root process', f => { f.options.uid = 0; f.manifest.serviceUid = 0; }],
    ['agent-owned release', f => f.entries.set('/opt/oakline/app',f.item(1001,0o755))],
    ['group-writable release', f => f.entries.set('/opt/oakline/app',f.item(0,0o775))],
    ['agent-owned executable', f => f.entries.set('/opt/oakline/runtime/node',f.item(1001,0o755,'file'))],
    ['symlinked manifest', f => f.entries.set('/etc/oakline/security.json',f.item(0,0o777,'symlink'))],
    ['world-readable database', f => f.entries.set('/var/lib/oakline/stocks.db',f.item(991,0o644,'file'))],
    ['database outside protected state', f => { f.options.databasePath = '/tmp/stocks.db'; }],
    ['state inside release', f => { f.manifest.stateDirectory = '/opt/oakline/app/state'; }],
    ['writable credentials', f => f.entries.set('/run/credentials/oakline.service/app.env',f.item(991,0o600,'file'))],
    ['shared credential read permission', f => f.entries.set('/run/credentials/oakline.service/app.env',f.item(991,0o440,'file'))],
    ['missing credential source declaration', f => { delete f.manifest.credentialSources; }],
    ['readable original credentials', f => f.entries.set('/etc/oakline/app.env',f.item(0,0o644,'file'))],
    ['service-owned original credentials', f => f.entries.set('/etc/oakline/app.env',f.item(991,0o600,'file'))],
    ['unprotected secondary credentials', f => f.entries.set('/etc/oakline/paper.env',f.item(0,0o640,'file'))],
    ['fake unmounted credential directory', f => { f.options.fileSystem.readFileSync = () => ''; }],
]) test(`live isolation rejects ${name}`, () => {
    const f = fixture(); change(f);
    assert.throws(() => verifyInstallation(f.manifest,f.options),{code:'LIVE_ISOLATION_REQUIRED'});
});

test('deep preflight rejects an agent-writable nested dependency', () => {
    const f = fixture();
    f.entries.set('/opt/oakline/app/dependency.js',f.item(1001,0o644,'file'));
    f.options.fileSystem.readdirSync = name => name === '/opt/oakline/app' ? ['dependency.js'] : [];
    assert.throws(() => verifyInstallation(f.manifest,f.options),{code:'LIVE_ISOLATION_REQUIRED'});
});

function linkedFixture() {
    const f = fixture();
    const links = new Map([['/opt/oakline/app/node_modules','/opt/shared']]);
    f.entries.set('/opt/oakline/app/node_modules',f.item(0,0o777,'symlink'));
    f.entries.set('/opt/shared',f.item(0,0o755));
    f.entries.set('/opt/shared/client.js',f.item(0,0o644,'file'));
    f.options.fileSystem.readlinkSync = name => links.get(name);
    f.options.fileSystem.readdirSync = name => name === '/opt/oakline/app' ? ['node_modules'] : name === '/opt/shared' ? ['client.js'] : [];
    return { ...f, links };
}

test('deep preflight traverses protected directory links and accepts protected executable links', () => {
    const f = linkedFixture();
    assert.equal(verifyInstallation(f.manifest,f.options).isolated,true);
    f.links.set('/opt/oakline/app/node_modules','/opt/shared/client.js');
    assert.equal(verifyInstallation(f.manifest,f.options).isolated,true);
});

test('deep preflight rejects writable dependencies inside a symlinked directory', () => {
    const f = linkedFixture();
    f.entries.set('/opt/shared/client.js',f.item(1001,0o644,'file'));
    assert.throws(()=>verifyInstallation(f.manifest,f.options),{code:'LIVE_ISOLATION_REQUIRED'});
});

test('deep preflight rejects replaceable intermediate link paths even when the final file is protected', () => {
    const f = linkedFixture();
    f.links.set('/opt/oakline/app/node_modules','/opt/intermediate/link');
    f.entries.set('/opt/intermediate',f.item(1001,0o755));
    f.entries.set('/opt/intermediate/link',f.item(0,0o777,'symlink'));
    f.links.set('/opt/intermediate/link','/opt/shared/client.js');
    assert.throws(()=>verifyInstallation(f.manifest,f.options),{code:'LIVE_ISOLATION_REQUIRED'});
    f.entries.set('/opt/intermediate',f.item(0,0o755));
    f.entries.set('/opt/intermediate/link',f.item(1001,0o777,'symlink'));
    assert.throws(()=>verifyInstallation(f.manifest,f.options),{code:'LIVE_ISOLATION_REQUIRED'});
    f.entries.set('/opt/intermediate/link',f.item(0,0o777,'symlink'));
    assert.equal(verifyInstallation(f.manifest,f.options).isolated,true);
});

test('deep preflight bounds link cycles and safely handles directory aliases', () => {
    const f = linkedFixture();
    f.links.set('/opt/oakline/app/node_modules','/opt/oakline/app/node_modules');
    assert.throws(()=>verifyInstallation(f.manifest,f.options),{code:'LIVE_ISOLATION_REQUIRED'});
    f.links.set('/opt/oakline/app/node_modules','/opt/oakline/app');
    assert.equal(verifyInstallation(f.manifest,f.options).isolated,true);
});

test('deep preflight resolves parent traversal after intermediate links like the kernel', () => {
    const f = linkedFixture();
    f.entries.set('/opt/client.js',f.item(0,0o644,'file'));
    f.entries.set('/opt/hop',f.item(0,0o777,'symlink'));
    f.entries.set('/var/linked',f.item(0,0o755));
    f.entries.set('/var/linked/nested',f.item(0,0o755));
    f.entries.set('/var/linked/client.js',f.item(1001,0o644,'file'));
    f.links.set('/opt/hop','/var/linked/nested');
    f.links.set('/opt/oakline/app/node_modules','/opt/hop/../client.js');
    assert.throws(()=>verifyInstallation(f.manifest,f.options),{code:'LIVE_ISOLATION_REQUIRED'});
    f.entries.set('/var/linked/client.js',f.item(0,0o644,'file'));
    assert.equal(verifyInstallation(f.manifest,f.options).isolated,true);
    f.links.set('/opt/oakline/app/node_modules','../../hop/../client.js');
    assert.equal(verifyInstallation(f.manifest,f.options).isolated,true);
});

test('host admin groups are not an agent credential isolation boundary', () => {
    const f = fixture(); const read = f.options.fileSystem.readFileSync;
    f.options.fileSystem.readFileSync = name => name === '/etc/group' ? 'oakline:x:991:\nlxd:x:990:agent\n' : read(name);
    assert.throws(()=>verifyInstallation(f.manifest,f.options),{code:'LIVE_ISOLATION_REQUIRED'});
    f.manifest.agentUids = []; // Dedicated host: no local agent identities to trust.
    assert.equal(verifyInstallation(f.manifest,f.options).isolated,true);
    f.options.groups = [991,990];
    assert.throws(()=>verifyInstallation(f.manifest,f.options),{code:'LIVE_ISOLATION_REQUIRED'});
});

test('missing isolation blocks even read-only live requests before credentials reach transport', async () => {
    let requested = false;
    const client = createLiveClient({ env:{ALPACA_LIVE_API_KEY:'synthetic-live',ALPACA_LIVE_SECRET_KEY:'synthetic-secret'},
        fetchImpl:async()=>{ requested=true; throw new Error('must not run'); } });
    await assert.rejects(client.getAccount(),{code:'LIVE_ISOLATION_REQUIRED'});
    assert.equal(requested,false);
    assert.deepEqual(assertLiveIsolation({}),{required:false});
    assert.throws(()=>assertLiveIsolation({ALPACA_LIVE_TRADING_ENABLED:'true'}),{code:'LIVE_ISOLATION_REQUIRED'});
});

test('research subprocesses receive no broker, agent, authentication or model credentials', () => {
    const env = researchEnvironment({ PATH:'/usr/bin',LANG:'C.UTF-8',ALPACA_LIVE_API_KEY:'synthetic',
        ALPACA_LIVE_SECRET_KEY:'synthetic',ALPACA_API_KEY:'synthetic',STOCK_DASHBOARD_TOTP_SECRET:'synthetic',
        STOCK_DASHBOARD_SESSION_SECRET:'synthetic',OPENAI_API_KEY:'synthetic',CREDENTIALS_DIRECTORY:'/private/credentials',
        NODE_OPTIONS:'--require=untrusted',PYTHONPATH:'/untrusted',LD_PRELOAD:'/untrusted' });
    assert.deepEqual(env,{PATH:'/usr/bin',LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'});
});
