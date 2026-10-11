import { test } from 'node:test'
import assert from 'node:assert/strict'
import { raceProgress } from '../../webapp/course-progress.mjs'
const now = Date.parse('2026-10-11T12:00:00Z')
const point = (latitude, longitude) => ({ latitude, longitude })
const entry = (value, age = 0) => ({ value, timestamp: new Date(now - age * 1000).toISOString() })
const status = { desired: { action: 'activate', start: point(0, 0), finish: point(0, 1/60) }, native: { activeMatchesDesired: false } }
const nav = (kn = 5, deg = 90) => ({ position: entry(point(0, 0)), speedOverGround: entry(kn / 1.9438444924406), courseOverGroundTrue: entry(deg * Math.PI / 180) })
const run = (navigation, calculated = {}, native = false, time = now, desired = status.desired) => raceProgress({ desired, native: { activeMatchesDesired: native, course: { activeRoute: { pointIndex: 1 } } } }, navigation, calculated, null, null, time)
for (const [label, kn, deg] of [['stationary',0,90],['drift',.01,90],['mid-tack',5,.001],['away',5,270],['epsilon',1e-310,90],['negative',-5,90],['speed boundary',.1,90]]) {
  test(`${label} has no live ETA and keeps navigation`, () => {
    const result = run(nav(kn,deg)); assert.equal(result.eta, null); assert.equal(result.timeToGo,null); assert.ok(result.distanceNm > 0); assert.ok(result.etaReason)
  })
}
test('normal speed uses injected clock and recovers after tack and stale sensors', () => {
  const result = run(nav()); assert.ok(Math.abs(result.timeToGo - 720.4854858) < .01)
  assert.equal(Date.parse(result.eta), now + Math.trunc(result.timeToGo * 1000))
  const stale = nav(); stale.speedOverGround = entry(5,31); assert.equal(run(stale).eta,null)
  assert.equal(run(nav()).eta,result.eta)
  const next = Object.fromEntries(Object.entries(nav()).map(([key, e]) => [key, { ...e, timestamp: new Date(now+86400000).toISOString() }]))
  assert.equal(Date.parse(run(next, {}, false, now+86400000).eta), Date.parse(result.eta)+86400000)
})
for (const key of ['position','speedOverGround','courseOverGroundTrue']) {
  for (const [label,timestamp] of [['missing',undefined],['invalid','broken'],['stale',new Date(now-30001).toISOString()],['future',new Date(now+5001).toISOString()]]) {
    test(`${key} ${label} timestamp rejects ETA`, () => { const n=nav(); n[key]={ ...n[key],timestamp }; assert.equal(run(n).eta,null) })
  }
}
test('freshness and skew boundaries are inclusive', () => {
  const n=nav(); for (const e of Object.values(n)) e.timestamp=new Date(now-30000).toISOString(); assert.ok(run(n).eta)
  n.speedOverGround.timestamp=new Date(now-20000).toISOString(); assert.ok(run(n).eta)
  n.speedOverGround.timestamp=new Date(now-19999).toISOString(); assert.equal(run(n).eta,null)
  for (const e of Object.values(n)) e.timestamp=new Date(now+5000).toISOString(); assert.ok(run(n).eta)
})
const calc = (seconds = 3600, distance = 1852, vmg = 1852 / 3600) => ({ distance: entry(distance), bearingTrue: entry(Math.PI/2), velocityMadeGood: entry(vmg), timeToGo: entry(seconds), estimatedTimeOfArrival: entry(new Date(now+seconds*1000).toISOString()) })
test('native coherent ETA passes and does not recompute native values', () => { const c=calc();const r=run(nav(),c,true);assert.equal(r.timeToGo,3600);assert.equal(r.eta,c.estimatedTimeOfArrival.value) })
for (const key of ['distance','bearingTrue','velocityMadeGood','timeToGo','estimatedTimeOfArrival']) {
  test(`native ${key} requires timestamp`, () => { const c=calc(); delete c[key].timestamp;assert.equal(run(nav(),c,true).eta,null) })
}
test('native speed, sign, consistency, and horizon boundaries', () => {
  assert.ok(run(nav(),calc(86400,1852*24),true).eta)
  assert.equal(run(nav(),calc(86401,1852*24),true).eta,null)
  for (const [key,value] of [['velocityMadeGood',-1],['timeToGo',-1],['distance',-1],['timeToGo',NaN],['estimatedTimeOfArrival','broken'],['estimatedTimeOfArrival','2026-10-10T12:00:00Z']]) { const c=calc();c[key].value=value;assert.equal(run(nav(),c,true).eta,null) }
  const c=calc();c.timeToGo.value+=36;c.estimatedTimeOfArrival.value=new Date(now+c.timeToGo.value*1000).toISOString();assert.ok(run(nav(),c,true).eta)
  c.timeToGo.value+=.001;assert.equal(run(nav(),c,true).eta,null)
  const e=calc();e.estimatedTimeOfArrival.value=new Date(now+3635*1000).toISOString();assert.ok(run(nav(),e,true).eta)
  e.estimatedTimeOfArrival.value=new Date(now+3635*1000+1).toISOString();assert.equal(run(nav(),e,true).eta,null)
})
test('cached 24h boundary and overflow never throw', () => {
  const desired={ ...status.desired, finish:point(0,10/60) };const distance=run(nav(),{},false,now,desired).distanceNm;assert.ok(run(nav(distance/24),{},false,now,desired).eta);assert.equal(run(nav(distance/24-.000001),{},false,now,desired).eta,null)
  assert.doesNotThrow(()=>run(nav(1e-310)));assert.equal(run(nav(),{},false,Number.MAX_VALUE).eta,null)
})

test('native invalid motion values, impossible closing speed and epoch units reject ETA', () => {
  for (const key of ['speedOverGround','courseOverGroundTrue']) for (const val of [null,NaN,Infinity]) {
    const n=nav();n[key].value=val;assert.equal(run(n,calc(),true).eta,null)
  }
  assert.equal(run(nav(0),calc(),true).eta,null)
  const c=calc();c.estimatedTimeOfArrival.value=Math.floor((now+3600000)/1000);assert.equal(run(nav(),c,true).eta,null)
  for (const key of Object.keys(calc())) for (const timestamp of ['broken',new Date(now-30001).toISOString(),new Date(now+5001).toISOString()]) {const c=calc();c[key].timestamp=timestamp;assert.equal(run(nav(),c,true).eta,null)}
})
