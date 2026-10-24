import test from 'node:test';import assert from 'node:assert/strict';
import {liveWindReadings,guidanceWind,windAngleText} from '../../webapp/wind-readout.mjs';
import {instrumentReadings,instrumentDisplayReadings,liveNavigationStrip} from '../../webapp/instruments.mjs';
const at=Date.parse('2026-10-24T00:00:00Z'),e=value=>({value,timestamp:new Date(at).toISOString()});
test('wind angles use compass heading and keep port/starboard through north wrap',()=>{
 const state={capturedAt:new Date(at).toISOString(),headingDeg:350,headingReference:'true',cogDeg:90,awaDeg:330,twsKn:12,twdDeg:20};
 const a=liveWindReadings(state,at);assert.equal(a.twaDeg,30);assert.equal(a.awaDeg,-30);assert.equal(windAngleText(a.awaDeg),'30° P');assert.equal(windAngleText(a.twaDeg),'30° S');
 assert.equal(liveWindReadings({...state,cogDeg:180},at).twaDeg,30);
 assert.equal(liveWindReadings({...state,headingReference:'magnetic'},at).twaDeg,null);
 assert.equal(windAngleText(null),'—');assert.equal(windAngleText(180),'180°');
});
test('canonical wind is displayed at a beam reach and expires by its own source clock',()=>{
 const snapshot={v:1,algorithm:'sailing-guidance-v1',headingDeg:0,headingAt:at,headingValidUntil:at+30000,windFromDeg:90,windSpeedKn:12,windAt:at,windValidUntil:at+30000,kind:null};
 assert.equal(guidanceWind(snapshot,at).twaDeg,90);
 const values=liveWindReadings({capturedAt:new Date(at+31000).toISOString(),guidance:snapshot,headingReference:'true',headingDeg:0,twdDeg:60,twsKn:10},at+31000);
 assert.equal(values.twaDeg,null);assert.equal(values.twsKn,null);
});
test('plugin shows one coherent TW pair even when both ground and water instruments exist',()=>{
 const view=instrumentReadings({now:at,navigation:{headingTrue:e(0)},environment:{wind:{speedOverGround:e(12/1.9438444924406),speedTrue:e(8/1.9438444924406),angleTrueGround:e(-Math.PI/3),angleTrueWater:e(Math.PI/4),speedApparent:e(15/1.9438444924406),angleApparent:e(-Math.PI/6)}}});
 const visible=instrumentDisplayReadings(view);assert.equal(visible.filter(r=>r.id==='twd').length,1);assert.ok(!visible.some(r=>r.id.startsWith('twa')));
 assert.equal(visible.find(r=>r.id==='twd').value,45);assert.ok(Math.abs(visible.find(r=>r.id==='tws').value-8)<1e-9);assert.equal(visible.find(r=>r.id==='tws').basis,'water');
 const strip=liveNavigationStrip(view);assert.equal(strip.filter(r=>r.id==='twd').length,1);assert.equal(strip.find(r=>r.id==='twd').formatted,'045°');assert.ok(!strip.some(r=>r.id==='twa'));
});

test('water true wind wins over published ground wind and shares its basis with VMG',()=>{
 const view=instrumentReadings({now:at,navigation:{headingTrue:e(0),speedThroughWater:e(4/1.9438444924406),speedOverGround:e(6/1.9438444924406),courseOverGroundTrue:e(0)},environment:{wind:{speedTrue:e(8/1.9438444924406),angleTrueWater:e(Math.PI/3),speedOverGround:e(12/1.9438444924406),angleTrueGround:e(-Math.PI/6)}}});
 const snapshot={v:1,algorithm:'sailing-guidance-v1',headingDeg:10,headingAt:at,headingValidUntil:at+30000,windFromDeg:340,windSpeedKn:12,windAt:at,windValidUntil:at+30000};
 const visible=instrumentDisplayReadings(view,snapshot,at),get=id=>visible.find(r=>r.id===id);
 assert.equal(get('twa'),undefined);assert.equal(get('twd').value,60);assert.equal(get('heading').value,0);
 assert.ok(Math.abs(get('tws').value-8)<1e-9);assert.ok(Math.abs(get('vmg-wind').value-2)<1e-9);
 assert.equal(get('vmg-wind').basis,'water');assert.equal(get('vmg-wind').label,'VMG to wind');
 assert.equal(visible.filter(r=>r.id.startsWith('vmg-wind')).length,1);
 assert.ok(!visible.some(r=>/\((ground|water)\)/.test(r.label)));
 assert.equal(liveNavigationStrip(view,snapshot,at).at(-1).basis,'water');
});

test('water wind loss falls back to one complete GPS pair and restores without mixing',()=>{
 const evaluate=waterAt=>instrumentDisplayReadings(instrumentReadings({now:at,navigation:{headingTrue:e(0),speedThroughWater:e(4/1.9438444924406),speedOverGround:e(6/1.9438444924406),courseOverGroundTrue:e(0)},environment:{wind:{speedTrue:{value:8/1.9438444924406,timestamp:new Date(waterAt).toISOString()},angleTrueWater:{value:Math.PI/3,timestamp:new Date(waterAt).toISOString()},speedOverGround:e(12/1.9438444924406),angleTrueGround:e(-Math.PI/6)}}}));
 for(const waterAt of [at,at-31000,at]){
  const values=evaluate(waterAt),basis=waterAt===at?'water':'ground';
  for(const id of ['tws','twd','vmg-wind'])assert.equal(values.find(r=>r.id===id).basis,basis);
  assert.equal(values.find(r=>r.id==='twd').value,basis==='water'?60:330);
  assert.equal(values.filter(r=>r.id==='tws').length,1);assert.equal(values.filter(r=>r.id==='vmg-wind').length,1);
 }
});

test('water TWA does not acquire an unrelated ground compass direction without heading',()=>{
 const view=instrumentReadings({now:at,environment:{wind:{speedTrue:e(8/1.9438444924406),angleTrueWater:e(Math.PI/3),directionTrue:e(Math.PI)}}});
 const values=instrumentDisplayReadings(view);
 assert.equal(view.displayWind.angle.available,true);assert.ok(!values.some(r=>r.id.startsWith('twa')));
 assert.equal(values.find(r=>r.id==='twd').available,false);
});
test('water-only measured wind stays available without GPS or heading',()=>{
 const view=instrumentReadings({now:at,environment:{wind:{speedTrue:e(8/1.9438444924406),angleTrueWater:e(-Math.PI/6)}}});const visible=instrumentDisplayReadings(view);
 assert.equal(view.displayWind.angle.basis ?? view.displayWind.basis,'water');assert.equal(view.displayWind.angle.available,true);assert.ok(!visible.some(r=>r.id.startsWith('twa')));assert.equal(visible.find(r=>r.id==='tws').available,true);
});
