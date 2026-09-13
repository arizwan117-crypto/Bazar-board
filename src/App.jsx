import { useState, useMemo, useEffect } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  ReferenceLine,
} from "recharts";

/* ---------------------------------------------------------------
   THEME
----------------------------------------------------------------*/
const T = {
  bg: "#0E1620",
  panel: "#141F2B",
  panelAlt: "#182432",
  border: "#26333F",
  text: "#E7EBEF",
  textDim: "#8C9BAA",
  textFaint: "#5C6B79",
  gain: "#3FA789",
  loss: "#D9614F",
  gold: "#C6A445",
  golddim: "#8A742F",
};

const numFont = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace";
const uiFont =
  "'IBM Plex Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

/* ---------------------------------------------------------------
   DETERMINISTIC PRNG + SERIES GENERATION (simulated market data)
----------------------------------------------------------------*/
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function genSeries(symbol, base, vol, days) {
  const rand = hashSeed(symbol);
  let price = base;
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const drift = (rand() - 0.5) * 2 * vol;
    price = Math.max(price * (1 + drift), base * 0.3);
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push({
      t: i,
      date: d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
      price: Math.round(price * 100) / 100,
    });
  }
  return out;
}

function genIntradaySeries(symbol, base, vol) {
  const rand = hashSeed(symbol + "-intraday-" + new Date().toDateString());
  let price = base * (0.997 + rand() * 0.006); // small gap from prev close
  const out = [];
  const startMin = 9 * 60 + 15; // 09:15
  for (let m = 0; m <= 375; m++) {
    const drift = (rand() - 0.5) * 2 * (vol / 6);
    price = Math.max(price * (1 + drift), base * 0.9);
    const totalMin = startMin + m;
    const hh = String(Math.floor(totalMin / 60)).padStart(2, "0");
    const mm = String(totalMin % 60).padStart(2, "0");
    out.push({ t: m, date: `${hh}:${mm}`, price: Math.round(price * 100) / 100 });
  }
  return out;
}

function atr(series, period = 14) {
  const diffs = [];
  for (let i = 1; i < series.length; i++) diffs.push(Math.abs(series[i].price - series[i - 1].price));
  const slice = diffs.slice(-period);
  return slice.reduce((s, d) => s + d, 0) / (slice.length || 1);
}

function sma(series, period) {
  return series.map((pt, idx) => {
    if (idx < period - 1) return { ...pt, [`sma${period}`]: null };
    const slice = series.slice(idx - period + 1, idx + 1);
    const avg = slice.reduce((s, p) => s + p.price, 0) / period;
    return { ...pt, [`sma${period}`]: Math.round(avg * 100) / 100 };
  });
}

function mergeSMAs(series, periods) {
  let out = series.map((p) => ({ ...p }));
  periods.forEach((p) => {
    const withSma = sma(series, p);
    out = out.map((row, i) => ({ ...row, [`sma${p}`]: withSma[i][`sma${p}`] }));
  });
  return out;
}

function rsi(series, period = 14) {
  const out = series.map((p) => ({ ...p, rsi: null }));
  let gains = 0,
    losses = 0;
  for (let i = 1; i < series.length; i++) {
    const diff = series[i].price - series[i - 1].price;
    if (i <= period) {
      if (diff >= 0) gains += diff;
      else losses -= diff;
      if (i === period) {
        const rs = gains / (losses || 1e-9);
        out[i].rsi = 100 - 100 / (1 + rs);
      }
      continue;
    }
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    gains = (gains * (period - 1) + gain) / period;
    losses = (losses * (period - 1) + loss) / period;
    const rs = gains / (losses || 1e-9);
    out[i].rsi = Math.round((100 - 100 / (1 + rs)) * 10) / 10;
  }
  return out;
}

function maxDrawdown(equity) {
  let peak = -Infinity,
    maxDd = 0;
  equity.forEach((v) => {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDd) maxDd = dd;
  });
  return maxDd * 100;
}

/* ---------------------------------------------------------------
   INSTRUMENT UNIVERSE
----------------------------------------------------------------*/
const SYMBOLS = [
  { id: "NIFTY50", name: "Nifty 50", group: "Index", base: 24800, vol: 0.011 },
  { id: "SENSEX", name: "Sensex", group: "Index", base: 81200, vol: 0.011 },
  { id: "BANKNIFTY", name: "Nifty Bank", group: "Index", base: 51600, vol: 0.013 },
  { id: "GOLD", name: "Gold (MCX, 10g)", group: "Commodity", base: 74300, vol: 0.009 },
  { id: "SILVER", name: "Silver (MCX, 1kg)", group: "Commodity", base: 91500, vol: 0.015 },
  { id: "CRUDE", name: "Crude Oil (MCX)", group: "Commodity", base: 5850, vol: 0.02 },
  { id: "RELIANCE", name: "Reliance Industries", group: "Stock", base: 2940, vol: 0.017 },
  { id: "TCS", name: "TCS", group: "Stock", base: 4120, vol: 0.014 },
  { id: "HDFCBANK", name: "HDFC Bank", group: "Stock", base: 1720, vol: 0.015 },
  { id: "INFY", name: "Infosys", group: "Stock", base: 1890, vol: 0.017 },
  { id: "ICICIBANK", name: "ICICI Bank", group: "Stock", base: 1265, vol: 0.016 },
];

