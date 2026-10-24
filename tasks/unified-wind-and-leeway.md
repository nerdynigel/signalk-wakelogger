# Shared sailing wind and leeway course

- [x] Publish one filtered sailing-wind selection: measured/derived water wind first, current-translated ground wind next, ground fallback last. Preserve existing ground fields and raw telemetry.
- [x] Consume that exact selection and filtered heading in plugin/web instruments, wind graphics and tack/layline guidance, including freshness and older snapshots.
- [x] Expose course through water as heading plus fresh measured/calibrated leeway. Draw a separate cyan dashed bow line with a tooltip; preserve measured heading and required steering lines.
- [x] Keep leeway and current separate in ground-track laylines; hide the extra line when leeway is unknown, stale or maneuvering. Do not infer leeway from heading minus COG.
- [x] Validate cross-current, both leeway signs, source loss/recovery, timestamps, source switches, plugin/web parity and desktop/mobile rendering.
- [x] Deploy to the test environment with the source trip/recording preserved. Do not interrupt the active replay to update backend code; wait for its natural end before loading the backend update.

The replay contains no usable rudder or measured leeway and has no validated vessel calibration. Its real frames validate wind agreement and the no-leeway fallback; independent fixtures validate the new course line and leeway/current vectors. No map legend or explanatory box is added.


Review: 324 plugin unit checks pass (seven existing optional checks skipped), as do 70 helper/geometry checks, 111 frontend unit checks and 25 API cases. Desktop/mobile scenarios cover shared TWD, both leeway signs, current, source loss, rudder fallback and GPS-independent instruments. The original 89,639 events produced 1,191 matching wind snapshots; existing ground wind and heading outputs match the previous compiled engine exactly. All snapshots round-trip unchanged through the deployed API.

Test deployment completed. The guidance replay backend was reloaded only after EOF. Its replay identity, cursor, open recording identity, emitted source log and durable sample bytes are unchanged. Installed backend vector verification and all three test plugin page checks pass, as do six deployed website browser cases. Backend differences are confined to the guidance modules; older test backends are untouched. The test-only replay harness remains excluded from the package. No production or registry publication occurred.
