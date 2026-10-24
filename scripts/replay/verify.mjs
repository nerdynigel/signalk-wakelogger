// Compare the actual cloud recording with the unchanged recorded sensor values
// emitted into Signal K. This verifies the full transport/normalization path.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import crypto from 'node:crypto';

const data=process.env.WAKELOGGER_REPLAY_DATA || path.join(os.homedir(),'.local/share/wakelogger-replay/trip-48');
const cfg=JSON.parse(fs.readFileSync(path.join(data,'deployment.json')));
const token=fs.readFileSync(path.join(data,'owner-token'),'utf8').trim();
const auth={authorization:`Bearer ${token}`};
const base=`http://127.0.0.1:8010/v1/vessels/${cfg.vesselId}/telemetry`;
async function get(suffix) {
  const r=await fetch(base+'/'+suffix,{headers:auth,signal:AbortSignal.timeout(15000)});
  assert.ok(r.ok,`Read ${suffix}: HTTP ${r.status}`);return r.json();
}
const trail=await get('trail'),overview=await get('overview');
assert.ok(trail.voyage_id,'Normal movement qualification must materialize a voyage');
assert.ok(trail.points.length>=60,'A meaningful recorded sailing section is required');
const log=path.join(cfg.runDir,'signalk/plugin-config-data/wakelogger-real-trip-replay/replay-emissions.ndjson');
const emissions=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
// The receive-only harness uses the file outbox. Read its checksummed frames
// without opening/repairing the store, so measured fields and heading reference
// can be distinguished from later forecast filling of missing trip fields.
const outbox=path.join(cfg.runDir,'signalk/plugin-config-data/signalk-wakelogger/outbox');
const directory=fs.readdirSync(outbox,{withFileTypes:true}).find(x=>x.isDirectory());
assert.ok(directory,'A replay file outbox is required for raw evidence');
const raw=[];
for(const name of fs.readdirSync(path.join(outbox,directory.name)).filter(x=>/^segment-.*\.log$/.test(x)).sort()) {
 const bytes=fs.readFileSync(path.join(outbox,directory.name,name));let offset=0;
 while(offset+36<=bytes.length){const size=bytes.readUInt32BE(offset),end=offset+4+size;
  assert.ok(size>0&&end+32<=bytes.length,'Complete outbox frame required');
  const payload=bytes.subarray(offset+4,end);
  assert.ok(crypto.createHash('sha256').update(payload).digest().equals(bytes.subarray(end,end+32)),'Outbox checksum');
  raw.push(JSON.parse(payload));offset=end+32;
 }
 assert.equal(offset,bytes.length);
}
const sourceSamples=raw.filter(x=>x.trackingSessionId===trail.tracking_session_id).sort((a,b)=>a.sequence-b.sequence);
assert.equal(sourceSamples.length,trail.points.length,'Full raw recording and non-decimated cloud trail required');
const failures=[],maxError={},checked={},maxSensorSkewMs={},unmeasuredEnriched={};
const angle=(a,b)=>Math.abs(((a-b+540)%360)-180);
const fields=[
  ['latitude','navigation.position',v=>v.latitude,0.0000001],
  ['longitude','navigation.position',v=>v.longitude,0.0000001],
  ['heading_deg','navigation.headingTrue',v=>v*180/Math.PI,0.0001],
  ['cog_deg','navigation.courseOverGroundTrue',v=>v*180/Math.PI,0.0001],
  ['sog_kn','navigation.speedOverGround',v=>v*1.9438444924406,0.00001],
  ['aws_kn','environment.wind.speedApparent',v=>v*1.9438444924406,0.00001],
  ['awa_deg','environment.wind.angleApparent',v=>v*180/Math.PI,0.0001],
];
const series=new Map([...fields.map(([field])=>[field,[]]),['heading_magnetic',[]]]);
for(const event of emissions) for(const value of event.values) {
  if(value.path==='navigation.headingMagnetic'&&Number.isFinite(value.value))series.get('heading_magnetic').push({at:Date.parse(event.wallTimestamp),value:value.value*180/Math.PI});
  for(const [field,key,convert] of fields) if(value.path===key && value.value!=null) {
    const number=convert(value.value);if(Number.isFinite(number))series.get(field).push({at:Date.parse(event.wallTimestamp),value:number});
  }
}
// Packet captured_at is the position clock, not an independent timestamp for
// each wind/heading reading. Match an exact original observation within 1.5s
// of that clock instead of falsely requiring all sensors to sample together.
function candidates(values,at) {
  let low=0,high=values.length;
  while(low<high){const mid=(low+high)>>1;if(values[mid].at<at-1500)low=mid+1;else high=mid;}
  const selected=[];
  for(let i=low;i<values.length && values[i].at<=at+1500;i++)selected.push(values[i]);
  return selected;
}
for(const [index,point] of trail.points.entries()) {
  const sample=sourceSamples[index],at=Date.parse(point.point_time);
  assert.equal(at,sample.capturedAt,'Cloud point order/capture clock must match raw recording');
  for(const [field,,,tolerance] of fields) {
    const rawField=field==='latitude'?'lat':field==='longitude'?'lon':field;
    if(sample.values[rawField]==null){if(point[field]!=null)unmeasuredEnriched[field]=(unmeasuredEnriched[field]||0)+1;continue;}
    assert.ok(Number.isFinite(point[field]),'A measured raw field must survive reconstruction');
    const actual=point[field],distance=value=>field.endsWith('_deg')?angle(actual,value):Math.abs(actual-value);
    const stream=field==='heading_deg'&&sample.values.heading_reference==='magnetic'?'heading_magnetic':field;
    const rawError=field.endsWith('_deg')?angle(actual,sample.values[rawField]):Math.abs(actual-sample.values[rawField]);
    if(rawError>tolerance)failures.push({at:point.point_time,field,rawRecorded:sample.values[rawField],actual,error:rawError,reason:'Measured raw field changed'});
    const nearby=candidates(series.get(stream),at).sort((a,b)=>distance(a.value)-distance(b.value) || Math.abs(a.at-at)-Math.abs(b.at-at));
    assert.ok(nearby.length,`No original ${field} observation near ${point.point_time}`);
    const expected=nearby[0].value,error=distance(expected);
    maxError[field]=Math.max(maxError[field] || 0,error);checked[field]=(checked[field] || 0)+1;
    maxSensorSkewMs[field]=Math.max(maxSensorSkewMs[field] || 0,Math.abs(nearby[0].at-at));
    if(error>tolerance)failures.push({at:point.point_time,field,expected,actual,error,tolerance});
  }
}
for(const [field] of fields) assert.ok(checked[field]>=30,`Insufficient recorded ${field} comparisons`);
const result={result:failures.length?'failed':'passed',observedAt:new Date().toISOString(),voyageId:trail.voyage_id,
  trackingSessionId:trail.tracking_session_id,points:trail.points.length,emittedPackets:emissions.length,
  compared:checked,unmeasuredFieldsEnrichedByExistingTripPipeline:unmeasuredEnriched,maxError,maxSensorSkewMs,sensorMatchWindowMs:1500,failures:failures.slice(0,30),failureCount:failures.length,
  firstRecordedTime:trail.points[0].point_time,lastRecordedTime:trail.points.at(-1).point_time,
  activeWaypoint:overview.race_navigation?.active_waypoint?.name};
fs.writeFileSync(path.join(cfg.runDir,'source-cloud-comparison.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
assert.equal(failures.length,0,'Cloud recording must agree with original emitted sensor data');
