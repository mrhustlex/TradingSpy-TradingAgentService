import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { createChart } from 'lightweight-charts';
import { Activity, RefreshCw, ScanSearch, AlertCircle, CheckCircle2, Clock, ChevronDown, HelpCircle, X, BookOpen, Wand2, CandlestickChart } from 'lucide-react';
import { INTELLIGENCE_SERVICE, BACKTEST_SERVICE } from '../config';

const UNIVERSE_PRESETS = [
    { key: 'mag7', label: 'Magnificent 7' },
    { key: 'faang', label: 'FAANG' },
    { key: 'semiconductors', label: 'Semiconductors' },
    { key: 'software', label: 'Software / Cybersecurity' },
    { key: 'banks', label: 'Banks' },
    { key: 'energy', label: 'Energy' },
    { key: 'healthcare', label: 'Healthcare' },
    { key: 'consumer', label: 'Consumer' },
    { key: 'industrials', label: 'Industrials' },
    { key: 'indices', label: 'Indices' },
];

const PATTERN_TYPES = [
    { key: 'vcp', label: 'VCP', color: 'var(--brand-yellow)', full: 'VCP (Volatility Contraction)', what: 'Price keeps compressing into a tighter and tighter range after a base — sellers are exhausted and a breakout is brewing.' },
    { key: 'cup_handle', label: 'Cup & Handle', color: '#4ade80', full: 'Cup & Handle', what: 'A U-shaped base with a small pullback near the top of the cup — a classic continuation pattern before a push higher.' },
    { key: 'bull_flag', label: 'Bull Flag', color: '#60a5fa', full: 'Bull Flag', what: 'A sharp rally (the pole) followed by a tight sideways/down drift (the flag) — a pause before the uptrend resumes.' },
    { key: 'bear_flag', label: 'Bear Flag', color: '#f87171', full: 'Bear Flag', what: 'A sharp drop followed by a tight consolidation — a pause before the downtrend resumes. Good for spotting short setups.' },
];

const PATTERN_LABEL = {
    vcp: 'VCP',
    cup_handle: 'Cup & Handle',
    bull_flag: 'Bull Flag',
    bear_flag: 'Bear Flag',
};

const TUTORIAL_STEPS = [
    {
        title: 'Pick what to scan',
        body: 'Choose a preset universe (a group of stocks like Semiconductors or Magnificent 7), or type your own comma-separated tickers (e.g. AAPL, NVDA, QQQ) to scan a custom list.',
    },
    {
        title: 'Choose the patterns and how strict',
        body: 'Select which chart patterns to look for, pick a timeframe (Daily is a good default), and set the minimum score. A higher score = a tighter, higher-quality setup. Start at ~55 and lower it if nothing shows up.',
    },
    {
        title: 'Click "Scan patterns" and read the results',
        body: 'The scan checks every ticker and takes 20–60 seconds. Matches are ranked by score (higher = stronger). Click Details to see why a stock matched, or Explain to have the assistant walk you through the setup.',
    },
];

const QUICK_START = {
    universe: 'semiconductors',
    customTickers: '',
    interval: '1d',
    selectedPatterns: ['vcp', 'cup_handle', 'bull_flag'],
    minScore: 55,
};

function scoreLabel(score) {
    if (score >= 75) return { label: 'Strong', color: '#4ade80' };
    if (score >= 55) return { label: 'Solid', color: 'var(--brand-yellow)' };
    return { label: 'Early / loose', color: '#94a3b8' };
}

const TRIGGER_COLOR = {
    vcp: '#eab308',
    cup_handle: '#eab308',
    bull_flag: '#60a5fa',
    bear_flag: '#f87171',
};

