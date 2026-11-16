// Only application-acknowledged cohort samples count as uploaded. New live
// samples do not enlarge the historical cohort or manufacture an ETA.
const count = value => Number.isSafeInteger(value) && value >= 0
export class UploadProgress {
  samples = []
  update(status, now = Date.now()) {
    const cohort = status?.historicalUpload
    const syncing = status?.uploadMode === 'automatic' && status?.connectionState === 'online' && status?.paired === true && status?.recording !== false && status?.available !== false && !status?.recordingError && !status?.persistenceError && status?.queue?.messageCount > 0
    if (!syncing) { this.samples = []; this.id = null; return null }
    const unknown = { percent: null, etaSeconds: null, detail: 'Estimating upload progress', text: 'Syncing saved history' }
    if (!cohort || !cohort.id || cohort.progressKnown === false || status.cohortProgressKnown === false || ![cohort.totalSamples, cohort.uploadedSamples, cohort.remainingSamples, cohort.droppedSamples ?? 0, cohort.excludedSamples ?? 0].every(count) || (cohort.droppedSamples ?? 0) > 0 || cohort.remainingSamples === 0) { this.samples = []; this.id = null; return unknown }
    const total = cohort.totalSamples - (cohort.excludedSamples ?? 0), uploaded = cohort.uploadedSamples
    if (!(total > 0) || uploaded + cohort.remainingSamples !== total) { this.samples = []; return unknown }
    const at = Number.isFinite(status.queueStatsAt) ? status.queueStatsAt : Number.isFinite(status.at) ? status.at : now
    if (at > now + 1000 || now - at > 30000) return unknown
    if (this.id !== cohort.id || this.samples.at(-1)?.uploaded > uploaded || this.samples.at(-1)?.at > at) this.samples = []
    this.id = cohort.id
    if (this.samples.at(-1)?.at !== at) this.samples.push({ at, uploaded })
    this.samples = this.samples.filter(sample => at - sample.at <= 30000)
    const first = this.samples[0], last = this.samples.at(-1)
    const seconds = (last.at - first.at) / 1000, delivered = uploaded - first.uploaded
    const lastChange = this.samples.findLast(sample => sample.uploaded < uploaded)
    const rate = seconds >= 3 && delivered > 0 && lastChange && now - lastChange.at <= 30000 ? delivered / seconds : null
    const etaSeconds = rate ? Math.ceil(cohort.remainingSamples / rate) : null
    const percent = Math.min(99, Math.round(uploaded / total * 100))
    const estimate = etaSeconds === null ? 'Estimating time remaining' : etaSeconds < 60 ? 'Less than a minute left' : 'About ' + Math.ceil(etaSeconds / 60) + ' min left'
    return { percent, etaSeconds, text: 'Syncing — ' + percent + '%', detail: uploaded.toLocaleString() + ' of ' + total.toLocaleString() + ' samples uploaded · ' + estimate }
  }
}
