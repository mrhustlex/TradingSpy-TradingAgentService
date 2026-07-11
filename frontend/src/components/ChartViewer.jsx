import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import {
    Calendar, Filter, X, ChevronRight, Activity, Plus,
    ChevronDown, ChevronUp, TrendingUp, TrendingDown, GitFork,
    Pen, Trash2
} from 'lucide-react';
import TradeSetupChecklist from './TradeSetupChecklist';

// ─── Constants ────────────────────────────────────────────────────────────────
const SMA_COLORS = ['#eab308', '#f97316', '#ef4444', '#06b6d4', '#84cc16'];
const EMA_COLORS = ['#3b82f6', '#6366f1', '#8b5cf6', '#14b8a6', '#0ea5e9'];
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ['#94a3b8', '#eab308', '#f97316', '#ec4899', '#10b981', '#a855f7', '#94a3b8'];
const LINE_TYPE_META = {
    support: { color: '#10b981', style: 0 },
    resistance: { color: '#ef4444', style: 0 },
    custom: { color: '#3b82f6', style: 1 },
};

// ─── Math helpers ─────────────────────────────────────────────────────────────
function calcSMA(data, period) {
    const r = [];
    for (let i = period - 1; i < data.length; i++) {
        let s = 0; for (let j = 0; j < period; j++) s += data[i - j].close;
        r.push({ time: data[i].time, value: s / period });
    }
    return r;
}

// Calculate slope-based trendlines with multiple candidates
function calculateTrendlines(data) {
    if (!data || data.length < 40) return { support: null, resistance: null, supportCandidates: [], resistanceCandidates: [] };
    
    const lows = data.map(d => d.low);
    const highs = data.map(d => d.high);
    const currentPrice = data[data.length - 1].close;
    const currentTime = data[data.length - 1].time;
    
    // Find pivot points (local min/max over 3-bar window)
    const radius = 3;
    const pivotLows = [];
    const pivotHighs = [];
    
    for (let i = radius; i < data.length - radius; i++) {
        const isLow = lows[i] <= Math.min(...lows.slice(i - radius, i + radius + 1));
        const isHigh = highs[i] >= Math.max(...highs.slice(i - radius, i + radius + 1));
        if (isLow) pivotLows.push(i);
        if (isHigh) pivotHighs.push(i);
    }
    
    const trendlines = { support: null, resistance: null, supportCandidates: [], resistanceCandidates: [] };
    
    // Helper to generate interpolated points — straight line across the full chart
    const generateLinePoints = (startIdx, endIdx, startPrice, endPrice) => {
        const points = [];
        const slope = (endPrice - startPrice) / (endIdx - startIdx);
        // Project from the very start of the chart using the slope
        const basePrice = startPrice - slope * startIdx;
        for (let i = 0; i < data.length; i++) {
            const projectedPrice = basePrice + slope * i;
            points.push({ time: data[i].time, value: projectedPrice });
        }
        return points;
    };
    
    // Helper to count touches (bars that touch the trendline within tolerance)
    const countTouches = (startIdx, endIdx, startPrice, endPrice, isSupport) => {
        const slope = (endPrice - startPrice) / (endIdx - startIdx);
        const atr = Math.abs(Math.max(...highs) - Math.min(...lows)) / 20; // rough ATR
        const tolerance = Math.max(atr * 0.5, currentPrice * 0.002);
        let touches = 0;
        let violations = 0;
        
        for (let i = startIdx; i < data.length; i++) {
            const linePrice = startPrice + slope * (i - startIdx);
            const distance = isSupport ? linePrice - lows[i] : highs[i] - linePrice;
            if (Math.abs(distance) < tolerance) touches++;
            else if (distance < -tolerance * 2) violations++;
        }
        return { touches, violations };
    };
    
    // Generate support candidates (pairs of recent lows)
    if (pivotLows.length >= 2) {
        const candidates = [];
        for (let i = Math.max(0, pivotLows.length - 6); i < pivotLows.length - 1; i++) {
            const idx1 = pivotLows[i];
            const idx2 = pivotLows[i + 1];
            if (idx2 > idx1) {
                const slope = (lows[idx2] - lows[idx1]) / (idx2 - idx1);
                const projectedSupport = lows[idx1] + slope * (data.length - 1 - idx1);
                const distancePct = (projectedSupport / currentPrice - 1) * 100;
                const { touches, violations } = countTouches(idx1, idx2, lows[idx1], lows[idx2], true);
                
                // Confidence: high if 3+ touches and no violations, medium if 2 touches
                let confidence = 'low';
                if (touches >= 3 && violations === 0) confidence = 'high';
                else if (touches >= 2 && violations <= 1) confidence = 'medium';
                
                const points = generateLinePoints(idx1, idx2, lows[idx1], lows[idx2]);
                
                candidates.push({
                    price: Math.round(projectedSupport * 100) / 100,
                    slope: slope > 0 ? 'rising' : 'falling',
                    slopeValue: Math.round(slope * 10000) / 10000,
                    slopePerBar: (slope * 1).toFixed(4),
                    distance: Math.round(distancePct * 100) / 100,
                    touches,
                    violations,
                    confidence,
                    points
                });
            }
        }
        
        // Sort by confidence and proximity to current price
        candidates.sort((a, b) => {
            const confOrder = { high: 0, medium: 1, low: 2 };
            if (confOrder[a.confidence] !== confOrder[b.confidence]) {
                return confOrder[a.confidence] - confOrder[b.confidence];
            }
            return Math.abs(a.distance) - Math.abs(b.distance);
        });
        
        if (candidates.length > 0) {
            trendlines.support = candidates[0];
            trendlines.supportCandidates = candidates.slice(0, 6);
        }
    }
    
    // Generate resistance candidates (pairs of recent highs)
    if (pivotHighs.length >= 2) {
        const candidates = [];
        for (let i = Math.max(0, pivotHighs.length - 6); i < pivotHighs.length - 1; i++) {
            const idx1 = pivotHighs[i];
            const idx2 = pivotHighs[i + 1];
            if (idx2 > idx1) {
                const slope = (highs[idx2] - highs[idx1]) / (idx2 - idx1);
                const projectedResistance = highs[idx1] + slope * (data.length - 1 - idx1);
                const distancePct = (projectedResistance / currentPrice - 1) * 100;
                const { touches, violations } = countTouches(idx1, idx2, highs[idx1], highs[idx2], false);
                
                // Confidence: high if 3+ touches and no violations, medium if 2 touches
                let confidence = 'low';
                if (touches >= 3 && violations === 0) confidence = 'high';
                else if (touches >= 2 && violations <= 1) confidence = 'medium';
                
                const points = generateLinePoints(idx1, idx2, highs[idx1], highs[idx2]);
                
                candidates.push({
                    price: Math.round(projectedResistance * 100) / 100,
                    slope: slope > 0 ? 'rising' : 'falling',
                    slopeValue: Math.round(slope * 10000) / 10000,
                    slopePerBar: (slope * 1).toFixed(4),
                    distance: Math.round(distancePct * 100) / 100,
                    touches,
                    violations,
                    confidence,
                    points
                });
            }
        }
        
        // Sort by confidence and proximity to current price
        candidates.sort((a, b) => {
            const confOrder = { high: 0, medium: 1, low: 2 };
            if (confOrder[a.confidence] !== confOrder[b.confidence]) {
                return confOrder[a.confidence] - confOrder[b.confidence];
            }
            return Math.abs(a.distance) - Math.abs(b.distance);
        });
        
        if (candidates.length > 0) {
            trendlines.resistance = candidates[0];
            trendlines.resistanceCandidates = candidates.slice(0, 6);
        }
    }
    
    return trendlines;
}

