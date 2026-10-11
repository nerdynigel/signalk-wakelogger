import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve(process.argv[2], 'frontend/package.json'));
const { chromium, expect } = require('@playwright/test');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const viewport of [{ width: 1200, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/v1/**', route => {
      const path = new URL(route.request().url()).pathname;
      // The shared layout sends its analytics heartbeat; it is intercepted.
      if (route.request().method() !== 'GET' && path !== '/v1/analytics/heartbeat') writes.push(path);
      return route.fulfill({ status: 200, json: [] });
    });
    const normal = sequence => ({ sequence, from_waypoint: { name: 'Start', latitude: 0, longitude: 0 }, to_waypoint: { name: 'Finish', latitude: 0, longitude: 1 / 60 }, distance_nm: 1, estimated_sog_knots: 5, forecast_twd_deg: sequence === 1 ? 0 : 90, forecast_tws_knots: 10, warnings: [] });
    const start = '2026-10-11T12:00:00Z';
    const snapshot = { planned_start_time: start, legs: [{ ...normal(1), estimated_finish_time: '2026-10-15T16:00:00Z' }, normal(2)], warnings: [] };
    await page.addInitScript(payload => { window.__WAKELOGGER_RACE_PLAN_PDF__ = payload; }, { timezone: 'UTC', plan: { name: 'QA only', vessel_name: 'Fixture', calculation_snapshot_json: snapshot } });
    await page.goto('http://127.0.0.1:3399/race-plan/print');
    await expect(page.locator('[data-race-plan-print-ready]')).toBeVisible();
    await expect(page.getByTestId('race-plan-summary-leg-2-timing')).toContainText('Oct 15');
    await expect(page.getByTestId('race-plan-leg-2')).toContainText('Oct 15');
    await expect(page.getByTestId('race-plan-overall-summary')).toContainText('100 h 12 min');
    await expect(page.getByTestId('race-plan-weather-summary')).toContainText('Leg 2 around Oct 15');
    expect(errors).toEqual([]);
    expect(writes).toEqual([]);
    if (process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR) await page.screenshot({ path: resolve(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR, `eta-print-${viewport.width}.png`), fullPage: true });
    console.log(`PASS ${viewport.width} print/table/card/weather/overall timing consistency, no page errors or control writes (analytics heartbeat intercepted)`);
    await page.close();
  }
} finally { await browser.close(); }
