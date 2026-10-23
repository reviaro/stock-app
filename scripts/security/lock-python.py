#!/usr/bin/env python3
"""Resolve pinned inputs and record complete PyPI wheel hashes for review.

Run with a patched pip in Python 3.12 on Linux, the deployment/CI target.
Existing transitive versions are retained unless --upgrade is explicitly given.
This writes a lock; it does not install or modify an application environment.
"""
import argparse
import concurrent.futures
import json
import pathlib
import platform
import re
import subprocess
import sys
import tempfile
import urllib.request


def normalize(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def pins(path):
    result = {}
    for line in path.read_text().splitlines():
        match = re.match(r'^([A-Za-z0-9_.-]+)==([^\s;]+)', line)
        if match:
            result[normalize(match[1])] = match[2]
    return result


def wheel_hashes(package):
    name, version = package
    with urllib.request.urlopen(f'https://pypi.org/pypi/{name}/{version}/json', timeout=30) as response:
        release = json.load(response)
    hashes = sorted({item['digests']['sha256'] for item in release['urls'] if item['packagetype'] == 'bdist_wheel' and not item['yanked']})
    if not hashes or any(not re.fullmatch('[a-f0-9]{64}', value) for value in hashes):
        raise ValueError('No valid published wheel hashes for ' + name)
    return package, hashes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('requirements', type=pathlib.Path)
    parser.add_argument('lock', type=pathlib.Path)
    parser.add_argument('--upgrade', action='store_true')
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 12) or not sys.platform.startswith('linux') or platform.machine() != 'x86_64':
        raise SystemExit('Generate these deployment locks on Python 3.12/Linux x86_64; validate other targets separately.')
    with tempfile.TemporaryDirectory(prefix='python-lock-') as scratch:
        report = pathlib.Path(scratch) / 'resolution.json'
        command = [sys.executable, '-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--only-binary=:all:', '--report', str(report), '-r', str(args.requirements)]
        if args.lock.exists() and not args.upgrade:
            existing = pins(args.lock)
            existing.update(pins(args.requirements))
            constraints = pathlib.Path(scratch) / 'constraints.txt'
            constraints.write_text(''.join(f'{name}=={version}\n' for name, version in sorted(existing.items())))
            command.extend(['-c', str(constraints)])
        subprocess.run(command, check=True)
        resolution = json.loads(report.read_text())
    packages = sorted((normalize(item['metadata']['name']), item['metadata']['version']) for item in resolution['install'])
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(wheel_hashes, packages))
    rows = ['# Fully pinned wheel hashes. Runtime resolution: CPython 3.12 on Linux x86_64.', '# Install with --require-hashes --only-binary=:all:. No source distributions.', '']
    for (name, version), hashes in results:
        rows.append(f'{name}=={version} \\')
        rows.extend('    --hash=sha256:' + value + (' \\' if i < len(hashes) - 1 else '') for i, value in enumerate(hashes))
        rows.append('')
    args.lock.write_text('\n'.join(rows))
    print(f'Wrote {len(packages)} pinned packages; review the diff, then install and audit in a disposable environment.')


if __name__ == '__main__':
    main()
