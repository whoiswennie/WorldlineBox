"""Read-only online SQLite backup and registered bodies for an offline probe."""
import sqlite3
import pathlib
import shutil
import sys

source = pathlib.Path(sys.argv[1]).resolve()
destination = pathlib.Path(sys.argv[2]).resolve()
destination.mkdir(parents=True, exist_ok=True)
with sqlite3.connect('file:' + source.joinpath('.worldlinebox/companions/messages.sqlite').as_posix() + '?mode=ro', uri=True) as current:
    with sqlite3.connect(destination / 'messages.sqlite') as target:
        current.backup(target)
    paths = current.execute('select owner_id,relative_path from companion_artifacts where state=?', ('committed',)).fetchall()
    for owner, relative in paths:
        original = source / '伙伴记忆' / owner / relative
        target = destination / 'owners' / owner / relative
        if not original.resolve().is_relative_to(source) or not target.resolve().is_relative_to(destination):
            raise RuntimeError('Artifact path escaped its library')
        if original.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
print('Copied SQLite backup and ' + str(len(paths)) + ' registered artifact paths; no private content emitted.')
