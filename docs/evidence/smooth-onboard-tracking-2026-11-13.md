# Smooth onboard tracking — 13 November 2026

Branch: `fix/smooth-onboard-tracking`.

The course poll recreated the marker at its raw fix every three seconds, while instrument polls snapped it between positions. Keep the marker alive and reuse the website's display-only motion model. Animate position and heading along the shortest angular arc, with guide origins following the displayed bow. Recorded track samples remain unchanged.

Instrument reads run every second using the existing single-flight request and timeout protection. Ignore older fixes and implausible GPS jumps; reconnects start at their accepted position. Respect reduced motion and suspend animation in hidden tabs. Guidance retains its existing freshness and sailing-mode rules.

Centre vessel selects gentle follow, warming up across three distinct fixes before adding a filtered direction-of-travel view ahead. Fit course, Fit track, drag and zoom retain viewer control. Explicit fits stop an in-progress follow pan.

Validation: 75 focused Node tests, lint, typecheck and build passed. Browser checks cover interpolation, persistent marker identity across course polls, GPS spike rejection, gentle follow, explicit viewport choices, manual dragging, GPS-only marker, whole-trip framing, resize/fullscreen, desktop/mobile heading and maneuver overlays, and source-age expiry.

Test deployment uses a locally packed beta.15 package in `signalk-dev`; no npm publication or default-branch merge.

Installed `public/app.mjs` SHA-256: `e01b7e1fa639ea7277047b045d358bab285a2e9696f7303386787dccecf66178`. Motion module hash: `2896b6f82ee4dd78256e25db314a89c2d720611df545b528c9994444dd4d4673`. Both match the built files. Live Moreton Bay replay browser probe: 387 frames, 321 unique displayed positions in ten seconds, unchanged marker identity, follow mode and no page errors. Screenshots: `/tmp/plugin-smoothing-desktop.png`, `/tmp/plugin-smoothing-mobile.png`; probe results: `/tmp/plugin-smoothing-live.json`.

Follow-up: vessel guide rays use the marker’s rounded screen position and the exact arrow-tip offset; projected directions translate with the marker rather than being reprojected geographically every frame. Corrected the triangle width to match its anchor. Automated movement/pan checks keep both heading and tack origins within 1.5 px of the bow. Live replay measurement improved from a maximum 7.39 px gap to 0.64 px across 290 frames. Follow view recentres on resize; track/course views retain their framing. Final stylesheet SHA-256: `a3a33fe72a8126432ace8202067a91a44b14981a889be95adc732f86b4f714f4`. Installed script and stylesheet hashes match.
