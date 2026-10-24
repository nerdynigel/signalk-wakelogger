# One sailing wind display

The Instruments panel still displayed both ground and water VMG calculations after the earlier true-wind cleanup. Older test installations also retained the original duplicate angle display.

- [x] Show one TWA/TWS pair, preferring complete water-referenced measurements or derivations, with a complete GPS-referenced fallback.
- [x] Use the same wind reference for the single VMG-to-wind tile and Race summary.
- [x] Keep water TWD unavailable without a compatible true heading rather than borrowing ground TWD.
- [x] Validate desktop/mobile rendering, source loss, restoration and reload.
- [x] Update test UI assets without changing running recorder processes or replay state.

Raymarine's [sailing glossary](https://docs.raymarine.com/81432/en-US/latest/SailingGlossary-71147499.html) defines sailing true wind over water, TWA relative to the bow, and TWD relative to north. B&G's [SailSteer description](https://prod.bandg.com/en-sg/blog/racepanel-series-with-mark-chisnell-part-5-sailsteer/) presents one TWA, AWA, TWS and TWD set.

The displayed wind selection is independent of the ground vectors retained for current-aware navigation and archived telemetry. No sensor paths or recording calculations are removed. A heading of 90° and wind angle of 40° starboard correspond to wind from 130° and an uncorrected mirrored opposite heading of 170°.

Validation: 51 unit checks and 10 relevant browser scenarios pass, including mobile/desktop source fallback, restoration, reload, wind VMG, and existing tack/current guidance. Webapp build, lint and public-repository checks pass. Read-only browser checks confirm one set in Instruments and Race on all three test installations, without JavaScript errors. Deployed assets match the build; server code, process identities, replay identities and active recording identities are unchanged. The website and production were not redeployed.
