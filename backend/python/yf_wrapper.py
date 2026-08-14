#!/usr/bin/env python3
"""
yfinance wrapper for stock dashboard
Takes JSON input from stdin, outputs JSON to stdout
"""
import yfinance as yf
import json
import sys
import argparse
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

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

def get_quality_metrics(symbol):
    """Compute Buffett-style quality metrics from yfinance financials."""
    try:
        t = yf.Ticker(symbol)

        # Financials: annual (last ~4-5 yrs) and quarterly
        fin = t.financials  # income statement (cols=years, rows=metrics)
        bs = t.balance_sheet
        cf = t.cashflow
        info = t.info or {}

        def _safe_row(df, row_name):
            try:
                return df.loc[row_name].dropna().tolist() if row_name in df.index else []
            except Exception:
                return []

        # --- 1. ROIC 5yr avg = NOPAT / Invested Capital; approximated as ROIC from info if available
        roic_pct = info.get('returnOnEquity')  # fallback; ROE is not ROIC but yfinance lacks ROIC directly
        # Prefer computed: (Operating Income × (1 - tax_rate)) / (Total Equity + Total Debt)
        op_income = _safe_row(fin, 'Operating Income') or _safe_row(fin, 'Ebit')
        equity = _safe_row(bs, 'Total Stockholder Equity') or _safe_row(bs, 'Stockholders Equity')
        total_debt = _safe_row(bs, 'Total Debt') or _safe_row(bs, 'Long Term Debt')
        if op_income and equity:
            tax_rate = 0.21
            try:
                avg_oi = sum(op_income[:5]) / min(5, len(op_income))
                avg_eq = sum(equity[:5]) / min(5, len(equity))
                avg_debt = sum(total_debt[:5]) / min(5, len(total_debt)) if total_debt else 0
                invested = avg_eq + avg_debt
                if invested > 0:
                    roic_pct = (avg_oi * (1 - tax_rate)) / invested * 100
            except Exception:
                pass
        else:
            roic_pct = (roic_pct * 100) if roic_pct is not None else None

        # --- 2. FCF margin = free_cash_flow / revenue (5yr avg)
        revenue = _safe_row(fin, 'Total Revenue')
        fcf = _safe_row(cf, 'Free Cash Flow')
        fcf_margin_pct = None
        if revenue and fcf and len(revenue) >= 1 and len(fcf) >= 1:
            n = min(5, len(revenue), len(fcf))
            total_rev = sum(revenue[:n])
            total_fcf = sum(fcf[:n])
            if total_rev > 0:
                fcf_margin_pct = (total_fcf / total_rev) * 100

        # --- 3. Debt/Equity
        debt_equity = None
        if total_debt and equity and equity[0] > 0:
            debt_equity = total_debt[0] / equity[0]
        elif info.get('debtToEquity') is not None:
            debt_equity = info['debtToEquity'] / 100.0  # yfinance returns it as percentage

        # --- 4. Interest coverage = EBIT / Interest Expense
        interest_expense = _safe_row(fin, 'Interest Expense')
        interest_coverage = None
        if op_income and interest_expense and interest_expense[0]:
            ie = abs(interest_expense[0])
            if ie > 0:
                interest_coverage = op_income[0] / ie

        # --- 5. Earnings consistency: positive-EPS years of last 10. yfinance often limits to 4-5 years.
        net_income = _safe_row(fin, 'Net Income')
        pos_years = sum(1 for x in net_income if x and x > 0)
        total_years = len(net_income) or 1
        # Scale to out-of-10
        earnings_consistency_ratio = (pos_years / total_years) * 10

        # --- 6. Gross margin stability (std/mean of last 5 years)
        gross_profit = _safe_row(fin, 'Gross Profit')
        gm_stability = None
        if gross_profit and revenue:
            n = min(5, len(gross_profit), len(revenue))
            margins = [gp/r for gp, r in zip(gross_profit[:n], revenue[:n]) if r > 0]
            if len(margins) >= 2:
                mean = sum(margins) / len(margins)
                variance = sum((m - mean) ** 2 for m in margins) / len(margins)
                std = variance ** 0.5
                if mean > 0:
                    gm_stability = std / mean  # coefficient of variation

        # --- 7. Revenue CAGR 5yr
        rev_cagr_pct = None
        if revenue and len(revenue) >= 2:
            # yfinance income statement: index 0 is most recent; compute from oldest to newest
            oldest = revenue[-1]
            newest = revenue[0]
            years = len(revenue) - 1
            if oldest > 0 and years > 0:
                rev_cagr_pct = ((newest / oldest) ** (1 / years) - 1) * 100

        grades = {
            'roic': _grade_numeric(roic_pct, [15, 10, 5], higher_is_better=True),
            'fcf_margin': _grade_numeric(fcf_margin_pct, [20, 10, 5], higher_is_better=True),
            'debt_equity': _grade_numeric(debt_equity, [0.3, 0.7, 1.5], higher_is_better=False),
            'interest_coverage': _grade_numeric(interest_coverage, [10, 5, 2], higher_is_better=True),
            'earnings_consistency': _grade_numeric(earnings_consistency_ratio, [10, 8, 6], higher_is_better=True),
            'gm_stability': _grade_numeric(gm_stability, [0.05, 0.10, 0.20], higher_is_better=False),
            'revenue_cagr': _grade_numeric(rev_cagr_pct, [10, 5, 0], higher_is_better=True),
        }

        weights = {
            'roic': 20, 'fcf_margin': 20, 'debt_equity': 15, 'interest_coverage': 10,
            'earnings_consistency': 15, 'gm_stability': 10, 'revenue_cagr': 10,
        }

        composite = _composite_score(grades, weights)

        return {
            'status': 'success',
            'data': {
                'symbol': symbol.upper(),
                'composite': composite,
                'metrics': {
                    'roic': {'value': roic_pct, 'grade': grades['roic'], 'unit': '%'},
                    'fcf_margin': {'value': fcf_margin_pct, 'grade': grades['fcf_margin'], 'unit': '%'},
                    'debt_equity': {'value': debt_equity, 'grade': grades['debt_equity'], 'unit': 'x'},
                    'interest_coverage': {'value': interest_coverage, 'grade': grades['interest_coverage'], 'unit': 'x'},
                    'earnings_consistency': {'value': earnings_consistency_ratio, 'grade': grades['earnings_consistency'], 'unit': '/10'},
                    'gm_stability': {'value': gm_stability, 'grade': grades['gm_stability'], 'unit': 'cv'},
                    'revenue_cagr': {'value': rev_cagr_pct, 'grade': grades['revenue_cagr'], 'unit': '%'},
                },
            }
        }
    except Exception as e:
        return {'status': 'error', 'error': str(e), 'symbol': symbol.upper()}

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

