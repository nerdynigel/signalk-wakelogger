# FigCraft redesign refinements

Started from a clean, freshly pulled `main` at `e8df11a`, on branch `feat/figcraft-redesign-refinements`.

The live design review covered redesign pages 06–08, including comments 23 and 35–43. Wind flow follows the detailed development note in frame 6532; the Race picker follows frames 6181/6329, map-mark selection follows 4291/4739, and syncing status follows 6564/6734. The source implements the final corrected wind hierarchy: speed remains largest, with enlarged angles underneath and phone TWD beside the speed. True-wind basis remains in the reading metadata and title.

## Wind field

One canvas in a dedicated Leaflet pane sits above tiles and below route, track, marks, vessel and A/T glyphs. Its origin compensates for map translation, so the jittered screen-space grid stays aligned and its count does not change when panning or zooming. The same layer serves both map display modes and every Map + data tab, on desktop and phone.

TWD is converted from a wind-from bearing to a downwind bearing. A circular ten-second sample average avoids north-crossing jumps; TWS uses the same ten-second sample window. Source timestamps are deduplicated, and new samples interpolate over 900 ms. Four-second arrow lifetimes have 600 ms fades at each end and staggered respawns. Wind strength interpolates length, opacity, stroke and drift between the design's 2/8/16/25-knot anchors. Counts remain independent of wind strength.

Below two knots, arrows are replaced with Calm. At source age greater than ten seconds, drift stops and opacity drops to 15%; at thirty seconds the field hides. Reduced motion disables drift and fades. Hidden tabs and the Instruments view stop the animation loop. The weather illustration never changes navigation calculations or published guidance.

## Navigation and status

The Race picker is a desktop popover or phone bottom sheet. Marks identify passed/current/selected states, support keyboard selection, and reuse the existing guarded native course commands. Advance always advances the active point rather than the highlighted selection. Selecting a map mark opens a preview with fresh-position distance/bearing and an explicit Set as next mark action. A changed route/revision/direction/geometry invalidates the selection; a changed active point closes an open picker. Foreign active routes and native failures retain the existing route checks and present an inline error. Merely opening or selecting never writes navigation state.

The Course panel keeps its selector and Set point / Advance point controls. The activation heading/status/button hide only when the selected course is active and has no pending or rejected delivery.

The cloud outline uses the centred vector geometry from the design. Syncing uses an amber upload icon and progress bar. Progress counts only application-acknowledged samples in a fixed historical-upload cohort, excluding positively identified non-trip records. Losses or unknown totals remain indeterminate. Remaining time requires observed acknowledged throughput; pauses, counter regressions, cohort changes and stale status reset or withhold it. Finished-trip cloud confirmation stays separate.

## Validation

- `npm run check`: public-content, lint, type checking and build pass; 384 backend tests pass, with three optional tests skipped.
- All 122 Node webapp tests pass, including north wraparound, strength interpolation, source-clock expiry, reduced motion, cohort exclusions/losses and ETA reset behavior.
- The full browser run passed 90 of 91 scenarios. The remaining scenario exposed a test reading an element while live rendering replaced it; an atomic, retrying style assertion corrected that race. The final focused run passed all 18 affected scenarios, verifying all 91 distinct scenarios across the full run and focused rerun.
- A further five focused checks passed after tightening Calm-label placement and fresh-position map-card details. These also verify explicit Set point and Advance point behavior on desktop and phone.
- Coverage includes widths 360/390/800/1440, pane ordering, field alignment/count through viewport changes, stale/calm/reduced-motion states, larger angles, sync completion and icon centring, course-context invalidation and foreign-route rejection.

The work remains on the feature branch; no package version or release tag is changed.
