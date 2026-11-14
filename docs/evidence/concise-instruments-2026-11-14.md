# Concise plugin instruments — 14 November 2026

Removed the Instruments heading/subtext and routine top-right connection, queue and readiness output. Removed Race readiness/authority/pack descriptions, previous-mark prose, verbose ETA explanation and sail-change commentary. Recommendations, controls and calculations remain available. Existing action feedback appears only when populated.

Display labels use AWS, AWA, TWS, TWD, SOG, COG, STW, HDG, BTW, DTW, VMG and reference-specific depth abbreviations. True/magnetic units use °T/°M. Missing values use a dash. Instrument tiles and Race data rows have stable heights, tabular digits and non-wrapping values; the position tile spans both columns.

Validation: 50 Node service tests passed. Fourteen distinct affected browser scenarios passed across focused runs, including 1280/800/390 px layout with small/large/unavailable values, sail holding/reefing, tracking/Finish controls, tab fit and ETA/source-expiry behavior. Build and lint passed. Updated obsolete copy expectations to the requested abbreviated presentation.

Installed the static beta.15 test package into signalk-dev without restarting Signal K. Installed app/instrument module, markup and stylesheet hashes match the build. The Moreton Bay replay had naturally ended and was restarted through its existing controls. Live probe: 394 frames, 341 distinct boat positions, stable marker, exactly one row-height layout, no page errors. Confirmed instrument heading/subtext, Race banner and top-right routine detail are absent from the visible UI. Current Race labels: BTW, DTW, AWS, AWA, TWS, TWD, SOG, HDG, VMG.

Evidence: /tmp/plugin-concise-live.json; /tmp/plugin-concise-desktop.png; /tmp/plugin-concise-mobile.png. No npm publication or default-branch merge.
