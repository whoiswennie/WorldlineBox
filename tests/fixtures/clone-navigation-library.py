"""Read-only source snapshot for real packaged navigation acceptance.

All real files are copied; links are rejected. SQLite files use online backup.
The private manifest stays in the owned temporary directory, never in Git.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import stat
import tempfile


def digest_file(filename):
    digest = hashlib.sha256()
    with extended(filename).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def readonly(filename):
    raw = str(filename)
    if raw.startswith('\\\\?\\'):
        raw = raw[4:]
    normal = pathlib.Path(raw)
    options = '?mode=ro' if extended(pathlib.Path(raw + '-wal')).is_file() else '?mode=ro&immutable=1'
    return sqlite3.connect(normal.as_uri() + options, uri=True)


def extended(filename):
    if os.name == 'nt' and not str(filename).startswith('\\\\?\\'):
        return pathlib.Path('\\\\?\\' + str(filename.absolute()))
    return filename


def is_link(entry):
    info = entry.lstat()
    return entry.is_symlink() or bool(getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def backup_sqlite(source, target, counts):
    # Python's Windows SQLite VFS still rejects some native-cache paths longer
    # than MAX_PATH. Read a stable DB/WAL pair into a short, owned directory;
    # never open the source with write access or omit its WAL.
    raw = str(source)
    normal = raw[4:] if raw.startswith('\\\\?\\') else raw
    if os.name != 'nt' or len(normal) < 240:
        with closing(readonly(source)) as current, closing(sqlite3.connect(':memory:')) as output:
            current.backup(output)
            target.write_bytes(output.serialize())
    else:
        with tempfile.TemporaryDirectory(prefix='wlb-sql-ro-') as temporary:
            copied = pathlib.Path(temporary) / 'snapshot.db'
            entries = [(source, copied), (pathlib.Path(raw + '-wal'), pathlib.Path(str(copied) + '-wal'))]
            for attempt in range(3):
                before = [(str(path), path.stat().st_size, digest_file(path))
                          for path, _ in entries if path.is_file()]
                for path, destination in entries:
                    if path.is_file():
                        shutil.copyfile(path, destination)
                    elif destination.exists():
                        destination.unlink()
                after = [(str(path), path.stat().st_size, digest_file(path))
                         for path, _ in entries if path.is_file()]
                copied_hashes = [(str(path), destination.stat().st_size, digest_file(destination))
                                 for path, destination in entries if destination.is_file()]
                if before == after == copied_hashes:
                    break
            else:
                raise RuntimeError('A long-path SQLite source changed during its read-only snapshot.')
            # This connection can recover/checkpoint only our private copy.
            with closing(sqlite3.connect(copied)) as current, closing(sqlite3.connect(':memory:')) as output:
                current.backup(output)
                target.write_bytes(output.serialize())
            counts['stableLongPathSqliteCopies'] += 1
    counts['sqliteBackups'] += 1


def copy_tree(source, target, counts, application_data=True):
    source, target = extended(source), extended(target)
    if is_link(source):
        raise RuntimeError('Refusing a linked source entry in the private navigation snapshot.')
    target.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        if is_link(child):
            raise RuntimeError('Refusing a linked source entry in the private navigation snapshot.')
        dest = target / child.name
        if child.is_dir():
            copy_tree(child, dest, counts, application_data)
        elif child.is_file():
            if application_data and (child.name.endswith(('-wal', '-shm', '.lock')) or child.name.lower() in ['lock', 'singletonlock']):
                continue
            sqlite_file = False
            if application_data and child.suffix.lower() in ['.db', '.sqlite', '.sqlite3']:
                with child.open('rb') as stream:
                    sqlite_file = stream.read(16) == b'SQLite format 3\0'
            if sqlite_file:
                backup_sqlite(child, dest, counts)
            else:
                shutil.copy2(child, dest)
            counts['files'] += 1
            counts['bytes'] += dest.stat().st_size


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source')
    arguments = parser.parse_args()
    if arguments.source:
        source = pathlib.Path(arguments.source).resolve()
    else:
        config = pathlib.Path(os.environ['APPDATA']) / 'worldlinebox' / 'recent-library.json'
        source = pathlib.Path(json.loads(config.read_text(encoding='utf-8-sig'))['activePath']).resolve()
    source_db = source / '.worldlinebox' / 'library.db'
    if not source_db.is_file():
        raise RuntimeError('The selected real library has no catalog database.')
    owned = pathlib.Path(tempfile.mkdtemp(prefix='wlb-navigation-real-')).resolve()
    if owned.is_relative_to(source):
        raise RuntimeError('The private copy must be outside its source library.')
    catalog = owned / 'library'
    counts = {'files': 0, 'bytes': 0, 'sqliteBackups': 0, 'stableLongPathSqliteCopies': 0}
    copy_tree(source, catalog, counts)
    copied_db = catalog / '.worldlinebox' / 'library.db'
    with closing(readonly(copied_db)) as db:
        db.row_factory = sqlite3.Row
        folders = list(db.execute('SELECT folder_id,absolute_root_path FROM linked_folders'))
        rows = [dict(row) for row in db.execute('''SELECT a.asset_id,a.linked_folder_id,a.relative_file_path,
            a.current_revision_id,a.availability,a.location_kind,r.byte_size
            FROM assets a JOIN revisions r ON r.revision_id=a.current_revision_id ORDER BY a.asset_id''')]
    links = []
    file_hashes = []
    missing_source_assets = []
    for index, folder in enumerate(folders):
        original = pathlib.Path(folder['absolute_root_path']).resolve()
        # Keep internal linked roots in their original library-relative place:
        # companion-memory technical-path classification depends on that shape.
        target = catalog / original.relative_to(source) if original.is_relative_to(source) else owned / 'linked-media' / str(index)
        if owned.is_relative_to(original):
            raise RuntimeError('The private media copy must be outside its original linked root.')
        # Linked media is user content, including any indexed SQLite files:
        # preserve its exact bytes rather than interpreting it as our database.
        copy_tree(original, target, counts, application_data=False)
        links.append({'folderId': folder['folder_id'], 'sourceRoot': str(original), 'copiedRoot': str(target)})
        for row in rows:
            if row['linked_folder_id'] != folder['folder_id']:
                continue
            relative = pathlib.PurePosixPath(row['relative_file_path'])
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('An indexed media path escapes its declared linked root.')
            before = original.joinpath(*relative.parts)
            after = target.joinpath(*relative.parts)
            if not extended(before).is_file():
                if extended(after).exists():
                    raise RuntimeError('A missing source unexpectedly exists in the private copy.')
                missing_source_assets.append(row['asset_id'])
                continue
            before_hash, after_hash = digest_file(before), digest_file(after)
            if before_hash != after_hash:
                raise RuntimeError('A real media file changed during snapshot preparation.')
            file_hashes.append({'assetId': row['asset_id'], 'sha256': after_hash, 'bytes': extended(after).stat().st_size})
    manifest = {'sourceLibrary': str(source), 'copiedLibrary': str(catalog), 'linkedRoots': links,
        'assets': rows, 'mediaHashes': file_hashes, 'copyCounts': counts,
        'missingSourceAssets': missing_source_assets,
        'sourcePathSha256': hashlib.sha256(str(source).encode()).hexdigest(),
        'snapshotDatabaseSha256': digest_file(copied_db), 'sourceOpenedReadOnly': True}
    (owned / 'private-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'privateSnapshot': str(owned), 'assetCount': len(rows), 'copiedMediaVerified': len(file_hashes), 'alreadyMissingSourceAssets': len(missing_source_assets),
        'sourceOpenedReadOnly': True, 'copyCounts': counts, 'sourcePathSha256': manifest['sourcePathSha256']}))


if __name__ == '__main__':
    main()
