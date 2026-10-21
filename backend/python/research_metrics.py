"""Period-aligned research calculations. No network, credentials or database access."""
import math
from datetime import datetime, timezone


def number(value):
    if value is None or isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def periods(frame, *names):
    if frame is None:
        return {}
    for name in names:
        if name in frame.index:
            result = {}
            for date, value in frame.loc[name].items():
                numeric = number(value)
                if numeric is not None:
                    result[date] = numeric
            if result:
                return result
    return {}


def metric(value, unit, dates=(), method='', **extra):
    return {'value': value, 'unit': unit, 'periods': [str(d)[:10] for d in sorted(dates, reverse=True)],
            'observations': len(dates), 'method': method, **extra}


def ratios(numerator, denominator, scale=1):
    return {date: numerator[date] / denominator[date] * scale for date in numerator.keys() & denominator.keys()
            if denominator[date] > 0}


def cagr(values):
    dates = sorted(values)
    if len(dates) < 2 or values[dates[0]] <= 0 or values[dates[-1]] <= 0:
        return None
    years = (dates[-1] - dates[0]).days / 365.25
    return ((values[dates[-1]] / values[dates[0]]) ** (1 / years) - 1) * 100 if years > 0 else None


def annual_growth(values, minimum_years=2.5):
    dates = sorted(values)
    if len(dates) < 3 or (dates[-1] - dates[0]).days / 365.25 < minimum_years:
        return None
    return cagr(values)


def quarterly_growth(values):
    if not values:
        return None, []
    latest = max(values)
    matches = [d for d in values if 320 <= (latest - d).days <= 410]
    if not matches:
        return None, [latest]
    previous = min(matches, key=lambda d: abs((latest - d).days - 365))
    if values[previous] <= 0:
        return None, [latest, previous]
    return (values[latest] / values[previous] - 1) * 100, [latest, previous]


