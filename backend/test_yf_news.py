import yfinance as yf
import json
try:
    news = yf.Ticker("AAPL").news
    print(json.dumps(news[:2], indent=2))
except Exception as e:
    print(f"Error: {e}")
