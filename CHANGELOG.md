# What's new in Wake Logger for Signal K

Updates for boat owners and crew: what's new, what's improved, and anything you need to do.

## [Unreleased]

### Live tracking when you want it

- Turn live tracking on or off directly from the onboard map. With it off, recording continues locally within your configured storage limits. Turn it on to resume live updates and upload stored history.
- Your choice survives restarts, and switching modes does not split a trip.

### A clearer map and upload status

- The onboard map now matches Wake Logger's live instrument view, with layouts for phones and tablets and a full-screen option.
- Historical uploads show percentage progress and an estimated time remaining once upload speed can be measured. A coloured live-tracking indicator makes connection status easier to see.
- Recording details are expandable, keeping the main upload view compact. Trips are created only when the recorded movement meets the trip definition.


## [0.2.0-beta.4] - 2026-09-14

### Clearer help in Signal K

- Rewritten the App Store guide around pairing, recording trips, uploading later, using courses and preparing offline maps.
- Replaced technical release summaries with customer-facing notes. Developer setup remains in the separate development documentation.

## [0.2.0-beta.3] - 2026-09-14

### Record your trip now, upload later

Keep recording when internet access is unavailable, or choose **Record locally** to defer uploading. Switch back to **Automatic upload** when you are ready. Stored readings and recording details are retained through plugin restarts.

With the supporting Wake Logger service update, you can see historical upload progress and processing status. Trips are finalised once their complete recording has arrived; missing data is clearly flagged.

Local storage is limited: by default, queued readings are kept for up to seven days or 250 MB. Keep Signal K and the plugin running to record your trip.

### Take your race course onboard

Select a course in Wake Logger and synchronise it to your vessel before departure. Once downloaded, it remains available without internet access.

Your course is available to other Signal K applications. You can advance or correct the current mark manually, and Wake Logger respects route selections made by other apps. Automatic detection of start crossings, mark roundings and finishes is not included in this release.

### Follow your course on an onboard map

The new mobile-friendly webapp displays your vessel, course, marks and current leg. It shows distance, bearing, cross-track error, VMG and arrival estimates when Signal K provides them.

### Prepare for sailing offline

Use locally installed Signal K charts and check coverage around your course before departure. Your vessel and course remain visible even without a basemap.

**Before you update:** Upload progress and course synchronisation require the supporting Wake Logger service update. Offline basemaps require suitable charts installed through Signal K Charts; verification checks existing coverage and does not download missing maps.

This remains a beta release.

## [0.2.0-beta.2] - 2026-09-02

### Easier to preview before installing

- Fixed App Store screenshots that could fail to display after installation.
- Added screenshots of live vessel tracking and trip review, alongside connection status and pairing settings.
- Clarified how Wake Logger helps you track your vessel and revisit your trips.

## [0.2.0-beta.1] - 2026-09-02

### A clearer App Store introduction

- Added Wake Logger's blue-wave app icon and improved the product introduction.
- Explained live tracking, trip replay, crew access and optional trip analysis more clearly.
- Clarified which navigation readings appear in private and owner-shared live views.

## [0.2.0-beta.0] - 2026-09-02

### First public beta

- Made Wake Logger available through the Signal K App Store for beta use.
- Improved connection and queued-upload status so support can help diagnose interrupted uploads.
- Added centrally managed recording profiles to adapt uploads to changing connectivity.
- Improved recovery of stored readings after outages and restarts.
- Added clearer feedback for expired pairing codes and revoked device connections.

## [0.1.0] - 2026-08-31

### Initial version

- Connected Signal K position and supported navigation readings to Wake Logger.
- Added pairing, live updates and onboard storage for readings waiting to upload.
- Added automatic retries and connection status information.
