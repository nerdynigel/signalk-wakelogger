// Disposable Signal K REST -> both calculators. The bundled N2K stream has
// historical timestamps, so positive cases use its source clock; wall-clock
// rejection is tested separately. This is replay evidence, not owner telemetry.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { instrumentReadings } from '../webapp/instruments.mjs'
import { vesselGuideBearings, projectBearing } from '../webapp/vessel-guides.mjs'
import { waypointLaylines } from '../webapp/waypoint-laylines.mjs'

const webRoot = process.argv[2]
assert.ok(webRoot, 'Usage: node scripts/test-waypoint-laylines-native.mjs /path/to/wakelogger')
const { waypointLaylines: webLaylines } = await import(pathToFileURL(resolve(webRoot, 'frontend/app/lib/waypointLaylines.mjs')))
const source = readFileSync(resolve(webRoot, 'frontend/app/lib/liveCourseGuides.js'), 'utf8')
const { liveCourseGuides } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const root = fileURLToPath(new URL('..', import.meta.url))
const project = `waypoint-native-${process.pid}`
function compose(args) {
  const r = spawnSync('docker', ['compose','-p',project,'-f','test/docker/compose.yml',...args], {cwd:root,encoding:'utf8',maxBuffer:8*1024*1024})
  if(r.status !== 0) throw new Error(r.stderr || r.stdout || `docker status ${r.status}`)
  return r.stdout
}
function query(path) {
  return JSON.parse(compose(['exec','-T','test-cloud','node','/app/query.mjs',`http://signalk:3000${path}`]))
}
try {
  compose(['up','-d','--build'])
  let sample
  const deadline=Date.now()+300000
  while(Date.now()<deadline) {
    try {
      const navigation=query('/signalk/v1/api/vessels/self/navigation')
      const environment=query('/signalk/v1/api/vessels/self/environment')
      const entries=[navigation.position,navigation.headingTrue,navigation.speedOverGround,navigation.courseOverGroundTrue,environment.wind?.speedApparent,environment.wind?.angleApparent]
      const now=Math.max(...entries.map(e=>Date.parse(e?.timestamp)))
      const view=instrumentReadings({navigation,environment,now})
      const guides=vesselGuideBearings(view.readings,null,view.guideWind)
      if(guides.maneuverBearing !== null) { sample={navigation,environment,now,view,guides}; break }
    } catch { /* Services and the replay warm up independently. */ }
    await new Promise(r=>setTimeout(r,1000))
  }
  assert.ok(sample,'fresh-together native replay guide inputs required')
  const {navigation,environment,now,view,guides}=sample
  const reading=id=>view.readings.find(r=>r.id===id)?.value
  const state={lat:guides.position.latitude,lon:guides.position.longitude,capturedAt:new Date(now).toISOString(),headingDeg:guides.heading,headingReference:'true',
    awaDeg:reading('awa'),awsKn:reading('aws'),sogKn:reading('sog'),cogDeg:reading('cog')}
  if(view.guideWind?.speed?.source==='direct' && view.guideWind.speed.basis==='ground' && view.guideWind.direction?.source==='direct') {
    state.twsKn=view.guideWind.speed.value;state.twdDeg=view.guideWind.direction.value
  }
  const webGuides=liveCourseGuides(state,{nowMs:now})
  assert.equal(webGuides.kind,guides.kind)
  assert.ok(Math.abs(webGuides.oppositeCourseDeg-guides.maneuverBearing)<1e-6)
  const target=projectBearing(guides.position,guides.trueWindFrom+(guides.kind==='gybe'?180:0),2000)
  const input={position:guides.position,target,headingDeg:guides.heading,oppositeCourseDeg:guides.maneuverBearing,currentTack:guides.currentTack,kind:guides.kind,trueWindFromDeg:guides.trueWindFrom}
  const onboard=waypointLaylines(input),web=webLaylines({...input,...webGuides})
  assert.equal(onboard.status,'ready')
  assert.equal(web.status,'ready')
  assert.ok(Math.abs(onboard.distanceM-web.distanceM)<0.01)
  assert.ok(Math.abs(onboard.maneuverPoint.latitude-web.maneuverPoint.latitude)<1e-7)
  assert.ok(Math.abs(onboard.maneuverPoint.longitude-web.maneuverPoint.longitude)<1e-7)
  const unavailable=(navigation,now)=>vesselGuideBearings(instrumentReadings({navigation,environment,now}).readings)
  assert.equal(unavailable({...navigation,headingTrue:undefined},now).heading,null)
  assert.equal(unavailable(navigation,Date.now()).heading,null)
  assert.equal(liveCourseGuides({...state,headingReference:'magnetic'},{nowMs:now}).headingDeg,null)
  assert.equal(liveCourseGuides(state,{nowMs:Date.now()}).headingDeg,null)
  const packaged=compose(['exec','-T','test-cloud','node','/app/query.mjs','http://signalk:3000/signalk-wakelogger/waypoint-laylines.mjs'])
  assert.equal(packaged.trim(),readFileSync(new URL('../webapp/waypoint-laylines.mjs',import.meta.url),'utf8').trim())
  console.log(JSON.stringify({clock:'native N2K replay source time',sourceTime:new Date(now).toISOString(),target,onboard,web,distanceToleranceM:0.01,negativeAndRecovery:true,packagedModuleMatches:true},null,2))
} finally {
  compose(['down','--volumes','--remove-orphans'])
}
