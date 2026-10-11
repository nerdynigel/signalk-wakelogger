# Racing overlays — plugin source checkpoint (THE-880)

Repository `nerdynigel/signalk-wakelogger`, workspace
`4de0cc0f-95fe-4135-ad51-b3e73b77de8b`, linked `.worktrees/THE-884`;
branch `release/2026-w42`, [draft PR #22](https://github.com/nerdynigel/signalk-wakelogger/pull/22),
base `main`. Starting head `a425020248bf312063e29693536ffb8f3f7b8d67`.
Final browser/UI source **c5e20d168621843c895d9acc56e49c36860acc62**. Guide/instrument core and native replay tested at **623e55e6cc44c68bcc133fe24aa31039f966354e**.
Companion website source **0a632f1dd063f441e8d97e55a82df057faaaf200**,
[PR #81](https://github.com/nerdynigel/wakelogger/pull/81).

## Diagnosis and correction

`webapp/app.mjs:renderVesselGuides` and `vessel-guides.mjs:vesselGuideBearings`
already draw heading and a dashed mirrored tack/gybe ray using the chartplotter's
boat-bow-origin / bearing-guide pattern. No missing component or feature flag was
found in release source. The calculator only accepted fresh apparent AWS/AWA and
COG/SOG. Executing the starting helper with fresh position, true heading 330°
and direct ground wind 12 kn/0° produced heading 330° and null maneuver bearing.
It now produces a labelled port tack ray at 30°. Unknown/magnetic/stale heading
still suppresses guides deliberately; historical incident attribution requires
the owner's actual inputs and deployed revision and remains unconfirmed.

`instrumentReadings` now supplies a separate `guideWind` object referencing its
existing measured ground speed, absolute true direction and ground TWA. This
keeps displayed water TWS independent and avoids adding duplicate instrument
tiles. The guide accepts a fresh measured ground vector or measured ground TWA
with measured ground speed, then falls back to the existing shared true-wind
helper for fresh apparent plus ground motion. It never pairs water TWS with a
ground direction, invents timestamps or uses forecast/polars. Direct calm ground
wind suppresses estimates. All used measurements require source timestamps,
existing 30-second freshness and maximum 10-second skew. Missing/failed
environment response suppresses estimates while fresh heading survives.

Both surfaces mirror the current true wind angle:
`opposite = wrap360(2*trueWindFrom - trueHeading)`. SI radians/m/s are converted
once by the instrument module to degrees true/knots. Signed TWA >0 means
starboard; the opposite ray is port. Eligibility matches the established web
chartplotter: derived mode apparent angle 20..<60° with upwind true angle <90°;
direct mode true angle 20..<90°; gybe true angle >100..<175°. Known opposite-type
active legs, reaching/dead run and calm inputs suppress estimates. Lines are
estimates without speed-change/tide/leeway correction, not polar laylines or
manoeuvre advice. Visible legend and tooltips explain basis and sides. Heading
unavailability explicitly names the fresh GPS/true-heading requirement.

A final screenshot review identified a second concrete heading-visibility cause:
without a course or saved history the plugin remained at world zoom, so rendered
rays and the vessel could be offscreen. The guide legend also sat outside the
100%-height map and was clipped. First fresh GPS/true-heading now frames the
vessel once when no course/track exists and the viewport is still automatic;
subsequent updates do not reframe user choices. The legend is positioned inside
the map. The seven affected browser checks were rerun at the final source,
including zoom 13 and an actual vessel rectangle contained within the viewport.
Screenshots now show both visible rays and the legend; the earlier blank
screenshots are superseded. `npm run build:webapp`, lint and diff checks passed.
The guide/instrument modules did not change, so the exact packaged native replay
above remains core evidence at its stated source rather than a claimed repeat.

## Executed validation

Node `/home/nigel/.nvm/versions/node/v24.21.0/bin/node` (24.21.0), with its directory
on PATH for npm/Playwright subprocesses; no package or host service installation.

| Requirement / boundary | Command / result |
| --- | --- |
| Instrument and guide behavior | `node --test test/webapp/services.test.mjs`: **43 passed**, including direct ground vector/TWA, separate water readout, fresh/unknown/stale/skew/reference/nonfinite inputs, direct/derived port/starboard, wrap, active-leg guards, calm/reaching/dead run and prior course/TWA/VMG/Finish/authority behavior |
| Packaged assets/build | `npm run build`: **exit 0**, TypeScript plus copied public webapp/Leaflet assets; public/dist remain generated and ignored |
| Actual-page affected regression | `PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright node node_modules/@playwright/test/cli.js test --config test/webapp/playwright.config.mjs --grep 'direct ground wind overlays|mirrored tack and gybe|course progress changes|advances native|rounding|Finish trip saves'`: **7 passed** |
| Desktop/mobile direct rendering | Actual plugin page with routed fresh SI REST fixtures, 1280x800 and 390x844: true heading 330°, tack 30°, heading/side change 30→330, gybe 130→230, changed TWD 10→250, zoom/fullscreen, environment 503 suppression/recovery, stale/unknown GPS-heading suppression, recovery/reload, no native writes |
| Screenshot rerun | Same command with `--grep 'direct ground wind overlays'`: **2 passed** after adding screenshots; no runtime change. [Desktop](overlays/direct-ground-gybe-1280.png), [mobile](overlays/direct-ground-gybe-390.png) |
| Native disposable flow | `WAKELOGGER_DOCKER_PROJECT=signalk-wakelogger-the880-overlays node scripts/test-signalk-docker.mjs`: **exit 0**, rebuilt packaged Signal K 2.31.1/local TLS MQTT/mock cloud stack; normal tracking/reconnect/native navigation/progress/Finish regressions also executed |
| Hygiene | `npm run lint`, `npm run check:public`, `git diff --check`: **exit 0** |

Native overlay observation: actual REST inputs at bundled replay source clock
`2014-08-15T19:00:01.879Z` yielded heading **201.1024565129676°**, opposite tack
**351.0167334389364°**, current side **starboard**. The served packaged guide and
instrument modules exactly matched tested source bytes; mirror identity was
asserted independently. Removing true heading rejects heading; wall-clock age
rejects both; evaluating fresh replay readings again restores the estimate.
The packaged test added this proof without weakening freshness. This is native
HTTP/replay evidence, not current-vessel/Openclaw input or a native browser flow.
Direct positive UI proof uses routed fixtures; native replay uses apparent mode.

Browser checks use real 2-second instrument polling; they do not establish
current vessel cadence or a single cloud/plugin/browser stream. Playwright owns
and stops the loopback server. Native test tears down only its own disposable
stack and volumes; build/test log stays in run scratch, not Git. Generated
assets, dependencies, traces and other-task WIP were excluded. Existing
NO_COLOR/FORCE_COLOR and npm-version notices remain. Per-command Git author
settings restored the prior Software identity after an unset-identity failure.

## Remaining gates and rollback

This is a source/local checkpoint, not complete original acceptance.
Chief → independent Verification → Chief review remains; final frozen
Openclaw/current-vessel positive/negative/recovery proof and one cross-repository
current-input stream await candidate freeze and owner Go. Software retains
implementation proof; independent acceptance adds a gate. Earlier tracking,
TWA/VMG/Finish/course-progress final holds remain. No Openclaw switch, deployment,
production mutation, merge, npm, paid CI or per-task PR occurred.

Rollback: reviewed revert of `c5e20d168621843c895d9acc56e49c36860acc62` followed by `623e55e6cc44c68bcc133fe24aa31039f966354e` and rebuild
public assets, plus companion web source revert. No migrations/data rewrites.
