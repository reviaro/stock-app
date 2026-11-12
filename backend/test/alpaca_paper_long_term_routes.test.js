'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createPaperLongTermRouter}=require('../routes/alpaca_paper_long_term');

test('paper investing routes enforce operator and narrowly scoped paper-agent access',async()=>{
    const calls=[];const service=Object.fromEntries(['overview','portfolio','simulatorDraft','savePolicy','pause','preview','execute','decision','cancel','adopt'].map(name=>[name,async(...args)=>{calls.push({name,args});return {ok:true};}]));
    const reconciliation={checked:2,updated:1,unchanged:1,failures:0,plans:{checked:1,reconciled:1,closed:1,cancelled:0,blocked:0,skipped:0,blockers:[]}};
    service.legacyReconcile=async()=>{calls.push({name:'legacyReconcile',args:[]});return reconciliation;};
    const app=express();app.use(express.json());
    app.use((req,res,next)=>{req.auth=JSON.parse(req.get('X-Synthetic-Principal')||'null');next();});
    app.use('/paper',createPaperLongTermRouter({service}));const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const send=(principal,path,method='GET',body)=>fetch(`http://127.0.0.1:${server.address().port}/paper${path}`,{method,headers:{'X-Synthetic-Principal':JSON.stringify(principal),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    try {
        const operator={type:'session',role:'operator'};const agent={type:'token',role:'alpaca-paper-investing-agent'};
        for(const principal of [null,{type:'loopback',role:'reader'},{type:'token',role:'alpaca-long-term-agent'},{type:'session',role:'reader'},{type:'token',role:'simulator-agent'}])assert.equal((await send(principal,'/overview')).status,403);
        assert.equal((await send(agent,'/overview')).status,200);
        assert.equal((await send(agent,'/portfolio')).status,403);
        assert.equal((await send(operator,'/portfolio?period=3M')).status,200);
        assert.deepEqual(calls.at(-1),{name:'portfolio',args:[{period:'3M'}]});
        for(const principal of [null,{type:'loopback',role:'reader'},{type:'token',role:'alpaca-long-term-agent'},{type:'session',role:'reader'},{type:'token',role:'simulator-agent'}]) assert.equal((await send(principal,'/portfolio')).status,403);
        assert.equal((await send(agent,'/decisions','POST',{account_id:1})).status,200);
        for(const [path,method] of [['/policy','PUT'],['/preview','POST'],['/execute','POST'],['/ownership','POST'],['/legacy-handover','POST'],['/legacy-reconcile','POST'],['/simulator-draft','GET']])assert.equal((await send(agent,path,method,method==='GET'?undefined:{})).status,403);
        assert.equal((await send(operator,'/policy','PUT',{policy:{paused:true},expectedVersion:3,confirmation:''})).status,200);
        assert.deepEqual(calls.at(-1),{name:'savePolicy',args:[{paused:true},3,'']});
        assert.equal((await send(operator,'/execute','POST',{planId:'synthetic-plan',confirmation:'BUY AAPL PAPER',automatic:true})).status,200);
        assert.deepEqual(calls.at(-1),{name:'execute',args:['synthetic-plan',{confirmation:'BUY AAPL PAPER'}]});
        const recovered=await send(operator,'/legacy-reconcile','POST',{});
        assert.equal(recovered.status,200);assert.deepEqual(await recovered.json(),{status:'success',data:reconciliation});
        assert.deepEqual(calls.at(-1),{name:'legacyReconcile',args:[]});
        for(const principal of [{type:'token',role:'alpaca-long-term-agent'},{type:'token',role:'simulator-agent'},{type:'loopback',role:'reader'}])assert.equal((await send(principal,'/legacy-reconcile','POST',{})).status,403);
    } finally {await new Promise(resolve=>server.close(resolve));}
});
