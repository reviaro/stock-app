const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-dashboard-suite-'));
const backend = path.resolve(__dirname, '..');
const preload = path.join(backend, 'test-support', 'environment.js');

// Start without application credentials, database overrides, NODE_OPTIONS, or
// provider URLs inherited from the shell. Tests supply their own fake settings.
const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ'];
const env = Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(env, {
    NODE_ENV: 'test',
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
    PYTHONDONTWRITEBYTECODE: '1',
    STOCK_DASHBOARD_TEST_TMPDIR: temporaryRoot,
});

const child = spawn(process.execPath, [
    '--test', '--test-concurrency=1', '--test-timeout=120000', ...process.argv.slice(2),
], { cwd: backend, env, stdio: 'inherit', detached: process.platform !== 'win32' });

let requestedExitCode = null;
let childClosed = false;
let childExitCode = 1;
let forceKill = null;
let forceKillSent = false;
let finished = false;

function signalChildren(signal) {
    if (!child.pid) return;
    try {
        // A separate POSIX process group includes Node test workers and Python
        // fixtures. Never signal the caller's terminal/process group.
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
    } catch (error) {
        if (error.code !== 'ESRCH') console.error(`Unable to stop backend tests: ${error.code}`);
    }
}

function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    clearTimeout(forceKill);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    process.exitCode = requestedExitCode ?? childExitCode;
}

function stop(signal, exitCode) {
    if (requestedExitCode !== null) return;
    requestedExitCode = exitCode;
    signalChildren(signal);
    // Retain this timer even if the direct runner exits: a fixture descendant
    // may ignore the initial signal. Windows has no process-group kill API;
    // terminate the child directly there without invoking a shell command.
    forceKill = setTimeout(() => {
        forceKillSent = true;
        signalChildren('SIGKILL');
        if (childClosed) finish();
    }, 5000);
}

const onInterrupt = () => stop('SIGINT', 130);
const onTerminate = () => stop('SIGTERM', 143);
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

const timeout = setTimeout(() => {
    console.error('Backend tests exceeded the 20-minute suite limit.');
    stop('SIGTERM', 1);
}, 20 * 60 * 1000);
timeout.unref();

child.once('error', (error) => {
    console.error(`Unable to start backend tests: ${error.message}`);
    process.exitCode = 1;
});
child.once('close', (code) => {
    childClosed = true;
    childExitCode = code === 0 ? 0 : 1;
    if (requestedExitCode === null) {
        signalChildren('SIGKILL');
        finish();
    } else if (forceKillSent) finish();
});
