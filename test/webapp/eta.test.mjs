import { test } from 'node:test'
import assert from 'node:assert/strict'
import { raceProgress } from '../../webapp/course-progress.mjs'
import { legAverageEta, alongLegMeters } from '../../webapp/leg-eta.mjs'
const start = Date.parse('2026-10-11T12:00:00Z')
const point = (latitude, longitude) => ({ latitude, longitude })
const origin = point(0,0), target = point(0,.1)
const desired = { action:'activate', courseId:'race', revision:1, updatedAt:new Date(start).toISOString(), start:origin, finish:target }
const identity = native => JSON.stringify(['race',1,desired.updatedAt,1,native ? '/route' : 'cached',false,[origin,target]])
const marker = { identity:identity(false), observedAt:start, startedAt:start, position:origin, positionTimestamp:start }
const stamp = (value,time) => ({value,timestamp:new Date(time).toISOString()})
function run({elapsed=3600000, position=point(0,.02), native=false, sog=0, cog=0, plan=null, change=()=>{}}={}) {
  const now=start+elapsed
  const status={desired,legStart:{...marker,identity:identity(native)},native:{activeMatchesDesired:native,course:{activeRoute:{pointIndex:1,href:'/route'}}}}
  const navigation={position:stamp(position,now),speedOverGround:stamp(sog,now),courseOverGroundTrue:stamp(cog,now)}
  const calculated={distance:stamp(1852,now),bearingTrue:stamp(Math.PI/2,now),velocityMadeGood:stamp(100,now),timeToGo:stamp(1,now),estimatedTimeOfArrival:stamp('invalid',now)}
  change({status,navigation,calculated,now})
  return raceProgress(status,navigation,calculated,null,plan,now)
}
const fallback = elapsed => ({pack:{applicable:true,courseId:'race',revision:1},latestSnapshot:{generatedAt:start+elapsed,packRevision:1,tracking:{courseId:'race',activeIndex:1,reverse:false},plan:{legs:[{estimatedSogKnots:5}]}}})
test('ETA uses net leg average despite stationary/mid-tack/away instantaneous motion and wrong native ETA',()=>{
  for (const native of [false,true]) for (const [sog,cog] of [[0,0],[.00001,0],[5,Math.PI],[5,Math.PI/2]]) {
    const r=run({native,sog,cog});assert.ok(Math.abs(r.vmgKn-1.200809)<.00001)
    assert.ok(Math.abs(r.timeToGo-r.distanceNm/r.vmgKn*3600)<1e-6)
    assert.ok(r.eta);assert.equal(r.etaProvisional,false)
  }
})
test('stationary, drifting, negative net progress and near-zero averages are suppressed',()=>{
  for(const position of [origin,point(0,-.02),point(0,1e-15),point(0,.00001)]) {const r=run({position});assert.equal(r.eta,null);assert.ok(r.etaReason)}
})
test('lateral movement never counts as progress and fresh position keeps updating ETA',()=>{
  assert.ok(Math.abs(alongLegMeters(origin,target,point(.02,.02))-alongLegMeters(origin,target,point(0,.02)))<1e-6)
  assert.ok(run({position:point(0,.04)}).vmgKn>run().vmgKn)
  assert.equal(run({position:point(.02,0)}).eta,null)
})
test('early window below/at/above 60s uses bounded provisional plan then average',()=>{
  const early=run({elapsed:59999,plan:fallback(59999),position:point(0,.001)})
  assert.equal(early.vmgKn,5);assert.equal(early.etaProvisional,true);assert.match(early.etaReason,/Provisional/)
  for(const elapsed of [60000,60001]) {const r=run({elapsed,plan:fallback(elapsed),position:point(0,.001)});assert.equal(r.etaProvisional,false);assert.ok(r.eta);assert.notEqual(r.vmgKn,5)}
  assert.equal(run({elapsed:59999}).eta,null)
  for(const speed of [null,0,.49,30.01,NaN,Infinity]) {const plan=fallback(1);plan.latestSnapshot.plan.legs[0].estimatedSogKnots=speed;assert.equal(run({elapsed:1,plan}).eta,null)}
})
test('fallback provenance rejects wrong course, revision, leg, reverse and expired snapshot',()=>{
  for(const mutate of [p=>p.pack.applicable=false,p=>p.pack.courseId='other',p=>p.latestSnapshot.tracking.activeIndex=2,p=>p.latestSnapshot.tracking.reverse=true,p=>p.latestSnapshot.packRevision=2,p=>p.latestSnapshot.generatedAt=start-1200001]) {
    const plan=fallback(1000);mutate(plan);assert.equal(run({elapsed:1000,plan}).eta,null)
  }
})
for(const native of [false,true]) for(const key of ['position','speedOverGround','courseOverGroundTrue',...(native ? ['distance','bearingTrue']:[])]) {
  test(`${native?'native':'cached'} ${key} freshness and recovery`,()=>{
    for(const timestamp of [undefined,'broken',new Date(start+3600000-30001).toISOString(),new Date(start+3600000+5001).toISOString()]) {
      assert.equal(run({native,change:({navigation,calculated})=>{(navigation[key]||calculated[key]).timestamp=timestamp}}).eta,null)
    }
    assert.ok(run({native}).eta)
  })
}
test('sensor skew boundary and future boundary remain inclusive',()=>{
  assert.ok(run({change:({navigation,now})=>navigation.speedOverGround.timestamp=new Date(now-10000).toISOString()}).eta)
  assert.equal(run({change:({navigation,now})=>navigation.speedOverGround.timestamp=new Date(now-10001).toISOString()}).eta,null)
  assert.ok(run({change:({navigation,now})=>{for(const entry of Object.values(navigation)) entry.timestamp=new Date(now+5000).toISOString()}}).eta)
})
test('missing/replaced marker, invalid motion and new leg suppress until new provenance arrives',()=>{
  for(const change of [({status})=>status.legStart=null,({status})=>status.legStart.identity='old',({status})=>status.desired={...desired,revision:2},({status})=>status.native={activeMatchesDesired:true,course:{activeRoute:{pointIndex:0,href:'/route'}}},({navigation})=>navigation.speedOverGround.value=-1,({navigation})=>navigation.position.value=point(91,0)]) assert.equal(run({change}).eta,null)
})
test('24h duration boundary, date overflow and degenerate geometry',()=>{
  const speed=alongLegMeters(origin,target,point(0,.02))/1852
  const args={marker,origin,target,position:point(0,.02),positionTime:start+3600000,now:start+3600000,distanceNm:speed*24}
  assert.ok(legAverageEta(args).eta)
  assert.equal(legAverageEta({...args,distanceNm:speed*24+.000001}).eta,null)
  assert.equal(legAverageEta({...args,now:Number.MAX_VALUE}).eta,null)
  assert.equal(legAverageEta({...args,target:origin}).eta,null)
})
test('activation without a position permits only the early plan and never rebases midway',()=>{
  const change=({status})=>{status.legStart.position=null;status.legStart.positionTimestamp=null}
  assert.ok(run({elapsed:1000,plan:fallback(1000),change}).eta)
  assert.equal(run({elapsed:60000,plan:fallback(60000),change}).eta,null)
  assert.equal(run({change:({status})=>status.legStart.startedAt=null}).eta,null)
  assert.equal(run({change:({status})=>status.legStart.positionTimestamp=start-30001}).eta,null)
})
