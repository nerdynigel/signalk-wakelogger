import os, json, subprocess, runpy
from pathlib import Path
c=runpy.run_path(str(Path(__file__).with_name('dev-feature-client.py')))
key='openclaw_scope_a_signalk_readonly_20261015111327'
token=c['pc']('/api/agents/me/secrets/'+key+'/value','POST')['value']
env=dict(os.environ);env['PLAYWRIGHT_BROWSERS_PATH']='/home/nigel/.cache/ms-playwright'
r=subprocess.run(['/home/nigel/.nvm/versions/node/v24.21.0/bin/node','docs/evidence/dev-plugin-page.cjs'],input=json.dumps({'token':token,'base':c['bundle']['signalk_url']}),text=True,cwd=c['ROOT'],env=env,timeout=100)
raise SystemExit(r.returncode)
