import assert from 'node:assert/strict'
import { legAverageEta } from '../../webapp/leg-eta.mjs'
import { raceProgress } from '../../webapp/course-progress.mjs'
const t=Date.parse('2026-10-11T12:00:00Z'), R=6371000
const p=metres=>({latitude:0,longitude:metres/R*180/Math.PI})
const marker={startedAt:t,observedAt:t,position:p(0),positionTimestamp:t}
const estimate=(elapsed,metres,extra={})=>legAverageEta({marker,origin:p(0),target:p(18520),position:p(metres),positionTime:t+elapsed,now:t+elapsed,distanceNm:1,...extra})
// Endpoint progress / total activation time; intermediate samples have unequal intervals.
for(const [seconds,metres] of [[60,100],[75,90],[240,400],[600,1000]]) {
 const r=estimate(seconds*1000,metres)
 assert.ok(Math.abs(r.vmgKn-metres/1852/(seconds/3600))<1e-10)
 assert.ok(Math.abs(r.timeToGo-1852/metres*seconds)<1e-7)
}
assert.ok(Math.abs(estimate(600000,1000,{marker:{...marker,position:p(500)}}).vmgKn-estimate(600000,500).vmgKn)<1e-12)
for(const [seconds,speed] of [[3600,30],[3600,30.0001]]) {
 const r=estimate(seconds*1000,speed*1852)
 if(speed===30) { console.log('30kn boundary result',JSON.stringify(r)); assert.ok(Math.abs(r.vmgKn-30)<1e-12) } else assert.equal(r.eta,null)
}
assert.ok(estimate(60000,100,{marker:{...marker,positionTimestamp:t-30000}}).eta)
assert.equal(estimate(60000,100,{marker:{...marker,positionTimestamp:t-30001}}).eta,null)
for(const speed of [.5,30]) assert.ok(estimate(59999,0,{fallbackKn:speed}).eta)
assert.equal(estimate(60000,0,{fallbackKn:30}).eta,null)
const origin=p(0),target=p(18520),desired={action:'activate',courseId:'qa',revision:1,updatedAt:new Date(t).toISOString(),start:origin,finish:target}
const now=t+600000,stamp=(value,at=now)=>({value,timestamp:new Date(at).toISOString()})
const status={desired,legStart:{...marker,identity:JSON.stringify(['qa',1,desired.updatedAt,1,'cached',false,[origin,target]])},native:{activeMatchesDesired:false}}
const nav={position:stamp(p(1000)),speedOverGround:stamp(0),courseOverGroundTrue:stamp(Math.PI)}
for(const [age,expected] of [[30000,true],[30001,false]]) {
 const n=Object.fromEntries(Object.entries(nav).map(([k,v])=>[k,stamp(v.value,now-age)]))
 assert.equal(!!raceProgress(status,n,{},null,null,now).eta,expected)
}
assert.ok(raceProgress(status,nav,{},null,null,now).eta)
const changed={feature:{geometry:{type:'LineString',coordinates:[[0,0],[1,0]]}}}
const nativeStatus={...status,native:{activeMatchesDesired:true,course:{activeRoute:{href:'/qa',pointIndex:1}}},legStart:{...marker,identity:JSON.stringify(['qa',1,desired.updatedAt,1,'/qa',false,[origin,target]])}}
assert.equal(raceProgress(nativeStatus,nav,{distance:stamp(1852),bearingTrue:stamp(Math.PI/2)},changed,null,now).eta,null)
console.log('PASS independent endpoint/unequal-interval, offset-baseline, above-30kn suppression, baseline-age, fallback, freshness/recovery and geometry assertions')

assert.ok(estimate(3600000,30*1852).eta, 'Exact 30 kn must be inside the stated inclusive sailing range')
