import test from 'node:test'
import assert from 'node:assert/strict'
import { WindFlowModel, windFlowStyle, windFlowGrid, windFlowArrow, windFlowReading } from '../../webapp/wind-flow.mjs'
import { UploadProgress } from '../../webapp/upload-progress.mjs'
import { markLabel, courseSelectionKey } from '../../webapp/mark-picker.mjs'

test('wind flow averages across north and uses source age, not repeat polls', () => {
  const model = new WindFlowModel()
  model.update({ from: 359, speed: 10, at: 1000 }, 1000)
  model.update({ from: 1, speed: 14, at: 2000 }, 2000)
  const mean = model.sample(3000)
  assert.ok(mean.from < .01 || mean.from > 359.99)
  assert.equal(mean.speed, 12)
  model.update({ from: 90, speed: 30, at: 2000 }, 9000)
  assert.equal(model.samples.length, 2)
  assert.equal(model.sample(12001).stale, true)
  assert.equal(model.sample(12001).opacity, .15)
  assert.equal(model.sample(32000), null)
  model.update({ from: 141, speed: 18, at: 40000 }, 40000)
  assert.equal(model.sample(40000).to, 321)
  model.update({ from: NaN, speed: 18, at: 41000 }, 41000)
  model.update({ from: 50, speed: -1, at: 41000 }, 41000)
  assert.equal(model.samples.length, 1)
})
test('wind strength changes style continuously without adding arrows', () => {
  assert.equal(new WindFlowModel().sample(0), null)
  const model = new WindFlowModel(); model.update({from:141,speed:1,at:1000},1000)
  assert.equal(model.sample(1000).calm,true)
  assert.equal(windFlowStyle(8).length,18)
  assert.equal(windFlowStyle(25).drift,36)
  assert.ok(windFlowStyle(7.99).length < windFlowStyle(8.01).length)
  assert.ok(windFlowGrid(1000,848).length >= 25 && windFlowGrid(1000,848).length <= 40)
  assert.equal(windFlowGrid(390,340,true).length,9)
  const cell={id:1,x:200,y:200,spacing:150,phase:0},wind={to:321,...windFlowStyle(8)}
  const a=windFlowArrow(cell,wind,1000),b=windFlowArrow(cell,wind,2000)
  assert.ok(b.x<a.x&&b.y<a.y)
  assert.deepEqual(windFlowArrow(cell,wind,0,true),windFlowArrow(cell,wind,10000,true))
  assert.equal(windFlowArrow(cell,wind,0).opacity,0)
  assert.equal(windFlowArrow(cell,wind,2000).opacity,.45)
})
test('wind flow requires a timestamped coherent true wind; GPS is optional',()=>{
  const view={displayWind:{speed:{available:true,value:12,timestamp:1000},direction:{available:true,value:141,timestamp:1100}}}
  assert.deepEqual(windFlowReading(view,null,1200),{from:141,speed:12,at:1000})
  assert.equal(windFlowReading({displayWind:{...view.displayWind,direction:{available:false}}},null,1200),null)
})
const status = (uploaded, at, options={}) => ({paired:true,recording:true,uploadMode:'automatic',connectionState:'online',queue:{messageCount:1000-uploaded},queueStatsAt:at,historicalUpload:{id:'upload-a',totalSamples:1000,uploadedSamples:uploaded,remainingSamples:1000-uploaded,droppedSamples:0,progressKnown:true},...options})
test('sync progress uses the fixed acknowledged cohort and observed throughput',()=>{
  const progress=new UploadProgress()
  const first=progress.update(status(400,1000),1000)
  assert.equal(first.percent,40);assert.equal(first.etaSeconds,null)
  const next=progress.update(status(680,11000),11000)
  assert.equal(next.percent,68);assert.equal(next.etaSeconds,12)
  assert.match(next.detail,/680 of 1,000 samples uploaded/)
  assert.equal(progress.update(status(680,11000),42000).etaSeconds,null)
  assert.equal(progress.update(status(1000,43000),43000),null)
})
test('sync estimates reset on pause, loss, cohort change and counter regression',()=>{
  const p=new UploadProgress();p.update(status(100,1000),1000);p.update(status(200,11000),11000)
  assert.equal(p.update(status(200,12000,{uploadMode:'local_only'}),12000),null)
  assert.equal(p.update(status(210,13000),13000).etaSeconds,null)
  const lost=status(250,14000);lost.historicalUpload.droppedSamples=4;lost.historicalUpload.progressKnown=false
  assert.equal(p.update(lost,14000).percent,null)
  const excluded=status(500,15000);Object.assign(excluded.historicalUpload,{totalSamples:1200,excludedSamples:200})
  assert.equal(p.update(excluded,15000).percent,50)
  const changed=status(100,16000);changed.historicalUpload.id='upload-b'
  assert.equal(p.update(changed,16000).etaSeconds,null)
  assert.equal(p.update(status(0,17000),17000).etaSeconds,null)
})
test('mark contexts distinguish route revisions, direction and geometry',()=>{
  const p={reverse:false,points:[{id:'a',name:'Start',latitude:0,longitude:1}]},s={desired:{courseId:'race',revision:1},native:{course:{activeRoute:{href:'/routes/a'}}}}
  const key=courseSelectionKey(s,p)
  assert.equal(courseSelectionKey({cachedCourse:s.desired,native:s.native},p),key)
  assert.notEqual(courseSelectionKey({...s,desired:{...s.desired,revision:2}},p),key)
  assert.notEqual(courseSelectionKey(s,{...p,reverse:true}),key)
  assert.notEqual(courseSelectionKey(s,{...p,points:[]}),key)
  assert.equal(markLabel(0,3,true),'F');assert.equal(markLabel(2,3,true),'S');assert.equal(markLabel(1,3),'1')
})
