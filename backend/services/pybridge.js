const { spawn } = require('child_process');
const path = require('path');
const {
    createAsyncTtlCache,
    createBatchingStockInfoLoader,
} = require('./market_data_cache');

const PYTHON_BIN = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
const PYTHON_PATH = process.env.PYTHON_PATH || path.join(__dirname, '..', 'venv', PYTHON_BIN);
const SCRIPT_PATH = path.join(__dirname, '..', 'python', 'yf_wrapper.py');

function researchEnvironment(env = process.env) {
    // Market-data workers need locale/cache/transport settings, not operator,
    // model-provider or broker credentials. Never inherit the full app env.
    const allowed = ['PATH','HOME','USER','LANG','LC_ALL','TZ','TMPDIR','TMP','TEMP','SystemRoot','WINDIR',
        'XDG_CACHE_HOME','SSL_CERT_FILE','SSL_CERT_DIR','REQUESTS_CA_BUNDLE','CURL_CA_BUNDLE',
        'DB_PATH_OVERRIDE','SAMPLE_DATA'];
    return { ...Object.fromEntries(allowed.filter(key => env[key] !== undefined).map(key => [key,env[key]])),
        PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };
}

function createPythonCaller({
    spawnImpl = spawn,
    pythonPath = PYTHON_PATH,
    scriptPath = SCRIPT_PATH,
    timeoutMs = Number(process.env.PYTHON_TIMEOUT_MS) || 45_000,
    maxOutputBytes = Number(process.env.PYTHON_MAX_OUTPUT_BYTES) || 5 * 1024 * 1024,
    maxConcurrent = 4, maxQueue = 32, queueTimeoutMs = 10_000,
} = {}) {
    function runRequest(request) {
        return new Promise((resolve, reject) => {
            const python = spawnImpl(pythonPath, [scriptPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: researchEnvironment(),
            });
            let stdout = '';
            let stderr = '';
            let outputBytes = 0;
            let settled = false;

            const requestTimeoutMs = request.action==='update_universe' ? Math.max(timeoutMs,300_000) : timeoutMs;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                python.kill('SIGKILL');
                reject(new Error(`Python request timed out after ${requestTimeoutMs}ms`));
            }, requestTimeoutMs);

            function settle(callback, value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback(value);
            }

            function collect(data, target) {
                if (settled) return;
                outputBytes += Buffer.byteLength(data);
                if (outputBytes > maxOutputBytes) {
                    settled = true;
                    clearTimeout(timer);
                    python.kill('SIGKILL');
                    reject(new Error(`Python output limit exceeded (${maxOutputBytes} bytes)`));
                    return;
                }
                if (target === 'stdout') stdout += data.toString();
                else stderr += data.toString();
            }

            python.stdout.on('data', (data) => collect(data, 'stdout'));
            python.stderr.on('data', (data) => collect(data, 'stderr'));
            python.on('error', (error) => settle(reject, error));
            python.on('close', (code) => {
                if (settled) return;
                if (code !== 0) {
                    settle(reject, new Error(`Python process exited with code ${code}: ${stderr}`));
                    return;
                }
                try {
                    settle(resolve, JSON.parse(stdout));
                } catch (_error) {
                    settle(reject, new Error(`Failed to parse Python output: ${stdout.slice(0, 500)}`));
                }
            });
            python.stdin.write(JSON.stringify(request));
            python.stdin.end();
        });
    }
    let active=0;const queue=[];
    function pump(){
        while(active<maxConcurrent&&queue.length){
            const entry=queue.shift();clearTimeout(entry.timer);active++;
            runRequest(entry.request).then(entry.resolve,entry.reject).finally(()=>{active--;pump();});
        }
    }
    return function callPython(request){
        if(queue.length>=maxQueue)return Promise.reject(new Error('Research request queue is full'));
        return new Promise((resolve,reject)=>{
            const entry={request,resolve,reject};
            entry.timer=setTimeout(()=>{const index=queue.indexOf(entry);if(index>=0)queue.splice(index,1);reject(new Error('Research request queue timed out'));},queueTimeoutMs);
            queue.push(entry);pump();
        });
    };
}

const callPython = createPythonCaller();
const {createSecSource}=require('./sec_fundamentals');
const {createNewsSource}=require('./research_news');

