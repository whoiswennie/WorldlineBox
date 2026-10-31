"""Read-only, content-free authority counters in a private benchmark clone."""
import json
import pathlib
import sqlite3
import sys
import tempfile


def clone_path(value):
    root = pathlib.Path(value).resolve()
    if root.parent != pathlib.Path(tempfile.gettempdir()).resolve() or not root.name.startswith('wlb-full-respond-'):
        raise RuntimeError('Authority counters require a private benchmark clone')
    return root / 'messages.sqlite'


filename = clone_path(sys.argv[1])
with sqlite3.connect('file:' + filename.as_posix() + '?mode=ro', uri=True) as db:
    if len(sys.argv) > 2:
        baseline = clone_path(sys.argv[2])
        db.execute('ATTACH DATABASE ? AS baseline', ('file:' + baseline.as_posix() + '?mode=ro',))
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    result = {
        'actions': dict(db.execute("SELECT CASE WHEN COALESCE(json_extract(data,'$.contentAvailable'),1)=0 THEN 'unavailable' ELSE 'available' END,count(*) FROM actions GROUP BY 1")),
        'notesByStatus': dict(db.execute("SELECT json_extract(data,'$.status'),count(*) FROM vcp_memory_notes GROUP BY 1")),
        'executionInvalidations': db.execute("SELECT count(*) FROM metadata WHERE key LIKE 'execution-source-invalid/%'").fetchone()[0],
    }
    if len(sys.argv) > 2:
        result['previousActionsNow'] = dict(db.execute("SELECT CASE WHEN a.id IS NULL THEN 'missing' WHEN COALESCE(json_extract(a.data,'$.contentAvailable'),1)=0 THEN 'unavailable' ELSE 'available' END,count(*) FROM baseline.actions b LEFT JOIN main.actions a ON a.id=b.id GROUP BY 1"))
        result['previousNotesNow'] = dict(db.execute("SELECT COALESCE(json_extract(a.data,'$.status'),'missing'),count(*) FROM baseline.vcp_memory_notes b LEFT JOIN main.vcp_memory_notes a ON a.id=b.id GROUP BY 1"))
        result['newExecutionInvalidations'] = db.execute("SELECT count(*) FROM main.metadata a WHERE a.key LIKE 'execution-source-invalid/%' AND NOT EXISTS(SELECT 1 FROM baseline.metadata b WHERE b.key=a.key)").fetchone()[0]
    print(json.dumps(result))