def get_stock_info(symbol):
    """Get basic stock info and quote data"""
    # Try yfinance first
    try:
        stock = yf.Ticker(symbol)
        
        # Get current price from history
        hist = stock.history(period="5d", interval="1d", timeout=10)
        
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
            prev_close = float(hist.iloc[0]['Open']) if len(hist) > 1 else price
            change = price - prev_close
            changePercent = (change / prev_close * 100) if prev_close else 0
            volume = int(latest['Volume']) if 'Volume' in latest.index else 0
            open_price = float(latest['Open'])
            day_high = float(latest['High'])
            day_low = float(latest['Low'])
        
        # Get additional info
        info = stock.info
        
        return {
            'status': 'success',
            'data': {
                'symbol': symbol.upper(),
                'name': info.get('shortName', info.get('longName', symbol)),
                'exchange': info.get('exchange', 'Unknown'),
                'sector': info.get('sector', 'Unknown'),
                'industry': info.get('industry', 'Unknown'),
                'currency': info.get('currency', 'USD'),
                'isDemo': False,
                'timestamp': _utc_iso_from_epoch(info.get('regularMarketTime')),
                'marketState': info.get('marketState', 'UNKNOWN'),
                'price': price,
                'change': change,
                'changePercent': changePercent,
                'volume': volume,
                'avgVolume': info.get('averageVolume', 0),
                'bid': 0,
                'ask': 0,
                'open': open_price,
                'previousClose': prev_close,
                'dayHigh': day_high,
                'dayLow': day_low,
                'marketCap': info.get('marketCap', 0),
                'peRatio': info.get('trailingPE', 0),
                'eps': info.get('trailingEps', 0),
                'beta': info.get('beta', 0),
                'week52High': info.get('fiftyTwoWeekHigh', 0),
                'week52Low': info.get('fiftyTwoWeekLow', 0),
                'dividendYield': info.get('dividendYield', 0),
                'dividendRate': info.get('dividendRate', 0),
                'exDividendDate': info.get('exDividendDate'),
                'sharesOutstanding': info.get('sharesOutstanding', 0),
                'float': info.get('floatShares', 0),
                'bookValue': info.get('bookValue', 0),
                'priceToBook': info.get('priceToBook', 0),
                'profitMargin': info.get('profitMargin', 0),
                'returnOnEquity': info.get('returnOnEquity', 0),
                'revenue': info.get('totalRevenue', 0),
                'revenuePerShare': info.get('revenuePerShare', 0),
                'grossProfit': info.get('grossProfit', 0),
                'operatingCashflow': info.get('operatingCashflow', 0),
                'freeCashflow': info.get('freeCashflow', 0),
                'forwardPE': info.get('forwardPE', 0),
                'pegRatio': info.get('pegRatio', 0),
                'enterpriseValue': info.get('enterpriseValue', 0),
                'enterpriseToRevenue': info.get('enterpriseToRevenue', 0),
                'enterpriseToEbitda': info.get('enterpriseToEbitda', 0),
                'sma50': info.get('fiftyDayAverage', 0),
                'sma200': info.get('twoHundredDayAverage', 0),
                'currentRatio': info.get('currentRatio', 0),
                'quickRatio': info.get('quickRatio', 0),
                'debtToEquity': info.get('debtToEquity', 0),
            }
        }
    except Exception as e:
        demo = get_demo_data(symbol)
        return demo if demo else {'status': 'error', 'error': str(e)}

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

