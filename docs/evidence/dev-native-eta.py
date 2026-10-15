"""New owned route/plan, real native WS positions, persisted backend marker.
Synthetic DEV proof only. Explicit activation of this owned fixture route only; no host administration.
"""
import datetime
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import time
C = runpy.run_path(str(Path(__file__).with_name('dev-feature-client.py')))
request, pc, ROOT, api, sk, status, mode, bundle, values, token = (C[k] for k in ['request','pc','ROOT','api','sk','status','mode','bundle','values','token'])
NODE='/home/nigel/.nvm/versions/node/v24.21.0/bin/node'
receiptPath=ROOT/'docs/evidence/dev-native-eta.json'
R=json.loads(receiptPath.read_text()) if receiptPath.exists() else {'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'synthetic':True,'observations':[]}
assert not R.get('observations'), 'do not replay completed observations'
if R.get('marker'):R.setdefault('initialUnknownStart',R['marker'])
def save():receiptPath.write_text(json.dumps(R,indent=2)+'\n')
def write(path,body,method='POST'):
 code,result=request(bundle['api_base_url'],path,token,body,method)
 assert code in [200,201], (path,code,result.get('detail'))
 return result
before=status();assert before['uploadMode']=='local_only'
assert before['trackingSessionId'] is None or before['trackingSessionId']==R.get('finalOff',{}).get('trackingSessionId'), 'unowned active recording'
R.setdefault('before',before)
R['resumeBefore']=before
route=api('/v1/race-routes/'+str(R['routeId'])) if R.get('routeId') else write('/v1/race-routes',{'vessel_id':4,'name':'THE882 synthetic ETA leg','points':[{'name':'Synthetic start','latitude':-33.86,'longitude':151.21},{'name':'Synthetic finish','latitude':-33.86,'longitude':151.23}]})
R['routeId']=route['id'];save()
plan=api('/v1/race-plan/'+str(R['planId'])) if R.get('planId') else write('/v1/race-plan',{'vessel_id':4,'race_route_id':route['id'],'name':'THE882 synthetic ETA proof','planned_start_time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'forecast_source':'manual','forecast_twd_deg':180,'forecast_tws_knots':12,'forecast_gust_knots':15})
R['planId']=plan['id'];save()
# ws input in real time with unequal progress increments and deliberately
# stationary instantaneous SOG: the ETA must depend on signed leg progress.
js=r"""const fs=require('fs'),WebSocket=require('ws');const q=JSON.parse(fs.readFileSync(0,'utf8'));let n=0,timer;const ws=new WebSocket(q.url,{headers:{Authorization:'Bearer '+q.token}});const end=setTimeout(()=>{clearInterval(timer);ws.close();setTimeout(()=>process.exit(0),300)},85000);ws.on('open',()=>{timer=setInterval(()=>{const metres=n<20?n*2:40+(n-20)*3;const longitude=151.21+metres/(6371000*Math.cos(-33.86*Math.PI/180))*180/Math.PI;ws.send(JSON.stringify({context:'vessels.self',updates:[{$source:'THE882.synthetic.eta',timestamp:new Date().toISOString(),values:[{path:'navigation.position',value:{latitude:-33.86,longitude}},{path:'navigation.speedOverGround',value:0},{path:'navigation.courseOverGroundTrue',value:Math.PI}]}]}));n++},1000)});ws.on('error',()=>{clearTimeout(end);clearInterval(timer);process.exit(1)});"""
p=None
injectionStarted=time.time()
try:
 mode('automatic')
 p=subprocess.Popen([NODE,'-e',js],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 p.stdin.write(json.dumps({'url':bundle['signalk_url'].replace('http:','ws:')+'/signalk/v1/stream?subscribe=none','token':values['rw']}));p.stdin.close()
 # Receive a real current native position before desired-course observation.
 for _ in range(15):
  code,nav=sk('/signalk/v1/api/vessels/self/navigation')
  if code==200 and nav['position'].get('$source')=='THE882.synthetic.eta' and datetime.datetime.fromisoformat(nav['position']['timestamp'].replace('Z','+00:00')).timestamp()>injectionStarted+1:break
  time.sleep(1)
 assert nav['position'].get('$source')=='THE882.synthetic.eta'
 assert datetime.datetime.fromisoformat(nav['position']['timestamp'].replace('Z','+00:00')).timestamp()>injectionStarted+1
 if not R.get('selected'):
  R['selected']=write('/v1/vessels/4/telemetry/course',{'race_plan_id':plan['id'],'active_waypoint_index':1},'PUT');save()
 code,activated=sk('/plugins/signalk-wakelogger/course/activate',{});assert code==200
 R['explicitActivation']=activated;save()
 for _ in range(20):
  code,course=sk('/plugins/signalk-wakelogger/course')
  if course.get('desired') and course['desired'].get('racePlanId')==plan['id'] and course.get('legStart',{}).get('startedAt') is not None:break
  time.sleep(1)
 assert course.get('legStart'), 'no backend activation marker'
 R['marker']=course['legStart'];save()
 # Import exact served modules into a temporary directory, no local rebuild.
 with tempfile.TemporaryDirectory(prefix='the882-served-') as directory:
  import urllib.request
  d=Path(directory)
  for name in ['leg-eta.mjs','course-progress.mjs','instruments.mjs','wind-derivation.mjs']:
   with urllib.request.urlopen(bundle['signalk_url']+'/signalk-wakelogger/'+name,timeout=20) as response:data=response.read()
   assert data==(ROOT/'public'/name).read_bytes()
   (d/name).write_bytes(data)
  evaluate="import fs from 'node:fs';import {raceProgress} from './course-progress.mjs';const q=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(raceProgress(q.course,q.nav,{},null,q.plan,q.now)))"
  for age in [0,20,61,76]:
   deadline=R['marker']['startedAt']/1000+age
   while time.time()<deadline:time.sleep(min(1,deadline-time.time()))
   code,course=sk('/plugins/signalk-wakelogger/course');assert code==200
   code,nav=sk('/signalk/v1/api/vessels/self/navigation');assert code==200
   code,race=sk('/plugins/signalk-wakelogger/race-plan');assert code==200
   now=int(time.time()*1000)
   result=json.loads(subprocess.check_output([NODE,'--input-type=module','-e',evaluate],cwd=d,input=json.dumps({'course':course,'nav':nav,'plan':race,'now':now}),text=True))
   assert course['legStart']==R['marker'],'unchanged-leg marker changed'
   observation={'ageSeconds':(now-R['marker']['startedAt'])/1000,'course':course,'navigation':nav,'racePlan':race,'result':result};R['observations'].append(observation);save()
   if age>=61:
    assert result['eta'] and result['vmgKn']>0 and not result['etaProvisional'], result.get('etaReason')
    assert nav['speedOverGround']['value']==0
    assert abs(result['timeToGo']-result['distanceNm']/result['vmgKn']*3600)<1e-6
  assert R['observations'][-1]['result']['vmgKn']!=R['observations'][-2]['result']['vmgKn']
 assert p.wait(timeout=20)==0
finally:
 if p and p.poll() is None:p.terminate();p.wait(timeout=10)
 R['finalOff']=mode('local_only');save()
print('PASS real native WS + backend unchanged-leg marker + served ETA module continuous leg average despite instantaneous SOG0')
