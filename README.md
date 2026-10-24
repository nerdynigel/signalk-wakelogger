# Wake Logger for Signal K

**Keep a record of your time on the water—even when you leave internet coverage.**

[Wake Logger](https://wakelogger.com/) connects your boat's Signal K data to live vessel tracking and trip history. Record your outings, review your route afterward, and share the experience with authorised crew. Bring a selected race course onboard and follow it on a map using the navigation data already available on your boat.

## What you can do

- **Track your boat live.** See its latest position, speed, heading, depth and apparent wind in Wake Logger when those sensors and an internet connection are available.
- **Record without uploading.** Keep recording during an internet outage, or choose when uploads are allowed. Upload stored history when you reconnect.
- **Review your trips.** Return to your route and recorded navigation data after the outing. With the supporting Wake Logger update, see upload progress and when a trip is being processed.
- **Take your race course with you.** Download the selected course before departure and retain it onboard through internet outages and restarts.
- **Use an onboard map.** View your boat, course, marks and current leg on a phone or tablet connected to the boat's Signal K server.

This is a **beta release**. Upload progress and course synchronisation need the supporting Wake Logger service update. If those controls are not yet available in your account, contact Wake Logger support.

## What you need

- A running Signal K server receiving your boat's position. Other navigation sensors are optional.
- A Wake Logger account with permission to pair a device to your vessel.
- Internet access for initial pairing, course downloads and uploads. Once paired, recording can continue without internet access.
- For onboard course and map features, Signal K's route and course services. These features have been tested with Signal K Server 2.31.1.
- For an offline basemap, suitable local charts installed through Signal K Charts. Charts are not included with Wake Logger.

The plugin requires Node.js 20 or newer on the Signal K server. Your boat does not need to accept incoming connections from the internet.

## Get started

1. In Signal K's **App Store**, install **Wake Logger** (`signalk-wakelogger`).
2. In Wake Logger, open your vessel's settings and generate a Signal K pairing code.
3. Open **Wake Logger** in Signal K's plugin configuration, enter the code and save. Enable the plugin if it is disabled.
4. Open the onboard **Wake Logger webapp** and confirm **Live tracking** on when you are ready to upload. Check the connection status. When your boat supplies a position and the connection is online, it will appear in the vessel's **Signal K Live** view in Wake Logger.

Pairing codes are single-use. If a code expires or is rejected, generate a new one. You do not need to pair again after an ordinary internet outage or plugin update.

## Record now, upload later

Recording and uploading are separate. Keep Signal K and the Wake Logger plugin running, with your boat's navigation data available, for the trip to be recorded.

Keep one trip running for the full outing. Turning Live tracking off or on does not finish it. **Finish trip** ends the current trip; subsequent movement starts a new one. Finished manifests include the closure reason for the supporting website's durable diagnostics.

**For normal use:** Confirm **Live tracking** on in the onboard Wake Logger app. If internet access drops, the plugin stores readings onboard and resumes uploads when the connection returns, provided your confirmed choice is still on.

**To deliberately defer uploading:** Pair first, then confirm **Live tracking** off on the onboard Wake Logger map. The plugin keeps recording locally, up to your storage and age limits. Confirm it on when you are ready to send your live position and upload stored history. Changing the switch does not end a trip or restart recording, and the confirmed setting survives restarts and configuration updates. Both directions require confirmation. New installations and upgrades without a readable confirmed choice start with live tracking off; confirm it on in the onboard app when ready. Saving the legacy upload mode in plugin settings cannot enable live tracking.

The plugin configuration still shows the legacy **Upload mode** setting. Saving **Record locally** or **Automatic upload** there does not change your confirmed live-tracking choice. Use the onboard **Live tracking** switch to change it.

On reconnecting with **Live tracking** on, the latest position is sent promptly while stored history uploads in the background. Reconnecting with it off keeps recording local and does not enable uploads. With the supporting Wake Logger service update, your vessel view shows the percentage of stored history uploaded and an estimated time remaining once there is enough upload progress to measure. Estimates pause when the connection is lost. Detailed recording updates are available under **Upload details**. Wake Logger uses the recorded movement and times to identify trips; switching live tracking does not itself create a new trip. Missing or rejected readings are flagged rather than presented as a complete trip.

**When you dock:** Tap **Finish trip** before switching off boat power. The plugin saves the trip’s actual final recorded sequence and capture time immediately, including offline and with Live tracking off. **Saved onboard · upload pending** is local success, not cloud confirmation. Keep power and Live tracking on until **Trip confirmed ready by cloud** appears if you need confirmation now; the same connection checks receipt coverage and processing. Otherwise the pending finish survives restart and uploads later. The automatic 15-minute stationary stop remains the fallback. Finish trip does not change the active Signal K route, and fresh movement can start a new recording.

**Before a long outing:** Check available storage and your queue limits. The default limits are seven days or 250 MB, whichever is reached first. If a limit is reached, the oldest queued readings are discarded; plugin status reports the dropped count. The dropped count is a **lifetime** total across every upload, not the number lost from the current trip—losses that belong to the current upload are shown separately, and a recording affected by them is marked as not complete. Recording locally controls this plugin's Wake Logger connections only—it does not switch off other apps or your boat's internet access.

## Bring your race course onboard

Select a saved race course for your vessel in Wake Logger while internet access is available. Check that the course has synchronised before departure. The downloaded course stays on the Signal K server and remains available offline.

Open the **Wake Logger webapp** from Signal K's Web Apps list, using a phone, tablet or computer connected to the boat's network. Sign in to Signal K if prompted. Any Signal K user account can view the onboard map; changing live tracking or activating a course requires an account with read/write access.

The onboard map uses the same instrument styling as Wake Logger's live view, adapts to phone and tablet screens, and includes a full-screen view. It shows the complete course, your boat, the next mark and current leg. Distance, bearing, cross-track error, VMG and arrival estimates appear when Signal K can calculate them; unavailable readings are left clearly marked. Your recorded track is loaded from durable onboard storage when the page opens and then updated live, so reloading the app mid-passage still shows the whole trip rather than only the track since the page opened.

Alongside the map, the webapp shows an **onboard race plan**. While **Live tracking** is on, Wake Logger cloud calculates the remaining race: it starts the current leg from your boat's actual position, samples the downloaded forecast at each leg's estimated time, and accounts for current, so the suggested heading, sail plan and arrival estimate keep up with how the race is actually going. When **Live tracking** is off, the vessel performs the same calculation on board from the Race Pack synchronised before departure, so the plan is still available with no internet access. If no Race Pack has synchronised yet, the map and course still work and the plan is clearly marked as unavailable.

Use **Advance point** to move to the next course point, or select a point and choose **Set point** to correct your progress. When mark detection is set to Automatic, a detected rounding advances only on the device that has explicitly taken **Navigation control**; other phones or tablets stay viewers and never advance the course. Detection suggests or holds when it is unsure, and manual controls always win.

Your course is also available as a standard Signal K route for other onboard applications. If another app selects a different active route, Wake Logger shows that state. Choose **Activate Wake Logger course** when you want to return to it.

Before going offshore, check the onboard app's status. **Offline race ready** means the selected course has been applied, its Signal K route is active (and not reversed), a Race Pack that matches the course is stored with supported rules and a forecast valid now, and onboard sail planning will work with no internet. The app distinguishes a forecast that is merely valid now from one whose declared coverage spans the expected race window, and says so when it cannot confirm the whole window. If anything is missing the app says so; you can still switch Live tracking off for radio silence, but you will see a warning naming what is missing.

## Watch your instruments with no course and no internet

Open the **Wake Logger webapp** and choose the **Instruments** tab (the default when no course is selected). It reads directly from your boat's Signal K server and shows position, speed and course over ground, heading (true or magnetic), speed through water, depth (with its stated reference), and apparent and true wind, with units and a clear measured/derived label.

Instrument readings are independent of the course, Race Pack, recording and cloud connection. Each reading tracks its own freshness, so a stale sensor is marked with its age while the others stay live, and a missing value is shown as unavailable rather than guessed. Wind-relative VMG is labelled separately from VMG to a waypoint (ground- and water-referenced where available). Viewing instruments on another phone or tablet is read-only by default: it will not activate a course, advance a mark, change upload mode or start a recording.

## Prepare your map for offline use

The onboard map can show your boat and course without internet access. Basemap coverage needs a little preparation:

1. Install Signal K Charts and add local charts that you are licensed to use, such as a suitable MBTiles chart.
2. In the Wake Logger webapp, select a **Chart source**.
3. Choose the surrounding course margin and zoom range, then select **Verify local chart coverage**.
4. Check the result before leaving coverage. Verification applies to the selected area and zoom range, not every possible view of the map.

Verification checks existing local chart coverage; it does not download missing maps. Automatic online map downloads are not included in this release. An online chart working at the dock does not by itself mean it will work offshore.

If chart tiles are unavailable, the map still shows your vessel, course and marks. You can fit the map to the course or centre it on your boat.

## Your data and privacy

Wake Logger records position and time, plus speed over ground, course over ground, heading, depth and apparent wind when supplied. Missing optional sensors do not prevent position tracking. This plugin does not collect engine, fuel or battery readings.

Vessel roles and sharing settings in Wake Logger control who can see your data. Public live sharing is off by default and stays under the vessel owner's control.

## If something is not working

- **Not paired:** Generate a pairing code in Wake Logger and enter it in the plugin settings.
- **Offline or waiting to upload:** Check **Live tracking** in the onboard app, your internet connection and the plugin's queue status. Confirm Live tracking on when you want uploads to resume. Leave the plugin running so it can record and retry while tracking is on; saving the legacy **Upload mode** setting cannot enable uploads.
- **No vessel position:** Check that Signal K itself is receiving a valid position from your boat.
- **Course not active:** Check whether another app selected a route. Reactivate the Wake Logger course when appropriate.
- **Blank basemap:** Check your selected chart source and local coverage. Course and vessel information can still be displayed.
- **Moving to a different Signal K server:** Use **Replace device** in Wake Logger. Use **Revoke association** when retiring an old connection; your existing trip history is retained.

For help with your account, pairing or trips, contact support through [Wake Logger](https://wakelogger.com/). When reporting a problem, include your plugin version, Signal K version and the status shown—never your pairing code or credentials.

See the **Changelog** tab for what's new in each release.

### Waypoint laylines

The onboard map shows red **Port** and green **Starboard** approaches to the next mark in the selected course, with an estimated tack/gybe point. It uses fresh GPS, true heading and ground true wind (direct or derived from apparent wind and ground motion). A missing or stale required reading removes the estimate. An unavailable forward intersection removes the estimated maneuver point.

Laylines also work from the selected cached course when native activation is unavailable and do not need cloud access. They follow native course reversal and mark advancement when available. No course is activated or advanced by displaying laylines.

These are mirrored-angle estimates without current/leeway correction, polars, hazard checks or tack alerts. They are separate from the existing leg-average ETA. When released, update the plugin through the Signal K App Store and reload the onboard app to obtain this display; no pairing or settings changes are needed.

## Local real-trip replay (development)

The [real sailing replay tools](scripts/replay/README.md) feed an original Yacht Devices sailing clip into an isolated Signal K instance and a dedicated development vessel. They provide real-time playback, pause/resume, course controls and source-to-cloud comparisons. Historical sensor timestamps are rebased consistently; personal recordings and device credentials remain outside Git. These are operator tools in the source repository, not an additional feed enabled by installing the published plugin.

### Sailing guidance (development)

Live heading and wind use a shared, source-clock-based filter. The plugin publishes
one versioned guidance sample for both the onboard and website maps. Raw sensor
readings and saved track fields remain unchanged. The measured bow heading and
geometric bearing to the mark retain their meanings; current-adjusted predicted
ground tracks and the optional **Steer** value are separate.

Actual `steering.rudderAngle` is optional. It can corroborate a turn, and contributes
to leeway only with an explicitly validated vessel calibration. Missing, stale or
invalid rudder falls back to the validated heel model. Without a calibration,
measured leeway is used if available; no generic rudder correction is invented.
The opposite tack uses the heel model or symmetric measured leeway, never the
present rudder setting. A longitudinal STW log is assumed by the heel model.
Provided current is preferred. Derived current requires independent leeway and
aligned heading, STW, SOG and COG; heading minus COG alone is insufficient.

Advanced plugin configuration accepts `guidance.enabled`, a validated
`guidance.calibration`, and a validated `guidance.polar`. Calibration coefficients
and polars must come from vessel measurements. There are no default coefficients.
Extreme heel/pitch and genuine maneuvers suppress steady-sailing predictions;
this does not perform full mast-motion compensation. `/guidance` is read-only and
reports the same durable sample used by the cloud (or a local sample when the
active upload profile omits these readings). Source expiry is checked again by
each display. No map information box is added.

The canonical math is `src/guidance/core.ts`. `npm run build` generates its browser
module and manifest. When updating the website, also run
`node scripts/generate-guidance.mjs --frontend-root=/path/to/frontend` and commit
both generated artifacts together. `test/guidance.test.ts` covers physical vector
oracles and sensor fallback; browser tests cover both desktop and mobile.
