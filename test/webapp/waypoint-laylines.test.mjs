import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { waypointLaylines, projectLayline, laylineCoordinates } from '../../webapp/waypoint-laylines.mjs';
const cases = JSON.parse(readFileSync(new URL('./fixtures/waypoint-laylines.json', import.meta.url)));
for (const fixture of cases) test(`waypoint laylines: ${fixture.name}`, () => {
  const result = waypointLaylines(fixture.input);
  assert.equal(result.status, fixture.status);
  if (result.status === 'ready') {
    assert.ok(Number.isFinite(result.distanceM) && result.distanceM >= 0);
    assert.deepEqual(result.approaches.map(a => a.side).sort(), ['port', 'starboard']);
    const projected = projectLayline(fixture.input.position, fixture.input.headingDeg, result.distanceM);
    assert.ok(Math.abs(projected.latitude-result.maneuverPoint.latitude) < 1e-8);
    assert.ok(Math.abs(projected.longitude-result.maneuverPoint.longitude) < 1e-8);
  } else assert.equal(result.distanceM, null);
});
test('independent right-angle spherical oracle gives known distance', () => {
  const result = waypointLaylines(cases[0].input);
  // A great circle tangent west at (1N, 1E) crosses longitude 0 at this latitude.
  const angle = Math.atan(Math.tan(Math.PI/180)*Math.cos(Math.PI/180));
  assert.ok(Math.abs(result.distanceM - 6371000*angle) < 0.001);
  assert.ok(Math.abs(result.maneuverPoint.latitude - angle*180/Math.PI) < 1e-8);
  assert.ok(Math.abs(result.maneuverPoint.longitude) < 1e-8);
});
test('nonfinite inputs and unknown side fail closed', () => {
  for (const value of [NaN, Infinity, -Infinity, null]) {
    assert.equal(waypointLaylines({...cases[0].input, headingDeg:value}).status, 'unavailable');
    assert.equal(waypointLaylines({...cases[0].input, target:{latitude:value,longitude:0}}).status, 'unavailable');
  }
  assert.equal(waypointLaylines({...cases[0].input,currentTack:null}).status,'unavailable');
});
test('sampled rays wrap continuously around dateline and viewport world copy', () => {
  for (const center of [-180,180,540]) {
    const ray=laylineCoordinates({latitude:0,longitude:179.99},90,50000,center);
    assert.ok(Math.abs(ray[0][1]-center) < 1);
    for (let i=1;i<ray.length;i++) assert.ok(Math.abs(ray[i][1]-ray[i-1][1]) < 1);
  }
});