function calcEMA(data, period) {
    const k = 2 / (period + 1); let ema = data[0].close; const r = [];
    for (let i = 1; i < data.length; i++) {
        ema = data[i].close * k + ema * (1 - k);
        if (i >= period - 1) r.push({ time: data[i].time, value: ema });
    }
    return r;
}
function calcBB(data, period = 20, mult = 2) {
    const upper = [], mid = [], lower = [];
    for (let i = period - 1; i < data.length; i++) {
        const s = data.slice(i - period + 1, i + 1).map(d => d.close);
        const mean = s.reduce((a, b) => a + b, 0) / period;
        const std = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
        upper.push({ time: data[i].time, value: mean + mult * std });
        mid.push({ time: data[i].time, value: mean });
        lower.push({ time: data[i].time, value: mean - mult * std });
    }
    return { upper, mid, lower };
}
function calcVWAP(data) {
    let cpv = 0, cv = 0;
    return data.filter(d => d.volume > 0).map(d => {
        const tp = (d.high + d.low + d.close) / 3;
        cpv += tp * d.volume; cv += d.volume;
        return { time: d.time, value: cpv / cv };
    });
}
function calcRSI(data, period = 14) {
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const d = data[i].close - data[i - 1].close;
        if (d >= 0) gains += d; else losses -= d;
    }
    let ag = gains / period, al = losses / period;
    const r = [{ time: data[period].time, value: 100 - 100 / (1 + ag / (al || 0.0001)) }];
    for (let i = period + 1; i < data.length; i++) {
        const d = data[i].close - data[i - 1].close;
        ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
        al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
        r.push({ time: data[i].time, value: 100 - 100 / (1 + ag / (al || 0.0001)) });
    }
    return r;
}
function fmtNum(n, d = 2) { if (n === undefined || n === null || isNaN(n)) return '—'; return parseFloat(n).toFixed(d); }
function fmtVol(v) {
    if (!v || isNaN(v)) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(v);
}

// ─── Sub-components ───────────────────────────────────────────────────────────
const PeriodChip = ({ period, color, onRemove, onChange }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '3px', background: `${color}22`, border: `1px solid ${color}55`, borderRadius: '6px', padding: '2px 6px' }}>
        <input type="number" value={period} min={2} max={500} onChange={e => onChange(parseInt(e.target.value) || period)}
            style={{ width: '34px', background: 'transparent', border: 'none', outline: 'none', color, fontWeight: 'bold', textAlign: 'center', fontSize: '0.73rem' }} />
        <button onClick={onRemove} style={{ background: 'none', border: 'none', cursor: 'pointer', color: `${color}99`, display: 'flex', padding: 0 }}><X size={10} /></button>
    </div>
);

