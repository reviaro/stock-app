#!/usr/bin/env python3
"""
yfinance wrapper for stock dashboard
Takes JSON input from stdin, outputs JSON to stdout
"""
import yfinance as yf
import json
import sys
import argparse
import math
import os
from research_metrics import quality as calculate_quality, number as research_number, periods, quarterly_growth, annual_growth
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from database_path import get_database_path

def _utc_iso_from_epoch(value):
    """Convert a provider epoch timestamp to a stable UTC ISO string."""
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat().replace('+00:00', 'Z')
    except (TypeError, ValueError, OSError):
        return None

def _letter_to_number(letter):
    return {'A': 90, 'B': 75, 'C': 60, 'D': 40, 'F': 20}.get(letter)

def _grade_numeric(value, thresholds, higher_is_better=True):
    """Given a numeric value and [a_threshold, b_threshold, c_threshold], return letter grade.
    higher_is_better=True: value >= thresholds[0] is A, >= thresholds[1] is B, etc.
    higher_is_better=False: value <= thresholds[0] is A, <= thresholds[1] is B, etc.
    """
    if value is None:
        return None
    a, b, c = thresholds
    if higher_is_better:
        if value >= a: return 'A'
        if value >= b: return 'B'
        if value >= c: return 'C'
        return 'D'
    else:
        if value <= a: return 'A'
        if value <= b: return 'B'
        if value <= c: return 'C'
        return 'D'

def _composite_score(grades, weights):
    """grades: {metric: letter_or_None}, weights: {metric: weight}.
    Returns weighted average of letter->number, excluding nulls."""
    total_weight = 0
    total_score = 0
    for k, letter in grades.items():
        if letter is None:
            continue
        w = weights.get(k, 0)
        total_weight += w
        total_score += _letter_to_number(letter) * w
    if total_weight == 0:
        return None
    return round(total_score / total_weight, 1)

def _unavailable(symbol, message='Research provider unavailable'):
    return {'status': 'error', 'error': message, 'symbol': symbol.upper(),
            'meta': {'source': 'yfinance', 'retrievedAt': datetime.now(timezone.utc).isoformat(), 'unavailable': True}}


def _sample_only(data):
    if os.environ.get('SAMPLE_DATA') != '1':
        return None
    if data and isinstance(data.get('data'), dict):
        data['data']['isDemo'] = True
        data['data']['is_demo'] = True
    if data:
        data['meta'] = {'source': 'sample', 'isDemo': True, 'stale': False}
    return data


def _statement_frames(records):
    frame = pd.DataFrame.from_dict(records, orient='index')
    if not frame.empty:
        frame.columns = pd.to_datetime(frame.columns)
        frame = frame.reindex(sorted(frame.columns, reverse=True), axis=1)
    return frame, frame, frame


def get_quality_from_records(symbol, records, info):
    from types import SimpleNamespace
    fin, bs, cf = _statement_frames(records.get('annual', {}))
    result = calculate_quality(SimpleNamespace(info=info, financials=fin, balance_sheet=bs, cashflow=cf), symbol)
    result.update(source='sec_edgar', filingEvidence=records.get('evidence', []), filingCutoff=records.get('asOf'))
    return {'status': 'success', 'data': result, 'meta': {'source': 'sec_edgar', 'retrievedAt': datetime.now(timezone.utc).isoformat()}}


def get_fund_research(symbol):
    try:
        ticker = yf.Ticker(symbol)
        info = ticker.info or {}
        if info.get('quoteType') not in ('ETF', 'MUTUALFUND'):
            return {'status': 'success', 'data': {'symbol': symbol, 'applicable': False}}
        holdings = []
        expense = research_number(info.get('annualReportExpenseRatio'))
        try:
            funds = ticker.funds_data
            top = funds.top_holdings
            for holding_symbol, row in top.iterrows():
                weight = research_number(row.get('Holding Percent'))
                if weight is not None and 0 <= weight <= 1:
                    holdings.append({'symbol': str(holding_symbol), 'weightPct': weight * 100})
            if expense is None:
                expense = research_number(funds.fund_operations.loc['Annual Report Expense Ratio', symbol])
        except Exception:
            pass
        return {'status': 'success', 'data': {'symbol': symbol, 'applicable': True, 'instrumentType': info['quoteType'],
                'expenseRatioPct': expense * 100 if expense is not None else None,
                'benchmark': None, 'holdings': holdings, 'holdingsAsOf': None, 'issuerVerified': False,
                'fundFamily': info.get('fundFamily'), 'totalAssets': research_number(info.get('totalAssets')),
                'limitations': ['Provider top holdings only; publication date and issuer verification unavailable.', 'Use an issuer disclosure before treating look-through exposures as complete.']}}
    except Exception:
        return _unavailable(symbol, 'Fund research unavailable')


def get_quality_metrics(symbol):
    try:
        return {'status': 'success', 'data': calculate_quality(yf.Ticker(symbol), symbol),
                'meta': {'source': 'yfinance', 'retrievedAt': datetime.now(timezone.utc).isoformat()}}
    except Exception:
        return _unavailable(symbol, 'Financial statements unavailable')


