const fs = require('node:fs');
const {ReplayEngine} = require('./engine.cjs');
const {renderControls} = require('./controls.cjs');

module.exports = app => {
  let engine, timer, log, webUrl='';
  return {
    id:'wakelogger-real-trip-replay',name:'Real trip replay',
    description:'Receive-only historical sailing sensors; isolated test instance only',
    schema:{type:'object',properties:{file:{type:'string',default:'/replay/clip.ndjson'},webUrl:{type:'string',title:'Test website URL',pattern:'^https?://'}}},
    start(options) {
      webUrl=String(options.webUrl || '');
      const events = fs.readFileSync(options.file || '/replay/clip.ndjson','utf8').trim().split('\n').map(JSON.parse);
      log = fs.createWriteStream(app.getDataDirPath()+'/replay-emissions.ndjson',{flags:'a',mode:0o600});
      engine = new ReplayEngine(events,(delta,event)=>{
        app.handleMessage('wakelogger-real-trip-replay',delta);
        log.write(JSON.stringify({sourceTimeMs:event.sourceTimeMs,wallTimestamp:delta.updates[0].timestamp,
          pgns:delta.updates.map(u=>u.source?.pgn),values:delta.updates.flatMap(u=>u.values)})+'\n');
      });
      timer = setInterval(()=>{
        try { engine.tick(); }
        catch(error) {engine.pause(error.message);app.error(error.message);}
      },20);
      app.setPluginStatus('Ready; playback paused');
    },
    stop() { clearInterval(timer); engine?.stop(); log?.end(); },
    registerWithRouter(router) {
      const reader = router.access?.('readonly') ?? router;
      const writer = router.access?.('readwrite') ?? router;
      reader.get('/controls',(_req,res)=>res.type('html').send(renderControls(webUrl)));
      reader.get('/controls.js',(_req,res)=>res.type('application/javascript').send(fs.readFileSync(require('node:path').join(__dirname,'controls.js'),'utf8')));
      reader.get('/status',(_req,res)=>res.status(engine ? 200 : 503).json(engine?.status() || {state:'initializing'}));
      writer.post('/control',(req,res)=>{
        if (!engine) return res.status(503).json({error:'Replay initializing'});
        const action = req.body?.action;
        if (!['start','pause','resume','stop'].includes(action)) return res.status(400).json({error:'Unknown replay action'});
        try {
          if (action === 'start' || action === 'resume') engine.start();
          else engine[action]();
          res.json(engine.status());
        } catch(error) {res.status(409).json({error:error.message,...engine.status()});}
      });
    }
  };
};
