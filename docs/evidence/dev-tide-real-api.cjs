const fs=require('fs');const {chromium,expect}=require('@playwright/test');
// Persist no real DEV host address: every origin is written as the placeholder.
const sanitize=value=>String(value).replace(/https?:\/\/[^/\s"']+/g,'http://dev-web:3010');
(async()=>{const input=JSON.parse(fs.readFileSync(0,'utf8'));const browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});const R={at:new Date().toISOString(),synthetic:true,url:sanitize(input.url),pageErrors:[],consoleErrors:[],tideCards:null,missingText:null,voyageCards:null};
try{const page=await browser.newPage({viewport:{width:1365,height:900}});
page.on('pageerror',e=>R.pageErrors.push(e.message));
page.on('console',m=>{if(m.type()==='error')R.consoleErrors.push(m.text().slice(0,200))});
await page.addInitScript(token=>localStorage.setItem('wakelogger_auth_token',token),input.token);
await page.goto(input.url);
await expect(page.getByTestId('workspace-trip-card-4')).toBeVisible({timeout:45000});
R.voyageCards=await page.getByTestId('workspace-trip-card-4').count();
await page.waitForTimeout(1500);
R.tideCards=await page.getByTestId('trip-tide-card').count();
R.missingText=await page.getByText('No tide summary available.').count();
expect(R.tideCards).toBe(0);
expect(R.missingText).toBeGreaterThan(0);
expect(R.pageErrors).toEqual([]);
await page.screenshot({path:'docs/evidence/dev-tide-real-api-1365.png',fullPage:true});
R.pageErrors=R.pageErrors.map(sanitize);R.consoleErrors=R.consoleErrors.map(sanitize);R.ok=true;fs.writeFileSync('docs/evidence/dev-tide-real-api-page.json',JSON.stringify(R,null,2)+'\n');
console.log('PASS real served website vs real isolated API: voyage4 renders without tide card and with explicit no-tide state; no page errors');console.log('consoleErrors',JSON.stringify(R.consoleErrors.slice(0,5)));}
finally{await browser.close()}})().catch(error=>{console.error(String(error.message).replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]').slice(0,400));process.exitCode=1});