def get_demo_data(symbol):
    """Return demo data when network is unavailable"""
    demo_stocks = {
        'AAPL': {'name': 'Apple Inc.', 'price': 178.52, 'change': 2.34, 'sector': 'Technology', 'industry': 'Consumer Electronics', 'marketCap': 2780000000000, 'peRatio': 28.45, 'eps': 6.27, 'week52High': 199.62, 'week52Low': 143.90},
        'MSFT': {'name': 'Microsoft Corporation', 'price': 402.56, 'change': -1.23, 'sector': 'Technology', 'industry': 'Software', 'marketCap': 2990000000000, 'peRatio': 35.2, 'eps': 11.42, 'week52High': 420.82, 'week52Low': 309.45},
        'GOOGL': {'name': 'Alphabet Inc.', 'price': 141.80, 'change': 0.89, 'sector': 'Technology', 'industry': 'Internet Services', 'marketCap': 1780000000000, 'peRatio': 24.8, 'eps': 5.72, 'week52High': 155.20, 'week52Low': 115.35},
        'AMZN': {'name': 'Amazon.com Inc.', 'price': 178.25, 'change': 3.45, 'sector': 'Consumer Cyclical', 'industry': 'Internet Retail', 'marketCap': 1850000000000, 'peRatio': 62.5, 'eps': 2.85, 'week52High': 189.77, 'week52Low': 118.35},
        'TSLA': {'name': 'Tesla Inc.', 'price': 248.50, 'change': -5.20, 'sector': 'Consumer Cyclical', 'industry': 'Auto Manufacturers', 'marketCap': 790000000000, 'peRatio': 75.3, 'eps': 3.30, 'week52High': 299.29, 'week52Low': 152.37},
        'NVDA': {'name': 'NVIDIA Corporation', 'price': 721.28, 'change': 15.67, 'sector': 'Technology', 'industry': 'Semiconductors', 'marketCap': 1780000000000, 'peRatio': 65.4, 'eps': 11.02, 'week52High': 974.00, 'week52Low': 395.97},
        'META': {'name': 'Meta Platforms Inc.', 'price': 474.35, 'change': 2.10, 'sector': 'Technology', 'industry': 'Internet Services', 'marketCap': 1220000000000, 'peRatio': 28.9, 'eps': 16.42, 'week52High': 542.81, 'week52Low': 274.38},
        'JPM': {'name': 'JPMorgan Chase & Co.', 'price': 183.27, 'change': 1.45, 'sector': 'Financial', 'industry': 'Banks', 'marketCap': 528000000000, 'peRatio': 10.8, 'eps': 16.97, 'week52High': 200.94, 'week52Low': 135.19},
        'V': {'name': 'Visa Inc.', 'price': 275.82, 'change': 0.75, 'sector': 'Financial', 'industry': 'Credit Services', 'marketCap': 563000000000, 'peRatio': 30.2, 'eps': 9.13, 'week52High': 290.96, 'week52Low': 227.68},
        'JNJ': {'name': 'Johnson & Johnson', 'price': 156.74, 'change': -0.32, 'sector': 'Healthcare', 'industry': 'Drug Manufacturers', 'marketCap': 377000000000, 'peRatio': 15.3, 'eps': 10.24, 'week52High': 175.97, 'week52Low': 143.13},
    }
    
    symbol = symbol.upper()
    if symbol in demo_stocks:
        d = demo_stocks[symbol]
        return {
            'status': 'success',
            'data': {
                'symbol': symbol,
                'name': d['name'],
                'exchange': 'NASDAQ',
                'sector': d['sector'],
                'industry': d['industry'],
                'currency': 'USD',
                'isDemo': True,
                'timestamp': None,
                'marketState': 'UNKNOWN',
                'price': d['price'],
                'change': d['change'],
                'changePercent': (d['change'] / d['price']) * 100,
                'volume': 50000000,
                'avgVolume': 55000000,
                'bid': 0,
                'ask': 0,
                'open': d['price'] - d['change'],
                'previousClose': d['price'] - d['change'],
                'dayHigh': d['price'] + 2,
                'dayLow': d['price'] - 2,
                'marketCap': d['marketCap'],
                'peRatio': d['peRatio'],
                'eps': d['eps'],
                'beta': 1.0,
                'week52High': d['week52High'],
                'week52Low': d['week52Low'],
                'dividendYield': 0.02,
                'dividendRate': 4.0,
                'exDividendDate': None,
                'sharesOutstanding': int(d['marketCap'] / d['price']),
                'float': int(d['marketCap'] / d['price']),
                'bookValue': 30.0,
                'priceToBook': 5.0,
                'profitMargin': 0.25,
                'returnOnEquity': 0.50,
                'revenue': d['marketCap'] // 10,
                'revenuePerShare': 20.0,
                'grossProfit': d['marketCap'] // 20,
                'operatingCashflow': d['marketCap'] // 15,
                'freeCashflow': d['marketCap'] // 18,
                'forwardPE': d['peRatio'] * 0.9,
                'pegRatio': 2.0,
                'enterpriseValue': d['marketCap'],
                'enterpriseToRevenue': 10,
                'enterpriseToEbitda': 20,
                'sma50': d['price'] * 0.95,
                'sma200': d['price'] * 0.90,
                'currentRatio': 1.5,
                'quickRatio': 1.2,
                'debtToEquity': 0.5,
            }
        }
    return None

def get_demo_history(symbol, period='1y'):
    """Generate demo history data"""
    import random
    import datetime
    
    symbol = symbol.upper()
    base_prices = {
        'AAPL': 175.0, 'MSFT': 400.0, 'GOOGL': 140.0, 'AMZN': 175.0,
        'TSLA': 245.0, 'NVDA': 700.0, 'META': 470.0, 'JPM': 180.0,
        'V': 270.0, 'JNJ': 155.0
    }
    base_price = base_prices.get(symbol, 100.0)
    
    data = []
    days = {'1mo': 30, '3mo': 90, '6mo': 180, '1y': 365, '2y': 730}
    n_days = days.get(period, 365)
    
    price = base_price * 0.8  # Start lower
    
    for i in range(n_days):
        date = datetime.datetime.now() - datetime.timedelta(days=n_days - i)
        
        # Random walk
        change = random.uniform(-0.03, 0.035)
        price = price * (1 + change)
        
        high = price * random.uniform(1.0, 1.03)
        low = price * random.uniform(0.97, 1.0)
        volume = int(random.uniform(30e6, 80e6))
        
        data.append({
            'date': date.isoformat(),
            'open': round(price * 0.995, 2),
            'high': round(high, 2),
            'low': round(low, 2),
            'close': round(price, 2),
            'volume': volume
        })
    
    return {
        'status': 'success',
        'data': {
            'symbol': symbol,
            'range': period,
            'interval': '1d',
            'data': data
        }
    }

def get_demo_indexes():
    """Return demo index data"""
    return {
        'status': 'success',
        'data': {
            '^GSPC': {'symbol': '^GSPC', 'name': 'S&P 500', 'price': 5021.84, 'change': 23.45, 'changePercent': 0.47, 'week52High': 5234.18, 'week52Low': 3810.32, 'volume': 2500000000},
            '^DJI': {'symbol': '^DJI', 'name': 'Dow Jones Industrial Average', 'price': 38654.42, 'change': 134.21, 'changePercent': 0.35, 'week52High': 40169.52, 'week52Low': 28660.94, 'volume': 320000000},
            '^IXIC': {'symbol': '^IXIC', 'name': 'NASDAQ Composite', 'price': 15990.66, 'change': 118.43, 'changePercent': 0.75, 'week52High': 17036.75, 'week52Low': 12277.17, 'volume': 4500000000},
            '^RUT': {'symbol': '^RUT', 'name': 'Russell 2000', 'price': 1998.45, 'change': -12.34, 'changePercent': -0.61, 'week52High': 2163.91, 'week52Low': 1635.75, 'volume': 1200000000},
            '^VIX': {'symbol': '^VIX', 'name': 'VIX Volatility Index', 'price': 13.62, 'change': -0.45, 'changePercent': -3.20, 'week52High': 28.14, 'week52Low': 11.83, 'volume': 0}
        }
    }

def get_demo_canslim(symbol):
    """Return demo CAN SLIM analysis"""
    import random
    
    symbol = symbol.upper()
    
    # Generate scores based on symbol
    scores = {
        'AAPL': {'C': 80, 'A': 65, 'N': 55, 'S': 45, 'L': 85, 'I': 90, 'M': 70},
        'MSFT': {'C': 75, 'A': 70, 'N': 65, 'S': 60, 'L': 80, 'I': 85, 'M': 70},
        'NVDA': {'C': 95, 'A': 90, 'N': 85, 'S': 95, 'L': 95, 'I': 80, 'M': 70},
        'TSLA': {'C': 40, 'A': 50, 'N': 70, 'S': 80, 'L': 60, 'I': 75, 'M': 70},
    }
    
    base = scores.get(symbol, {k: random.randint(40, 80) for k in ['C', 'A', 'N', 'S', 'L', 'I', 'M']})
    
    c, a, n, s, l, i, m = base['C'], base['A'], base['N'], base['S'], base['L'], base['I'], base['M']
    overall = int(c * 0.20 + a * 0.15 + n * 0.15 + s * 0.15 + l * 0.15 + i * 0.10 + m * 0.10)
    
    rating = 'Excellent' if overall >= 80 else 'Good' if overall >= 60 else 'Average' if overall >= 40 else 'Poor'
    
    return {
        'status': 'success',
        'data': {
            'symbol': symbol,
            'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
            'overall': {
                'score': overall,
                'rating': rating,
                'passCount': sum([1 for s in [c, a, n, s, l, i, m] if s >= 50]),
                'failCount': sum([1 for s in [c, a, n, s, l, i, m] if s < 50])
            },
            'criteria': {
                'C': {'name': 'Current Quarterly Earnings', 'score': c, 'status': 'Pass' if c >= 50 else 'Fail', 'value': 1.47},
                'A': {'name': 'Annual Earnings Growth', 'score': a, 'status': 'Pass' if a >= 50 else 'Fail', 'value': 18.2},
                'N': {'name': 'New Factors', 'score': n, 'status': 'Pass' if n >= 50 else 'Fail', 'pricePosition': 0.91},
                'S': {'name': 'Supply and Demand', 'score': s, 'status': 'Pass' if s >= 50 else 'Fail', 'volumeRatio': 0.90},
                'L': {'name': 'Leader or Laggard', 'score': l, 'status': 'Pass' if l >= 50 else 'Fail'},
                'I': {'name': 'Institutional Sponsorship', 'score': i, 'status': 'Pass' if i >= 50 else 'Fail'},
                'M': {'name': 'Market Direction', 'score': m, 'status': 'Pass' if m >= 50 else 'Fail'}
            }
        }
    }

