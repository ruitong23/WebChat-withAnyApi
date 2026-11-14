// Public model metadata only. API keys and conversation data never go to this URL.
export const vertexCatalogURL='https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions?hl=en';
const plain=value=>value.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
export function parseVertexCatalog(html,now=Date.now()){
 const result=[];
 for(const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  const cells=[...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>plain(m[1]));
  if(cells.length<3)continue;
  const id=cells[0].match(/^gemini-[a-zA-Z0-9._-]+$/)?.[0];
  if(!id||/(?:image|live|audio|tts|embedding|omni|robotics|banana)/i.test(id))continue;
  const retirement=cells[2].match(/[A-Z][a-z]+ \d{1,2}, \d{4}/)?.[0];
  if(retirement){const date=Date.parse(retirement+' 23:59:59 UTC');if(Number.isFinite(date)&&date<now)continue;}
  if(!result.some(model=>model.id===id))result.push({id,releasedAt:Date.parse(cells[1])||0});
 }
 if(!result.length||result.length>60)throw new Error('Invalid official model catalog');
 return result.sort((a,b)=>b.releasedAt-a.releasedAt).map(model=>model.id);
}
export function createVertexCatalog({fetcher=globalThis.fetch,now=Date.now}={}){
 let cached=null,inFlight=null;
 return {async get({refresh=false}={}){
  if(!refresh&&cached&&now()-cached.updatedAt<6*60*60*1000)return {...cached,source:'official_cache'};
  if(!inFlight)inFlight=(async()=>{
   try{
    const response=await fetcher(vertexCatalogURL,{headers:{Accept:'text/html','Accept-Language':'en'},signal:AbortSignal.timeout(4000),redirect:'follow'});
    if(!response.ok)throw new Error('Official catalog unavailable');
    const html=await response.text();if(html.length>4*1024*1024)throw new Error('Official catalog too large');
    cached={models:parseVertexCatalog(html,now()),updatedAt:now()};return {...cached,source:'official'};
   }catch{return cached?{...cached,source:'stale_cache'}:{models:[],source:'bundled',updatedAt:null};}
  })().finally(()=>{inFlight=null;});
  return inFlight;
 }};
}
