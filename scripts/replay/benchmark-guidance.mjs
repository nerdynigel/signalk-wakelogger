// Offline comparison of unchanged original sensors; no server writes or mocks.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {waypointLaylines} from '../../webapp/waypoint-laylines.mjs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {GuidanceService}=require('../../dist/guidance/service.js');
const {guidanceBearings}=require('../../dist/guidance/core.js');
const data=process.env.WAKELOGGER_REPLAY_DATA;
if(!data)throw Error('Set WAKELOGGER_REPLAY_DATA to the private prepared source directory');
const output=process.argv[2]||path.join(data,'guidance-benchmark.json');
const raw=new GuidanceService({headingTauSeconds:0,windTauSeconds:0}),filtered=new GuidanceService();
const course=JSON.parse(fs.readFileSync(path.join(data,'source-course.json')));
const rows=[];let lastSample=-Infinity,events=0,position=null;
for await(const line of readline.createInterface({input:fs.createReadStream(path.join(data,'clip.ndjson')),crlfDelay:Infinity})){
 const event=JSON.parse(line),at=event.sourceTimeMs;events++;
 for(const update of event.delta.updates)for(const value of update.values)if(value.path==='navigation.position')position=value.value;
 raw.ingest(event.delta,at);filtered.ingest(event.delta,at);
 if(at-lastSample<100)continue;lastSample=at;
 const a=raw.snapshot(at),b=filtered.snapshot(at);
 const ra=guidanceBearings(a,at),rb=guidanceBearings(b,at);
 if(!a||!b)continue;
 const target=course.points[at<Date.parse('2026-06-28T03:16:21Z')?1:2];
 const distance=g=>waypointLaylines({position,target,headingDeg:g.currentCourseDeg,oppositeCourseDeg:g.oppositeCourseDeg,currentTack:g.currentTack,kind:g.kind,trueWindFromDeg:g.trueWindFromDeg,groundCorrected:g.corrected}).distanceM;
 rows.push({at,rawDistance:distance(ra),distance:distance(rb),rawHeading:((a.inputs.heading.value % 360) + 360) % 360,heading:b.headingDeg,rawWind:((Math.atan2(a.inputs.windEast?.value, a.inputs.windNorth?.value) * 180 / Math.PI) + 360) % 360,wind:b.windFromDeg,rawOpposite:ra.oppositeCourseDeg,opposite:rb.oppositeCourseDeg,turning:b.turning,rawVisible:ra.oppositeCourseDeg!==null,visible:rb.oppositeCourseDeg!==null});
}
const angle=(a,b)=>Math.abs(((a-b+540)%360)-180);
const steadyWindows=[['2026-06-28T03:06:00Z','2026-06-28T03:09:00Z'],['2026-06-28T03:19:00Z','2026-06-28T03:25:00Z']].map(a=>a.map(Date.parse));
const steady=rows.filter(r=>steadyWindows.some(([a,b])=>r.at>=a&&r.at<=b));
function jitter(rawField,smoothField,angular=true){const rawChanges=[],changes=[];for(let i=1;i<steady.length;i++){const a=steady[i-1],b=steady[i];if(b.at-a.at>300||b.turning||a.turning||[a[rawField],b[rawField],a[smoothField],b[smoothField]].some(x=>!Number.isFinite(x)))continue;rawChanges.push(angular?angle(a[rawField],b[rawField]):Math.abs(a[rawField]-b[rawField]));changes.push(angular?angle(a[smoothField],b[smoothField]):Math.abs(a[smoothField]-b[smoothField]));}const rms=x=>Math.sqrt(x.reduce((n,v)=>n+v*v,0)/Math.max(1,x.length));return{comparisons:changes.length,rawRms:rms(rawChanges),filteredRms:rms(changes),units:angular?'degrees':'metres',reductionPercent:100*(1-rms(changes)/rms(rawChanges))};}
const turn=rows.filter(r=>r.at>=Date.parse('2026-06-28T03:15:40Z')&&r.at<=Date.parse('2026-06-28T03:17:30Z'));
let best={seconds:0,rms:Infinity};
for(let offset=0;offset<=30;offset++){
 const errors=[];let previous=0;
 for(const row of turn){const at=row.at-offset*100;while(previous+1<turn.length&&turn[previous+1].at<=at)previous++;const candidate=turn[previous];if(Math.abs(candidate.at-at)>200)continue;errors.push(angle(row.heading,candidate.rawHeading));}
 const rms=Math.sqrt(errors.reduce((n,x)=>n+x*x,0)/Math.max(1,errors.length));if(rms<best.rms)best={seconds:offset/10,rms};
}
const transitions=key=>steady.slice(1).filter((r,i)=>r.at-steady[i].at<300&&r[key]!==steady[i][key]).length;
const result={sourceEvents:events,algorithm:'sailing-guidance-v1',sampleCount:rows.length,steadyWindows:steadyWindows.map(w=>w.map(t=>new Date(t).toISOString())),heading:jitter('rawHeading','heading'),wind:jitter('rawWind','wind'),oppositeCourse:jitter('rawOpposite','opposite'),maneuverDistance:jitter('rawDistance','distance',false),visibilityTransitions:{raw:transitions('rawVisible'),filtered:transitions('visible')},steadyVisibility:{raw:steady.filter(r=>r.rawVisible).length,filtered:steady.filter(r=>r.visible).length,total:steady.length},turnLagBestFitSeconds:best.seconds,turnHeadingRmsDegrees:best.rms,limits:['Actual rudder unavailable in this source; validates rudder-free operation.','No measured/calibrated leeway or current correction was invented for this clip.','Best-fit turn lag is a timestamped series comparison, not vessel-model validation.']};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');fs.writeFileSync(output.replace(/\.json$/,'.ndjson'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');console.log(JSON.stringify(result,null,2));
if(events<80000||result.oppositeCourse.comparisons<100||result.oppositeCourse.reductionPercent<50||best.seconds>3)process.exitCode=1;
