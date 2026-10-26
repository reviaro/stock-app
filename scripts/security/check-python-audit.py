#!/usr/bin/env python3
"""Audit the active environment via OSV, including its installer packages.

Only public package names and versions leave the process. Network/API failures
fail the check rather than being treated as a clean advisory result.
"""
import argparse
import importlib.metadata
import json
import pathlib
import re
import sys
import urllib.request


def canonical(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def lock_packages(path):
    result = {}
    with open(path, encoding='utf-8') as source:
        for line in source:
            value = line.strip().removesuffix('\\').rstrip()
            if not value or value.startswith('#') or re.fullmatch(r'--hash=sha256:[a-f0-9]{64}', value):
                continue
            match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([A-Za-z0-9_.!+\-]+)', value)
            if not match:
                raise ValueError('Requirements must contain only exact version pins and wheel hashes')
            name, version = match.groups()
            name = canonical(name)
            if name in result:
                raise ValueError('Duplicate dependency pin')
            result[name] = version
    if not result:
        raise ValueError('The dependency lock contains no packages')
    return result


def audit(packages):
    entries = sorted(packages.items())
    payload = {'queries': [{'package': {'ecosystem': 'PyPI', 'name': name}, 'version': version} for name, version in entries]}
    request = urllib.request.Request('https://api.osv.dev/v1/querybatch', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=60) as response:
        result = json.load(response)
    matches = result.get('results')
    if not isinstance(matches, list) or len(matches) != len(entries):
        raise ValueError('Unexpected advisory API response')
    findings = []
    for (name, version), match in zip(entries, matches):
        if not isinstance(match, dict):
            raise ValueError('Invalid advisory result')
        if match.get('error') or match.get('next_page_token'):
            raise ValueError('Advisory result is incomplete')
        vulnerabilities = match.get('vulns', [])
        if not isinstance(vulnerabilities, list):
            raise ValueError('Invalid advisory list')
        for vulnerability in vulnerabilities:
            if not isinstance(vulnerability, dict) or not isinstance(vulnerability.get('id'), str):
                raise ValueError('Invalid advisory identifier')
            findings.append((name, version, vulnerability['id']))
    return findings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lock', required=True)
    parser.add_argument('--installer-lock', required=True)
    args = parser.parse_args()
    try:
        expected = lock_packages(args.lock) | lock_packages(args.installer_lock)
        inputs = lock_packages(pathlib.Path(args.lock).with_suffix('.txt'))
        if any(expected.get(name) != version for name, version in inputs.items()):
            raise ValueError('Requirements inputs differ from the reviewed lock')
        installed = {canonical(d.metadata['Name']): d.version for d in importlib.metadata.distributions()}
        if installed != expected:
            mismatches = sorted(name for name in installed.keys() | expected.keys() if installed.get(name) != expected.get(name))
            print('Environment differs from the reviewed locks: ' + ', '.join(mismatches), file=sys.stderr)
            return 1
        findings = audit(installed)
        if findings:
            for name, version, advisory in findings:
                print(f'{name} {version}: {advisory}', file=sys.stderr)
            return 1
        print(f'No known advisories for {len(installed)} locked installed Python distributions.')
        return 0
    except Exception as error:
        # Do not echo arbitrary HTTP response bodies or environment details.
        print('Python security audit could not complete: ' + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
