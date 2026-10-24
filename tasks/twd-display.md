# Display true wind direction

The owner clarified that the desired true-wind value is the compass bearing (TWD). Instruments and Race now show one field labelled TWD, using the existing north-referenced direction and wind-flow arrow. The bow-relative TWA tiles are removed; AWA remains visible.

Water-referenced true wind, GPS fallback, internal angle calculations, VMG, current/leeway guidance and recording data retain their existing behavior. Missing heading cannot create a compass direction from a relative water angle.

Validation: 51 relevant unit checks and three desktop/mobile browser scenarios pass, including source fallback, restoration, reload, compass arrow orientation and absence of the TWA display. Webapp build, lint and public-repository checks pass. Only test UI assets are deployed; recorder processes and backend files remain unchanged.