const ToggleChip = ({ label, enabled, color, onClick }) => (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', background: enabled ? `${color}18` : 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '5px 10px', border: `1px solid ${enabled ? color + '55' : 'rgba(255,255,255,0.08)'}`, transition: 'all 0.2s', userSelect: 'none' }}>
        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: enabled ? color : 'rgba(255,255,255,0.2)', flexShrink: 0 }} />
        <span style={{ color: enabled ? color : 'var(--text-secondary)', fontWeight: enabled ? 'bold' : 'normal', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
);

const IndBlock = ({ id, label, color, ind, onToggle, onAdd, onRemove, onUpdate, hasPeriods }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', background: ind.enabled ? `${color}15` : 'rgba(255,255,255,0.03)', border: `1px solid ${ind.enabled ? color + '44' : 'rgba(255,255,255,0.07)'}`, borderRadius: '8px', padding: '5px 9px' }}>
        <button onClick={onToggle} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', color: ind.enabled ? color : 'var(--text-secondary)', fontWeight: ind.enabled ? 'bold' : 'normal', fontSize: '0.78rem', padding: 0 }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: ind.enabled ? color : 'rgba(255,255,255,0.2)' }} /> {label}
        </button>
        {ind.enabled && hasPeriods && ind.periods.map((p, i) => (
            <PeriodChip key={i} period={p} color={color} onRemove={() => onRemove(i)} onChange={v => onUpdate(i, v)} />
        ))}
        {ind.enabled && hasPeriods && (
            <button onClick={onAdd} style={{ background: 'none', border: `1px dashed ${color}55`, borderRadius: '4px', cursor: 'pointer', color, width: '17px', height: '17px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={10} /></button>
        )}
    </div>
);

// ─── Main Component ───────────────────────────────────────────────────────────
const ChartViewer = ({ data, markers = [], onClose, fileName, allFiles = [], onSwitch, externalStartDate, externalEndDate, height = 400, defaultShowIndicators = true }) => {
    const chartContainerRef = useRef();
    const [localStartDate, setLocalStartDate] = useState(externalStartDate || '');
    const [localEndDate, setLocalEndDate] = useState(externalEndDate || '');
    const [showIndicators, setShowIndicators] = useState(defaultShowIndicators);
    const [activeTab, setActiveTab] = useState('indicators');
    const [tooltip, setTooltip] = useState(null); // crosshair data

    const [indicators, setIndicators] = useState({
        sma: { enabled: true, periods: [20, 50, 200] },
        ema: { enabled: false, periods: [12, 26] },
        bb: { enabled: false, periods: [20] },
        vol: { enabled: true, periods: [] },
        vwap: { enabled: false, periods: [] },
        rsi: { enabled: false, periods: [14] },
    });

    const [priceLines, setPriceLines] = useState([
        { id: 1, price: '', type: 'support', label: 'Support', visible: true },
        { id: 2, price: '', type: 'resistance', label: 'Resistance', visible: true },
    ]);
    const [nextLineId, setNextLineId] = useState(3);
    const [fibHigh, setFibHigh] = useState('');
    const [fibLow, setFibLow] = useState('');
    const [fibEnabled, setFibEnabled] = useState(false);
    const [fibDir, setFibDir] = useState('bull');
    const [autoAnnotate, setAutoAnnotate] = useState(false);
    const [tradeAnalysis, setTradeAnalysis] = useState(null);
    const [annotationVisibility, setAnnotationVisibility] = useState({ showLevels: true, showTrendlines: true, showStructures: true });
    const [drawingMode, setDrawingMode] = useState(false);
    const [currentDrawPoints, setCurrentDrawPoints] = useState([]);
    const [calculatedTrendlines, setCalculatedTrendlines] = useState({ support: null, resistance: null, supportCandidates: [], resistanceCandidates: [] });
    const [hiddenCandidates, setHiddenCandidates] = useState(new Set()); // Candidates hidden by user clicking
    const drawingModeRef = useRef(false);
    const drawnLineSeriesRef = useRef([]);
    const chartRef = useRef(null);

    useEffect(() => { if (externalStartDate) setLocalStartDate(externalStartDate); }, [externalStartDate]);
    useEffect(() => { if (externalEndDate) setLocalEndDate(externalEndDate); }, [externalEndDate]);

    // ── helpers ──
    const parseInfo = (name) => {
        if (!name || typeof name !== 'string') return { ticker: 'UNKNOWN', interval: '?', period: '?' };
        const intervals = ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo'];
        const parts = name.replace('.txt', '').split('-');
        const ii = parts.findIndex(p => intervals.includes(p));
        return ii !== -1 ? { ticker: parts.slice(0, ii).join('-').toUpperCase(), interval: parts[ii], period: parts.slice(ii + 1).join('-') } : { ticker: parts[0].toUpperCase(), interval: '?', period: '?' };
    };
    const currentInfo = parseInfo(fileName);
    const tickers = [...new Set((allFiles || []).map(f => parseInfo(f).ticker))].sort();
    const uniqueIntervals = [...new Set((allFiles || []).filter(f => parseInfo(f).ticker === currentInfo.ticker).map(f => parseInfo(f).interval))].sort();
    const handleTickerChange = (t) => { const m = (allFiles || []).find(f => parseInfo(f).ticker === t); if (m && onSwitch) onSwitch(m); };
    const handleIntervalChange = (iv) => { const m = (allFiles || []).find(f => { const i = parseInfo(f); return i.ticker === currentInfo.ticker && i.interval === iv; }); if (m && onSwitch) onSwitch(m); };
    const onTradeAnalysisChange = useCallback((analysis, visibility) => {
        setTradeAnalysis(analysis);
        setAnnotationVisibility(visibility);
    }, []);

    const toggleInd = (id) => setIndicators(p => ({ ...p, [id]: { ...p[id], enabled: !p[id].enabled } }));
    const addPeriod = (id) => setIndicators(p => ({ ...p, [id]: { ...p[id], periods: [...p[id].periods, 14] } }));
    const removePeriod = (id, i) => setIndicators(p => ({ ...p, [id]: { ...p[id], periods: p[id].periods.filter((_, j) => j !== i) } }));
    const updatePeriod = (id, i, v) => setIndicators(p => ({ ...p, [id]: { ...p[id], periods: p[id].periods.map((x, j) => j === i ? v : x) } }));

    const addLine = () => { setPriceLines(p => [...p, { id: nextLineId, price: '', type: 'support', label: 'Support', visible: true }]); setNextLineId(n => n + 1); };
    const removeLine = (id) => setPriceLines(p => p.filter(l => l.id !== id));
    const updateLine = (id, field, val) => setPriceLines(p => p.map(l => l.id === id ? { ...l, [field]: val } : l));

    // ── Chart effect ──────────────────────────────────────────────────────────
    useEffect(() => {
        if (!data || data.length === 0 || !chartContainerRef.current) return;
        chartContainerRef.current.innerHTML = '';
        setTooltip(null);
        let disposed = false;

        const hasRSI = indicators.rsi.enabled;
        const mainH = hasRSI ? Math.round(height * 0.70) : height;
        const rsiH = hasRSI ? Math.round(height * 0.30) : 0;

        const chart = createChart(chartContainerRef.current, {
            width: chartContainerRef.current.offsetWidth || chartContainerRef.current.parentElement?.offsetWidth || 800,
            height: mainH,
            layout: { background: { color: '#0b1120' }, textColor: '#94a3b8' },
            grid: { vertLines: { color: 'rgba(51,65,85,0.3)' }, horzLines: { color: 'rgba(51,65,85,0.3)' } },
            timeScale: { borderColor: '#334155', timeVisible: true, barSpacing: 12, minBarSpacing: 1 },
            rightPriceScale: { borderColor: '#334155' },
            crosshair: { mode: 1 },
        });

        // parse raw data
        const formattedData = (data || []).map(item => {
            const get = (keys) => { const k = Object.keys(item).find(k => keys.includes(k.trim().toLowerCase())); return k ? item[k] : null; };
            const rawDate = get(['date', 'datetime', 'time', 'timestamp']);
            const o = parseFloat(get(['open'])), h = parseFloat(get(['high'])), l = parseFloat(get(['low'])), c = parseFloat(get(['close']));
            const v = parseFloat(get(['volume'])) || 0;
            if (!rawDate || isNaN(o)) return null;
            const t = new Date(rawDate).getTime() / 1000;
            if (isNaN(t)) return null;
            return { time: t, open: o, high: h, low: l, close: c, volume: v };
        }).filter(Boolean).sort((a, b) => a.time - b.time);

        const seenT = new Set(); let uniqueData = [];
        for (const d of formattedData) { if (!seenT.has(d.time)) { seenT.add(d.time); uniqueData.push(d); } }
        if (localStartDate) uniqueData = uniqueData.filter(d => d.time >= new Date(localStartDate).getTime() / 1000);
        if (localEndDate) uniqueData = uniqueData.filter(d => d.time <= new Date(localEndDate + 'T23:59:59').getTime() / 1000);
        if (uniqueData.length === 0) { chart.remove(); return; }

        // Calculate trendlines from chart data
        const trendlines = calculateTrendlines(uniqueData);
        setCalculatedTrendlines(trendlines);

        // Pre-compute indicator lookup maps (time -> value) for tooltip
        const indicatorMaps = {};

        // Candle
        const candle = chart.addCandlestickSeries({ upColor: '#10b981', downColor: '#ef4444', borderVisible: false, wickUpColor: '#10b981', wickDownColor: '#ef4444' });
        candle.setData(uniqueData);

        // Trade markers
        if (markers && markers.length > 0) {
            const seen = new Set(); const cms = [];
            markers.forEach(m => {
                const key = `${m.time}-${m.type}`;
                if (!seen.has(key)) { seen.add(key); cms.push({ time: new Date(m.time).getTime() / 1000, position: m.type === 'Buy' ? 'belowBar' : 'aboveBar', color: m.type === 'Buy' ? '#10b981' : '#ef4444', shape: m.type === 'Buy' ? 'arrowUp' : 'arrowDown', text: `${m.type} @ ${m.price?.toFixed(2)}` }); }
            });
            candle.setMarkers(cms);
        }

        // S/R Lines
        priceLines.forEach(line => {
            const price = parseFloat(line.price);
            if (!isNaN(price) && price > 0 && line.visible) {
                const meta = LINE_TYPE_META[line.type] || LINE_TYPE_META.custom;
                candle.createPriceLine({ price, color: meta.color, lineWidth: 1, lineStyle: meta.style, axisLabelVisible: true, title: line.label || meta.label });
            }
        });

        // Auto-calculated trendlines with slope (shown only if showTrendlines enabled)
        // Show the best support/resistance trendlines
        if (trendlines.support && annotationVisibility.showTrendlines) {
            const series = chart.addLineSeries({ 
                color: '#10b98199', 
                lineWidth: 2.5, 
                lineStyle: 0, 
                title: `Support (${trendlines.support.slope} @ ${trendlines.support.slopePerBar}/bar)`, 
                lastValueVisible: true, 
                priceLineVisible: false 
            });
            series.setData(trendlines.support.points);
        }
        if (trendlines.resistance && annotationVisibility.showTrendlines) {
            const series = chart.addLineSeries({ 
                color: '#f9731699', 
                lineWidth: 2.5, 
                lineStyle: 0, 
                title: `Resistance (${trendlines.resistance.slope} @ ${trendlines.resistance.slopePerBar}/bar)`, 
                lastValueVisible: true, 
                priceLineVisible: false 
            });
            series.setData(trendlines.resistance.points);
        }

        // Show all candidate trendlines by default; hiddenCandidates holds ones user clicked to hide
        if (annotationVisibility.showTrendlines) {
            // Support candidates
            trendlines.supportCandidates?.forEach((candidate, idx) => {
                const candKey = `sup_${idx}`;
                if (!hiddenCandidates.has(candKey)) {
                    const series = chart.addLineSeries({
                        color: candidate.confidence === 'high' ? '#10b98166' : candidate.confidence === 'medium' ? '#10b98133' : '#10b98111',
                        lineWidth: candidate.confidence === 'high' ? 2 : 1.5,
                        lineStyle: 1, // dashed
                        title: `Support (${candidate.slopePerBar}/bar, ${candidate.touches}t)`,
                        lastValueVisible: false,
                        priceLineVisible: false
                    });
                    series.setData(candidate.points);
                }
            });
            // Resistance candidates
            trendlines.resistanceCandidates?.forEach((candidate, idx) => {
                const candKey = `res_${idx}`;
                if (!hiddenCandidates.has(candKey)) {
                    const series = chart.addLineSeries({
                        color: candidate.confidence === 'high' ? '#f9731666' : candidate.confidence === 'medium' ? '#f9731633' : '#f9731611',
                        lineWidth: candidate.confidence === 'high' ? 2 : 1.5,
                        lineStyle: 1, // dashed
                        title: `Resistance (${candidate.slopePerBar}/bar, ${candidate.touches}t)`,
                        lastValueVisible: false,
                        priceLineVisible: false
                    });
                    series.setData(candidate.points);
                }
            });
        }

        // Deterministic setup annotations are kept separate from user lines.
        if (autoAnnotate && tradeAnalysis?.available) {
            if (annotationVisibility.showLevels) {
                [...(tradeAnalysis.levels?.supports || []), ...(tradeAnalysis.levels?.resistances || [])].forEach((level) => {
                    candle.createPriceLine({
                        price: level.price,
                        color: level.type === 'support' ? '#10b98199' : '#f9731699',
                        lineWidth: 1,
                        lineStyle: 2,
                        axisLabelVisible: true,
                        title: level.label,
                    });
                });
            }
            if (annotationVisibility.showTrendlines) {
                (tradeAnalysis.trendlines || []).forEach((line) => {
                    const series = chart.addLineSeries({ color: line.type === 'support' ? '#10b981' : '#f97316', lineWidth: 2, lineStyle: line.validated ? 0 : 1, title: line.label, lastValueVisible: false, priceLineVisible: false });
                    series.setData(line.points);
                });
            }
        }

        // Fibonacci
        if (fibEnabled && !isNaN(parseFloat(fibHigh)) && !isNaN(parseFloat(fibLow))) {
            const H = parseFloat(fibDir === 'bull' ? fibHigh : fibLow), L = parseFloat(fibDir === 'bull' ? fibLow : fibHigh);
            FIB_LEVELS.forEach((level, idx) => {
                const price = fibDir === 'bull' ? H - (H - L) * level : L + (H - L) * level;
                candle.createPriceLine({ price, color: FIB_COLORS[idx], lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: `Fib ${(level * 100).toFixed(1)}%` });
            });
        }

        // Volume
        if (indicators.vol.enabled) {
            const vs = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol_scale', color: '#334155' });
            chart.priceScale('vol_scale').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
            vs.setData(uniqueData.map(d => ({ time: d.time, value: d.volume, color: d.close >= d.open ? '#10b98155' : '#ef444455' })));
        }

        // SMA
        if (indicators.sma.enabled) {
            indicators.sma.periods.forEach((period, idx) => {
                if (period < 2 || period >= uniqueData.length) return;
                const d = calcSMA(uniqueData, period);
                const m = {}; d.forEach(p => m[p.time] = p.value); indicatorMaps[`SMA${period}`] = { map: m, color: SMA_COLORS[idx % SMA_COLORS.length] };
                const s = chart.addLineSeries({ color: SMA_COLORS[idx % SMA_COLORS.length], lineWidth: 2, title: `SMA${period}`, crosshairMarkerVisible: false, lastValueVisible: true, priceLineVisible: false });
                s.setData(d);
            });
        }

        // EMA
        if (indicators.ema.enabled) {
            indicators.ema.periods.forEach((period, idx) => {
                if (period < 2 || period >= uniqueData.length) return;
                const d = calcEMA(uniqueData, period);
                const m = {}; d.forEach(p => m[p.time] = p.value); indicatorMaps[`EMA${period}`] = { map: m, color: EMA_COLORS[idx % EMA_COLORS.length] };
                const s = chart.addLineSeries({ color: EMA_COLORS[idx % EMA_COLORS.length], lineWidth: 2, title: `EMA${period}`, crosshairMarkerVisible: false, lastValueVisible: true, priceLineVisible: false });
                s.setData(d);
            });
        }

        // Bollinger Bands
        if (indicators.bb.enabled) {
            const period = Math.max(2, indicators.bb.periods[0] || 20);
            if (uniqueData.length >= period) {
                const { upper, mid, lower } = calcBB(uniqueData, period, 2);
                const mU = {}, mM = {}, mL = {};
                upper.forEach(p => mU[p.time] = p.value); mid.forEach(p => mM[p.time] = p.value); lower.forEach(p => mL[p.time] = p.value);
                indicatorMaps[`BB`] = { upper: mU, mid: mM, lower: mL, color: '#a855f7' };
                const bU = chart.addLineSeries({ color: '#a855f788', lineWidth: 1, title: 'BB U', crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
                const bM = chart.addLineSeries({ color: '#a855f7', lineWidth: 1, lineStyle: 2, title: 'BB M', crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
                const bL = chart.addLineSeries({ color: '#a855f788', lineWidth: 1, title: 'BB L', crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
                bU.setData(upper); bM.setData(mid); bL.setData(lower);
            }
        }

        // VWAP
        if (indicators.vwap.enabled) {
            const d = calcVWAP(uniqueData);
            if (d.length > 0) {
                const m = {}; d.forEach(p => m[p.time] = p.value); indicatorMaps['VWAP'] = { map: m, color: '#ec4899' };
                const s = chart.addLineSeries({ color: '#ec4899', lineWidth: 2, lineStyle: 1, title: 'VWAP', crosshairMarkerVisible: false, lastValueVisible: true, priceLineVisible: false });
                s.setData(d);
            }
        }

        // Build bar lookup map for tooltip
        const barMap = {};
        uniqueData.forEach(d => barMap[d.time] = d);

        // Crosshair move → tooltip
        chart.subscribeCrosshairMove(param => {
            if (disposed) return;
            if (!param.time || param.panes === undefined && !param.point) {
                setTooltip(null); return;
            }
            const bar = barMap[param.time];
            if (!bar) { setTooltip(null); return; }

            const t = new Date(param.time * 1000);
            const dateStr = t.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

            const inds = [];
            Object.entries(indicatorMaps).forEach(([key, meta]) => {
                if (key === 'BB') {
                    const u = fmtNum(meta.upper[param.time]), m = fmtNum(meta.mid[param.time]), l = fmtNum(meta.lower[param.time]);
                    inds.push({ label: 'BB', value: `${u} / ${m} / ${l}`, color: meta.color, sub: 'upper/mid/lower' });
                } else {
                    const v = fmtNum(meta.map[param.time]);
                    inds.push({ label: key, value: v, color: meta.color });
                }
            });

            setTooltip({ date: dateStr, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, change: ((bar.close - bar.open) / bar.open * 100).toFixed(2), positive: bar.close >= bar.open, inds });
        });

        // Zoom
        if (uniqueData.length > 300) { chart.timeScale().setVisibleRange({ from: uniqueData[uniqueData.length - 300].time, to: uniqueData[uniqueData.length - 1].time }); }
        else { chart.timeScale().fitContent(); }

        chartRef.current = chart;

        // Click handler for drawing mode (uses ref to avoid chart rebuild)
        const clickHandler = (param) => {
            if (!drawingModeRef.current || !param.time || !param.point || disposed) return;
            const priceData = param.seriesPrices?.get(candle);
            const p = typeof priceData === 'object' && priceData !== null ? priceData.close : priceData;
            if (p == null) return;
            setCurrentDrawPoints(prev => {
                const newPt = { time: param.time, value: p };
                const updated = [...prev, newPt];
                if (updated.length >= 2) {
                    const ls = chart.addLineSeries({ color: '#3b82f6', lineWidth: 2, lineStyle: 1, lastValueVisible: false, priceLineVisible: false });
                    ls.setData(updated);
                    drawnLineSeriesRef.current.push(ls);
                    return [];
                }
                return updated;
            });
        };
        chart.subscribeClick(clickHandler);

        // RSI sub-chart
        let rsiChart = null;
        if (hasRSI) {
            const period = indicators.rsi.periods[0] || 14;
            const cont = document.createElement('div'); cont.style.width = '100%';
            chartContainerRef.current.appendChild(cont);
            rsiChart = createChart(cont, {
                width: chartContainerRef.current.clientWidth, height: rsiH,
                layout: { background: { color: '#080e1a' }, textColor: '#64748b' },
                grid: { vertLines: { color: 'rgba(51,65,85,0.2)' }, horzLines: { color: 'rgba(51,65,85,0.2)' } },
                timeScale: { borderColor: '#334155', visible: false },
                rightPriceScale: { borderColor: '#334155', autoScale: false },
                crosshair: { mode: 1 },
            });
            chart.timeScale().subscribeVisibleLogicalRangeChange(r => rsiChart.timeScale().setVisibleLogicalRange(r));
            rsiChart.timeScale().subscribeVisibleLogicalRangeChange(r => chart.timeScale().setVisibleLogicalRange(r));

            const rsiData = calcRSI(uniqueData, period);
            const rsiMap = {}; rsiData.forEach(p => rsiMap[p.time] = p.value);
            indicatorMaps[`RSI${period}`] = { map: rsiMap, color: '#3b82f6' };

            const rs = rsiChart.addLineSeries({ color: '#3b82f6', lineWidth: 2, title: `RSI${period}`, crosshairMarkerVisible: false, lastValueVisible: true, priceLineVisible: false });
            rs.setData(rsiData);
            rs.createPriceLine({ price: 70, color: '#ef444466', lineWidth: 1, lineStyle: 2, title: 'OB' });
            rs.createPriceLine({ price: 30, color: '#10b98166', lineWidth: 1, lineStyle: 2, title: 'OS' });

            rsiChart.subscribeCrosshairMove(param => {
                if (disposed) return;
                if (!param.time) return;
                const v = rsiMap[param.time];
                setTooltip(prev => prev ? { ...prev, rsi: v ? fmtNum(v, 1) : '—' } : null);
            });
        }

        // Use ResizeObserver so chart fills container properly even inside AnimatePresence
        const resizeObserver = new ResizeObserver(entries => {
            if (disposed) return;
            for (const entry of entries) {
                const w = entry.contentRect.width;
                if (w > 0) {
                    chart.applyOptions({ width: w });
                    if (rsiChart) rsiChart.applyOptions({ width: w });
                }
            }
        });
        resizeObserver.observe(chartContainerRef.current);
        // Also handle regular window resize
        const handleResize = () => {
            if (disposed || !chartContainerRef.current) return;
            const w = chartContainerRef.current.offsetWidth;
            if (w > 0) {
                chart.applyOptions({ width: w });
                if (rsiChart) rsiChart.applyOptions({ width: w });
            }
        };
        window.addEventListener('resize', handleResize);
        // Force correct width immediately in case container was animating
        setTimeout(() => handleResize(), 50);
        setTimeout(() => handleResize(), 200);
        return () => {
            disposed = true;
            chart.unsubscribeClick(clickHandler);
            resizeObserver.disconnect();
            window.removeEventListener('resize', handleResize);
            chart.remove();
            if (rsiChart) rsiChart.remove();
        };
    }, [data, localStartDate, localEndDate, markers, indicators, priceLines, fibEnabled, fibHigh, fibLow, fibDir, height, autoAnnotate, tradeAnalysis, annotationVisibility, hiddenCandidates]);

    // Sync drawingMode to ref so click handler always reads latest value
    useEffect(() => { drawingModeRef.current = drawingMode; }, [drawingMode]);

    // ─── Render ───────────────────────────────────────────────────────────────
    const tabStyle = (active) => ({ background: active ? 'rgba(255,255,255,0.08)' : 'transparent', border: 'none', cursor: 'pointer', color: active ? 'var(--text-main)' : 'var(--text-secondary)', padding: '5px 12px', borderRadius: '6px', fontSize: '0.78rem', fontWeight: active ? 'bold' : 'normal', display: 'flex', alignItems: 'center', gap: '5px', transition: 'all 0.2s' });

    return (
        <div className="panel" style={{ position: 'relative', padding: 0, border: '1px solid rgba(59,130,246,0.25)' }}>

            {/* ── Toolbar ── */}
            <div style={{ padding: '0.55rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(11,17,32,0.95)', backdropFilter: 'blur(10px)', gap: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <Filter size={15} color="var(--brand-blue)" />
                    <span style={{ fontWeight: '800', fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--brand-blue)' }}>Terminal</span>
                    <ChevronRight size={12} style={{ opacity: 0.3 }} />
                    <select className="input" value={currentInfo.ticker} onChange={e => handleTickerChange(e.target.value)}
                        style={{ width: 'auto', height: '28px', padding: '0 0.6rem', fontSize: '0.82rem', fontWeight: 'bold', background: 'rgba(59,130,246,0.15)', borderColor: 'rgba(59,130,246,0.35)' }}>
                        {tickers.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <select className="input" value={currentInfo.interval} onChange={e => handleIntervalChange(e.target.value)}
                        style={{ width: 'auto', height: '28px', padding: '0 0.6rem', fontSize: '0.78rem', background: 'rgba(255,255,255,0.05)' }}>
                        {uniqueIntervals.map(i => <option key={i} value={i}>{i}</option>)}
                    </select>
                    <span style={{ fontSize: '0.68rem', opacity: 0.4 }}>Period: <span style={{ color: 'var(--text-main)' }}>{currentInfo.period}</span></span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'rgba(0,0,0,0.3)', padding: '3px 7px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <Calendar size={11} style={{ opacity: 0.5 }} />
                        <input type="date" className="input" value={localStartDate} onChange={e => setLocalStartDate(e.target.value)} style={{ height: '24px', width: '115px', fontSize: '0.7rem', padding: '0 0.3rem', border: 'none', background: 'transparent' }} />
                        <span style={{ opacity: 0.3, fontSize: '0.7rem' }}>–</span>
                        <input type="date" className="input" value={localEndDate} onChange={e => setLocalEndDate(e.target.value)} style={{ height: '24px', width: '115px', fontSize: '0.7rem', padding: '0 0.3rem', border: 'none', background: 'transparent' }} />
                        {(localStartDate || localEndDate) && <button onClick={() => { setLocalStartDate(''); setLocalEndDate(''); }} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--brand-red)', display: 'flex', padding: 0 }}><X size={11} /></button>}
                    </div>
                    <button className={`btn btn-ghost ${drawingMode ? 'active' : ''}`} onClick={() => { setDrawingMode(v => !v); setCurrentDrawPoints([]); }}
                        style={{ height: '28px', padding: '0 0.65rem', fontSize: '0.73rem', gap: '0.25rem', color: drawingMode ? '#10b981' : 'var(--text-secondary)', borderColor: drawingMode ? 'rgba(16,185,129,0.5)' : 'rgba(255,255,255,0.15)' }}>
                        <Pen size={12} /> Draw
                    </button>
                    <button className={`btn btn-ghost ${autoAnnotate ? 'active' : ''}`} onClick={() => setAutoAnnotate(v => !v)}
                        title="Show calculated support, resistance, and pivot trendlines"
                        style={{ height: '28px', padding: '0 0.65rem', fontSize: '0.73rem', gap: '0.25rem', color: autoAnnotate ? '#a855f7' : 'var(--text-secondary)', borderColor: autoAnnotate ? 'rgba(168,85,247,0.5)' : 'rgba(255,255,255,0.15)' }}>
                        <Activity size={12} /> Auto
                    </button>
                    {drawnLineSeriesRef.current.length > 0 && (
                        <button className="btn btn-ghost" onClick={() => {
                            drawnLineSeriesRef.current.forEach(ls => { try { chartRef.current?.removeSeries(ls); } catch {} });
                            drawnLineSeriesRef.current = [];
                            setCurrentDrawPoints([]);
                            setDrawingMode(false);
                        }}
                            style={{ height: '28px', padding: '0 0.65rem', fontSize: '0.73rem', color: 'var(--brand-red)', borderColor: 'rgba(239,68,68,0.3)' }}>
                            <Trash2 size={12} /> Clear
                        </button>
                    )}
                    <button className="btn btn-ghost" onClick={() => setShowIndicators(v => !v)}
                        style={{ height: '28px', padding: '0 0.65rem', fontSize: '0.73rem', gap: '0.25rem', color: 'var(--brand-yellow)', borderColor: 'rgba(234,179,8,0.3)' }}>
                        <Activity size={12} /> TA {showIndicators ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </button>
                    {onClose && <button className="btn btn-ghost" onClick={onClose} style={{ height: '28px', padding: '0 0.65rem', fontSize: '0.73rem', borderColor: 'rgba(239,68,68,0.3)', color: 'var(--brand-red)' }}><X size={12} /> Close</button>}
                </div>
            </div>

            {/* ── TA Panel ── */}
            {showIndicators && (
                <div style={{ background: 'rgba(8,14,26,0.95)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ display: 'flex', gap: '4px', padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <button style={tabStyle(activeTab === 'indicators')} onClick={() => setActiveTab('indicators')}><Activity size={12} /> Indicators</button>
                        <button style={tabStyle(activeTab === 'trendlines')} onClick={() => setActiveTab('trendlines')}><TrendingUp size={12} /> Trendlines</button>
                        <button style={tabStyle(activeTab === 'lines')} onClick={() => setActiveTab('lines')}><TrendingUp size={12} /> S/R Lines</button>
                        <button style={tabStyle(activeTab === 'fib')} onClick={() => setActiveTab('fib')}><GitFork size={12} /> Fibonacci</button>
                    </div>

                    {activeTab === 'indicators' && (
                        <div style={{ padding: '8px 10px', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'flex-start' }}>
                            <IndBlock id="sma" label="SMA" color="#eab308" ind={indicators.sma} hasPeriods onToggle={() => toggleInd('sma')} onAdd={() => addPeriod('sma')} onRemove={i => removePeriod('sma', i)} onUpdate={(i, v) => updatePeriod('sma', i, v)} />
                            <IndBlock id="ema" label="EMA" color="#3b82f6" ind={indicators.ema} hasPeriods onToggle={() => toggleInd('ema')} onAdd={() => addPeriod('ema')} onRemove={i => removePeriod('ema', i)} onUpdate={(i, v) => updatePeriod('ema', i, v)} />
                            <IndBlock id="bb" label="Bollinger Bands" color="#a855f7" ind={indicators.bb} hasPeriods onToggle={() => toggleInd('bb')} onAdd={() => addPeriod('bb')} onRemove={i => removePeriod('bb', i)} onUpdate={(i, v) => updatePeriod('bb', i, v)} />
                            <ToggleChip label="Volume" enabled={indicators.vol.enabled} color="#64748b" onClick={() => toggleInd('vol')} />
                            <ToggleChip label="VWAP" enabled={indicators.vwap.enabled} color="#ec4899" onClick={() => toggleInd('vwap')} />
                            <IndBlock id="rsi" label="RSI (sub-panel)" color="#3b82f6" ind={indicators.rsi} hasPeriods onToggle={() => toggleInd('rsi')} onAdd={() => { }} onRemove={() => { }} onUpdate={(i, v) => updatePeriod('rsi', i, v)} />
                            <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', opacity: 0.5, alignSelf: 'center' }}>Click to toggle · Edit period numbers inline</span>
                        </div>
                    )}

                    {activeTab === 'trendlines' && (
                        <div style={{ padding: '8px 10px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', cursor: 'pointer' }}>
                                    <input 
                                        type="checkbox" 
                                        checked={annotationVisibility.showTrendlines} 
                                        onChange={e => setAnnotationVisibility({...annotationVisibility, showTrendlines: e.target.checked})} 
                                        style={{ accentColor: '#10b981' }} 
                                    />
                                    <span style={{ color: annotationVisibility.showTrendlines ? '#10b981' : 'var(--text-secondary)', fontWeight: annotationVisibility.showTrendlines ? 'bold' : 'normal' }}>Show Auto Trendlines</span>
                                </label>

                                <details style={{ fontSize: '0.75rem', cursor: 'pointer', opacity: 0.8 }}>
                                    <summary style={{ fontWeight: 600, marginBottom: '6px' }}>
                                        Nearby slope candidates ({calculatedTrendlines.supportCandidates?.length || 0} support · {calculatedTrendlines.resistanceCandidates?.length || 0} resistance)
                                        {hiddenCandidates.size > 0 && <span style={{ fontSize: '0.65rem', fontWeight: 400, color: 'var(--text-secondary)' }}> · {hiddenCandidates.size} hidden</span>}
                                    </summary>
                                    
                                    {(calculatedTrendlines.supportCandidates?.length > 0 || calculatedTrendlines.resistanceCandidates?.length > 0) ? (
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '6px', marginTop: '8px', maxHeight: '300px', overflowY: 'auto', paddingRight: '4px' }}>
                                            {[...(calculatedTrendlines.supportCandidates || []), ...(calculatedTrendlines.resistanceCandidates || [])].map((line, idx) => {
                                                const isSupport = calculatedTrendlines.supportCandidates?.includes(line);
                                                const candIdx = isSupport ? calculatedTrendlines.supportCandidates?.indexOf(line) : calculatedTrendlines.resistanceCandidates?.indexOf(line);
                                                const candKey = isSupport ? `sup_${candIdx}` : `res_${candIdx}`;
                                                const isVisible = !hiddenCandidates.has(candKey);
                                                const confColor = line.confidence === 'high' ? '#10b981' : line.confidence === 'medium' ? '#f97316' : '#ef4444';
                                                return (
                                                    <div 
                                                        key={idx} 
                                                        onClick={() => setHiddenCandidates(prev => {
                                                            const next = new Set(prev);
                                                            if (next.has(candKey)) next.delete(candKey);
                                                            else next.add(candKey);
                                                            return next;
                                                        })}
                                                        style={{ 
                                                            background: isVisible ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)', 
                                                            border: `1px solid ${isVisible ? confColor + '66' : confColor + '33'}`, 
                                                            borderRadius: '6px', 
                                                            padding: '6px 8px', 
                                                            fontSize: '0.7rem', 
                                                            lineHeight: '1.4',
                                                            cursor: 'pointer',
                                                            transition: 'all 0.2s',
                                                            boxShadow: isVisible ? `0 0 8px ${confColor}44` : 'none'
                                                        }}
                                                    >
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                                                            <span style={{ width: '12px', height: '12px', borderRadius: '2px', background: confColor, opacity: isVisible ? 1 : 0.5 }} />
                                                            <span style={{ color: confColor, fontWeight: 'bold' }}>{isSupport ? 'support' : 'resistance'}</span>
                                                            <span style={{ color: confColor, fontSize: '0.65rem', textTransform: 'uppercase', fontWeight: 600, marginLeft: 'auto' }}>· {line.confidence}</span>
                                                        </div>
                                                        <div style={{ color: 'var(--text-secondary)', marginBottom: '3px' }}>
                                                            Now {line.price} · {line.distance > 0 ? '+' : ''}{line.distance}% away
                                                        </div>
                                                        <div style={{ color: 'var(--text-secondary)' }}>
                                                            Slope {line.slopePerBar}/bar · {line.touches} touches · {line.violations} violations
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                                <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', opacity: 0.5, marginTop: '4px', textAlign: 'center' }}>
                                                    Click a candidate to hide/show it on chart
                                                </div>
                                            </div>
                                    ) : (
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', opacity: 0.6, fontStyle: 'italic', marginTop: '6px' }}>
                                            Not enough pivot points detected.
                                        </div>
                                    )}
                                </details>

                                {calculatedTrendlines.support && (
                                    <div style={{ background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '8px', padding: '8px 10px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981' }} />
                                            <span style={{ fontSize: '0.8rem', fontWeight: 'bold', color: '#10b981' }}>Support</span>
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '0.75rem' }}>
                                            <div>
                                                <span style={{ color: 'var(--text-secondary)' }}>Level:</span><br/>
                                                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>${calculatedTrendlines.support.price}</span>
                                            </div>
                                            <div>
                                                <span style={{ color: 'var(--text-secondary)' }}>Slope:</span><br/>
                                                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: calculatedTrendlines.support.slope === 'rising' ? '#10b981' : '#ef4444' }}>
                                                    {calculatedTrendlines.support.slope === 'rising' ? '↗' : '↘'} {calculatedTrendlines.support.slope}
                                                </span>
                                            </div>
                                            <div>
                                                <span style={{ color: 'var(--text-secondary)' }}>Distance:</span><br/>
                                                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{calculatedTrendlines.support.distance > 0 ? '+' : ''}{calculatedTrendlines.support.distance}%</span>
                                            </div>
                                            <div>
                                                <span style={{ color: 'var(--text-secondary)' }}>Touches:</span><br/>
                                                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{calculatedTrendlines.support.touches} / {calculatedTrendlines.support.violations} violations</span>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {calculatedTrendlines.resistance && (
                                    <div style={{ background: 'rgba(249, 115, 22, 0.1)', border: '1px solid rgba(249, 115, 22, 0.3)', borderRadius: '8px', padding: '8px 10px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f97316' }} />
                                            <span style={{ fontSize: '0.8rem', fontWeight: 'bold', color: '#f97316' }}>Resistance</span>
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '0.75rem' }}>
                                            <div>
                                                <span style={{ color: 'var(--text-secondary)' }}>Level:</span><br/>
                                                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>${calculatedTrendlines.resistance.price}</span>
                                            </div>
                                            <div>
                                                <span style={{ color: 'var(--text-secondary)' }}>Slope:</span><br/>
                                                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: calculatedTrendlines.resistance.slope === 'rising' ? '#10b981' : '#ef4444' }}>
                                                    {calculatedTrendlines.resistance.slope === 'rising' ? '↗' : '↘'} {calculatedTrendlines.resistance.slope}
                                                </span>
                                            </div>
                                            <div>
                                                <span style={{ color: 'var(--text-secondary)' }}>Distance:</span><br/>
                                                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{calculatedTrendlines.resistance.distance > 0 ? '+' : ''}{calculatedTrendlines.resistance.distance}%</span>
                                            </div>
                                            <div>
                                                <span style={{ color: 'var(--text-secondary)' }}>Touches:</span><br/>
                                                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{calculatedTrendlines.resistance.touches} / {calculatedTrendlines.resistance.violations} violations</span>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {!calculatedTrendlines.support && !calculatedTrendlines.resistance && (
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', opacity: 0.6, fontStyle: 'italic' }}>
                                        Not enough pivot points detected to calculate trendlines. Need at least 40 bars and 2 pivot points per trendline.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'lines' && (
                        <div style={{ padding: '8px 10px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {priceLines.map(line => {
                                    const meta = LINE_TYPE_META[line.type] || LINE_TYPE_META.custom;
                                    return (
                                        <div key={line.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '6px 10px', border: `1px solid ${meta.color}33` }}>
                                            <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                                            <select value={line.type} onChange={e => updateLine(line.id, 'type', e.target.value)}
                                                style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', color: meta.color, fontSize: '0.75rem', padding: '2px 5px', cursor: 'pointer' }}>
                                                <option value="support">Support</option>
                                                <option value="resistance">Resistance</option>
                                                <option value="custom">Custom</option>
                                            </select>
                                            <input type="number" placeholder="Price level" value={line.price} onChange={e => updateLine(line.id, 'price', e.target.value)}
                                                style={{ flex: 1, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', color: 'var(--text-main)', fontSize: '0.78rem', padding: '3px 8px' }} />
                                            <input type="text" placeholder="Label" value={line.label} onChange={e => updateLine(line.id, 'label', e.target.value)}
                                                style={{ width: '90px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', color: 'var(--text-main)', fontSize: '0.75rem', padding: '3px 8px' }} />
                                            <button onClick={() => removeLine(line.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', padding: '2px' }}><X size={13} /></button>
                                        </div>
                                    );
                                })}
                            </div>
                            <button onClick={addLine} className="btn btn-ghost btn-sm" style={{ marginTop: '8px', fontSize: '0.75rem', color: 'var(--brand-blue)', gap: '4px' }}><Plus size={12} /> Add Line</button>
                        </div>
                    )}

                    {activeTab === 'fib' && (
                        <div style={{ padding: '8px 10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.8rem', cursor: 'pointer' }}>
                                    <input type="checkbox" checked={fibEnabled} onChange={e => setFibEnabled(e.target.checked)} style={{ accentColor: '#a855f7' }} />
                                    <span style={{ color: fibEnabled ? '#a855f7' : 'var(--text-secondary)', fontWeight: fibEnabled ? 'bold' : 'normal' }}>Enable Fibonacci</span>
                                </label>
                                {fibEnabled && (
                                    <>
                                        <div style={{ display: 'flex', gap: '4px' }}>
                                            <button onClick={() => setFibDir('bull')} style={{ background: fibDir === 'bull' ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.05)', border: `1px solid ${fibDir === 'bull' ? '#10b981' : 'rgba(255,255,255,0.1)'}`, borderRadius: '5px', cursor: 'pointer', color: fibDir === 'bull' ? '#10b981' : 'var(--text-secondary)', fontSize: '0.75rem', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                                <TrendingUp size={11} /> Bullish
                                            </button>
                                            <button onClick={() => setFibDir('bear')} style={{ background: fibDir === 'bear' ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.05)', border: `1px solid ${fibDir === 'bear' ? '#ef4444' : 'rgba(255,255,255,0.1)'}`, borderRadius: '5px', cursor: 'pointer', color: fibDir === 'bear' ? '#ef4444' : 'var(--text-secondary)', fontSize: '0.75rem', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                                <TrendingDown size={11} /> Bearish
                                            </button>
                                        </div>
                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>High:</span>
                                        <input type="number" value={fibHigh} onChange={e => setFibHigh(e.target.value)} placeholder="e.g. 503.00"
                                            style={{ width: '90px', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', color: 'var(--text-main)', fontSize: '0.78rem', padding: '3px 8px' }} />
                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Low:</span>
                                        <input type="number" value={fibLow} onChange={e => setFibLow(e.target.value)} placeholder="e.g. 420.00"
                                            style={{ width: '90px', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', color: 'var(--text-main)', fontSize: '0.78rem', padding: '3px 8px' }} />
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Chart area + crosshair tooltip ── */}
            <div style={{ position: 'relative', minHeight: `${height}px` }}>
                {drawingMode && (
                    <div style={{ position: 'absolute', top: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: 20, background: 'rgba(16,185,129,0.9)', color: '#fff', padding: '4px 14px', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 'bold', pointerEvents: 'none' }}>
                        Drawing Mode — click on chart to place points (2 clicks = 1 line)
                    </div>
                )}
                <div ref={chartContainerRef} style={{ width: '100%', minHeight: `${height}px`, cursor: drawingMode ? 'crosshair' : 'default' }} />

                {/* Crosshair Tooltip Overlay */}
                {tooltip && (
                    <div style={{
                        position: 'absolute', top: '10px', left: '10px', zIndex: 10, pointerEvents: 'none',
                        background: 'rgba(11,17,32,0.92)', backdropFilter: 'blur(12px)',
                        border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px',
                        padding: '10px 14px', minWidth: '200px', maxWidth: '320px',
                        boxShadow: '0 4px 24px rgba(0,0,0,0.5)'
                    }}>
                        {/* Date + Change */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', gap: '12px' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 'bold' }}>{tooltip.date}</span>
                            <span style={{ fontSize: '0.72rem', fontWeight: 'bold', color: tooltip.positive ? '#10b981' : '#ef4444' }}>
                                {tooltip.positive ? '▲' : '▼'} {Math.abs(tooltip.change)}%
                            </span>
                        </div>

                        {/* OHLCV */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px', marginBottom: '8px' }}>
                            {[
                                { label: 'Open', value: fmtNum(tooltip.open), color: 'var(--text-main)' },
                                { label: 'High', value: fmtNum(tooltip.high), color: '#10b981' },
                                { label: 'Low', value: fmtNum(tooltip.low), color: '#ef4444' },
                                { label: 'Close', value: fmtNum(tooltip.close), color: tooltip.positive ? '#10b981' : '#ef4444' },
                            ].map(({ label, value, color }) => (
                                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', opacity: 0.7 }}>{label}</span>
                                    <span style={{ fontSize: '0.7rem', fontWeight: 'bold', color }}>{value}</span>
                                </div>
                            ))}
                        </div>

                        {/* Volume */}
                        {indicators.vol.enabled && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', opacity: 0.7 }}>Volume</span>
                                <span style={{ fontSize: '0.7rem', fontWeight: 'bold', color: tooltip.positive ? '#10b98199' : '#ef444499' }}>{fmtVol(tooltip.volume)}</span>
                            </div>
                        )}

                        {/* Indicator values */}
                        {tooltip.inds && tooltip.inds.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                {tooltip.inds.map(ind => (
                                    <div key={ind.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                            <div style={{ width: '6px', height: '2px', background: ind.color, borderRadius: '1px' }} />
                                            <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', opacity: 0.8 }}>{ind.label}{ind.sub && <span style={{ opacity: 0.5, fontSize: '0.62rem' }}> {ind.sub}</span>}</span>
                                        </div>
                                        <span style={{ fontSize: '0.7rem', fontWeight: 'bold', color: ind.color }}>{ind.value}</span>
                                    </div>
                                ))}
                                {tooltip.rsi && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginTop: '2px', paddingTop: '4px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                            <div style={{ width: '6px', height: '2px', background: '#3b82f6', borderRadius: '1px' }} />
                                            <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', opacity: 0.8 }}>RSI{indicators.rsi.periods[0]}</span>
                                        </div>
                                        <span style={{ fontSize: '0.7rem', fontWeight: 'bold', color: parseFloat(tooltip.rsi) > 70 ? '#ef4444' : parseFloat(tooltip.rsi) < 30 ? '#10b981' : '#3b82f6' }}>{tooltip.rsi}</span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
            <TradeSetupChecklist
                data={data}
                interval={currentInfo.interval}
                startDate={localStartDate}
                endDate={localEndDate}
                onAnalysisChange={onTradeAnalysisChange}
                compact={height < 450}
            />
        </div>
    );
};

export default ChartViewer;
