#!/usr/bin/env node
// Actual child processes exercise selected-provider credential isolation.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {Supervisor}=require('../dist/main/supervisor');
const {sttEnvironment,ttsEnvironment}=require('../dist/main/speech-env');
const {buildManifest}=require('../dist/main/model-manager');
const {validateConfigSet}=require('../dist/main/config');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'aria-speech-env-'));
const inherited={ARIA_STT_GROQ_KEY:'fixture-inherited',ARIA_STT_CLOUD_KEY:'fixture-inherited',ARIA_TTS_CLOUD_KEY:'fixture-inherited'};
const saved=Object.fromEntries([...Object.keys(inherited),'ARIA_SIDECAR_DIR'].map(k=>[k,process.env[k]]));
(async()=>{
 let sup, count=0; const check=(b,label)=>{assert(b,label);count++;console.log('PASS '+label)};
 try{
  const results=[];
  for(const name of ['stt','tts','wakeword']){
   fs.mkdirSync(path.join(root,name));
   fs.writeFileSync(path.join(root,name,name),`#!/usr/bin/env node\nconst net=require('net');const endpoint=process.argv[process.argv.indexOf('--socket')+1];const s=endpoint.startsWith('tcp://')?net.connect({host:'127.0.0.1',port:Number(endpoint.split(':').pop())}):net.connect(endpoint);s.on('connect',()=>process.stdout.write(JSON.stringify({type:'env_snapshot',groq:process.env.ARIA_STT_GROQ_KEY,stt:process.env.ARIA_STT_CLOUD_KEY,tts:process.env.ARIA_TTS_CLOUD_KEY,provider:process.env.ARIA_STT_PROVIDER,voice:process.env.ARIA_TTS_CLOUD_VOICE})+'\\n'));s.on('error',()=>{});setInterval(()=>{},1000);`);
   fs.chmodSync(path.join(root,name,name),0o755);
  }
  Object.assign(process.env,inherited,{ARIA_SIDECAR_DIR:root});
  let provider='deepgram',engine='cartesia';
  const get=k=>({'stt.provider':provider,'tts.engine':engine,[`tts.cloudModels.${engine}`]:'fixture-model',[`tts.cloudVoices.${engine}`]:'fixture-voice'})[k];
  const secret=k=>'fixture-'+k;
  sup=new Supervisor(()=>{},(name,msg)=>results.push({name,...msg}),{sttEnv:()=>sttEnvironment(get,secret),ttsEnv:()=>ttsEnvironment(get,secret)});
  const wait=async n=>{for(let i=0;i<100&&results.length<n;i++)await new Promise(r=>setTimeout(r,30));assert(results.length>=n,'children ready')};
  for(const name of ['stt','tts','wakeword'])await sup.start(name);await wait(3);
  const stt=results.find(r=>r.name==='stt'),tts=results.find(r=>r.name==='tts'),ww=results.find(r=>r.name==='wakeword');
  check(stt.stt==='fixture-stt-deepgram-api-key'&&!stt.tts&&!stt.groq,'Deepgram STT key confined to STT');
  check(tts.tts==='fixture-tts-cartesia-api-key'&&tts.voice==='fixture-voice'&&!tts.stt&&!tts.groq,'Cartesia TTS key confined to TTS');
  check(!ww.tts&&!ww.stt&&!ww.groq,'wakeword receives no speech credentials');
  for(const p of ['assemblyai','groq','local']){
   provider=p;const n=results.length;await sup.stop('stt');await sup.start('stt');await wait(n+1);const r=results[n];
   check(p==='local'?(!r.stt&&!r.groq):p==='groq'?(r.groq==='fixture-stt-api-key'&&!r.stt):(r.stt==='fixture-stt-assemblyai-api-key'&&!r.groq),p+' restart selects only its own credential');
  }
  for(const eng of ['elevenlabs','openai','deepgram','kokoro']){
   engine=eng;const n=results.length;await sup.stop('tts');await sup.start('tts');await wait(n+1);const r=results[n];
   check(eng==='kokoro'?!r.tts:r.tts===`fixture-tts-${eng}-api-key`,eng+' restart selects only its own credential');
  }
  for(const eng of ['elevenlabs','cartesia','openai','deepgram'])check(buildManifest('base.en','bm_george',eng).every(m=>m.kind==='stt')&&validateConfigSet('tts.engine',eng).ok,eng+' requires no local TTS weights and accepts config');
  check(Object.keys(inherited).every(k=>process.env[k]===inherited[k]),'parent environment untouched');
  console.log('PASS '+count+' checks');
 }finally{
  if(sup)await sup.stopAll();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  fs.rmSync(root,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1});
