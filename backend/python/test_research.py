import os
import sqlite3
import tempfile
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import pandas as pd
from research_metrics import quality
import yf_wrapper as wrapper


def frame(rows, dates=('2025-12-31','2023-12-31')):
    return pd.DataFrame.from_dict(rows, orient='index', columns=pd.to_datetime(dates))


def ticker(**values):
    defaults = dict(info={}, financials=pd.DataFrame(), quarterly_financials=pd.DataFrame(), balance_sheet=pd.DataFrame(), cashflow=pd.DataFrame(), history=lambda **kw:pd.DataFrame())
    return SimpleNamespace(**{**defaults,**values})


class ResearchTests(unittest.TestCase):
    def test_periods_survive_missing_rows_and_cagr_uses_actual_years(self):
        t=ticker(financials=frame({'Total Revenue':[200,100]}),cashflow=frame({'Free Cash Flow':[None,10]}))
        result=quality(t,'TEST')
        self.assertAlmostEqual(result['metrics']['revenue_cagr']['value'],41.42,places=1)
        self.assertEqual(result['metrics']['fcf_margin']['value'],10)
        self.assertEqual(result['metrics']['fcf_margin']['periods'],['2023-12-31'])

    def test_roe_is_never_substituted_for_roic(self):
        t=ticker(info={'returnOnEquity':.25},financials=frame({'Operating Income':[10,9]}),balance_sheet=frame({'Stockholders Equity':[-100,-90]}))
        self.assertIsNone(quality(t,'TEST')['metrics']['roic']['value'])

    def test_actual_tax_rate_and_matching_opening_capital(self):
        dates=('2025-12-31','2024-12-31')
        t=ticker(financials=frame({'Operating Income':[30,20],'Tax Provision':[5,4],'Pretax Income':[25,20]},dates),balance_sheet=frame({'Stockholders Equity':[100,80],'Total Debt':[20,20]},dates))
        r=quality(t,'TEST')['metrics']['roic']
        self.assertAlmostEqual(r['value'],24/110*100)
        self.assertEqual(r['observations'],1)

    def test_empty_financials_are_unknown_not_bad_earnings(self):
        r=quality(ticker(),'TEST')
        self.assertIsNone(r['metrics']['earnings_consistency']['value'])
        self.assertIsNone(r['composite'])
        self.assertEqual(r['coveragePct'],0)

    def test_fund_has_no_corporate_quality_score(self):
        r=quality(ticker(info={'quoteType':'ETF'}),'TEST')
        self.assertFalse(r['applicable'])
        self.assertIsNone(r['composite'])

    @patch.dict(os.environ,{'SAMPLE_DATA':'0'})
    def test_outage_does_not_generate_analysis_or_history(self):
        with patch.object(wrapper.yf,'Ticker',side_effect=RuntimeError('provider failed')):
            for function in [wrapper.get_canslim_analysis,wrapper.get_technical_indicators,wrapper.get_stock_info,wrapper.get_history]:
                self.assertEqual(function('AAPL')['status'],'error')

    @patch.dict(os.environ,{'SAMPLE_DATA':'1'})
    def test_sample_fallback_is_explicitly_marked(self):
        with patch.object(wrapper.yf,'Ticker',side_effect=RuntimeError('provider failed')):
            r=wrapper.get_canslim_analysis('AAPL')
            self.assertTrue(r['meta']['isDemo'])
            self.assertTrue(r['data']['isDemo'])

    def test_empty_canslim_does_not_pass_any_criterion(self):
        with patch.object(wrapper.yf,'Ticker',return_value=ticker()),patch.object(wrapper,'get_rs_rating_details',return_value={'rating':None,'stale':True}),patch.object(wrapper,'detect_market_direction',return_value={'status':'Unavailable'}):
            r=wrapper.get_canslim_analysis('TEST')['data']
        self.assertEqual(r['overall']['passCount'],0)
        self.assertEqual(r['overall']['unknownCount'],7)
        self.assertIsNone(r['overall']['score'])

    def test_quarterly_growth_uses_year_ago_eps_and_sales_not_pe(self):
        latest=pd.Timestamp.now().normalize()-pd.DateOffset(months=3)
        dates=(latest,latest-pd.DateOffset(years=1))
        t=ticker(info={'forwardPE':3},quarterly_financials=frame({'Diluted EPS':[1.3,1.0],'Total Revenue':[130,100]},dates))
        with patch.object(wrapper.yf,'Ticker',return_value=t),patch.object(wrapper,'get_rs_rating_details',return_value={'rating':None,'stale':True}),patch.object(wrapper,'detect_market_direction',return_value={'status':'Unavailable'}):
            c=wrapper.get_canslim_analysis('TEST')['data']['criteria']['C']
        self.assertEqual(c['status'],'Pass')
        self.assertAlmostEqual(c['value'],30)

class RelativeStrengthTests(unittest.TestCase):
    def fixture(self, age_days=0, mixed=False):
        tmp=tempfile.NamedTemporaryFile(suffix='.db')
        now=datetime.now(timezone.utc)
        date=(datetime.now(ZoneInfo('America/New_York'))-timedelta(days=age_days)).date().isoformat()
        with sqlite3.connect(tmp.name) as conn:
            conn.execute('CREATE TABLE universe_cache(symbol TEXT,weighted_score REAL,updated_at TEXT,price_date TEXT,universe_version TEXT)')
            conn.executemany('INSERT INTO universe_cache VALUES(?,?,?,?,?)',[(f'T{i}',i,now.isoformat(),date if not mixed or i else (datetime.now(ZoneInfo('America/New_York'))-timedelta(days=2)).date().isoformat(),'custom-large-cap-v1') for i in range(20)])
        return tmp

    def test_old_price_dates_are_stale_even_when_just_refreshed(self):
        with self.fixture(age_days=10) as tmp,patch.object(wrapper,'get_database_path',return_value=tmp.name):
            r=wrapper.get_rs_rating_details('T19')
            self.assertTrue(r['stale']);self.assertIsNone(r['rating'])

    def test_coherent_universe_reports_scope_date_and_unknown_symbols(self):
        with self.fixture() as tmp,patch.object(wrapper,'get_database_path',return_value=tmp.name):
            r=wrapper.get_rs_rating_details('T19')
            self.assertFalse(r['stale']);self.assertEqual(r['rating'],99);self.assertEqual(r['coverage'],20)
            self.assertIsNone(wrapper.get_rs_rating_details('MISSING')['rating'])

    def test_mixed_date_cohorts_never_look_current(self):
        with self.fixture(mixed=True) as tmp,patch.object(wrapper,'get_database_path',return_value=tmp.name):
            self.assertTrue(wrapper.get_rs_rating_details('T19')['stale'])

if __name__=='__main__': unittest.main()
