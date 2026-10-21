'use strict';
const crypto=require('node:crypto');
const {hash}=require('./research_data');
const schema=[
    `CREATE TABLE IF NOT EXISTS research_packets (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, symbol TEXT NOT NULL, created_at TEXT NOT NULL, packet_json TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS research_packets_symbol ON research_packets(symbol,created_at)`,
    `CREATE TABLE IF NOT EXISTS research_ai_audit (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, event TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS research_decision_evidence (decision_key TEXT PRIMARY KEY, packet_id TEXT NOT NULL REFERENCES research_packets(id), strategy_version TEXT NOT NULL, analysis_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS research_evaluations (id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, created_at TEXT NOT NULL, ends_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS research_shadow_decisions (id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL REFERENCES research_evaluations(id), packet_id TEXT NOT NULL REFERENCES research_packets(id), symbol TEXT NOT NULL, action TEXT NOT NULL, decision_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(evaluation_id,symbol))`,
    `CREATE TABLE IF NOT EXISTS research_evaluation_marks (id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL REFERENCES research_evaluations(id), symbol TEXT NOT NULL, price REAL NOT NULL, event_at TEXT NOT NULL, packet_id TEXT NOT NULL REFERENCES research_packets(id), UNIQUE(evaluation_id,symbol,event_at,packet_id))`,
    ...['research_evaluation_marks','research_packets','research_ai_audit','research_decision_evidence','research_evaluations','research_shadow_decisions'].flatMap(table=>['UPDATE','DELETE'].map(op=>`CREATE TRIGGER IF NOT EXISTS ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'research evidence is immutable'); END`)),
];
async function connection(fn){const db=require('../database/db').getDb();try{return await fn(db);}finally{await new Promise(r=>db.close(r));}}
const all=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,rows)=>e?reject(e):resolve(rows)));
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,function(e){e?reject(e):resolve({changes:this.changes});}));
async function savePacket(packet){
    const id=crypto.randomUUID(),contentHash=hash(packet),createdAt=new Date().toISOString();
    await connection(db=>run(db,'INSERT INTO research_packets VALUES(?,?,?,?,?)',[id,contentHash,packet.symbol,createdAt,JSON.stringify(packet)]));
    return {...packet,id,contentHash};
}
async function getPacket(id){return connection(async db=>{const row=(await all(db,'SELECT * FROM research_packets WHERE id=?',[id]))[0];if(!row)return null;const packet=JSON.parse(row.packet_json);if(hash(packet)!==row.content_hash)throw Error('Research evidence integrity check failed');return {...packet,id:row.id,contentHash:row.content_hash};});}
async function audit({runId,model,event,detail,promptVersion='research-v2'}){
    await connection(db=>run(db,'INSERT INTO research_ai_audit VALUES(?,?,?,?,?,?,?)',[crypto.randomUUID(),runId,model,promptVersion,event,JSON.stringify(detail),new Date().toISOString()]));
}
async function saveDecisionEvidence(key,analysis){
    return connection(async db=>{
        const old=(await all(db,'SELECT * FROM research_decision_evidence WHERE decision_key=?',[key]))[0];
        if(old){if(old.analysis_json!==JSON.stringify(analysis))throw Object.assign(Error('Decision evidence cannot change for an existing key'),{code:'LIVE_DECISION_CONFLICT',status:409});return;}
        await run(db,'INSERT OR IGNORE INTO research_decision_evidence VALUES(?,?,?,?,?)',[key,analysis.packetId,analysis.strategyVersion,JSON.stringify(analysis),new Date().toISOString()]);
        const retained=(await all(db,'SELECT analysis_json FROM research_decision_evidence WHERE decision_key=?',[key]))[0];
        if(retained.analysis_json!==JSON.stringify(analysis))throw Object.assign(Error('Decision evidence cannot change for an existing key'),{code:'LIVE_DECISION_CONFLICT',status:409});
    });
}
const listAudit=()=>connection(db=>all(db,'SELECT id,run_id,model,prompt_version,event,created_at FROM research_ai_audit ORDER BY created_at DESC LIMIT 100'));
module.exports={schema,connection,all,run,savePacket,getPacket,audit,saveDecisionEvidence,listAudit};
