#!/usr/bin/env python3
"""Reject private runtime/configuration artifacts in the Git index; print paths only."""
import pathlib
import re
import subprocess
import sys


def private_path(name):
    path = pathlib.PurePosixPath(name)
    parts = path.parts
    base = path.name.lower()
    if any(part in {'.planning', '.claude', '.hermes', 'node_modules', 'venv', '.venv', 'backups', 'exports', 'logs'} for part in parts):
        return True
    if name.startswith(('docs/plans/', 'docs/superpowers/')):
        return True
    if base in {'handoff.md', 'ai_agent_status.md'}:
        return True
    if base == '.env' or (base.startswith('.env.') and not base.endswith('.example')):
        return True
    if re.search(r'\.(?:db|sqlite|sqlite3)(?:[.-]|$)', base):
        return True
    return any(base.endswith(suffix) for suffix in ('.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3', '.pem', '.key', '.p12', '.pfx', '.backup', '.bak'))


def main():
    paths = subprocess.check_output(['git', 'ls-files', '-z'], text=True).split('\0')
    failures = sorted(name for name in paths if name and private_path(name))
    if failures:
        print('Private file types must not be tracked:', file=sys.stderr)
        print('\n'.join(failures), file=sys.stderr)
        return 1
    print('Tracked-file privacy policy passed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
