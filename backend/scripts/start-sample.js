const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { hashPassword } = require('../services/auth');
const { SAMPLE_DB_PATH, assertSamplePath, verifySampleDatabase } = require('../services/sample_mode');

const BACKEND = path.resolve(__dirname, '..');
// Deliberately exclude inherited broker/auth/database variables and the normal .env.
function buildSampleEnvironment(parent = process.env, optional = {}) {
    const env = {};
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
        if (parent[key]) env[key] = parent[key];
    }
    for (const key of ['GOOGLE_GENERATIVE_AI_API_KEY', 'LMSTUDIO_BASE_URL', 'LMSTUDIO_MODEL', 'PYTHON_PATH', 'PORTFOLIO_LAB_PYTHON']) {
        if (optional[key]) env[key] = optional[key];
    }
    return { ...env,
        SAMPLE_DATA: '1', DB_PATH_OVERRIDE: SAMPLE_DB_PATH,
        PORT: '3003', STOCK_DASHBOARD_HOST: '127.0.0.1',
        STOCK_DASHBOARD_USERNAME: 'sample-investor',
        STOCK_DASHBOARD_PASSWORD_HASH: hashPassword('sample-portfolio'),
        STOCK_DASHBOARD_SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
        STOCK_DASHBOARD_SECURE_COOKIE: '0', STOCK_DASHBOARD_ALLOW_LOOPBACK: '0',
    };
}

async function main() {
    if (process.argv.length > 2) throw new Error('start:sample takes no arguments');
    assertSamplePath(SAMPLE_DB_PATH);
    await verifySampleDatabase(SAMPLE_DB_PATH);
    const envFile = path.join(BACKEND, '.env.sample');
    const optional = fs.existsSync(envFile) ? require('dotenv').parse(fs.readFileSync(envFile)) : {};
    const env = buildSampleEnvironment(process.env, optional);
    console.log('Local sample: http://127.0.0.1:3003');
    console.log('Demo login: sample-investor / sample-portfolio');
    console.log('Uses sample.db only. Normal .env and broker credentials are not loaded.');
    const child = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env, stdio: 'inherit' });
    const forwardInt = () => child.kill('SIGINT');
    const forwardTerm = () => child.kill('SIGTERM');
    process.on('SIGINT', forwardInt);
    process.on('SIGTERM', forwardTerm);
    child.once('error', () => { console.error('Unable to start sample server'); process.exitCode = 1; });
    child.once('exit', (code, signal) => {
        process.removeListener('SIGINT', forwardInt);
        process.removeListener('SIGTERM', forwardTerm);
        process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
    });
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildSampleEnvironment };
