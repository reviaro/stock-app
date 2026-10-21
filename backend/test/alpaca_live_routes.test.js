'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {fetch}=require('../services/http_runtime');
const {createAuth,hashPassword,createAuthFromEnv}=require('../services/auth');
const {authorizeApiRequest}=require('../services/api_capabilities');
const {createLiveRouter}=require('../routes/alpaca_live');

test('actual auth, capability and live-router boundaries require a session for policy/ownership/execution',async()=>{
    const token='synthetic-live-investing-token-32-characters';
    const reader='synthetic-reader-token-32-characters';
    const auth=createAuth({username:'synthetic-operator',passwordHash:hashPassword('synthetic-password'),sessionSecret:'synthetic-session-secret-at-least-32-characters',alpacaLiveInvestingToken:token,apiToken:reader,allowLoopback:true});
    let calls=0;
    const app=express();app.use(express.json());app.use('/api/auth',auth.router);
    app.use('/api',auth.requireAuth,authorizeApiRequest);
    const service={overview:async()=>({configured:false}),savePolicy:async()=>{calls++;return {};},adopt:async()=>{calls++;return {};},execute:async()=>{calls++;return {};},decision:async body=>{calls++;return {accountId:body.account_id};}};
    app.use('/api/alpaca-live',createLiveRouter({service}));
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const origin='http://127.0.0.1:'+server.address().port;
    async function request(path,{method='GET',body,credential,cookie,requestOrigin}={}) {
        const response=await fetch(origin+path,{method,headers:{...(credential?{Authorization:'Bearer '+credential}:{}),...(cookie?{Cookie:cookie}:{}),...(requestOrigin?{Origin:requestOrigin}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
    }
    try {
        for (const credential of [undefined,reader]) {
            assert.equal((await request('/api/alpaca-live/overview',{credential})).status,credential?403:401);
            assert.equal((await request('/api/alpaca-live/policy',{method:'PUT',body:{},credential})).status,credential?403:401);
        }
        assert.equal((await request('/api/alpaca-live/overview',{credential:token})).status,200);
        for (const [method,path] of [['PUT','/policy'],['POST','/ownership'],['POST','/execute'],['POST','/preview']]) assert.equal((await request('/api/alpaca-live'+path,{method,body:{account_id:1},credential:token})).status,403);
        assert.equal((await request('/api/alpaca-live/decisions',{method:'POST',body:{account_id:2},credential:token})).status,403);
        assert.equal((await request('/api/alpaca-live/decisions',{method:'POST',body:{account_id:1},credential:token})).status,200);
        assert.equal(calls,1);
        const login=await request('/api/auth/login',{method:'POST',requestOrigin:origin,body:{username:'synthetic-operator',password:'synthetic-password'}});
        assert.equal(login.status,200);
        assert.equal((await request('/api/alpaca-live/policy',{method:'PUT',cookie:login.cookie,requestOrigin:'https://different.example',body:{}})).status,403);
        assert.equal((await request('/api/alpaca-live/policy',{method:'PUT',cookie:login.cookie,requestOrigin:origin,body:{}})).status,200);
        assert.equal(calls,2);
    } finally {await new Promise(r=>server.close(r));}
});
test('the dedicated live token is loaded from its own environment variable and must be unique',()=>{
    const env={STOCK_DASHBOARD_USERNAME:'synthetic-user',STOCK_DASHBOARD_PASSWORD_HASH:'synthetic-hash',STOCK_DASHBOARD_SESSION_SECRET:'s'.repeat(32),STOCK_DASHBOARD_SECURE_COOKIE:'0',STOCK_DASHBOARD_LIVE_INVESTING_TOKEN:'short'};
    assert.throws(()=>createAuthFromEnv(env),/Live investing credential/);
    assert.throws(()=>createAuthFromEnv({...env,STOCK_DASHBOARD_LIVE_INVESTING_TOKEN:'x'.repeat(32),ALPACA_DAY_TRADING_ENTRY_TOKEN:'x'.repeat(32)}),/unique/);
});