const NEWS = [
  { h: "RBI holds repo rate steady, cites balanced inflation outlook", tag: "neutral" },
  { h: "FIIs turn net buyers in Indian equities for second straight week", tag: "positive" },
  { h: "IT majors flag cautious client spending ahead of earnings season", tag: "negative" },
  { h: "Crude prices firm up on tighter OPEC+ supply signals", tag: "negative" },
  { h: "Rupee steadies against dollar as crude eases off highs", tag: "neutral" },
  { h: "Banking stocks rally on stronger-than-expected credit growth data", tag: "positive" },
  { h: "Government announces fresh capex push for infrastructure sector", tag: "positive" },
  { h: "Gold holds near record levels on safe-haven demand", tag: "neutral" },
  { h: "Auto sales data shows festive-season demand picking up", tag: "positive" },
  { h: "Global growth concerns weigh on metal and mining counters", tag: "negative" },
];

const TAG_COLOR = { positive: T.gain, negative: T.loss, neutral: T.gold };

/* ---------------------------------------------------------------
   SMALL PRESENTATION HELPERS
----------------------------------------------------------------*/
function fmt(n) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function Sparkline({ data, color }) {
  return (
    <ResponsiveContainer width="100%" height={40}>
      <LineChart data={data}>
        <Line type="monotone" dataKey="price" stroke={color} strokeWidth={1.6} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function Pill({ children, color }) {
  return (
    <span
      style={{
        fontFamily: numFont,
        fontSize: 12,
        padding: "2px 7px",
        borderRadius: 3,
        color,
        border: `1px solid ${color}55`,
        background: `${color}14`,
      }}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------
   DASHBOARD TAB
----------------------------------------------------------------*/
function Dashboard({ data }) {
  const groups = ["Index", "Commodity", "Stock"];
  return (
    <div>
      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 28 }}>
          <div
            style={{
              fontFamily: uiFont,
              fontSize: 13,
              color: T.textDim,
              marginBottom: 10,
              borderBottom: `1px solid ${T.border}`,
              paddingBottom: 8,
            }}
          >
            {g === "Index" ? "Indices" : g === "Commodity" ? "Commodities" : "Stocks"}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
              gap: 12,
            }}
          >
            {data
              .filter((d) => d.group === g)
              .map((d) => {
                const last = d.series[d.series.length - 1].price;
                const prev = d.series[d.series.length - 2].price;
                const chg = last - prev;
                const pct = (chg / prev) * 100;
                const up = chg >= 0;
                const color = up ? T.gain : T.loss;
                return (
                  <div
                    key={d.id}
                    style={{
                      background: T.panel,
                      border: `1px solid ${T.border}`,
                      borderLeft: `3px solid ${color}`,
                      borderRadius: 4,
                      padding: "12px 14px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <div style={{ fontFamily: uiFont, fontSize: 13, color: T.text }}>{d.name}</div>
                    </div>
                    <div
                      style={{
                        fontFamily: numFont,
                        fontSize: 22,
                        color: T.text,
                        marginTop: 6,
                      }}
                    >
                      {fmt(last)}
                    </div>
                    <div style={{ fontFamily: numFont, fontSize: 12.5, color, marginTop: 2 }}>
                      {up ? "+" : ""}
                      {fmt(chg)} ({up ? "+" : ""}
                      {pct.toFixed(2)}%)
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <Sparkline data={d.series.slice(-30)} color={color} />
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------
   TECHNICAL + ALERTS TAB
----------------------------------------------------------------*/
function TechnicalTab({ data, symbolId, setSymbolId, alerts, setAlerts }) {
  const inst = data.find((d) => d.id === symbolId);
  const withSma = useMemo(() => mergeSMAs(inst.series, [20, 50]), [inst]);
  const withRsi = useMemo(() => rsi(inst.series, 14), [inst]);
  const last = inst.series[inst.series.length - 1].price;
  const lastSma20 = withSma[withSma.length - 1].sma20;
  const lastSma50 = withSma[withSma.length - 1].sma50;
  const lastRsi = withRsi[withRsi.length - 1].rsi;

  let signal = "Not enough data";
  let signalColor = T.textDim;
  if (lastSma20 && lastSma50) {
    if (lastSma20 > lastSma50) {
      signal = "20-day average above 50-day — trend reads constructive";
      signalColor = T.gain;
    } else {
      signal = "20-day average below 50-day — trend reads weak";
      signalColor = T.loss;
    }
  }

  const [threshold, setThreshold] = useState("");
  const [direction, setDirection] = useState("above");

  function addAlert() {
    if (!threshold || isNaN(Number(threshold))) return;
    setAlerts([
      ...alerts,
      { id: Date.now(), symbolId, symbolName: inst.name, threshold: Number(threshold), direction },
    ]);
    setThreshold("");
  }

  function removeAlert(id) {
    setAlerts(alerts.filter((a) => a.id !== id));
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <select
          value={symbolId}
          onChange={(e) => setSymbolId(e.target.value)}
          style={selectStyle}
        >
          {data.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <div style={{ fontFamily: numFont, fontSize: 20, color: T.text }}>{fmt(last)}</div>
        <Pill color={T.gold}>RSI 14: {lastRsi ?? "—"}</Pill>
      </div>

      <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 4, padding: 14, marginBottom: 6 }}>
        <ResponsiveContainer width="100%" height={230}>
          <LineChart data={withSma}>
            <CartesianGrid stroke={T.border} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: T.textFaint, fontSize: 10, fontFamily: numFont }} interval={Math.floor(withSma.length / 6)} axisLine={{ stroke: T.border }} tickLine={false} />
            <YAxis tick={{ fill: T.textFaint, fontSize: 10, fontFamily: numFont }} axisLine={false} tickLine={false} width={54} domain={["auto", "auto"]} />
            <Tooltip
              contentStyle={{ background: T.panelAlt, border: `1px solid ${T.border}`, fontFamily: numFont, fontSize: 12 }}
              labelStyle={{ color: T.textDim }}
            />
            <Line type="monotone" dataKey="price" stroke={T.text} strokeWidth={1.4} dot={false} name="Price" />
            <Line type="monotone" dataKey="sma20" stroke={T.gold} strokeWidth={1.4} dot={false} name="SMA 20" />
            <Line type="monotone" dataKey="sma50" stroke={T.loss} strokeWidth={1.4} dot={false} name="SMA 50" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={{ fontFamily: uiFont, fontSize: 12.5, color: signalColor, marginBottom: 20 }}>{signal}</div>

      <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 4, padding: 14, marginBottom: 20 }}>
        <ResponsiveContainer width="100%" height={110}>
          <LineChart data={withRsi}>
            <XAxis dataKey="date" hide />
            <YAxis domain={[0, 100]} tick={{ fill: T.textFaint, fontSize: 10, fontFamily: numFont }} axisLine={false} tickLine={false} width={30} ticks={[30, 50, 70]} />
            <ReferenceLine y={70} stroke={T.loss} strokeDasharray="3 3" />
            <ReferenceLine y={30} stroke={T.gain} strokeDasharray="3 3" />
            <Line type="monotone" dataKey="rsi" stroke={T.gold} strokeWidth={1.4} dot={false} />
          </LineChart>
        </ResponsiveContainer>
        <div style={{ fontFamily: uiFont, fontSize: 11, color: T.textFaint, marginTop: 4 }}>
          RSI (14) — above 70 often read as overbought, below 30 as oversold
        </div>
      </div>

      <div style={{ fontFamily: uiFont, fontSize: 13, color: T.textDim, marginBottom: 10 }}>Price alerts</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <select value={direction} onChange={(e) => setDirection(e.target.value)} style={selectStyle}>
          <option value="above">Notify when above</option>
          <option value="below">Notify when below</option>
        </select>
        <input
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          placeholder="Price level"
          style={{ ...selectStyle, width: 120, fontFamily: numFont }}
        />
        <button onClick={addAlert} style={buttonStyle}>
          Add alert
        </button>
      </div>

      {alerts.length === 0 && (
        <div style={{ fontFamily: uiFont, fontSize: 12.5, color: T.textFaint }}>No alerts set yet.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {alerts.map((a) => {
          const currentInst = data.find((d) => d.id === a.symbolId);
          const currentPrice = currentInst.series[currentInst.series.length - 1].price;
          const triggered = a.direction === "above" ? currentPrice >= a.threshold : currentPrice <= a.threshold;
          return (
            <div
              key={a.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: T.panel,
                border: `1px solid ${triggered ? T.gold : T.border}`,
                borderRadius: 4,
                padding: "8px 12px",
                fontFamily: uiFont,
                fontSize: 12.5,
              }}
            >
              <span style={{ color: T.text }}>
                {a.symbolName} {a.direction} {fmt(a.threshold)}
              </span>
              <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ color: triggered ? T.gold : T.textFaint, fontFamily: numFont, fontSize: 11 }}>
                  {triggered ? "TRIGGERED" : "watching"}
                </span>
                <span
                  onClick={() => removeAlert(a.id)}
                  style={{ color: T.textFaint, cursor: "pointer", fontFamily: numFont }}
                >
                  remove
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   BACKTEST TAB — simple moving-average crossover
----------------------------------------------------------------*/
function runBacktest(series, fast, slow) {
  const merged = mergeSMAs(series, [fast, slow]);
  let position = 0; // 0 = flat, 1 = long
  let cash = 100000;
  let shares = 0;
  const equity = [];
  const trades = [];
  let entryPrice = 0;

  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const cur = merged[i];
    if (prev[`sma${fast}`] && prev[`sma${slow}`] && cur[`sma${fast}`] && cur[`sma${slow}`]) {
      const wasAbove = prev[`sma${fast}`] > prev[`sma${slow}`];
      const isAbove = cur[`sma${fast}`] > cur[`sma${slow}`];
      if (!wasAbove && isAbove && position === 0) {
        shares = cash / cur.price;
        cash = 0;
        position = 1;
        entryPrice = cur.price;
      } else if (wasAbove && !isAbove && position === 1) {
        cash = shares * cur.price;
        trades.push({ pnlPct: ((cur.price - entryPrice) / entryPrice) * 100 });
        shares = 0;
        position = 0;
      }
    }
    const markToMarket = position === 1 ? shares * cur.price : cash;
    equity.push({ date: cur.date, equity: Math.round(markToMarket), buyHold: Math.round((100000 / series[0].price) * cur.price) });
  }
  if (position === 1) {
    trades.push({ pnlPct: ((series[series.length - 1].price - entryPrice) / entryPrice) * 100 });
  }
  const finalEquity = equity[equity.length - 1]?.equity ?? 100000;
  const totalReturn = ((finalEquity - 100000) / 100000) * 100;
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const dd = maxDrawdown(equity.map((e) => e.equity));
  return { equity, totalReturn, winRate, tradeCount: trades.length, dd };
}

function BacktestTab({ data, symbolId, setSymbolId }) {
  const inst = data.find((d) => d.id === symbolId);
  const [fast, setFast] = useState(20);
  const [slow, setSlow] = useState(50);
  const result = useMemo(() => runBacktest(inst.series, Number(fast), Number(slow)), [inst, fast, slow]);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <select value={symbolId} onChange={(e) => setSymbolId(e.target.value)} style={selectStyle}>
          {data.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <span style={{ fontFamily: uiFont, fontSize: 12.5, color: T.textDim }}>Fast SMA</span>
        <input type="number" value={fast} onChange={(e) => setFast(e.target.value)} style={{ ...selectStyle, width: 60, fontFamily: numFont }} />
        <span style={{ fontFamily: uiFont, fontSize: 12.5, color: T.textDim }}>Slow SMA</span>
        <input type="number" value={slow} onChange={(e) => setSlow(e.target.value)} style={{ ...selectStyle, width: 60, fontFamily: numFont }} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Stat label="Strategy return" value={`${result.totalReturn >= 0 ? "+" : ""}${result.totalReturn.toFixed(1)}%`} color={result.totalReturn >= 0 ? T.gain : T.loss} />
        <Stat label="Win rate" value={`${result.winRate.toFixed(0)}%`} color={T.gold} />
        <Stat label="Trades taken" value={result.tradeCount} color={T.text} />
        <Stat label="Max drawdown" value={`-${result.dd.toFixed(1)}%`} color={T.loss} />
      </div>

      <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 4, padding: 14 }}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={result.equity}>
            <CartesianGrid stroke={T.border} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: T.textFaint, fontSize: 10, fontFamily: numFont }} interval={Math.floor(result.equity.length / 6)} axisLine={{ stroke: T.border }} tickLine={false} />
            <YAxis tick={{ fill: T.textFaint, fontSize: 10, fontFamily: numFont }} axisLine={false} tickLine={false} width={60} />
            <Tooltip contentStyle={{ background: T.panelAlt, border: `1px solid ${T.border}`, fontFamily: numFont, fontSize: 12 }} labelStyle={{ color: T.textDim }} />
            <Line type="monotone" dataKey="equity" stroke={T.gold} strokeWidth={1.6} dot={false} name="Strategy" />
            <Line type="monotone" dataKey="buyHold" stroke={T.textFaint} strokeWidth={1.2} dot={false} name="Buy & hold" strokeDasharray="4 3" />
          </LineChart>
        </ResponsiveContainer>
        <div style={{ display: "flex", gap: 16, marginTop: 8, fontFamily: uiFont, fontSize: 11.5 }}>
          <span style={{ color: T.gold }}>— Strategy (₹1,00,000 starting)</span>
          <span style={{ color: T.textFaint }}>- - Buy &amp; hold</span>
        </div>
      </div>
      <div style={{ fontFamily: uiFont, fontSize: 11.5, color: T.textFaint, marginTop: 10 }}>
        Backtested on simulated price history. Past performance of a rule on historical (or simulated) data does not indicate future results.
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 4, padding: "10px 12px" }}>
      <div style={{ fontFamily: uiFont, fontSize: 11, color: T.textFaint }}>{label}</div>
      <div style={{ fontFamily: numFont, fontSize: 19, color, marginTop: 3 }}>{value}</div>
    </div>
  );
}

/* ---------------------------------------------------------------
   NEWS / SENTIMENT TAB
----------------------------------------------------------------*/
function NewsTab() {
  const pos = NEWS.filter((n) => n.tag === "positive").length;
  const neg = NEWS.filter((n) => n.tag === "negative").length;
  const neu = NEWS.filter((n) => n.tag === "neutral").length;
  const score = Math.round(((pos - neg) / NEWS.length) * 100);

  return (
    <div>
      <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 4, padding: 16, marginBottom: 18 }}>
        <div style={{ fontFamily: uiFont, fontSize: 13, color: T.textDim, marginBottom: 10 }}>
          Aggregate sentiment across today's headlines
        </div>
        <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
          <div style={{ width: `${(pos / NEWS.length) * 100}%`, background: T.gain }} />
          <div style={{ width: `${(neu / NEWS.length) * 100}%`, background: T.gold }} />
          <div style={{ width: `${(neg / NEWS.length) * 100}%`, background: T.loss }} />
        </div>
        <div style={{ display: "flex", gap: 16, fontFamily: numFont, fontSize: 12 }}>
          <span style={{ color: T.gain }}>{pos} positive</span>
          <span style={{ color: T.gold }}>{neu} neutral</span>
          <span style={{ color: T.loss }}>{neg} negative</span>
          <span style={{ color: T.textDim, marginLeft: "auto" }}>net score {score >= 0 ? "+" : ""}{score}</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {NEWS.map((n, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              background: T.panel,
              border: `1px solid ${T.border}`,
              borderRadius: 4,
              padding: "10px 12px",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: TAG_COLOR[n.tag], marginTop: 5, flexShrink: 0 }} />
            <span style={{ fontFamily: uiFont, fontSize: 13, color: T.text, lineHeight: 1.4 }}>{n.h}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   MARKET SCANNER — classifies every instrument as trending or
   sideways right now, and works out where the "action" is:
   Index first, then Commodities, then individual Stocks as a
   fallback pool — matching how a trading desk would triage.
----------------------------------------------------------------*/
const RANGE_THRESHOLD = { Index: 0.25, Commodity: 0.4, Stock: 0.5 }; // % range to count as "trending"
const SCAN_ORDER = ["Index", "Commodity", "Stock"];

function sessionStats(intraday, group) {
  const open = intraday[0].price;
  const last = intraday[intraday.length - 1].price;
  const high = Math.max(...intraday.map((p) => p.price));
  const low = Math.min(...intraday.map((p) => p.price));
  const changePct = ((last - open) / open) * 100;
  const rangePct = ((high - low) / open) * 100;
  const thresh = RANGE_THRESHOLD[group] ?? 0.4;
  const status = rangePct < thresh ? "Sideways" : changePct >= 0 ? "Trending up" : "Trending down";
  return { open, last, changePct, rangePct, status };
}

function autoPick(data, statsById) {
  for (const g of SCAN_ORDER) {
    const group = data.filter((d) => d.group === g);
    const trending = group.filter((d) => statsById[d.id].status !== "Sideways");
    if (trending.length) {
      trending.sort((a, b) => Math.abs(statsById[b.id].changePct) - Math.abs(statsById[a.id].changePct));
      return { group: g, pick: trending[0], reason: `${g === "Index" ? "an index" : g === "Commodity" ? "a commodity" : "a stock"} is showing real movement` };
    }
  }
  const stocks = data.filter((d) => d.group === "Stock");
  stocks.sort((a, b) => statsById[b.id].rangePct - statsById[a.id].rangePct);
  return { group: "Stock", pick: stocks[0], reason: "index and commodities are both flat — closest-to-moving stock" };
}

function StatusBadge({ status }) {
  const color = status === "Sideways" ? T.textFaint : status === "Trending up" ? T.gain : T.loss;
  return (
    <span style={{ fontFamily: numFont, fontSize: 11, color, border: `1px solid ${color}55`, borderRadius: 3, padding: "2px 6px" }}>
      {status}
    </span>
  );
}

function ScanRow({ d, stats, onAnalyze, highlight }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: highlight ? T.panelAlt : T.panel,
        border: `1px solid ${highlight ? T.gold : T.border}`,
        borderRadius: 4,
        padding: "9px 12px",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ fontFamily: uiFont, fontSize: 13, color: T.text, whiteSpace: "nowrap" }}>{d.name}</span>
        <StatusBadge status={stats.status} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontFamily: numFont, fontSize: 12.5, color: stats.changePct >= 0 ? T.gain : T.loss }}>
          {stats.changePct >= 0 ? "+" : ""}
          {stats.changePct.toFixed(2)}%
        </span>
        <span onClick={() => onAnalyze(d.id)} style={{ fontFamily: uiFont, fontSize: 11.5, color: T.gold, cursor: "pointer", whiteSpace: "nowrap" }}>
          analyze →
        </span>
      </div>
    </div>
  );
}

