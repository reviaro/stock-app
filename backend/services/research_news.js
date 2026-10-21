'use strict';
const http=require('./http_runtime');
function createNewsSource({env=process.env,fetchImpl=http.fetch}={}){
    const configured=()=>Boolean(env.ALPACA_RESEARCH_API_KEY&&env.ALPACA_RESEARCH_SECRET_KEY);
    async function get(symbol){
        if(!configured())return null;
        if(!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol))return null;
        const response=await fetchImpl('https://data.alpaca.markets/v1beta1/news?symbols='+encodeURIComponent(symbol)+'&limit=10&sort=desc&include_content=false',{
            method:'GET',redirect:'error',signal:AbortSignal.timeout(6000),headers:{'APCA-API-KEY-ID':env.ALPACA_RESEARCH_API_KEY,'APCA-API-SECRET-KEY':env.ALPACA_RESEARCH_SECRET_KEY}});
        if(!response.ok)throw Error('Alpaca news unavailable');
        const body=await response.json();if(!Array.isArray(body.news))throw Error('Invalid news response');
        return {status:'success',data:body.news.filter(n=>n.symbols?.includes(symbol)).map(n=>({title:n.headline,publisher:n.source,link:n.url,providerPublishTime:n.created_at})),meta:{source:'alpaca_benzinga',retrievedAt:new Date().toISOString()}};
    }
    return {get,configured};
}
module.exports={createNewsSource};
