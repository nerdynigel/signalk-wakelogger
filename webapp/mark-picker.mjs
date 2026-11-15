const element = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text != null) node.textContent = text; return node }
export const markLabel = (index, count, reverse = false) => index === 0 ? reverse ? 'F' : 'S' : index === count - 1 ? reverse ? 'S' : 'F' : String(index)
export const courseSelectionKey = (status, progress) => JSON.stringify([(status?.desired ?? status?.cachedCourse)?.courseId, (status?.desired ?? status?.cachedCourse)?.revision, status?.native?.course?.activeRoute?.href, progress?.reverse, progress?.points?.map(p => [p.id, p.name, p.latitude, p.longitude])])
export class MarkPicker {
  constructor({ dialog, card, getState, setPoint, advance, onMapSelection, layout, distance }) {
    Object.assign(this, { dialog, card, getState, setPoint, advance, onMapSelection, layout, distance })
    this.selected = null; this.mapIndex = null
    const heading = element('div', 'dialog-heading'), title = element('h2', '', 'Next mark'), close = element('button', '', 'Close')
    title.id = 'mark-picker-title'; close.type = 'button'; close.onclick = () => dialog.close(); heading.append(title, close)
    const help = element('p', 'mark-picker-help', 'Choose a mark, then Set point. Advance point steps to the mark after the current one.')
    this.list = element('div', 'mark-picker-list'); this.list.setAttribute('role', 'listbox'); this.list.setAttribute('aria-label', 'Course marks')
    this.error = element('p', 'mark-picker-error'); this.error.setAttribute('role', 'alert')
    const actions = element('div', 'mark-picker-actions')
    this.setButton = element('button', '', 'Set point'); this.advanceButton = element('button', 'primary', 'Advance point')
    this.setButton.onclick = () => this.execute(false); this.advanceButton.onclick = () => this.execute(true)
    actions.append(this.setButton, this.advanceButton); dialog.append(heading, help, this.list, this.error, actions)
    dialog.addEventListener('close', () => { document.body.classList.remove('mark-picker-open'); this.selected = null; this.error.textContent = '' })
    const row = element('div', 'map-mark-heading'); this.cardTitle = element('strong', ''); const dismiss = element('button', '', '×')
    dismiss.setAttribute('aria-label', 'Close selected mark'); dismiss.onclick = () => this.clearMap(); row.append(this.cardTitle, dismiss)
    this.cardDetail = element('span', 'map-mark-detail'); this.cardButton = element('button', 'primary', 'Set as next mark')
    this.cardError = element('p', 'mark-picker-error'); this.cardError.setAttribute('role', 'alert'); this.cardButton.onclick = () => this.execute(false, true)
    card.append(row, this.cardDetail, this.cardButton, this.cardError)
  }
  open() {
    const state = this.getState()
    if (!state.points.length) return
    this.context = state.key; this.openIndex = state.index; this.selected = state.index ?? 0; this.signature = null
    this.error.textContent = ''; this.render(); document.body.classList.add('mark-picker-open'); this.dialog.showModal()
    this.list.querySelector('[aria-selected="true"]')?.focus()
  }
  selectMap(index) {
    const state = this.getState()
    this.mapContext = state.key; this.mapIndex = index; this.cardError.textContent = ''
    this.onMapSelection(index); this.render(); this.layout()
  }
  clearMap() { this.mapIndex = null; this.card.hidden = true; this.onMapSelection(null) }
  render() {
    const state = this.getState(), canChange = state.available && !state.busy
    if (this.dialog.open && (this.context !== state.key || this.openIndex !== state.index)) this.dialog.close()
    if (this.mapIndex !== null && (this.mapContext !== state.key || !state.points[this.mapIndex])) this.clearMap()
    if (this.selected !== null) {
      const signature = JSON.stringify([state.key, state.index, this.selected, canChange])
      if (this.signature !== signature) {
        const focus = this.list.contains(document.activeElement) ? document.activeElement.dataset.index : null
        this.signature = signature
        this.list.replaceChildren(...state.points.map((point, index) => {
          const row = element('button', 'mark-picker-row' + (index === state.index ? ' current' : state.index !== null && index < state.index ? ' passed' : ''))
          row.type = 'button'; row.dataset.index = index; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === this.selected)); row.disabled = state.busy
          row.append(element('span', 'mark-badge', markLabel(index, state.points.length, state.reverse)), element('span', 'mark-picker-name', point.name || 'Course point'))
          row.append(element('small', 'mark-picker-tag', index === state.index ? 'NEXT' : state.index !== null && index < state.index ? 'PASSED' : ''))
          const check = element('span', 'mark-picker-selected', index === this.selected ? '✓' : ''); check.setAttribute('aria-hidden', 'true'); row.append(check)
          row.onclick = () => { this.selected = index; this.render(); this.list.querySelector('[aria-selected="true"]')?.focus() }
          row.onkeydown = event => {
            const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
            const target = event.key === 'Home' ? 0 : event.key === 'End' ? state.points.length - 1 : step ? Math.max(0, Math.min(state.points.length - 1, index + step)) : null
            if (target !== null) { event.preventDefault(); this.selected = target; this.render(); this.list.querySelector('[aria-selected="true"]')?.focus() }
          }
          return row
        }))
        if (focus !== null) this.list.querySelector('[data-index="' + focus + '"]')?.focus()
      }
      this.setButton.disabled = !canChange || !Number.isInteger(this.selected)
      this.advanceButton.disabled = !canChange || state.index === null || state.index >= state.points.length - 1
      if (!state.available && !this.error.textContent) this.error.textContent = 'Activate this course in Course before changing its next mark.'
    }
    const point = state.points[this.mapIndex]
    this.card.hidden = !point
    if (point) {
      this.cardTitle.textContent = markLabel(this.mapIndex, state.points.length, state.reverse) + ' · ' + (point.name || 'Course point')
      this.cardDetail.textContent = this.distance(point)
      this.cardButton.disabled = !canChange
      if (!state.available && !this.cardError.textContent) this.cardError.textContent = 'Activate this course in Course before changing its next mark.'
    }
  }
  reportError(message) { (this.mapAction ? this.cardError : this.error).textContent = message }
  async execute(advance, fromMap = false) {
    const state = this.getState(), expected = fromMap ? this.mapContext : this.context, index = fromMap ? this.mapIndex : this.selected
    if (!state.available || state.busy || state.key !== expected || !fromMap && state.index !== this.openIndex) return
    this.mapAction = fromMap; this.error.textContent = ''; this.cardError.textContent = ''
    const success = await (advance ? this.advance() : this.setPoint(index))
    if (success) { if (this.dialog.open) this.dialog.close(); this.clearMap() }
  }
}
