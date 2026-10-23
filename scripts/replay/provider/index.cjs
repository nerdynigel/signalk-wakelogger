const fs = require('node:fs');
const {ReplayEngine} = require('./engine.cjs');

module.exports = app => {
  let engine, timer, log, webUrl='';
  return {
    id:'wakelogger-real-trip-replay',name:'Real trip replay',
    description:'Receive-only historical sailing sensors; isolated test instance only',
    schema:{type:'object',properties:{file:{type:'string',default:'/replay/clip.ndjson'}}},
    start(options) {
      webUrl=String(options.webUrl || '').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
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
      reader.get('/controls',(_req,res)=>res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SAGS sailing replay</title>
        <style>body{font:16px system-ui;background:#102c3b;color:#fff;max-width:720px;margin:40px auto;padding:20px}button,a{display:inline-block;padding:12px 18px;margin:5px;border-radius:8px}button{cursor:pointer}a{color:#8de0f0}pre{white-space:pre-wrap}#status{line-height:1.8}</style>
        <h1>SAGS sailing replay</h1><p>28 June 2026 · 1:06–1:26 pm AEST · original instruments at real speed.</p>
        <p>Confirm Live tracking on in the onboard app before starting. The first 30 seconds initialize the instruments; the website then waits for normal trip qualification.</p>
        <p><a href="/signalk-wakelogger/">Open onboard app</a>${webUrl ? '<a href="'+webUrl+'">Open test vessel</a>' : ''}</p>
        <div>${['start','pause','resume','stop'].map(action=>'<button data-action="'+action+'">'+action[0].toUpperCase()+action.slice(1)+'</button>').join('')}</div>
        <p id="status" role="status">Reading replay state…</p><p id="error" role="alert"></p>
        <p>Playback runs once. At the end, use Finish trip in the onboard app. This feed belongs only to the replay test vessel.</p>
        <script>const base='/plugins/wakelogger-real-trip-replay/';async function refresh(){const r=await fetch(base+'status');const s=await r.json();document.querySelector('#status').textContent=s.state+' · Original time '+new Date(s.sourceTime).toLocaleTimeString('en-AU',{timeZone:'Australia/Brisbane'})+' · '+s.cursor+' / '+s.total+' messages'+(s.reason?' · '+s.reason:'')}
        document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{try{if(b.dataset.action==='start'){const t=await(await fetch('/plugins/signalk-wakelogger/tracking')).json();if(t.uploadMode!=='automatic')throw Error('Confirm Live tracking on in the onboard app first.')}const r=await fetch(base+'control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:b.dataset.action})});const s=await r.json();if(!r.ok)throw Error(s.error);document.querySelector('#error').textContent='';await refresh()}catch(e){document.querySelector('#error').textContent=e.message}});refresh();setInterval(refresh,1000);</script></html>`));
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
