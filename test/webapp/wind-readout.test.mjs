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
 const visible=instrumentDisplayReadings(view);assert.equal(visible.filter(r=>r.id==='twa').length,1);assert.ok(!visible.some(r=>r.id==='twa-water'||r.id==='twa-ground'));
 assert.equal(visible.find(r=>r.id==='twa').value,-60);assert.ok(Math.abs(visible.find(r=>r.id==='tws').value-12)<1e-9);assert.equal(visible.find(r=>r.id==='tws').basis,'ground');
 const strip=liveNavigationStrip(view);assert.equal(strip.filter(r=>r.id==='twa').length,1);assert.equal(strip.find(r=>r.id==='twa').formatted,'60° P');
});
test('water-only measured wind stays available without GPS or heading',()=>{
 const view=instrumentReadings({now:at,environment:{wind:{speedTrue:e(8/1.9438444924406),angleTrueWater:e(-Math.PI/6)}}});const visible=instrumentDisplayReadings(view);
 assert.equal(visible.find(r=>r.id==='twa').basis,'water');assert.equal(visible.find(r=>r.id==='twa').available,true);assert.equal(visible.find(r=>r.id==='tws').available,true);
});
