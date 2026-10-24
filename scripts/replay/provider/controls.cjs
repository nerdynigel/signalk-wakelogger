const fs = require('node:fs');
const path = require('node:path');
function renderControls(webUrl) {
  const url = new URL(webUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid test website URL');
  const href = url.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return fs.readFileSync(path.join(__dirname, 'controls.html'), 'utf8').replace('__WEB_URL__', href);
}
module.exports = { renderControls };
