'use strict';
const { createAsyncRouter } = require('../services/http_errors');
const { createLiveInvesting } = require('../services/alpaca_live_investing');

function createLiveRouter({ service=createLiveInvesting() }={}) {
    const router=createAsyncRouter();
    const respond=handler=>async(req,res)=>{
        try { return res.json({status:'success',data:await handler(req)}); }
        catch(e) {
            const known=typeof e.code==='string' && e.code.startsWith('LIVE_');
            return res.status(known?e.status||409:503).json({status:'error',code:known?e.code:'LIVE_UNAVAILABLE',error:known?e.message:'Live investing is temporarily unavailable.'});
        }
    };
    // Reject loopback, generic tokens, simulator/day-trading agents and session-shaped
    // objects lacking a real authenticated operator principal. Agents never set policy.
    router.use((req,res,next)=>{
        if (req.auth?.type==='session' && req.auth.role==='operator') return next();
        if (req.auth?.role==='alpaca-long-term-agent' && ((req.method==='GET' && req.path==='/overview') || (req.method==='POST' && req.path==='/decisions'))) return next();
        return res.status(403).json({status:'error',code:'CAPABILITY_DENIED',error:'Live investing requires operator login or the scoped live-investing credential.'});
    });
    router.get('/overview',respond(()=>service.overview()));
    router.get('/simulator-draft',respond(()=>service.simulatorDraft()));
    router.put('/policy',respond(req=>service.savePolicy(req.body?.policy,req.body?.expectedVersion,req.body?.confirmation)));
    router.post('/preview',respond(req=>req.body?.decisionKey?service.previewDecision(req.body.decisionKey):service.preview()));
    router.post('/execute',respond(req=>service.execute(req.body?.planId,{confirmation:req.body?.confirmation})));
    router.post('/decisions',respond(req=>service.decision(req.body)));
    router.post('/orders/:id/cancel',respond(req=>service.cancel(req.params.id)));
    router.post('/ownership',respond(req=>service.adopt(req.body)));
    return router;
}
module.exports={createLiveRouter};
