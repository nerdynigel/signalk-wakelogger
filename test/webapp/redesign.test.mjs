import test from 'node:test'
import assert from 'node:assert/strict'
import { statusPresentation, windMarkerMarkup } from '../../webapp/redesign.mjs'

test('healthy local logging uses a green vessel; uploads and sensor connection are independent', () => {
  const local = statusPresentation({ paired: true, recording: true, uploadMode: 'local_only', connectionState: 'recording_locally', queue: { messageCount: 50 } }, true)
  assert.equal(local.cloudState, 'green'); assert.equal(local.icon, 'vessel'); assert.equal(local.cloudText, 'Logging locally')
  assert.equal(statusPresentation({ paired: true, uploadMode: 'automatic', connectionState: 'online', queue: { messageCount: 50 } }, true).cloudState, 'amber')
  assert.equal(statusPresentation({ paired: true, uploadMode: 'automatic', connectionState: 'online', queue: { messageCount: 0 } }, false).signalState, 'red')
  assert.equal(statusPresentation({ paired: true, uploadMode: 'automatic', connectionState: 'online', queue: { messageCount: 0 } }, true).cloudState, 'green')
  assert.equal(statusPresentation({ paired: true, uploadMode: 'automatic', connectionState: 'online' }, true).cloudState, 'amber')
  assert.equal(statusPresentation({ paired: true, uploadMode: 'local_only', recordingError: 'disk full' }, true).cloudState, 'red')
})
test('map wind glyphs withhold missing or magnetic direction; display fresh speeds only', () => {
  const readings = [{ id:'heading', value:55, available:true, reference:'true' },{ id:'awa', value:56, available:true },{ id:'aws', value:14.6, available:true },{ id:'twd', value:141, available:true },{ id:'tws', value:13.2, available:true }]
  const markup = windMarkerMarkup(readings, null)
  assert.match(markup, />A<\/text>/); assert.match(markup, />T<\/text>/)
  assert.match(markup, />14\.6<\/text>/); assert.match(markup, />13\.2<\/text>/)
  assert.match(markup, /rotate\(291\)/); assert.match(markup, /rotate\(321\)/)
  assert.doesNotMatch(windMarkerMarkup(readings.map(r => ({ ...r, available:false })), null), /svg/)
  assert.doesNotMatch(windMarkerMarkup(readings.map(r => r.id==='heading' ? {...r, reference:'magnetic'} : r), null), />A<\/text>/)
})

test('dial interpolates shortest angles, including through north and when retargeted', async () => {
  const { DialMotion } = await import('../../webapp/dial-motion.mjs')
  const motion = new DialMotion(900)
  motion.update({heading:359,awa:179,cog:5,btw:40},0,{reference:'true'})
  motion.update({heading:1,awa:-179,cog:15,btw:60},1000,{reference:'true'})
  const middle=motion.sample(1450)
  assert.equal(middle.heading,360);assert.equal(middle.awa,180)
  assert.equal(middle.cog,10);assert.equal(middle.btw,50)
  assert.equal(motion.moving(1450),true)
  motion.update({heading:3,awa:-177,cog:20,btw:80},1450,{reference:'true'})
  assert.equal(motion.sample(1450).heading,middle.heading)
  assert.equal(motion.sample(2350).heading,363)
  assert.equal(motion.moving(2350),false)
})
test('dial immediately hides expired angles and snaps across references or reduced motion', async () => {
  const { DialMotion } = await import('../../webapp/dial-motion.mjs')
  const motion = new DialMotion()
  motion.update({heading:20,cog:30},0,{reference:'true'})
  motion.update({heading:80,cog:90},100,{reference:'true'})
  motion.update({heading:null,cog:null},200,{reference:'true'})
  assert.equal(motion.sample(200).heading,null);assert.equal(motion.sample(200).cog,null)
  motion.update({heading:200},300,{reference:'magnetic'})
  assert.equal(motion.sample(300).heading,200)
  motion.update({heading:270},400,{reference:'magnetic',animate:false})
  assert.equal(motion.sample(400).heading,270);assert.equal(motion.moving(400),false)
})
