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


def canslim(t, now=datetime(2026, 10, 21, 18, tzinfo=timezone.utc)):
    with patch.object(wrapper.yf, 'Ticker', return_value=t), \
         patch.object(wrapper, 'get_rs_rating_details', return_value={'rating':None, 'stale':True}), \
         patch.object(wrapper, 'detect_market_direction', return_value={'status':'Unavailable'}), \
         patch.object(wrapper, 'datetime', wraps=datetime) as clock:
        clock.now.side_effect = lambda tz=None: now.astimezone(tz) if tz else now.replace(tzinfo=None)
        result = wrapper.get_canslim_analysis('TEST')
        assert result['status'] == 'success', result
        return result['data']['criteria']


def volume_history(last_session, observations=51):
    dates = pd.bdate_range(end=last_session, periods=observations, tz='America/New_York')
    return pd.DataFrame({**{name:[100] * observations for name in wrapper.OHLC_COLUMNS},
                         'Volume':[100] * (observations - 1) + [200]}, index=dates)


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

    def test_quarterly_growth_rejects_different_latest_eps_and_sales_quarters(self):
        dates=('2026-08-31','2026-05-31','2025-08-31','2025-05-31')
        t=ticker(quarterly_financials=frame({'Diluted EPS':[1.3,1.3,1,1],
                                          'Total Revenue':[None,130,None,100]}, dates))
        c=canslim(t)['C']
        self.assertEqual(c['status'],'Unknown')
        self.assertIsNone(c['score'])
        self.assertIsNone(c['value'])
        self.assertIsNone(c['salesGrowthPct'])
        self.assertFalse(c['periodsAligned'])
        self.assertEqual(c['periods'],['2026-08-31','2025-08-31'])
        self.assertEqual(c['salesPeriods'],['2026-05-31','2025-05-31'])

    def test_quarterly_growth_does_not_substitute_an_older_aligned_quarter(self):
        dates=('2026-08-31','2026-05-31','2025-08-31','2025-05-31')
        t=ticker(quarterly_financials=frame({'Diluted EPS':[None,1.3,None,1],
                                          'Total Revenue':[None,130,None,100],
                                          'Net Income':[10,10,8,8]}, dates))
        c=canslim(t)['C']
        self.assertEqual(c['status'],'Unknown')
        self.assertFalse(c['periodsAligned'])

    def test_quarterly_growth_requires_the_same_year_ago_period(self):
        dates=('2026-08-31','2025-08-31','2025-08-30')
        t=ticker(quarterly_financials=frame({'Diluted EPS':[1.3,1,None],
                                          'Total Revenue':[130,None,100]}, dates))
        c=canslim(t)['C']
        self.assertEqual(c['status'],'Unknown')
        self.assertIsNone(c['score'])
        self.assertFalse(c['periodsAligned'])

    def test_aligned_fiscal_periods_allow_a_52_or_53_week_reporting_calendar(self):
        dates=('2026-08-29','2025-08-30')
        t=ticker(quarterly_financials=frame({'Diluted EPS':[1.3,1],
                                          'Total Revenue':[130,100]}, dates))
        c=canslim(t)['C']
        self.assertEqual(c['status'],'Pass')
        self.assertAlmostEqual(c['value'],30)
        self.assertAlmostEqual(c['salesGrowthPct'],30)
        self.assertTrue(c['periodsAligned'])
        self.assertEqual(c['periods'],list(dates))
        self.assertEqual(c['salesPeriods'],list(dates))

    def test_aligned_quarters_with_insufficient_sales_growth_still_fail(self):
        t=ticker(quarterly_financials=frame({'Diluted EPS':[1.3,1],
                                          'Total Revenue':[110,100]}, ('2026-08-31','2025-08-31')))
        c=canslim(t)['C']
        self.assertEqual(c['status'],'Fail')
        self.assertEqual(c['score'],25)
        self.assertTrue(c['periodsAligned'])

    def test_stale_volume_is_unknown_and_keeps_actual_evidence_dates(self):
        history=volume_history('2020-01-31')
        s=canslim(ticker(history=lambda **kw:history))['S']
        self.assertEqual(s['status'],'Unknown')
        self.assertIsNone(s['value'])
        self.assertIsNone(s['score'])
        self.assertTrue(s['stale'])
        self.assertEqual(s['periods'],['2020-01-31'])
        self.assertEqual(s['baselinePeriods'],[str(history.index[0].date()),str(history.index[-2].date())])
        self.assertEqual(s['observations'],51)

    def test_completed_volume_stays_current_over_weekends_and_a_market_holiday(self):
        cases=[('2026-10-16',datetime(2026,10,17,16,tzinfo=timezone.utc)),
               ('2026-10-16',datetime(2026,10,19,19,tzinfo=timezone.utc)),
               ('2026-09-04',datetime(2026,9,8,14,tzinfo=timezone.utc)),
               ('2026-10-20',datetime(2026,10,21,18,tzinfo=timezone.utc))]
        for last_session, now in cases:
            with self.subTest(last_session=last_session, now=now):
                history=volume_history(last_session)
                s=canslim(ticker(history=lambda **kw:history),now)['S']
                self.assertEqual(s['status'],'Pass')
                self.assertEqual(s['value'],2)
                self.assertFalse(s['stale'])
                self.assertEqual(s['periods'],[last_session])

    def test_partial_current_session_does_not_replace_completed_volume(self):
        history=volume_history('2026-10-16')
        history.loc[pd.Timestamp('2026-10-19',tz='America/New_York')]=[100,100,100,100,10000]
        s=canslim(ticker(history=lambda **kw:history),datetime(2026,10,19,15,tzinfo=timezone.utc))['S']
        self.assertEqual(s['status'],'Pass')
        self.assertEqual(s['value'],2)
        self.assertEqual(s['periods'],['2026-10-16'])
        self.assertEqual(s['baselinePeriods'][-1],'2026-10-15')

    def test_recent_volume_still_requires_fifty_preceding_observations(self):
        history=volume_history('2026-10-20',observations=50)
        s=canslim(ticker(history=lambda **kw:history))['S']
        self.assertEqual(s['status'],'Unknown')
        self.assertIsNone(s['score'])
        self.assertFalse(s['stale'])
        self.assertEqual(s['observations'],50)
        self.assertEqual(s['periods'],['2026-10-20'])

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
