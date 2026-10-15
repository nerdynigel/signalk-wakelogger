"""Run inside the proved isolated scope-a API only. Synthetic THE-882 fixture.
No schema/config changes. Explicit setup/rollback; do not run on production.
"""
import datetime as dt, json, math, os, pathlib, sys, threading, time
from sqlalchemy import select, delete
from app.core.database import SessionLocal
from app.models import Voyage, RacePlan, RaceRoute, Vessel, SignalKDevice, VoyageEnvironmentSnapshot, TideDailyCacheEntry
from app.services import signalk_race_packs as packs, signalk_mqtt as transport
from app.routers.race_plans import _route_midpoint
from app.services.tide_daily import _cache_stmt
TAG='THE882.synthetic.fixture.20261015'
STATE=pathlib.Path('/scopea-backups/the882-fixture-20261015.json')
DEVICE='7b0fddba-1a98-4872-b3ef-1b1df87e6ddb'
mode=sys.argv[1]
assert mode in ['setup','rollback']
now=dt.datetime.now(dt.UTC)
iso=lambda t:t.isoformat()
with SessionLocal() as db:
 v=db.get(Voyage,4);plan=db.get(RacePlan,25);device=db.get(SignalKDevice,DEVICE)
 assert v.vessel_id==plan.vessel_id==device.vessel_id==4 and plan.owner_user_id==2
 route=db.get(RaceRoute,plan.race_route_id)
 # Use the generator's own ordered inputs, digest and framing.
 inputs=packs._load_plan_inputs(db,plan)
 print('INPUT_TYPES', [type(x).__name__ for x in inputs],file=sys.stderr) if False else None
 vessel,route,points,sails=inputs
 assert len(points)==2 and plan.race_route_id==4
 lat,lon=_route_midpoint(points)
 if mode=='setup':
  if STATE.exists():
   prior=json.loads(STATE.read_text());assert prior['rolledBack'], 'existing active fixture: reconcile first'
   revision=prior['revision']+2
  else:
   revision=1
  assert not list(db.scalars(select(VoyageEnvironmentSnapshot).where(VoyageEnvironmentSnapshot.voyage_id==4))), 'preserve existing rows'
  start=v.start_time;end=v.end_time
  events=[{'kind':'low','observed_at':iso(start-dt.timedelta(hours=3)),'height_m':0.2,'source':TAG},
          {'kind':'high','observed_at':iso(start+(end-start)/2),'height_m':1.8,'source':TAG},
          {'kind':'low','observed_at':iso(end+dt.timedelta(hours=3)),'height_m':0.2,'source':TAG}]
  summary={'tide_start_height_m':1.1,'tide_end_height_m':1.2,'tide_min_m':1.1,'tide_max_m':1.8,'tide_events':events}
  snap=VoyageEnvironmentSnapshot(voyage_id=4,provider_name=TAG,provider_endpoint='synthetic://THE882',latitude=lat,longitude=lon,observed_at=start,sampling_start_at=start,sampling_end_at=end,tide_height_m=1.1,tide_state='rising',summary_json=summary,provenance_json={'synthetic':True,'fixture':TAG},notes='Isolated synthetic acceptance fixture, not provider observations')
  db.add(snap);db.flush()
  day=plan.planned_start_time.date();timezone='UTC'
  assert db.execute(_cache_stmt(latitude=lat,longitude=lon,local_date_value=day,timezone_name=timezone,datum='LAT')).scalar_one_or_none() is None, 'cache key occupied: preserve'
  midnight=dt.datetime.combine(day,dt.time(),dt.UTC)
  raw={'timezone':'UTC','heights':[{'date':iso(midnight+dt.timedelta(minutes=30*i)),'height':round(1+0.8*math.cos(i*math.pi/12),4)} for i in range(49)],'extremes':[{'date':iso(midnight+dt.timedelta(hours=i)),'height':1.8 if i%12==0 else 0.2,'type':'High' if i%12==0 else 'Low'} for i in [0,6,12,18]],'provenance':{'provider':TAG,'source_type':'model','station':None,'atlas':'THE882 synthetic','requested_datum':'LAT','response_datum':'LAT','provider_timezone':'UTC'}}
  cache=TideDailyCacheEntry(provider_name='worldtides',provider_endpoint='synthetic://THE882',latitude=round(lat,6),longitude=round(lon,6),local_date=day,timezone_name=timezone,datum='LAT',payload_json=raw)
  db.add(cache);db.flush()
  state={'revision':revision,'snapshotId':snap.id,'cacheId':cache.id,'rolledBack':False,'planBefore':plan.calculation_snapshot_json}
  STATE.write_text(json.dumps(state,default=str));os.chmod(STATE,0o600)
  db.commit()
  times=[now+dt.timedelta(hours=i) for i in range(-1,13)]
  forecast={'coverage':{'from':iso(times[0]),'until':iso(times[-1])},'legs':[{'sequence':1,'samples':[{'time':iso(t),'twd_deg':0,'tws_knots':12,'current_velocity_kn':0,'current_direction_deg':0} for t in times]}]}
  pack=packs.build_race_pack_document(plan=plan,vessel=vessel,route=route,route_points=points,sails=sails,polar_summary=None,forecast=forecast,revision=revision,pack_id=TAG,generated_at=now)
  assert pack['courseDefinitionDigest']=='2342f0a86d7362a72d32c5d90e6ba78a54c97a1607dd90f5b5fe6519477a59b0'
  manifest,chunks=packs.build_transport({'pack':pack})
 else:
  state=json.loads(STATE.read_text());assert not state['rolledBack']
  revision=state['revision']+1
  snap=db.get(VoyageEnvironmentSnapshot,state['snapshotId']);cache=db.get(TideDailyCacheEntry,state['cacheId'])
  assert snap.provider_name==TAG and cache.provider_endpoint=='synthetic://THE882'
  db.delete(snap);db.delete(cache);db.commit()
  manifest={'v':1,'action':'clear','revision':revision,'generatedAt':iso(now),'reason':'THE882 fixture rollback'};chunks=[]
 mqtt=transport._mqtt_module();client=mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,client_id='THE882-fixture-'+str(revision),protocol=mqtt.MQTTv5)
 transport._configure_client(client,worker=True)
 connected=threading.Event();acknowledged=threading.Event();acks=[]
 base='wakelogger/v1/devices/'+DEVICE
 def connect(c,u,f,reason,props):
  if not transport._reason_code_failed(reason):c.subscribe(base+'/race-pack-ack',qos=1);connected.set()
 def message(c,u,m):
  a=json.loads(m.payload)
  if a.get('revision')==revision:acks.append(a);acknowledged.set()
 client.on_connect=connect;client.on_message=message
 try:
  client.connect(transport.settings.mqtt_broker_host,transport.settings.mqtt_broker_port,keepalive=20);client.loop_start();assert connected.wait(10),'MQTT connect failed'
  time.sleep(.3)
  for chunk in chunks:
   info=client.publish(base+'/race-pack/chunk/'+str(chunk['index']),json.dumps(chunk),qos=1,retain=True);info.wait_for_publish(10);assert info.rc==0
  info=client.publish(base+'/race-pack/manifest',json.dumps(manifest),qos=1,retain=True);info.wait_for_publish(10);assert info.rc==0
  # OFF deliberately disconnects the plugin transport. Publication is staged only.
  if acknowledged.wait(2):assert acks[-1]['status']=='applied',acks
  if mode=='rollback':
   info=client.publish(base+'/race-pack/chunk/0','',qos=1,retain=True);info.wait_for_publish(10)
   state['rolledBack']=True;STATE.write_text(json.dumps(state,default=str))
 finally:client.disconnect();client.loop_stop()
 print(json.dumps({'mode':mode,'manifest':manifest,'acks':acks,'snapshotId':state['snapshotId'],'cacheId':state['cacheId'],'synthetic':True,'receivedByPlugin':bool(acks)}))
