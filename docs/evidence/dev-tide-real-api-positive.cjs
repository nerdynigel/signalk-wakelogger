// THE-882 real-API positive tide page proof: served website rendered against the
// real isolated API fixture (no mocks), desktop + mobile. Persisted values are
// placeholder-sanitized so no DEV host address enters the public repository.
const fs = require('fs');
const { chromium, expect } = require('@playwright/test');
const sanitize = value => String(value).replace(/https?:\/\/[^/\s"']+/g, 'http://dev-web:3010');
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const R = { at: new Date().toISOString(), synthetic: true, url: sanitize(input.url), expected: input.expected, viewports: [], ok: false };
  try {
    for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
      const V = { viewport: `${viewport.width}x${viewport.height}`, pageErrors: [], consoleErrors: [], writes: [], failed: [] };
      const page = await browser.newPage({ viewport });
      page.on('pageerror', error => V.pageErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') V.consoleErrors.push(message.text().slice(0, 200)); });
      page.on('request', request => {
        if (request.method() === 'GET') return;
        const path = new URL(request.url()).pathname;
        if (['/v1/auth/session/renew-live', '/v1/analytics/heartbeat'].some(allowed => path.includes(allowed))) return;
        V.writes.push(request.method() + ' ' + path);
      });
      await page.addInitScript(token => localStorage.setItem('wakelogger_auth_token', token), input.token);
      await page.goto(input.url);
      const card = page.getByTestId(input.expected.voyageCard);
      await expect(card).toBeVisible({ timeout: 45000 });
      const tide = card.locator('xpath=ancestor::article').getByTestId('trip-tide-card');
      await expect(tide).toBeVisible({ timeout: 15000 });
      await expect(tide).toHaveAttribute('data-tide-source', 'voyage');
      await expect(tide.locator('svg path').first()).toBeVisible();
      await expect(tide.locator('polyline').first()).toBeVisible();
      await expect(tide.getByTestId('trip-tide-marker-edge')).toHaveCount(2);
      await expect(tide.getByTestId('trip-tide-marker-edge').first()).toBeVisible();
      await expect(tide.getByTestId('trip-tide-marker-edge').last()).toBeVisible();
      const text = (await tide.innerText()).replace(/\s+/g, ' ').toLowerCase();
      for (const needle of [...input.expected.heights, input.expected.diff, ...input.expected.eventKinds]) {
        expect(text).toContain(needle.toLowerCase());
      }
      V.tideText = text.slice(0, 600);
      V.tideSource = await tide.getAttribute('data-tide-source');
      V.markerEdges = await tide.getByTestId('trip-tide-marker-edge').count();
      V.markerTestids = await tide.locator('[data-testid]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')));
      V.svgPaths = await tide.locator('svg path').count();
      V.provenance = await tide.getByTestId('trip-tide-provenance').count();
      expect(V.markerTestids.some(id => id.startsWith('trip-tide-marker-during-high-'))).toBe(true);
      expect(V.provenance).toBe(0);
      expect(V.pageErrors).toEqual([]);
      expect(V.consoleErrors).toEqual([]);
      expect(V.writes).toEqual([]);
      await page.screenshot({ path: `docs/evidence/dev-tide-real-api-positive-${viewport.width}.png`, fullPage: true });
      V.pageErrors = V.pageErrors.map(sanitize);
      V.consoleErrors = V.consoleErrors.map(sanitize);
      V.writes = V.writes.map(sanitize);
      R.viewports.push(V);
      await page.close();
      console.log(`PASS ${V.viewport}: real-API voyage4 tide card, numeric high/low/graphics, markers, no errors/writes`);
    }
    R.ok = true;
    fs.writeFileSync('docs/evidence/dev-tide-real-api-positive-page.json', JSON.stringify(R, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(String(error.message).replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').slice(0, 400)); process.exitCode = 1; });