OHLC_COLUMNS = ('Open', 'High', 'Low', 'Close')

def _normalize_bars(hist):
    """Return only bars with finite Open/High/Low/Close, and a finite integer Volume.

    The provider occasionally returns partial bars (volume but NaN prices, or non-finite values).
    One such bar would otherwise poison every later EMA/RSI value and any SMA window containing
    it, become the reported latest price, or crash int(volume). All four OHLC columns are
    required; a frame missing any of them yields no bars. Invalid or missing volume becomes 0.
    """
    if hist is None or len(hist) == 0:
        return hist
    if not all(col in hist.columns for col in OHLC_COLUMNS):
        return hist.iloc[0:0]
    bars = hist.copy()
    for col in OHLC_COLUMNS:
        bars[col] = pd.to_numeric(bars[col], errors='coerce')
    finite = np.isfinite(bars[list(OHLC_COLUMNS)].to_numpy(dtype=float)).all(axis=1)
    bars = bars[finite]
    volume = pd.to_numeric(bars['Volume'], errors='coerce') if 'Volume' in bars.columns else pd.Series(0, index=bars.index)
    volume = volume.where(np.isfinite(volume.to_numpy(dtype=float)), 0)
    bars['Volume'] = volume.astype('int64')
    return bars

def get_stock_info(symbol):
    """Get basic stock info and quote data"""
    # Try yfinance first
    try:
        stock = yf.Ticker(symbol)
        
        # Get current price from history
        hist = stock.history(period="5d", interval="1d", auto_adjust=False, timeout=10)
        hist = _normalize_bars(hist)
        
        price = 0
        change = 0
        changePercent = 0
        volume = 0
        open_price = 0
        prev_close = 0
        day_high = 0
        day_low = 0
        
        if len(hist) > 0:
            latest = hist.iloc[-1]
            price = float(latest['Close'])
            prev_close = float(hist.iloc[-2]['Close']) if len(hist) > 1 else price  # One row: zero change; prior session unknown.
            change = price - prev_close
            changePercent = (change / prev_close * 100) if prev_close else 0
            volume = int(latest['Volume']) if 'Volume' in latest.index else 0
            open_price = float(latest['Open'])
            day_high = float(latest['High'])
            day_low = float(latest['Low'])
        
        # Use one observation for price and timestamp. Unadjusted daily-bar fallback stays dated as a bar.
        info = stock.info
        provider_price = research_number(info.get('regularMarketPrice')) or research_number(info.get('currentPrice'))
        if provider_price is not None and provider_price <= 0:
            provider_price = None
        quote_price = provider_price if provider_price is not None and provider_price > 0 else (price if price > 0 else None)
        if quote_price is None:
            return _unavailable(symbol, 'A verified quote price is unavailable')
        quote_time = _utc_iso_from_epoch(info.get('regularMarketTime')) if provider_price else (_utc_iso_from_epoch(hist.index[-1].timestamp()) if len(hist) and callable(getattr(hist.index[-1], 'timestamp', None)) else None)
        
        return {
            'status': 'success',
            'data': {
                'symbol': symbol.upper(),
                'name': info.get('shortName', info.get('longName', symbol)),
                'exchange': info.get('exchange', 'Unknown'),
                'sector': info.get('sector', 'Unknown'),
                'industry': info.get('industry', 'Unknown'),
                'currency': info.get('currency'),
                'isDemo': False,
                'timestamp': quote_time,
                'priceBasis': 'provider_quote' if provider_price else 'unadjusted_daily_bar',
                'fieldUnits': {'price': info.get('currency'), 'marketCap': info.get('currency'), 'freeCashflow': info.get('currency'), 'peRatio': 'x', 'forwardPE': 'x', 'debtToEquity': '%', 'returnOnEquity': 'fraction'},
                'quoteType': info.get('quoteType'),
                'marketState': info.get('marketState', 'UNKNOWN'),
                'price': quote_price,
                'change': change,
                'changePercent': changePercent,
                'volume': volume,
                'avgVolume': info.get('averageVolume'),
                'bid': 0,
                'ask': 0,
                'open': open_price,
                'previousClose': prev_close,
                'dayHigh': day_high,
                'dayLow': day_low,
                'marketCap': info.get('marketCap'),
                'peRatio': info.get('trailingPE'),
                'eps': info.get('trailingEps'),
                'beta': info.get('beta'),
                'week52High': info.get('fiftyTwoWeekHigh'),
                'week52Low': info.get('fiftyTwoWeekLow'),
                'dividendYield': info.get('dividendYield'),
                'dividendRate': info.get('dividendRate'),
                'exDividendDate': info.get('exDividendDate'),
                'sharesOutstanding': info.get('sharesOutstanding'),
                'float': info.get('floatShares'),
                'bookValue': info.get('bookValue'),
                'priceToBook': info.get('priceToBook'),
                'profitMargin': info.get('profitMargin'),
                'returnOnEquity': info.get('returnOnEquity'),
                'revenue': info.get('totalRevenue'),
                'revenuePerShare': info.get('revenuePerShare'),
                'grossProfit': info.get('grossProfit'),
                'operatingCashflow': info.get('operatingCashflow'),
                'freeCashflow': info.get('freeCashflow'),
                'forwardPE': info.get('forwardPE'),
                'pegRatio': info.get('pegRatio'),
                'enterpriseValue': info.get('enterpriseValue'),
                'enterpriseToRevenue': info.get('enterpriseToRevenue'),
                'enterpriseToEbitda': info.get('enterpriseToEbitda'),
                'sma50': info.get('fiftyDayAverage'),
                'sma200': info.get('twoHundredDayAverage'),
                'currentRatio': info.get('currentRatio'),
                'quickRatio': info.get('quickRatio'),
                'debtToEquity': info.get('debtToEquity'),
            }
        }
    except Exception as e:
        demo = _sample_only(get_demo_data(symbol))
        return demo if demo else _unavailable(symbol)

def get_stock_info_batch(symbols):
    """Fetch several symbols concurrently inside one Python process."""
    normalized = list(dict.fromkeys(
        str(symbol).strip().upper() for symbol in (symbols or []) if str(symbol).strip()
    ))
    if not normalized:
        return {'status': 'success', 'data': {}}

    worker_count = min(8, len(normalized))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        results = list(executor.map(get_stock_info, normalized))
    return {
        'status': 'success',
        'data': dict(zip(normalized, results)),
    }

def get_screener_inputs_batch(symbols):
    """Load stock, quality, and technical inputs in one bounded process."""
    normalized = list(dict.fromkeys(
        str(symbol).strip().upper() for symbol in (symbols or []) if str(symbol).strip()
    ))
    if not normalized:
        return {'status': 'success', 'data': {}}

    def load_symbol(symbol):
        return {
            'stock': get_stock_info(symbol),
            'quality': get_quality_metrics(symbol),
            'technical': get_technical_indicators(symbol),
        }

    worker_count = min(8, len(normalized))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        results = list(executor.map(load_symbol, normalized))
    return {
        'status': 'success',
        'data': dict(zip(normalized, results)),
    }

