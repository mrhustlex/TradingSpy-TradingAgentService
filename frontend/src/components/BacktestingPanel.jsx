import React, { useState, useEffect, Suspense, lazy } from 'react';
import axios from 'axios';
import Papa from 'papaparse';
import { FileCode, ShieldCheck, Activity, TrendingDown, RefreshCw, Cpu, TrendingUp, List, X, Download, Code, Layers } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { DATA_SERVICE, BACKTEST_SERVICE } from '../config';
import { formatDatasetName } from '../utils/formatters';
import AnimatedProgressIndicator from './AnimatedProgressIndicator';

const ChartViewer = lazy(() => import('./ChartViewer'));
const MAX_BATTLE_STRATEGIES = 5;

const BacktestingPanel = ({ files, strategies, onTrigger, tasks, onAnalyze }) => {
    const [selectedFile, setSelectedFile] = useState('');
    const [selectedStrats, setSelectedStrats] = useState([]);
    const [stakeRange, setStakeRange] = useState('10, 30, 50, 70, 90, 95');
    const [trailRange, setTrailRange] = useState('0.0, 0.05, 0.10, 0.15');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [loading, setLoading] = useState(false);
    const [expandedStrategy, setExpandedStrategy] = useState(null);
    const [viewingCode, setViewingCode] = useState(null);
    const [stratSearch, setStratSearch] = useState('');
    const [chartData, setChartData] = useState(null);
    const [chartMarkers, setChartMarkers] = useState([]);
    const [chartFileName, setChartFileName] = useState('');
    const [collapsedGroups, setCollapsedGroups] = useState({});
    const [sequential, setSequential] = useState(false);
    const [initialCash, setInitialCash] = useState(100000);
    const [commission, setCommission] = useState(0.001);

    // Group files by ticker
    const groupedFiles = files.reduce((acc, f) => {
        const ticker = f.split('-')[0].toUpperCase();
        if (!acc[ticker]) acc[ticker] = [];
        acc[ticker].push(f);
        return acc;
    }, {});

    // Parse granularity from filename
    const parseGranularity = (filename) => {
        const parts = filename.split('-');
        return parts.length >= 2 ? parts[1] : 'unknown';
    };

    // Get display label for granularity
    const getGranularityLabel = (granularity) => {
        const labels = {
            '1m': '1 Min',
            '5m': '5 Min',
            '15m': '15 Min',
            '30m': '30 Min',
            '1h': '1 Hour',
            '4h': '4 Hour',
            '1d': 'Daily',
            '1wk': 'Weekly',
            '1mo': 'Monthly'
        };
        return labels[granularity] || granularity.toUpperCase();
    };

    // Auto-default dates when file changes
    useEffect(() => {
        if (!selectedFile) return;
        const fetchMeta = async () => {
            try {
                const res = await axios.get(`${DATA_SERVICE}/data/${selectedFile}/meta`);
                if (res.data.start && res.data.end) {
                    setStartDate(res.data.start);
                    setEndDate(res.data.end);
                }
            } catch (e) {
                console.error("Failed to fetch metadata", e);
            }
        };
        fetchMeta();
    }, [selectedFile]);

    // Find if there's an active task for the current selection or just the latest backtest
    const activeTask = tasks.find(t => t.type === 'backtest' && t.status === 'running');
    const latestBacktest = tasks.find(t => t.type === 'backtest' && (t.status === 'completed' || t.status === 'running'));

    // Use completed results OR partial results if running
    // Ensure we only show results for the task that is currently relevant
    const results = (activeTask && activeTask.progressData?.partial_results)
        ? activeTask.progressData.partial_results
        : (latestBacktest?.status === 'completed' ? latestBacktest.results : null);

    const startBacktest = async () => {
        if (!selectedFile || selectedStrats.length === 0) return;
        if (selectedStrats.length > MAX_BATTLE_STRATEGIES) {
            alert(`Select ${MAX_BATTLE_STRATEGIES} strategies or fewer for one battle. Split larger comparisons into batches.`);
            return;
        }

        // Validation: End Date cannot be before Start Date
        if (startDate && endDate && startDate > endDate) {
            alert("Validation Error: End Date cannot be before Start Date.");
            return;
        }

        setLoading(true);
        try {
            const sRange = stakeRange.split(',').map(s => parseInt(s.trim())).filter(s => !isNaN(s));
            const tRange = trailRange.split(',').map(t => parseFloat(t.trim())).filter(t => !isNaN(t));

            const res = await axios.post(`${BACKTEST_SERVICE}/backtest`, {
                dataset_filename: selectedFile,
                strategies: selectedStrats,
                stake_range: sRange.length ? sRange : null,
                trail_range: tRange.length ? tRange : null,
                start_date: startDate || null,
                end_date: endDate || null,
                sequential: sequential,
                initial_cash: initialCash,
                commission: commission
            });
            onTrigger(res.data.task_id, `${sequential ? 'Sequential' : 'Parallel'} Battle: ${selectedFile} (${selectedStrats.length} strats)`);
        } catch (e) {
            alert("Error starting backtest");
        }
        setLoading(false);
    };

    const toggleSelectedStrategy = (strategyName) => {
        setSelectedStrats(prev => {
            if (prev.includes(strategyName)) return prev.filter(x => x !== strategyName);
            if (prev.length >= MAX_BATTLE_STRATEGIES) {
                alert(`Battle selection is capped at ${MAX_BATTLE_STRATEGIES} strategies for speed.`);
                return prev;
            }
            return [...prev, strategyName];
        });
    };

    const toggleSelectedStrategyGroup = (strategyItems) => {
        setSelectedStrats(prev => {
            const names = strategyItems.map(s => s.name);
            const allPresent = names.every(n => prev.includes(n));
            if (allPresent) return prev.filter(n => !names.includes(n));
            const remaining = Math.max(0, MAX_BATTLE_STRATEGIES - prev.length);
            if (remaining === 0) {
                alert(`Battle selection is capped at ${MAX_BATTLE_STRATEGIES} strategies for speed.`);
                return prev;
            }
            return [...new Set([...prev, ...names.filter(n => !prev.includes(n)).slice(0, remaining)])];
        });
    };

    const downloadResults = () => {
        if (!results) return;

        const data = {
            dataset: latestBacktest.dataset_filename || selectedFile,
            timestamp: new Date().toISOString(),
            description: latestBacktest.description,
            results: results,
            config: {
                stake_range: stakeRange,
                trail_range: trailRange,
                start_date: startDate,
                end_date: endDate
            }
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `backtest_${selectedFile}_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const viewStrategyCode = async (strategyName) => {
        // First check if it's in the current forged results (in memory)
        if (results) {
            const forgedMatch = results.find(s => s.strategy === strategyName);
            if (forgedMatch && forgedMatch.code) {
                setViewingCode({ name: strategyName, code: forgedMatch.code });
                return;
            }
        }

        try {
            const headers = await getAuthHeader();
            const res = await axios.get(`${BACKTEST_SERVICE}/strategies`, { headers });
            const strat = res.data.strategies.find(s => s.name === strategyName);
            if (strat && strat.code) {
                setViewingCode({ name: strategyName, code: strat.code });
            }
        } catch (e) {
            console.error('Failed to fetch strategy code:', e);
        }
    };

    const handleInlineAnalyze = async (filename, markers) => {
        setLoading(true);
        try {
            const now = new Date().getTime();
            const headers = await getAuthHeader();
            const res = await axios.get(`${DATA_SERVICE}/data/${filename}?t=${now}`, { headers });
            const parsed = Papa.parse(res.data, {
                header: true,
                skipEmptyLines: true,
                transformHeader: h => h.trim()
            });

            setChartData(parsed.data);
            setChartMarkers(markers);
            setChartFileName(filename);

            // Scroll to chart
            setTimeout(() => {
                const el = document.getElementById('inline-chart-anchor');
                if (el) el.scrollIntoView({ behavior: 'smooth' });
            }, 100);
        } catch (e) {
            console.error("Error loading inline chart:", e);
        }
        setLoading(false);
    };

    return (
        <div>
            <h1 style={{ marginBottom: '2rem' }}>Deep Battle Runner</h1>

            <div className="panel">
                <div className="form-row">
                    <div className="form-group">
                        <h3>1. Select Dataset</h3>
                        <p style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: '1rem' }}>Choose a ticker and granularity for backtesting</p>
                        
                        {Object.keys(groupedFiles).length === 0 ? (
                            <select className="input" style={{ marginTop: '0.5rem' }} disabled>
                                <option value="">No datasets available</option>
                            </select>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {Object.entries(groupedFiles)
                                    .sort(([a], [b]) => a.localeCompare(b))
                                    .map(([ticker, tickerFiles]) => {
                                        // Sort files by granularity
                                        const sortedFiles = [...tickerFiles].sort((a, b) => {
                                            const order = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1wk', '1mo'];
                                            const granA = parseGranularity(a);
                                            const granB = parseGranularity(b);
                                            return order.indexOf(granA) - order.indexOf(granB);
                                        });

                                        return (
                                            <div key={ticker} style={{
                                                padding: '1rem',
                                                background: selectedFile && selectedFile.startsWith(ticker.toLowerCase()) ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                                                borderRadius: '8px',
                                                border: selectedFile && selectedFile.startsWith(ticker.toLowerCase()) ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid rgba(255, 255, 255, 0.05)'
                                            }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                                                    <h4 style={{ margin: 0, color: 'var(--brand-blue)', fontSize: '1rem' }}>{ticker}</h4>
                                                    <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>{tickerFiles.length} dataset{tickerFiles.length > 1 ? 's' : ''}</span>
                                                </div>
                                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                                    {sortedFiles.map(file => {
                                                        const granularity = parseGranularity(file);
                                                        const isSelected = selectedFile === file;
                                                        return (
                                                            <button
                                                                key={file}
                                                                className={`btn ${isSelected ? 'btn-primary' : 'btn-ghost'}`}
                                                                style={{
                                                                    fontSize: '0.85rem',
                                                                    padding: '0.5rem 1rem',
                                                                    minWidth: '80px',
                                                                    background: isSelected ? 'var(--brand-blue)' : 'rgba(59, 130, 246, 0.05)',
                                                                    color: isSelected ? 'white' : 'var(--brand-blue)',
                                                                    border: `1px solid ${isSelected ? 'var(--brand-blue)' : 'rgba(59, 130, 246, 0.2)'}`,
                                                                }}
                                                                onClick={() => setSelectedFile(file)}
                                                            >
                                                                {getGranularityLabel(granularity)}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })}
                            </div>
                        )}
                        
                        {selectedFile && (
                            <div style={{
                                marginTop: '1rem',
                                padding: '0.75rem',
                                background: 'rgba(16, 185, 129, 0.1)',
                                borderRadius: '6px',
                                border: '1px solid rgba(16, 185, 129, 0.2)',
                                fontSize: '0.85rem',
                                color: 'var(--brand-green)'
                            }}>
                                ✓ Selected: <strong>{formatDatasetName(selectedFile)}</strong>
                            </div>
                        )}
                    </div>
                    <div className="form-group">
                        <h3>2. Strategies</h3>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                                <p style={{ fontSize: '0.8rem', opacity: 0.6, margin: 0 }}>
                                    Select multiple strategies - they'll run in parallel
                                </p>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <button className="btn btn-ghost btn-xs" onClick={() => setSelectedStrats([])} style={{ fontSize: '0.7rem' }}>Clear All ({selectedStrats.length})</button>
                                    <button
                                        className="btn btn-ghost btn-xs"
                                        style={{ fontSize: '0.7rem' }}
                                        onClick={() => {
                                            const allTickers = [...new Set(strategies.map(s => s.ticker || 'General'))];
                                            const anyExpanded = allTickers.some(t => !collapsedGroups[t]);
                                            if (anyExpanded) {
                                                const newCollapsed = {};
                                                allTickers.forEach(t => newCollapsed[t] = true);
                                                setCollapsedGroups(newCollapsed);
                                            } else {
                                                setCollapsedGroups({});
                                            }
                                        }}
                                    >
                                        {Object.keys(collapsedGroups).length > 0 ? 'Expand All' : 'Collapse All'}
                                    </button>
                                </div>
                            </div>
                            <input
                                className="input"
                                style={{ width: '180px', height: '28px', fontSize: '0.75rem' }}
                                placeholder="Search Arsenal..."
                                value={stratSearch}
                                onChange={(e) => setStratSearch(e.target.value)}
                            />
                        </div>
                        <div style={{ marginTop: '0.5rem' }}>
                            {Object.entries(strategies.reduce((acc, s) => {
                                if (stratSearch && !s.name.toLowerCase().includes(stratSearch.toLowerCase())) return acc;
                                const t = s.ticker || 'General';
                                if (!acc[t]) acc[t] = [];
                                acc[t].push(s);
                                return acc;
                            }, {}))
                                .sort(([a], [b]) => {
                                    if (selectedFile && selectedFile.includes(a)) return -1;
                                    if (selectedFile && selectedFile.includes(b)) return 1;
                                    if (a === 'General') return -1;
                                    if (b === 'General') return 1;
                                    return a.localeCompare(b);
                                })
                                .map(([ticker, groupStrats]) => {
                                    const isCurrentTicker = selectedFile && selectedFile.includes(ticker);
                                    const isCollapsed = collapsedGroups[ticker];
                                    return (
                                        <div key={ticker} style={{ marginBottom: '1rem', background: isCurrentTicker ? 'rgba(59, 130, 246, 0.03)' : 'transparent', borderRadius: '8px', padding: isCurrentTicker ? '0.5rem' : '0' }}>
                                            <div style={{
                                                fontSize: '0.75rem',
                                                fontWeight: 'bold',
                                                textTransform: 'uppercase',
                                                color: isCurrentTicker ? 'var(--brand-blue)' : 'var(--text-secondary)',
                                                marginBottom: '0.4rem',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '0.4rem',
                                                justifyContent: 'space-between',
                                                cursor: 'pointer',
                                                padding: '0.4rem',
                                                background: isCurrentTicker ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                                                borderRadius: '6px',
                                                border: isCurrentTicker ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid transparent'
                                            }} onClick={() => setCollapsedGroups(prev => ({ ...prev, [ticker]: !prev[ticker] }))}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                    <Layers size={12} style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.2s' }} />
                                                    {ticker} {isCurrentTicker && '(Matches Ticker)'}
                                                    <span style={{ opacity: 0.5, fontSize: '0.7rem', fontWeight: 'normal' }}>({groupStrats.length})</span>
                                                </div>
                                                <div style={{ display: 'flex', gap: '0.5rem' }} onClick={e => e.stopPropagation()}>
                                                    <button
                                                        className="btn btn-ghost btn-xs"
                                                        style={{ fontSize: '0.65rem' }}
                                                        onClick={() => toggleSelectedStrategyGroup(groupStrats)}
                                                    >
                                                        {groupStrats.every(n => selectedStrats.includes(n.name)) ? 'Unselect Group' : 'Select Group'}
                                                    </button>
                                                </div>
                                            </div>
                                            {!isCollapsed && (
                                                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', padding: '0.2rem' }}>
                                                    {groupStrats.map(s => (
                                                        <div
                                                            key={s.name}
                                                            className={`nav-link ${selectedStrats.includes(s.name) ? 'active' : ''}`}
                                                            style={{
                                                                border: '1px solid rgba(255,255,255,0.1)',
                                                                width: 'auto',
                                                                padding: '0.4rem 0.8rem',
                                                                fontSize: '0.85rem',
                                                                marginBottom: 0,
                                                                opacity: (!isCurrentTicker && ticker !== 'General') ? 0.7 : 1,
                                                                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
                                                            }}
                                                            onClick={() => toggleSelectedStrategy(s.name)}
                                                        >
                                                            {s.is_custom ? <FileCode size={14} style={{ marginRight: '0.4rem' }} /> : <ShieldCheck size={14} style={{ marginRight: '0.4rem' }} />}
                                                            {s.name}
                                                        </div>
                                                    ))}
                                                </motion.div>
                                            )}
                                        </div>
                                    );
                                })}
                        </div>
                    </div>
                </div>

                <div className="form-row" style={{ marginTop: '2rem', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '2rem' }}>
                    <div className="form-group">
                        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Activity size={18} /> Optimization: Stake Range</h3>
                        <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>Comma-separated % values (e.g. 10, 50, 95)</p>
                        <input className="input" value={stakeRange} onChange={e => setStakeRange(e.target.value)} />
                    </div>
                    <div className="form-group">
                        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><TrendingDown size={18} /> Optimization: T-Stop Range</h3>
                        <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>Comma-separated decimal values (e.g. 0.02, 0.10)</p>
                        <input className="input" value={trailRange} onChange={e => setTrailRange(e.target.value)} />
                    </div>
                </div>

                <div className="form-row" style={{ marginTop: '1.5rem' }}>
                    <div className="form-group">
                        <h3>Backtest Start Date</h3>
                        <input type="date" className="input" value={startDate} onChange={e => setStartDate(e.target.value)} />
                    </div>
                    <div className="form-group">
                        <h3>Backtest End Date</h3>
                        <input type="date" className="input" value={endDate} onChange={e => setEndDate(e.target.value)} />
                    </div>
                </div>

                <div className="form-row" style={{ marginTop: '1.5rem' }}>
                    <div className="form-group">
                        <h3>Initial Cash ($)</h3>
                        <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>Starting capital for the backtest</p>
                        <input type="number" className="input" min="1" step="1000" value={initialCash} onChange={e => setInitialCash(parseFloat(e.target.value) || 100000)} />
                    </div>
                    <div className="form-group">
                        <h3>Commission (decimal)</h3>
                        <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>Per-trade fee, e.g. 0.001 = 0.1%</p>
                        <input type="number" className="input" min="0" step="0.0001" value={commission} onChange={e => setCommission(parseFloat(e.target.value) || 0)} />
                    </div>
                </div>

                {activeTask && (
                    <AnimatedProgressIndicator
                        label={sequential ? "⚡ Sequential Battle" : "⚡ Parallel Battle"}
                        detail={activeTask.progressData?.current || "Executing strategies..."}
                        progress={activeTask.progressData?.progress}
                        status="running"
                        variant="card"
                        size="medium"
                    />
                )}

                <div style={{ marginTop: '2rem', display: 'flex', alignItems: 'center', gap: '0.75rem', paddingLeft: '0.5rem' }}>
                    <input
                        type="checkbox"
                        id="sequential-toggle"
                        style={{ width: '18px', height: '18px' }}
                        checked={sequential}
                        onChange={(e) => setSequential(e.target.checked)}
                    />
                    <label htmlFor="sequential-toggle" style={{ fontSize: '0.9rem', cursor: 'pointer', userSelect: 'none' }}>
                        <strong>Low CPU Mode</strong> (Run sequentially instead of parallel)
                    </label>
                </div>

                <button
                    className="btn btn-primary"
                    style={{ marginTop: '2rem', width: '100%', height: '50px', fontSize: '1.1rem' }}
                    onClick={startBacktest}
                    disabled={loading || activeTask}
                >
                    {loading || activeTask ? <RefreshCw className="animate-spin" size={20} /> : (sequential ? <Activity size={20} /> : <Cpu size={20} />)}
                    {activeTask ? (sequential ? 'Sequential Battle in Progress...' : 'Parallel Battle in Progress...') :
                        sequential ? `Commence Sequential Battle (${selectedStrats.length} strategies)` : `Commence Parallel Battle (${selectedStrats.length} strategies)`}
                </button>
            </div>

            <div id="inline-chart-anchor" style={{ marginTop: '2rem' }}>
                <AnimatePresence>
                    {chartData && (
                        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <Activity color="var(--brand-blue)" /> Performance Visualization
                                </h2>
                            </div>
                            <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center', opacity: 0.6 }}>Loading chart...</div>}>
                              <ChartViewer
                                  data={chartData}
                                  markers={chartMarkers}
                                  fileName={chartFileName}
                                  allFiles={files}
                                  height={580}
                                  defaultShowIndicators={false}
                                  onClose={() => setChartData(null)}
                              />
                            </Suspense>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <AnimatePresence>
                {results && (
                    <motion.div className="panel" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
                            <TrendingUp color="#10b981" />
                            <h2>
                                {activeTask ? "Live Battle Results" : `Latest Battle Results (${latestBacktest.description})`}
                            </h2>
                            {activeTask && (
                                <div style={{
                                    fontSize: '0.75rem',
                                    background: 'rgba(59, 130, 246, 0.2)',
                                    color: 'var(--brand-blue)',
                                    padding: '0.25rem 0.6rem',
                                    borderRadius: '12px',
                                    border: '1px solid var(--brand-blue)',
                                    fontWeight: 'bold',
                                    animation: 'pulse 2s infinite'
                                }}>
                                    LIVE UPDATES
                                </div>
                            )}
                            {!activeTask && (
                                <div style={{
                                    fontSize: '0.75rem',
                                    background: 'rgba(16, 185, 129, 0.1)',
                                    color: 'var(--brand-green)',
                                    padding: '0.25rem 0.5rem',
                                    borderRadius: '4px',
                                    border: '1px solid rgba(16, 185, 129, 0.2)'
                                }}>
                                    Parallel Execution
                                </div>
                            )}
                        </div>

                        {/* Action Buttons */}
                        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
                            <button
                                className="btn btn-ghost btn-sm"
                                onClick={downloadResults}
                                style={{ color: 'var(--brand-blue)' }}
                            >
                                <Download size={14} /> Export JSON
                            </button>
                        </div>

                        {/* Summary Table */}
                        <table className="table">
                            <thead>
                                <tr><th>#</th><th>Strategy</th><th>ROI %</th><th>Sharpe</th><th>Win Rate</th><th>Trades</th><th>Max DD</th><th>Actions</th></tr>
                            </thead>
                            <tbody>
                                {results.map((r, i) => (
                                    <tr key={r.strategy}>
                                        <td>#{i + 1}</td>
                                        <td>
                                            <strong>{r.strategy}</strong>
                                            {(r.statistics?.total_trades || 0) === 0 && (
                                                <span className="badge badge-yellow" style={{ marginLeft: '0.45rem', fontSize: '0.62rem' }}>No trades</span>
                                            )}
                                        </td>
                                        <td style={{ color: r.roi >= 0 ? 'var(--brand-green)' : 'var(--brand-red)' }}>{r.roi.toFixed(2)}%</td>
                                        <td>{r.statistics?.sharpe_ratio || 'N/A'}</td>
                                        <td>{r.statistics?.win_rate || 0}%</td>
                                        <td>{(r.statistics?.total_trades || 0) === 0 ? '0 - inactive' : r.statistics?.total_trades}</td>
                                        <td style={{ color: 'var(--brand-red)' }}>{r.statistics?.max_drawdown || 0}%</td>
                                        <td style={{ display: 'flex', gap: '0.5rem' }}>
                                            <button
                                                className="btn btn-ghost btn-sm"
                                                onClick={() => handleInlineAnalyze(latestBacktest.dataset_filename || selectedFile, r.markers)}
                                                style={{ color: 'var(--brand-blue)' }}
                                            >
                                                <Activity size={14} /> Chart
                                            </button>
                                            <button
                                                className="btn btn-ghost btn-sm"
                                                onClick={() => setExpandedStrategy(expandedStrategy === r.strategy ? null : r.strategy)}
                                                style={{ color: 'var(--brand-green)' }}
                                            >
                                                <List size={14} /> Details
                                            </button>
                                            <button
                                                className="btn btn-ghost btn-sm"
                                                onClick={() => viewStrategyCode(r.strategy)}
                                                style={{ color: 'var(--brand-yellow)' }}
                                            >
                                                <Code size={14} /> Code
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {/* Detailed Statistics for Expanded Strategy */}
                        <AnimatePresence>
                            {expandedStrategy && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    style={{ marginTop: '2rem', overflow: 'hidden' }}
                                >
                                    {(() => {
                                        const strategy = results.find(r => r.strategy === expandedStrategy);
                                        if (!strategy || !strategy.statistics) return null;

                                        const stats = strategy.statistics;
                                        return (
                                            <div className="panel" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--brand-blue)' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                                                    <h3 style={{ color: 'var(--brand-blue)' }}>Detailed Analysis: {strategy.strategy}</h3>
                                                    <button
                                                        className="btn btn-ghost btn-sm"
                                                        onClick={() => setExpandedStrategy(null)}
                                                        style={{ color: 'var(--text-secondary)' }}
                                                    >
                                                        <X size={16} />
                                                    </button>
                                                </div>

                                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem' }}>
                                                    {/* Performance Metrics */}
                                                    <div>
                                                        <h4 style={{ marginBottom: '1rem', color: 'var(--brand-green)' }}>Performance</h4>
                                                        <div className="stats-grid">
                                                            <div className="stat-item">
                                                                <span className="stat-label">Total Return</span>
                                                                <span className={`stat-value ${stats.total_return >= 0 ? 'positive' : 'negative'}`}>
                                                                    {stats.total_return}%
                                                                </span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Sharpe Ratio</span>
                                                                <span className="stat-value">{Number(stats.sharpe_ratio).toFixed(2)}</span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Max Drawdown</span>
                                                                <span className="stat-value negative">{Number(stats.max_drawdown).toFixed(2)}%</span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Profit Factor</span>
                                                                <span className="stat-value">{Number(stats.profit_factor).toFixed(2)}</span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Trade Statistics */}
                                                    <div>
                                                        <h4 style={{ marginBottom: '1rem', color: 'var(--brand-blue)' }}>Trade Analysis</h4>
                                                        <div className="stats-grid">
                                                            <div className="stat-item">
                                                                <span className="stat-label">Total Trades</span>
                                                                <span className="stat-value">{stats.total_trades}</span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Win Rate</span>
                                                                <span className="stat-value positive">{Number(stats.win_rate).toFixed(2)}%</span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Winning Trades</span>
                                                                <span className="stat-value positive">{stats.winning_trades}</span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Losing Trades</span>
                                                                <span className="stat-value negative">{stats.losing_trades}</span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Win/Loss Analysis */}
                                                    <div>
                                                        <h4 style={{ marginBottom: '1rem', color: 'var(--brand-yellow)' }}>Win/Loss Profile</h4>
                                                        <div className="stats-grid">
                                                            <div className="stat-item">
                                                                <span className="stat-label">Avg Win</span>
                                                                <span className="stat-value positive">${Number(stats.avg_win).toFixed(2)}</span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Avg Loss</span>
                                                                <span className="stat-value negative">${Number(stats.avg_loss).toFixed(2)}</span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Payoff Ratio</span>
                                                                <span className="stat-value">{Number(stats.payoff_ratio).toFixed(2)}</span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Gross Profit</span>
                                                                <span className="stat-value positive">${Number(stats.gross_profit).toFixed(2)}</span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Configuration */}
                                                    <div>
                                                        <h4 style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>Optimal Config</h4>
                                                        <div className="stats-grid">
                                                            <div className="stat-item">
                                                                <span className="stat-label">Stake Size</span>
                                                                <span className="stat-value">{strategy.best_config.stake}%</span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Trailing Stop</span>
                                                                <span className="stat-value">{(strategy.best_config.trail * 100).toFixed(1)}%</span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Total PnL</span>
                                                                <span className={`stat-value ${stats.total_pnl >= 0 ? 'positive' : 'negative'}`}>
                                                                    ${Number(stats.total_pnl).toFixed(2)}
                                                                </span>
                                                            </div>
                                                            <div className="stat-item">
                                                                <span className="stat-label">Commission</span>
                                                                <span className="stat-value negative">${Number(stats.total_commission).toFixed(2)}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Trade List */}
                                                {strategy.markers && strategy.markers.length > 0 && (
                                                    <div style={{ marginTop: '2rem' }}>
                                                        <h4 style={{ marginBottom: '1rem' }}>Trade Signals ({strategy.markers.length})</h4>
                                                        <div style={{
                                                            maxHeight: '200px',
                                                            overflowY: 'auto',
                                                            background: 'rgba(0,0,0,0.2)',
                                                            borderRadius: '6px',
                                                            padding: '1rem'
                                                        }}>
                                                            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 80px 100px 80px 100px 120px', gap: '0.5rem', fontSize: '0.8deg' }}>
                                                                <div style={{ fontWeight: 'bold', opacity: 0.7 }}>Time</div>
                                                                <div style={{ fontWeight: 'bold', opacity: 0.7 }}>Type</div>
                                                                <div style={{ fontWeight: 'bold', opacity: 0.7 }}>Price</div>
                                                                <div style={{ fontWeight: 'bold', opacity: 0.7 }}>Order</div>
                                                                <div style={{ fontWeight: 'bold', opacity: 0.7 }}>Total Pos</div>
                                                                <div style={{ fontWeight: 'bold', opacity: 0.7 }}>Equity</div>
                                                                {strategy.markers.map((marker, idx) => (
                                                                    <React.Fragment key={idx}>
                                                                        <div style={{ fontSize: '0.75rem' }}>{marker.time}</div>
                                                                        <div style={{ color: marker.type === 'Buy' ? 'var(--brand-green)' : 'var(--brand-red)', fontWeight: 'bold' }}>
                                                                            {marker.type}
                                                                        </div>
                                                                        <div>${marker.price.toFixed(2)}</div>
                                                                        <div style={{ opacity: 0.8 }}>{marker.size}</div>
                                                                        <div style={{ color: marker.pos_size !== 0 ? 'var(--brand-blue)' : 'inherit', fontWeight: marker.pos_size !== 0 ? 'bold' : 'normal' }}>
                                                                            {marker.pos_size}
                                                                        </div>
                                                                        <div style={{ fontSize: '0.75rem', opacity: 0.9 }}>
                                                                            ${marker.value ? marker.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A'}
                                                                        </div>
                                                                    </React.Fragment>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })()}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Strategy Code Viewer */}
            <AnimatePresence>
                {viewingCode && (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 20 }}
                        className="panel"
                        style={{ marginTop: '2rem', border: '1px solid var(--brand-yellow)' }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                            <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <Code size={20} style={{ color: 'var(--brand-yellow)' }} />
                                Strategy Code: {viewingCode.name}
                            </h2>
                            <button
                                className="btn btn-ghost"
                                onClick={() => setViewingCode(null)}
                                style={{ color: 'var(--text-secondary)' }}
                            >
                                <X size={18} /> Close
                            </button>
                        </div>
                        <pre style={{
                            background: 'rgba(0,0,0,0.4)',
                            padding: '1.5rem',
                            borderRadius: '8px',
                            overflow: 'auto',
                            maxHeight: '500px',
                            fontSize: '0.85rem',
                            lineHeight: '1.6',
                            border: '1px solid rgba(255,255,255,0.1)'
                        }}>
                            <code>{viewingCode.code}</code>
                        </pre>
                    </motion.div>
                )}
            </AnimatePresence>
        </div >
    );
};

export default BacktestingPanel;
