import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),provider=require('./provider/index.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'replay-lifecycle-'));
 const start=Date.parse('2026-06-28T03:06:00Z');
 const events=[0,1000,2000].map(offset=>({sourceTimeMs:start+offset,delta:{context:'vessels.self',updates:[{timestamp:new Date(start+offset).toISOString(),source:{label:'recorded',src:'22'},values:[{path:'navigation.position',value:{latitude:-27.4,longitude:153.2}}]}]}}));
 const file=path.join(directory,'clip.ndjson');fs.writeFileSync(file,events.map(e=>JSON.stringify(e)).join('\n'));
 let id=null,counter=0,fail=false,hold=false,release;
 const finished=[],emitted=[],writes=[];
 const server=createServer(async(req,res)=>{
  let body='';for await(const b of req)body+=b;
  res.setHeader('content-type','application/json');
  if(req.url.endsWith('/finish')){
   const input=JSON.parse(body);writes.push({input,authorization:req.headers.authorization});
   if(hold)await new Promise(resolve=>{release=resolve;});
   if(fail||input.expectedRecordingId!==id){res.statusCode=409;return res.end(JSON.stringify({error:'recording_changed'}));}
   finished.push(id);id=null;
  }
  res.end(JSON.stringify({trackingSessionId:id,uploadMode:'automatic',paired:true,available:true}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const options={file,webUrl:'https://preview.example.invalid',apiOrigin:`http://127.0.0.1:${server.address().port}`};
 const routes={};let plugin;
 const app={getDataDirPath:()=>directory,handleMessage:(_label,delta)=>{id ||= `recording-${++counter}`;emitted.push({id,delta});},error:message=>{throw Error(message);},setPluginStatus:()=>{}};
 const router={access(){return this;},get(route,handler){routes['GET '+route]=handler;},post(route,handler){routes['POST '+route]=handler;}};
 const open=()=>{plugin=provider(app);plugin.start(options);plugin.registerWithRouter(router);};open();
 async function request(action,confirmed=true){let code=200,body;await routes['POST /control']({body:{action,confirmed},headers:{authorization:'Bearer test-session'}},{status(value){code=value;return this;},json(value){body=value;}});return {code,body};}
 const status=()=>{let body;routes['GET /status']({}, {status(){return this;},json(value){body=value;}});return body;};
 t.after(async()=>{plugin.stop();await new Promise(resolve=>server.close(resolve));await sleep(10);fs.rmSync(directory,{recursive:true,force:true});});
 return {request,status,finished,emitted,writes,directory,setFail:value=>{fail=value;},setHold:value=>{hold=value;},release:()=>release?.(),recording:()=>id,reopen:()=>{plugin.stop();open();},reopenUnclean:()=>{const file=path.join(directory,'replay-checkpoint.json'),saved=fs.readFileSync(file);plugin.stop();fs.writeFileSync(file,saved);open();}};
}
test('Stop saves the exact recording and Restart rewinds into a different recording with fresh clocks',async t=>{
 const f=await fixture(t);assert.equal((await f.request('start')).code,200);const first=f.recording(),initial=f.status();
 const stopped=await f.request('stop');assert.equal(stopped.code,200);assert.equal(stopped.body.state,'stopped');assert.equal(f.recording(),null);assert.deepEqual(f.finished,[first]);
 assert.equal((await f.request('start')).code,409);
 const resumed=await f.request('restart');assert.equal(resumed.code,200);assert.equal(resumed.body.state,'running');assert.notEqual(f.recording(),first);assert.notEqual(resumed.body.replayId,initial.replayId);
 assert.equal(f.emitted[0].delta.updates[0].values[0].value.latitude,f.emitted.at(-1).delta.updates[0].values[0].value.latitude);
 assert.ok(Date.parse(f.emitted.at(-1).delta.updates[0].timestamp)>Date.parse(f.emitted[0].delta.updates[0].timestamp));
 assert.deepEqual(f.writes[0],{input:{expectedRecordingId:first},authorization:'Bearer test-session'});
 assert.ok(fs.existsSync(path.join(f.directory,`replay-emissions-${initial.replayId}.ndjson`)));
});
test('failed Finish leaves the same replay paused and never rewinds it',async t=>{
 const f=await fixture(t);await f.request('start');const before=f.status(),id=f.recording();f.setFail(true);
 const result=await f.request('restart');assert.equal(result.code,409);assert.equal(f.status().state,'paused');assert.equal(f.status().cursor,before.cursor);assert.equal(f.status().replayId,before.replayId);assert.equal(f.recording(),id);assert.deepEqual(f.finished,[]);
});
test('confirmation and concurrent-action guards prevent overlapping restarts',async t=>{
 const f=await fixture(t);await f.request('start');assert.equal((await f.request('stop',false)).code,400);assert.equal(f.status().state,'running');
 f.setHold(true);const saving=f.request('stop');for(let i=0;i<100&&!f.writes.length;i++)await sleep(5);
 assert.equal((await f.request('restart')).code,409);assert.equal(f.status().busy,true);f.release();assert.equal((await saving).code,200);assert.equal(f.finished.length,1);
});
test('server reload restores the paused cursor and recording identity',async t=>{
 const f=await fixture(t);await f.request('start');await f.request('pause');const before=f.status(),id=f.recording();f.reopen();
 assert.equal(f.status().state,'paused');assert.equal(f.status().cursor,before.cursor);assert.equal(f.status().replayId,before.replayId);assert.equal(f.recording(),id);
 await f.request('resume');assert.equal(f.recording(),id);assert.deepEqual(f.finished,[]);
});

test('an unclean interrupted pass requires a new recording rather than repeating data in the old one',async t=>{
 const f=await fixture(t);await f.request('start');const previous=f.recording();f.reopenUnclean();
 assert.equal(f.status().restartRequired,true);assert.equal((await f.request('resume')).code,409);assert.equal(f.recording(),previous);
 assert.equal((await f.request('restart')).code,200);assert.notEqual(f.recording(),previous);assert.deepEqual(f.finished,[previous]);
});