def get_history(symbol, period='1y', interval='1d'):
    """Get historical price data"""
    # Try yfinance first, fallback to demo if needed
    try:
        stock = yf.Ticker(symbol)
        hist = stock.history(period=period, interval=interval, auto_adjust=True, timeout=10)
        
        hist = _normalize_bars(hist)

        data = []
        for idx, row in hist.iterrows():
            data.append({
                'date': idx.isoformat(),
                'open': round(float(row['Open']), 2),
                'high': round(float(row['High']), 2),
                'low': round(float(row['Low']), 2),
                'close': round(float(row['Close']), 2),
                'volume': int(row['Volume'])
            })

        return {
            'status': 'success',
            'data': {
                'symbol': symbol.upper(),
                'range': period,
                'interval': interval,
                'adjustment': 'dividend_and_split_adjusted',
                'data': data
            }
        }
    except Exception as e:
        # Fallback to demo
        demo = _sample_only(get_demo_history(symbol, period))
        if demo:
            return demo
        return {'status': 'error', 'error': str(e)}

def get_rs_rating_details(symbol):
    """Custom-universe percentile; unknown and stale data are never neutral passes."""
    import sqlite3
    result = {'rating': None, 'stale': True, 'universe': 'custom-large-cap', 'asOf': None, 'coverage': 0}
    try:
        path = get_database_path()
        if not os.path.exists(path):
            return result
        with sqlite3.connect(path) as conn:
            rows = conn.execute('SELECT symbol, weighted_score, updated_at, price_date, universe_version FROM universe_cache').fetchall()
        result['coverage'] = len(rows)
        if len(rows) < 10:
            return result
        times = [datetime.fromisoformat(row[2].replace('Z', '+00:00')).replace(tzinfo=timezone.utc) for row in rows]
        result['refreshedAt'] = min(times).isoformat()
        dates = [row[3] for row in rows]
        from zoneinfo import ZoneInfo
        today = datetime.now(ZoneInfo('America/New_York')).date()
        if any(not date or not str(row[4]).startswith('custom-large-cap-') for row, date in zip(rows, dates)) or len(set(dates)) != 1 or len({row[4] for row in rows}) != 1:
            return result
        age_days = (today - datetime.fromisoformat(dates[0]).date()).days
        if age_days < 0 or age_days > 4:
            return result
        result['asOf'] = dates[0]
        result['universe'] = rows[0][4]
        result['weightedScoreMethod'] = 'custom-quarterly-weighted-performance-v1'
        result['cohort'] = [{'symbol': row[0], 'weightedScore': row[1]} for row in sorted(rows)]
        now = datetime.now(timezone.utc)
        if any((now - stamp).total_seconds() > 96 * 3600 or (stamp - now).total_seconds() > 60 for stamp in times):
            return result
        if (max(times) - min(times)).total_seconds() > 3600:
            return result
        df = pd.DataFrame(rows, columns=['symbol', 'weighted_score', 'updated_at', 'price_date', 'universe_version'])
        df['rank_pct'] = df['weighted_score'].rank(pct=True)
        match = df[df['symbol'] == symbol.upper()]
        if match.empty:
            return result
        result.update(rating=max(1, min(99, int(match['rank_pct'].values[0] * 99))), stale=False)
        return result
    except Exception:
        return result


def get_rs_rating_from_cache(symbol):
    details = get_rs_rating_details(symbol)
    return details['rating'], details['stale']


def _history_is_current(history):
    try:
        event = history.index[-1].to_pydatetime()
        if event.tzinfo is None:
            event = event.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - event).total_seconds()
        return -60 <= age <= 96 * 3600
    except Exception:
        return False


def detect_market_direction(index_symbol='^IXIC'):
    """
    Analyzes the Nasdaq Composite for Follow-Through Days (FTD).

    FTD Rules (O'Neil):
    - Identify the most recent correction: >= 5% decline from a recent peak.
    - Day 1: First day the index closes HIGHER after that correction begins.
    - Day 4-10 after Day 1: Index gains >= 1.25% on volume HIGHER than prior day
      AND volume must be above 10-day average (guard against low-volume false positives).
    - If FTD occurs: 'Confirmed Uptrend'
    - If index breaks below Day 1 low: 'Market in Correction'
    - Otherwise: 'Uptrend Under Pressure'

    Returns dict with keys: status, ftd_detected, ftd_day (optional), ftd_gain_pct (optional)
    """
    try:
        index = yf.Ticker(index_symbol)
        hist = index.history(period='6mo', interval='1d', timeout=10)
        hist = _normalize_bars(hist)

        if hist is None or len(hist) < 60 or not _history_is_current(hist):
            return {'status': 'Unavailable', 'ftd_detected': False, 'reason': 'Insufficient market history'}

        closes = hist['Close'].values
        volumes = hist['Volume'].values

        # Find the most recent peak in the last 60 trading days
        lookback = min(60, len(closes))
        peak_offset = np.argmax(closes[-lookback:])
        peak_idx = len(closes) - lookback + peak_offset
        peak_price = closes[peak_idx]

        # Find if a >= 5% correction occurred after the peak
        correction_start = None
        for i in range(peak_idx + 1, len(closes)):
            if closes[i] < peak_price * 0.95:
                # Confirmed correction. Now find Day 1: first up-close day
                for j in range(i, len(closes) - 1):
                    if closes[j + 1] > closes[j]:
                        correction_start = j + 1  # Day 1
                        break
                break

        if correction_start is None:
            # No correction found — market hasn't dropped 5% from recent peak
            # Check if we're above 200-day SMA as a fallback signal
            if len(closes) >= 200:
                sma200 = np.mean(closes[-200:])
                if closes[-1] > sma200:
                    return {'status': 'Confirmed Uptrend', 'ftd_detected': False}
            return {'status': 'Unavailable', 'ftd_detected': False, 'reason': 'Insufficient market history'}

        day1_low = closes[correction_start]

        # Compute 10-day average volume for false-positive guard
        avg_vol_10d = np.mean(volumes[max(0, correction_start - 10):correction_start]) if correction_start >= 10 else np.mean(volumes[:correction_start]) if correction_start > 0 else 0

        # Scan Day 4-10 after Day 1 for FTD
        for day_num in range(3, min(10, len(closes) - correction_start)):
            i = correction_start + day_num
            if i >= len(closes) or i < 1:
                continue

            gain_pct = (closes[i] - closes[i - 1]) / closes[i - 1] * 100
            vol_up = volumes[i] > volumes[i - 1]
            vol_above_avg = volumes[i] > avg_vol_10d if avg_vol_10d > 0 else True

            if gain_pct >= 1.25 and vol_up and vol_above_avg:
                return {
                    'status': 'Confirmed Uptrend',
                    'ftd_detected': True,
                    'ftd_day': int(day_num + 1),
                    'ftd_gain_pct': round(gain_pct, 2),
                }

            # If index breaks below Day 1 low → back in correction
            if closes[i] < day1_low:
                return {'status': 'Market in Correction', 'ftd_detected': False}

        return {'status': 'Uptrend Under Pressure', 'ftd_detected': False}
    except Exception as e:
        # Missing market evidence is explicit, never a neutral pass
        return {'status': 'Unavailable', 'ftd_detected': False, 'reason': 'Insufficient market history'}

