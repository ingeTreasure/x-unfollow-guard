"""Package only runtime extension files. No local credentials or test fixtures."""
from pathlib import Path
import hashlib
import json
import zipfile
ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'manifest.json').read_text())
files = [ROOT / 'manifest.json', ROOT / 'README.md', ROOT / 'CHANGELOG.md', ROOT / 'LICENSE']
for folder in ('background', 'content', 'popup', 'icons'):
    files.extend(sorted((ROOT / folder).glob('*')))
assert all(p.is_file() and ' (1)' not in p.name for p in files)
required = [manifest['background']['service_worker'], manifest['action']['default_popup'], *manifest['icons'].values()]
for script in manifest['content_scripts']:
    required.extend(script['js'] + script['css'])
assert all((ROOT / path).is_file() for path in required)
output = ROOT / 'releases'
output.mkdir(exist_ok=True)
archive = output / f'fan-manager-v{manifest["version"]}.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as package:
    for file in files:
        package.write(file, file.relative_to(ROOT))
with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None
    assert json.loads(package.read('manifest.json'))['version'] == manifest['version']
    assert not any(name.startswith(('tests/', 'docs/')) for name in package.namelist())
sha = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(f'{sha}  {archive.name}\n')
print(f'{archive} ({archive.stat().st_size:,} bytes, {len(files)} files)')
print(f'SHA256: {sha}')
