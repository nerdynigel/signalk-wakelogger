#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import os from 'node:os';

const root=fileURLToPath(new URL('../..',import.meta.url));
const data=path.resolve(process.env.WAKELOGGER_REPLAY_DATA || path.join(os.homedir(),'.local/share/wakelogger-replay/trip-48'));
const stateFile=path.join(data,'deployment.json');
const environment=readEnvironment();
const action=process.argv[2] || 'status';
const base=environment.apiOrigin || 'http://127.0.0.1:8010';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('The replay operator must target the local test API');
const ownerId=environment.ownerUserId;
const port=Number(process.env.WAKELOGGER_REPLAY_PORT || (fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')).port:0) || 3003);
const sk=`http://127.0.0.1:${port}`;
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:8*1024*1024});
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function readEnvironment() {
  const config=JSON.parse(fs.readFileSync(path.join(data,'environment.json'),'utf8'));
  if(!config.expectedServiceOrigin || !config.publicWebOrigin || !config.pairingUrl || !config.ownerUserId || !config.ownerDisplayName) throw new Error('Complete the private replay environment.json first');
  for(const target of [config.expectedServiceOrigin,config.pairingUrl,config.publicWebOrigin]) {
    if(['wakelogger.com','www.wakelogger.com'].includes(new URL(target).hostname))throw new Error('Production destinations are forbidden for replay');
  }
  if(new URL(config.pairingUrl).origin!==new URL(config.expectedServiceOrigin).origin)throw new Error('Pairing must use the selected development service');
  return config;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(url,method='GET',body,token,timeoutMs=10000) {
  const response=await fetch(url,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeoutMs)});
  const value=await response.json();
  if(!response.ok) throw new Error(`${method} ${new URL(url).pathname}: HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}
function ownerToken() {
  const code=`from datetime import datetime, UTC, timedelta
import json, sys
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.security import create_access_token, generate_token_id
from app.models import User, AuthToken
config=json.loads(sys.argv[1])
assert settings.app_public_base_url.rstrip('/') == config['expectedServiceOrigin'].rstrip('/'), 'Refusing an unexpected API instance'
with SessionLocal() as db:
 u=db.get(User,config['ownerUserId'])
 assert u and u.display_name == config['ownerDisplayName'] and u.is_active and u.role == 'admin'
 at=datetime.now(UTC); end=at+timedelta(hours=4); tid=generate_token_id()
 db.add(AuthToken(token_id=tid,user_id=u.id,issued_at=at,expires_at=end));db.commit()
 print(create_access_token(user_id=u.id,role=u.role,token_id=tid,expires_at=end))
`;
  const token=docker(['exec','-i','wakelogger-api-1','python','-c',code,JSON.stringify(environment)]).trim();
  fs.writeFileSync(path.join(data,'owner-token'),token,{mode:0o600});
  return token;
}
const token=()=>fs.readFileSync(path.join(data,'owner-token'),'utf8').trim();
async function provision(reset=false) {
  if(!fs.existsSync(path.join(data,'clip.ndjson'))) throw new Error('Prepare the DAT clip first');
  let state=fs.existsSync(stateFile)?read(stateFile):{};
  if(state.runId && !reset) {
    const existing=JSON.parse(docker(['inspect','wakelogger-real-trip-replay']))[0];
    if(existing.State.Running || state.phase==='ready') throw new Error('A replay run already exists; use reset after Finish trip');
    if(!existing.Mounts.some(m=>m.Source===path.join(state.runDir,'signalk'))) throw new Error('Replay container does not belong to this run');
    docker(['rm','wakelogger-real-trip-replay']);
  }
  if(reset) {
    const tracking=await api(`${sk}/plugins/signalk-wakelogger/tracking`);
    if(tracking.trackingSessionId) throw new Error('Finish the active test trip in the onboard app before reset');
    if(tracking.queue?.messageCount || tracking.finishedTrip?.uploadPending || tracking.finishedTrip?.confirmationPending)
      throw new Error('Wait for saved history upload and cloud Finish confirmation before reset');
    const existing=JSON.parse(docker(['inspect','wakelogger-real-trip-replay']))[0];
    if(!existing.Mounts.some(m=>m.Source===path.join(state.runDir,'signalk')))
      throw new Error('Replay container does not belong to this run');
    save(path.join(state.runDir,'deployment.json'),state);
  }
  const auth=ownerToken();
  const users=await api(`${base}/v1/admin/users`,'GET',null,auth);
  const owner=users.find(user=>user.id===ownerId);
  if(!owner?.feature_flags?.race_analytics) {
    if(!fs.existsSync(path.join(data,'owner-features-before.json'))) save(path.join(data,'owner-features-before.json'),owner?.feature_overrides || {});
    await api(`${base}/v1/admin/users/${ownerId}`,'PATCH',{feature_overrides:{race_analytics:true}},auth);
  }
  if(!state.vesselId) {
    const vessels=await api(`${base}/v1/vessels`,'GET',null,auth);
    const list=Array.isArray(vessels)?vessels:vessels.items || [];
    const existing=list.find(v=>v.name==='Replay — SAGS 2026-06-28');
    const vessel=existing || await api(`${base}/v1/vessels`,'POST',{name:'Replay — SAGS 2026-06-28',propulsion_type:'sail',playback_icon_type:'sailing_monohull'},auth);
    state.vesselId=vessel.id;
    const course=read(path.join(data,'source-course.json'));
    const route=await api(`${base}/v1/race-routes`,'POST',{vessel_id:vessel.id,name:'Replay — '+course.name,
      notes:'Private test copy of trip 48 course. Original track passes about 180m from Lockyer Light; use manual advancement.',
      points:course.points.map(p=>({name:p.name,latitude:p.latitude,longitude:p.longitude,source_type:'manual'}))},auth);
    state.routeId=route.id; save(stateFile,state);
  }
  const runId=crypto.randomUUID();
  const runDir=path.join(data,'runs',runId), config=path.join(runDir,'signalk');
  fs.mkdirSync(path.join(config,'plugin-config-data'),{recursive:true,mode:0o700});
  const pairing=await api(`${base}/v1/vessels/${state.vesselId}/telemetry/pairing-codes`,'POST',{},auth);
  const planBody={vessel_id:state.vesselId,race_route_id:state.routeId,name:`Replay 2026-06-28 ${runId.slice(0,8)}`,
    planned_start_time:new Date().toISOString(),status:'planned',forecast_source:'open-meteo'};
  // Normal forecast-provider retries can take longer than ordinary local API
  // reads. Leave the previous replay intact until this preparation succeeds.
  const plan=state.planId ? await api(`${base}/v1/race-plan/${state.planId}`,'PATCH',planBody,auth,120000) : await api(`${base}/v1/race-plan`,'POST',planBody,auth,120000);
  state={...state,runId,runDir,planId:plan.id,container:'wakelogger-real-trip-replay',sourceVoyageId:48,
    sourceStart:'2026-06-28T03:06:00Z',sourceEnd:'2026-06-28T03:26:00Z',
    webUrl:`${environment.publicWebOrigin}/vessels/manage?vessel=${state.vesselId}&tab=live`,
    port,phase:'provisioning',initialForecastBasis:'Normal current-time test forecast provider; original sailing sensors remain the live observations',
    pluginUrl:`${new URL(environment.publicWebOrigin).protocol}//${new URL(environment.publicWebOrigin).hostname}:${port}/signalk-wakelogger/`,createdAt:new Date().toISOString()};
  save(stateFile,state);
  save(path.join(config,'settings.json'),{vessel:{name:'Replay — SAGS 2026-06-28',uuid:runId},pipedProviders:[]});
  save(path.join(config,'plugin-config-data/signalk-wakelogger.json'),{enabled:true,configuration:{pairingApiUrl:environment.pairingUrl,pairingCode:pairing.code,samplePeriodMs:1000,raceProgressionMode:'off'}});
  save(path.join(config,'plugin-config-data/wakelogger-real-trip-replay.json'),{enabled:true,configuration:{file:'/replay/clip.ndjson',webUrl:state.webUrl}});
  const image=docker(['inspect','signalk-dev','--format','{{.Image}}']).trim();
  state.imageId=image;state.toolRoot=root;
  state.pluginTarballSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(data,'wakelogger-feature.tgz'))).digest('hex');
  state.sourceSha256=read(path.join(data,'frames.ndjson.json')).sourceSha256;
  save(stateFile,state);
  save(path.join(runDir,'deployment.json'),state);
  if(reset) docker(['rm','-f','wakelogger-real-trip-replay']);
  docker(['run','-d','--init','--name',state.container,'--label','org.wakelogger.replay=real-trip-48','-p',`${port}:3000`,
    '--entrypoint','sh','-v',`${config}:/home/node/.signalk`,
    '-v',`${data}:/replay:ro`,'-v',`${root}/scripts/replay/provider:/replay-provider:ro`,
    '-v',`${data}/wakelogger-feature.tgz:/opt/signalk-wakelogger.tgz:ro`,
    '-v',`${root}/scripts/replay/entrypoint.sh:/replay-entrypoint.sh:ro`,image,'/replay-entrypoint.sh']);
  for(let attempt=0;attempt<120;attempt++) {
    try {
      const tracking=await api(`${sk}/plugins/signalk-wakelogger/tracking`);
      if(tracking.paired) {
        await api(`${base}/v1/vessels/${state.vesselId}/telemetry/course`,'PUT',{race_plan_id:state.planId,active_waypoint_index:1},auth);
        state.phase='ready';save(stateFile,state);save(path.join(runDir,'deployment.json'),state);
        console.log(JSON.stringify({ready:true,...state},null,2));return;
      }
    } catch(error) {if(attempt===119) throw error;}
    await sleep(1000);
  }
  throw new Error('Pairing did not become ready; inspect only this replay container logs');
}

