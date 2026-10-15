// Actual trip-card page with disposable routed API data, never a production session.
const { chromium, expect } = require('@playwright/test');
const { readFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const fixtures = JSON.parse(readFileSync(resolve(__dirname, 'tide-source-samples.json')));
const base = process.env.WAKELOGGER_E2E_FRONTEND_URL;
if (!base) throw new Error('Set the authorized DEV frontend URL');
const output = process.env.WAKELOGGER_TIDE_EVIDENCE_DIR;
(async () => {
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    for (const viewport of [{width:1365,height:900},{width:390,height:844}]) {
      const page = await browser.newPage({viewport});
      const errors = [], writes = [], failed = [], consoleErrors = [];
      let mode = 'samples';
      page.on('pageerror', error => errors.push(error.message));
      page.on('requestfailed', request => {
        if (request.failure()?.errorText !== 'net::ERR_ABORTED') failed.push({url:request.url(),error:request.failure()?.errorText});
      });
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      await page.route('**/public/homepage', route => route.fulfill({status:200,json:{}}));
      await page.addInitScript(() => localStorage.setItem('wakelogger_auth_token','local-fixture-token'));
      const trips = () => fixtures.trips.map(trip => ({
        ...trip, vessel_id:1, created_by_user_id:1, created_by_display_name:'Fixture owner',
        start_timezone:'Australia/Brisbane', start_location_name:`Sample ${trip.id} tide fixture`,
        end_location_name:'Tide fixture end', route_preview_svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1 1 L9 9"/></svg>',
        race_plan_id:1, race_plan_snapshot:{source_plan_id:1,calculation_snapshot_json:{tide_snapshot_json:fixtures.race}},
        ...(mode === 'missing' ? {tide_events:[]} : {}),
        ...(mode === 'race' ? {tide_events:[],race_plan_snapshot:{source_plan_id:1,calculation_snapshot_json:{tide_snapshot_json:{...fixtures.race,events:trip.tide_events,datum:'LAT',station:'Synthetic race fixture'}}}} : {}),
      }));
      await page.route('**/v1/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/backend(?=\/v1\/)/, '');
        // Session renewal and analytics are normal background requests, fulfilled locally.
        if (request.method() !== 'GET' && !['/v1/auth/session/renew-live','/v1/analytics/heartbeat'].includes(path)) writes.push(path);
        let data = [];
        if (path.endsWith('/auth/me')) data = {id:1,display_name:'Fixture owner',timezone_name:'Australia/Brisbane',feature_flags:{}};
        else if (path.endsWith('/onboarding-state')) data = {completed:true,dismissed:true};
        else if (path.endsWith('/vessels')) data = [{id:1,name:'Local tide fixture vessel',propulsion_type:'sail',current_user_membership_role:'owner',effective_feature_flags:{}}];
        else if (path.endsWith('/voyages') || path.endsWith('/trip-summaries')) data = trips();
        else if (path.endsWith('/access')) data = {current_user_membership_role:'owner',can_manage:true};
        await route.fulfill({status:200,json:data});
      });
      await page.goto(base + '/vessels/manage?vessel=1&tab=trips');
      for (const trip of fixtures.trips) {
        const card = page.getByTestId(`workspace-trip-card-${trip.id}`).locator('xpath=ancestor::article');
        const tide = card.getByTestId('trip-tide-card');
        await expect(tide).toBeVisible();
        await expect(tide).toHaveAttribute('data-tide-source','voyage');
        await expect(tide).toContainText(trip.id === 76 ? 'Trip diff -1.29 m' : 'Trip diff -1.65 m');
        await expect(tide.locator('svg path').first()).toBeVisible();
        await expect(tide.getByTestId('trip-tide-marker-edge')).toHaveCount(2);
        await expect(tide.getByTestId('trip-tide-marker-edge').first()).toBeVisible();
        await expect(tide.getByTestId('trip-tide-marker-edge').last()).toBeVisible();
        await expect(tide).toContainText(trip.id === 76 ? '0.91 m' : '-1.03 m');
        await expect(tide).toContainText(trip.id === 76 ? '-0.92 m' : '-0.87 m');
        await expect(tide.getByTestId('trip-tide-provenance')).toHaveCount(0);
        if (output) {
          mkdirSync(output,{recursive:true});
          await card.screenshot({path:resolve(output,`sample-${trip.id}-${viewport.width}.png`)});
        }
      }
      mode = 'missing'; await page.reload();
      await expect(page.getByTestId('trip-tide-card')).toHaveCount(0);
      await expect(page.getByText('No tide summary available.')).toHaveCount(2);
      mode = 'race'; await page.reload();
      for (const trip of fixtures.trips) {
        const tide = page.getByTestId(`workspace-trip-card-${trip.id}`).locator('xpath=ancestor::article').getByTestId('trip-tide-card');
        await expect(tide).toHaveAttribute('data-tide-source','race');
        await expect(tide.getByTestId('trip-tide-provenance')).toHaveText('Synthetic race fixture · LAT');
        await expect(tide.locator('svg path').first()).toBeVisible();
      }
      mode = 'samples'; await page.reload();
      await expect(page.getByTestId('trip-tide-card').first()).toHaveAttribute('data-tide-source','voyage');
      expect(errors).toEqual([]); expect(writes).toEqual([]); expect(failed).toEqual([]); expect(consoleErrors).toEqual([]);
      console.log(`PASS ${viewport.width}x${viewport.height}: sample76/77 graphics, bounding high/low values, differential, missing state, race fallback provenance, recovery; no page/console errors/control writes/unexpected failed requests; session renewal and analytics mocked`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
