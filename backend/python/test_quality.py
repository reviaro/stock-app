import unittest
from unittest.mock import MagicMock, patch
import importlib

class QualityMetricsTest(unittest.TestCase):
    def _stub_ticker(self, **kwargs):
        m = MagicMock()
        for k, v in kwargs.items():
            setattr(m, k, v)
        return m

    def test_grade_thresholds(self):
        from yf_wrapper import _grade_numeric
        self.assertEqual(_grade_numeric(20, [15, 10, 5], higher_is_better=True), 'A')
        self.assertEqual(_grade_numeric(12, [15, 10, 5], higher_is_better=True), 'B')
        self.assertEqual(_grade_numeric(7, [15, 10, 5], higher_is_better=True), 'C')
        self.assertEqual(_grade_numeric(4, [15, 10, 5], higher_is_better=True), 'D')
        self.assertEqual(_grade_numeric(0.2, [0.3, 0.7, 1.5], higher_is_better=False), 'A')
        self.assertEqual(_grade_numeric(1.0, [0.3, 0.7, 1.5], higher_is_better=False), 'C')
        self.assertEqual(_grade_numeric(2.0, [0.3, 0.7, 1.5], higher_is_better=False), 'D')

    def test_composite_excludes_nulls(self):
        from yf_wrapper import _composite_score
        grades = {'roic': 'A', 'fcf_margin': 'B', 'debt_equity': None, 'interest_coverage': 'C'}
        weights = {'roic': 20, 'fcf_margin': 20, 'debt_equity': 15, 'interest_coverage': 10}
        score = _composite_score(grades, weights)
        # (90*20 + 75*20 + 60*10) / (20+20+10) = 3900/50 = 78.0
        self.assertAlmostEqual(score, 78.0, places=1)

    def test_grade_letter_to_number(self):
        from yf_wrapper import _letter_to_number
        self.assertEqual(_letter_to_number('A'), 90)
        self.assertEqual(_letter_to_number('B'), 75)
        self.assertEqual(_letter_to_number('C'), 60)
        self.assertEqual(_letter_to_number('D'), 40)
        self.assertEqual(_letter_to_number('F'), 20)

if __name__ == '__main__':
    unittest.main()
