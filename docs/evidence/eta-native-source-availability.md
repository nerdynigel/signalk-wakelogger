# ETA native-source availability — THE-899

11 October 2026, Platform & Reliability Engineer, read-only tranche for Chief.
**Prerequisite unavailable in the inspected authorised environment.** No usable
physical-current native capture or access handoff was obtained. Software's
positive/stale/invalid/recovery physical-native proof remains **NOT RUN**;
this finding does not complete THE-882 acceptance or approve a release.

## Frozen identity and scope

Plugin `nerdynigel/signalk-wakelogger`, registered workspace
`4de0cc0f-95fe-4135-ad51-b3e73b77de8b`, linked `.worktrees/THE-884`,
`release/2026-w42`, starting head
`1da1d1538536eb91142541d53dd1fbb2c92a453b`,
[existing PR22](https://github.com/nerdynigel/signalk-wakelogger/pull/22).
`pwd`, `git remote get-url origin`, `git status --short`, `git rev-parse HEAD`,
`git ls-remote origin refs/heads/release/2026-w42` and
`gh pr view 22 --json url,headRefName,headRefOid` verified the clean linked
worktree and matching remote/PR heads before investigation.

Website `nerdynigel/wakelogger`, registered workspace
`4c588ef5-e0ec-475c-a7f6-f4501c9f4d3e`, linked `.paperclip-runtime/wt-w42`,
`release/2026-w42-web`, head
`cec9ff3cf8a749218e1c99504ce61289f3892434`,
[PR81](https://github.com/nerdynigel/wakelogger/pull/81).
Equivalent cwd/origin/status/remote/PR commands matched. Pre-existing untracked
`frontend/node_modules` preserved; no website writes.

Read the W42 plan and Chief final reconciliation, project access description,
repository development guidance and existing ETA reports. No tracked repository
AGENTS.md found. Existing production SSH investigation permission supplies no
physical-vessel Signal K endpoint or native API read identity. No production
connection was needed: the frozen cloud service explicitly lacks independent
sensor timestamps (see `api/app/services/signalk_race_navigation.py:894–898`).
Cloud packet timestamps cannot supply the missing native envelopes.

## Actual availability checks

All remote commands used `ssh -o BatchMode=yes -o ConnectTimeout=8 openclaw`.
Connection succeeded; no SSH credential was inspected or provisioned.

| Read-only command/check | Executed outcome |
| --- | --- |
| `hostname; date -u` plus cwd/origin/status/HEAD in the project-registered Openclaw website checkout | Reachable at 13:23:20 UTC; clean website checkout at `72286c7aa26622edf079bc68d7291beed929898a`, rather than the frozen website candidate |
| `docker ps --format "{{.Names}} {{.Image}} {{.Ports}}"` | Existing `signalk-dev` service publishes host loopback-accessible port 3001; no container started or stopped |
| `docker inspect signalk-dev --format "Image={{.Config.Image}} ImageID={{.Image}} Started={{.State.StartedAt}} Mounts={{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}"` | Image `signalk-signalk`, ID `sha256:b5e6e271137e8885fc0cc5c6d824c0064734d0e3b400cc498e5c4d843dd6e169`, started `2026-10-10T14:04:41.197233744Z`; existing Signal K settings volume identified; private host mount path omitted |
| `curl -sS --max-time 8 -o /dev/null -w "ready HTTP=%{http_code}\n" http://127.0.0.1:8010/ready` | HTTP200; website API readiness only |
| `curl -sS --max-time 8 -o /dev/null -w "signalk discovery HTTP=%{http_code}\n" http://127.0.0.1:3001/signalk` | HTTP200; service discovery only |
| SSH `python3 -`, using `urllib.request.urlopen(base+path, timeout=6)` and a field whitelist, two samples 2 seconds apart | `/signalk` HTTP200, server `signalk-server-node`, version `2.31.1`; observation UTC `13:23:55.849142` and `13:23:58.110631` |
| Same two-sample GET for `/signalk/v1/api/vessels/self/navigation`, `/signalk/v2/api/vessels/self/navigation/course`, `/signalk/v2/api/vessels/self/navigation/course/calcValues`, `/plugins/signalk-wakelogger/course` | All four HTTP401 in both observations; no position, SOG, COG, route/leg or calculation envelope received. Second observation confirmed the same state, not an authentication workaround |
| `docker exec signalk-dev node -e` selecting only provider ID/enabled/type/file fields from settings JSON | Eight configured enabled entries, all `n2k-sample-data` / `providers/simple` / `FileStream`, all the bundled `signalk-server/samples/aava-n2k.data`; no physical input provider in that configuration |
| Same scoped Node read of installed plugin package metadata | `signalk-wakelogger` `0.2.0-beta.9`; course-provider package probe at the assumed scoped package path returned ENOENT, which does not establish provider absence |
| Same scoped Node SHA256 of installed `public/course-progress.mjs` | `bcfaf4df31678f94c65f72c58815831448168440eaf0e696642a96c8a9a875f7`; installed `webapp/course-progress.mjs` absent |
| `sha256sum webapp/course-progress.mjs` in frozen plugin worktree | `afa0513c282373d7804681f4714026f58678be8e31b172b7222c9cb2a9001f46`; deployed helper differs from frozen source |
| Scoped Node read of the configured bundled sample, output only length/hash/first three timestamp matches | 2,066,312 bytes; SHA256 `65abc4a8db5e6a970d47cd204c25126857b99577bec67b653ddf0b128fad1b8f`; timestamps `2014-08-15T19:00:00.042Z`, `.045Z`, `.048Z` |
| cwd/origin/status/HEAD in the existing Openclaw Signal K checkout | `nerdynigel/signalk-server-testing`, `2dfa715182cb40a21746675026cf0421d37a4f1b`; pre-existing untracked memory, beta.9 tarball and beta.8 backup preserved |
| `git ls-files` capture/fixture/JSON patterns in the two frozen repositories and existing Openclaw website checkout; bounded local artifact filename inventory | Fixtures, prior QA reports and build/test logs identified; no documented physical-current native capture with the required provenance found in this bounded inventory |

Initial broad remote AGENTS.md filename discovery encountered permission-denied
database directories, exit1. No privilege escalation or retry into those paths;
subsequent tracked-file inventory stayed within repository metadata. Local `rg`
was unavailable; `find`, `grep` and `git ls-files` were used instead. An attempted
plugin-helper hash from website cwd failed file lookup; only the corrected
frozen plugin hash above is used. No failed command is counted as validation.

## Precise missing prerequisite and handoff

Chief owns obtaining or confirming one **authorised physical-vessel source or
provenance-preserving native capture**, then routing Software on the existing
THE-882 parent. Required access is a named endpoint reachable from the approved
execution environment with an already-granted read-only API identity, or an
owner-supplied capture delivered privately. Openclaw SSH access alone does not
grant Signal K API authentication; a read token for the sample environment alone
would still not make its 2014 data physical-current proof. No token request,
credential search, network scan or access-control change was made.

The source/capture must retain:

- Physical origin and UTC capture time, deployed Signal K/plugin/provider/API
  versions or hashes, source labels, and route identity/direction/leg index.
- Individual `navigation.position`, `speedOverGround` and
  `courseOverGroundTrue` values with original envelopes and timestamps.
- Native `navigation.course.calcValues` distance, bearingTrue,
  velocityMadeGood, timeToGo and estimatedTimeOfArrival envelopes, individual
  timestamps and stated units: metres, radians, m/s, seconds and ISO datetime.
  A v2 scalar response alone cannot establish freshness.
- Successive real samples sufficient for a coherent positive result and the
  approved stale/invalid/recovery proof at frozen `raceProgress` source. Any
  deliberately altered local sample must remain explicitly labelled as a
  local validation variant, never physical source evidence.

Use existing run-owned scratch with restricted permissions for private inputs;
retain a hash and capture manifest, omit credentials and sensitive positions from
public reports, and preserve timestamp/unit relationships when sanitizing.
Do not translate old timestamps to today. Do not activate a route, toggle
tracking, inject production data or switch/serve Openclaw to obtain the proof.
Once the prerequisite exists, Software owns implementation proof; independent
Verification owns the frozen acceptance. Historical incident attribution still
requires the race-day inputs/deployed identity separately.

## Validation, hygiene and rollback

This is one evidence file only. Previous source/local QA and source hashes remain
unchanged; no behaviour suite is rerun or represented as physical-current proof.
Publication validation is the public-repository safety script, scoped diff and
whitespace checks, clean post-commit status, and remote/PR head equality; exact
delivered commit is recorded in the task handoff.

Bounded disk-hygiene inspection: before/after `df -h / /tmp` showed root
165 GB total, 132 GB used, 33 GB free (81% used); tmpfs 388 MB used. Local
`du -sh` showed QA logs 165 KB, test-results 1 KB, dependencies 83 MB and
linked worktrees 107 MB. Current project tasks/agent states were checked.
No safely disposable completed-task material was established: active release
worktrees, dependencies, QA evidence and uncertain ownership were preserved.
Paths removed: none; bytes reclaimed: zero. No heavy build started.

Recovery requires no service/data rollback: all environment operations were
reads. If needed, revert only this documentation commit, preserving accepted
ETA source and prior QA. All original acceptance, serial discovery and owner-Go
holds remain; no candidate promotion, deployment, merge, npm or paid runners.
