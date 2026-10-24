const base = '/plugins/wakelogger-real-trip-replay/';
const start = document.querySelector('#start'), pause = document.querySelector('#pause'), stop = document.querySelector('#stop'), restart = document.querySelector('#restart');
let busy = false, replay, tracking, refreshing = false;
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.detail || value.error || `Request failed (${response.status})`);
  return value;
}
document.querySelector('#confirm-cancel').onclick = () => document.querySelector('#confirm-start').close('cancel');
document.querySelector('#confirm-enable').onclick = () => document.querySelector('#confirm-start').close('start');
function confirmAction(title = 'Start test replay?', label = 'Start and enable Live tracking') {
  document.querySelector('#confirm-title').textContent = title;
  document.querySelector('#confirm-enable').textContent = label;
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
  const stopped = replay.state === 'stopped', locked = busy || replay.busy;
  const lifecycle = replay.capabilities?.tripLifecycle === true;
  const newTrip = lifecycle && (replay.restartRequired || ended || stopped || replay.cursor > 0 && !tracking.trackingSessionId);
  const ready = tracking.paired && tracking.available;
  start.textContent = running ? 'Running' : replay.cursor && !newTrip ? 'Resume test' : 'Start test';
  start.hidden = newTrip; restart.hidden = !lifecycle || !newTrip && !replay.cursor; stop.hidden = !lifecycle;
  start.disabled = locked || !ready || running || ended;
  pause.disabled = locked || !running;
  stop.disabled = locked || !ready || !tracking.trackingSessionId;
  restart.disabled = locked || !ready;
  document.querySelector('#status').textContent = replay.busy ? ({start:'Starting…',resume:'Resuming…',restart:'Restarting…',stop:'Saving trip…',pause:'Pausing…'}[replay.operation] || 'Working…') : ended ? 'Replay complete' : stopped ? 'Stopped' : running ? 'Playing' : replay.cursor ? 'Paused' : 'Ready';
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
    start.disabled = true; pause.disabled = true; stop.disabled = true; restart.disabled = true;
    document.querySelector('#error').textContent = error.message;
  } finally { refreshing = false; }
}
start.onclick = async () => {
  if (busy) return;
  busy = true; render(); document.querySelector('#error').textContent = '';
  try {
    tracking = await request('/plugins/signalk-wakelogger/tracking');
    if (tracking.uploadMode !== 'automatic') {
      if (!await confirmAction()) return;
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

stop.onclick = async () => {
  if (busy) return;
  busy = true; render(); document.querySelector('#error').textContent = '';
  try {
    if (!await confirmAction('Stop this test trip?', 'Stop and save trip')) return;
    replay = await post(base + 'control', { action: 'stop', confirmed: true });
    tracking = await request('/plugins/signalk-wakelogger/tracking');
  } catch (error) { document.querySelector('#error').textContent = error.message; }
  finally { busy = false; render(); }
};
restart.onclick = async () => {
  if (busy) return;
  busy = true; render(); document.querySelector('#error').textContent = '';
  try {
    tracking = await request('/plugins/signalk-wakelogger/tracking');
    const label = tracking.uploadMode === 'automatic' ? 'Save trip and restart' : 'Enable Live tracking and restart';
    if (!await confirmAction('Restart from the beginning?', label)) return;
    if (tracking.uploadMode !== 'automatic') {
      tracking = await post('/plugins/signalk-wakelogger/tracking', { uploadMode: 'automatic', confirmed: true, expectedUploadMode: tracking.uploadMode });
      if (tracking.uploadMode !== 'automatic' || tracking.persistenceError) throw new Error(tracking.persistenceError || 'Live tracking was not enabled');
    }
    replay = await post(base + 'control', { action: 'restart', confirmed: true });
    tracking = await request('/plugins/signalk-wakelogger/tracking');
  } catch (error) { document.querySelector('#error').textContent = error.message; }
  finally { busy = false; render(); }
};
