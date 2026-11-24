'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {agentPicksUsedPct,applyTargetChange,planAgentTargetChange,planOperatorTargetChange}=require('../services/long_term_target_changes');

const fail=(code,message,status)=>Object.assign(new Error(message),{code,status});
const base={budget:10000,reservePct:5,maxPositionPct:25,executionMode:'automatic',paused:false,agentPicksMaxPct:20,
    targets:[{symbol:'AAPL',weightPct:30},{symbol:'QQQ',weightPct:10,source:'agent'}]};

test('agent change creates, raises, lowers and exits only agent targets within limits',()=>{
    assert.deepEqual(planAgentTargetChange(base,{symbol:'VTI',side:'buy',weightPct:8},fail),{symbol:'VTI',weightPct:8,source:'agent',actor:'agent',previous:null});
    assert.equal(planAgentTargetChange(base,{symbol:'QQQ',side:'buy',weightPct:10},fail),null);
    assert.deepEqual(planAgentTargetChange(base,{symbol:'QQQ',side:'buy',weightPct:12},fail),{symbol:'QQQ',weightPct:12,source:'agent',actor:'agent',previous:{weightPct:10,source:'agent'}});
    assert.equal(planAgentTargetChange(base,{symbol:'QQQ',side:'sell',weightPct:0},fail).weightPct,0);
    for (const [input,code] of [
        [{symbol:'AAPL',side:'buy',weightPct:31},'AGENT_TARGET_OPERATOR'],
        [{symbol:'VTI',side:'buy',weightPct:11},'AGENT_TARGET_LIMIT'],
        [{symbol:'VTI',side:'buy',weightPct:26},'AGENT_TARGET_LIMIT'],
        [{symbol:'VTI',side:'sell',weightPct:0},'AGENT_TARGET_SIDE'],
        [{symbol:'QQQ',side:'sell',weightPct:12},'AGENT_TARGET_SIDE'],
        [{symbol:'QQQ',side:'buy',weightPct:5},'AGENT_TARGET_SIDE'],
    ]) assert.throws(()=>planAgentTargetChange(base,input,fail),{code});
    assert.throws(()=>planAgentTargetChange({...base,targets:[{symbol:'AAPL',weightPct:80}]},{symbol:'VTI',side:'buy',weightPct:16},fail),{code:'AGENT_TARGET_LIMIT'});
    assert.throws(()=>planAgentTargetChange({...base,executionMode:'confirm'},{symbol:'VTI',side:'buy',weightPct:5},fail),{code:'AGENT_TARGET_MODE'});
    assert.throws(()=>planAgentTargetChange({...base,paused:true},{symbol:'VTI',side:'buy',weightPct:5},fail),{code:'AGENT_TARGET_MODE'});
    assert.throws(()=>planAgentTargetChange({...base,agentPicksMaxPct:undefined},{symbol:'VTI',side:'buy',weightPct:5},fail),{code:'AGENT_TARGET_LIMIT'});
});

test('an agent pick can always be lowered, even when the operator cut the cap below current usage',()=>{
    const over={...base,agentPicksMaxPct:5,targets:[...base.targets,{symbol:'VTI',weightPct:15,source:'agent'}]};
    assert.equal(planAgentTargetChange(over,{symbol:'VTI',side:'sell',weightPct:12},fail).weightPct,12);
    assert.throws(()=>planAgentTargetChange(over,{symbol:'VTI',side:'buy',weightPct:16},fail),{code:'AGENT_TARGET_LIMIT'});
});

test('operator change follows max-on-buy, min-on-sell and removes on full sell',()=>{
    assert.equal(planOperatorTargetChange(base,{symbol:'VTI',side:'buy',resultingWeightPct:3.456,sellsAll:false}).weightPct,3.46);
    assert.equal(planOperatorTargetChange(base,{symbol:'AAPL',side:'buy',resultingWeightPct:12,sellsAll:false}),null);
    assert.deepEqual(planOperatorTargetChange(base,{symbol:'AAPL',side:'sell',resultingWeightPct:12,sellsAll:false}),{symbol:'AAPL',weightPct:12,actor:'operator',previous:{weightPct:30}});
    assert.deepEqual(planOperatorTargetChange(base,{symbol:'QQQ',side:'sell',resultingWeightPct:0,sellsAll:true}),{symbol:'QQQ',weightPct:0,source:'agent',actor:'operator',previous:{weightPct:10,source:'agent'}});
    assert.equal(planOperatorTargetChange(base,{symbol:'VTI',side:'sell',resultingWeightPct:0,sellsAll:true}),null);
    assert.equal(planOperatorTargetChange(base,{symbol:'VTI',side:'sell',resultingWeightPct:4.2,sellsAll:false}).weightPct,4.2);
    assert.equal(planOperatorTargetChange(base,{symbol:'VTI',side:'buy',resultingWeightPct:0.001,sellsAll:false}).weightPct,0.01);
});

test('apply and usage are pure',()=>{
    const next=applyTargetChange(base,{symbol:'QQQ',weightPct:0,actor:'agent',previous:{weightPct:10,source:'agent'}});
    assert.deepEqual(next.targets,[{symbol:'AAPL',weightPct:30}]);
    assert.equal(base.targets.length,2);
    assert.deepEqual(applyTargetChange(base,{symbol:'VTI',weightPct:4,source:'agent',actor:'agent',previous:null}).targets.map(t=>t.symbol),['AAPL','QQQ','VTI']);
    assert.deepEqual(applyTargetChange(base,{symbol:'AAPL',weightPct:12,actor:'operator',previous:{weightPct:30}}).targets[0],{symbol:'AAPL',weightPct:12});
    assert.equal(agentPicksUsedPct(base),10);
    assert.equal(agentPicksUsedPct({targets:[{symbol:'A',weightPct:0.1,source:'agent'},{symbol:'B',weightPct:0.2,source:'agent'}]}),0.3);
});
