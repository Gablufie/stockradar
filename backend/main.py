from forecast import forecast
import os
from decimal import Decimal, ROUND_CEILING
from math import isfinite
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import firebase_admin
from firebase_admin import credentials, firestore

app = FastAPI(title="StockRadar API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

cred_path = os.path.join(os.path.dirname(__file__), "serviceAccountKey.json")
if not firebase_admin._apps:
    if os.path.exists(cred_path):
        cred = credentials.Certificate(cred_path)
        firebase_admin.initialize_app(cred)
    else:
        firebase_admin.initialize_app()

db = firestore.client()


class SaleEvent(BaseModel):
    units_sold: int
    timestamp: str
    unit_selling_price: float | None = None
    unit_cost_at_sale: float | None = None
    batch_id: str | None = None
    recovery_id: str | None = None


class ItemInput(BaseModel):
    sku: str = ""
    name: str
    stock_qty: int
    unit_cost: float
    selling_price: float = 0.0
    expiry_date: str | None = None
    prior_daily_sales: float = 0.0
    recent_daily_sales: float = 0.0
    created_at: str | None = None
    last_sale_at: str | None = None
    units_sold_tracked: float = 0.0
    sales_events: list[SaleEvent] = []
    recovery_campaigns: list[dict] = []


class ItemEditInput(BaseModel):
    name: str | None = None
    unit_cost: float | None = None
    selling_price: float | None = None
    expiry_date: str | None = None


class SaleRecordInput(BaseModel):
    units_sold: int = 1


class CheckoutLineItem(BaseModel):
    item_id: str
    units_sold: int
    expected_price: float | None = None


class CheckoutCartInput(BaseModel):
    items: list[CheckoutLineItem]


class RestockInput(BaseModel):
    units_added: int


class ActionLogInput(BaseModel):
    item_id: str
    sku: str = ""
    item_name: str
    action_type: str
    notes: str = ""
    estimated_cash_recovered: float = 0.0


def parse_iso_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def parse_expiry_days(expiry_str: str | None, today_utc: date) -> int | None:
    if not expiry_str or not expiry_str.strip():
        return None
    try:
        exp_date = date.fromisoformat(expiry_str.strip()[:10])
        return (exp_date - today_utc).days
    except ValueError:
        return None


def compute_rolling_paces(events: list[SaleEvent], now: datetime):
    recent_cutoff = now - timedelta(days=7)
    prior_cutoff = now - timedelta(days=14)

    recent_units = 0
    prior_units = 0

    for ev in events:
        dt = parse_iso_dt(ev.timestamp)
        if not dt or dt > now:
            continue
        if dt >= recent_cutoff:
            recent_units += max(0, int(ev.units_sold))
        elif dt >= prior_cutoff:
            prior_units += max(0, int(ev.units_sold))

    recent_pace = round(recent_units / 7.0, 2)
    prior_pace = round(prior_units / 7.0, 2)
    return recent_pace, prior_pace


def sellable_until(expiry):
    if not expiry:
        return None
    try:
        day = date.fromisoformat(expiry.strip()[:10]) + timedelta(days=1)
        return datetime.combine(day, datetime.min.time(), tzinfo=ZoneInfo("Africa/Dar_es_Salaam"))
    except ValueError:
        return None


def campaign_deadline(c, expiry):
    end = parse_iso_dt(c["ends_at"])
    limit = sellable_until(expiry)
    return min(end, limit) if limit else end


def active_recovery(raw, now):
    for c in reversed(raw.get("recovery_campaigns", [])):
        if not c.get("ended_at") and campaign_deadline(c, raw.get("expiry_date")) > now:
            return c
    return None


def recovery_price(raw, now):
    c = active_recovery(raw, now)
    base = raw.get("selling_price") or raw.get("unit_cost", 0)
    return c["price"] if c else base


def campaign_report(c, events, now, item):
    sales = [e for e in events if e.recovery_id == c["id"]]
    end = campaign_deadline(c, item.expiry_date) if not c.get("ended_at") and parse_iso_dt(c["ends_at"]) > now else parse_iso_dt(c["ends_at"])
    active = not c.get("ended_at") and end > now
    units = sum(e.units_sold for e in sales)
    started = parse_iso_dt(c["started_at"])
    elapsed = max(0, (now-started).total_seconds()/86400)
    remaining = max(0, (end-now).total_seconds()/86400)
    pace = units/elapsed if elapsed >= 1 else None
    target = item.stock_qty/remaining if active and remaining > 0 else None
    status = "Ended"
    advice = "Campaign ended; review recorded recovery."
    if active:
        if item.stock_qty == 0:
            status, advice = "Cleared", "Stock cleared; end the campaign and review replenishment."
        elif pace is None:
            status, advice = "Collecting data", "Review after 24 hours; improve shelf visibility now."
        elif pace >= target:
            status, advice = "On track", "Maintain the current strategy and monitor sales."
        else:
            status, advice = "Behind target", "Improve visibility or test bundles; review pricing before starting another campaign."
    return {**c, "effective_ends_at": end.isoformat(), "active": active,
            "performance": status, "advice": advice,
            "campaign_daily_sales": round(pace, 2) if pace is not None and active else None,
            "required_daily_sales": round(target, 2) if target is not None else None,
            "remaining_capital": round(item.stock_qty*item.unit_cost, 2) if active else None,
            "units": sum(e.units_sold for e in sales),
            "revenue": round(sum(e.units_sold * e.unit_selling_price for e in sales), 2),
            "capital_recovered": round(sum(e.units_sold * e.unit_cost_at_sale for e in sales), 2),
            "gross_profit": round(sum(e.units_sold * (e.unit_selling_price-e.unit_cost_at_sale) for e in sales), 2)}


class RecoveryInput(BaseModel):
    discount: int
    days: int = 7


@firestore.transactional
def change_recovery(tx, item_id, payload):
    ref = db.collection("items").document(item_id)
    doc = ref.get(transaction=tx)
    if not doc.exists:
        raise HTTPException(404, "Item not found")
    raw = doc.to_dict()
    now = datetime.now(timezone.utc)
    campaigns = raw.get("recovery_campaigns", [])
    active = active_recovery(raw, now)
    if payload is None:
        if not active:
            raise HTTPException(409, "No active campaign")
        active["ended_at"] = now.isoformat()
    else:
        if active:
            raise HTTPException(409, "End the active campaign first")
        expiry = parse_expiry_days(raw.get("expiry_date"), now.astimezone(ZoneInfo("Africa/Dar_es_Salaam")).date())
        if raw.get("stock_qty", 0) <= 0 or (expiry is not None and expiry < 0):
            raise HTTPException(400, "No sellable stock")
        base = raw.get("selling_price") or raw.get("unit_cost", 0)
        cost = raw.get("unit_cost", 0)
        if not all(isfinite(x) for x in (base, cost)) or cost < 0 or not 1 <= payload.discount <= 99 or not 1 <= payload.days <= 30:
            raise HTTPException(400, "Invalid recovery parameters")
        price = float((Decimal(str(base)) * (100-payload.discount)/100).quantize(Decimal("0.01"), rounding=ROUND_CEILING))
        if not 0 < price < base or price < cost:
            raise HTTPException(400, "Discount would violate the cost floor")
        deadline = now + timedelta(days=payload.days)
        limit = sellable_until(raw.get("expiry_date"))
        if limit:
            deadline = min(deadline, limit)
        campaigns.append({"id": str(uuid.uuid4()), "original_price": base, "price": price, "discount": payload.discount, "started_at": now.isoformat(), "ends_at": deadline.isoformat(), "ended_at": None})
    tx.update(ref, {"recovery_campaigns": campaigns})
    return {"item": analyze_item(ItemInput(**{**raw, "recovery_campaigns": campaigns}), item_id)}


@app.post("/api/items/{item_id}/recovery")
def start_recovery(item_id: str, payload: RecoveryInput):
    return change_recovery(db.transaction(), item_id, payload)


@app.post("/api/items/{item_id}/recovery/end")
def end_recovery(item_id: str):
    return change_recovery(db.transaction(), item_id, None)


def analyze_item(item: ItemInput, doc_id: str | None = None):
    now = datetime.now(timezone.utc)
    today_utc = now.astimezone(ZoneInfo("Africa/Dar_es_Salaam")).date()

    effective_selling_price = (
        item.selling_price if item.selling_price and item.selling_price > 0 else item.unit_cost
    )
    base_price = effective_selling_price
    effective_selling_price = recovery_price(item.model_dump(), now)
    unit_profit = round(effective_selling_price - item.unit_cost, 2)

    if effective_selling_price > item.unit_cost:
        max_safe_discount_pct = round(
            ((effective_selling_price - item.unit_cost) / effective_selling_price) * 100, 1
        )
    else:
        max_safe_discount_pct = 0.0

    if item.sales_events:
        recent_sales, prior_sales = compute_rolling_paces(item.sales_events, now)
    else:
        recent_sales = item.recent_daily_sales
        prior_sales = item.prior_daily_sales

    if prior_sales > 0:
        velocity_ratio = recent_sales / prior_sales
    else:
        velocity_ratio = 1.0 if recent_sales > 0 else 0.0

    if recent_sales > 0:
        days_of_cover = round(item.stock_qty / recent_sales, 1)
    else:
        days_of_cover = None

    tied_up_value = round(item.stock_qty * item.unit_cost, 2)
    potential_retail_value = round(item.stock_qty * effective_selling_price, 2)

    days_to_expiry = parse_expiry_days(item.expiry_date, today_utc)
    is_expired = days_to_expiry is not None and days_to_expiry < 0
    expiring_soon = days_to_expiry is not None and 0 <= days_to_expiry <= 14

    if is_expired or days_of_cover is None or (velocity_ratio <= 0.35 and (days_of_cover or 0) > 45):
        status = "Dead-Stock Risk"
        if is_expired:
            action = "Expired stock — pull from shelf immediately and pause reorders"
        elif max_safe_discount_pct > 0:
            action = f"Run promo up to {max_safe_discount_pct}% off (break-even floor {item.unit_cost}) & pause reorders"
        else:
            action = "Run bundle/clearance promo or pause reorders immediately"
    elif expiring_soon or velocity_ratio < 0.75 or (days_of_cover is not None and days_of_cover > 30):
        status = "Slowing Down"
        if expiring_soon:
            action = f"Expires in {days_to_expiry}d — push to front of shelf & discount up to {max_safe_discount_pct}%"
        else:
            action = f"Pause next reorder & test bundle (safe discount up to {max_safe_discount_pct}%)"
    else:
        status = "Healthy"
        if days_of_cover is not None and days_of_cover < 5:
            action = "Low stock — reorder soon before shelf runs empty"
        else:
            action = "Maintain normal replenishment cadence"

    # Explainable heuristic, not a statistical probability.
    risk_reasons = []
    risk_score = 0
    if item.stock_qty > 0:
        if is_expired:
            risk_score = 100
            risk_reasons.append("Expired inventory")
        else:
            if recent_sales <= 0:
                risk_score += 60
                risk_reasons.append("No recent sales (+60)")
            elif prior_sales > 0 and velocity_ratio < 0.75:
                risk_score += 30
                risk_reasons.append("Declining sales velocity (+30)")
            if days_of_cover is not None and days_of_cover > 30:
                risk_score += 30
                risk_reasons.append("More than 30 days of stock (+30)")
            if expiring_soon:
                risk_score += 40
                risk_reasons.append("Expiry within 14 days (+40)")
    risk_score = min(100, risk_score)
    if item.stock_qty == 0 and not is_expired:
        status = "Healthy"
        action = "Out of stock — review demand before replenishing"
    elif not is_expired and not expiring_soon and recent_sales <= 0 and prior_sales <= 0 and (now - (parse_iso_dt(item.created_at) or now)).total_seconds() < 7 * 86400:
        status = "Healthy"
        action = "New item — collect seven days of sales history before assessing demand"
        risk_score = 0
        risk_reasons = ["Insufficient sales history; monitoring"]

    reorder_soon = status == "Healthy" and days_of_cover is not None and days_of_cover < 5

    start_dt = parse_iso_dt(item.created_at) or now
    elapsed_days = max(1.0, round((now - start_dt).total_seconds() / 86400.0, 2))
    tracked_units = (
        sum(int(e.units_sold) for e in item.sales_events)
        if item.sales_events
        else item.units_sold_tracked
    )

    today_start = now.astimezone(ZoneInfo("Africa/Dar_es_Salaam")).replace(hour=0, minute=0, second=0, microsecond=0)
    units_sold_today = 0
    cash_collected_today = 0.0
    profit_today = 0.0

    for ev in item.sales_events:
        ev_dt = parse_iso_dt(ev.timestamp)
        if ev_dt and today_start <= ev_dt <= now:
            qty = int(ev.units_sold)
            sp = ev.unit_selling_price if ev.unit_selling_price is not None else effective_selling_price
            uc = ev.unit_cost_at_sale if ev.unit_cost_at_sale is not None else item.unit_cost
            units_sold_today += qty
            cash_collected_today += qty * sp
            profit_today += qty * (sp - uc)

    current_campaign = active_recovery(item.model_dump(), now)
    if current_campaign and not is_expired:
        action = campaign_report(current_campaign, item.sales_events, now, item)["advice"]
    return {
        "id": doc_id,
        "sku": item.sku,
        "name": item.name,
        "stock_qty": item.stock_qty,
        "unit_cost": item.unit_cost,
        "selling_price": effective_selling_price,
        "base_price": base_price,
        "recovery_campaigns": [campaign_report(c, item.sales_events, now, item) for c in reversed(item.recovery_campaigns)],
        "unit_profit": unit_profit,
        "max_safe_discount_pct": max_safe_discount_pct,
        "expiry_date": item.expiry_date or "",
        "days_to_expiry": days_to_expiry,
        "expiring_soon": expiring_soon,
        "is_expired": is_expired,
        "prior_daily_sales": prior_sales,
        "recent_daily_sales": recent_sales,
        "tied_up_value": tied_up_value,
        "potential_retail_value": potential_retail_value,
        "velocity_ratio": round(velocity_ratio, 2),
        "days_of_cover": days_of_cover if days_of_cover is not None else "Stalled",
        "status": status,
        "risk_score": risk_score,
        "risk_reasons": risk_reasons,
        "reorder_soon": reorder_soon,
        "recommended_action": action,
        "created_at": item.created_at,
        "last_sale_at": item.last_sale_at,
        "units_sold_tracked": tracked_units,
        "units_sold_today": units_sold_today,
        "cash_collected_today": round(cash_collected_today, 2),
        "profit_today": round(profit_today, 2),
        "tracked_days": elapsed_days,
        "can_undo_sale": len(item.sales_events) > 0,
    }


def prepare_sale(doc, item_id, units_sold, now, batch_id=None):
    if not doc.exists:
        raise HTTPException(status_code=404, detail=f"Item {item_id} not found")

    raw = doc.to_dict()
    expiry = parse_expiry_days(raw.get("expiry_date"), now.astimezone(ZoneInfo("Africa/Dar_es_Salaam")).date())
    if expiry is not None and expiry < 0:
        raise HTTPException(status_code=400, detail="Expired stock cannot be sold")
    current_stock = int(raw.get("stock_qty", 0))
    if current_stock < units_sold:
        raise HTTPException(
            status_code=400,
            detail=f"Not enough stock for {raw.get('name', 'item')} ({current_stock} left)",
        )

    new_stock = current_stock - units_sold
    now_iso = now.isoformat()
    unit_cost = float(raw.get("unit_cost", 0.0))
    raw_sp = float(raw.get("selling_price", 0.0))
    effective_sp = recovery_price(raw, now)
    campaign = active_recovery(raw, now)

    existing_events = [SaleEvent(**e) for e in (raw.get("sales_events") or [])]
    existing_events.append(
        SaleEvent(
            units_sold=units_sold,
            timestamp=now_iso,
            unit_selling_price=effective_sp,
            unit_cost_at_sale=unit_cost,
            batch_id=batch_id,
            recovery_id=campaign["id"] if campaign else None,
        )
    )

    recent_pace, prior_pace = compute_rolling_paces(existing_events, now)
    new_tracked = sum(e.units_sold for e in existing_events)

    update_data = {
        "stock_qty": new_stock,
        "units_sold_tracked": new_tracked,
        "prior_daily_sales": prior_pace,
        "recent_daily_sales": recent_pace,
        "last_sale_at": now_iso,
        "created_at": raw.get("created_at") or now_iso,
        "sales_events": [e.model_dump() for e in existing_events],
    }
    merged = {**raw, **update_data}
    return update_data, {**analyze_item(ItemInput(**merged), doc_id=item_id), "sale_unit_price": effective_sp}


@firestore.transactional
def commit_sales(transaction, quantities, now, batch_id=None, expected=None):
    prepared = []
    for item_id, qty in quantities.items():
        ref = db.collection("items").document(item_id)
        update, analyzed = prepare_sale(ref.get(transaction=transaction), item_id, qty, now, batch_id)
        if expected and item_id in expected and expected[item_id] != analyzed["sale_unit_price"]:
            raise HTTPException(409, "Price changed; refresh basket before checkout")
        prepared.append((ref, update, analyzed))
    for ref, update, _ in prepared:
        transaction.update(ref, update)
    return [analyzed for _, _, analyzed in prepared]


def apply_single_item_sale(item_id, units_sold, now, batch_id=None):
    return commit_sales(db.transaction(), {item_id: units_sold}, now, batch_id)[0]


@app.get("/")
def health_check():
    return {"status": "StockRadar backend running"}


@app.post("/api/items")
def create_item(item: ItemInput):
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        payload = item.model_dump()
        payload["recovery_campaigns"] = []
        if not payload.get("selling_price") or payload["selling_price"] <= 0:
            payload["selling_price"] = payload["unit_cost"]
        payload["expiry_date"] = (payload.get("expiry_date") or "").strip() or None
        payload["created_at"] = payload.get("created_at") or now_iso
        payload["units_sold_tracked"] = payload.get("units_sold_tracked") or 0.0
        payload["prior_daily_sales"] = payload.get("prior_daily_sales") or 0.0
        payload["recent_daily_sales"] = payload.get("recent_daily_sales") or 0.0
        payload["sales_events"] = payload.get("sales_events") or []

        doc_ref = db.collection("items").document()
        doc_ref.set(payload)
        saved = ItemInput(**payload)
        return {"message": "Item saved", "item": analyze_item(saved, doc_id=doc_ref.id)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/items/{item_id}")
def edit_item(item_id: str, payload: ItemEditInput):
    return edit_item_tx(db.transaction(), item_id, payload)


@firestore.transactional
def edit_item_tx(tx, item_id, payload):
    try:
        doc_ref = db.collection("items").document(item_id)
        doc = doc_ref.get(transaction=tx)
        if not doc.exists:
            raise HTTPException(status_code=404, detail="Item not found")

        raw = doc.to_dict()
        if active_recovery(raw, datetime.now(timezone.utc)):
            raise HTTPException(409, "End the recovery campaign before editing this item")
        updates = {}
        if payload.name is not None and payload.name.strip():
            updates["name"] = payload.name.strip()
        if payload.unit_cost is not None and payload.unit_cost >= 0:
            updates["unit_cost"] = float(payload.unit_cost)
        if payload.selling_price is not None and payload.selling_price >= 0:
            updates["selling_price"] = float(payload.selling_price)
        if payload.expiry_date is not None:
            updates["expiry_date"] = payload.expiry_date.strip() or None

        if updates:
            tx.update(doc_ref, updates)

        merged = {**raw, **updates}
        return {"message": "Item updated", "item": analyze_item(ItemInput(**merged), doc_id=item_id)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/items/{item_id}")
def delete_item(item_id: str):
    try:
        doc_ref = db.collection("items").document(item_id)
        doc = doc_ref.get()
        if not doc.exists:
            raise HTTPException(status_code=404, detail="Item not found")
        doc_ref.delete()
        return {"message": "Item deleted", "id": item_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/items/{item_id}/sales")
def record_item_sale(item_id: str, payload: SaleRecordInput):
    try:
        if payload.units_sold < 1:
            raise HTTPException(status_code=400, detail="units_sold must be at least 1")
        now = datetime.now(timezone.utc)
        updated_item = apply_single_item_sale(item_id, int(payload.units_sold), now, batch_id=None)
        return {"message": f"Recorded {payload.units_sold} sold", "item": updated_item}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/sales/checkout")
def checkout_customer_cart(payload: CheckoutCartInput):
    try:
        if not payload.items:
            raise HTTPException(status_code=400, detail="Customer basket is empty")

        now = datetime.now(timezone.utc)
        batch_id = str(uuid.uuid4())
        quantities = {}
        for line in payload.items:
            if line.units_sold < 1:
                raise HTTPException(status_code=400, detail="Quantity must be at least 1")
            quantities[line.item_id] = quantities.get(line.item_id, 0) + line.units_sold
        updated_items = commit_sales(db.transaction(), quantities, now, batch_id, {line.item_id: line.expected_price for line in payload.items if line.expected_price is not None})
        total_units = sum(quantities.values())
        total_paid = sum(quantities[item["id"]] * item["sale_unit_price"] for item in updated_items)

        return {
            "message": f"Completed sale of {total_units} items",
            "batch_id": batch_id,
            "total_units": total_units,
            "total_paid": round(total_paid, 2),
            "items": updated_items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/sales/undo-basket/{batch_id}")
def undo_basket_sale(batch_id: str):
    try:
        now = datetime.now(timezone.utc)
        docs = db.collection("items").stream()
        undone_count = 0

        for doc in docs:
            raw = doc.to_dict()
            raw_events = raw.get("sales_events") or []
            matching = [e for e in raw_events if e.get("batch_id") == batch_id]
            if not matching:
                continue

            remaining = [e for e in raw_events if e.get("batch_id") != batch_id]
            restored_units = sum(int(e.get("units_sold", 0)) for e in matching)
            restored_stock = int(raw.get("stock_qty", 0)) + restored_units
            parsed_events = [SaleEvent(**e) for e in remaining]
            recent_pace, prior_pace = compute_rolling_paces(parsed_events, now)
            new_tracked = sum(e.units_sold for e in parsed_events)

            doc.reference.update(
                {
                    "stock_qty": restored_stock,
                    "units_sold_tracked": new_tracked,
                    "prior_daily_sales": prior_pace,
                    "recent_daily_sales": recent_pace,
                    "last_sale_at": parsed_events[-1].timestamp if parsed_events else None,
                    "sales_events": [e.model_dump() for e in parsed_events],
                }
            )
            undone_count += restored_units

        if undone_count == 0:
            raise HTTPException(status_code=404, detail="No basket sale found to undo")

        return {"message": f"Undid basket sale ({undone_count} units restored)"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/items/{item_id}/undo-sale")
def undo_last_sale(item_id: str):
    try:
        doc_ref = db.collection("items").document(item_id)
        doc = doc_ref.get()
        if not doc.exists:
            raise HTTPException(status_code=404, detail="Item not found")

        raw = doc.to_dict()
        existing_events = [SaleEvent(**e) for e in (raw.get("sales_events") or [])]
        if not existing_events:
            raise HTTPException(status_code=400, detail="No recorded sale to undo")

        last_event = existing_events.pop()
        now = datetime.now(timezone.utc)
        restored_stock = int(raw.get("stock_qty", 0)) + int(last_event.units_sold)
        recent_pace, prior_pace = compute_rolling_paces(existing_events, now)
        new_tracked = sum(e.units_sold for e in existing_events)

        update_data = {
            "stock_qty": restored_stock,
            "units_sold_tracked": new_tracked,
            "prior_daily_sales": prior_pace,
            "recent_daily_sales": recent_pace,
            "last_sale_at": existing_events[-1].timestamp if existing_events else None,
            "sales_events": [e.model_dump() for e in existing_events],
        }
        doc_ref.update(update_data)

        merged = {**raw, **update_data}
        parsed = ItemInput(**merged)
        return {
            "message": f"Undid sale of {last_event.units_sold}",
            "item": analyze_item(parsed, doc_id=item_id),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/items/{item_id}/restock")
def restock_item(item_id: str, payload: RestockInput):
    try:
        if payload.units_added < 1:
            raise HTTPException(status_code=400, detail="units_added must be at least 1")

        doc_ref = db.collection("items").document(item_id)
        doc = doc_ref.get()
        if not doc.exists:
            raise HTTPException(status_code=404, detail="Item not found")

        raw = doc.to_dict()
        current_analysis = analyze_item(ItemInput(**raw), doc_id=item_id)
        if current_analysis["status"] != "Healthy":
            raise HTTPException(
                status_code=400,
                detail=f"Restock blocked while item is {current_analysis['status']}. Clear existing stock first.",
            )

        new_stock = int(raw.get("stock_qty", 0)) + int(payload.units_added)
        doc_ref.update({"stock_qty": new_stock})

        merged = {**raw, "stock_qty": new_stock}
        parsed = ItemInput(**merged)
        return {
            "message": f"Added {payload.units_added} units",
            "item": analyze_item(parsed, doc_id=item_id),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/radar")
def get_radar_overview():
    try:
        docs = db.collection("items").stream()
        results = []
        for doc in docs:
            data = doc.to_dict()
            parsed = ItemInput(**data)
            results.append(analyze_item(parsed, doc_id=doc.id))

        priority = {"Dead-Stock Risk": 0, "Slowing Down": 1, "Healthy": 2}
        results.sort(key=lambda x: (priority.get(x["status"], 3), -x["tied_up_value"]))

        summary = {
            "total_items": len(results),
            "dead_stock_risk": sum(1 for r in results if r["status"] == "Dead-Stock Risk"),
            "slowing_down": sum(1 for r in results if r["status"] == "Slowing Down"),
            "healthy": sum(1 for r in results if r["status"] == "Healthy"),
            "reorder_soon_count": sum(1 for r in results if r["reorder_soon"]),
            "expiring_soon_count": sum(
                1 for r in results if r["expiring_soon"] or r["is_expired"]
            ),
            "total_tied_up_value": round(sum(r["tied_up_value"] for r in results), 2),
            "at_risk_capital": round(
                sum(r["tied_up_value"] for r in results if r["status"] != "Healthy"), 2
            ),
            "units_sold_today": sum(r["units_sold_today"] for r in results),
            "cash_collected_today": round(sum(r["cash_collected_today"] for r in results), 2),
            "profit_today": round(sum(r["profit_today"] for r in results), 2),
        }
        return {"summary": summary, "items": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/actions")
def log_action(entry: ActionLogInput):
    try:
        record = entry.model_dump()
        record["created_at"] = datetime.now(timezone.utc).isoformat()
        doc_ref = db.collection("action_logs").document()
        doc_ref.set(record)
        return {"id": doc_ref.id, **record}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/actions")
def list_actions():
    try:
        docs = (
            db.collection("action_logs")
            .order_by("created_at", direction=firestore.Query.DESCENDING)
            .limit(15)
            .stream()
        )
        return [{"id": d.id, **d.to_dict()} for d in docs]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/predictions")
def get_predictions(demo: bool = False):
    now = datetime.now(timezone.utc)
    tz = ZoneInfo("Africa/Dar_es_Salaam")
    today = now.astimezone(tz).date()
    rows = []
    for doc in db.collection("demo_items" if demo else "items").stream():
        item = ItemInput(**doc.to_dict())
        valid = [(parse_iso_dt(e.timestamp), e.units_sold) for e in item.sales_events]
        valid = [(dt, qty) for dt, qty in valid if dt and dt <= now and qty > 0]
        created = parse_iso_dt(item.created_at)
        start = created.astimezone(tz).date() + timedelta(days=1) if created else today
        start = max(start, today - timedelta(days=30))
        dates = [start + timedelta(days=i) for i in range(max(0, (today-start).days))]
        counts = {d: 0 for d in dates}
        for dt, qty in valid:
            day = dt.astimezone(tz).date()
            if day in counts:
                counts[day] += qty
        price = recovery_price(item.model_dump(), now)
        result = forecast(list(counts.values()), item.stock_qty, item.unit_cost, price, parse_expiry_days(item.expiry_date, today))
        rows.append({"id": doc.id, "name": item.name, "stock": item.stock_qty, "history": [{"date": d.isoformat(), "units": counts[d]} for d in dates], **result})
    return {"as_of": today.isoformat(), "demo": demo, "items": rows}
