#!/usr/bin/env node
// Spawn the actual Supervisor with fake sidecars: prove key isolation and
// fresh environment reads on restart without any account credential/network.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {Supervisor}=require('../dist/main/supervisor');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'aria-stt-env-'));
const old=process.env.ARIA_SIDECAR_DIR;
(async()=>{
 let sup;
 try{
  const results=[];
  for(const name of ['stt','tts','wakeword']){
   fs.mkdirSync(path.join(root,name));
   fs.writeFileSync(path.join(root,name,name),`#!/usr/bin/env node\nconst net=require('net');const endpoint=process.argv[process.argv.indexOf('--socket')+1];const s=endpoint.startsWith('tcp://')?net.connect({host:'127.0.0.1',port:Number(endpoint.split(':').pop())}):net.connect(endpoint);s.on('connect',()=>process.stdout.write(JSON.stringify({type:'env_snapshot',hasKey:process.env.ARIA_STT_GROQ_KEY==='fixture-child-only',hasAnyKey:!!process.env.ARIA_STT_GROQ_KEY,provider:process.env.ARIA_STT_PROVIDER,legacyKey:!!process.env.ARIA_STT_CLOUD_KEY})+'\\n'));s.on('error',()=>{});setInterval(()=>{},1000);`);
   fs.chmodSync(path.join(root,name,name),0o755);
  }
  process.env.ARIA_SIDECAR_DIR=root;
  process.env.ARIA_STT_GROQ_KEY='fixture-inherited-do-not-pass';
  process.env.ARIA_STT_CLOUD_KEY='fixture-legacy-do-not-pass';
  let provider='groq';
  sup=new Supervisor(()=>{},(name,msg)=>results.push({name,...msg}),{sttEnv:()=>({ARIA_STT_PROVIDER:provider,...(provider==='groq'?{ARIA_STT_GROQ_KEY:'fixture-child-only'}:{})})});
  for(const name of ['stt','tts','wakeword'])await sup.start(name);
  const wait=async n=>{for(let i=0;i<100&&results.length<n;i++)await new Promise(r=>setTimeout(r,30));assert(results.length>=n,'children must be ready')};
  await wait(3);
  assert(results.find(r=>r.name==='stt').hasKey,'STT received injected key');
  assert(results.filter(r=>r.name!=='stt').every(r=>!r.hasAnyKey&&!r.legacyKey),'other children received no cloud credentials');
  assert(results.every(r=>!r.legacyKey),'legacy credential stripped');
  provider='local';await sup.stop('stt');await sup.start('stt');await wait(4);
  assert(results[3].provider==='local'&&!results[3].hasAnyKey,'restart re-reads config and drops cloud key');
  assert.equal(process.env.ARIA_STT_GROQ_KEY,'fixture-inherited-do-not-pass','injection never mutates parent');
  console.log('PASS 5 real-child credential isolation/restart checks');
 }finally{
  if(sup)await sup.stopAll();
  if(old===undefined)delete process.env.ARIA_SIDECAR_DIR;else process.env.ARIA_SIDECAR_DIR=old;
  delete process.env.ARIA_STT_GROQ_KEY;delete process.env.ARIA_STT_CLOUD_KEY;
  fs.rmSync(root,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1});