def get_canslim_analysis(symbol, statements=None):
    """Measured earnings growth with explicitly named price/ownership proxies."""
    try:
        stock = yf.Ticker(symbol)
        info = stock.info or {}
        if info.get('quoteType') in ('ETF', 'MUTUALFUND'):
            return {'status': 'success', 'data': {'symbol': symbol.upper(), 'applicable': False, 'generatedAt': datetime.now(timezone.utc).isoformat(),
                    'overall': {'score': None, 'rating': 'Not applicable', 'passCount': 0, 'failCount': 0, 'unknownCount': 7},
                    'criteria': {}, 'instrumentType': info['quoteType'], 'notes': ['Company earnings criteria do not apply to funds.']}}
        quarterly = _statement_frames(statements.get('quarterly', {}))[0] if statements else stock.quarterly_financials
        annual = _statement_frames(statements.get('annual', {}))[0] if statements else stock.financials
        eps_growth, eps_dates = quarterly_growth(periods(quarterly, 'Diluted EPS', 'Basic EPS'))
        sales_growth, sales_dates = quarterly_growth(periods(quarterly, 'Total Revenue'))
        # A missing row must not silently move either metric to an older quarter.
        # Select the fiscal periods from the statement before checking each series.
        latest_quarter = max(quarterly.columns) if quarterly is not None and len(quarterly.columns) else None
        prior_quarters = [d for d in quarterly.columns if 320 <= (latest_quarter - d).days <= 410] if latest_quarter is not None else []
        expected_quarters = [latest_quarter, min(prior_quarters, key=lambda d: abs((latest_quarter - d).days - 365))] if prior_quarters else []
        quarters_aligned = len(expected_quarters) == 2 and eps_dates == sales_dates == expected_quarters
        if not quarters_aligned:
            eps_growth = sales_growth = None
        annual_eps = periods(annual, 'Diluted EPS', 'Basic EPS')
        annual_cagr = annual_growth(annual_eps)
        today_utc = datetime.now(timezone.utc).date()
        if not eps_dates or not 0 <= (today_utc - max(eps_dates).date()).days <= 200:
            eps_growth = None
        if not sales_dates or not 0 <= (today_utc - max(sales_dates).date()).days <= 200:
            sales_growth = None
        if not annual_eps or not 0 <= (today_utc - max(annual_eps).date()).days <= 550:
            annual_cagr = None
        price = research_number(info.get('currentPrice')) or research_number(info.get('regularMarketPrice'))
        high = research_number(info.get('fiftyTwoWeekHigh'))
        quote_epoch = research_number(info.get('regularMarketTime'))
        if quote_epoch is None or not -60 <= datetime.now(timezone.utc).timestamp() - quote_epoch <= 96 * 3600:
            price = None
        proximity = price / high if price is not None and high is not None and high > 0 else None
        hist = _normalize_bars(stock.history(period='1y', interval='1d', timeout=10))
        volume_ratio = None
        volume_dates, volume_baseline_dates = [], []
        volume_stale, volume_observations = True, 0
        from zoneinfo import ZoneInfo
        today = datetime.now(ZoneInfo('America/New_York')).date()
        if hist is not None and len(hist):
            completed = hist[[d.date() < today for d in hist.index]].sort_index()
            volume_observations = min(len(completed), 51)
            if len(completed):
                volume_dates = [completed.index[-1]]
                # Daily bars use session dates, matching the RS cache convention;
                # four calendar days accommodates weekends and a market holiday.
                volume_stale = not 0 <= (today - completed.index[-1].date()).days <= 4
            if len(completed) >= 51:
                volume_baseline_dates = [completed.index[-51], completed.index[-2]]
                avg_volume = float(completed['Volume'].iloc[-51:-1].mean())
                if not volume_stale and avg_volume > 0 and (completed['Volume'].iloc[-51:] > 0).all():
                    volume_ratio = float(completed['Volume'].iloc[-1]) / avg_volume
        institutional = research_number(info.get('heldByInstitutions'))
        if institutional is not None and not 0 <= institutional <= 1:
            institutional = None
        rs = get_rs_rating_details(symbol)
        market = detect_market_direction()
        market_score = {'Confirmed Uptrend': 90, 'Uptrend Under Pressure': 40, 'Market in Correction': 15}.get(market.get('status'))
        def criterion(name, value, passing, method, dates=()):
            return {'name': name, 'value': value, 'score': None if value is None else 100 if passing else 25,
                    'status': 'Unknown' if value is None else 'Pass' if passing else 'Fail',
                    'method': method, 'periods': [str(d)[:10] for d in dates]}
        criteria = {
            'C': criterion('Quarterly EPS and Sales Growth', eps_growth, eps_growth is not None and sales_growth is not None and eps_growth >= 25 and sales_growth >= 25,
                           'Latest reported quarter versus the same quarter one year earlier; both EPS and sales must grow at least 25%', eps_dates),
            'A': criterion('Annual EPS Growth', annual_cagr, annual_cagr is not None and annual_cagr >= 25,
                           'EPS CAGR over at least three elapsed fiscal years; 25% threshold', sorted(annual_eps, reverse=True)),
            'N': criterion('52-week High Proximity Proxy', proximity, proximity is not None and proximity >= .95,
                           'Within 5% of reported 52-week high; does not measure new products or management'),
            'S': criterion('Completed-session Volume Proxy', volume_ratio, volume_ratio is not None and volume_ratio >= 1.5,
                           'Last completed session volume / preceding 50 completed sessions; 1.5x threshold; session date must be within four calendar days', volume_dates),
            'L': criterion('Custom-universe Relative Strength', rs['rating'], rs['rating'] is not None and rs['rating'] >= 80,
                           '80th percentile in the dated custom large-cap universe; not an official IBD rating'),
            'I': criterion('Institutional Ownership Proxy', institutional, institutional is not None and institutional >= .1,
                           'At least 10% reported institutional ownership; does not establish increasing sponsorship'),
            'M': criterion('Market Direction', market_score, market.get('status') == 'Confirmed Uptrend',
                           'Nasdaq follow-through and distribution-day heuristic'),
        }
        if sales_growth is None:
            criteria['C'].update(score=None, status='Unknown')
        criteria['C']['salesGrowthPct'] = sales_growth
        criteria['C']['salesPeriods'] = [str(d)[:10] for d in sales_dates]
        criteria['C']['periodsAligned'] = quarters_aligned
        criteria['S'].update(stale=volume_stale, observations=volume_observations,
                             baselinePeriods=[str(d)[:10] for d in volume_baseline_dates])
        known = [v for v in criteria.values() if v['score'] is not None]
        score = round(sum(v['score'] for v in known) / len(known)) if len(known) >= 5 else None
        return {'status': 'success', 'data': {'symbol': symbol.upper(), 'applicable': True,
                'cache_stale': rs['stale'], 'relativeStrength': rs,
                'generatedAt': datetime.now(timezone.utc).isoformat(),
                'overall': {'score': score, 'rating': 'Insufficient evidence' if score is None else 'Excellent' if score >= 80 else 'Good' if score >= 60 else 'Poor',
                            'passCount': sum(v['status'] == 'Pass' for v in criteria.values()),
                            'failCount': sum(v['status'] == 'Fail' for v in criteria.values()),
                            'unknownCount': sum(v['status'] == 'Unknown' for v in criteria.values()), 'coveragePct': round(len(known)/7*100)},
                'criteria': criteria}}
    except Exception:
        return _sample_only(get_demo_canslim(symbol)) or _unavailable(symbol, 'Earnings and price evidence unavailable')