def quality(ticker, symbol):
    info = ticker.info or {}
    instrument = info.get('quoteType', 'UNKNOWN')
    if instrument in ('ETF', 'MUTUALFUND'):
        return {'symbol': symbol.upper(), 'instrumentType': instrument, 'applicable': False,
                'composite': None, 'coveragePct': 0, 'metrics': {},
                'notes': ['Company financial ratios do not apply to funds. Use fund holdings, costs and benchmark research.']}
    fin, bs, cf = ticker.financials, ticker.balance_sheet, ticker.cashflow
    revenue = periods(fin, 'Total Revenue')
    op = periods(fin, 'Operating Income', 'EBIT')
    equity = periods(bs, 'Stockholders Equity', 'Total Stockholder Equity')
    debt = periods(bs, 'Total Debt')
    tax = periods(fin, 'Tax Provision')
    pretax = periods(fin, 'Pretax Income')
    net = periods(fin, 'Net Income')
    fcf = periods(cf, 'Free Cash Flow')
    gross = periods(fin, 'Gross Profit')
    interest = {d: abs(v) for d, v in periods(fin, 'Interest Expense').items()}
    capital = {d: equity[d] + debt[d] for d in equity.keys() & debt.keys()}
    roic, roe = {}, {}
    for date in sorted(capital):
        previous = [d for d in capital if 320 <= (date - d).days <= 410]
        if previous:
            prior = max(previous)
            invested = (capital[date] + capital[prior]) / 2
            rate = tax.get(date, float('nan')) / pretax[date] if pretax.get(date, 0) > 0 else float('nan')
            if invested > 0 and date in op and 0 <= rate <= 1:
                roic[date] = op[date] * (1 - rate) / invested * 100
    for date in net.keys() & equity.keys():
        previous = [d for d in equity if 320 <= (date - d).days <= 410]
        if previous:
            avg_equity = (equity[date] + equity[max(previous)]) / 2
            if avg_equity > 0:
                roe[date] = net[date] / avg_equity * 100
    roic = {d:roic[d] for d in sorted(roic,reverse=True)[:5]}
    roe = {d:roe[d] for d in sorted(roe,reverse=True)[:5]}
    shared_fcf = sorted(fcf.keys() & revenue.keys(), reverse=True)[:5]
    total_revenue = sum(revenue[d] for d in shared_fcf)
    margin = sum(fcf[d] for d in shared_fcf) / total_revenue * 100 if shared_fcf and total_revenue > 0 else None
    de = ratios(debt, equity)
    coverage = ratios(op, interest)
    margins = ratios(gross, revenue)
    gm_dates = sorted(margins, reverse=True)[:5]
    gm_values = [margins[d] for d in gm_dates]
    gm_mean = sum(gm_values) / len(gm_values) if gm_values else 0
    gm_cv = (sum((v - gm_mean)**2 for v in gm_values) / len(gm_values))**0.5 / gm_mean if len(gm_values) >= 2 and gm_mean > 0 else None
    annual_dates = sorted(net, reverse=True)[:10]
    revenue_dates = sorted(revenue, reverse=True)[:5]
    latest = lambda values: values[max(values)] if values else None
    average = lambda values: sum(values.values()) / len(values) if values else None
    metrics = {
        'roic': metric(average(roic), '%', roic, 'Mean annual NOPAT / average opening and closing debt plus equity; reported effective tax rate; cash not deducted'),
        'roe': metric(average(roe), '%', roe, 'Mean annual net income / average opening and closing equity; separate from ROIC'),
        'fcf_margin': metric(margin, '%', shared_fcf, 'Sum free cash flow / sum revenue over matching fiscal periods'),
        'debt_equity': metric(latest(de), 'x', [max(de)] if de else [], 'Reported total debt / positive equity at the same fiscal date'),
        'interest_coverage': metric(latest(coverage), 'x', [max(coverage)] if coverage else [], 'Operating income / absolute interest expense at the same fiscal date'),
        'earnings_consistency': metric(100 * sum(net[d] > 0 for d in annual_dates) / len(annual_dates) if annual_dates else None, '%', annual_dates, 'Percentage of available annual periods with positive net income'),
        'gm_stability': metric(gm_cv, 'cv', gm_dates, 'Coefficient of variation of fiscal-period-aligned gross margins'),
        'revenue_cagr': metric(cagr({d: revenue[d] for d in revenue_dates}), '%', revenue_dates, 'Annualized growth using actual elapsed fiscal dates'),
    }
    sector = str(info.get('sector', ''))
    industry = str(info.get('industry', ''))
    notes = []
    if sector == 'Financial Services' or any(x in industry.lower() for x in ['bank', 'insurance', 'reit']):
        for key in ['roic', 'debt_equity', 'interest_coverage', 'fcf_margin']:
            metrics[key] = metric(None, metrics[key]['unit'], method='Not graded by the industrial-company model for this sector')
        notes.append('Sector-specific valuation is required; industrial leverage and cash-flow thresholds are not applied.')
    rules = {'roic': ([15,10,5],True,20),'fcf_margin':([20,10,5],True,20),
             'debt_equity':([.3,.7,1.5],False,15),'interest_coverage':([10,5,2],True,10),
             'earnings_consistency':([100,80,60],True,15),'gm_stability':([.05,.1,.2],False,10),
             'revenue_cagr':([10,5,0],True,10)}
    total, available = 0, 0
    for key, item in metrics.items():
        item['grade'] = None
        latest_period = max(item['periods']) if item['periods'] else None
        age_days = (datetime.now(timezone.utc).date() - datetime.fromisoformat(latest_period).date()).days if latest_period else None
        item['stale'] = age_days is not None and (age_days > 550 or age_days < 0)
        if key not in rules or item['value'] is None or item['stale']:
            continue
        thresholds, higher, weight = rules[key]
        grade_index = next((i for i,boundary in enumerate(thresholds) if (item['value'] >= boundary if higher else item['value'] <= boundary)), 3)
        item['grade'] = ['A','B','C','D'][grade_index]
        total += [90,75,60,40][grade_index] * weight
        available += weight
    return {'symbol':symbol.upper(),'instrumentType':instrument,'applicable':True,
            'composite':round(total/available,1) if available >= 60 else None,
            'coveragePct':available,'metrics':metrics,'notes':notes,
            'source':'yfinance','retrievedAt':datetime.now(timezone.utc).isoformat(),
            'missingMetrics':[k for k in rules if metrics[k]['value'] is None]}
