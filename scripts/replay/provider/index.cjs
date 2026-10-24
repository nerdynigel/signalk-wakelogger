const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {ReplayEngine} = require('./engine.cjs');
const {renderControls} = require('./controls.cjs');

module.exports = app => {
  let engine, timer, log, webUrl='', directory, sourceHash, replayId, sourceLabel, lastTrip=null, operation=null, apiOrigin, restartRequired=false;
  const state = () => ({...engine.status(), replayId, capabilities:{tripLifecycle:true}, busy:operation!==null, operation, lastTrip, restartRequired});
  const checkpoint = (clean=false) => {
    const file=path.join(directory,'replay-checkpoint.json');
    fs.writeFileSync(file+'.tmp',JSON.stringify({v:1,clean,sourceHash,replayId,sourceLabel,lastTrip,...engine.status()}),{mode:0o600});
    fs.renameSync(file+'.tmp',file);
  };
  async function local(req, route, method='GET', body) {
    const headers={};
    for(const key of ['authorization','cookie']) if(req.headers?.[key])headers[key]=req.headers[key];
    if(body)headers['content-type']='application/json';
    const response=await fetch(apiOrigin+route,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    const value=await response.json();
    if(!response.ok)throw new Error(value.error || value.detail || `Onboard request failed (${response.status})`);
    return value;
  }
  async function finish(req) {
    const tracking=await local(req,'/plugins/signalk-wakelogger/tracking');
    if(tracking.trackingSessionId){
      const saved=await local(req,'/plugins/signalk-wakelogger/tracking/finish','POST',{expectedRecordingId:tracking.trackingSessionId});
      if(saved.trackingSessionId)throw new Error('The current recording is still open');
      lastTrip={id:tracking.trackingSessionId,savedAt:Date.now(),replayId};
    }
  }
  async function waitRecording(req, previousId) {
    for(let attempt=0;attempt<30;attempt++){
      const tracking=await local(req,'/plugins/signalk-wakelogger/tracking');
      if(tracking.trackingSessionId && tracking.trackingSessionId!==previousId)return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    engine.pause('Waiting for the first recorded position');
    throw new Error('The new recording did not start; check onboard recording before resuming');
  }
  async function rotateLog() {
    await new Promise((resolve,reject)=>{log.once('error',reject);log.end(resolve);});
    const file=path.join(directory,'replay-emissions.ndjson');
    await fs.promises.rename(file,path.join(directory,`replay-emissions-${replayId}.ndjson`));
    replayId=crypto.randomUUID();sourceLabel='replay-'+replayId.slice(0,8);
    log=fs.createWriteStream(file,{flags:'a',mode:0o600});
  }
  return {
    id:'wakelogger-real-trip-replay',name:'Real trip replay',
    description:'Receive-only historical sailing sensors; isolated test instance only',
    schema:{type:'object',properties:{file:{type:'string',default:'/replay/clip.ndjson'},webUrl:{type:'string',title:'Test website URL',pattern:'^https?://'},apiOrigin:{type:'string',title:'Local Signal K API origin',default:'http://127.0.0.1:3000'}}},
    start(options) {
      webUrl=String(options.webUrl || '');directory=app.getDataDirPath();
      const api=new URL(options.apiOrigin || 'http://127.0.0.1:3000');
      if(api.protocol!=='http:' || !['localhost','127.0.0.1'].includes(api.hostname) || api.username || api.password || api.pathname!=='/' || api.search || api.hash)throw new Error('Replay API must use the local Signal K server');
      apiOrigin=api.origin;
      const source=fs.readFileSync(options.file || '/replay/clip.ndjson','utf8');
      sourceHash=crypto.createHash('sha256').update(source).digest('hex');
      const events=source.trim().split('\n').map(JSON.parse);
      replayId=crypto.randomUUID();sourceLabel='replay-'+replayId.slice(0,8);
      let saved;
      try{saved=JSON.parse(fs.readFileSync(path.join(directory,'replay-checkpoint.json'),'utf8'));}
      catch(error){if(error.code!=='ENOENT')throw error;}
      if(saved){
        if(saved.v!==1 || saved.sourceHash!==sourceHash || !/^[0-9a-f-]{36}$/.test(saved.replayId))throw new Error('Replay checkpoint does not match the source clip');
        replayId=saved.replayId;sourceLabel=saved.sourceLabel;lastTrip=saved.lastTrip || null;
      }
      log=fs.createWriteStream(path.join(directory,'replay-emissions.ndjson'),{flags:'a',mode:0o600});
      engine=new ReplayEngine(events,(delta,event)=>{
        app.handleMessage('wakelogger-real-trip-replay',delta);
        log.write(JSON.stringify({replayId,sourceTimeMs:event.sourceTimeMs,wallTimestamp:delta.updates[0].timestamp,
          pgns:delta.updates.map(u=>u.source?.pgn),values:delta.updates.flatMap(u=>u.values)})+'\n');
      },Date.now,sourceLabel);
      if(saved){engine.restore(saved);restartRequired=saved.state==='running' && saved.clean!==true;}
      timer=setInterval(()=>{try{engine.tick();}catch(error){engine.pause(error.message);app.error(error.message);}},20);
      app.setPluginStatus('Ready; playback paused');
    },
    stop() {
      clearInterval(timer);
      if(engine){if(engine.state==='running')engine.pause('Paused after server restart');checkpoint(true);engine.stop();}
      log?.end();
    },
    registerWithRouter(router) {
      const reader=router.access?.('readonly') ?? router;
      const writer=router.access?.('readwrite') ?? router;
      reader.get('/controls',(_req,res)=>res.type('html').send(renderControls(webUrl)));
      reader.get('/controls.js',(_req,res)=>res.type('application/javascript').send(fs.readFileSync(path.join(__dirname,'controls.js'),'utf8')));
      reader.get('/status',(_req,res)=>res.status(engine?200:503).json(engine?state():{state:'initializing'}));
      writer.post('/control',async(req,res)=>{
        if(!engine)return res.status(503).json({error:'Replay initializing'});
        const action=req.body?.action;
        if(!['start','pause','resume','stop','restart'].includes(action))return res.status(400).json({error:'Unknown replay action'});
        if(operation)return res.status(409).json({error:'Another replay action is in progress',...state()});
        if(['stop','restart'].includes(action) && req.body.confirmed!==true)return res.status(400).json({error:'Confirm saving the current trip first'});
        operation=action;
        try{
          if(action==='stop' || action==='restart'){
            engine.pause('Saving test trip');checkpoint();
            await finish(req);engine.stop();checkpoint();
            if(action==='restart'){
              const tracking=await local(req,'/plugins/signalk-wakelogger/tracking');
              if(tracking.uploadMode!=='automatic')throw new Error('Enable Live tracking before restarting the test');
              await rotateLog();engine.rewind(sourceLabel);restartRequired=false;checkpoint();engine.start();checkpoint();await waitRecording(req,lastTrip?.id);
            }
          }else if(action==='start' || action==='resume'){
            if(restartRequired || engine.state==='stopped' || engine.state==='ended')throw new Error('Use Restart test to start a new trip');
            const tracking=await local(req,'/plugins/signalk-wakelogger/tracking');
            if(tracking.uploadMode!=='automatic')throw new Error('Enable Live tracking before starting the test');
            if(engine.cursor && !tracking.trackingSessionId)throw new Error('The previous trip is closed; use Restart test');
            engine.start();checkpoint();await waitRecording(req);
          }else engine.pause();
          checkpoint();operation=null;res.json(state());
        }catch(error){operation=null;checkpoint();res.status(409).json({error:error.message,...state()});}
      });
    }
  };
};
