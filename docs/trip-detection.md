# Trip detection

The plugin emits evidence; Wake Logger remains authoritative for provisional and final trip boundaries.

The state machine is `STOPPED → START_CANDIDATE → MOVING → STOP_CANDIDATE → STOPPED`. A start candidate begins when SOG exceeds 1.5 kn or the vessel moves more than 200 m from its stationary cluster. Two minutes of credible movement confirms it and backdates the effective time. A stop candidate begins below 0.5 kn; remaining within 75 m for 15 minutes confirms it and backdates the effective end.

The stationary origin uses a slowly adjusted centroid only while points remain inside the 75 m berth cluster. This absorbs normal GPS drift without dragging the origin along a slow marina departure. Engine data is neither subscribed nor required, so engine-off sailing remains valid. Connectivity and sensor interruption never end a tracking session. Evidence includes effective time, speed, distance and dwell duration. State is persisted across Signal K and vessel restarts.
