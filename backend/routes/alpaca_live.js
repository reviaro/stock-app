'use strict';
const { createAsyncRouter } = require('../services/http_errors');
const { createLiveInvesting } = require('../services/alpaca_live_investing');
const { requireRecentMfa } = require('../services/auth');
const { emitSecurityEvent } = require('../services/security_events');

function createLiveRouter({ service=createLiveInvesting() }={}) {
    const router=createAsyncRouter();
    const respond=(handler,event)=>async(req,res)=>{
        try {
            const data=await handler(req);
            if(event)emitSecurityEvent(event,{outcome:'success'});
            return res.json({status:'success',data});
        }
        catch(e) {
            const known=typeof e.code==='string' && e.code.startsWith('LIVE_');
            if(event)emitSecurityEvent(event,{outcome:'refused',code:known?e.code:'LIVE_UNAVAILABLE'});
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
    router.put('/policy',requireRecentMfa,respond(req=>service.savePolicy(req.body?.policy,req.body?.expectedVersion,req.body?.confirmation),'live_policy'));
    router.post('/pause',respond(req=>service.pause(req.body?.expectedVersion),'live_pause'));
    router.post('/preview',respond(req=>req.body?.decisionKey?service.previewDecision(req.body.decisionKey):service.preview()));
    router.post('/execute',requireRecentMfa,respond(req=>service.execute(req.body?.planId,{confirmation:req.body?.confirmation}),'live_execute'));
    router.post('/decisions',respond(req=>service.decision(req.body)));
    router.post('/orders/:id/cancel',respond(req=>service.cancel(req.params.id),'live_cancel'));
    router.post('/ownership',requireRecentMfa,respond(req=>service.adopt(req.body),'live_ownership'));
    return router;
}
module.exports={createLiveRouter};
