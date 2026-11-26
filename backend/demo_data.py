from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from random import Random


def generate_demo(now=None):
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(ZoneInfo('Africa/Dar_es_Salaam'))
    today = local.date()
    rng = Random(42)
    scenarios = [
        ('water', 'Kilimanjaro Water', 160, 300, 500, None, 8, 12),
        ('milk', 'Kilimanjaro Milk', 60, 800, 1200, 4, 10, 2),
        ('cable', 'Legacy Serial POS Cable', 35, 5000, 8000, None, 2, 0),
        ('scanner', 'Wireless Barcode Scanner', 12, 45000, 65000, None, 1, 5),
        ('rice', 'Rice (1 kg)', 100, 1800, 2500, None, 5, 5),
    ]
    for key, name, stock, cost, price, expiry, first, last in scenarios:
        events = []
        for i in range(30):
            day = today - timedelta(days=30-i)
            qty = max(0, round(first+(last-first)*i/29+rng.choice([-1,0,0,1])))
            if qty:
                stamp = datetime.combine(day, datetime.min.time(), local.tzinfo)+timedelta(hours=12)
                events.append(dict(timestamp=stamp.isoformat(), units_sold=qty, unit_selling_price=price, unit_cost_at_sale=cost))
        yield key, dict(name=name, stock_qty=stock, unit_cost=cost, selling_price=price, expiry_date=(today+timedelta(days=expiry)).isoformat() if expiry is not None else None, created_at=(local.replace(hour=0,minute=0,second=0,microsecond=0)-timedelta(days=31)).isoformat(), sales_events=events)


if __name__ == '__main__':
    from main import db
    batch = db.batch()
    for key, item in generate_demo():
        batch.set(db.collection('demo_items').document(key), item)
    batch.commit()
    print('Five simulated products saved to demo_items. Live inventory untouched.')
