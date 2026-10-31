"""Physical identity adaptation for an owned performance copy, never a restore test."""
from contextlib import closing
import base64
import hashlib
import json
import pathlib
import sqlite3
import subprocess
import sys

from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location('clone_navigation', pathlib.Path(__file__).with_name('clone-navigation-library.py'))
clone = module_from_spec(spec)
spec.loader.exec_module(clone)
root = pathlib.Path(sys.argv[1]).resolve()
if not root.name.startswith('wlb-navigation-real-'):
    raise RuntimeError('Only an owned navigation fixture is permitted.')
manifest = json.loads((root / 'private-manifest.json').read_text(encoding='utf-8'))
source = pathlib.Path(manifest['sourceLibrary']).resolve()
copied = pathlib.Path(manifest['copiedLibrary']).resolve()
if not copied.is_relative_to(root) or root.is_relative_to(source):
    raise RuntimeError('The fixture escaped its owned root.')


def regular(file):
    for entry in [file, *file.parents]:
        if clone.is_link(entry):
            raise RuntimeError('Physical identity adaptation forbids links and junctions.')
        if entry == root:
            break
    if file.stat().st_nlink != 1:
        raise RuntimeError('The fixture database must be an independent file.')


def content_digest(connection):
    digest = hashlib.sha256()
    for name, sql in connection.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name"):
        digest.update(json.dumps([name, sql], ensure_ascii=False).encode())
        table = '"' + name.replace('"', '""') + '"'
        rows = []
        for row in connection.execute('SELECT * FROM ' + table):
            rows.append(json.dumps([{'binary': base64.b64encode(value).decode()} if isinstance(value, bytes) else value
                                    for value in row], ensure_ascii=False, separators=(',', ':')))
        for row in sorted(rows):
            digest.update(row.encode())
            digest.update(b'\n')
    return digest.hexdigest()


ledger_relative = pathlib.Path('.worldlinebox/companions/messages.sqlite')
authority_relative = pathlib.Path('.worldlinebox/companions-recovery-authority.sqlite')
ledger, authority = copied / ledger_relative, copied / authority_relative
regular(ledger)
regular(authority)
with closing(clone.readonly(source / ledger_relative)) as original, closing(clone.readonly(ledger)) as target, \
        closing(clone.readonly(source / authority_relative)) as source_authority, closing(clone.readonly(authority)) as copied_authority:
    for connection in [original, target, source_authority, copied_authority]:
        connection.execute('BEGIN')
    marker = original.execute('SELECT lineage_id,generation FROM companion_recovery_state WHERE singleton=1').fetchone()
    if marker != target.execute('SELECT lineage_id,generation FROM companion_recovery_state WHERE singleton=1').fetchone():
        raise RuntimeError('Source and copied ledger lineage/generation differ.')
    original_head = source_authority.execute('SELECT * FROM recovery_authority WHERE singleton=1').fetchone()
    copied_head = copied_authority.execute('SELECT * FROM recovery_authority WHERE singleton=1').fetchone()
    if original_head != copied_head or copied_head[5] != 0 or marker != (copied_head[3], copied_head[4]):
        raise RuntimeError('The copied authority is not the exact settled source head.')
    source_content_hash, copied_content_hash = content_digest(original), content_digest(target)
    if source_content_hash != copied_content_hash:
        raise RuntimeError('The complete ledger contents differ from the read-only original.')
    authority_content_hash = content_digest(copied_authority)
    canonical_hashes = []
    for owner, relative, registered_hash in original.execute("SELECT owner_id,relative_path,content_hash FROM companion_artifacts WHERE state='committed' ORDER BY owner_id,artifact_id"):
        relative_path = pathlib.PurePosixPath(relative)
        if relative_path.is_absolute() or '..' in relative_path.parts:
            raise RuntimeError('A canonical path escapes its owner.')
        before, after = source / '伙伴记忆' / owner / pathlib.Path(relative), copied / '伙伴记忆' / owner / pathlib.Path(relative)
        if not clone.extended(before).is_file() or not clone.extended(after).is_file():
            raise RuntimeError('A registered canonical body is absent from source or copy.')
        body_hash, copied_body_hash = clone.digest_file(before), clone.digest_file(after)
        if body_hash != copied_body_hash or body_hash != registered_hash:
            raise RuntimeError('A registered canonical body differs from its exact source baseline.')
        canonical_hashes.append([owner, relative, body_hash])

identity = json.loads(subprocess.check_output(['node', '-e',
    "const s=require('node:fs').lstatSync(process.argv[1]);process.stdout.write(JSON.stringify([String(s.dev),String(s.ino)]))", str(ledger)], text=True))
with closing(sqlite3.connect(authority)) as writable:
    writable.execute('BEGIN IMMEDIATE')
    current = writable.execute('SELECT * FROM recovery_authority WHERE singleton=1').fetchone()
    if current != copied_head:
        raise RuntimeError('The private authority changed before the physical CAS.')
    result = writable.execute('UPDATE recovery_authority SET ledger_device=?,ledger_inode=? WHERE singleton=1 AND ledger_device=? AND ledger_inode=? AND generation=? AND lineage_id=? AND pending=0',
                             (*identity, copied_head[7], copied_head[8], marker[1], marker[0]))
    if result.rowcount != 1:
        raise RuntimeError('The private physical identity CAS failed.')
    after_head = writable.execute('SELECT * FROM recovery_authority WHERE singleton=1').fetchone()
    if after_head[:7] != copied_head[:7]:
        raise RuntimeError('Identity adaptation unexpectedly changed semantic authority.')
    writable.commit()

report = {'fixtureIdentityRebound': True, 'isProductRestoreAcceptance': False, 'sourceOpenedReadOnly': True,
          'completeLedgerContentSha256': source_content_hash, 'copiedLedgerContentSha256': copied_content_hash,
          'sourceLedgerFileSha256': clone.digest_file(source / ledger_relative), 'copiedLedgerFileSha256': clone.digest_file(ledger),
          'authorityContentBeforeSha256': authority_content_hash, 'lineageAndGenerationPreserved': True,
          'registeredCanonicalFilesVerified': len(canonical_hashes),
          'canonicalBaselineSha256': hashlib.sha256(json.dumps(canonical_hashes, ensure_ascii=False).encode()).hexdigest(),
          'physicalIdentityBefore': list(copied_head[7:9]), 'physicalIdentityAfter': identity}
(root / 'fixture-identity-rebind.json').write_text(json.dumps(report), encoding='utf-8')
print(json.dumps({key: value for key, value in report.items() if not key.startswith('physicalIdentity')}))
