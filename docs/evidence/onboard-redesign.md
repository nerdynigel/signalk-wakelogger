# Onboard redesign implementation

Implemented the Instrument display, Map + data and Map designs from FigCraft pages 06–08, including the reviewed map-button styling and wind glyphs.

The presentation uses existing sensor freshness, course progress, Race Pack, tracking and Finish trip APIs. Display changes and planned-leg previews do not write navigation or tracking state. The compass card rotates with measured heading; stale heading blanks the readout and true compass overlays are withheld for a magnetic-only reference. Map route/waypoint highlights are magenta. Local logging uses a healthy green sailing-vessel icon; the status dialog retains upload, storage, offline-readiness and finished-trip details and both live-tracking confirmations.

Validation:

- Repository check: lint, type-checking, build, and 364 passing backend tests (one optional broker test skipped).
- All 114 webapp Node tests pass; the standard webapp command now includes every Node webapp test.
- All 69 browser scenarios verified across the full run and focused reruns. Four legacy navigation tests needed to select Map + data before accessing the Race tab after a no-course Instruments start; the corrected scenarios pass. Final redesign checks also verify the phone navigation card and Finish control stay within the viewport.
- Compass test verifies north moves from x=300 to x=65 when heading changes from 0 to 90 degrees, with unchanged COG; stale heading then becomes unavailable.
- Authenticated test-server verification at desktop and phone sizes: all three modes and status dialogs load without page errors or horizontal overflow. View changes produce no recorder/navigation writes (the existing map-readiness reports remain).

Deployment updates only the four webapp assets (HTML, CSS, application module, redesign module). The original public directory and an archive were retained for rollback. Backend package and entry-point hashes and the server start timestamp were unchanged. The existing replay and recording settings were preserved. Live data was stale during verification, and stale values were withheld as designed. This is a test deployment, with no npm publication or production rollout.

## Dial motion and phone density refinement

The dial now retains one SVG and animates only its compass card, upright compass labels and pointer transforms between samples over 900 ms. It follows the shortest angular path through north, retargets from its current interpolated position, and never extrapolates. Numeric readings retain their existing refresh cadence. Expired angles disappear immediately, reference changes snap directly, and reduced-motion preference disables interpolation.

The phone Instruments wheel uses the full content width with an intrinsic square SVG. Its size no longer depends on space left by fixed-height card rows; short screens scroll the instrument panel. SOG/STW cards are shorter on phones and size to content on desktop. True-wind detail rows grow naturally, keep the TWA value together and put TWD on its own row. The Map + data DTW, TTG and ETA font is reduced from 21 to 19 px, with smaller units and additional width for DTW. ETA uses the design's 24-hour clock. Longer TTG values use hours:minutes with an explicit H:M label rather than unbounded minutes.

Verification: all 116 webapp Node tests passed, including interpolation, wraparound, mid-animation retargeting, expiry and reference changes. Twenty focused browser tests passed across phone widths 360/390/430 and desktop widths 800/1280/1440, covering retained SVG identity, observed intermediate animation frames, short-path north crossing, reduced motion, large wind angles, long navigation values, stale sensors and existing display controls. Four final visual checks passed after tightening desktop SOG/STW cards. Public-content, syntax and lint checks passed. Deployment includes the additional dial-motion module and preserves the backend, process and recording settings.

## Leg preview controls, side suffixes and AWA scale

Planned-leg controls no longer contain a duplicate forecast timestamp. A single freshness/source line occupies its own row below the controls. Mobile and narrow tablet layouts give Previous / Next leg a full row of buttons with at least 44 px height; wide desktop layouts retain a dedicated action column. Preview reading widths are allocated separately from the controls.

Live AWA/TWA, heel and planned wind values consistently use PT/STB. On phones those suffixes are smaller text following the value, including in the Race panel, instead of taking space in the heading. Neutral zero/180-degree wind angles retain their neutral meaning; geographic N/S/E/W references are unchanged. Inner AWA ring labels increase from 12 to 20 SVG pixels on desktop and from 14 to 22 on mobile, with the 180-degree label and tick white.

All 116 webapp Node tests, 13 focused browser scenarios, and the repository's 364 backend tests passed (one optional broker test skipped). Layout checks cover all three display modes at 360/390/800/1440 px, source text below the action buttons, button dimensions, reading containment, smaller side suffixes and AWA label size/colour. Source safety, syntax, lint, type-checking and build checks passed. The generated fixture manifest records the updated wind readout formatter hash; the guidance core is unchanged. Test deployment includes the updated wind-readout module and retains the prior public directory for rollback.

## Dial labels and FigCraft synchronization

Outer compass labels now match the inner AWA labels in font family, size and weight: 20 SVG units / 500 on desktop, 22 / 500 in the phone Instrument view. Non-north compass labels and the neutral inner 180-degree label are white; north retains cyan. The magenta bearing line extends to the arrow tip in the same rotating group. The heading readout contains only the degree value, positioned at the former label height with no box or background; the heading reference remains available in its title and accessible description.

All 116 Node webapp tests and 14 focused browser checks passed for the final source. Browser coverage includes matching computed dial fonts, pointer attachment, the bare heading readout, animation, phone layout, navigation values and leg-preview controls. The authenticated OpenClaw check covered all three views and status dialogs at 1440 and 390 px without page errors or horizontal overflow. All six deployed asset hashes match the tested build. The test deployment retained its previous public directory; backend hashes match and the server was not restarted.

The live `wakelogger.figcraft` design document was updated through MCP and saved. All 18 redesigned screens on pages 06–08 were synchronized, including four Instrument status variants and both leg-preview variants. Read-back verified matching label styles and a white inner 180-degree label on every dial, hidden heading labels and removed heading boxes, consistent PT/STB text, and 19 px phone DTW/TTG/ETA values. Phone speed cards are 72 px high; the dial bezel is 334 px wide; true-wind details occupy separate rows. Planned-leg controls have their own row with the forecast timestamp below. The phone preview artboard shows expanded scroll content. Map variants share magenta active-leg/mark styling, measured vessel heading and wind glyphs; healthy local logging uses the green vessel icon.

Updated frame IDs: 3098, 3100, 3353, 3494, 5209, 5383, 3715, 5551, 3835, 3837, 4468, 4291, 4114, 4833, 4739, 4645, 5670, 5847. Design review exports and authenticated application screenshots remain in the local design workspace. Public App Store screenshots are packaged under `assets/screenshots/`.