def get_market_indexes():
    """Get major market indexes"""
    # Always try yfinance first, only fallback to demo on failure
    try:
        indexes = {
            '^GSPC': 'S&P 500',
            '^DJI': 'Dow Jones Industrial Average',
            '^IXIC': 'NASDAQ Composite',
            '^RUT': 'Russell 2000',
            '^VIX': 'VIX Volatility Index'
        }
        
        result = {}
        for symbol, name in indexes.items():
            try:
                ticker = yf.Ticker(symbol)
                hist = ticker.history(period="5d", interval="1d", timeout=10)
                hist = _normalize_bars(hist)
                info = ticker.info
                
                price = 0
                change = 0
                changePercent = 0
                volume = 0
                
                if len(hist) > 0:
                    latest = hist.iloc[-1]
                    price = float(latest['Close'])
                    prev_close = float(hist.iloc[-2]['Close']) if len(hist) > 1 else price  # One row: zero change; prior session unknown.
                    change = price - prev_close
                    changePercent = (change / prev_close * 100) if prev_close else 0
                    volume = int(latest['Volume']) if 'Volume' in latest.index else 0
                
                result[symbol] = {
                    'symbol': symbol,
                    'name': name,
                    'price': price,
                    'change': change,
                    'changePercent': changePercent,
                    'week52High': info.get('fiftyTwoWeekHigh', 0) if info else 0,
                    'week52Low': info.get('fiftyTwoWeekLow', 0) if info else 0,
                    'volume': volume
                }
            except Exception as e:
                result[symbol] = {'symbol': symbol, 'name': name, 'error': str(e)}
        
        return {'status': 'success', 'data': result}
    except Exception as e:
        demo = _sample_only(get_demo_indexes())
        if demo:
            return demo
        return {'status': 'error', 'error': str(e)}

def get_news(symbol):
    """Get latest news for a stock symbol"""
    try:
        stock = yf.Ticker(symbol)
        news = stock.news
        if not news:
            return {'status': 'success', 'data': []}
        
        formatted_news = []
        for item in news[:10]:
            n = item.get('content') or item
            
            title = n.get('title', '')
            pub_date = n.get('pubDate') or n.get('providerPublishTime', '')
            
            provider_dict = n.get('provider') or {}
            publisher = provider_dict.get('displayName') or n.get('publisher', '')
            
            click_through = n.get('clickThroughUrl') or {}
            canonical = n.get('canonicalUrl') or {}
            link = click_through.get('url') or canonical.get('url') or n.get('link', '')
            
            formatted_news.append({
                'title': title,
                'publisher': publisher,
                'link': link,
                'providerPublishTime': pub_date
            })
            
        return {
            'status': 'success',
            'data': formatted_news
        }
    except Exception as e:
        return {'status': 'error', 'error': str(e)}

def calculate_rsi(prices, period=14):
    """Calculate Relative Strength Index"""
    if len(prices) < period + 1:
        return []
    
    deltas = np.diff(prices)
    gains = np.where(deltas > 0, deltas, 0)
    losses = np.where(deltas < 0, -deltas, 0)
    
    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])
    
    rsi_values = []
    if avg_loss == 0:
        rsi_values = [100.0] * (period + 1)
    else:
        rs = avg_gain / avg_loss
        rsi_values.append(100 - (100 / (1 + rs)))
    
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        
        if avg_loss == 0:
            rsi_values.append(100.0)
        else:
            rs = avg_gain / avg_loss
            rsi_values.append(100 - (100 / (1 + rs)))
    
    return rsi_values

def calculate_macd(prices, fast=12, slow=26, signal=9):
    """Calculate MACD - returns line, signal, histogram"""
    if len(prices) < slow + signal:
        return [], [], []
    
    # Calculate EMAs
    def calc_ema(data, period):
        ema = [data[0]]
        multiplier = 2 / (period + 1)
        for i in range(1, len(data)):
            ema.append((data[i] - ema[-1]) * multiplier + ema[-1])
        return ema
    
    ema_fast = calc_ema(prices, fast)
    ema_slow = calc_ema(prices, slow)
    
    # MACD line
    macd_line = [ema_fast[i] - ema_slow[i] for i in range(len(ema_slow))]
    
    # Signal line (EMA of MACD)
    signal_line = calc_ema(macd_line, signal)
    
    # Histogram
    histogram = []
    signal_start = len(macd_line) - len(signal_line)
    for i in range(len(signal_line)):
        histogram.append(macd_line[signal_start + i] - signal_line[i])
    
    return macd_line, signal_line, histogram

def calculate_sma(prices, period):
    """Calculate Simple Moving Average"""
    sma = []
    for i in range(len(prices)):
        if i < period - 1:
            sma.append(None)
        else:
            sma.append(np.mean(prices[i - period + 1:i + 1]))
    return sma

def calculate_ema(prices, period):
    """Calculate Exponential Moving Average"""
    ema = [prices[0]]
    multiplier = 2 / (period + 1)
    for i in range(1, len(prices)):
        ema.append((prices[i] - ema[-1]) * multiplier + ema[-1])
    return ema

def calculate_bollinger_bands(prices, period=20, num_std=2):
    """Calculate Bollinger Bands - returns upper, middle, lower"""
    if len(prices) < period:
        return [], [], []
    
    middle = calculate_sma(prices, period)
    upper = []
    lower = []
    
    for i in range(len(prices)):
        if i < period - 1:
            upper.append(None)
            lower.append(None)
        else:
            slice_prices = prices[i - period + 1:i + 1]
            std = np.std(slice_prices)
            middle_val = middle[i]
            upper.append(middle_val + (std * num_std))
            lower.append(middle_val - (std * num_std))
    
    return upper, middle, lower

def calculate_atr(high, low, close, period=14):
    """Calculate Average True Range"""
    if len(high) < 2:
        return []
    
    tr = []
    tr.append(high[0] - low[0])
    
    for i in range(1, len(high)):
        h_l = high[i] - low[i]
        h_c = abs(high[i] - close[i - 1])
        l_c = abs(low[i] - close[i - 1])
        tr.append(max(h_l, h_c, l_c))
    
    atr = []
    for i in range(len(tr)):
        if i < period - 1:
            atr.append(None)
        elif i == period - 1:
            atr.append(np.mean(tr[:period]))
        else:
            atr.append((atr[-1] * (period - 1) + tr[i]) / period)
    
    return atr

