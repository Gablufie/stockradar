from datetime import timedelta
from math import ceil


def forecast(history, stock, cost, price, expiry_days):
    n = len(history)
    rate = sum(history[-14:]) / min(n, 14) if n >= 7 else None
    stock = max(0, stock)
    cover = ceil(stock / rate) if rate else None
    # Expiry date is sellable under the existing backend policy.
    sellable_days = max(0, expiry_days + 1) if expiry_days is not None else None
    remaining = (stock if sellable_days == 0 else max(0, stock - rate * sellable_days) if rate is not None and sellable_days is not None else None)
    horizons = {}
    for h in (7, 14, 30):
        demand = rate * h if rate is not None else None
        sales = min(stock, rate * min(h, sellable_days if sellable_days is not None else h)) if rate is not None else None
        horizons[str(h)] = {'demand': round(demand, 2) if demand is not None else None, 'revenue': round(sales * price, 2) if sales is not None else None}
    return {'validation': backtest(history), 'history_days': n, 'daily_rate': round(rate, 3) if rate is not None else None, 'evidence': 'Insufficient history' if n < 7 else 'Limited history' if n < 14 or sum(history[-14:]) < 5 else 'Established history', 'days_to_stockout': cover if sellable_days is None or (cover is not None and cover <= sellable_days) else None, 'expiry_units': round(remaining, 2) if remaining is not None else None, 'expiry_cost': round(remaining * cost, 2) if remaining is not None else None, 'horizons': horizons}


def backtest(history):
    """Fixed-origin seven-day holdout, no future observations in training."""
    if len(history) < 14:
        return None
    train, actual = history[:-7], history[-7:]
    rate = sum(train[-14:]) / min(14, len(train))
    predicted = [rate] * 7
    error = sum(abs(a-p) for a,p in zip(actual,predicted))
    return {'actual': actual, 'predicted': predicted, 'mae': round(error/7, 3), 'wape': round(100*error/sum(actual), 2) if sum(actual) else None}