def get_history(symbol, period='1y', interval='1d'):
    """Get historical price data"""
    # Try yfinance first, fallback to demo if needed
    try:
        stock = yf.Ticker(symbol)
        hist = stock.history(period=period, interval=interval, timeout=10)
        
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
                'data': data
            }
        }
    except Exception as e:
        # Fallback to demo
        demo = get_demo_history(symbol, period)
        if demo:
            return demo
        return {'status': 'error', 'error': str(e)}

def get_rs_rating_from_cache(symbol):
    """Returns (rs_rating: int 1-99, cache_stale: bool)."""
    import sqlite3
    import os
    DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'database', 'stocks.db')
    try:
        if not os.path.exists(DB_PATH):
            return 50, True
            
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute('SELECT symbol, weighted_score FROM universe_cache').fetchall()
        conn.close()

        if len(rows) < 10:  # cache essentially empty
            return 50, True

        df = pd.DataFrame(rows, columns=['symbol', 'weighted_score'])
        # Use rank(pct=True) to get percentile
        df['rank_pct'] = df['weighted_score'].rank(pct=True)

        match = df[df['symbol'] == symbol.upper()]
        if match.empty:
            return 50, True  # symbol not in universe cache

        target_pct = match['rank_pct'].values[0]
        # IBD RS Rating is 1-99
        return max(1, min(99, int(target_pct * 99))), False
    except Exception:
        return 50, True

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

        if hist is None or len(hist) < 60:
            return {'status': 'Uptrend Under Pressure', 'ftd_detected': False}

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
            return {'status': 'Uptrend Under Pressure', 'ftd_detected': False}

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
        # On any error, return neutral status
        return {'status': 'Uptrend Under Pressure', 'ftd_detected': False}