def get_technical_indicators(symbol):
    """Get technical indicators for a stock"""
    try:
        stock = yf.Ticker(symbol)
        # Get enough data for all indicators (need 200+ days for SMA200)
        hist = stock.history(period="1y", interval="1d", timeout=10)
        hist = _normalize_bars(hist)
        
        if hist is None or len(hist) < 30 or not _history_is_current(hist):
            return _sample_only(get_demo_technical(symbol)) or _unavailable(symbol, 'Technical history unavailable')
        
        # Extract price data
        closes = hist['Close'].values.tolist()
        highs = hist['High'].values.tolist()
        lows = hist['Low'].values.tolist()
        
        # Calculate indicators
        rsi = calculate_rsi(closes, 14)
        macd_line, macd_signal, macd_histogram = calculate_macd(closes, 12, 26, 9)
        
        sma_20 = calculate_sma(closes, 20)
        sma_50 = calculate_sma(closes, 50)
        sma_200 = calculate_sma(closes, 200)
        
        ema_12 = calculate_ema(closes, 12)
        ema_21 = calculate_ema(closes, 21)
        ema_26 = calculate_ema(closes, 26)

        bb_upper, bb_middle, bb_lower = calculate_bollinger_bands(closes, 20, 2)
        
        atr = calculate_atr(highs, lows, closes, 14)
        
        # Get current values (latest)
        current_price = closes[-1]
        
        def get_latest(values, default=0):
            for v in reversed(values):
                if v is not None:
                    return round(v, 4)
            return default
        
        def get_latest_multi(values, default=0):
            result = []
            for arr in values:
                for v in reversed(arr):
                    if v is not None:
                        result.append(round(v, 4))
                        break
                else:
                    result.append(default)
            return result
        
        # Prepare historical data for charts (last 60 points)
        chart_start = -60
        
        # RSI chart data
        rsi_chart = []
        for i in range(chart_start, 0):
            if i + len(rsi) > 0 and i >= -len(rsi):
                val = rsi[i + len(rsi) - 1] if i + len(rsi) - 1 < len(rsi) else None
                if val:
                    rsi_chart.append(val)
        
        # MACD chart data
        macd_chart = {'line': [], 'signal': [], 'histogram': []}
        macd_offset = len(macd_line) - len(macd_signal)
        for i in range(chart_start, 0):
            idx = i + len(macd_line)
            if idx >= 0 and idx < len(macd_line):
                macd_chart['line'].append(round(macd_line[idx], 4))
            else:
                macd_chart['line'].append(None)
            
            signal_idx = i + len(macd_signal)
            if signal_idx >= 0 and signal_idx < len(macd_signal):
                macd_chart['signal'].append(round(macd_signal[signal_idx], 4))
            else:
                macd_chart['signal'].append(None)
            
            hist_idx = i + len(macd_histogram)
            if hist_idx >= 0 and hist_idx < len(macd_histogram):
                macd_chart['histogram'].append(round(macd_histogram[hist_idx], 4))
            else:
                macd_chart['histogram'].append(None)
        
        # SMA 50 chart data (last 60 points, aligned with chart_start)
        sma50_chart = []
        for i in range(chart_start, 0):
            idx = i + len(sma_50)
            if idx >= 0 and idx < len(sma_50):
                val = sma_50[idx]
                sma50_chart.append(round(val, 2) if val is not None else None)
            else:
                sma50_chart.append(None)

        # SMA 200 chart data (last 60 points, aligned with chart_start)
        sma200_chart = []
        for i in range(chart_start, 0):
            idx = i + len(sma_200)
            if idx >= 0 and idx < len(sma_200):
                val = sma_200[idx]
                sma200_chart.append(round(val, 2) if val is not None else None)
            else:
                sma200_chart.append(None)

        # EMA 21 chart data (last 60 points, aligned with chart_start)
        ema21_chart = []
        for i in range(chart_start, 0):
            idx = i + len(ema_21)
            if idx >= 0 and idx < len(ema_21):
                val = ema_21[idx]
                ema21_chart.append(round(val, 2) if val is not None else None)
            else:
                ema21_chart.append(None)

        # Bollinger Bands chart data
        bb_chart = {'upper': [], 'middle': [], 'lower': [], 'price': []}
        for i in range(chart_start, 0):
            idx = i + len(bb_upper)
            if idx >= 0 and idx < len(bb_upper):
                bb_chart['upper'].append(round(bb_upper[idx], 2) if bb_upper[idx] else None)
                bb_chart['middle'].append(round(bb_middle[idx], 2) if bb_middle[idx] else None)
                bb_chart['lower'].append(round(bb_lower[idx], 2) if bb_lower[idx] else None)
                price_idx = i + len(closes)
                if price_idx >= 0 and price_idx < len(closes):
                    bb_chart['price'].append(closes[price_idx])
                else:
                    bb_chart['price'].append(None)
            else:
                bb_chart['upper'].append(None)
                bb_chart['middle'].append(None)
                bb_chart['lower'].append(None)
                bb_chart['price'].append(None)
        
        return {
            'status': 'success',
            'data': {
                'symbol': symbol.upper(),
                'generatedAt': datetime.now(timezone.utc).isoformat(),
                'timestamp': hist.index[-1].isoformat(),
                'current': {
                    'price': round(current_price, 2),
                    'rsi': get_latest(rsi),
                    'macd': {
                        'line': get_latest(macd_line),
                        'signal': get_latest(macd_signal),
                        'histogram': get_latest(macd_histogram)
                    },
                    'sma': {
                        '20': get_latest(sma_20),
                        '50': get_latest(sma_50),
                        '200': get_latest(sma_200)
                    },
                    'ema': {
                        '12': get_latest(ema_12),
                        '21': get_latest(ema_21),
                        '26': get_latest(ema_26)
                    },
                    'bollingerBands': {
                        'upper': get_latest(bb_upper),
                        'middle': get_latest(bb_middle),
                        'lower': get_latest(bb_lower)
                    },
                    'atr': get_latest(atr)
                },
                'interpretation': {
                    'rsi': 'Overbought' if get_latest(rsi) > 70 else 'Oversold' if get_latest(rsi) < 30 else 'Neutral',
                    'macd': 'Bullish' if get_latest(macd_line) > get_latest(macd_signal) else 'Bearish',
                    'priceVsSma20': 'Above' if current_price > get_latest(sma_20) else 'Below',
                    'priceVsSma50': 'Above' if current_price > get_latest(sma_50) else 'Below',
                    'priceVsSma200': 'Above' if current_price > get_latest(sma_200) else 'Below',
                    'priceVsBb': 'Upper Band' if current_price > get_latest(bb_upper) else 'Lower Band' if current_price < get_latest(bb_lower) else 'Middle'
                },
                'charts': {
                    'rsi': rsi_chart,
                    'macd': macd_chart,
                    'bollingerBands': bb_chart,
                    'sma50': sma50_chart,
                    'sma200': sma200_chart,
                    'ema21': ema21_chart
                }
            }
        }
    except Exception as e:
        return _sample_only(get_demo_technical(symbol)) or _unavailable(symbol, 'Technical history unavailable')

def get_earnings_calendar(symbol):
    """Get upcoming earnings date for a stock"""
    try:
        stock = yf.Ticker(symbol)
        cal = stock.calendar
        if cal is None:
            return {'status': 'success', 'data': {'earningsDate': None, 'symbol': symbol}}

        earnings_date = None
        if isinstance(cal, dict):
            ed = cal.get('Earnings Date')
            if ed is not None:
                if hasattr(ed, '__iter__') and not isinstance(ed, str):
                    ed_list = list(ed)
                    if ed_list:
                        earnings_date = str(ed_list[0])[:10]
                else:
                    earnings_date = str(ed)[:10]

        return {'status': 'success', 'data': {'earningsDate': earnings_date, 'symbol': symbol}}
    except Exception as e:
        return {'status': 'error', 'error': str(e)}


SECTOR_ETFS = {
    'XLK': 'Technology',
    'XLF': 'Financials',
    'XLV': 'Health Care',
    'XLE': 'Energy',
    'XLI': 'Industrials',
    'XLY': 'Cons. Discretionary',
    'XLP': 'Cons. Staples',
    'XLB': 'Materials',
    'XLRE': 'Real Estate',
    'XLU': 'Utilities',
    'XLC': 'Comm. Services',
}

def get_sector_performance():
    """Get 1M, 3M, 6M performance for each sector ETF"""
    try:
        results = []
        for ticker, sector_name in SECTOR_ETFS.items():
            try:
                etf = yf.Ticker(ticker)
                hist = etf.history(period='6mo')
                hist = _normalize_bars(hist)
                if hist.empty or len(hist) < 5:
                    continue
                current = float(hist['Close'].iloc[-1])

                def pct_change(days):
                    idx = max(0, len(hist) - days)
                    base = float(hist['Close'].iloc[idx])
                    return round(((current - base) / base * 100), 2) if base else 0

                results.append({
                    'ticker': ticker,
                    'name': sector_name,
                    'change1M': pct_change(21),
                    'change3M': pct_change(63),
                    'change6M': pct_change(126),
                    'price': round(current, 2),
                })
            except Exception:
                continue
        results.sort(key=lambda x: x['change1M'], reverse=True)
        return {'status': 'success', 'data': results}
    except Exception as e:
        return {'status': 'error', 'error': str(e)}


