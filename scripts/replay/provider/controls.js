const base = '/plugins/wakelogger-real-trip-replay/';
const start = document.querySelector('#start'), pause = document.querySelector('#pause');
let busy = false, replay, tracking, refreshing = false;
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.detail || value.error || `Request failed (${response.status})`);
  return value;
}
document.querySelector('#confirm-cancel').onclick = () => document.querySelector('#confirm-start').close('cancel');
document.querySelector('#confirm-enable').onclick = () => document.querySelector('#confirm-start').close('start');
function confirmStart() {
  const dialog = document.querySelector('#confirm-start');
  return new Promise(resolve => {
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'start'), { once: true });
    dialog.showModal();
  });
}
const post = (url, body) => request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function render() {
  if (!replay || !tracking) return;
  const running = replay.state === 'running', ended = replay.state === 'ended';
  const ready = tracking.paired && tracking.available;
  start.textContent = ended ? 'Replay complete' : running ? 'Running' : replay.cursor ? 'Resume test' : 'Start test';
  start.disabled = busy || !ready || running || ended;
  pause.disabled = busy || !running;
  document.querySelector('#status').textContent = ended ? 'Replay complete' : running ? 'Playing' : replay.cursor ? 'Paused' : 'Ready';
  document.querySelector('#live').textContent = !ready ? 'Onboard connection unavailable' : tracking.uploadMode === 'automatic' ? 'Live tracking on' : 'Live tracking off';
  document.querySelector('#progress').max = replay.total;
  document.querySelector('#progress').value = replay.cursor;
  document.querySelector('#clock').textContent = `${new Date(replay.sourceTime).toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' })} · ${replay.cursor.toLocaleString()} / ${replay.total.toLocaleString()} messages`;
}
async function refresh() {
  if (refreshing || busy) return;
  refreshing = true;
  try {
    [replay, tracking] = await Promise.all([request(base + 'status'), request('/plugins/signalk-wakelogger/tracking')]);
    render();
  } catch (error) {
    start.disabled = true; pause.disabled = true;
    document.querySelector('#error').textContent = error.message;
  } finally { refreshing = false; }
}
start.onclick = async () => {
  if (busy) return;
  busy = true; render(); document.querySelector('#error').textContent = '';
  try {
    tracking = await request('/plugins/signalk-wakelogger/tracking');
    if (tracking.uploadMode !== 'automatic') {
      if (!await confirmStart()) return;
      tracking = await post('/plugins/signalk-wakelogger/tracking', { uploadMode: 'automatic', confirmed: true, expectedUploadMode: tracking.uploadMode });
      if (tracking.uploadMode !== 'automatic' || tracking.persistenceError) throw new Error(tracking.persistenceError || 'Live tracking was not enabled');
    }
    replay = await post(base + 'control', { action: 'start' });
  } catch (error) { document.querySelector('#error').textContent = error.message; }
  finally { busy = false; render(); }
};
pause.onclick = async () => {
  if (busy) return;
  busy = true; render(); document.querySelector('#error').textContent = '';
  try { replay = await post(base + 'control', { action: 'pause' }); }
  catch (error) { document.querySelector('#error').textContent = error.message; }
  finally { busy = false; render(); }
};
refresh(); setInterval(refresh, 1000);