function MatchChart({ match }) {
    const containerRef = useRef(null);
    const chartRef = useRef(null);

    useEffect(() => {
        if (!containerRef.current || !match?.candles?.length) return;
        const chart = createChart(containerRef.current, {
            layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#cbd5e1', fontFamily: 'inherit' },
            grid: { vertLines: { color: 'rgba(148,163,184,0.12)' }, horzLines: { color: 'rgba(148,163,184,0.12)' } },
            timeScale: { borderColor: 'rgba(148,163,184,0.2)', rightOffset: 4, timeVisible: false },
            rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
            width: containerRef.current.clientWidth,
            height: 300,
        });
        chartRef.current = chart;
        const series = chart.addCandlestickSeries({
            upColor: '#4ade80', downColor: '#f87171',
            wickUpColor: '#4ade80', wickDownColor: '#f87171',
            borderVisible: false,
        });
        series.setData(match.candles
            .map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
            .sort((a, b) => a.time - b.time));
        if (match.markers?.length) series.setMarkers([...match.markers].sort((a, b) => a.time - b.time));
        (match.levels || []).forEach((lv) => {
            series.createPriceLine({
                price: lv.price,
                color: TRIGGER_COLOR[lv.pattern] || '#eab308',
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: `${lv.label} ${lv.pattern === 'bear_flag' ? '↓' : '↑'}`,
            });
        });
        const ro = new ResizeObserver(() => {
            if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
        });
        ro.observe(containerRef.current);
        return () => {
            ro.disconnect();
            chart.remove();
            chartRef.current = null;
        };
    }, [match]);

    if (!match?.candles?.length) {
        return <p className="scanner-chart-empty">No price data returned for a chart.</p>;
    }
    return <div className="scanner-chart" ref={containerRef} />;
}

