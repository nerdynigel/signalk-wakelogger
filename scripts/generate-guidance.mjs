import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import ts from 'typescript';
const root=new URL('../',import.meta.url);
const source=await fs.readFile(new URL('src/guidance/core.ts',root),'utf8');
const hash=crypto.createHash('sha256').update(source).digest('hex');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const output=`// Generated from src/guidance/core.ts; SHA256 ${hash}. Do not edit.\n${compiled}`;
await fs.writeFile(new URL('webapp/sailing-guidance.mjs',root),output);
const manifest=JSON.stringify({sourceSha256:hash,moduleSha256:crypto.createHash('sha256').update(output).digest('hex'),algorithm:'sailing-guidance-v1'},null,2)+'\n';
await fs.mkdir(new URL('test/fixtures/',root),{recursive:true});
await fs.writeFile(new URL('test/fixtures/guidance-manifest.json',root),manifest);
const destination=process.argv.find(x=>x.startsWith('--frontend-root='))?.slice('--frontend-root='.length);
if(destination){const path=await import('node:path');await fs.writeFile(path.resolve(destination,'app/lib/sailingGuidance.mjs'),output);await fs.mkdir(path.resolve(destination,'tests/fixtures'),{recursive:true});await fs.writeFile(path.resolve(destination,'tests/fixtures/guidance-manifest.json'),manifest);}
console.log(`Guidance core ${hash}`);

const service=await fs.readFile(new URL('src/guidance/service.ts',root),'utf8');
const serviceJs=ts.transpileModule(service,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace("from './core'", "from './sailing-guidance.mjs'");
await fs.writeFile(new URL('webapp/guidance-service.mjs',root),'// Generated from src/guidance/service.ts. Do not edit.\n'+serviceJs);
