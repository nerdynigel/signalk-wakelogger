// Run inside the pinned Signal K image. The recorded PGN clock is explicit;
// Canboat's default (current wall time) must never select historical frames.
const fs = require('node:fs');
const readline = require('node:readline');
const {createRequire} = require('node:module');
const native = createRequire('/home/node/signalk/node_modules/signalk-server/package.json');
const {FromPgn} = native('@canboat/canboatjs');
const {N2kMapper} = native('@signalk/n2k-signalk');
const parser = new FromPgn(), mapper = new N2kMapper();
const [input, output] = process.argv.slice(2);
let parseErrors = 0;
parser.on('error', () => parseErrors++);
parser.on('warning', () => {});
const events = [], paths = {}, references = {}, engine = [], latest = new Map();
let derivedHeadings = 0;
(async () => {
  for await (const line of readline.createInterface({input:fs.createReadStream(input),crlfDelay:Infinity})) {
    const frame = JSON.parse(line), bytes = Buffer.from(frame.data, 'base64');
    const pgn = parser.parsePgnData(frame, bytes.length, bytes, false);
    if (!pgn) continue;
    pgn.timestamp = new Date(frame.sourceTimeMs).toISOString();
    if (pgn.pgn === 127250 || pgn.pgn === 130306) {
      const key = `${pgn.pgn}:${pgn.fields.reference}`;
      references[key] = (references[key] || 0) + 1;
    }
    const delta = mapper.toDelta(pgn);
    // Exclude other vessels' AIS and remote control/resource data.
    if (!delta || delta.context && delta.context !== 'vessels.self') continue;
    const updates = (delta.updates || []).map(update => ({...update,
      values:(update.values || []).filter(v => /^(navigation\.|environment\.(wind|depth)\.|propulsion\.)/.test(v.path)
        && !/^navigation\.course(GreatCircle|Rhumbline)\./.test(v.path))
    })).filter(update => update.values.length);
    if (!updates.length) continue;
    for (const update of updates) for (const value of update.values) latest.set(value.path,{value:value.value,at:frame.sourceTimeMs});
    const magnetic = latest.get('navigation.headingMagnetic'), variation = latest.get('navigation.magneticVariation');
    if (!latest.has('navigation.headingTrue') && updates.some(u=>u.values.some(v=>v.path==='navigation.headingMagnetic' || v.path==='navigation.magneticVariation'))
      && magnetic && variation && frame.sourceTimeMs-magnetic.at <= 10000 && frame.sourceTimeMs-variation.at <= 10000
      && Number.isFinite(magnetic.value) && Number.isFinite(variation.value)) {
      updates.push({timestamp:pgn.timestamp,source:{type:'derived',label:'recorded-magnetic-plus-variation'},
        values:[{path:'navigation.headingTrue',value:((magnetic.value+variation.value)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)}]});
      derivedHeadings++;
    }
    for (const update of updates) for (const value of update.values) {
      paths[value.path] = (paths[value.path] || 0) + 1;
      if (/propulsion.*revolutions/.test(value.path) && typeof value.value === 'number') engine.push(value.value);
    }
    events.push({sourceTimeMs:frame.sourceTimeMs, delta:{context:'vessels.self',updates}});
  }
  if (parseErrors) throw new Error(`${parseErrors} CAN decode errors`);
  for (const key of ['navigation.position','navigation.courseOverGroundTrue','navigation.speedOverGround','environment.wind.angleApparent','environment.wind.speedApparent']) {
    if (!paths[key]) throw new Error(`Required original sensor missing: ${key}`);
  }
  if (!paths['navigation.headingTrue'] && !(paths['navigation.headingMagnetic'] && paths['navigation.magneticVariation'])) throw new Error('True heading or magnetic heading plus measured variation required');
  fs.writeFileSync(output, events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const report = {events:events.length, paths, references, derivedHeadings,
    headingBasis:'Recorded magnetic heading plus recorded variation, with <=10 second source age; never COG',
    engine:engine.length ? {samples:engine.length,min:Math.min(...engine),max:Math.max(...engine)} : {samples:0,underSail:'inferred from race window and sailing data; engine state unrecorded'}};
  fs.writeFileSync(output+'.json', JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1});