export default function PatternScanner({ notify, onExplain }) {
    const [universe, setUniverse] = useState('indices');
    const [customTickers, setCustomTickers] = useState('');
    const [interval, setIntervalOpt] = useState('1d');
    const [selectedPatterns, setSelectedPatterns] = useState(['vcp', 'cup_handle', 'bull_flag']);
    const [minScore, setMinScore] = useState(55);
    const [running, setRunning] = useState(false);
    const [status, setStatus] = useState(null); // idle | running | completed | failed
    const [task, setTask] = useState(null);
    const [results, setResults] = useState(null);
    const [expanded, setExpanded] = useState({});
    const [chartTickers, setChartTickers] = useState({});
    const [showHelp, setShowHelp] = useState(() => localStorage.getItem('pattern_scanner_help_dismissed') !== '1');
    const pollRef = useRef(null);

    const dismissHelp = () => {
        setShowHelp(false);
        localStorage.setItem('pattern_scanner_help_dismissed', '1');
    };

    const showHelpAgain = () => {
        localStorage.removeItem('pattern_scanner_help_dismissed');
        setShowHelp(true);
    };

    const togglePattern = (key) => {
        setSelectedPatterns((prev) => prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]);
    };

    const applyQuickStart = () => {
        setUniverse(QUICK_START.universe);
        setCustomTickers(QUICK_START.customTickers);
        setIntervalOpt(QUICK_START.interval);
        setSelectedPatterns([...QUICK_START.selectedPatterns]);
        setMinScore(QUICK_START.minScore);
        setResults(null);
        setExpanded({});
        notify?.('Loaded a quick example: Semiconductors · Daily · VCP/Cup/Bull Flag · min 55. Click Scan to run it.', 'blue');
        // auto-run the example so the user immediately sees the flow
        setTimeout(() => runScan({ universe: QUICK_START.universe, customTickers: '', interval: '1d', patterns: QUICK_START.selectedPatterns, minScore: QUICK_START.minScore }), 300);
    };

    const runScan = async ({ universe: uni, customTickers: custom, interval: iv, patterns, minScore: minScoreVal }) => {
        if (running) return;
        const tickers = (custom || '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
        if (!patterns || !patterns.length) {
            notify?.('Pick at least one pattern to scan for', 'red');
            return;
        }
        setResults(null);
        setExpanded({});
        setRunning(true);
        setStatus('running');
        try {
            const res = await axios.post(`${INTELLIGENCE_SERVICE}/pattern-scan`, {
                universe: tickers.length ? undefined : uni,
                tickers: tickers.length ? tickers : undefined,
                interval: iv,
                patterns,
                min_score: minScoreVal,
                max_results: 25,
            });
            if (res.data?.task_id) {
                setTask(res.data.task_id);
                pollScan(res.data.task_id);
            } else {
                setStatus('failed');
                notify?.('Failed to start pattern scan', 'red');
            }
        } catch (e) {
            setStatus('failed');
            notify?.('Failed to start pattern scan: ' + (e.response?.data?.detail || e.message), 'red');
        }
    };

    const startScan = () => {
        runScan({ universe, customTickers, interval, patterns: selectedPatterns, minScore });
    };

    const pollScan = (taskId) => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
            try {
                const res = await axios.get(`${BACKTEST_SERVICE}/results/${taskId}`);
                const data = res.data;
                if (data.status === 'completed') {
                    clearInterval(pollRef.current);
                    pollRef.current = null;
                    setResults(data.results);
                    setStatus('completed');
                    setRunning(false);
                    notify?.('Pattern scan complete', 'green');
                } else if (data.status === 'failed') {
                    clearInterval(pollRef.current);
                    pollRef.current = null;
                    setStatus('failed');
                    setRunning(false);
                    notify?.(data.error || 'Pattern scan failed', 'red');
                }
            } catch (e) {
                // keep polling; transient errors are common during long scans
            }
        }, 1500);
    };

    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    const toggleExpand = (ticker) => {
        setExpanded((prev) => ({ ...prev, [ticker]: !prev[ticker] }));
    };

    const explainTicker = (ticker, label) => {
        const prompt = `Explain the chart pattern setup for ${ticker} found by the pattern scanner (${label}). Walk through the pattern structure, what would confirm or invalidate it, and where the risk is.`;
        if (onExplain) onExplain(prompt, `Pattern: ${ticker} ${label}`);
    };

    const matches = results?.matches || [];

    return (
        <div className="pattern-scanner">
            <div className="panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <ScanSearch size={20} color="var(--brand-yellow)" />
                    <h2 className="panel-title">Pattern Scanner</h2>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span className="panel-subtitle">VCP · Cup &amp; Handle · Bull/Bear Flags</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowHelp((v) => !v)} title="How to use">
                        <HelpCircle size={15} /> {showHelp ? 'Hide guide' : 'How to use'}
                    </button>
                </div>
            </div>

            {showHelp && (
                <div className="scanner-help card">
                    <div className="scanner-help-head">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <BookOpen size={16} color="var(--brand-yellow)" />
                            <strong>How to use Pattern Scanner</strong>
                        </div>
                        <button className="btn btn-ghost btn-sm" onClick={dismissHelp} title="Dismiss guide"><X size={15} /></button>
                    </div>
                    <ol className="scanner-help-steps">
                        {TUTORIAL_STEPS.map((step, i) => (
                            <li key={i}>
                                <span className="scanner-step-num">{i + 1}</span>
                                <div>
                                    <strong>{step.title}</strong>
                                    <p>{step.body}</p>
                                </div>
                            </li>
                        ))}
                    </ol>
                    <div className="scanner-help-extra">
                        <div className="scanner-glossary">
                            <strong>What each pattern means</strong>
                            <div className="scanner-glossary-list">
                                {PATTERN_TYPES.map((p) => (
                                    <div key={p.key} className="scanner-glossary-item">
                                        <span className="scanner-glossary-dot" style={{ background: p.color }} />
                                        <span className="scanner-glossary-name">{p.label}</span>
                                        <span className="scanner-glossary-what">{p.what}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="scanner-score-scale">
                            <strong>Reading the score</strong>
                            <div className="scanner-score-scale-row"><span style={{ color: '#4ade80' }}>75+ Strong</span><span className="scanner-score-scale-note">tight, high-quality setup</span></div>
                            <div className="scanner-score-scale-row"><span style={{ color: 'var(--brand-yellow)' }}>55–74 Solid</span><span className="scanner-score-scale-note">worth a closer look</span></div>
                            <div className="scanner-score-scale-row"><span style={{ color: '#94a3b8' }}>below 55 Early / loose</span><span className="scanner-score-scale-note">pattern forming but not tight yet</span></div>
                        </div>
                    </div>
                    <div className="scanner-help-cta">
                        <button className="btn btn-primary" onClick={applyQuickStart}>
                            <Wand2 size={15} /> Try an example (Semiconductors)
                        </button>
                        <span className="scanner-help-cta-note">Loads a ready-to-run example so you can see the flow.</span>
                    </div>
                </div>
            )}

            <div className="scanner-controls card">
                <div className="scanner-grid">
                    <label className="scanner-field">
                        <span>Universe</span>
                        <select value={universe} onChange={(e) => setUniverse(e.target.value)} disabled={customTickers.trim().length > 0}>
                            {UNIVERSE_PRESETS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
                        </select>
                        <em className="scanner-field-hint">A preset group of stocks to scan</em>
                    </label>
                    <label className="scanner-field">
                        <span>Custom tickers</span>
                        <input
                            value={customTickers}
                            onChange={(e) => setCustomTickers(e.target.value)}
                            placeholder="AAPL, NVDA, QQQ"
                        />
                        <em className="scanner-field-hint">Comma-separated. Overrides the universe.</em>
                    </label>
                    <label className="scanner-field">
                        <span>Interval</span>
                        <select value={interval} onChange={(e) => setIntervalOpt(e.target.value)}>
                            <option value="1d">Daily</option>
                            <option value="1h">1 Hour</option>
                            <option value="1wk">Weekly</option>
                        </select>
                        <em className="scanner-field-hint">Daily is the default for swing setups</em>
                    </label>
                    <label className="scanner-field">
                        <span>Min score: {minScore}</span>
                        <input type="range" min="40" max="80" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
                        <em className="scanner-field-hint">Higher = stricter, fewer but tighter matches</em>
                    </label>
                </div>
                <div className="scanner-patterns">
                    <span className="scanner-patterns-label">Patterns to look for:</span>
                    {PATTERN_TYPES.map((p) => (
                        <button
                            key={p.key}
                            className={`pattern-chip ${selectedPatterns.includes(p.key) ? 'selected' : ''}`}
                            style={selectedPatterns.includes(p.key) ? { borderColor: p.color, color: p.color } : {}}
                            onClick={() => togglePattern(p.key)}
                            title={p.what}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>
                <div className="scanner-actions">
                    <button className="btn btn-primary" onClick={startScan} disabled={running}>
                        {running ? <><RefreshCw size={16} className="spin" /> Scanning…</> : <><Activity size={16} /> Scan patterns</>}
                    </button>
                    {status === 'completed' && results && (
                        <span className="scanner-summary">
                            <CheckCircle2 size={15} color="#4ade80" /> {matches.length} of {results.scanned} tickers matched
                        </span>
                    )}
                    {status === 'failed' && (
                        <span className="scanner-summary" style={{ color: '#f87171' }}>
                            <AlertCircle size={15} /> Scan failed
                        </span>
                    )}
                    {status === 'running' && (
                        <span className="scanner-summary" style={{ color: 'var(--brand-yellow)' }}>
                            <Clock size={15} /> Scanning… task {task?.slice(-8)}
                        </span>
                    )}
                </div>
            </div>

            {status === 'idle' && !results && (
                <div className="scanner-empty card">
                    <ScanSearch size={28} color="var(--brand-yellow)" />
                    <p>No scan yet. Pick a universe (or type tickers), choose patterns, and hit <strong>Scan patterns</strong>.</p>
                    <p className="scanner-empty-sub">New here? Open the <em>How to use</em> guide above or click <em>Try an example</em>.</p>
                </div>
            )}

            {results && (
                <div className="scanner-results">
                    <div className="scanner-results-head">
                        <span>{matches.length} match(es)</span>
                        <span className="scanner-results-meta">min score {results.min_score} · {results.interval} · {results.scanned} scanned</span>
                    </div>
                    {matches.length === 0 && (
                        <div className="scanner-empty card">
                            <AlertCircle size={22} />
                            <p>No matches at score {results.min_score}. Try lowering the min score, picking more patterns, or a wider universe.</p>
                            <div className="scanner-empty-actions">
                                <button className="btn btn-ghost" onClick={() => setMinScore(Math.max(40, results.min_score - 10))}>Lower score to {Math.max(40, results.min_score - 10)} and rescan</button>
                                <button className="btn btn-ghost" onClick={applyQuickStart}>Try the example universe</button>
                            </div>
                        </div>
                    )}
                    {matches.map((match) => (
                        <div key={match.ticker} className="scanner-match card">
                            <div className="scanner-match-top">
                                <div className="scanner-match-ticker">{match.ticker}</div>
                                <div className="scanner-match-patterns">
                                    {match.patterns.map((p) => {
                                        const meta = PATTERN_TYPES.find((t) => t.key === p.pattern);
                                        return (
                                            <span key={p.pattern} className="scanner-match-badge" style={{ color: meta?.color || 'var(--brand-yellow)' }}>
                                                {PATTERN_LABEL[p.pattern] || p.pattern} · {p.score} <span className="scanner-badge-grade">({scoreLabel(p.score).label})</span>
                                            </span>
                                        );
                                    })}
                                </div>
                                <button className="btn btn-ghost btn-sm" onClick={() => explainTicker(match.ticker, PATTERN_LABEL[match.best_pattern])}>Explain</button>
                                <button className="btn btn-ghost btn-sm" onClick={() => setChartTickers((prev) => ({ ...prev, [match.ticker]: !prev[match.ticker] }))}>
                                    <CandlestickChart size={14} /> {chartTickers[match.ticker] ? 'Hide chart' : 'Chart'}
                                </button>
                            </div>
                            <div className="scanner-match-meta">
                                <span>Close: ${match.last_close?.toLocaleString?.() ?? match.last_close}</span>
                                <span>Vol: {match.last_volume?.toLocaleString?.() ?? '—'}</span>
                                <span>Best: {PATTERN_LABEL[match.best_pattern]} ({match.best_score})</span>
                                <button className="btn btn-ghost btn-sm" onClick={() => toggleExpand(match.ticker)}>
                                    {expanded[match.ticker] ? 'Collapse' : 'Details'} <ChevronDown size={14} style={{ transform: expanded[match.ticker] ? 'rotate(180deg)' : 'none' }} />
                                </button>
                            </div>
                            {expanded[match.ticker] && (
                                <div className="scanner-match-details">
                                    {match.patterns.map((p) => {
                                        const meta = PATTERN_TYPES.find((t) => t.key === p.pattern);
                                        return (
                                            <div key={p.pattern} className="scanner-pattern-detail">
                                                <div className="scanner-pattern-detail-head">
                                                    <strong style={{ color: meta?.color || 'var(--brand-yellow)' }}>
                                                        {PATTERN_LABEL[p.pattern] || p.pattern}
                                                    </strong>
                                                    <span>score {p.score} · {scoreLabel(p.score).label}</span>
                                                </div>
                                                {meta?.what && <p className="scanner-pattern-what">{meta.what}</p>}
                                                <p className="scanner-pattern-reason">{p.reason}</p>
                                                {p.detail && (
                                                    <div className="scanner-pattern-metrics">
                                                        {Object.entries(p.detail).filter(([k]) => k !== 'markers').map(([k, v]) => (
                                                            <span key={k} className="scanner-metric"><em>{k}</em>{typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}</span>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {chartTickers[match.ticker] && (
                                <div className="scanner-chart-wrap">
                                    <div className="scanner-chart-legend">
                                        <span><span className="scanner-chart-key" style={{ background: '#4ade80' }} />up</span>
                                        <span><span className="scanner-chart-key" style={{ background: '#f87171' }} />down</span>
                                        <span><span className="scanner-chart-key scanner-chart-key-dash" />trigger</span>
                                        <span className="scanner-chart-hint">Dots mark the pattern's key points (base, pivot, handle, flag).</span>
                                    </div>
                                    <MatchChart match={match} />
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <style>{`
                .pattern-scanner { padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }
                .panel-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; }
                .panel-title { margin: 0; font-size: 1.25rem; }
                .panel-subtitle { font-size: 0.8rem; opacity: 0.7; }
                .scanner-controls { padding: 1rem; }
                .scanner-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.9rem; }
                .scanner-field { display: flex; flex-direction: column; gap: 0.3rem; }
                .scanner-field > span { font-size: 0.75rem; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.04em; }
                .scanner-field select, .scanner-field input[type=text], .scanner-field input {
                    padding: 0.5rem 0.6rem; border-radius: 8px; border: 1px solid var(--border, #333); background: var(--bg-input, #1a1f2e); color: var(--text, #eee);
                }
                .scanner-field-hint { font-style: normal; font-size: 0.72rem; opacity: 0.55; }
                .scanner-patterns { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.9rem; }
                .scanner-patterns-label { font-size: 0.75rem; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.04em; }
                .pattern-chip {
                    padding: 0.35rem 0.7rem; border-radius: 999px; border: 1px solid var(--border, #333);
                    background: transparent; color: var(--text-muted, #999); cursor: pointer; font-size: 0.8rem;
                }
                .pattern-chip.selected { border-width: 1.5px; }
                .scanner-actions { display: flex; align-items: center; gap: 1rem; margin-top: 1rem; flex-wrap: wrap; }
                .scanner-summary { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.85rem; }
                .scanner-results { display: flex; flex-direction: column; gap: 0.7rem; }
                .scanner-results-head { display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; font-weight: 600; }
                .scanner-results-meta { font-weight: 400; opacity: 0.7; }
                .scanner-empty { padding: 1.5rem; text-align: center; opacity: 0.9; display: flex; flex-direction: column; align-items: center; gap: 0.4rem; }
                .scanner-empty p { margin: 0; }
                .scanner-empty-sub { opacity: 0.65; font-size: 0.85rem; }
                .scanner-empty-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; justify-content: center; }
                .scanner-match { padding: 0.85rem 1rem; }
                .scanner-match-top { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
                .scanner-match-ticker { font-weight: 700; font-size: 1.05rem; letter-spacing: 0.02em; }
                .scanner-match-patterns { display: flex; gap: 0.4rem; flex-wrap: wrap; flex: 1; }
                .scanner-match-badge { font-size: 0.78rem; font-weight: 600; padding: 0.2rem 0.5rem; border-radius: 6px; background: rgba(127,127,127,0.08); }
                .scanner-badge-grade { font-weight: 400; opacity: 0.7; }
                .scanner-match-meta { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-top: 0.5rem; font-size: 0.8rem; opacity: 0.75; }
                .scanner-match-details { margin-top: 0.7rem; border-top: 1px dashed var(--border, #333); padding-top: 0.6rem; display: flex; flex-direction: column; gap: 0.8rem; }
                .scanner-chart-wrap { margin-top: 0.8rem; border-top: 1px dashed var(--border, #333); padding-top: 0.6rem; }
                .scanner-chart { width: 100%; height: 300px; border-radius: 8px; overflow: hidden; }
                .scanner-chart-empty { font-size: 0.8rem; opacity: 0.7; }
                .scanner-chart-legend { display: flex; align-items: center; gap: 0.9rem; flex-wrap: wrap; font-size: 0.75rem; opacity: 0.8; margin-bottom: 0.4rem; }
                .scanner-chart-legend span { display: inline-flex; align-items: center; gap: 0.3rem; }
                .scanner-chart-key { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
                .scanner-chart-key-dash { height: 0; border-top: 2px dashed var(--brand-yellow); width: 14px; border-radius: 0; }
                .scanner-chart-hint { margin-left: auto; opacity: 0.55; }
                .scanner-pattern-detail-head { display: flex; justify-content: space-between; font-size: 0.85rem; }
                .scanner-pattern-what { margin: 0.3rem 0 0; font-size: 0.8rem; opacity: 0.75; }
                .scanner-pattern-reason { margin: 0.2rem 0 0.4rem; font-size: 0.8rem; opacity: 0.85; }
                .scanner-pattern-metrics { display: flex; flex-wrap: wrap; gap: 0.4rem; }
                .scanner-metric { font-size: 0.7rem; opacity: 0.7; background: rgba(127,127,127,0.08); padding: 0.15rem 0.4rem; border-radius: 5px; }
                .scanner-metric em { font-style: normal; font-weight: 600; margin-right: 0.25rem; }
                .spin { animation: pattern-spin 1s linear infinite; }
                @keyframes pattern-spin { to { transform: rotate(360deg); } }
                .btn-sm { padding: 0.25rem 0.55rem; font-size: 0.75rem; }
                .scanner-help { padding: 1rem 1.1rem; }
                .scanner-help-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
                .scanner-help-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.7rem; }
                .scanner-help-steps li { display: flex; gap: 0.6rem; align-items: flex-start; }
                .scanner-step-num {
                    flex: 0 0 22px; height: 22px; border-radius: 50%; background: rgba(255, 203, 40, 0.15);
                    color: var(--brand-yellow); font-weight: 700; font-size: 0.78rem; display: flex; align-items: center; justify-content: center; margin-top: 0.1rem;
                }
                .scanner-help-steps p { margin: 0.15rem 0 0; font-size: 0.82rem; opacity: 0.75; }
                .scanner-help-extra { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; margin-top: 0.9rem; border-top: 1px dashed var(--border, #333); padding-top: 0.8rem; }
                .scanner-glossary, .scanner-score-scale { font-size: 0.82rem; }
                .scanner-glossary-list { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.4rem; }
                .scanner-glossary-item { display: flex; align-items: baseline; gap: 0.45rem; flex-wrap: wrap; }
                .scanner-glossary-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; align-self: center; }
                .scanner-glossary-name { font-weight: 600; white-space: nowrap; }
                .scanner-glossary-what { font-size: 0.78rem; opacity: 0.7; }
                .scanner-score-scale-row { display: flex; gap: 0.5rem; align-items: baseline; margin-top: 0.3rem; }
                .scanner-score-scale-note { font-size: 0.76rem; opacity: 0.65; }
                .scanner-help-cta { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.9rem; flex-wrap: wrap; }
                .scanner-help-cta-note { font-size: 0.78rem; opacity: 0.6; }
            `}</style>
        </div>
    );
}