if(action==='provision' || action==='reset') await provision(action==='reset');
else if(action==='status') {
  console.log(JSON.stringify({deployment:read(stateFile),playback:await api(`${sk}/plugins/wakelogger-real-trip-replay/status`),tracking:await api(`${sk}/plugins/signalk-wakelogger/tracking`)},null,2));
} else if(action==='advance') {
  const state=read(stateFile);
  const native=await api(`${sk}/plugins/signalk-wakelogger/course`);
  const route=native.native?.course?.activeRoute;
  if(!native.native?.activeMatchesDesired || !Number.isInteger(route?.pointIndex)) throw new Error('The replay course must be active onboard before advancing');
  const count=(native.desired?.marks?.length || 0)+2;
  const next=Math.min(route.pointIndex+1,count-1);
  const current=await api(`${base}/v1/vessels/${state.vesselId}/telemetry/overview`,'GET',null,token());
  const cloud=current.race_navigation?.active_waypoint_index;
  if(cloud!==next && cloud!==route.pointIndex) throw new Error('Native and cloud route positions need explicit operator reconciliation');
  if(cloud!==next) await api(`${base}/v1/vessels/${state.vesselId}/telemetry/race-navigation`,'PATCH',{waypoint_action:'next'},token());
  const stillActive=await api(`${sk}/signalk/v2/api/vessels/self/navigation/course`);
  if(stillActive.activeRoute?.href!==route.href)throw new Error('Active native course changed; refusing navigation write');
  await api(`${sk}/signalk/v2/api/vessels/self/navigation/course/activeRoute/pointIndex`,'PUT',{value:next});
  console.log(JSON.stringify({activeWaypointIndex:next,cloudAlreadyAdvanced:cloud===next,nativeExplicitControl:true}));
} else if(['start','pause','resume','stop'].includes(action)) {
  if(action==='start') {
    const tracking=await api(`${sk}/plugins/signalk-wakelogger/tracking`);
    if(tracking.uploadMode!=='automatic') throw new Error('Confirm Live tracking ON in the replay onboard app first');
  }
  console.log(JSON.stringify(await api(`${sk}/plugins/wakelogger-real-trip-replay/control`,'POST',{action}),null,2));
} else throw new Error('Use provision, start, pause, resume, stop, status, advance or reset');