function createPybridge({
    callPython: runPython = callPython,
    quoteTtlMs = Number(process.env.MARKET_QUOTE_CACHE_TTL_MS || 60_000),
    staleQuoteTtlMs = Number(process.env.MARKET_QUOTE_STALE_TTL_MS || 15 * 60_000),
    batchDelayMs = Number(process.env.MARKET_QUOTE_BATCH_DELAY_MS || 15),
    marketTtlMs = Number(process.env.MARKET_SUMMARY_CACHE_TTL_MS || 60_000),
    secSource = createSecSource(), newsSource = createNewsSource(),
} = {}) {
    const stockInfoLoader = createBatchingStockInfoLoader({
        ttlMs: quoteTtlMs,
        staleTtlMs: staleQuoteTtlMs,
        batchDelayMs,
        fetchBatch: async (symbols) => {
            const result = await runPython({ action: 'info_batch', symbols });
            if (result?.status !== 'success' || !result.data) {
                throw new Error(result?.error || 'Batch market data request failed');
            }
            return Object.fromEntries(Object.entries(result.data).map(([symbol,value])=>[symbol,{...value,meta:{source:result.meta?.source||'yfinance',retrievedAt:result.meta?.retrievedAt||new Date().toISOString(),...value.meta}}]));
        },
    });
    const marketCache = createAsyncTtlCache({ ttlMs: marketTtlMs });
    const sectorCache = createAsyncTtlCache({ ttlMs: Math.max(marketTtlMs, 5 * 60_000) });
    const screenerCache = createAsyncTtlCache({ ttlMs: 5 * 60_000 });
    const researchCache = createAsyncTtlCache({ ttlMs: 5 * 60_000 });
    async function filings(symbol) { try { return await secSource.get(symbol); } catch { return {status:'error',meta:{source:'sec_edgar',unavailable:true}}; } }
    async function quality(symbol) {
        const primary=await filings(symbol);
        if(primary?.status==='success') {
            const info=await stockInfoLoader.get(symbol);
            const result=info?.status==='success'?await runPython({action:'quality_records',symbol,statements:primary.data,info:info.data}):null;
            if(result?.data?.coveragePct>=60)return result;
        }
        const result=await runPython({action:'quality',symbol});
        return {...result,meta:{...result?.meta,source:'yfinance',primarySourceStatus:primary?.configurationRequired?'configuration_required':primary?.status==='success'?'insufficient_coverage':'unavailable'}};
    }

    const warming=new Set(),warmQueue=[];let warmActive=0;
    function warmQuality(symbol){
        if(warming.has(symbol))return;
        warming.add(symbol);warmQueue.push(symbol);pumpWarm();
    }
    function pumpWarm(){
        while(warmActive<2&&warmQueue.length){
            const symbol=warmQueue.shift();warmActive++;
            researchCache.get('quality:'+symbol,()=>quality(symbol)).catch(()=>{}).finally(()=>{
                warming.delete(symbol);warmActive--;pumpWarm();
                if(!warmActive&&!warmQueue.length)setImmediate(()=>screenerCache.clear()).unref();
            });
        }
    }
    return {
        getStockInfo(symbol) {
            return stockInfoLoader.get(symbol);
        },
        getStockHistory(symbol, period = '1y', interval = '1d') {
            return runPython({ action: 'history', symbol, period, interval });
        },
        getCANSlimAnalysis(symbol) {
            return researchCache.get('canslim:'+symbol,async()=>{
                const primary=await filings(symbol);
                const result=await runPython({action:'canslim',symbol,...(primary?.status==='success'?{statements:primary.data}:{})});
                return {...result,meta:{...result?.meta,fundamentalSource:primary?.status==='success'?'sec_edgar':'yfinance'}};
            });
        },
        getTechnicalIndicators(symbol) {
            return researchCache.get('technical:'+symbol,()=>runPython({ action: 'technical', symbol }));
        },
        getMarketIndexes() {
            return marketCache.get('indexes', () => runPython({ action: 'indexes' }));
        },
        updateUniverse() {
            return runPython({ action: 'update_universe' });
        },
        getMarketDirection() {
            return marketCache.get('direction', () => runPython({ action: 'market_direction' }));
        },
        getNews(symbol) {
            return researchCache.get('news:'+symbol,async()=>{
                try { const primary=await newsSource.get(symbol);if(primary)return primary; } catch { /* Preserve a labeled research fallback. */ }
                const result=await runPython({action:'news',symbol});
                return {...result,meta:{...result?.meta,source:'yfinance',primarySourceStatus:newsSource.configured()?'unavailable':'not_configured'}};
            });
        },
        getEarningsDate(symbol) {
            return runPython({ action: 'earnings', symbol });
        },
        getSectorPerformance() {
            return sectorCache.get('sectors', () => runPython({ action: 'sectors' }));
        },
        getQualityMetrics(symbol) {
            return researchCache.get('quality:'+symbol,()=>quality(symbol));
        },
        getFilings(symbol) {return filings(symbol);},
        getFundResearch(symbol) {return researchCache.get('fund:'+symbol,()=>runPython({action:'fund',symbol}));},
        getScreenerInputs(symbols) {
            const normalized = [...new Set((symbols || [])
                .map((symbol) => String(symbol).trim().toUpperCase())
                .filter(Boolean))].sort();
            const key = normalized.join(',');
            return screenerCache.get(key, async () => {
                const result = await runPython({ action: 'screener_batch', symbols: normalized });
                if (result?.status !== 'success' || !result.data) {
                    throw new Error(result?.error || 'Batch screener data request failed');
                }
                for(const row of Object.values(result.data))for(const key of ['stock','quality','technical'])if(row[key])row[key]={...row[key],meta:{source:result.meta?.source||'yfinance',retrievedAt:result.meta?.retrievedAt||new Date().toISOString(),...row[key].meta}};
                if(secSource.configured()) {
                    for(const symbol of normalized){
                        const cached=researchCache.peek('quality:'+symbol);
                        if(cached)result.data[symbol].quality=cached;
                        else{
                            warmQuality(symbol);
                            const row=result.data[symbol].quality;
                            if(row)result.data[symbol].quality={...row,meta:{...row.meta,primarySourceStatus:'loading'}};
                        }
                    }
                }
                return result.data;
            });
        },
        clearMarketDataCache(symbol) {
            stockInfoLoader.clear(symbol);
            marketCache.clear();
            sectorCache.clear();
            screenerCache.clear();
            researchCache.clear();
        },
    };
}

const defaultBridge = createPybridge();

module.exports = {
    researchEnvironment,
    callPython,
    createPythonCaller,
    createPybridge,
    ...defaultBridge,
};
