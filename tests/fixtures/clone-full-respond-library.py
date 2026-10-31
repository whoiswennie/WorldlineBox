"""Read-only real-library backup for the complete respond probe; no private output."""
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys

source = pathlib.Path(sys.argv[1]).resolve()
destination = pathlib.Path(sys.argv[2]).resolve()
subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name('clone-memory-library.py')), str(source), str(destination)], check=True, stdout=subprocess.DEVNULL)
count = 0
for owner in (source / '伙伴记忆').iterdir():
    native = owner / '.运行' / '索引'
    if not native.is_dir():
        continue
    for original in native.rglob('*'):
        if not original.is_file() or original.name.endswith(('-wal', '-shm', '.lock')):
            continue
        if not original.resolve().is_relative_to(source):
            raise RuntimeError('Native cache path escaped its library')
        target = destination / 'owners' / owner.name / '.运行' / '索引' / original.relative_to(native)
        # Native VCP's two profile hashes can exceed legacy MAX_PATH after
        # relocating a library into the longer Windows temporary directory.
        output_path = pathlib.Path('\\\\?\\' + str(target)) if os.name == 'nt' else target
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with original.open('rb') as handle:
            sqlite = handle.read(16) == b'SQLite format 3\x00'
        if sqlite:
            has_wal = pathlib.Path(str(original) + '-wal').is_file()
            uri_options = '?mode=ro' if has_wal else '?mode=ro&immutable=1'
            with sqlite3.connect('file:' + original.as_posix() + uri_options, uri=True) as current:
                with sqlite3.connect(':memory:') as output:
                    current.backup(output)
                    output_path.write_bytes(output.serialize())
        else:
            shutil.copyfile(original, output_path)
        count += 1
keys = source / '.worldlinebox' / 'companions' / 'llm-keys.enc.json'
if keys.is_file():
    shutil.copyfile(keys, destination / keys.name)
catalog = json.loads((pathlib.Path(os.environ['APPDATA']) / 'worldlinebox' / 'ai-profiles.json').read_text(encoding='utf-8'))
selected = next(value for value in catalog['profiles'] if value['id'] == catalog['activeProfileId'])
(destination / 'global-config.json').write_text(json.dumps({key: selected[key] for key in ['id', 'apiFormat', 'model', 'baseUrl'] if key in selected}), encoding='utf-8')
credential = pathlib.Path(os.environ['APPDATA']) / 'worldlinebox' / 'ai-profile-keys' / (selected['id'] + '.bin')
if credential.is_file():
    shutil.copyfile(credential, destination / 'global-provider-key.enc.bin')
local_state = pathlib.Path(os.environ['APPDATA']) / 'worldlinebox' / 'Local State'
if local_state.is_file():
    # Preserve the encrypted OS-storage context in the isolated Electron app.
    # Neither the original profile nor any plaintext key is written.
    isolated_profile = destination / 'electron-user-data'
    isolated_profile.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(local_state, isolated_profile / 'Local State')
device = pathlib.Path(os.environ['APPDATA']) / 'worldlinebox' / 'embedding-models' / 'device-capability-v1.json'
if device.is_file():
    shutil.copyfile(device, destination / 'embedding-device.json')
with sqlite3.connect('file:' + destination.joinpath('messages.sqlite').as_posix() + '?mode=ro&immutable=1', uri=True) as snapshot:
    names = [row[0] for row in snapshot.execute("select name from sqlite_master where type='table' and name like 'companion_learning%'")]
    learning_rows = {name: snapshot.execute('select count(*) from ' + name).fetchone()[0] for name in names}
print(json.dumps({'copiedNativeFiles': count, 'sqliteBackup': True, 'sourceOpenedReadOnly': True, 'learningTableRows': learning_rows}))
