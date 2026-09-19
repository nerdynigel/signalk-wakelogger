#!/usr/bin/env python3
"""Generate golden fixtures for the onboard sail-plan physics port.

The fixtures come from the authoritative Wake Logger calculation in
wakelogger/api/app/services/race_plan_service.py so the TypeScript port can be
checked for parity. Run from the signalk-wakelogger repository with the Wake
Logger API checkout available:

    WAKELOGGER_API_PATH=../wakelogger/api python3 scripts/generate-sail-fixtures.py

Only pure calculation functions are exercised; no database or network access is
performed. Regenerate the fixtures whenever the cloud calculation changes and
record the rule-set version alongside them.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

api_path = Path(os.environ.get('WAKELOGGER_API_PATH', '../wakelogger/api')).resolve()
sys.path.insert(0, str(api_path))

from app.services.race_plan_service import (  # noqa: E402
    _best_upwind_target_from_polar_summary,
    _polar_speed_for_leg,
    _sailing_course_for_target_twa,
    angular_difference_degrees,
    apparent_wind,
    bearing_degrees,
    classify_point_of_sail,
    current_components,
    distance_nm,
    estimate_boat_speed_knots,
    hull_speed_for_vessel,
    normalize_degrees,
    sailing_side_for_course,
    signed_angle_degrees,
    wave_angle_to_leg,
)

OUTPUT = Path(__file__).resolve().parent.parent / 'test' / 'fixtures' / 'sail-physics.json'

POLAR_SUMMARY = {
    'eligible': True,
    'buckets': [
        {'abs_twa_deg': 40, 'tws_kn': 12, 'average_speed_kn': 5.4, 'sample_count': 60, 'side': 'starboard', 'label': '40/12 stbd'},
        {'abs_twa_deg': 45, 'tws_kn': 12, 'average_speed_kn': 5.9, 'sample_count': 20, 'side': 'port', 'label': '45/12 port'},
        {'abs_twa_deg': 90, 'tws_kn': 14, 'average_speed_kn': 6.6, 'sample_count': 30, 'side': 'starboard', 'label': '90/14 stbd'},
        {'abs_twa_deg': 150, 'tws_kn': 18, 'average_speed_kn': 7.1, 'sample_count': 12, 'side': 'port', 'label': '150/18 port'},
        {'abs_twa_deg': 20, 'tws_kn': 12, 'average_speed_kn': 4.0, 'sample_count': 5, 'side': 'port', 'label': '20/12 port'},
        {'abs_twa_deg': 55, 'tws_kn': 20, 'average_speed_kn': 0.0, 'sample_count': 3, 'side': 'starboard', 'label': '55/20 zero'},
    ],
}

VESSELS = {
    'explicit': SimpleNamespace(hull_speed_knots=7.2),
    'waterline': SimpleNamespace(length_waterline_m=9.5),
    'length': SimpleNamespace(length_m=12.0),
    'default': SimpleNamespace(),
    'zero': SimpleNamespace(hull_speed_knots=0, length_waterline_m=0),
}


def vessel_case(name: str) -> dict:
    return vars(VESSELS[name])


cases: dict[str, list[dict]] = {
    'normalizeDegrees': [{'input': {'value': value}, 'output': normalize_degrees(value)} for value in (-370, -10, 0, 45, 359.9, 720.5)],
    'angularDifferenceDegrees': [
        {'input': {'left': left, 'right': right}, 'output': angular_difference_degrees(left, right)}
        for left, right in ((350, 10), (10, 350), (0, 180), (180, 0), (45, 45), (0, 0), (400, 20))
    ],
    'signedAngleDegrees': [
        {'input': {'left': left, 'right': right}, 'output': signed_angle_degrees(left, right)}
        for left, right in ((350, 10), (10, 350), (0, 180), (180, 0), (90, 45), (45, 90))
    ],
    'bearingDegrees': [
        {'input': {'fromLat': from_lat, 'fromLon': from_lon, 'toLat': to_lat, 'toLon': to_lon}, 'output': bearing_degrees(from_lat, from_lon, to_lat, to_lon)}
        for from_lat, from_lon, to_lat, to_lon in (
            (-27.4, 153.17, -27.39, 153.19),
            (-27.4, 153.17, -27.4, 153.17),
            (0, 0, 1, 1),
            (0, 0, -1, 0),
            (51.5, -0.1, 48.85, 2.35),
        )
    ],
    'distanceNm': [
        {'input': {'fromLat': from_lat, 'fromLon': from_lon, 'toLat': to_lat, 'toLon': to_lon}, 'output': distance_nm(from_lat, from_lon, to_lat, to_lon)}
        for from_lat, from_lon, to_lat, to_lon in (
            (-27.4, 153.17, -27.39, 153.19),
            (-27.4, 153.17, -27.4, 153.17),
            (0, 0, 1, 1),
            (51.5, -0.1, 48.85, 2.35),
        )
    ],
    'classifyPointOfSail': [
        {'input': {'twaDeg': twa}, 'output': classify_point_of_sail(twa)}
        for twa in (-10, 0, 20, 34.9, 35, 45, 59.9, 60, 70, 89.5, 90, 90.4, 100, 134.9, 135, 150, 180, 200)
    ],
    'sailingCourseForTargetTwa': [
        {'input': {'legBearingDeg': bearing, 'trueWindFromDeg': wind, 'targetTwaDeg': twa}, 'output': _sailing_course_for_target_twa(leg_bearing_deg=bearing, true_wind_from_deg=wind, target_twa_deg=twa)}
        for bearing, wind, twa in ((45, 0, 45), (90, 90, 45), (0, 180, 45), (350, 10, 45), (200, 90, 60), (10, 350, 40))
    ],
    'sailingSideForCourse': [
        {'input': {'sailingCourseDeg': course, 'trueWindFromDeg': wind, 'pointOfSail': pos}, 'output': sailing_side_for_course(sailing_course_deg=course, true_wind_from_deg=wind, point_of_sail=pos)}
        for course, wind, pos in ((45, 90, 'close reach'), (300, 90, 'broad reach'), (90, 90, 'beam reach'), (270, 180, 'running'), (180, 0, 'close-hauled'), (350, 10, 'broad reach'))
    ],
    'apparentWind': [
        {'input': {'vesselCourseDeg': course, 'vesselSpeedKnots': speed, 'trueWindFromDeg': wind, 'trueWindSpeedKnots': tws}, 'output': vars(apparent_wind(vessel_course_deg=course, vessel_speed_knots=speed, true_wind_from_deg=wind, true_wind_speed_knots=tws))}
        for course, speed, wind, tws in ((0, 6, 90, 12), (0, 0, 90, 12), (45, 7, 0, 15), (180, 5, 90, 10), (270, 8, 180, 20), (0, 5, 180, 5), (359, 6.5, 1, 11))
    ],
    'hullSpeedForVessel': [
        {'input': {'vessel': vessel_case(name)}, 'output': {'speed': hull_speed_for_vessel(VESSELS[name])[0], 'source': hull_speed_for_vessel(VESSELS[name])[1]}}
        for name in VESSELS
    ],
    'estimateBoatSpeedKnots': [
        {'input': {'vessel': vessel_case(name), 'pointOfSail': pos, 'forecastTwsKnots': tws, 'forecastGustKnots': gust}, 'output': {'speed': estimate_boat_speed_knots(vessel=VESSELS[name], point_of_sail=pos, forecast_tws_knots=tws, forecast_gust_knots=gust)[0], 'warnings': estimate_boat_speed_knots(vessel=VESSELS[name], point_of_sail=pos, forecast_tws_knots=tws, forecast_gust_knots=gust)[1]}}
        for name, pos, tws, gust in (
            ('explicit', 'beam reach', 12, 15),
            ('explicit', 'close-hauled', 4, 5),
            ('explicit', 'running', 7, 18),
            ('waterline', 'close-hauled', 10, 22),
            ('length', 'close-hauled / no-sail zone', 12, 14),
            ('default', 'broad reach', 6, 8),
            ('zero', 'beam reach', 14, 16),
        )
    ],
    'currentComponents': [
        {'input': {'currentVelocityKn': velocity, 'currentDirectionDeg': direction, 'legBearingDeg': bearing}, 'output': current_components(current_velocity_kn=velocity, current_direction_deg=direction, leg_bearing_deg=bearing)}
        for velocity, direction, bearing in ((None, None, 90), (1.2, 45, 90), (0.8, 270, 0), (0.5, 180, 45), (0.0, 0, 90))
    ],
    'waveAngleToLeg': [
        {'input': {'waveDirectionDeg': direction, 'legBearingDeg': bearing}, 'output': wave_angle_to_leg(wave_direction_deg=direction, leg_bearing_deg=bearing)}
        for direction, bearing in ((None, 90), (45, 90), (200, 10), (0, 0))
    ],
    'bestUpwindTargetFromPolarSummary': [
        {'input': {'polarSummary': summary, 'forecastTwsKnots': tws}, 'output': {'twa': _best_upwind_target_from_polar_summary(summary, tws)[0], 'source': _best_upwind_target_from_polar_summary(summary, tws)[1]}}
        for summary, tws in ((POLAR_SUMMARY, 12), (POLAR_SUMMARY, 20), (POLAR_SUMMARY, 5), ({'eligible': False}, 12), (None, 12), ({'eligible': True, 'buckets': []}, 12))
    ],
    'polarSpeedForLeg': [
        {'input': {'polarSummary': summary, 'twaDeg': twa, 'forecastTwsKnots': tws, 'windSide': side}, 'output': {'speed': _polar_speed_for_leg(summary, twa_deg=twa, forecast_tws_knots=tws, wind_side=side)[0], 'match': _polar_speed_for_leg(summary, twa_deg=twa, forecast_tws_knots=tws, wind_side=side)[1]}}
        for summary, twa, tws, side in (
            (POLAR_SUMMARY, 45, 12, 'starboard'),
            (POLAR_SUMMARY, 45, 12, 'port'),
            (POLAR_SUMMARY, 90, 14, None),
            (POLAR_SUMMARY, 150, 18, 'starboard'),
            (POLAR_SUMMARY, 25, 12, 'port'),
            (POLAR_SUMMARY, 100, 5, 'starboard'),
            (POLAR_SUMMARY, 10, 12, 'port'),
            (POLAR_SUMMARY, 45, 30, 'starboard'),
            ({'eligible': False}, 45, 12, 'port'),
        )
    ],
}

document = {
    'description': 'Golden fixtures generated from the Wake Logger deterministic sail calculation for the onboard port.',
    'source': 'wakelogger/api/app/services/race_plan_service.py',
    'ruleSetVersion': 'race_plan_preview_v1',
    'polarSummary': POLAR_SUMMARY,
    'cases': cases,
}

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(document, indent=2, sort_keys=True) + '\n')
print(f'wrote {OUTPUT} with {sum(len(rows) for rows in cases.values())} cases')
