import { useEffect, useRef, useState } from "react";
import "./stockradar.css";
import Predictions from "./Predictions";
import { translator, errorMessage } from "./translations";

const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

const INITIAL_FORM = {
  name: "",
  stock_qty: "",
  unit_cost: "",
  selling_price: "",
  expiry_date: "",
};

export default function App() {
  const [lang, setLang] = useState(() => localStorage.getItem("sr-language") === "sw" ? "sw" : "en");
  useEffect(() => { localStorage.setItem("sr-language", lang); }, [lang]);
  const t = translator(lang);
  const labels = {Overview:t("Home"), "Inventory Workspace":t("My Stock"), "Predictive Intelligence":t("Reports"), Details:t("Details"), Recovery:t("Offers"), Basket:t("Basket"), All:t("All"), "Dead-Stock Risk":t("Not selling / at risk"), "Slowing Down":t("Selling slowly"), Healthy:t("Selling normally"), "Reorder Soon":t("Buy more soon"), "Expiring Soon":t("Expiring soon")};
  const [quickSale, setQuickSale] = useState(false);
  const inspectorRef = useRef(null);
  const [inspectorRequest, setInspectorRequest] = useState(0);
  const handledInspectorRequest = useRef(0);
  const [quickCheckout, setQuickCheckout] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [page, setPage] = useState("Overview");
  useEffect(() => { document.title = `StockRadar | ${t("My Stock")}`; document.documentElement.lang = lang; }, [lang]);
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("risk");
  const currency = "TSh";
  const [discount, setDiscount] = useState(0);
  const [recoveryDays, setRecoveryDays] = useState(7);
  const [panel, setPanel] = useState("Details");
  const [showAdd, setShowAdd] = useState(false);

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

      setSelectedItem(prev => prev ? freshItems.find(i => i.id === prev.id) || null : null);

      setBasket((prev) => {
        const next = {};
        for (const [id, qty] of Object.entries(prev)) {
          const match = freshItems.find((i) => i.id === id);
          if (match && !match.is_expired && match.stock_qty > 0) {
            next[id] = Math.min(qty, match.stock_qty);
          }
        }
        return next;
      });
    } catch (err) {
      setError(
        t("Cannot connect to the server. Try again.")
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRadar();
  }, []);

  useEffect(() => {
    if (inspectorRequest === handledInspectorRequest.current || page !== "Inventory Workspace" || quickSale) return;
    const frame = requestAnimationFrame(() => {
      const target = inspectorRef.current;
      if (!target) return;
      handledInspectorRequest.current = inspectorRequest;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ behavior: reduced ? "instant" : "smooth", block: "start", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [inspectorRequest, page, quickSale]);

  const openInspector = (item) => {
    if (submitting) return;
    setInspectorRequest(n => n + 1);
    setSelectedItem(item);
    setPanel(prev => prev === "Recovery" ? "Recovery" : "Details");
    setDiscount(0);
    setRestockInput(10);
    setIsEditing(false);
    setEditName(item.name);
    setEditCost(item.unit_cost);
    setEditSellingPrice(item.base_price ?? item.selling_price ?? item.unit_cost);
    setEditExpiry(item.expiry_date || "");
  };

  const addToBasket = (item, qtyToAdd = 1) => {
    if (item.is_expired) return;
    setPanel("Basket");
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
            expected_price: l.unitPrice,
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
      setQuickCheckout(false);
      showNotice(
        t(`Sale recorded: ${data.total_units} items · Total ${formatMoney(data.total_paid)}`,`Mauzo yamerekodiwa: bidhaa ${data.total_units} · Jumla ${formatMoney(data.total_paid)}`)
      );
      await fetchRadar();
    } catch (err) {
      setError(t("Could not complete customer sale") + ": " + errorMessage(lang, err.message));
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
        t(`Undid basket sale (${lastBasketBatch.totalUnits} items · ${formatMoney(lastBasketBatch.totalPaid)})`,`Mauzo yametenguliwa (bidhaa ${lastBasketBatch.totalUnits} · ${formatMoney(lastBasketBatch.totalPaid)})`)
      );
      setLastBasketBatch(null);
      await fetchRadar();
    } catch (err) {
      setError(t("Failed to undo basket sale") + ": " + errorMessage(lang, err.message));
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
      setShowAdd(false);
      showNotice(t(`Added "${payload.name}"`,`Bidhaa "${payload.name}" imeongezwa`));
      await fetchRadar();
    } catch (err) {
      setError(t("Failed to save item") + ": " + errorMessage(lang, err.message));
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
        t(`Sold 1 × ${data.item.name} (${formatMoney(unitCharge)}) · ${data.item.stock_qty} left`,`Imeuzwa 1 × ${data.item.name} (${formatMoney(unitCharge)}) · zimebaki ${data.item.stock_qty}`)
      );
      await fetchRadar();
    } catch (err) {
      setError(t("Sale did not save") + ": " + errorMessage(lang, err.message));
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
      showNotice(t(`Undid last sale on ${data.item.name}`,`Mauzo ya mwisho ya ${data.item.name} yametenguliwa`));
      await fetchRadar();
    } catch (err) {
      setError(t("Failed to undo last sale") + ": " + errorMessage(lang, err.message));
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
      showNotice(t(`Added ${added} units to ${data.item.name}`,`Bidhaa ${added} za ${data.item.name} zimeongezwa`));
      await fetchRadar();
    } catch (err) {
      setError(t("Failed to restock item") + ": " + errorMessage(lang, err.message));
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
      showNotice(t("Item details updated"));
      await fetchRadar();
    } catch (err) {
      setError(t("Failed to update item") + ": " + errorMessage(lang, err.message));
    } finally {
      setSubmitting(false);
    }
  };

  const recoveryPrice = selectedItem ? Math.ceil(Number(selectedItem.selling_price) * (1-discount/100) * 100 - 1e-8)/100 : 0;
  const safeDiscount = selectedItem && selectedItem.selling_price > 0 ? Math.max(0, Math.min(100, Math.floor((1-selectedItem.unit_cost/selectedItem.selling_price)*100))) : 0;
  const canApplyRecovery = selectedItem && !selectedItem.is_expired && selectedItem.stock_qty > 0 && discount > 0 && recoveryPrice > 0 && recoveryPrice >= selectedItem.unit_cost && recoveryPrice < selectedItem.selling_price;

  const activeCampaign = selectedItem?.recovery_campaigns?.find(c => c.active);
  const saveRecoveryPrice = async (restore = false) => {
    if (!selectedItem || submitting || (!restore && (!canApplyRecovery || activeCampaign))) return;
    if (!window.confirm(restore ? t("End this campaign and restore the base price?") : t(`Start a recovery campaign for up to ${recoveryDays} days (limited by expiry)?`,`Anza ofa ya hadi siku ${recoveryDays}, bila kuvuka tarehe ya mwisho wa matumizi?`))) return;
    setSubmitting(true); setError("");
    try {
      const res = await fetch(`${API_BASE}/api/items/${selectedItem.id}/recovery${restore ? "/end" : ""}`, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: restore ? undefined : JSON.stringify({discount, days: Number(recoveryDays)})
      });
      if (!res.ok) { const data = await res.json(); throw new Error(data.detail || `Error ${res.status}`); }
      setDiscount(0); setIsEditing(false);
      showNotice(restore ? t("Campaign ended") : t("Campaign started"));
      await fetchRadar();
    } catch(err) { setError(errorMessage(lang, err.message)); } finally { setSubmitting(false); }
  };

  const handleDeleteItem = async () => {
    if (!selectedItem?.id) return;
    if (!window.confirm(t(`Remove "${selectedItem.name}" from inventory?`,`Futa "${selectedItem.name}" kwenye orodha ya bidhaa?`))) return;
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
      showNotice(t(`Deleted "${selectedItem.name}"`,`Bidhaa "${selectedItem.name}" imefutwa`));
      setSelectedItem(null);
      await fetchRadar();
    } catch (err) {
      setError(t("Failed to delete item") + ": " + errorMessage(lang, err.message));
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
        !`${item.name} ${item.sku || ""}`.toLowerCase().includes(searchQuery.trim().toLowerCase())
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

  const navigate = (next) => { setQuickSale(false); setQuickCheckout(false); setPage(next); setFilter("All"); setSearchQuery(""); if (window.matchMedia("(max-width: 760px)").matches) window.scrollTo(0, 0); };
  const nav = [["Overview","M3 10l9-7 9 7v11h-6v-7H9v7H3z"],["Inventory Workspace","M3 7l9-4 9 4v13H3z M3 7l9 4 9-4 M12 11v9"],["Predictive Intelligence","M4 20V4 M4 20h16 M8 16v-5 M13 16V7 M18 16v-8"]];
  const priority = [...items].filter(i => i.stock_qty > 0 && i.status !== "Healthy").sort((a,b) => (b.risk_score || 0)-(a.risk_score || 0) || b.tied_up_value-a.tied_up_value);
  const bestSellers = items.filter(i=>i.units_sold_today>0).sort((a,b)=>b.units_sold_today-a.units_sold_today).slice(0,3);
  const attention = items.filter(i=>i.stock_qty>0&&(i.is_expired||i.expiring_soon||i.reorder_soon||i.status!=="Healthy")).sort((a,b)=>Number(b.is_expired)-Number(a.is_expired)||(b.risk_score||0)-(a.risk_score||0));
  const duplicateNames = new Set(items.filter((item,index)=>items.some((other,j)=>j!==index && other.name.trim().toLowerCase()===item.name.trim().toLowerCase())).map(item=>item.name.trim().toLowerCase()));
  const productName = item => duplicateNames.has(item.name.trim().toLowerCase()) && item.sku ? `${item.name} (${item.sku})` : item.name;
  const urgent = attention.find(i=>i.is_expired) || [...attention].filter(i=>i.expiring_soon).sort((a,b)=>a.days_to_expiry-b.days_to_expiry)[0] || attention.find(i=>i.reorder_soon) || attention[0];
  const tip = !summary ? null : urgent ? urgent.is_expired ? t(`${productName(urgent)} has expired. Remove it from sale.`,`${productName(urgent)} imeisha muda wake. Usiiuze.`) : urgent.expiring_soon ? t(`${productName(urgent)}: ${urgent.stock_qty} left. Aim to sell ${Math.ceil(urgent.stock_qty/Math.max(1,urgent.days_to_expiry+1))} per day before the expiry date passes.`,`${productName(urgent)}: zimebaki ${urgent.stock_qty}. Lenga kuuza ${Math.ceil(urgent.stock_qty/Math.max(1,urgent.days_to_expiry+1))} kila siku kabla muda wake haujaisha.`) : urgent.reorder_soon ? t(`Check ${productName(urgent)} before your next stock purchase.`,`Angalia ${productName(urgent)} kabla ya kununua bidhaa tena.`) : t(`${productName(urgent)} is selling slowly. Consider a special offer.`,`${productName(urgent)} inauzika polepole. Fikiria kuweka ofa.`) : t("Keep recording every sale so you can see how your shop is doing.");
  const capital = Number(summary?.total_tied_up_value || 0);
  const atRisk = Number(summary?.at_risk_capital || 0);
  const riskPct = capital > 0 ? Math.min(100, Math.max(0, atRisk/capital*100)) : 0;
  return (
    <div className="sr-shell">
      <aside className="sr-sidebar">
        <div className="sr-brand"><span className="sr-logo">◎</span><div>Stock<span>Radar</span><small>{t("INVENTORY INTELLIGENCE")}</small></div></div>
        <div className="sr-nav-label">{t("MY SHOP")}</div>
        <nav aria-label={t("Main navigation")}>{nav.map(([name,icon]) => <button key={name} aria-current={page===name ? "page" : undefined} className={page===name ? "active" : ""} onClick={()=>navigate(name)}><span aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={icon}/></svg></span><span className="sr-nav-text">{labels[name]}</span>{name==="Inventory Workspace" && basketTotalUnits>0 && <b>{basketTotalUnits}</b>}</button>)}</nav>
        <div className="sr-sidebar-foot">StockRadar v1.0<br/><small>{t("Independent portfolio project")}</small></div>
      </aside>
      <main className="sr-main">
      <header className="sr-header"><div><h1>{labels[page]}</h1></div><div className="sr-header-actions"><select aria-label="Language / Lugha" value={lang} onChange={e=>setLang(e.target.value)}><option value="en">English</option><option value="sw">Kiswahili</option></select><button onClick={fetchRadar} disabled={loading} style={styles.primaryBtn}>{loading?t("Loading…"):t("Refresh")}</button></div></header>
      {page === "Predictive Intelligence" && <><section className="sr-panel"><h2>{t("Shop report today")}</h2>{summary && <div className="sr-simple-kpis"><KpiCard label={t("Sales today")} value={formatMoney(summary.cash_collected_today)}/><KpiCard label={t("Gross profit today")} value={formatMoney(summary.profit_today)}/><KpiCard label={t("Units sold today")} value={summary.units_sold_today}/><KpiCard label={t("Money in stock")} value={formatMoney(capital)}/></div>}<p>{t("Gross profit excludes shop expenses.")}</p><button style={styles.secondaryBtn} onClick={()=>setAdvanced(v=>!v)}>{advanced?t("Hide detailed forecasts"):t("Show detailed forecasts")}</button></section>{advanced && <Predictions api={API_BASE} refresh={loading} money={formatMoney} lang={lang}/>}</>}
      {toast && <div style={styles.toastBox}>{toast}</div>}
      {error && <div style={styles.errorBox}>{error}</div>}

      {page === "Overview" && <div className="sr-mobile-home">
        <section className="sr-home-welcome"><h2>{t("Welcome to your shop!")}</h2><p>{t("Here is how your shop is doing today.")}</p></section>
        {summary && <div className="sr-home-kpis">{[
          ["↗",t("Sales today"),formatMoney(summary.cash_collected_today)],
          ["+",t("Gross profit today"),formatMoney(summary.profit_today)],
          ["✓",t("Units sold today"),summary.units_sold_today ?? 0],
          ["▦",t("Products in stock"),items.filter(i=>i.stock_qty>0).length]
        ].map(([icon,label,value],index)=><div className={`sr-home-stat tone-${index}`} key={label}><span aria-hidden="true">{icon}</span><small>{label}</small><strong>{value}</strong></div>)}</div>}
        <div className="sr-quick-actions sr-home-actions"><button onClick={()=>{navigate("Inventory Workspace");setQuickSale(true);setQuickCheckout(false);setPanel("Basket");setShowAdd(false)}}>{t("Record a sale")}</button><button onClick={()=>{navigate("Inventory Workspace");setShowAdd(true)}}>{t("Add a product")}</button></div>
        {tip && <section className="sr-daily-tip" data-tone={urgent?.is_expired?"danger":urgent?.expiring_soon?"warning":"normal"}><div><h2>{t("Today's business tip")}</h2><p>{tip}</p></div>{urgent && <button style={styles.secondaryBtn} onClick={()=>{navigate("Inventory Workspace");openInspector(urgent);setShowAdd(false);setPanel(urgent.is_expired||urgent.reorder_soon?"Details":"Recovery")}}>{t("View product")}</button>}</section>}
        <div className="sr-home-columns">
          <section className="sr-panel"><h2>{t("Best sellers today")}</h2><p>{t("Ranked by units sold today.")}</p>
          {!summary ? <p>{t("Sales data unavailable.")}</p> : bestSellers.length===0 ? <p>{t("No sales recorded today yet.")}</p> : bestSellers.map(i=><div className="sr-home-seller" key={i.id}><div><strong>{productName(i)}</strong><span>{i.units_sold_today} {t("sold")}</span></div><progress max={bestSellers[0].units_sold_today} value={i.units_sold_today} aria-label={`${i.name}: ${i.units_sold_today}`}/></div>)}
          {summary && <div className="sr-home-note">{summary.cash_collected_today>0?t(`For every TSh 1,000 sold today, your gross profit was about ${formatMoney(Math.round(1000*summary.profit_today/summary.cash_collected_today))}, before shop expenses.`,`Kwa kila TSh 1,000 ya mauzo leo, faida ghafi ilikuwa takriban ${formatMoney(Math.round(1000*summary.profit_today/summary.cash_collected_today))}, kabla ya gharama za duka.`):t("Record a sale to see today's profit margin.")}</div>}
          </section>
          <section className="sr-panel"><h2>{t("Stock at a glance")}</h2><p>{t("What to check before buying more.")}</p>{[
            [t("Expiring soon or expired"),items.filter(i=>i.stock_qty>0&&(i.expiring_soon||i.is_expired)).length,"Expiring Soon"],
            [t("Buy more soon"),items.filter(i=>i.reorder_soon&&!i.is_expired).length,"Reorder Soon"],
            [t("Selling slowly or at risk"),priority.length,"All"],
            [t("Active special offers"),items.filter(i=>i.recovery_campaigns?.some(c=>c.active)).length,"All"]
          ].map(([label,count,target])=><button className="sr-home-alert" data-tone={count>0&&target==="Expiring Soon"?"warning":count>0&&target==="Reorder Soon"?"warning":"normal"} key={label} onClick={()=>{navigate("Inventory Workspace");setFilter(target);setPanel("Details");setShowAdd(false)}}><span>{label}</span><strong>{count} ›</strong></button>)}<div className="sr-home-note">{t("Money in stock")}: <strong>{summary?formatMoney(capital):"—"}</strong></div></section>
        </div>
        <section className="sr-panel"><h2>{t("Needs your attention")}</h2>{attention.length===0 && <p>{summary?t("Nothing urgent to review right now."):t("Stock data unavailable.")}</p>}{attention.slice(0,8).map(i=><div className="sr-recommendation sr-attention" data-tone={i.is_expired?"danger":i.expiring_soon?"warning":"normal"} key={i.id}><div><strong>{productName(i)}</strong><p>{i.is_expired?t("Expired — do not sell"):i.expiring_soon?(i.days_to_expiry===0?t("Expires today"):t(`Expires in ${i.days_to_expiry} days`,`Muda unaisha baada ya siku ${i.days_to_expiry}`)):i.reorder_soon?t("Check whether to buy more"):labels[i.status]} · {i.stock_qty} {t("left")}</p></div><button style={styles.secondaryBtn} onClick={()=>{openInspector(i);navigate("Inventory Workspace");setPanel(i.reorder_soon||i.is_expired?"Details":"Recovery")}}>{t("Review")}</button></div>)}</section>
      </div>}
      {page === "Inventory Workspace" && quickSale && <section className={`sr-quick-sale${basketLines.length ? " sr-has-basket" : ""}`}>
        <div className="sr-quick-heading"><h2>{t("Record a sale")}</h2><button style={styles.secondaryBtn} onClick={()=>{setQuickSale(false);setPanel("Details")}}>{t("Back to stock")}</button></div>
        {!quickCheckout ? <><label className="sr-field">{t("Find a product")}<input style={styles.input} value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder={t("Product name or code")}/></label>
        <div className="sr-quick-list">{items.filter(i=>!i.is_expired&&i.stock_qty>0&&`${i.name} ${i.sku||""}`.toLowerCase().includes(searchQuery.toLowerCase().trim())).sort((a,b)=>a.name.localeCompare(b.name)).map(i=><article key={i.id} className="sr-quick-product"><div><strong>{productName(i)}</strong><small>{i.stock_qty} {t("left")}</small><b>{formatMoney(i.selling_price)}</b></div><div className="sr-quick-qty">{basket[i.id]>0?<><button disabled={submitting} aria-label={t("Remove one")} onClick={()=>updateBasketQty(i.id,basket[i.id]-1,i.stock_qty)}>−</button><strong>{basket[i.id]}</strong><button disabled={submitting||basket[i.id]>=i.stock_qty} aria-label={t("Add one")} onClick={()=>addToBasket(i)}>+</button></>:<button disabled={submitting} onClick={()=>addToBasket(i)}>{t("+ Add")}</button>}</div></article>)}</div>
        {items.filter(i=>!i.is_expired&&i.stock_qty>0&&`${i.name} ${i.sku||""}`.toLowerCase().includes(searchQuery.toLowerCase().trim())).length===0&&<p>{t("No available products found.")}</p>}</>:<><button style={styles.secondaryBtn} onClick={()=>setQuickCheckout(false)}>{t("← Add more products")}</button><h3>{t("Customer basket")}</h3>{basketLines.map(({item,qty,lineTotal})=><article key={item.id} className="sr-quick-product"><div><strong>{productName(item)}</strong><small>{formatMoney(lineTotal)}</small>{item.is_expired&&<small>{t("Expired — remove from basket")}</small>}</div><div className="sr-quick-qty"><button disabled={submitting} aria-label={t("Remove one")} onClick={()=>updateBasketQty(item.id,qty-1,item.stock_qty)}>−</button><strong>{qty}</strong><button disabled={submitting||item.is_expired||qty>=item.stock_qty} aria-label={t("Add one")} onClick={()=>addToBasket(item)}>+</button></div></article>)}{!basketLines.length&&<p>{t("Basket is empty.")}</p>}</>}
        {lastBasketBatch&&<button style={styles.secondaryBtn} disabled={submitting} onClick={handleUndoBasketSale}>{t("Undo last sale")}</button>}
        {basketLines.length > 0 && <div className="sr-quick-dock"><div><span>{basketTotalUnits} {t("items")}</span><strong>{formatMoney(basketTotalMoney)}</strong></div>{quickCheckout?<button disabled={submitting||!basketLines.length||basketLines.some(l=>l.item.is_expired)} onClick={handleCompleteBasketSale}>{submitting?t("Recording…"):t("Complete sale")}</button>:<button disabled={!basketLines.length||submitting} onClick={()=>{setQuickCheckout(true);window.scrollTo(0,0)}}>{t("View basket")}</button>}</div>}
      </section>}
      {page === "Inventory Workspace" && !quickSale && <div className="sr-workspace-toolbar"><button style={styles.primaryBtn} aria-expanded={showAdd} onClick={()=>setShowAdd(v=>!v)}>{showAdd ? t("Close form") : t("+ Add product")}</button><button style={styles.secondaryBtn} onClick={()=>setPanel("Basket")}>{t("Basket")} · {basketTotalUnits}</button></div>}
      {page === "Inventory Workspace" && !quickSale && showAdd && (
      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>{t("Add a product")}</h2>
        <form onSubmit={handleAddItem} style={styles.formGrid} className="sr-add-form">
          <label className="sr-field"><span>{t("Product name")}</span><input
            name="name"
            value={form.name}
            onChange={handleChange}
            required
            style={styles.input}
          /></label>
          <label className="sr-field"><span>{t("Quantity in stock")}</span><input
            name="stock_qty" inputMode="numeric"
            type="number"
            min="0"
            value={form.stock_qty}
            onChange={handleChange}
            required
            style={styles.input}
          /></label>
          <label className="sr-field"><span>{t("Buying price per item (TSh)")}</span><input
            name="unit_cost" inputMode="decimal"
            type="number"
            step="0.01"
            min="0"
            value={form.unit_cost}
            onChange={handleChange}
            required
            style={styles.input}
          /></label>
          <label className="sr-field"><span>{t("Selling price per item (TSh)")}</span><input
            name="selling_price" inputMode="decimal"
            type="number"
            step="0.01"
            min="0"
            value={form.selling_price}
            onChange={handleChange}
            required
            style={styles.input}
          /></label>
          <label style={styles.dateFieldWrap}>
            <span style={styles.dateHint}>{t("Expiry date (optional)")}</span>
            <input
              name="expiry_date"
              type="date"
              value={form.expiry_date}
              onChange={handleChange}
              style={styles.input}
            />
          </label>
          <button type="submit" disabled={submitting} style={styles.primaryBtn}>
            {submitting ? t("Saving…") : t("Add product")}
          </button>
        </form>
      </section>

      )}
      {page === "Inventory Workspace" && !quickSale && <div className="sr-workspace" style={styles.mainSplit}>
        <section style={{ ...styles.card, flex: 2, minWidth: 0 }}>
          <div style={styles.tableHeader}>
            <h2 style={{ ...styles.sectionTitle, margin: 0 }}>
              {t("Products")}
            </h2>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="search"
                placeholder={t("Search item name...")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ ...styles.input, padding: "6px 10px", minWidth: "170px" }}
              />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{ ...styles.input, padding: "6px 10px" }}
              >
                <option value="risk">{t("Needs attention first")}</option>
                <option value="cash">{t("Sort: Most Cash Tied Up")}</option>
                <option value="low_stock">{t("Sort: Lowest Stock Left")}</option>
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
                key={labels[tab]}
                onClick={() => setFilter(tab)}
                style={{
                  ...styles.filterBtn,
                  background: filter === tab ? "#0f172a" : "#f1f5f9",
                  color: filter === tab ? "#ffffff" : "#334155",
                }}
              >
                {labels[tab]}
              </button>
            ))}
          </div>

          {loading ? (
            <p style={styles.muted}>{t("Scanning inventory from Firestore...")}</p>
          ) : visibleItems.length === 0 ? (
            <p style={styles.muted}>
              {t("No matching items found. Add a product or adjust your search/filter.")}
            </p>
          ) : (
            <div className="sr-product-list">{visibleItems.map(item=><article key={item.id} className="sr-product" data-selected={selectedItem?.id===item.id}><button className="sr-item-link" onClick={()=>{openInspector(item);setPanel("Details")}}>{productName(item)}</button><strong>{formatMoney(item.selling_price)}</strong><small>{item.stock_qty} {t("left")} · {item.is_expired?t("Expired"):item.expiring_soon?t("Expiring soon"):labels[item.status]}</small><button style={styles.basketAddBtn} disabled={item.is_expired||item.stock_qty<=0||(basket[item.id]||0)>=item.stock_qty} onClick={()=>addToBasket(item)}>{t("+ Add")}{basket[item.id]?` (${basket[item.id]})`:""}</button></article>)}</div>
          )}
        </section>

        {/* Right Side: Customer Basket + Streamlined Selected-Item Panel */}
        <aside ref={inspectorRef} className="sr-inspector" style={{ flex: 1, minWidth: 0, scrollMarginTop: 12 }}> 
          <div className="sr-action-tabs" role="group" aria-label={t("Workspace actions")}>{["Details","Recovery","Basket"].map(t=><button key={t} aria-pressed={panel===t} onClick={()=>setPanel(t)}>{labels[t]}{t==="Basket" ? ` (${basketTotalUnits})` : ""}</button>)}</div>
          {panel === "Basket" && (
          <div style={{ ...styles.card, border: "2px solid #0f172a" }}>
            <div style={styles.basketHeader}>
              <h2 style={{ ...styles.sectionTitle, margin: 0 }}>{t("Customer basket")}</h2>
              {basketLines.length > 0 && (
                <button type="button" onClick={clearBasket} style={styles.clearLink}>
                  {t("Clear")}
                </button>
              )}
            </div>

            {basketLines.length === 0 ? (
              <p style={styles.muted}>
                {t("Tap + Add to select products, adjust quantities and check the total before recording the sale.")}
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
                          disabled={item.is_expired || qty >= item.stock_qty}
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
                    <span>{t("Total items:")}</span>
                    <strong>{basketTotalUnits} {t("units")}</strong>
                  </div>
                  <div style={{ ...styles.totalRow, fontSize: "18px", marginTop: "6px" }}>
                    <span>{t("Total to Pay:")}</span>
                    <strong style={{ color: "#15803d" }}>
                      {formatMoney(basketTotalMoney)}
                    </strong>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCompleteBasketSale}
                  disabled={submitting || basketLines.some(l=>l.item.is_expired)}
                  style={styles.counterTapBtn}
                >
                  {submitting
                    ? t("Recording...")
                    : t(`Complete Sale (${formatMoney(basketTotalMoney)})`,`Kamilisha mauzo (${formatMoney(basketTotalMoney)})`)}
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
                {t("Undo last sale")} ({formatMoney(lastBasketBatch.totalPaid)})
              </button>
            )}
          </div>

          )}
          {panel !== "Basket" && <div style={styles.card}>
            <h2 style={styles.sectionTitle}>{panel === "Recovery" ? t("Special offers") : t("Product details")}</h2>
            {!selectedItem ? (
              <p style={styles.muted}>
                {t("Select a product from the inventory table to view its details or simulate recovery.")}
              </p>
            ) : (
              <div>
                <div style={styles.inspectorHeader}>
                  <div>
                    <strong>{selectedItem.name}</strong>
                    <div style={styles.skuText}>
                      <strong>{selectedItem.stock_qty} {t("left")}</strong> · {t("Sell:")}{" "}
                      <strong>{formatMoney(selectedItem.selling_price)}</strong> · {t("Cost:")}{" "}
                      {formatMoney(selectedItem.unit_cost)}
                    </div>
                  </div>
                  <span style={{ ...styles.badge, ...badgeStyle(selectedItem.status) }}>
                    {labels[selectedItem.status]}
                  </span>
                </div>

                {panel === "Recovery" && selectedItem.is_expired && <p style={styles.muted}>{t("Expired stock cannot be sold. Review disposal options.")}</p>}
                {panel === "Recovery" && !selectedItem.is_expired && !activeCampaign && <div style={styles.simBox}>
                  <strong>{t("Set a discount")}</strong>
                  <p>{t("Discount:")} {discount}%</p>
                  <input aria-label={t("Discount percentage")} type="range" min="0" max={safeDiscount} disabled={submitting || safeDiscount === 0 || selectedItem.stock_qty <= 0} value={discount} onChange={e => setDiscount(Number(e.target.value))} style={{width:"100%"}} />
                  <div>{t("New unit price:")} {formatMoney(recoveryPrice)}</div>
                  <div>{t("Potential revenue:")} {formatMoney(selectedItem.stock_qty * recoveryPrice)}</div>
                  <div>{t("Gross profit:")} {formatMoney(selectedItem.stock_qty * (recoveryPrice-selectedItem.unit_cost))}</div>
                  <div>{t("Maximum whole-percent break-even discount:")} {safeDiscount}%</div>
                  <small>{t("Estimates assume all units sell; excludes operating expenses. Applying changes the live selling price, not historical sales.")}</small>
                  <p>{t("Suggested starting discount:")} {Math.min(safeDiscount, selectedItem.risk_score >= 70 ? 20 : selectedItem.risk_score >= 40 ? 10 : 5)}% (rule-based, not a demand prediction).</p>
                  <label>{t("Maximum duration")} <select value={recoveryDays} onChange={e=>setRecoveryDays(Number(e.target.value))}>{[1,3,7,14,30].map(d=><option key={d} value={d}>{d} {t("days")}</option>)}</select></label>
                  <p><small>{t("Campaigns end no later than the end of the expiry date (EAT).")}</small></p>
                  <button type="button" style={styles.counterTapBtn} disabled={submitting || loading || !canApplyRecovery} onClick={()=>saveRecoveryPrice()}>{t("Start offer")}</button>
                </div>}
                {panel === "Recovery" && activeCampaign && <div style={styles.simBox}>
                  <strong>{t("Active offer")}</strong>
                  <p>{formatMoney(activeCampaign.original_price)} → {formatMoney(activeCampaign.price)}</p>
                  <p>{t("Ends:")} {new Date(activeCampaign.effective_ends_at || activeCampaign.ends_at).toLocaleString("en-TZ", {timeZone:"Africa/Dar_es_Salaam"})} EAT</p>
                  <div className="sr-recovery-performance">
                    <strong>{t(activeCampaign.performance)}</strong>
                    <div className="sr-recovery-metrics">
                      <div><small>{t("Campaign sales/day")}</small><b>{activeCampaign.campaign_daily_sales ?? t("Pending")}</b></div>
                      <div><small>{t("Required sales/day")}</small><b>{activeCampaign.required_daily_sales ?? "—"}</b></div>
                      <div><small>{t("Money recovered")}</small><b>{formatMoney(activeCampaign.capital_recovered)}</b></div>
                      <div><small>{t("Current stock cost")}</small><b>{formatMoney(activeCampaign.remaining_capital)}</b></div>
                    </div>
                    {activeCampaign.campaign_daily_sales != null && activeCampaign.required_daily_sales > 0 && <progress aria-label={t("Clearance pace versus target")} max={100} value={Math.min(100,100*activeCampaign.campaign_daily_sales/activeCampaign.required_daily_sales)}/>}
                    <small>{t("The daily target uses remaining stock and time. Check offer progress after 24 hours.")}</small>
                  </div>
                  <button style={styles.secondaryBtn} disabled={submitting || loading} onClick={()=>saveRecoveryPrice(true)}>{t("End offer")}</button>
                </div>}
                {panel === "Recovery" && <div style={styles.simBox}><strong>{t("Special offer history")}</strong>
                  {!(selectedItem.recovery_campaigns || []).length && <p>{t("No campaigns yet.")}</p>}
                  {(selectedItem.recovery_campaigns || []).map(c=><div key={c.id} className="sr-campaign"><strong>{c.discount}% {t("off")} · {c.active ? t("Active") : t("Ended")}</strong><small>{new Date(c.started_at).toLocaleDateString("en-TZ", {timeZone:"Africa/Dar_es_Salaam"})}</small><div>{t("Units sold:")} {c.units}</div><div>{t("Revenue:")} {formatMoney(c.revenue)}</div><div>{t("Inventory cost recovered:")} {formatMoney(c.capital_recovered)}</div><div>{t("Gross profit:")} {formatMoney(c.gross_profit)}</div></div>)}
                </div>}
                <div style={styles.simBox}>
                  <div style={styles.simStats}>
                    <div>
                      {t("Profit per unit:")} <strong>{formatMoney(selectedItem.unit_profit)}</strong>
                    </div>
                    {!activeCampaign && <div>
                      {t("Safe max discount:")}{" "}
                      <strong>{selectedItem.max_safe_discount_pct}% {t("off")}</strong> ({t("minimum price")}{" "}
                      {formatMoney(selectedItem.unit_cost)})
                    </div>}
                    {selectedItem.expiry_date && (
                      <div>
                        {t("Expiry:")} <strong>{selectedItem.expiry_date}</strong> (
                        {selectedItem.days_to_expiry < 0
                          ? t("Expired")
                          : t(`${selectedItem.days_to_expiry} days left`,`Zimebaki siku ${selectedItem.days_to_expiry}`)}
                        )
                      </div>
                    )}
                    <div>
                      {t("Average sold per day (last 7 days):")}{" "}
                      <strong>
                        {selectedItem.recent_daily_sales}
                      </strong>
                    </div>
                  </div>
                </div>

                {panel === "Details" && <>
                <button
                  type="button"
                  onClick={handleSellOneUnit}
                  disabled={submitting || selectedItem.is_expired || selectedItem.stock_qty <= 0}
                  style={styles.counterTapBtn}
                >
                  {t("Sell one item")} ({formatMoney(selectedItem.selling_price)})
                </button>

                <button
                  type="button"
                  onClick={handleUndoSale}
                  disabled={submitting || !selectedItem.can_undo_sale}
                  style={{ ...styles.secondaryBtn, width: "100%", marginTop: "8px" }}
                >
                  {t("Undo Last Sale")}
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
                    <strong>{t("Restock Paused")} ({labels[selectedItem.status]})</strong>
                    <div style={{ marginTop: "4px" }}>
                      {t("Adding stock is locked until sales speed recovers or expired stock is cleared.")}
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleRestock} style={styles.subBlock}>
                    <label style={styles.fieldLabel}>
                      {t("Add New Stock (Restock)")}
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
                      {t("Add Stock")}
                    </button>
                  </form>
                )}

                <div style={styles.subBlock}>
                  {!isEditing ? (
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        type="button"
                        disabled={!!activeCampaign}
                         onClick={() => setIsEditing(true)}
                        style={{ ...styles.secondaryBtn, flex: 1 }}
                      >
                        {t("Edit Item")}
                      </button>
                      <button
                        type="button"
                        onClick={handleDeleteItem}
                        disabled={submitting}
                        style={styles.dangerBtn}
                      >
                        {t("Delete")}
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
                        placeholder={t("Item Name")}
                        required
                        style={styles.input}
                      />
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editCost}
                        onChange={(e) => setEditCost(e.target.value)}
                        placeholder={t(`Buying Cost (${currency})`,`Bei ya kununua (${currency})`)}
                        required
                        style={styles.input}
                      />
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editSellingPrice}
                        onChange={(e) => setEditSellingPrice(e.target.value)}
                        placeholder={t(`Selling Price (${currency})`,`Bei ya kuuza (${currency})`)}
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
                          {t("Save Changes")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsEditing(false)}
                          style={styles.secondaryBtn}
                        >
                          {t("Cancel")}
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
      <div className="sr-kpi-value" style={{ ...styles.kpiValue, color: accent }}>{value}</div>
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
  title: { margin: 0, fontSize: "32px", fontWeight: 800, color: "#2900BB" },
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
    background: "#005BC4",
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
    background: "#005BC4",
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