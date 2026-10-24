import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {renderControls}=require('./provider/controls.cjs');
let server,origin,mode,state,writes,failSave,cursor,recording;
test.beforeAll(async()=>{
 server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/embedded'){res.setHeader('content-type','text/html');return res.end('<iframe title="Replay" sandbox="allow-scripts allow-same-origin" style="width:100%;height:800px;border:0" src="/plugins/wakelogger-real-trip-replay/controls"></iframe>');}
  if(url.pathname.endsWith('/controls')){res.setHeader('content-type','text/html');return res.end(renderControls('https://preview.example.invalid/vessels/manage?vessel=7&tab=live'));}
  if(url.pathname.endsWith('/controls.js')){res.setHeader('content-type','application/javascript');return res.end(fs.readFileSync(new URL('./provider/controls.js',import.meta.url)));}
  let body='';for await(const part of req)body+=part;
  res.setHeader('content-type','application/json');
  if(req.method==='POST')writes.push({path:url.pathname,body:JSON.parse(body)});
  if(url.pathname.endsWith('/tracking')){
   if(req.method==='POST'){
    if(failSave){res.statusCode=503;return res.end(JSON.stringify({error:'tracking_persistence_failed'}));}
    const change=JSON.parse(body);if(!change.confirmed||change.expectedUploadMode!==mode){res.statusCode=409;return res.end('{}');}mode=change.uploadMode;
   }
   return res.end(JSON.stringify({uploadMode:mode,paired:true,available:true,trackingSessionId:recording}));
  }
  if(url.pathname.endsWith('/control')){const action=JSON.parse(body).action;if(action==='stop'){state='stopped';recording=null;}else{state=action==='pause'?'paused':'running';if(state==='running'){cursor=12;recording=action==='restart'?'new-recording':'recording';}}}
  return res.end(JSON.stringify({state,cursor,capabilities:{tripLifecycle:true},total:100,sourceTime:'2026-06-28T03:06:00Z'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
});
test.afterAll(()=>new Promise(resolve=>server.close(resolve)));
test.beforeEach(()=>{mode='local_only';state='paused';writes=[];failSave=false;cursor=0;recording=null;});
const open=page=>page.goto(origin+'/plugins/wakelogger-real-trip-replay/controls');
test('one confirmed Start enables tracking then starts; website uses the configured HTTPS origin',async({page})=>{
 await open(page);
 await expect(page.getByRole('link',{name:'Open test website'})).toHaveAttribute('href','https://preview.example.invalid/vessels/manage?vessel=7&tab=live');
 await page.getByRole('button',{name:'Start test'}).click();
 await page.getByRole('button',{name:'Start and enable Live tracking'}).click();
 await expect(page.locator('#status')).toHaveText('Playing');
 expect(writes.map(w=>w.body)).toEqual([{uploadMode:'automatic',confirmed:true,expectedUploadMode:'local_only'},{action:'start'}]);
 await page.getByRole('button',{name:'Pause',exact:true}).click();await expect(page.getByRole('button',{name:'Resume test'})).toBeEnabled();
});
test('cancel does not change tracking or feed',async({page})=>{
 await open(page);await page.getByRole('button',{name:'Start test'}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByRole('button',{name:'Start test'})).toBeEnabled();expect(writes).toEqual([]);
});
test('failed tracking confirmation never starts the feed',async({page})=>{
 failSave=true;await open(page);await page.getByRole('button',{name:'Start test'}).click();await page.getByRole('button',{name:'Start and enable Live tracking'}).click();
 await expect(page.getByRole('alert')).toHaveText('tracking_persistence_failed');expect(writes).toHaveLength(1);expect(state).toBe('paused');
});
test('already enabled tracking starts without another tracking write',async({page})=>{
 mode='automatic';await open(page);await page.getByRole('button',{name:'Start test'}).click();await expect(page.locator('#status')).toHaveText('Playing');
 expect(writes.map(w=>w.body)).toEqual([{action:'start'}]);
});

test('mobile embedded controls start without browser-native modal permission',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto(origin+'/embedded');
 const frame=page.frameLocator('iframe');await frame.getByRole('button',{name:'Start test'}).click();
 await frame.getByRole('button',{name:'Start and enable Live tracking'}).click();
 await expect(frame.locator('#status')).toHaveText('Playing');expect(writes.map(w=>w.body)).toEqual([{uploadMode:'automatic',confirmed:true,expectedUploadMode:'local_only'},{action:'start'}]);
});

test('Stop and save closes the trip; Restart is a separate confirmed action',async({page})=>{
 mode='automatic';state='paused';cursor=45;recording='existing-recording';await open(page);
 await page.getByRole('button',{name:'Stop and save',exact:true}).click();
 await page.getByRole('button',{name:'Stop and save trip',exact:true}).click();
 await expect(page.locator('#status')).toHaveText('Stopped');expect(recording).toBeNull();
 await page.getByRole('button',{name:'Restart test',exact:true}).click();await page.getByRole('button',{name:'Save trip and restart',exact:true}).click();
 await expect(page.locator('#status')).toHaveText('Playing');expect(recording).toBe('new-recording');
 expect(writes.map(w=>w.body)).toEqual([{action:'stop',confirmed:true},{action:'restart',confirmed:true}]);
});
test('cancelling Restart keeps the paused trip and source position',async({page})=>{
 mode='automatic';state='paused';cursor=45;recording='existing-recording';await open(page);
 await page.getByRole('button',{name:'Restart test',exact:true}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByRole('button',{name:'Resume test'})).toBeEnabled();expect(writes).toEqual([]);expect(cursor).toBe(45);expect(recording).toBe('existing-recording');
});
