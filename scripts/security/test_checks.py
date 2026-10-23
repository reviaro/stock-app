import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit = load('check-python-audit')
privacy = load('check-public-files')


class SecurityCheckTests(unittest.TestCase):
    def test_unpinned_or_conflicting_requirements_cannot_bypass_lock_comparison(self):
        with tempfile.TemporaryDirectory() as scratch:
            source = pathlib.Path(scratch) / 'requirements.txt'
            for content in ['example==1.0\nother>=2.0\n', 'example==1.0\nexample==2.0\n', '-r unchecked.txt\n', 'example==1.0; python_version>="3.12"\n']:
                with self.subTest(content=content):
                    source.write_text(content)
                    with self.assertRaises(ValueError):
                        audit.lock_packages(source)
            source.write_text('# reviewed pin\nexample==1.0 \\\n    --hash=sha256:' + 'a' * 64 + '\n')
            self.assertEqual(audit.lock_packages(source), {'example': '1.0'})

    def test_advisory_failures_are_not_clean_results(self):
        for body in ({}, {'results': []}, {'results': [{'error': 'unavailable'}]}, {'results': [{'next_page_token': 'more'}]}, {'results': [{'vulns': [{}]}]}):
            with self.subTest(body=body), patch.object(audit.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(body).encode())):
                with self.assertRaises(ValueError):
                    audit.audit({'example-package': '1.0'})

    def test_clean_and_affected_versions_are_distinguished(self):
        with patch.object(audit.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"results":[{}]}')):
            self.assertEqual(audit.audit({'example-package': '1.0'}), [])
        body = b'{"results":[{"vulns":[{"id":"GHSA-example"}]}]}'
        with patch.object(audit.urllib.request, 'urlopen', return_value=io.BytesIO(body)):
            self.assertEqual(audit.audit({'example-package': '1.0'}), [('example-package', '1.0', 'GHSA-example')])

    def test_private_artifacts_are_rejected_but_templates_are_allowed(self):
        for name in ['backend/.env', 'frontend/.env.local', '.planning/report.txt', 'backend/database/private.db', 'backend/database/private.db.pre-deploy', 'credentials/private.key', 'docs/plans/proposal.md', 'exports/account.csv']:
            self.assertTrue(privacy.private_path(name), name)
        for name in ['backend/.env.example', 'backend/.env.sample.example', 'backend/python/requirements.lock', 'frontend/src/App.tsx']:
            self.assertFalse(privacy.private_path(name), name)


if __name__ == '__main__':
    unittest.main()
