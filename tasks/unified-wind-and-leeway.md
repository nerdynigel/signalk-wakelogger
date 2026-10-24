# Shared sailing wind and leeway course

- [ ] Publish one filtered sailing-wind selection: measured/derived water wind first, current-translated ground wind next, ground fallback last. Preserve existing ground fields and raw telemetry.
- [ ] Consume that exact selection and filtered heading in plugin/web instruments, wind graphics and tack/layline guidance, including freshness and older snapshots.
- [ ] Expose course through water as heading plus fresh measured/calibrated leeway. Draw a separate cyan dashed bow line with a tooltip; preserve measured heading and required steering lines.
- [ ] Keep leeway and current separate in ground-track laylines; hide the extra line when leeway is unknown, stale or maneuvering. Do not infer leeway from heading minus COG.
- [ ] Validate cross-current, both leeway signs, source loss/recovery, timestamps, source switches, plugin/web parity and desktop/mobile rendering.
- [ ] Deploy to the test environment with the source trip/recording preserved. Do not interrupt the active replay to update backend code; wait for its natural end before loading the backend update.

The replay contains no usable rudder or measured leeway and has no validated vessel calibration. Its real frames validate wind agreement and the no-leeway fallback; independent fixtures validate the new course line and leeway/current vectors. No map legend or explanatory box is added.
