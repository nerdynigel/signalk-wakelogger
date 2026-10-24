// Real 1x sensor replay -> real Signal K -> paired MQTT -> real test API ->
// both browsers. No response routes, source-clock overrides or synthetic wind.
import fs from 'node:fs';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';

const data=process.env.WAKELOGGER_REPLAY_DATA || '/data';
const config=JSON.parse(fs.readFileSync(path.join(data,'deployment.json'),'utf8'));
const token=fs.readFileSync(path.join(data,'owner-token'),'utf8').trim();
const sk=`http://127.0.0.1:${config.port}`,api='http://127.0.0.1:8010';
const output=path.join(data,'runs',config.runId,'acceptance');
fs.mkdirSync(output,{recursive:true});
const continuing=process.env.WAKELOGGER_REPLAY_CONTINUE==='1';
const report=continuing ? JSON.parse(fs.readFileSync(path.join(output,'report.json'))) : {runId:config.runId,source:'Original trip 48 DAT messages',startedAt:new Date().toISOString(),checks:[],snapshots:[],errors:[]};
if(continuing) {
  report.interruptions=[...(report.interruptions || []),{at:report.finishedAt,reason:report.failure}];
  // Earlier live-map availability is distinct from materialized qualification.
  for(const check of report.checks) if(check.name==='Normal movement qualification and live heading on both maps' && !check.voyageId) check.name='Pending recording and live heading visible on both maps';
  delete report.result;delete report.failure;delete report.finishedAt;
}
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(url,method='GET',body,auth=false) {
  const r=await fetch(url,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(auth?{authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  const value=await r.json();if(!r.ok)throw Error(`${method} ${new URL(url).pathname} HTTP ${r.status}: ${JSON.stringify(value)}`);return value;
}
const control=action=>request(`${sk}/plugins/wakelogger-real-trip-replay/control`,'POST',{action});
const overview=()=>request(`${api}/v1/vessels/${config.vesselId}/telemetry/overview`,'GET',null,true);
const check=(name,details={})=>{report.checks.push({name,at:new Date().toISOString(),...details});save();console.log(`PASS ${name}`);};
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const plugin=await browser.newPage({viewport:{width:1280,height:900}});
const web=await browser.newPage({viewport:{width:1280,height:900}});
for(const [label,page] of [['plugin',plugin],['web',web]]) page.on('pageerror',error=>report.errors.push({surface:label,message:error.message}));
let paused=false,resumed=false,advanced=false,qualified=false,reloaded=false,pauseWall=0,lastSnapshot=0,lastLog=0;
if(continuing) {
  resumed=report.checks.some(c=>c.name==='Fresh original readings restored both displays');
  reloaded=report.checks.some(c=>c.name==='Reload retained course, full recorded track and live display');
}
try {
  await plugin.context().tracing.start({screenshots:true,snapshots:true});
  await web.context().tracing.start({screenshots:true,snapshots:true});
  plugin.on('dialog',dialog=>dialog.accept());
  await plugin.goto(`${sk}/signalk-wakelogger/`);
  const toggle=plugin.getByRole('switch',{name:'Live tracking'});
  await expect(toggle).toBeEnabled({timeout:60000});
  if(await toggle.getAttribute('aria-checked')!=='true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked','true',{timeout:15000});
  await web.addInitScript(value=>localStorage.setItem('wakelogger_auth_token',value),token);
  await web.goto(`http://127.0.0.1:3000/vessels/manage?vessel=${config.vesselId}&tab=live`);
  await control(continuing?'resume':'start');
  check(continuing?'Continued the same recorded stream after correcting the test-control assumption':'Confirmed upload mode and started the real 1x sensor feed');
  const deadline=Date.now()+40*60000;
  while(Date.now()<deadline) {
    const state=await request(`${sk}/plugins/wakelogger-real-trip-replay/status`);
    const current=await overview();
    if(Date.now()-lastLog>30000){console.log(`REPLAY ${state.sourceTime} ${state.state} ${state.cursor}/${state.total}`);lastLog=Date.now();}
    if(state.state==='paused' && !paused) {
      if(!String(state.reason).includes('Scheduler lag'))throw Error(`Unexpected pause: ${state.reason}`);
      report.checks.push({name:'Scheduler-lag rebase',at:new Date().toISOString(),source:state.sourceTime});
      await control('resume');continue;
    }
    if(current.tracking_session?.tracking_session_id && current.tracking_session?.voyage_id && !qualified) {
      if(current.race_navigation?.race_plan_id!==config.planId) await request(`${api}/v1/vessels/${config.vesselId}/telemetry/course`,'PUT',{race_plan_id:config.planId,active_waypoint_index:1},true);
      await expect(web.getByTestId('chartplotter-heading-guide')).toHaveCount(1,{timeout:30000});
      await expect(plugin.locator('#map')).toHaveAttribute('data-heading-guide-bearing',/.+/,{timeout:15000});
      qualified=true;report.voyageId=current.tracking_session.voyage_id;
      await plugin.screenshot({path:path.join(output,'plugin-live.png'),fullPage:true});
      await web.screenshot({path:path.join(output,'web-live.png'),fullPage:true});
      check('Normal movement qualification and live heading on both maps',{voyageId:report.voyageId});
    }
    if(qualified && Date.now()-lastSnapshot>10000 && !paused) {
      const navigation=await request(`${sk}/signalk/v1/api/vessels/self/navigation`);
      report.snapshots.push({wall:new Date().toISOString(),source:state.sourceTime,
        cloud:current.live_state,native:{position:navigation.position,headingTrue:navigation.headingTrue,headingMagnetic:navigation.headingMagnetic,variation:navigation.magneticVariation,sog:navigation.speedOverGround,cog:navigation.courseOverGroundTrue},
        pluginGuide:await plugin.locator('#map').getAttribute('data-heading-guide-bearing'),
        pluginLaylineStatus:await plugin.locator('#map').getAttribute('data-layline-status'),
        webGuide:await web.getByTestId('chartplotter-heading-guide').getAttribute('data-bearing-deg').catch(()=>null)});
      lastSnapshot=Date.now();save();
    }
    if(qualified && !paused && !resumed && state.sourceTimeMs>=Date.parse('2026-06-28T03:10:00Z')) {
      await control('pause');paused=true;pauseWall=Date.now();check('Paused original input to exercise actual wall-clock freshness');
    }
    if(paused && !resumed && Date.now()-pauseWall>=135000) {
      await expect(plugin.locator('#map')).toHaveAttribute('data-heading-guide-bearing','',{timeout:15000});
      await expect(web.getByTestId('chartplotter-heading-guide')).toHaveCount(0,{timeout:15000});
      await plugin.screenshot({path:path.join(output,'plugin-stale.png'),fullPage:true});
      await web.screenshot({path:path.join(output,'web-stale.png'),fullPage:true});
      check('Both surfaces expired retained readings after a real 135-second pause');
      await control('resume');paused=false;resumed=true;
      await expect(plugin.locator('#map')).toHaveAttribute('data-heading-guide-bearing',/.+/,{timeout:30000});
      await expect(web.getByTestId('chartplotter-heading-guide')).toHaveCount(1,{timeout:30000});
      check('Fresh original readings restored both displays');
    }
    if(qualified && resumed && !reloaded) {
      await plugin.reload();await web.reload();
      await expect(plugin.locator('#next-mark')).toContainText('Lockyer',{timeout:15000});
      await expect(web.getByTestId('chartplotter-heading-guide')).toHaveCount(1,{timeout:30000});
      check('Reload retained course, full recorded track and live display');reloaded=true;
    }
    if(!advanced && state.sourceTimeMs>=Date.parse('2026-06-28T03:16:21Z')) {
      const currentNav=(await overview()).race_navigation;
      const before=currentNav?.active_waypoint_index;
      if(before===1) await request(`${api}/v1/vessels/${config.vesselId}/telemetry/race-navigation`,'PATCH',{waypoint_action:'next'},true);
      else if(before!==2)throw Error(`Unexpected pre-advance waypoint index ${before}`);
      // Cloud approach-plane progress and native route control are separate
      // authorities. Exercise the existing explicit onboard control as needed.
      await plugin.getByRole('tab',{name:'Course',exact:true}).click();
      await plugin.locator('#point-index').selectOption('2');
      await plugin.locator('#set-point').click();
      await expect(plugin.locator('#next-mark')).toContainText('Green Island',{timeout:30000});
      const selected=(await overview()).race_navigation;
      const target=selected.route_waypoints[selected.active_waypoint_index];
      await expect(web.getByTestId('chartplotter-port-layline')).toHaveAttribute('data-target-lat',String(target.latitude),{timeout:30000});
      await plugin.screenshot({path:path.join(output,'plugin-next-leg.png'),fullPage:true});
      await web.screenshot({path:path.join(output,'web-next-leg.png'),fullPage:true});
      advanced=true;check('Both supported course controls selected Green Island',{cloudAlreadyAdvanced:before===2,nativeExplicitControl:true});
    }
    if(state.state==='ended') {
      if(!qualified || !resumed || !advanced || !reloaded)throw Error('Replay ended before required checks completed');
      await plugin.getByRole('button',{name:'Finish trip',exact:true}).click();
      const finishDeadline=Date.now()+180000;
      let finished;
      do {
        finished=await request(`${sk}/plugins/signalk-wakelogger/tracking`);
        if(!finished.trackingSessionId && !finished.queue?.messageCount &&
          finished.finishedTrip?.cloudStatus?.state==='ready' &&
          !finished.finishedTrip.uploadPending && !finished.finishedTrip.confirmationPending)break;
        await delay(2000);
      }while(Date.now()<finishDeadline);
      if(finished.finishedTrip?.cloudStatus?.state!=='ready' || finished.finishedTrip.confirmationPending)
        throw Error('Finish did not receive cloud readiness confirmation');
      check('End of clip and explicit Finish confirmed the complete cloud trip',{finishedTrip:finished.finishedTrip});
      if(report.errors.length)throw Error(`Browser errors: ${JSON.stringify(report.errors)}`);
      report.result='passed';report.finishedAt=new Date().toISOString();save();break;
    }
    await delay(2000);
  }
  if(report.result!=='passed')throw Error('Replay acceptance timed out');
} catch(error) {
  report.result='failed';report.failure=error.message;report.finishedAt=new Date().toISOString();save();
  await control('pause').catch(()=>{});
  await plugin.screenshot({path:path.join(output,'plugin-failure.png'),fullPage:true}).catch(()=>{});
  await web.screenshot({path:path.join(output,'web-failure.png'),fullPage:true}).catch(()=>{});
  console.error(error.stack);process.exitCode=1;
} finally {
  await plugin.context().tracing.stop({path:path.join(output,'plugin-trace.zip')});
  await web.context().tracing.stop({path:path.join(output,'web-trace.zip')});
  await browser.close();
}