function ScannerTab({ data, onAnalyze }) {
  const statsById = useMemo(() => {
    const out = {};
    data.forEach((d) => {
      const intraday = genIntradaySeries(d.id, d.base, d.vol);
      out[d.id] = sessionStats(intraday, d.group);
    });
    return out;
  }, [data]);

  const pick = useMemo(() => autoPick(data, statsById), [data, statsById]);

  const focusGroups = ["Index", "Commodity"];
  const fallbackGroup = "Stock";
  const bothFocusSideways = data
    .filter((d) => focusGroups.includes(d.group))
    .every((d) => statsById[d.id].status === "Sideways");

  return (
    <div>
      <div style={{ background: T.panelAlt, border: `1px solid ${T.gold}`, borderRadius: 4, padding: 14, marginBottom: 20 }}>
        <div style={{ fontFamily: uiFont, fontSize: 12, color: T.textDim, marginBottom: 6 }}>Head agent — where's the action right now</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontFamily: numFont, fontSize: 17, color: T.text }}>
            {pick.pick.name} <span style={{ color: T.textFaint, fontFamily: uiFont, fontSize: 12 }}>— {pick.reason}</span>
          </div>
          <button onClick={() => onAnalyze(pick.pick.id)} style={buttonStyle}>
            Run agents on this
          </button>
        </div>
      </div>

      <div style={{ fontFamily: uiFont, fontSize: 11.5, color: T.textFaint, marginBottom: 18 }}>
        Scan order: Index → Commodities → Stocks (stocks are only checked as a fallback pool once index and
        commodities are both flat) — {bothFocusSideways ? "index & commodities are flat right now, so the scan dropped into stocks" : "movement was found within index/commodities"}.
      </div>

      {focusGroups.map((g) => (
        <div key={g} style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: uiFont, fontSize: 13, color: T.textDim, marginBottom: 8, borderBottom: `1px solid ${T.border}`, paddingBottom: 6 }}>
            {g === "Index" ? "Indices" : "Commodities"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data
              .filter((d) => d.group === g)
              .sort((a, b) => Math.abs(statsById[b.id].changePct) - Math.abs(statsById[a.id].changePct))
              .map((d) => (
                <ScanRow key={d.id} d={d} stats={statsById[d.id]} onAnalyze={onAnalyze} highlight={pick.pick.id === d.id} />
              ))}
          </div>
        </div>
      ))}

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontFamily: uiFont, fontSize: 13, color: T.textDim, marginBottom: 8, borderBottom: `1px solid ${T.border}`, paddingBottom: 6 }}>
          Stocks {!bothFocusSideways && <span style={{ color: T.textFaint, fontSize: 11 }}>(fallback pool — not checked while index/commodities are moving)</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, opacity: bothFocusSideways ? 1 : 0.45 }}>
          {data
            .filter((d) => d.group === "Stock")
            .sort((a, b) => statsById[b.id].rangePct - statsById[a.id].rangePct)
            .map((d) => (
              <ScanRow key={d.id} d={d} stats={statsById[d.id]} onAnalyze={onAnalyze} highlight={pick.pick.id === d.id} />
            ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   MULTI-AGENT SIGNAL LOGIC (intraday)
   Each agent returns { label: "Bullish"|"Bearish"|"Neutral", note, weight }
   The Head Agent combines them into an action + levels + a confidence
   score — confidence reflects how much the agents AGREE, not a
   guarantee of outcome.
----------------------------------------------------------------*/
function technicalAgent(intraday) {
  const withSma = mergeSMAs(intraday, [5, 15]);
  const withRsi = rsi(intraday, 14);
  const last = withSma[withSma.length - 1];
  const lastRsi = withRsi[withRsi.length - 1].rsi;
  if (!last.sma5 || !last.sma15) return { label: "Neutral", note: "Not enough bars yet", score: 0 };
  let score = last.sma5 > last.sma15 ? 1 : -1;
  let note = last.sma5 > last.sma15 ? "5-min avg above 15-min avg" : "5-min avg below 15-min avg";
  if (lastRsi >= 70) {
    score -= 0.4;
    note += ", RSI stretched (overbought)";
  } else if (lastRsi <= 30) {
    score += 0.4;
    note += ", RSI stretched (oversold)";
  }
  return { label: score > 0.2 ? "Bullish" : score < -0.2 ? "Bearish" : "Neutral", note, score };
}

function sentimentAgent() {
  const pos = NEWS.filter((n) => n.tag === "positive").length;
  const neg = NEWS.filter((n) => n.tag === "negative").length;
  const score = (pos - neg) / NEWS.length;
  return {
    label: score > 0.1 ? "Bullish" : score < -0.1 ? "Bearish" : "Neutral",
    note: `${pos} positive / ${neg} negative headlines today`,
    score,
  };
}

function riskAgent(intraday, capital = 100000, riskPct = 1) {
  const a = atr(intraday, 14);
  const last = intraday[intraday.length - 1].price;
  const stopDistance = Math.max(a * 1.5, last * 0.002);
  const riskAmount = capital * (riskPct / 100);
  const qty = Math.max(1, Math.floor(riskAmount / stopDistance));
  return { atrValue: a, stopDistance, qty, riskAmount };
}

function headAgent(technical, sentiment, risk, last) {
  const combined = technical.score * 0.65 + sentiment.score * 0.35;
  const action = combined > 0.25 ? "BUY" : combined < -0.25 ? "SELL" : "HOLD";
  const agreeCount =
    (technical.label !== "Neutral" ? 1 : 0) + (sentiment.label !== "Neutral" ? 1 : 0);
  const sameDirection =
    technical.label !== "Neutral" &&
    sentiment.label !== "Neutral" &&
    technical.label === sentiment.label;
  const confidence = sameDirection ? 75 : agreeCount === 1 ? 55 : 40;

  const entry = last;
  const stop = action === "BUY" ? entry - risk.stopDistance : action === "SELL" ? entry + risk.stopDistance : null;
  const target = action === "BUY" ? entry + risk.stopDistance * 1.8 : action === "SELL" ? entry - risk.stopDistance * 1.8 : null;

  return { action, entry, stop, target, confidence, qty: risk.qty };
}

function AgentCard({ name, label, note }) {
  const color = label === "Bullish" ? T.gain : label === "Bearish" ? T.loss : T.gold;
  return (
    <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderLeft: `3px solid ${color}`, borderRadius: 4, padding: "10px 12px" }}>
      <div style={{ fontFamily: uiFont, fontSize: 11.5, color: T.textFaint }}>{name}</div>
      <div style={{ fontFamily: numFont, fontSize: 15, color, margin: "3px 0" }}>{label}</div>
      <div style={{ fontFamily: uiFont, fontSize: 11.5, color: T.textDim }}>{note}</div>
    </div>
  );
}

function SignalsTab({ data, symbolId, setSymbolId }) {
  const inst = data.find((d) => d.id === symbolId);
  const intraday = useMemo(() => genIntradaySeries(inst.id, inst.base, inst.vol), [inst]);
  const withSma = useMemo(() => mergeSMAs(intraday, [5, 15]), [intraday]);
  const last = intraday[intraday.length - 1].price;

  const technical = useMemo(() => technicalAgent(intraday), [intraday]);
  const sentiment = useMemo(() => sentimentAgent(), []);
  const risk = useMemo(() => riskAgent(intraday), [intraday]);
  const head = useMemo(() => headAgent(technical, sentiment, risk, last), [technical, sentiment, risk, last]);

  const actionColor = head.action === "BUY" ? T.gain : head.action === "SELL" ? T.loss : T.gold;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <select value={symbolId} onChange={(e) => setSymbolId(e.target.value)} style={selectStyle}>
          {data.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <span style={{ fontFamily: numFont, fontSize: 18, color: T.text }}>{fmt(last)}</span>
      </div>

      <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 4, padding: 14, marginBottom: 16 }}>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={withSma}>
            <CartesianGrid stroke={T.border} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: T.textFaint, fontSize: 10, fontFamily: numFont }} interval={60} axisLine={{ stroke: T.border }} tickLine={false} />
            <YAxis tick={{ fill: T.textFaint, fontSize: 10, fontFamily: numFont }} axisLine={false} tickLine={false} width={54} domain={["auto", "auto"]} />
            <Tooltip contentStyle={{ background: T.panelAlt, border: `1px solid ${T.border}`, fontFamily: numFont, fontSize: 12 }} labelStyle={{ color: T.textDim }} />
            <Line type="monotone" dataKey="price" stroke={T.text} strokeWidth={1.2} dot={false} />
            <Line type="monotone" dataKey="sma5" stroke={T.gold} strokeWidth={1.2} dot={false} />
            <Line type="monotone" dataKey="sma15" stroke={T.loss} strokeWidth={1.2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
        <div style={{ fontFamily: uiFont, fontSize: 11, color: T.textFaint, marginTop: 4 }}>
          Simulated 1-min bars for today's session (09:15–15:30 IST)
        </div>
      </div>

      <div style={{ fontFamily: uiFont, fontSize: 13, color: T.textDim, marginBottom: 10 }}>Agent breakdown</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 20 }}>
        <AgentCard name="Technical agent" label={technical.label} note={technical.note} />
        <AgentCard name="Sentiment agent" label={sentiment.label} note={sentiment.note} />
        <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderLeft: `3px solid ${T.gold}`, borderRadius: 4, padding: "10px 12px" }}>
          <div style={{ fontFamily: uiFont, fontSize: 11.5, color: T.textFaint }}>Risk agent</div>
          <div style={{ fontFamily: numFont, fontSize: 15, color: T.gold, margin: "3px 0" }}>{fmt(risk.stopDistance)} stop width</div>
          <div style={{ fontFamily: uiFont, fontSize: 11.5, color: T.textDim }}>
            Sized for ₹1,000 risk (1% of ₹1L) → qty {risk.qty}
          </div>
        </div>
      </div>

      <div
        style={{
          background: T.panelAlt,
          border: `1px solid ${actionColor}`,
          borderRadius: 4,
          padding: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <div style={{ fontFamily: uiFont, fontSize: 12.5, color: T.textDim }}>Head agent — consolidated call</div>
          <Pill color={T.gold}>Confidence {head.confidence}%</Pill>
        </div>
        <div style={{ fontFamily: numFont, fontSize: 26, color: actionColor, marginBottom: 10 }}>{head.action}</div>
        {head.action !== "HOLD" ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12 }}>
            <div>
              <div style={{ fontFamily: uiFont, fontSize: 11, color: T.textFaint }}>Entry</div>
              <div style={{ fontFamily: numFont, fontSize: 16, color: T.text }}>{fmt(head.entry)}</div>
            </div>
            <div>
              <div style={{ fontFamily: uiFont, fontSize: 11, color: T.textFaint }}>Stop-loss</div>
              <div style={{ fontFamily: numFont, fontSize: 16, color: T.loss }}>{fmt(head.stop)}</div>
            </div>
            <div>
              <div style={{ fontFamily: uiFont, fontSize: 11, color: T.textFaint }}>Target</div>
              <div style={{ fontFamily: numFont, fontSize: 16, color: T.gain }}>{fmt(head.target)}</div>
            </div>
            <div>
              <div style={{ fontFamily: uiFont, fontSize: 11, color: T.textFaint }}>Suggested qty</div>
              <div style={{ fontFamily: numFont, fontSize: 16, color: T.text }}>{head.qty}</div>
            </div>
          </div>
        ) : (
          <div style={{ fontFamily: uiFont, fontSize: 12.5, color: T.textDim }}>
            Agents disagree or signal is weak — no clean entry right now.
          </div>
        )}
      </div>
      <div style={{ fontFamily: uiFont, fontSize: 11.5, color: T.textFaint, marginTop: 12 }}>
        Confidence reflects how much the agents agree with each other — it is not a probability of profit, and this
        runs on simulated data. No signal here should be treated as financial advice.
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   SHARED STYLES
----------------------------------------------------------------*/
const selectStyle = {
  background: T.panelAlt,
  color: T.text,
  border: `1px solid ${T.border}`,
  borderRadius: 4,
  padding: "7px 10px",
  fontFamily: uiFont,
  fontSize: 12.5,
  outline: "none",
};

