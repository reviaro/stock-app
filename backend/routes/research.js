'use strict';
const {createAsyncRouter}=require('../services/http_errors');
function createResearchRouter({service=require('../services/research_service'),store=require('../services/research_store'),funds=require('../services/fund_research'),evaluation=require('../services/research_evaluation')}={}){
    const router=createAsyncRouter();
    const operator=(req,res,next)=>req.auth?.type==='session'&&req.auth?.role==='operator'?next():res.status(403).json({status:'error',code:'CAPABILITY_DENIED',error:'Operator login required'});
    const review=(req,res,next)=>req.auth?.role==='alpaca-long-term-agent'||req.auth?.role==='operator'?next():res.status(403).json({status:'error',code:'CAPABILITY_DENIED',error:'Long-term research capability required'});
    const respond=fn=>async(req,res)=>{
        try{return res.json({status:'success',data:await fn(req)});}catch(error){
            const invalid=error.status===400||error.code==='RESEARCH_INVALID_INPUT';
            return res.status(invalid?400:503).json({status:'error',error:invalid?error.message:'Research is temporarily unavailable'});
        }
    };
    router.get('/sources',respond(async()=>{
        let models=[];try{models=require('../services/ai_models').getAIModels().map(m=>m.label);}catch{/* Configuration details remain server-side. */}
        const rows=await store.connection(db=>store.all(db,'SELECT COUNT(*) as count,MIN(updated_at) as oldest,MAX(updated_at) as newest,MIN(price_date) as priceAsOf,MAX(universe_version) as version FROM universe_cache'));
        return {secConfigured:require('../services/sec_fundamentals').createSecSource().configured(),alpacaNewsConfigured:require('../services/research_news').createNewsSource().configured(),
            models,modelFallback:'Only explicitly configured local fallback; no cross-cloud substitution',universe:{name:'custom-large-cap',...rows[0]},executionFeed:'alpaca_iex',
            limitations:['IEX is a single-exchange feed; it is not consolidated SIP.','Research data cannot authorize or price a live order.']};
    }));
    router.get('/decisions/:key',review,respond(async req=>{
        const rows=await store.connection(db=>store.all(db,'SELECT r.*,d.symbol,d.side,d.reason FROM research_decision_evidence r JOIN alpaca_live_decisions d ON d.decision_key=r.decision_key WHERE r.decision_key=?',[req.params.key]));
        if(!rows.length)return null;
        const orders=await store.connection(db=>store.all(db,'SELECT id,symbol,side,qty,limit_price,status,filled_qty,filled_avg_price,created_at,updated_at FROM alpaca_live_orders WHERE decision_key=?',[req.params.key]));
        return {decision:{...rows[0],analysis:JSON.parse(rows[0].analysis_json)},orders};
    }));
    router.get('/audit/:id',operator,respond(req=>store.connection(db=>store.all(db,'SELECT * FROM research_ai_audit WHERE id=?',[req.params.id]))));
    router.get('/audit',operator,respond(()=>store.listAudit()));
    router.get('/evaluations',review,respond(()=>evaluation.list()));
    router.post('/evaluations',operator,respond(req=>evaluation.create(req.body)));
    router.get('/evaluations/:id',review,respond(req=>evaluation.report(req.params.id)));
    router.post('/evaluations/:id/observe',operator,respond(req=>evaluation.observe(req.params.id)));
    router.post('/evaluations/:id/decisions',review,respond(req=>evaluation.record(req.params.id,req.body)));
    router.post('/fund-disclosures',operator,respond(async req=>{
        try{const result=await funds.save(req.body);service.invalidate(result.symbol);return result;}catch(error){if(!error.code)error.status=400;throw error;}
    }));
    router.post('/valuation',operator,respond(req=>{try{return require('../services/valuation_model').calculateValuation(req.body);}catch(error){error.status=400;throw error;}}));
    router.get('/packets/:id',respond(req=>store.getPacket(req.params.id)));
    router.get('/:symbol',respond(req=>{const symbol=req.params.symbol.toUpperCase();if(req.query.refresh==='1')service.invalidate(symbol);return service.packet(symbol);}));
    return router;
}
module.exports={createResearchRouter};