def get_canslim_analysis(symbol):
    """Get CAN SLIM analysis for a stock"""
    # Try yfinance first
    try:
        stock = yf.Ticker(symbol)
        info = stock.info
        
        # Get recent data
        hist = stock.history(period="2y", interval="1mo", timeout=10)
        
        # Calculate CAN SLIM criteria
        price = info.get('currentPrice', 0)
        week52_high = info.get('fiftyTwoWeekHigh', 0)
        week52_low = info.get('fiftyTwoWeekLow', 0)
        
        # C - Current Quarterly Earnings (simplified)
        eps = info.get('trailingEps', 0)
        c_score = 50
        if eps and eps > 0:
            fwd_pe = info.get('forwardPE', 0)
            if fwd_pe and fwd_pe > 0:
                c_score = min(100, max(0, int(50 + (30 - fwd_pe) * 2)))
        
        # A - Annual Earnings Growth
        a_score = 50
        if info.get('earningsGrowth') and info.get('earningsGrowth') > 0:
            growth = info.get('earningsGrowth') * 100
            if growth >= 25: a_score = 100
            elif growth >= 20: a_score = 80
            elif growth >= 15: a_score = 60
            elif growth >= 10: a_score = 40
            elif growth >= 5: a_score = 20
        
        # N - New Factors (price at new highs)
        n_score = 50
        if week52_high > 0:
            price_position = price / week52_high
            n_score = int(price_position * 100)
        
        # S - Supply and Demand (volume)
        avg_volume = info.get('averageVolume', 1)
        volume = info.get('regularMarketVolume', 0)
        s_score = 50
        if avg_volume > 0:
            volume_ratio = volume / avg_volume
            if volume_ratio >= 1.5: s_score = 100
            elif volume_ratio >= 1.2: s_score = 75
            elif volume_ratio >= 1.0: s_score = 50
            elif volume_ratio >= 0.8: s_score = 25
        
        # L - Leader or Laggard (IBD Weighted RS Rating)
        l_score, cache_stale = get_rs_rating_from_cache(symbol)
        
        # I - Institutional Sponsorship
        i_score = 50
        holders = info.get('heldByInstitutions', 0)
        if holders and holders > 1000: i_score = 90
        elif holders and holders > 500: i_score = 70
        elif holders and holders > 100: i_score = 50
        
        # M - Market Direction (Follow-Through Day detection)
        m_score = 50
        try:
            market = detect_market_direction()
            if market['status'] == 'Confirmed Uptrend':
                m_score = 90 if market.get('ftd_detected') else 80
            elif market['status'] == 'Uptrend Under Pressure':
                m_score = 50
            elif market['status'] == 'Market in Correction':
                m_score = 15
        except Exception:
            m_score = 50
        
        # Calculate overall score
        weights = {'C': 0.20, 'A': 0.15, 'N': 0.15, 'S': 0.15, 'L': 0.15, 'I': 0.10, 'M': 0.10}
        overall = int(c_score * weights['C'] + a_score * weights['A'] + n_score * weights['N'] + 
                     s_score * weights['S'] + l_score * weights['L'] + i_score * weights['I'] + 
                     m_score * weights['M'])
        
        if overall >= 80: rating = 'Excellent'
        elif overall >= 60: rating = 'Good'
        elif overall >= 40: rating = 'Average'
        else: rating = 'Poor'
        
        return {
            'status': 'success',
            'data': {
                'symbol': symbol.upper(),
                'cache_stale': cache_stale,
                'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
                'overall': {
                    'score': overall,
                    'rating': rating,
                    'passCount': sum([1 for s in [c_score, a_score, n_score, s_score, l_score, i_score, m_score] if s >= 50]),
                    'failCount': sum([1 for s in [c_score, a_score, n_score, s_score, l_score, i_score, m_score] if s < 50])
                },
                'criteria': {
                    'C': {'name': 'Current Quarterly Earnings', 'score': c_score, 'status': 'Pass' if c_score >= 50 else 'Fail', 'value': eps},
                    'A': {'name': 'Annual Earnings Growth', 'score': a_score, 'status': 'Pass' if a_score >= 50 else 'Fail', 'value': info.get('earningsGrowth', 0) * 100},
                    'N': {'name': 'New Factors', 'score': n_score, 'status': 'Pass' if n_score >= 50 else 'Fail', 'pricePosition': price / week52_high if week52_high else 0},
                    'S': {'name': 'Supply and Demand', 'score': s_score, 'status': 'Pass' if s_score >= 50 else 'Fail', 'volumeRatio': volume / avg_volume if avg_volume else 0},
                    'L': {'name': 'Leader or Laggard', 'score': l_score, 'status': 'Pass' if l_score >= 50 else 'Fail'},
                    'I': {'name': 'Institutional Sponsorship', 'score': i_score, 'status': 'Pass' if i_score >= 50 else 'Fail'},
                    'M': {'name': 'Market Direction', 'score': m_score, 'status': 'Pass' if m_score >= 50 else 'Fail'}
                }
            }
        }
    except Exception as e:
        demo = get_demo_canslim(symbol)
        return demo if demo else {'status': 'error', 'error': str(e)}

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
                info = ticker.info
                
                price = 0
                change = 0
                changePercent = 0
                volume = 0
                
                if len(hist) > 0:
                    latest = hist.iloc[-1]
                    price = float(latest['Close'])
                    prev_close = float(hist.iloc[0]['Open']) if len(hist) > 1 else price
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
        demo = get_demo_indexes()
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
        
        if hist is None or len(hist) < 30:
            return get_demo_technical(symbol)
        
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
                'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
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
        return get_demo_technical(symbol)

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
    elif action == 'history':
        result = get_history(symbol, period, interval)
    elif action == 'canslim':
        result = get_canslim_analysis(symbol)
    elif action == 'quality':
        result = get_quality_metrics(symbol)
    elif action == 'news':
        result = get_news(symbol)
    elif action == 'indexes':
        result = get_market_indexes()
    elif action == 'technical':
        result = get_technical_indicators(symbol)
    elif action == 'update_universe':
        from universe_updater import update_universe_cache
        update_universe_cache()
        result = {'status': 'success', 'message': 'Universe cache updated'}
    elif action == 'market_direction':
        result = detect_market_direction(request.get('index', '^IXIC'))
    elif action == 'earnings':
        result = get_earnings_calendar(symbol)
    elif action == 'sectors':
        result = get_sector_performance()
    else:
        result = {'status': 'error', 'error': f'Unknown action: {action}'}
    
    print(json.dumps(result))

if __name__ == '__main__':
    main()