const buttonStyle = {
  background: T.gold,
  color: "#1A1508",
  border: "none",
  borderRadius: 4,
  padding: "7px 14px",
  fontFamily: uiFont,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

/* ---------------------------------------------------------------
   ROOT APP
----------------------------------------------------------------*/
export default function App() {
  const [tab, setTab] = useState("scan");
  const [techSymbol, setTechSymbol] = useState("NIFTY50");
  const [backSymbol, setBackSymbol] = useState("NIFTY50");
  const [signalSymbol, setSignalSymbol] = useState("NIFTY50");
  const [alerts, setAlerts] = useState([]);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const data = useMemo(
    () => SYMBOLS.map((s) => ({ ...s, series: genSeries(s.id, s.base, s.vol, 150) })),
    []
  );

  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const hh = ist.getHours() + ist.getMinutes() / 60;
  const isWeekday = ist.getDay() >= 1 && ist.getDay() <= 5;
  const marketOpen = isWeekday && hh >= 9.25 && hh <= 15.5;

  const tabs = [
    { id: "scan", label: "Market scan" },
    { id: "dashboard", label: "Dashboard" },
    { id: "signals", label: "Agent signals" },
    { id: "technical", label: "Technical & alerts" },
    { id: "backtest", label: "Backtest" },
    { id: "news", label: "News & sentiment" },
  ];

  function analyzeSymbol(id) {
    setSignalSymbol(id);
    setTab("signals");
  }

  return (
    <div style={{ background: T.bg, minHeight: "100%", padding: "18px 16px 40px", fontFamily: uiFont }}>
      <style>{`
        * { box-sizing: border-box; }
        input:focus, select:focus, button:focus { outline: 1px solid ${T.gold}; }
        ::selection { background: ${T.gold}55; }
        select option { background: ${T.panelAlt}; }
      `}</style>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontFamily: numFont, fontSize: 20, color: T.text, letterSpacing: 0.5 }}>Bazaar Board</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: numFont, fontSize: 12, color: T.textDim }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: marketOpen ? T.gain : T.textFaint, display: "inline-block" }} />
          {marketOpen ? "Market session open" : "Market session closed"} · IST {ist.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
      <div style={{ fontFamily: uiFont, fontSize: 12, color: T.textFaint, marginBottom: 20 }}>
        Simulated data for demonstration — wire in a real feed (NSE/BSE/MCX-licensed provider) before relying on this for actual decisions.
      </div>

      <div style={{ display: "flex", gap: 22, borderBottom: `1px solid ${T.border}`, marginBottom: 20, overflowX: "auto" }}>
        {tabs.map((t) => (
          <div
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              fontFamily: uiFont,
              fontSize: 13,
              padding: "0 0 10px 0",
              color: tab === t.id ? T.text : T.textFaint,
              borderBottom: tab === t.id ? `2px solid ${T.gold}` : "2px solid transparent",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {t.label}
          </div>
        ))}
      </div>

      {tab === "scan" && <ScannerTab data={data} onAnalyze={analyzeSymbol} />}
      {tab === "dashboard" && <Dashboard data={data} />}
      {tab === "signals" && <SignalsTab data={data} symbolId={signalSymbol} setSymbolId={setSignalSymbol} />}
      {tab === "technical" && (
        <TechnicalTab data={data} symbolId={techSymbol} setSymbolId={setTechSymbol} alerts={alerts} setAlerts={setAlerts} />
      )}
      {tab === "backtest" && <BacktestTab data={data} symbolId={backSymbol} setSymbolId={setBackSymbol} />}
      {tab === "news" && <NewsTab />}
    </div>
  );
}
