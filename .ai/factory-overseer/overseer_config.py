"""Machine-specific settings for the overseer tooling, read from ~/.config/factory-overseer.json
(never committed: it names internal hosts and paths). See config.example.json."""
import json
from pathlib import Path

PATH = Path.home() / '.config' / 'factory-overseer.json'


def _expand(v):
    return str(Path(v).expanduser()) if isinstance(v, str) and v.startswith('~') else v


def load():
    raw = json.loads(PATH.read_text())
    def walk(x):
        if isinstance(x, dict):
            return {k: walk(v) for k, v in x.items()}
        return _expand(x)
    return walk(raw)


def data_dir():
    d = Path(load()['dataDir'])
    d.mkdir(parents=True, exist_ok=True)
    return d


def api_key():
    cfg = load()['provider']
    oc = json.loads(Path(cfg['opencodeConfig']).read_text())
    return (oc.get('provider') or oc.get('providers'))[cfg['name']]['settings']['apiKey']
