#!/usr/bin/env python3
"""Generate golden fixtures for the onboard sail-plan port.

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
    _candidate_for_sail,
    _confidence_for_score,
    _mainsail_configuration,
    _polar_speed_for_leg,
    _range_score,
    _sailing_course_for_target_twa,
    _sail_category,
    _sail_type_score,
    angular_difference_degrees,
    apparent_wind,
    bearing_degrees,
    build_recommended_sail_plan,
    classify_point_of_sail,
    current_components,
    distance_nm,
    estimate_boat_speed_knots,
    hull_speed_for_vessel,
    normalize_degrees,
    recommend_sails,
    reefing_recommendation,
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


def sail(**overrides) -> SimpleNamespace:
    base = dict(
        id=99, sail_name='Sail', sail_type='Custom sail', availability_status='Available', is_available=True, archived_at=None,
        max_aws_knots=None, min_awa_deg=None, max_awa_deg=None, min_twa_deg=None, max_twa_deg=None,
        min_tws_knots=None, max_tws_knots=None, crew_required=None,
        reef_1_tws_knots=None, reef_2_tws_knots=None, reef_3_tws_knots=None,
        reef_1_notes=None, reef_2_notes=None, reef_3_notes=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


MAIN = sail(id=1, sail_name='Doyle main', sail_type='Mainsail', min_twa_deg=0, max_twa_deg=180, min_tws_knots=0, max_tws_knots=25, crew_required=1,
            reef_1_tws_knots=14, reef_2_tws_knots=20, reef_3_tws_knots=26, reef_1_notes='Reef 1 above 14 kn')
JIB1 = sail(id=2, sail_name='No. 1 jib', sail_type='No. 1 jib', min_awa_deg=0, max_awa_deg=60, min_twa_deg=0, max_twa_deg=70, min_tws_knots=0, max_tws_knots=14, crew_required=2)
JIB3 = sail(id=3, sail_name='No. 3 jib', sail_type='No. 3 jib', min_awa_deg=0, max_awa_deg=90, min_twa_deg=0, max_twa_deg=110, min_tws_knots=8, max_tws_knots=25, crew_required=1)
CODE0 = sail(id=4, sail_name='Code 0', sail_type='Code 0', min_awa_deg=40, max_awa_deg=110, min_twa_deg=50, max_twa_deg=110, min_tws_knots=4, max_tws_knots=18, crew_required=2)
A2 = sail(id=5, sail_name='A2 kite', sail_type='Asymmetric A2', min_awa_deg=60, max_awa_deg=160, min_twa_deg=70, max_twa_deg=180, min_tws_knots=6, max_tws_knots=22, crew_required=3)
STORM = sail(id=6, sail_name='Storm jib', sail_type='Storm jib', min_awa_deg=0, max_awa_deg=80, min_twa_deg=0, max_twa_deg=120, min_tws_knots=18, max_tws_knots=45, crew_required=1)
TRISAIL = sail(id=7, sail_name='Trysail', sail_type='Trysail', min_twa_deg=0, max_twa_deg=180, min_tws_knots=20, max_tws_knots=45, crew_required=1)
TRAINING = sail(id=8, sail_name='Training jib', sail_type='No. 2 jib', availability_status='Training only', min_twa_deg=0, max_twa_deg=90, min_tws_knots=0, max_tws_knots=20, crew_required=1)
IN_REPAIR = sail(id=9, sail_name='Old main', sail_type='Mainsail', availability_status='In repair', is_available=False)
LIGHT_GENOA = sail(id=10, sail_name='Light genoa', sail_type='Genoa', max_aws_knots=12, min_twa_deg=0, max_twa_deg=70, min_tws_knots=0, max_tws_knots=12, crew_required=1)
ARCHIVED = sail(id=11, sail_name='Archived jib', sail_type='No. 1 jib', archived_at='2026-01-01T00:00:00Z')
HEAVY = sail(id=12, sail_name='Heavy jib', sail_type='Heavy-weather jib', availability_status='Heavy weather only', min_twa_deg=0, max_twa_deg=100, min_tws_knots=16, max_tws_knots=45, crew_required=1)

INVENTORY = [MAIN, JIB1, JIB3, CODE0, A2, STORM, TRISAIL, TRAINING, IN_REPAIR, LIGHT_GENOA, ARCHIVED, HEAVY]

CLOSE_HAULED = dict(point_of_sail='close-hauled', twa_deg=45, forecast_tws_knots=12, forecast_gust_knots=15, awa_deg=28, aws_knots=16, apparent_gust_knots=19, available_crew_count=3)
RUNNING = dict(point_of_sail='running', twa_deg=170, forecast_tws_knots=10, forecast_gust_knots=12, awa_deg=175, aws_knots=6, apparent_gust_knots=8, available_crew_count=3)
LIGHT_CLOSE = dict(point_of_sail='close-hauled', twa_deg=40, forecast_tws_knots=6, forecast_gust_knots=8, awa_deg=22, aws_knots=9, apparent_gust_knots=11, available_crew_count=1)
HEAVY_UPWIND = dict(point_of_sail='close-hauled', twa_deg=50, forecast_tws_knots=24, forecast_gust_knots=30, awa_deg=32, aws_knots=30, apparent_gust_knots=34, available_crew_count=2)
SCENARIOS = {'close_hauled': CLOSE_HAULED, 'running': RUNNING, 'light_close': LIGHT_CLOSE, 'heavy_upwind': HEAVY_UPWIND}


def range_case(value, minimum, maximum, primary):
    reasons, warnings = [], []
    score = _range_score(value=value, minimum=minimum, maximum=maximum, label='TWA', reasons=reasons, warnings=warnings, primary=primary)
    return {'input': {'value': value, 'minimum': minimum, 'maximum': maximum, 'primary': primary}, 'output': {'score': score, 'reasons': reasons, 'warnings': warnings}}


def type_case(sail_type, point_of_sail, forecast_tws_knots):
    reasons, warnings = [], []
    score = _sail_type_score(sail_type, point_of_sail, forecast_tws_knots, reasons, warnings)
    return {'input': {'sailType': sail_type, 'pointOfSail': point_of_sail, 'forecastTwsKnots': forecast_tws_knots}, 'output': {'score': score, 'reasons': reasons, 'warnings': warnings}}

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
    'sailCategory': [
        {'input': {'sailType': sail_type}, 'output': _sail_category(sail_type)}
        for sail_type in ('Mainsail', 'Reefed mainsail', 'Trysail', 'Mizzen staysail', 'Mizzen', 'No. 1 jib', 'Genoa', 'Storm jib', 'Heavy-weather jib', 'Staysail', 'Code 0', 'Reacher', 'Drifter', 'Asymmetric A2', 'Symmetric spinnaker', 'Gennaker', 'A5', 'Custom sail', '')
    ],
    'rangeScore': [
        range_case(*row)
        for row in ((45, 40, 60, True), (30, 40, 60, True), (30, 42, 60, True), (70, 40, 60, True), (70, 64, 60, True), (50, None, None, True), (50, None, None, False), (12, None, 10, False))
    ],
    'sailTypeScore': [
        type_case(*row)
        for row in (
            ('Mainsail', 'close-hauled', 10), ('No. 1 jib', 'close-hauled', 10), ('Asymmetric A2', 'close-hauled', 10),
            ('Code 0', 'beam reach', 10), ('Asymmetric A2', 'running', 10), ('No. 3 jib', 'running', 10),
            ('Trysail', 'running', 22), ('Custom sail', 'close-hauled', 10), ('No. 2 jib', 'close reach', 12),
            ('Heavy-weather jib', 'close reach', 24), ('Gennaker', 'broad reach', 12),
        )
    ],
    'mainsailConfiguration': [
        {'input': {'status': status, 'trysailAvailable': available}, 'output': _mainsail_configuration({'status': status}, trysail_available=available)}
        for status, available in (('none', False), ('consider_reef_1', False), ('consider_reef_2', False), ('consider_reef_3', False), ('consider_reef_3', True), ('unknown', False))
    ],
    'confidenceForScore': [
        {'input': {'score': score, 'warnings': warnings}, 'output': _confidence_for_score(score, warnings)}
        for score, warnings in ((95, []), (95, ['a', 'b']), (80, []), (68, ['a', 'b', 'c']), (60, []))
    ],
    'reefingRecommendation': [
        {'input': {'sails': [vars(s) for s in sails], 'forecastTwsKnots': tws, 'forecastGustKnots': gust}, 'output': reefing_recommendation(sails, forecast_tws_knots=tws, forecast_gust_knots=gust)}
        for sails, tws, gust in ((INVENTORY, 10, 12), (INVENTORY, 15, 18), (INVENTORY, 22, 24), (INVENTORY, 27, 30), ([JIB3], 12, 14), (INVENTORY, 12, 24))
    ],
    'candidateForSail': [
        {'input': {'sail': vars(current), 'scenario': name}, 'output': _candidate_for_sail(current, **SCENARIOS[name])}
        for name in SCENARIOS
        for current in INVENTORY
    ],
    'recommendSails': [
        {'input': {'sails': [vars(s) for s in INVENTORY], 'scenario': name}, 'output': {'candidates': recommend_sails(INVENTORY, **SCENARIOS[name])[0], 'recommendation': recommend_sails(INVENTORY, **SCENARIOS[name])[1]}}
        for name in SCENARIOS
    ] + [
        {'input': {'sails': [vars(MAIN)], 'scenario': 'close_hauled'}, 'output': {'candidates': recommend_sails([MAIN], **CLOSE_HAULED)[0], 'recommendation': recommend_sails([MAIN], **CLOSE_HAULED)[1]}},
    ],
}

SAIL_BY_NAME = {s.sail_name: s for s in INVENTORY}


def build_plan(scenario_name: str, sails: list, crew: int) -> dict | None:
    params = dict(SCENARIOS[scenario_name])
    params['available_crew_count'] = crew
    candidates, _recommendation = recommend_sails(sails, **params)
    reefing = reefing_recommendation(sails, forecast_tws_knots=params['forecast_tws_knots'], forecast_gust_knots=params['forecast_gust_knots'])
    return build_recommended_sail_plan(
        candidates=candidates,
        reefing=reefing,
        point_of_sail=params['point_of_sail'],
        forecast_tws_knots=params['forecast_tws_knots'],
        forecast_gust_knots=params['forecast_gust_knots'],
        available_crew_count=params['available_crew_count'],
    )


cases['buildRecommendedSailPlan'] = [
    {'input': {'scenario': scenario, 'crew': crew, 'sails': [vars(s) for s in INVENTORY]}, 'output': build_plan(scenario, INVENTORY, crew)}
    for scenario, crew in (('close_hauled', 3), ('running', 3), ('light_close', 1), ('heavy_upwind', 2), ('close_hauled', 0))
] + [
    {'input': {'scenario': 'close_hauled', 'crew': 3, 'sails': [vars(MAIN)]}, 'output': build_plan('close_hauled', [MAIN], 3)},
    {'input': {'scenario': 'running', 'crew': 3, 'sails': [vars(JIB3)]}, 'output': build_plan('running', [JIB3], 3)},
]

document = {
    'description': 'Golden fixtures generated from the Wake Logger deterministic sail calculation for the onboard port.',
    'source': 'wakelogger/api/app/services/race_plan_service.py',
    'ruleSetVersion': 'race_plan_preview_v1',
    'polarSummary': POLAR_SUMMARY,
    'scenarios': SCENARIOS,
    'cases': cases,
}

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(document, indent=2, sort_keys=True) + '\n')
print(f'wrote {OUTPUT} with {sum(len(rows) for rows in cases.values())} cases')
