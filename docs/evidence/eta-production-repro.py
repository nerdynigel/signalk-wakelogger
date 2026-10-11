"""Replay sanitized historical scalar inputs against actual deployed/candidate ETA expressions.
Usage: python3 eta-production-repro.py /path/to/wakelogger
No production access, coordinates, dependencies or clock rewriting.
"""
import ast
import datetime
import json
import math
import pathlib
import subprocess
import sys

DEPLOYED = "e02fd1586730a4c04e9d376f73a94642512ac24b"
CANDIDATE = "c3ca12cee9c444bc1fe9016a78562ff619140a5e"
repo = pathlib.Path(sys.argv[1])
data = json.loads(pathlib.Path(__file__).with_name("eta-production-reconstruction.json").read_text())


def eta_expression(revision):
    source = subprocess.check_output(
        ["git", "-C", str(repo), "show", revision + ":api/app/services/signalk_race_navigation.py"],
        text=True,
    )
    tree = ast.parse(source)
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "race_navigation_payload")
    expressions = []
    for node in ast.walk(function):
        if isinstance(node, ast.Dict):
            expressions.extend(value for key, value in zip(node.keys, node.values)
                               if isinstance(key, ast.Constant) and key.value == "eta")
    assert expressions
    return compile(ast.Expression(expressions[0]), revision, "eval")


old, new = eta_expression(DEPLOYED), eta_expression(CANDIDATE)
for row in data["examples"] + [data["normal"], data["conditional_unbounded_closing_example"]]:
    captured = datetime.datetime.fromisoformat(row["captured_at"])
    live = type("Live", (), {"captured_at": captured})()
    env = {"live": live, "distance": row["distance_nm"], "vmg": row["target_vmg_kn"],
           "timedelta": datetime.timedelta}
    before = eval(old, {"__builtins__": {}}, env)
    after = eval(new, {"__builtins__": {}}, env)
    assert after is None
    if row["target_vmg_kn"] > 0.1:
        hours = (datetime.datetime.fromisoformat(before) - captured).total_seconds() / 3600
        assert math.isclose(hours, row["hours"], abs_tol=1e-8)
    else:
        assert before is None  # Cloud floor already rejects this conditional unbounded example.
        assert row["hours"] > 24
    assert math.isclose(row["sog_kn"] * math.cos(math.radians(row["heading_error_deg"])),
                        row["target_vmg_kn"], abs_tol=1e-12)
    print(row["id"], "deployed:", before, "candidate:", after)
print("PASS: 4 historical scalar cases; conditional geometry, not captured UI/native responses")
