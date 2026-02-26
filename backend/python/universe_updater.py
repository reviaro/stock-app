import yfinance as yf
import sqlite3
import pandas as pd
import os
import time
from datetime import datetime

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
    return float(score)

def update_universe_cache():
    DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'database', 'stocks.db')
    
    print(f"[universe_updater] Starting cache update for {len(SP500_TOP100)} tickers...", flush=True)
    
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        count = 0
        for ticker in SP500_TOP100:
            try:
                # Use yfinance to get 1y history
                # auto_adjust=True for dividend/split adjusted prices
                stock = yf.Ticker(ticker)
                hist = stock.history(period='1y', interval='1d', auto_adjust=True, timeout=10)
                
                if len(hist) < 252:
                    # Try to get slightly more data if 1y is just short of 252 days due to holidays
                    hist = stock.history(period='2y', interval='1d', auto_adjust=True, timeout=10)
                
                if len(hist) < 252:
                    print(f"[universe_updater] Skipping {ticker}: Insufficient data ({len(hist)} days)", flush=True)
                    continue
                
                closes = hist['Close'].tolist()
                weighted_score = calculate_weighted_performance(closes)
                
                if weighted_score is not None:
                    cursor.execute(
                        "INSERT OR REPLACE INTO universe_cache (symbol, weighted_score, updated_at) VALUES (?, ?, datetime('now'))",
                        (ticker, weighted_score)
                    )
                    count += 1
                
                # Respect rate limits
                time.sleep(0.1)
                
            except Exception as e:
                print(f"[universe_updater] Failed to update {ticker}: {str(e)}", flush=True)
        
        conn.commit()
        conn.close()
        print(f"[universe_updater] Updated {count}/{len(SP500_TOP100)} tickers", flush=True)
        
    except Exception as e:
        print(f"[universe_updater] Database error: {str(e)}", flush=True)

if __name__ == "__main__":
    update_universe_cache()
