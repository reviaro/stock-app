import yfinance as yf
import sqlite3
import pandas as pd
import os
import time
import math
import hashlib
import sys
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from yf_wrapper import _normalize_bars
from database_path import get_database_path

def _log(message):
    print(message, file=sys.stderr, flush=True)

# Top 100 S&P 500 tickers by market cap (approximate/manual list)
# TODO: expand to full S&P 500 via Wikipedia scrape
SP500_TOP100 = [
    'AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'META', 'BRK-B', 'LLY', 'AVGO', 'JPM',
    'XOM', 'UNH', 'V', 'MA', 'PG', 'COST', 'JNJ', 'HD', 'ABBV', 'MRK',
    'WMT', 'NFLX', 'BAC', 'KO', 'PEP', 'CRM', 'ORCL', 'AMD', 'TMO', 'ADBE',
    'CVX', 'LIN', 'MCD', 'ACN', 'ABT', 'CSCO', 'QCOM', 'WFC', 'DHR', 'TXN',
    'PM', 'NEE', 'INTU', 'GE', 'UNP', 'ISRG', 'RTX', 'AMAT', 'PFE', 'HON',
    'AMGN', 'LOW', 'T', 'CAT', 'BLK', 'AXP', 'GS', 'BKNG', 'SYK', 'MDLZ',
    'VRTX', 'LRCX', 'DE', 'PLD', 'SBUX', 'GILD', 'MS', 'CB', 'SCHW', 'ADI',
    'REGN', 'MMC', 'ELV', 'KLAC', 'BMY', 'SO', 'MO', 'CI', 'CME', 'COP',
    'ZTS', 'PGR', 'PYPL', 'DUK', 'SNPS', 'ICE', 'TGT', 'CDNS', 'SHW', 'EOG',
    'APD', 'ANET', 'NOC', 'FDX', 'USB', 'CMG', 'ITW', 'MCK', 'MPC'
]

def calculate_weighted_performance(closes):
    """
    IBD formula: score = (2 * (p_now / p_63d)) + (p_now / p_126d) + (p_now / p_189d) + (p_now / p_252d)
    Requires at least 252 trading days (1 year).
    """
    if len(closes) < 252:
        return None
    
    p_now = closes[-1]
    p_63d = closes[-63]
    p_126d = closes[-126]
    p_189d = closes[-189]
    p_252d = closes[-252]
    
    # Avoid division by zero
    if any(p == 0 for p in [p_63d, p_126d, p_189d, p_252d]):
        return None
        
    score = (2 * (p_now / p_63d)) + (p_now / p_126d) + (p_now / p_189d) + (p_now / p_252d)
    score = float(score)
    return score if math.isfinite(score) else None

def update_universe_cache():
    """Collect a coherent cohort before replacing the prior cache atomically."""
    now = datetime.now(timezone.utc)
    version = 'custom-large-cap-' + hashlib.sha256(','.join(sorted(SP500_TOP100)).encode()).hexdigest()[:12]
    if not SP500_TOP100:
        return {'count':0,'requested':0,'asOf':now.isoformat(),'universe':version}
    def load(ticker):
        try:
            history = _normalize_bars(yf.Ticker(ticker).history(period='2y', interval='1d', auto_adjust=True, timeout=10))
            if history is None or len(history) < 252:
                return None
            event = history.index[-1].to_pydatetime()
            if event.tzinfo is None:
                event = event.replace(tzinfo=timezone.utc)
            if (now-event).total_seconds() > 96*3600 or (event-now).total_seconds() > 60:
                return None
            score = calculate_weighted_performance(history['Close'].tolist())
            return (ticker, score, now.isoformat(), event.date().isoformat(), version) if score is not None else None
        except Exception:
            return None
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = [row for row in pool.map(load, SP500_TOP100) if row]
    if rows:
        cohort_date=Counter(row[3] for row in rows).most_common(1)[0][0]
        rows=[row for row in rows if row[3]==cohort_date]
    if len(rows) < max(min(10,len(SP500_TOP100)), math.ceil(len(SP500_TOP100)*.8)):
        raise RuntimeError('Insufficient coherent universe coverage; previous cache retained')
    with sqlite3.connect(get_database_path()) as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute('DELETE FROM universe_cache')
        conn.executemany('INSERT INTO universe_cache(symbol,weighted_score,updated_at,price_date,universe_version) VALUES(?,?,?,?,?)', rows)
        conn.commit()
    _log(f'[universe_updater] Refreshed {len(rows)}/{len(SP500_TOP100)} custom large-cap symbols')
    return {'count': len(rows), 'requested': len(SP500_TOP100), 'asOf': now.isoformat(), 'universe': version}

if __name__ == "__main__":
    update_universe_cache()
