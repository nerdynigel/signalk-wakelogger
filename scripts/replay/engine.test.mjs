import test from 'node:test';
import assert from 'node:assert/strict';
import engine from './provider/engine.cjs';
const {ReplayEngine,rebaseDelta}=engine;
const original=Date.parse('2026-06-28T03:06:00Z');
const event=offset=>({sourceTimeMs:original+offset,delta:{context:'vessels.self',updates:[{
  timestamp:new Date(original+offset).toISOString(),source:{type:'NMEA2000',src:'22',pgn:126992},
  values:[{path:'navigation.datetime',value:new Date(original+offset).toISOString()},
    {path:'environment.wind.angleApparent',value:-0.5}]
}]}});
test('rebases both envelope and embedded clock, preserving sensor value and source identity',()=>{
  const wall=Date.parse('2026-10-24T00:00:00Z'),source=event(1000);
  const delta=rebaseDelta(source,wall,original);
  assert.equal(delta.updates[0].timestamp,'2026-10-24T00:00:01.000Z');
  assert.equal(delta.updates[0].values[0].value,'2026-10-24T00:00:01.000Z');
  assert.equal(delta.updates[0].values[1].value,-0.5);
  assert.equal(delta.updates[0].source.src,'22');
  assert.equal(source.delta.updates[0].timestamp,'2026-06-28T03:06:01.000Z');
});
test('preserves cadence, emits once and ends without looping',()=>{
  let now=100000;const output=[];
  const replay=new ReplayEngine([event(0),event(100),event(1000)],d=>output.push(d),()=>now);
  replay.start();replay.tick();assert.equal(output.length,1);
  now+=99;replay.tick();assert.equal(output.length,1);
  now+=1;replay.tick();assert.equal(output.length,2);
  now+=900;replay.tick();replay.tick();assert.equal(output.length,3);
  assert.equal(replay.state,'ended');assert.throws(()=>replay.start(),/fresh run/);
});
test('pause permits genuine staleness; resume shifts future events without filling the gap',()=>{
  let now=100000;const output=[];
  const replay=new ReplayEngine([event(0),event(1000)],d=>output.push(d),()=>now);
  replay.start();replay.tick();now+=500;replay.pause();
  now+=135000;replay.tick();assert.equal(output.length,1);
  replay.start();replay.tick();assert.equal(output.length,1);
  now+=500;replay.tick();assert.equal(output.length,2);
  assert.equal(Date.parse(output[1].updates[0].timestamp),now);
  assert.equal(Date.parse(output[0].updates[0].timestamp),100000);
});
test('scheduler lag pauses rather than emitting a catch-up burst',()=>{
  let now=100000;const output=[];
  const replay=new ReplayEngine([event(0),event(100)],d=>output.push(d),()=>now);
  replay.start();now+=2000;replay.tick();assert.equal(output.length,0);
  assert.equal(replay.state,'paused');assert.match(replay.pauseReason,/lag/);
  replay.start();replay.tick();assert.equal(output.length,1);
});
test('invalid source order and missing clock data fail closed',()=>{
  assert.throws(()=>new ReplayEngine([],()=>{}),/Ordered/);
  assert.throws(()=>new ReplayEngine([event(100),event(0)],()=>{}),/Ordered/);
  const invalid=event(0);invalid.delta.updates[0].values[0].value='not-a-clock';
  assert.throws(()=>rebaseDelta(invalid,100000,original),/Invalid embedded clock/);
});

test('rewind starts a distinct pass with fresh timestamps and source identity',()=>{
 let now=100000;const output=[];const replay=new ReplayEngine([event(0)],d=>output.push(d),()=>now);
 replay.start();replay.tick();assert.equal(replay.state,'ended');now+=10000;replay.rewind('replay-second');replay.start();replay.tick();
 assert.equal(output.length,2);assert.equal(Date.parse(output[1].updates[0].timestamp),now);assert.equal(output[1].updates[0].source.label,'replay-second');assert.equal(output[1].updates[0].values[1].value,output[0].updates[0].values[1].value);
});
test('checkpoint restores a paused position without replaying emitted events',()=>{
 let now=100000;const output=[];const first=new ReplayEngine([event(0),event(1000)],()=>{},()=>now);first.start();first.tick();now+=400;first.pause();
 const next=new ReplayEngine([event(0),event(1000)],d=>output.push(d),()=>now);next.restore(first.status());assert.equal(next.cursor,1);assert.equal(next.state,'paused');
 now+=10000;next.start();next.tick();assert.equal(output.length,0);now+=600;next.tick();assert.equal(output.length,1);
 assert.throws(()=>next.restore({cursor:100,sourceTimeMs:original,state:'paused'}),/Invalid/);
});
