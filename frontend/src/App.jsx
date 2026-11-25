import { useEffect, useState } from "react";
import "./stockradar.css";
import Predictions from "./Predictions";

const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

const INITIAL_FORM = {
  name: "",
  stock_qty: "",
  unit_cost: "",
  selling_price: "",
  expiry_date: "",
};

export default function App() {
  const [page, setPage] = useState("Overview");
  useEffect(() => { document.title = "StockRadar | Inventory Intelligence"; }, []);
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("risk");
  const currency = "TSh";
  const [discount, setDiscount] = useState(0);

  const [form, setForm] = useState(INITIAL_FORM);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  // Multi-product Customer Basket state: { [itemId]: qty }
  const [basket, setBasket] = useState({});
  const [lastBasketBatch, setLastBasketBatch] = useState(null);

  const [selectedItem, setSelectedItem] = useState(null);
  const [restockInput, setRestockInput] = useState(10);

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editCost, setEditCost] = useState("");
  const [editSellingPrice, setEditSellingPrice] = useState("");
  const [editExpiry, setEditExpiry] = useState("");

  const formatMoney = (amount) => {
    const val = Number(amount || 0);
    return `TSh ${val.toLocaleString("en-TZ", { maximumFractionDigits: 2 })}`;
  };

  const showNotice = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3200);
  };

  const fetchRadar = async () => {
    setLoading(true);
    setError("");
    try {
      const radarRes = await fetch(`${API_BASE}/api/radar`);
      if (!radarRes.ok) throw new Error(`Radar API returned ${radarRes.status}`);
      const radarData = await radarRes.json();
      const freshItems = radarData.items || [];
      setSummary(radarData.summary);
      setItems(freshItems);

      if (selectedItem?.id) {
        const fresh = freshItems.find((i) => i.id === selectedItem.id);
        setSelectedItem(fresh || null);
      }

      setBasket((prev) => {
        const next = {};
        for (const [id, qty] of Object.entries(prev)) {
          const match = freshItems.find((i) => i.id === id);
          if (match && match.stock_qty > 0) {
            next[id] = Math.min(qty, match.stock_qty);
          }
        }
        return next;
      });
    } catch (err) {
      setError(
        `Offline or server unreachable (${err.message}). Check that Uvicorn is running on port 8000.`
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRadar();
  }, []);

  const openInspector = (item) => {
    setSelectedItem(item);
    setRestockInput(10);
    setIsEditing(false);
    setEditName(item.name);
    setEditCost(item.unit_cost);
    setEditSellingPrice(item.selling_price ?? item.unit_cost);
    setEditExpiry(item.expiry_date || "");
  };

  const addToBasket = (item, qtyToAdd = 1) => {
    if (item.is_expired) return;
    if (!item?.id || item.stock_qty <= 0) return;
    setBasket((prev) => {
      const current = prev[item.id] || 0;
      const nextQty = Math.min(item.stock_qty, current + qtyToAdd);
      return { ...prev, [item.id]: nextQty };
    });
  };

  const updateBasketQty = (itemId, nextQty, maxStock) => {
    setBasket((prev) => {
      const copy = { ...prev };
      if (nextQty <= 0) {
        delete copy[itemId];
      } else {
        copy[itemId] = Math.min(maxStock, nextQty);
      }
      return copy;
    });
  };

  const clearBasket = () => setBasket({});

  const basketLines = Object.entries(basket)
    .map(([id, qty]) => {
      const item = items.find((i) => i.id === id);
      if (!item) return null;
      const unitPrice = Number(item.selling_price || item.unit_cost || 0);
      return {
        item,
        qty,
        unitPrice,
        lineTotal: unitPrice * qty,
      };
    })
    .filter(Boolean);

  const basketTotalUnits = basketLines.reduce((acc, l) => acc + l.qty, 0);
  const basketTotalMoney = basketLines.reduce((acc, l) => acc + l.lineTotal, 0);

  const handleCompleteBasketSale = async () => {
    if (basketLines.length === 0) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/sales/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: basketLines.map((l) => ({
            item_id: l.item.id,
            units_sold: l.qty,
          })),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Error ${res.status}`);
      }
      const data = await res.json();
      setLastBasketBatch({
        batchId: data.batch_id,
        totalUnits: data.total_units,
        totalPaid: data.total_paid,
      });
      clearBasket();
      showNotice(
        `Sale completed: ${data.total_units} items · Paid ${formatMoney(data.total_paid)}`
      );
      await fetchRadar();
    } catch (err) {
      setError(`Could not complete customer sale: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUndoBasketSale = async () => {
    if (!lastBasketBatch?.batchId) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(
        `${API_BASE}/api/sales/undo-basket/${lastBasketBatch.batchId}`,
        { method: "POST" }
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Error ${res.status}`);
      }
      showNotice(
        `Undid basket sale (${lastBasketBatch.totalUnits} items · ${formatMoney(lastBasketBatch.totalPaid)})`
      );
      setLastBasketBatch(null);
      await fetchRadar();
    } catch (err) {
      setError(`Failed to undo basket sale: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleAddItem = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const payload = {
        name: form.name.trim(),
        stock_qty: Number(form.stock_qty),
        unit_cost: Number(form.unit_cost),
        selling_price: Number(form.selling_price || form.unit_cost),
        expiry_date: form.expiry_date || null,
      };
      const res = await fetch(`${API_BASE}/api/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Error ${res.status}`);
      }
      setForm(INITIAL_FORM);
      showNotice(`Added "${payload.name}"`);
      await fetchRadar();
    } catch (err) {
      setError(`Failed to save item: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSellOneUnit = async () => {
    if (!selectedItem?.id) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/items/${selectedItem.id}/sales`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ units_sold: 1 }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Error ${res.status}`);
      }
      const data = await res.json();
      setSelectedItem(data.item);
      const unitCharge = Number(data.item.selling_price || data.item.unit_cost);
      showNotice(
        `Sold 1 × ${data.item.name} (${formatMoney(unitCharge)}) · ${data.item.stock_qty} left`
      );
      await fetchRadar();
    } catch (err) {
      setError(`Sale did not save: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUndoSale = async () => {
    if (!selectedItem?.id) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/items/${selectedItem.id}/undo-sale`, {
        method: "POST",
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Error ${res.status}`);
      }
      const data = await res.json();
      setSelectedItem(data.item);
      showNotice(`Undid last sale on ${data.item.name}`);
      await fetchRadar();
    } catch (err) {
      setError(`Failed to undo last sale: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRestock = async (e) => {
    e.preventDefault();
    if (!selectedItem?.id) return;
    const added = Math.max(1, Number(restockInput) || 1);
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/items/${selectedItem.id}/restock`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ units_added: added }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Error ${res.status}`);
      }
      const data = await res.json();
      setSelectedItem(data.item);
      setRestockInput(10);
      showNotice(`Added ${added} units to ${data.item.name}`);
      await fetchRadar();
    } catch (err) {
      setError(`Failed to restock item: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!selectedItem?.id) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/items/${selectedItem.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          unit_cost: Number(editCost),
          selling_price: Number(editSellingPrice || editCost),
          expiry_date: editExpiry,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Error ${res.status}`);
      }
      const data = await res.json();
      setSelectedItem(data.item);
      setIsEditing(false);
      showNotice("Item details updated");
      await fetchRadar();
    } catch (err) {
      setError(`Failed to update item: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteItem = async () => {
    if (!selectedItem?.id) return;
    if (!window.confirm(`Remove "${selectedItem.name}" from inventory?`)) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/items/${selectedItem.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Error ${res.status}`);
      }
      showNotice(`Deleted "${selectedItem.name}"`);
      setSelectedItem(null);
      await fetchRadar();
    } catch (err) {
      setError(`Failed to delete item: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const visibleItems = items
    .filter((item) => {
      if (filter === "Reorder Soon" && !item.reorder_soon) return false;
      if (filter === "Expiring Soon" && !item.expiring_soon && !item.is_expired) return false;
      if (
        filter !== "All" &&
        filter !== "Reorder Soon" &&
        filter !== "Expiring Soon" &&
        item.status !== filter
      ) {
        return false;
      }
      if (
        searchQuery.trim() &&
        !item.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "cash") return b.tied_up_value - a.tied_up_value;
      if (sortBy === "low_stock") return a.stock_qty - b.stock_qty;
      return (b.risk_score ?? 0) - (a.risk_score ?? 0) || b.tied_up_value - a.tied_up_value;
    });

  const badgeStyle = (status) => {
    if (status === "Dead-Stock Risk")
      return { background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" };
    if (status === "Slowing Down")
      return { background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" };
    return { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  };

  const navigate = (next) => { setPage(next); setFilter("All"); setSearchQuery(""); };
  const nav = [["Overview","◈"],["Inventory Radar","◎"],["Point of Sale","▤"],["Capital Recovery","↗"],["Business Advisor","✦"],["Predictive Intelligence","↝"]];
  const priority = [...items].filter(i => i.stock_qty > 0 && i.status !== "Healthy").sort((a,b) => (b.risk_score || 0)-(a.risk_score || 0) || b.tied_up_value-a.tied_up_value);
  const capital = Number(summary?.total_tied_up_value || 0);
  const atRisk = Number(summary?.at_risk_capital || 0);
  const riskPct = capital > 0 ? Math.min(100, Math.max(0, atRisk/capital*100)) : 0;
  return (
    <div className="sr-shell">
      <aside className="sr-sidebar">
        <div className="sr-brand"><span className="sr-logo">◎</span><div>Stock<span>Radar</span><small>INVENTORY INTELLIGENCE</small></div></div>
        <div className="sr-nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">{nav.map(([name,icon]) => <button key={name} aria-current={page===name ? "page" : undefined} className={page===name ? "active" : ""} onClick={()=>navigate(name)}><span>{icon}</span>{name}{name==="Point of Sale" && basketTotalUnits>0 && <b>{basketTotalUnits}</b>}</button>)}</nav>
        <div className="sr-sidebar-foot">StockRadar v1.0<br/><small>Independent portfolio project</small></div>
      </aside>
      <main className="sr-main">
      <header className="sr-header"><div><div className="sr-eyebrow">WORKSPACE / {page.toUpperCase()}</div><h1>{page}</h1><p>{({Overview:"Monitor your inventory. Protect your capital.","Inventory Radar":"Manage products and investigate inventory risks.","Point of Sale":"Build a basket and record customer sales.","Capital Recovery":"Explore discount scenarios before making decisions.","Business Advisor":"Prioritize actions using your inventory data.","Predictive Intelligence":"Forecast demand and anticipate inventory exposure."})[page]}</p></div><button onClick={fetchRadar} disabled={loading} style={styles.primaryBtn}>{loading ? "Refreshing…" : "↻ Refresh data"}</button></header>
      {page === "Predictive Intelligence" && <Predictions api={API_BASE} refresh={loading} money={formatMoney}/>}
      {toast && <div style={styles.toastBox}>{toast}</div>}
      {error && <div style={styles.errorBox}>{error}</div>}

      {page === "Overview" && summary && (
        <section style={styles.todayBar}>
          <div>
            <span style={styles.todayLabel}>TODAY&apos;S COUNTER RECAP</span>
            <div style={styles.todayStats}>
              <span>
                Sold Today: <strong>{summary.units_sold_today ?? 0} units</strong>
              </span>
              <span>·</span>
              <span>
                Cash Collected Today:{" "}
                <strong>{formatMoney(summary.cash_collected_today ?? 0)}</strong>
              </span>
              <span>·</span>
              <span style={{ color: "#86efac" }}>
                Profit Earned Today: <strong>{formatMoney(summary.profit_today ?? 0)}</strong>
              </span>
              <span>·</span>
              <span>
                Expiring Soon: <strong>{summary.expiring_soon_count ?? 0}</strong>
              </span>
            </div>
          </div>
        </section>
      )}

      {page === "Overview" && summary && (
        <section style={styles.kpiGrid}>
          <KpiCard label="Total Tracked Items" value={summary.total_items} />
          <KpiCard
            label="Dead-Stock Risk"
            value={summary.dead_stock_risk}
            accent="#dc2626"
          />
          <KpiCard
            label="Slowing Down"
            value={summary.slowing_down}
            accent="#d97706"
          />
          <KpiCard label="Healthy" value={summary.healthy} accent="#16a34a" />
          <KpiCard
            label="At-Risk Capital"
            value={formatMoney(summary.at_risk_capital ?? summary.total_tied_up_value)}
            accent="#b91c1c"
          />
          <KpiCard
            label="Total Tied-Up Cost"
            value={formatMoney(summary.total_tied_up_value)}
          />
        </section>
      )}

      {page === "Overview" && <div className="sr-overview-grid">
        <section className="sr-panel"><h2>Capital exposure</h2><p>Inventory cost classified as slowing or dead-stock risk.</p><div className="sr-big">{riskPct.toFixed(1)}%</div><div className="sr-meter" role="img" aria-label={`${riskPct.toFixed(1)} percent capital at risk`}><span style={{width:`${riskPct}%`}}/></div><div className="sr-between"><span>At risk <strong>{formatMoney(atRisk)}</strong></span><span>Total <strong>{formatMoney(capital)}</strong></span></div></section>
        <section className="sr-panel"><h2>Inventory health</h2><p>Number of tracked products by status.</p>{[["Healthy",summary?.healthy,"#10b981"],["Slowing down",summary?.slowing_down,"#f59e0b"],["Dead-stock risk",summary?.dead_stock_risk,"#ef4444"]].map(([label,count,color])=><div className="sr-health" key={label}><div className="sr-between"><span>{label}</span><strong>{count ?? 0}</strong></div><div className="sr-meter"><span style={{width:`${summary?.total_items ? 100*(count||0)/summary.total_items : 0}%`,background:color}}/></div></div>)}</section>
      </div>}
      {(page === "Overview" || page === "Business Advisor") && <section className="sr-panel"><h2>Priority recommendations</h2><p>Rule-based insights from your current inventory, ranked by risk score.</p>{priority.length===0 ? <p>No at-risk stocked products to review.</p> : (page === "Overview" ? priority.slice(0,5) : priority).map(item=><div className="sr-recommendation" key={item.id}><div><strong>{item.name}</strong><p>{item.recommended_action}</p><small>{(item.risk_reasons||[]).join(" · ")}</small></div><div><strong>{formatMoney(item.tied_up_value)}</strong><small>Risk {item.risk_score ?? "—"}/100</small><button style={styles.secondaryBtn} onClick={()=>{openInspector(item);navigate("Inventory Radar");}}>Review item</button></div></div>)}</section>}
      {page === "Inventory Radar" && (
      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>Add Inventory Item</h2>
        <form onSubmit={handleAddItem} style={styles.formGrid}>
          <input
            name="name"
            placeholder="Item Name (e.g. Single Cigarette)"
            value={form.name}
            onChange={handleChange}
            required
            style={styles.input}
          />
          <input
            name="stock_qty"
            type="number"
            min="0"
            placeholder="Stock Qty"
            value={form.stock_qty}
            onChange={handleChange}
            required
            style={styles.input}
          />
          <input
            name="unit_cost"
            type="number"
            step="0.01"
            min="0"
            placeholder={`Buying Cost (${currency})`}
            value={form.unit_cost}
            onChange={handleChange}
            required
            style={styles.input}
          />
          <input
            name="selling_price"
            type="number"
            step="0.01"
            min="0"
            placeholder={`Selling Price (${currency})`}
            value={form.selling_price}
            onChange={handleChange}
            required
            style={styles.input}
          />
          <label style={styles.dateFieldWrap}>
            <span style={styles.dateHint}>Expiry Date (Optional)</span>
            <input
              name="expiry_date"
              type="date"
              value={form.expiry_date}
              onChange={handleChange}
              style={styles.input}
            />
          </label>
          <button type="submit" disabled={submitting} style={styles.primaryBtn}>
            {submitting ? "Saving..." : "Add Item"}
          </button>
        </form>
      </section>

      )}
      {(page === "Inventory Radar" || page === "Point of Sale" || page === "Capital Recovery") && <div className="sr-workspace" style={styles.mainSplit}>
        <section style={{ ...styles.card, flex: 2, minWidth: 0 }}>
          <div style={styles.tableHeader}>
            <h2 style={{ ...styles.sectionTitle, margin: 0 }}>
              {page === "Point of Sale" ? "Product catalog" : "Inventory watchlist"}
            </h2>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="search"
                placeholder="Search item name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ ...styles.input, padding: "6px 10px", minWidth: "170px" }}
              />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{ ...styles.input, padding: "6px 10px" }}
              >
                <option value="risk">Sort: Risk Priority</option>
                <option value="cash">Sort: Most Cash Tied Up</option>
                <option value="low_stock">Sort: Lowest Stock Left</option>
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "14px" }}>
            {[
              "All",
              "Dead-Stock Risk",
              "Slowing Down",
              "Healthy",
              "Reorder Soon",
              "Expiring Soon",
            ].map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                style={{
                  ...styles.filterBtn,
                  background: filter === tab ? "#0f172a" : "#f1f5f9",
                  color: filter === tab ? "#ffffff" : "#334155",
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          {loading ? (
            <p style={styles.muted}>Scanning inventory from Firestore...</p>
          ) : visibleItems.length === 0 ? (
            <p style={styles.muted}>
              No matching items found. Add an item above or adjust your search/filter.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {page === "Point of Sale" && <th style={styles.th}>Quick Add</th>}
                    <th style={styles.th}>Item Name</th>
                    <th style={styles.th}>Sell Price</th>
                    <th style={styles.th}>Left in Stock</th>
                    <th style={styles.th}>Pace (7d → 7d)</th>
                    <th style={styles.th}>Status</th>
                    <th style={styles.th}>Recommended Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item, idx) => {
                    const isSelected = selectedItem?.id && selectedItem.id === item.id;
                    const inBasketQty = basket[item.id] || 0;
                    return (
                      <tr
                        key={item.id || `${item.name}-${idx}`}
                        onClick={() => openInspector(item)}
                        style={{
                          ...styles.tr,
                          cursor: "pointer",
                          background: isSelected ? "#eff6ff" : "transparent",
                        }}
                      >
                        {page === "Point of Sale" && <td
                          style={styles.td}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            disabled={item.is_expired || item.stock_qty <= 0 || inBasketQty >= item.stock_qty}
                            onClick={() => addToBasket(item, 1)}
                            style={styles.basketAddBtn}
                          >
                            + Basket{inBasketQty > 0 ? ` (${inBasketQty})` : ""}
                          </button>
                        </td>}
                        <td style={styles.td}>
                          <button className="sr-item-link" onClick={()=>openInspector(item)}>{item.name}</button>
                          <div style={styles.skuText}>
                            Cost: {formatMoney(item.unit_cost)} · Profit/unit:{" "}
                            {formatMoney(item.unit_profit)}
                          </div>
                          {item.reorder_soon && (
                            <span style={styles.reorderPill}>Reorder Soon</span>
                          )}
                          {item.is_expired && (
                            <span style={styles.expiredPill}>Expired ({item.expiry_date})</span>
                          )}
                          {item.expiring_soon && !item.is_expired && (
                            <span style={styles.expiringPill}>
                              Expires in {item.days_to_expiry}d
                            </span>
                          )}
                        </td>
                        <td style={styles.td}>
                          <strong>{formatMoney(item.selling_price)}</strong>
                        </td>
                        <td style={styles.td}>
                          <strong>{item.stock_qty}</strong> left
                        </td>
                        <td style={styles.td}>
                          {item.prior_daily_sales}/d → <strong>{item.recent_daily_sales}/d</strong>
                        </td>
                        <td style={styles.td}>
                          <span style={{ ...styles.badge, ...badgeStyle(item.status) }}>
                            {item.status}
                          </span>
                          <div style={styles.skuText}>Risk: {item.risk_score ?? "—"}/100</div>
                        </td>
                        <td style={styles.td}>{item.recommended_action}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Right Side: Customer Basket + Streamlined Selected-Item Panel */}
        <aside className="sr-inspector" style={{ flex: 1, minWidth: 0 }}>
          {page === "Point of Sale" && (
          <div style={{ ...styles.card, border: "2px solid #0f172a" }}>
            <div style={styles.basketHeader}>
              <h2 style={{ ...styles.sectionTitle, margin: 0 }}>Customer Basket (Checkout)</h2>
              {basketLines.length > 0 && (
                <button type="button" onClick={clearBasket} style={styles.clearLink}>
                  Clear
                </button>
              )}
            </div>

            {basketLines.length === 0 ? (
              <p style={styles.muted}>
                Tap <strong>+ Basket</strong> on any row to add items, adjust quantities here, and see the total before completing the sale.
              </p>
            ) : (
              <div>
                <div style={styles.basketList}>
                  {basketLines.map(({ item, qty, unitPrice, lineTotal }) => (
                    <div key={item.id} style={styles.basketRow}>
                      <div style={{ flex: 1 }}>
                        <strong>{item.name}</strong>
                        <div style={styles.skuText}>
                          {formatMoney(unitPrice)} × {qty} ={" "}
                          <strong>{formatMoney(lineTotal)}</strong>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <button
                          type="button"
                          onClick={() => updateBasketQty(item.id, qty - 1, item.stock_qty)}
                          style={styles.qtyStepBtn}
                        >
                          −
                        </button>
                        <strong style={{ minWidth: "20px", textAlign: "center" }}>{qty}</strong>
                        <button
                          type="button"
                          disabled={qty >= item.stock_qty}
                          onClick={() => updateBasketQty(item.id, qty + 1, item.stock_qty)}
                          style={styles.qtyStepBtn}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={styles.basketTotalBox}>
                  <div style={styles.totalRow}>
                    <span>Total Products:</span>
                    <strong>{basketTotalUnits} units</strong>
                  </div>
                  <div style={{ ...styles.totalRow, fontSize: "18px", marginTop: "6px" }}>
                    <span>Total to Pay:</span>
                    <strong style={{ color: "#15803d" }}>
                      {formatMoney(basketTotalMoney)}
                    </strong>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCompleteBasketSale}
                  disabled={submitting}
                  style={styles.counterTapBtn}
                >
                  {submitting
                    ? "Recording..."
                    : `Complete Sale (${formatMoney(basketTotalMoney)})`}
                </button>
              </div>
            )}

            {lastBasketBatch && (
              <button
                type="button"
                onClick={handleUndoBasketSale}
                disabled={submitting}
                style={{ ...styles.secondaryBtn, width: "100%", marginTop: "8px" }}
              >
                Undo Last Basket Sale ({formatMoney(lastBasketBatch.totalPaid)})
              </button>
            )}
          </div>

          )}
          {page !== "Point of Sale" && <div style={styles.card}>
            <h2 style={styles.sectionTitle}>{page === "Capital Recovery" ? "Recovery scenario" : "Selected item actions"}</h2>
            {!selectedItem ? (
              <p style={styles.muted}>
                Click any item row to highlight it in <strong>light blue</strong> for 1-tap single-unit sales, undo, restock, or editing.
              </p>
            ) : (
              <div>
                <div style={styles.inspectorHeader}>
                  <div>
                    <strong>{selectedItem.name}</strong>
                    <div style={styles.skuText}>
                      <strong>{selectedItem.stock_qty} left</strong> · Sell:{" "}
                      <strong>{formatMoney(selectedItem.selling_price)}</strong> · Cost:{" "}
                      {formatMoney(selectedItem.unit_cost)}
                    </div>
                  </div>
                  <span style={{ ...styles.badge, ...badgeStyle(selectedItem.status) }}>
                    {selectedItem.status}
                  </span>
                </div>

                <div style={styles.simBox}>
                  <strong>Risk score: {selectedItem.risk_score ?? "—"}/100</strong>
                  <div style={styles.skuText}>{(selectedItem.risk_reasons || []).join(" · ") || "No scored risk factors"}</div>
                </div>
                {!selectedItem.is_expired && <div style={styles.simBox}>
                  <strong>Capital recovery simulator</strong>
                  <p>Discount: {discount}%</p>
                  <input aria-label="Discount percentage" type="range" min="0" max="60" value={discount} onChange={e => setDiscount(Number(e.target.value))} style={{width:"100%"}} />
                  <div>New unit price: {formatMoney(selectedItem.selling_price * (1-discount/100))}</div>
                  <div>Potential revenue: {formatMoney(selectedItem.stock_qty * selectedItem.selling_price * (1-discount/100))}</div>
                  <div>Gross profit: {formatMoney(selectedItem.stock_qty * (selectedItem.selling_price * (1-discount/100)-selectedItem.unit_cost))}</div>
                  <small>Scenario only: assumes all units sell; excludes operating expenses.</small>
                </div>}
                <div style={styles.simBox}>
                  <div style={styles.simStats}>
                    <div>
                      Profit per unit: <strong>{formatMoney(selectedItem.unit_profit)}</strong>
                    </div>
                    <div>
                      Safe max discount:{" "}
                      <strong>{selectedItem.max_safe_discount_pct}% off</strong> (floor{" "}
                      {formatMoney(selectedItem.unit_cost)})
                    </div>
                    {selectedItem.expiry_date && (
                      <div>
                        Expiry: <strong>{selectedItem.expiry_date}</strong> (
                        {selectedItem.days_to_expiry < 0
                          ? "Expired"
                          : `${selectedItem.days_to_expiry}d left`}
                        )
                      </div>
                    )}
                    <div>
                      Pace (7d → 7d):{" "}
                      <strong>
                        {selectedItem.prior_daily_sales}/d → {selectedItem.recent_daily_sales}/d
                      </strong>
                    </div>
                  </div>
                </div>

                {page === "Inventory Radar" && <>
                <button
                  type="button"
                  onClick={handleSellOneUnit}
                  disabled={submitting || selectedItem.is_expired || selectedItem.stock_qty <= 0}
                  style={styles.counterTapBtn}
                >
                  Sell 1 Unit Now ({formatMoney(selectedItem.selling_price)})
                </button>

                <button
                  type="button"
                  onClick={handleUndoSale}
                  disabled={submitting || !selectedItem.can_undo_sale}
                  style={{ ...styles.secondaryBtn, width: "100%", marginTop: "8px" }}
                >
                  Undo Last Sale
                </button>

                {selectedItem.status !== "Healthy" ? (
                  <div
                    style={{
                      ...styles.simBox,
                      marginTop: "14px",
                      background: "#fffbeb",
                      borderColor: "#fde68a",
                      color: "#92400e",
                      fontSize: "13px",
                    }}
                  >
                    <strong>Restock Paused ({selectedItem.status})</strong>
                    <div style={{ marginTop: "4px" }}>
                      Adding stock is locked until sales speed recovers or expired stock is cleared.
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleRestock} style={styles.subBlock}>
                    <label style={styles.fieldLabel}>
                      Add New Stock (Restock)
                      <input
                        type="number"
                        min="1"
                        value={restockInput}
                        onChange={(e) => setRestockInput(e.target.value)}
                        style={styles.input}
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={submitting}
                      style={{ ...styles.secondaryBtn, width: "100%", marginTop: "8px" }}
                    >
                      Add Stock
                    </button>
                  </form>
                )}

                <div style={styles.subBlock}>
                  {!isEditing ? (
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        type="button"
                        onClick={() => setIsEditing(true)}
                        style={{ ...styles.secondaryBtn, flex: 1 }}
                      >
                        Edit Item
                      </button>
                      <button
                        type="button"
                        onClick={handleDeleteItem}
                        disabled={submitting}
                        style={styles.dangerBtn}
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                    <form
                      onSubmit={handleSaveEdit}
                      style={{ display: "flex", flexDirection: "column", gap: "8px" }}
                    >
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Item Name"
                        required
                        style={styles.input}
                      />
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editCost}
                        onChange={(e) => setEditCost(e.target.value)}
                        placeholder={`Buying Cost (${currency})`}
                        required
                        style={styles.input}
                      />
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editSellingPrice}
                        onChange={(e) => setEditSellingPrice(e.target.value)}
                        placeholder={`Selling Price (${currency})`}
                        required
                        style={styles.input}
                      />
                      <input
                        type="date"
                        value={editExpiry}
                        onChange={(e) => setEditExpiry(e.target.value)}
                        style={styles.input}
                      />
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          type="submit"
                          disabled={submitting}
                          style={{ ...styles.primaryBtn, flex: 1 }}
                        >
                          Save Changes
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsEditing(false)}
                          style={styles.secondaryBtn}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </div>
                </>}
              </div>
            )}
          </div>}
        </aside>
      </div>}
      </main>
    </div>
  );
}

function KpiCard({ label, value, accent = "#0f172a" }) {
  return (
    <div style={styles.kpiCard}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={{ ...styles.kpiValue, color: accent }}>{value}</div>
    </div>
  );
}

const styles = {
  page: {
    maxWidth: "1320px",
    margin: "0 auto",
    padding: "24px 16px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "#0f172a",
    background: "#f8fafc",
    minHeight: "100vh",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "14px",
    marginBottom: "18px",
  },
  title: { margin: 0, fontSize: "32px", fontWeight: 800, color: "#047857" },
  subtitle: { margin: "4px 0 0", color: "#475569", fontSize: "14px" },
  todayBar: {
    background: "#0f172a",
    color: "#ffffff",
    padding: "14px 18px",
    borderRadius: "10px",
    marginBottom: "18px",
  },
  todayLabel: {
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.06em",
    color: "#94a3b8",
  },
  todayStats: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
    marginTop: "4px",
    fontSize: "14px",
  },
  kpiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
    gap: "14px",
    marginBottom: "20px",
  },
  kpiCard: {
    background: "#ffffff",
    padding: "16px",
    borderRadius: "10px",
    border: "1px solid #e2e8f0",
  },
  kpiLabel: {
    fontSize: "12px",
    color: "#64748b",
    fontWeight: 600,
    textTransform: "uppercase",
  },
  kpiValue: { fontSize: "22px", fontWeight: 700, marginTop: "6px" },
  card: {
    background: "#ffffff",
    padding: "18px",
    borderRadius: "10px",
    border: "1px solid #e2e8f0",
    marginBottom: "20px",
  },
  mainSplit: {
    display: "flex",
    gap: "20px",
    alignItems: "flex-start",
    flexWrap: "wrap",
  },
  sectionTitle: { margin: "0 0 14px", fontSize: "17px", fontWeight: 600 },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))",
    gap: "10px",
    alignItems: "end",
  },
  dateFieldWrap: { display: "flex", flexDirection: "column", gap: "3px" },
  dateHint: { fontSize: "11px", color: "#64748b", fontWeight: 600 },
  input: {
    padding: "10px 11px",
    borderRadius: "7px",
    border: "1px solid #cbd5e1",
    fontSize: "14px",
    background: "#ffffff",
  },
  primaryBtn: {
    background: "#0f172a",
    color: "#ffffff",
    border: "none",
    padding: "10px 16px",
    borderRadius: "7px",
    fontWeight: 600,
    cursor: "pointer",
  },
  counterTapBtn: {
    width: "100%",
    marginTop: "12px",
    background: "#16a34a",
    color: "#ffffff",
    border: "none",
    padding: "15px 18px",
    borderRadius: "9px",
    fontSize: "16px",
    fontWeight: 700,
    cursor: "pointer",
  },
  basketAddBtn: {
    background: "#eff6ff",
    color: "#1d4ed8",
    border: "1px solid #bfdbfe",
    padding: "6px 10px",
    borderRadius: "7px",
    fontSize: "12px",
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  basketHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "12px",
  },
  clearLink: {
    background: "none",
    border: "none",
    color: "#dc2626",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
  },
  basketList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    marginBottom: "12px",
  },
  basketRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
    padding: "8px 10px",
    background: "#f8fafc",
    borderRadius: "8px",
    border: "1px solid #e2e8f0",
    fontSize: "13px",
  },
  qtyStepBtn: {
    width: "28px",
    height: "28px",
    borderRadius: "6px",
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    fontWeight: 700,
    cursor: "pointer",
  },
  basketTotalBox: {
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    borderRadius: "8px",
    padding: "12px",
    fontSize: "14px",
  },
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  secondaryBtn: {
    background: "#ffffff",
    color: "#0f172a",
    border: "1px solid #cbd5e1",
    padding: "10px 14px",
    borderRadius: "7px",
    fontWeight: 600,
    cursor: "pointer",
  },
  dangerBtn: {
    background: "#fef2f2",
    color: "#b91c1c",
    border: "1px solid #fecaca",
    padding: "10px 14px",
    borderRadius: "7px",
    fontWeight: 600,
    cursor: "pointer",
  },
  tableHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "10px",
    marginBottom: "12px",
  },
  filterBtn: {
    border: "none",
    padding: "7px 12px",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "14px" },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    borderBottom: "2px solid #e2e8f0",
    color: "#475569",
    fontSize: "12px",
    textTransform: "uppercase",
  },
  tr: { borderBottom: "1px solid #f1f5f9" },
  td: { padding: "12px", verticalAlign: "middle" },
  skuText: { fontSize: "12px", color: "#64748b", marginTop: "2px" },
  badge: {
    display: "inline-block",
    padding: "4px 10px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  reorderPill: {
    display: "inline-block",
    marginTop: "4px",
    marginRight: "6px",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: 700,
    background: "#dbeafe",
    color: "#1d4ed8",
  },
  expiringPill: {
    display: "inline-block",
    marginTop: "4px",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: 700,
    background: "#fef3c7",
    color: "#92400e",
  },
  expiredPill: {
    display: "inline-block",
    marginTop: "4px",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: 700,
    background: "#fee2e2",
    color: "#991b1b",
  },
  inspectorHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "8px",
    paddingBottom: "12px",
    borderBottom: "1px solid #e2e8f0",
  },
  simBox: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: "8px",
    padding: "12px",
    marginTop: "12px",
  },
  simStats: { fontSize: "13px", display: "flex", flexDirection: "column", gap: "4px" },
  subBlock: { marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #f1f5f9" },
  fieldLabel: { fontSize: "12px", color: "#475569", display: "flex", flexDirection: "column", gap: "4px" },
  toastBox: {
    background: "#ecfdf5",
    color: "#065f46",
    border: "1px solid #a7f3d0",
    padding: "10px 14px",
    borderRadius: "8px",
    marginBottom: "14px",
    fontSize: "14px",
    fontWeight: 600,
  },
  errorBox: {
    background: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
    padding: "12px 14px",
    borderRadius: "8px",
    marginBottom: "18px",
    fontSize: "14px",
  },
  muted: { color: "#64748b", fontSize: "14px" },
};