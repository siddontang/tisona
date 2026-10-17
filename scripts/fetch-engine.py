"""Fetch only the reviewed engine revision during a Linux image build."""
import json
import subprocess

source = json.load(open('engine-source.json'))
if source['repository'] != 'https://github.com/resonatehq/resonate.git':
    raise SystemExit('Unexpected engine repository')
subprocess.run(['git', 'init', '--quiet', 'resonate'], check=True)
def git(*args):
    return subprocess.check_output(['git', '-C', 'resonate', *args], text=True).strip()
git('remote', 'add', 'origin', source['repository'])
git('sparse-checkout', 'set', source['path'])
git('fetch', '--depth=1', 'origin', source['revision'])
git('checkout', '--detach', source['revision'])
if git('rev-parse', 'HEAD') != source['revision']:
    raise SystemExit('Engine revision verification failed')