def get_demo_technical(symbol):
    """Return demo technical indicators"""
    import random
    import datetime
    
    symbol = symbol.upper()
    base_prices = {
        'AAPL': 175.0, 'MSFT': 400.0, 'GOOGL': 140.0, 'AMZN': 175.0,
        'TSLA': 245.0, 'NVDA': 700.0, 'META': 470.0, 'JPM': 180.0,
        'V': 270.0, 'JNJ': 155.0
    }
    base_price = base_prices.get(symbol, 100.0)
    
    # Generate realistic values around base price
    current_price = base_price * random.uniform(0.95, 1.05)
    rsi_val = random.uniform(30, 70)
    macd_line = random.uniform(-5, 5)
    macd_signal = macd_line * random.uniform(0.8, 1.2)
    sma_20 = current_price * random.uniform(0.95, 1.02)
    sma_50 = current_price * random.uniform(0.90, 1.05)
    sma_200 = current_price * random.uniform(0.85, 1.10)
    bb_upper = current_price * 1.05
    bb_middle = current_price
    bb_lower = current_price * 0.95
    atr_val = current_price * 0.02
    
    # Generate chart data
    rsi_chart = [random.uniform(30, 70) for _ in range(60)]
    macd_line_chart = [random.uniform(-5, 5) for _ in range(60)]
    macd_signal_chart = [random.uniform(-5, 5) for _ in range(60)]
    macd_hist_chart = [macd_line_chart[i] - macd_signal_chart[i] for i in range(60)]
    bb_chart = {
        'upper': [current_price * random.uniform(1.03, 1.07) for _ in range(60)],
        'middle': [current_price * random.uniform(0.98, 1.02) for _ in range(60)],
        'lower': [current_price * random.uniform(0.93, 0.97) for _ in range(60)],
        'price': [current_price * random.uniform(0.95, 1.05) for _ in range(60)]
    }
    
    return {
        'status': 'success',
        'data': {
            'symbol': symbol,
            'generatedAt': datetime.datetime.utcnow().isoformat() + 'Z',
            'current': {
                'price': round(current_price, 2),
                'rsi': round(rsi_val, 2),
                'macd': {
                    'line': round(macd_line, 2),
                    'signal': round(macd_signal, 2),
                    'histogram': round(macd_line - macd_signal, 2)
                },
                'sma': {
                    '20': round(sma_20, 2),
                    '50': round(sma_50, 2),
                    '200': round(sma_200, 2)
                },
                'ema': {
                    '12': round(current_price * 1.01, 2),
                    '21': round(current_price * 1.005, 2),
                    '26': round(current_price * 0.99, 2)
                },
                'bollingerBands': {
                    'upper': round(bb_upper, 2),
                    'middle': round(bb_middle, 2),
                    'lower': round(bb_lower, 2)
                },
                'atr': round(atr_val, 2)
            },
            'interpretation': {
                'rsi': 'Overbought' if rsi_val > 70 else 'Oversold' if rsi_val < 30 else 'Neutral',
                'macd': 'Bullish' if macd_line > macd_signal else 'Bearish',
                'priceVsSma20': 'Above' if current_price > sma_20 else 'Below',
                'priceVsSma50': 'Above' if current_price > sma_50 else 'Below',
                'priceVsSma200': 'Above' if current_price > sma_200 else 'Below',
                'priceVsBb': 'Upper Band' if current_price > bb_upper else 'Lower Band' if current_price < bb_lower else 'Middle'
            },
            'charts': {
                'rsi': [round(x, 2) for x in rsi_chart],
                'macd': {
                    'line': [round(x, 2) for x in macd_line_chart],
                    'signal': [round(x, 2) for x in macd_signal_chart],
                    'histogram': [round(x, 2) for x in macd_hist_chart]
                },
                'bollingerBands': {
                    'upper': [round(x, 2) for x in bb_chart['upper']],
                    'middle': [round(x, 2) for x in bb_chart['middle']],
                    'lower': [round(x, 2) for x in bb_chart['lower']],
                    'price': [round(x, 2) for x in bb_chart['price']]
                },
                'sma50': [round(sma_50 * random.uniform(0.98, 1.02), 2) for _ in range(60)],
                'sma200': [round(sma_200 * random.uniform(0.98, 1.02), 2) for _ in range(60)],
                'ema21': [round(current_price * random.uniform(0.97, 1.03), 2) for _ in range(60)]
            }
        }
    }

def _nan_safe_serialize(obj):
    """Recursively convert any float that is NaN or infinite (including numpy types) to None."""
    if isinstance(obj, dict):
        return {k: _nan_safe_serialize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_nan_safe_serialize(v) for v in obj]
    if isinstance(obj, tuple):
        return [_nan_safe_serialize(v) for v in obj]
    if isinstance(obj, (float, np.floating)):
        if not math.isfinite(float(obj)):
            return None
        return float(obj)
    return obj

def _nan_safe_dumps(obj):
    return json.dumps(_nan_safe_serialize(obj), allow_nan=False)

def main():
    # Read JSON from stdin
    try:
        request = json.loads(sys.stdin.read())
    except:
        # If no stdin, check command line args
        parser = argparse.ArgumentParser()
        parser.add_argument('symbol', nargs='?', default='AAPL')
        parser.add_argument('--action', default='info')
        parser.add_argument('--period', default='1y')
        parser.add_argument('--interval', default='1d')
        args = parser.parse_args()
        request = {'action': args.action, 'symbol': args.symbol, 'period': args.period, 'interval': args.interval}
    
    action = request.get('action', 'info')
    symbol = request.get('symbol', 'AAPL').upper()
    period = request.get('period', '1y')
    interval = request.get('interval', '1d')
    
    if action == 'info':
        result = get_stock_info(symbol)
    elif action == 'info_batch':
        result = get_stock_info_batch(request.get('symbols', []))
    elif action == 'screener_batch':
        result = get_screener_inputs_batch(request.get('symbols', []))
    elif action == 'history':
        result = get_history(symbol, period, interval)
    elif action == 'canslim':
        result = get_canslim_analysis(symbol, request.get('statements'))
    elif action == 'quality':
        result = get_quality_metrics(symbol)
    elif action == 'quality_records':
        result = get_quality_from_records(symbol, request.get('statements', {}), request.get('info', {}))
    elif action == 'fund':
        result = get_fund_research(symbol)
    elif action == 'news':
        result = get_news(symbol)
    elif action == 'indexes':
        result = get_market_indexes()
    elif action == 'technical':
        result = get_technical_indicators(symbol)
    elif action == 'update_universe':
        from universe_updater import update_universe_cache
        result = {'status': 'success', 'data': update_universe_cache()}
    elif action == 'market_direction':
        result = detect_market_direction(request.get('index', '^IXIC'))
    elif action == 'earnings':
        result = get_earnings_calendar(symbol)
    elif action == 'sectors':
        result = get_sector_performance()
    else:
        result = {'status': 'error', 'error': f'Unknown action: {action}'}
    
    if isinstance(result, dict):
        result['meta'] = {'source': 'yfinance', 'retrievedAt': datetime.now(timezone.utc).isoformat(), **result.get('meta', {})}
    print(_nan_safe_dumps(result))

if __name__ == '__main__':
    main()
