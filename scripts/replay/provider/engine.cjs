function rebaseDelta(event, anchorWall, anchorSource) {
  const delta = structuredClone(event.delta);
  const at = anchorWall + event.sourceTimeMs - anchorSource;
  for (const update of delta.updates) {
    update.timestamp = new Date(at).toISOString();
    update.source = {...update.source, label:'real-trip-48-replay'};
    for (const value of update.values) {
      if (/(^|\.)datetime$/i.test(value.path) && typeof value.value === 'string') {
        const recorded = Date.parse(value.value);
        if (!Number.isFinite(recorded)) throw new Error(`Invalid embedded clock: ${value.path}`);
        value.value = new Date(anchorWall + recorded - anchorSource).toISOString();
      }
    }
  }
  return delta;
}

class ReplayEngine {
  constructor(events, emit, clock = Date.now) {
    if (!events.length || events.some((e,i)=>!Number.isFinite(e.sourceTimeMs) || i && e.sourceTimeMs<events[i-1].sourceTimeMs)) throw new Error('Ordered source events required');
    this.events = events; this.emit = emit; this.clock = clock;
    this.cursor = 0; this.state = 'paused'; this.sourceCursor = events[0].sourceTimeMs;
    this.anchorWall = clock(); this.anchorSource = this.sourceCursor;
    this.maxLagMs = 0; this.pauseReason = 'Ready; start playback';
  }
  start() {
    if (this.state === 'ended') throw new Error('Replay ended; finish the trip and create a fresh run');
    if (this.state === 'running') return;
    this.anchorSource = this.sourceCursor;
    this.anchorWall = this.clock(); this.state = 'running'; this.pauseReason = null;
  }
  pause(reason = 'Paused by operator') {
    if (this.state === 'running') this.sourceCursor = this.anchorSource + this.clock() - this.anchorWall;
    if (this.state !== 'ended') this.state = 'paused';
    this.pauseReason = reason;
  }
  stop() { this.pause('Stopped by operator'); if (this.state !== 'ended') this.state = 'stopped'; }
  tick() {
    if (this.state !== 'running') return;
    const now = this.clock(), sourceNow = this.anchorSource + now - this.anchorWall;
    const lag = Math.max(0, sourceNow-this.events[this.cursor].sourceTimeMs);
    this.maxLagMs = Math.max(this.maxLagMs, lag);
    if (lag > 1000) {
      this.sourceCursor = this.events[this.cursor].sourceTimeMs;
      this.state = 'paused'; this.pauseReason = 'Scheduler lag exceeded 1 second; resume to rebase without a burst';
      return;
    }
    while (this.cursor < this.events.length && this.events[this.cursor].sourceTimeMs <= sourceNow) {
      const event = this.events[this.cursor++];
      const delta = rebaseDelta(event, this.anchorWall, this.anchorSource);
      this.emit(delta, event);
    }
    this.sourceCursor = sourceNow;
    if (this.cursor === this.events.length) { this.state = 'ended'; this.pauseReason = 'End of recorded data; finish the test trip in Wake Logger'; }
  }
  status() {
    const at = this.state === 'running' ? this.anchorSource + this.clock()-this.anchorWall : this.sourceCursor;
    return {state:this.state,reason:this.pauseReason,cursor:this.cursor,total:this.events.length,
      sourceTime:new Date(at).toISOString(),sourceTimeMs:at,wallTime:new Date(this.clock()).toISOString(),
      firstSourceTime:new Date(this.events[0].sourceTimeMs).toISOString(),
      lastSourceTime:new Date(this.events.at(-1).sourceTimeMs).toISOString(),maxLagMs:this.maxLagMs};
  }
}
module.exports = {ReplayEngine,rebaseDelta};
