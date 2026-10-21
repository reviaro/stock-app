'use strict';
const http=require('./http_runtime');
const {createAsyncTtlCache}=require('./market_data_cache');
const {numberOrNull}=require('./research_data');
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const TAGS={
    'Total Revenue':['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet'],
    'Operating Income':['OperatingIncomeLoss'], 'Net Income':['NetIncomeLoss','ProfitLoss'],
    'Tax Provision':['IncomeTaxExpenseBenefit'],'Pretax Income':['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest','IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
    'Gross Profit':['GrossProfit'],'Interest Expense':['InterestExpenseNonOperating','InterestAndDebtExpense'],
    'Diluted EPS':['EarningsPerShareDiluted'],'Stockholders Equity':['StockholdersEquity'],
    'Operating Cash Flow':['NetCashProvidedByUsedInOperatingActivities'],
    'Capital Expenditure':['PaymentsToAcquirePropertyPlantAndEquipment'],
    'Current Debt':['LongTermDebtCurrent'],'Noncurrent Debt':['LongTermDebtNoncurrent'],
};
const INSTANT=new Set(['Stockholders Equity','Current Debt','Noncurrent Debt']);
function normalizeFacts(payload,{asOf=new Date().toISOString().slice(0,10)}={}){
    if(!DATE.test(asOf))throw Error('Invalid filing cutoff');
    const annual={},quarterly={},evidence=[];
    for(const [name,tags]of Object.entries(TAGS)){
        const unit=name==='Diluted EPS'?'USD/shares':'USD';
        const candidates=[];
        for(const tag of tags){
            for(const fact of payload.facts?.['us-gaap']?.[tag]?.units?.[unit]||[]){
                if(!['10-K','10-K/A','10-Q','10-Q/A'].includes(fact.form)||!DATE.test(fact.end||'')||!DATE.test(fact.filed||'')||fact.filed>asOf||fact.end>asOf||numberOrNull(fact.val)==null)continue;
                const days=fact.start?(Date.parse(fact.end)-Date.parse(fact.start))/86400000:null;
                const period=INSTANT.has(name)?'instant':days>=330&&days<=400?'annual':days>=70&&days<=110?'quarterly':null;
                if(period)candidates.push({...fact,tag,period});
            }
        }
        // Latest filing at the requested historical cutoff; do not backfill from future revisions.
        candidates.sort((a,b)=>a.filed.localeCompare(b.filed));
        for(const f of candidates){
            const destinations=f.period==='instant'?[annual,quarterly]:[f.period==='annual'?annual:quarterly];
            for(const target of destinations){
                target[name]??={};target[name][f.end]=f.val;
            }
            evidence.push({metric:name,tag:f.tag,unit,start:f.start||null,end:f.end,filed:f.filed,form:f.form,accession:f.accn,
                url:f.accn&&/^\d{10}-\d{2}-\d{6}$/.test(f.accn)?`https://www.sec.gov/Archives/edgar/data/${Number(payload.cik)}/${f.accn.replaceAll('-','')}/`:null});
        }
    }
    for(const target of [annual,quarterly]){
        for(const [name,left,right,sign]of [['Total Debt','Current Debt','Noncurrent Debt',1],['Free Cash Flow','Operating Cash Flow','Capital Expenditure',-1]]){
            target[name]={};
            for(const date of Object.keys(target[left]||{}))if(target[right]?.[date]!=null)target[name][date]=target[left][date]+sign*target[right][date];
        }
    }
    return {annual,quarterly,evidence,asOf,cik:String(payload.cik).padStart(10,'0'),source:'sec_edgar',limitations:['Standard US-GAAP USD mappings only; custom taxonomy, foreign currency and missing debt components remain unavailable.','Quarterly facts require a standalone quarter; cumulative year-to-date values are not treated as quarters.']};
}
function createSecSource({env=process.env,fetchImpl=http.fetch,now=()=>new Date()}={}){
    const cache=createAsyncTtlCache({ttlMs:6*3600_000});let gate=Promise.resolve();
    const configured=()=>typeof env.SEC_USER_AGENT==='string'&&/^[^\r\n]{5,200}\s+[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.SEC_USER_AGENT);
    async function json(url){
        if(!configured())throw Error('SEC source requires a server-side contact user agent');
        // Serialize below SEC's fair-access request limit. Never follow arbitrary URLs or redirects.
        const request=gate.catch(()=>{}).then(async()=>{
            const response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{'User-Agent':env.SEC_USER_AGENT,'Accept':'application/json'},signal:AbortSignal.timeout(12000)});
            if(!response.ok)throw Error('SEC source unavailable');
            const body=await response.text();if(Buffer.byteLength(body)>25*1024*1024)throw Error('SEC response too large');return JSON.parse(body);
        });
        gate=request.then(()=>new Promise(r=>setTimeout(r,250)),()=>new Promise(r=>setTimeout(r,250)));
        return request;
    }
    async function company(symbol){
        if(!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol))throw Error('Invalid SEC symbol');
        const catalog=await cache.get('tickers',()=>json('https://www.sec.gov/files/company_tickers.json'));
        const entry=Object.values(catalog).find(x=>x.ticker===symbol);
        if(!entry)throw Error('SEC company mapping unavailable');
        return String(entry.cik_str).padStart(10,'0');
    }
    async function get(symbol){
        if(!configured())return {status:'unavailable',configurationRequired:true,source:'sec_edgar'};
        return cache.get(symbol,async()=>{
            const cik=await company(symbol);
            const [facts,submissions]=await Promise.all([json(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`),json(`https://data.sec.gov/submissions/CIK${cik}.json`)]);
            const normalized=normalizeFacts(facts,{asOf:now().toISOString().slice(0,10)});
            const recent=submissions.filings?.recent||{};
            const filings=(recent.accessionNumber||[]).slice(0,30).map((accn,i)=>({form:recent.form?.[i],filedAt:recent.filingDate?.[i],reportDate:recent.reportDate?.[i],accession:accn,
                url:/^\d{10}-\d{2}-\d{6}$/.test(accn)&&/^[A-Za-z0-9_.-]+$/.test(recent.primaryDocument?.[i]||'')?`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replaceAll('-','')}/${recent.primaryDocument[i]}`:null}));
            return {status:'success',data:{...normalized,filings},meta:{source:'sec_edgar',retrievedAt:now().toISOString()}};
        });
    }
    return {get,configured};
}
module.exports={normalizeFacts,createSecSource};
