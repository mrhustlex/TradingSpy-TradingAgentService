import React, { useState, useEffect, Suspense, lazy } from 'react';
import axios from 'axios';
import { RefreshCw, List, Trash2, X, Activity, TrendingUp, TrendingDown, Code, ShieldCheck, FileCode, CheckCircle, AlertCircle, Wand2, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Papa from 'papaparse';
import { BACKTEST_SERVICE, DATA_SERVICE } from '../config';
import { formatDatasetName } from '../utils/formatters';
import { getApiSettings } from '../utils/apiKeyHelper';

const ChartViewer = lazy(() => import('./ChartViewer'));


const ResultsHistory = ({ onAnalyze, notify, files = [], onTrigger, onRefreshStrats, onOpenInTerminal, onSwitchTab }) => {
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(false);
    const [selectedResult, setSelectedResult] = useState(null);
    const [viewingChartFor, setViewingChartFor] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const resultsPerPage = 10;

    const [detailPage, setDetailPage] = useState(1);
    const detailsPerPage = 10;

    const [chartData, setChartData] = useState(null);
    const [chartMarkers, setChartMarkers] = useState([]);
    const [chartFileName, setChartFileName] = useState('');
    const [expandedStrategy, setExpandedStrategy] = useState(null);
    const [viewingCode, setViewingCode] = useState(null);

    // Evolution States
    const [evolvingStrategy, setEvolvingStrategy] = useState(null);
    const [evolutionInstruction, setEvolutionInstruction] = useState('');
    const [evolvedCode, setEvolvedCode] = useState('');
    const [isEvolving, setIsEvolving] = useState(false);

    const fetchHistory = async () => {
        setLoading(true);
        try {
            const res = await axios.get(`${BACKTEST_SERVICE}/history`);
            setHistory(res.data.history);
        } catch (e) {
            notify("Error loading results history", 'red');
        }
        setLoading(false);
    };

    const deleteResult = async (resultId) => {
        if (!window.confirm('Delete this result from history?')) return;
        try {
            await axios.delete(`${BACKTEST_SERVICE}/history/${resultId}`);
            notify("Result deleted from history", 'blue');
            fetchHistory();
            if (selectedResult?.id === resultId) setSelectedResult(null);
        } catch (e) {
            notify("Error deleting result", 'red');
        }
    };

    const viewDetails = async (result) => {
        console.log('Viewing details for:', result.id);
        setSelectedResult(result);
        setChartData(null);
        setExpandedStrategy(null);
        try {
            const res = await axios.get(`${BACKTEST_SERVICE}/results/${result.id}`);
            if (res.data) {
                setSelectedResult(prev => ({ ...prev, ...res.data }));
            }
        } catch (e) {
            // Fallback to history data is fine
        }
    };

    const handleInlineAnalyze = async (filename, markers) => {
        if (!filename) { notify("No dataset available", 'yellow'); setLoading(false); return; }
        setLoading(true);
        try {
            const now = new Date().getTime();
            const res = await axios.get(`${DATA_SERVICE}/data/${filename}?t=${now}`);
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
                const el = document.getElementById('history-chart-anchor');
                if (el) el.scrollIntoView({ behavior: 'smooth' });
            }, 100);
        } catch (e) {
            console.error("Error loading inline chart:", e);
            notify("Error loading chart data", 'red');
        }
        setLoading(false);
    };

    const viewStrategyCode = async (strategyName) => {
        if (selectedResult && selectedResult.results) {
            const match = selectedResult.results.find(r => r.strategy === strategyName);
            if (match && match.code) {
                setViewingCode({ name: strategyName, code: match.code });
                return;
            }
        }

        try {
            const res = await axios.get(`${BACKTEST_SERVICE}/strategies/${encodeURIComponent(strategyName)}`);
            if (res.data && res.data.code) {
                setViewingCode({ name: strategyName, code: res.data.code });
            } else {
                notify("Strategy code not found", 'yellow');
            }
        } catch (e) {
            console.error('Failed to fetch strategy code:', e);
            notify("Failed to fetch code", 'red');
        }
    };

    const handleEvolve = async () => {
        if (!evolutionInstruction) return;
        setIsEvolving(true);

        const { provider, model, api_key, provider_config } = getApiSettings();

        try {
            const res = await axios.post(`${BACKTEST_SERVICE}/strategies/ai-edit`, {
                name: evolvingStrategy.name,
                code: evolvedCode || evolvingStrategy.code,
                instruction: evolutionInstruction,
                api_key,
                provider,
                model,
                provider_config,
            });
            setEvolvedCode(res.data.code);
            notify("AI successfully evolved the logic!", "green");
        } catch (e) {
            notify(e.response?.data?.detail || "AI Evolution failed", "red");
        }
        setIsEvolving(false);
    };

    const handleRerun = async (newCode, originalName) => {
        if (!selectedResult) { notify("No result selected", "red"); return; }
        try {
            const variantName = `${originalName} Evolved ${new Date().getTime().toString().slice(-4)}`;
            const className = newCode.match(/class\s+(\w+)\s*\(/)?.[1] || 'EvolvedStrategy';

            // 1. Save as new strategy
            await axios.post(`${BACKTEST_SERVICE}/strategies/custom`, {
                name: variantName,
                code: newCode,
                class_name: className,
                ticker: (selectedResult.dataset || '').split('-')[0]?.toUpperCase() || 'General',
                description: `Evolved from ${originalName} via History.`
            });

            // 2. Refresh library
            onRefreshStrats();

            // 3. Trigger new backtest
            const res = await axios.post(`${BACKTEST_SERVICE}/backtest`, {
                dataset_filename: selectedResult.dataset,
                strategies: [variantName],
                stake_range: selectedResult.config?.stake_range || [30, 70, 95],
                trail_range: selectedResult.config?.trail_range || [0.0, 0.10],
                start_date: selectedResult.config?.start_date,
                end_date: selectedResult.config?.end_date
            });

            onTrigger(res.data.task_id, `Evolved Re-run: ${variantName}`);
            notify(`Strategy secured and rerun triggered: ${variantName}`, 'blue');
            setEvolvingStrategy(null);
        } catch (e) {
            console.error(e);
            notify("Failed to initiate rerun", "red");
        }
    };

    const cloneToLibrary = async (stratName, code) => {
        try {
            const newName = `${stratName} (Fork)`;
            const className = code.match(/class\s+(\w+)\s*\(/)?.[1] || 'ClonedStrategy';

            await axios.post(`${BACKTEST_SERVICE}/strategies/custom`, {
                name: newName,
                code: code,
                class_name: className,
                ticker: 'General',
                description: `Imported from Backtest History.`
            });
            onRefreshStrats();
            notify(`Strategy "${newName}" added to your arsenal!`, 'green');
            if (onSwitchTab) onSwitchTab('ai');
        } catch (e) {
            notify("Cloning failed", "red");
        }
    };

    useEffect(() => {
        fetchHistory();
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 5rem)' }}>
            <h1 style={{ marginBottom: '1rem', marginTop: 0, flexShrink: 0 }}>Results History</h1>

            <div style={{ display: 'flex', gap: '1rem', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                {/* Left Panel: Search + Results List */}
                <div style={{ width: '340px', minWidth: '340px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '1rem', margin: 0, overflow: 'hidden' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                            <h2 style={{ margin: 0, fontSize: '0.9rem' }}>Past Backtests</h2>
                            <button className="btn btn-ghost btn-xs" onClick={fetchHistory} disabled={loading} style={{ padding: '0.25rem' }} title="Refresh backtest history">
                                <RefreshCw className={loading ? 'animate-spin' : ''} size={14} />
                            </button>
                        </div>
                        <input
                            className="input"
                            style={{ height: '28px', fontSize: '0.75rem', padding: '0 0.5rem', marginBottom: '0.5rem' }}
                            placeholder="Search by dataset..."
                            value={searchTerm}
                            onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                        />

                        {history.length === 0 && !loading && (
                            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem', fontSize: '0.85rem' }}>
                                No backtest history yet.
                            </p>
                        )}

                        <div style={{ flex: 1, overflowY: 'auto' }}>
                            {(() => {
                                const filtered = history.filter(h => h.dataset.toLowerCase().includes(searchTerm.toLowerCase()));
                                const totalPages = Math.ceil(filtered.length / resultsPerPage);
                                const currentHistory = filtered.slice((currentPage - 1) * resultsPerPage, currentPage * resultsPerPage);

                                return (
                                    <>
                                        {currentHistory.map(result => (
                                            <div
                                                key={result.id}
                                                className="panel"
                                                style={{
                                                    padding: '0.6rem 0.75rem',
                                                    margin: '0 0 0.35rem',
                                                    background: selectedResult?.id === result.id ? 'rgba(59,130,246,0.15)' : 'rgba(0,0,0,0.2)',
                                                    border: selectedResult?.id === result.id ? '1px solid var(--brand-blue)' : '1px solid transparent',
                                                    cursor: 'pointer'
                                                }}
                                                onClick={() => { viewDetails(result); setDetailPage(1); }}
                                            >
                                                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--brand-blue)' }}>{formatDatasetName(result.dataset)}</div>
                                                <div style={{ fontSize: '0.65rem', opacity: 0.6, marginTop: '0.15rem' }}>
                                                    {new Date(result.timestamp).toLocaleString()} · {result.summary?.total_strategies || 0} strats
                                                </div>
                                                <div style={{ fontSize: '0.7rem', marginTop: '0.25rem' }}>
                                                    <span style={{ color: 'var(--brand-green)' }}>
                                                        Best: {result.summary?.best_roi?.toFixed(2) || '0.00'}%
                                                    </span>
                                                    <span style={{ opacity: 0.5, marginLeft: '0.5rem' }}>
                                                        Avg: {result.summary?.avg_roi?.toFixed(2) || '0.00'}%
                                                    </span>
                                                </div>
                                                <div style={{ marginTop: '0.3rem', display: 'flex', justifyContent: 'flex-end' }}>
                                                    <button
                                                        className="btn btn-ghost btn-xs"
                                                        onClick={(e) => { e.stopPropagation(); deleteResult(result.id); }}
                                                        style={{ color: 'var(--brand-red)', padding: '0.15rem 0.3rem', fontSize: '0.65rem' }}
                                                        title="Delete result"
                                                    >
                                                        <Trash2 size={10} />
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                        {totalPages > 1 && (
                                            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.35rem', marginTop: '0.5rem', alignItems: 'center', fontSize: '0.7rem' }}>
                                                <button className="btn btn-ghost btn-xs" disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)} title="Previous page">Prev</button>
                                                <span style={{ opacity: 0.6 }}>{currentPage} / {totalPages}</span>
                                                <button className="btn btn-ghost btn-xs" disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)} title="Next page">Next</button>
                                            </div>
                                        )}
                                    </>
                                );
                            })()}
                        </div>
                    </div>
                </div>

                {/* Right Panel: Detail View */}
                <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
                    {selectedResult ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="panel"
                            style={{ border: '1px solid var(--brand-blue)', margin: 0, overflow: 'hidden' }}
                        >
                            <div id="history-chart-anchor">
                                <AnimatePresence>
                                    {chartData && (
                                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ marginBottom: '1.5rem' }}>
                                            <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center', opacity: 0.6 }}>Loading chart...</div>}>
                                              <ChartViewer
                                                  data={chartData}
                                                  markers={chartMarkers}
                                                  fileName={chartFileName}
                                                  allFiles={files}
                                                  height={400}
                                                  defaultShowIndicators={false}
                                                  onClose={() => setChartData(null)}
                                              />
                                            </Suspense>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                                <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Detailed Results: {formatDatasetName(selectedResult.dataset)}</h2>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <button
                                        className="btn btn-sm"
                                        onClick={() => {
                                            const bestResult = selectedResult.results?.find(r => r.strategy === selectedResult.summary?.best_strategy);
                                            onOpenInTerminal?.({
                                                dataset: selectedResult.dataset,
                                                markers: bestResult?.markers || [],
                                                strategies: selectedResult.strategies || [],
                                                results: selectedResult.results || [],
                                                summary: selectedResult.summary || {}
                                            });
                                        }}
                                        style={{ color: 'var(--brand-blue)', borderColor: 'var(--brand-blue)', fontSize: '0.75rem' }}
                                        title="Open this dataset in Battle Station"
                                    >
                                        <Activity size={14} /> Open in Battle Station
                                    </button>
                                    <button
                                        className="btn btn-ghost btn-xs"
                                        onClick={() => setSelectedResult(null)}
                                        style={{ color: 'var(--text-secondary)' }}
                                        title="Close detail view"
                                    >
                                        <X size={16} />
                                    </button>
                                </div>
                            </div>

                            <div style={{ marginBottom: '1.25rem', padding: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', fontSize: '0.8rem' }}>
                                <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.85rem' }}>Configuration</h4>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.5rem' }}>
                                    <div>Strategies: {selectedResult.strategies?.join(', ') || 'N/A'}</div>
                                    <div>Date Range: {selectedResult.config?.start_date || 'All'} to {selectedResult.config?.end_date || 'All'}</div>
                                    <div>Stake Range: {selectedResult.config?.stake_range?.join(', ') || 'Default'}</div>
                                    <div>Trail Range: {selectedResult.config?.trail_range?.join(', ') || 'Default'}</div>
                                </div>
                            </div>

                            {(() => {
                                const totalPages = Math.ceil(selectedResult.results.length / detailsPerPage);
                                const currentDetails = selectedResult.results.slice((detailPage - 1) * detailsPerPage, detailPage * detailsPerPage);

                                return (
                                    <>
                                        <div style={{ overflowX: 'auto' }}>
                                        <table className="table" style={{ fontSize: '0.78rem', minWidth: '700px' }}>
                                            <thead>
                                                <tr><th>#</th><th>Strategy</th><th>ROI %</th><th>Sharpe</th><th>Win Rate</th><th>Trades</th><th>Max DD</th><th>Actions</th></tr>
                                            </thead>
                                            <tbody>
                                                {currentDetails.map((r, i) => (
                                                    <tr key={r.strategy}>
                                                        <td>#{(detailPage - 1) * detailsPerPage + i + 1}</td>
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
                                                        <td style={{ display: 'flex', gap: '0.3rem' }}>
                                                            <button
                                                                className="btn btn-ghost btn-xs"
                                                                onClick={() => handleInlineAnalyze(selectedResult.dataset, r.markers)}
                                                                style={{ color: 'var(--brand-blue)' }}
                                                                title="View Chart"
                                                            >
                                                                <Activity size={12} />
                                                            </button>
                                                            <button
                                                                className="btn btn-ghost btn-xs"
                                                                onClick={() => setExpandedStrategy(expandedStrategy === r.strategy ? null : r.strategy)}
                                                                style={{ color: 'var(--brand-green)' }}
                                                                title="Stats"
                                                            >
                                                                <List size={12} />
                                                            </button>
                                                            <button
                                                                className="btn btn-ghost btn-xs"
                                                                onClick={async () => {
                                                                    const match = (selectedResult.results || []).find(res => res.strategy === r.strategy);
                                                                    let code = match?.code;
                                                                    if (!code) {
                                                                        try {
                                                                            const res = await axios.get(`${BACKTEST_SERVICE}/strategies/${encodeURIComponent(r.strategy)}`);
                                                                            code = res.data?.code;
                                                                        } catch (_) {}
                                                                    }
                                                                    if (code) {
                                                                        setEvolvingStrategy({ name: r.strategy, code });
                                                                        setEvolvedCode(code);
                                                                        setEvolutionInstruction('');
                                                                    } else {
                                                                        notify("Source code unavailable", "red");
                                                                    }
                                                                }}
                                                                style={{ color: 'var(--brand-blue)' }}
                                                                title="AI Evolve & Rerun"
                                                            >
                                                                <RefreshCw size={12} />
                                                            </button>
                                                            <button
                                                                className="btn btn-ghost btn-xs"
                                                                onClick={() => viewStrategyCode(r.strategy)}
                                                                style={{ color: 'var(--brand-yellow)' }}
                                                                title="View Code"
                                                            >
                                                                <Code size={12} />
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        </div>
                                        {totalPages > 1 && (
                                            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.35rem', marginTop: '0.75rem', alignItems: 'center', fontSize: '0.75rem' }}>
                                                <button className="btn btn-ghost btn-xs" disabled={detailPage === 1} onClick={() => setDetailPage(p => p - 1)} title="Previous page">Prev</button>
                                                <span style={{ opacity: 0.6 }}>{detailPage} / {totalPages}</span>
                                                <button className="btn btn-ghost btn-xs" disabled={detailPage === totalPages} onClick={() => setDetailPage(p => p + 1)} title="Next page">Next</button>
                                            </div>
                                        )}

                                        <AnimatePresence>
                                            {expandedStrategy && (
                                                <motion.div
                                                    initial={{ opacity: 0, height: 0 }}
                                                    animate={{ opacity: 1, height: 'auto' }}
                                                    exit={{ opacity: 0, height: 0 }}
                                                    style={{ marginTop: '1.5rem', overflow: 'hidden' }}
                                                >
                                                    {(() => {
                                                        const strategy = selectedResult.results.find(r => r.strategy === expandedStrategy);
                                                        if (!strategy || !strategy.statistics) return null;

                                                        const stats = strategy.statistics;
                                                        return (
                                                            <div className="panel" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--brand-blue)', padding: '1rem' }}>
                                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                                                    <h3 style={{ margin: 0, color: 'var(--brand-blue)', fontSize: '0.95rem' }}>Detailed Analysis: {strategy.strategy}</h3>
                                                                </div>

                                                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
                                                                    <div>
                                                                        <h4 style={{ margin: '0 0 0.35rem', color: 'var(--brand-green)', fontSize: '0.85rem' }}>Performance</h4>
                                                                        <div style={{ display: 'grid', gap: '0.3rem', fontSize: '0.8rem' }}>
                                                                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>ROI</span><span style={{ color: stats.total_return >= 0 ? 'var(--brand-green)' : 'var(--brand-red)' }}>{stats.total_return}%</span></div>
                                                                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Sharpe</span><span>{stats.sharpe_ratio}</span></div>
                                                                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Max DD</span><span style={{ color: 'var(--brand-red)' }}>{stats.max_drawdown}%</span></div>
                                                                        </div>
                                                                    </div>
                                                                    <div>
                                                                        <h4 style={{ margin: '0 0 0.35rem', color: 'var(--brand-blue)', fontSize: '0.85rem' }}>Trades</h4>
                                                                        <div style={{ display: 'grid', gap: '0.3rem', fontSize: '0.8rem' }}>
                                                                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Total</span><span>{stats.total_trades}</span></div>
                                                                            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Win Rate</span><span style={{ color: 'var(--brand-green)' }}>{stats.win_rate}%</span></div>
                                                                        </div>
                                                                    </div>
                                                                </div>

                                                                {strategy.markers && strategy.markers.length > 0 && (
                                                                    <div style={{ marginTop: '1.5rem' }}>
                                                                        <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.85rem' }}>Trade History</h4>
                                                                        <div style={{ maxHeight: '250px', overflow: 'auto', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', padding: '0.75rem' }}>
                                                                            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(80px,1.2fr) minmax(45px,55px) minmax(60px,80px) minmax(70px,100px) minmax(70px,100px) minmax(80px,115px)', gap: '0.35rem', fontSize: '0.72rem' }}>
                                                                                <div style={{ opacity: 0.5 }}>Time</div>
                                                                                <div style={{ opacity: 0.5 }}>Type</div>
                                                                                <div style={{ opacity: 0.5 }}>Price</div>
                                                                                <div style={{ opacity: 0.5 }}>Order</div>
                                                                                <div style={{ opacity: 0.5 }}>Total Pos</div>
                                                                                <div style={{ opacity: 0.5 }}>Equity</div>
                                                                                {strategy.markers.map((marker, idx) => (
                                                                                    <React.Fragment key={idx}>
                                                                                        <div style={{ fontSize: '0.68rem' }}>{marker.time}</div>
                                                                                        <div style={{ color: marker.type === 'Buy' ? 'var(--brand-green)' : 'var(--brand-red)', fontWeight: 'bold' }}>{marker.type}</div>
                                                                                        <div>${typeof marker.price === 'number' ? marker.price.toFixed(2) : marker.price}</div>
                                                                                        <div style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{typeof marker.size === 'number' ? marker.size.toFixed(2) : marker.size}</div>
                                                                                        <div style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{typeof marker.pos_size === 'number' ? marker.pos_size.toFixed(2) : marker.pos_size}</div>
                                                                                        <div style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>${marker.value?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
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
                                    </>
                                );
                            })()}
                        </motion.div>
                    ) : (
                        <div className="panel" style={{ margin: 0, textAlign: 'center', padding: '3rem', opacity: 0.5 }}>
                            <Activity size={32} style={{ margin: '0 auto 1rem', opacity: 0.3 }} />
                            <p style={{ fontSize: '0.95rem' }}>Select a backtest result to view details</p>
                        </div>
                    )}
                </div>
            </div>

            <AnimatePresence>
                {viewingCode && (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 20 }}
                        className="modal-overlay"
                        onClick={() => setViewingCode(null)}
                    >
                        <motion.div
                            className="panel"
                            style={{ width: '80%', maxWidth: '900px', border: '1px solid var(--brand-yellow)', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
                            onClick={e => e.stopPropagation()}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                                <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <Code size={20} style={{ color: 'var(--brand-yellow)' }} />
                                    Strategy Code: {viewingCode.name}
                                </h2>
                                <div style={{ display: 'flex', gap: '1rem' }}>
                                    <button
                                        className="btn btn-primary btn-sm"
                                        onClick={() => cloneToLibrary(viewingCode.name, viewingCode.code)}
                                    >
                                        <FileCode size={14} /> Clone to Forge
                                    </button>
                                    <button className="btn btn-ghost" onClick={() => setViewingCode(null)} style={{ color: 'var(--text-secondary)' }}><X size={18} /></button>
                                </div>
                            </div>
                            <pre style={{
                                background: 'rgba(0,0,0,0.4)', padding: '1.5rem', borderRadius: '8px', overflow: 'auto', flex: 1, fontSize: '0.85rem', lineHeight: '1.6', border: '1px solid rgba(255,255,255,0.1)'
                            }}>
                                <code>{viewingCode.code}</code>
                            </pre>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {evolvingStrategy && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="modal-overlay"
                        onClick={() => setEvolvingStrategy(null)}
                    >
                        <motion.div
                            className="panel"
                            style={{ width: '90%', maxWidth: '1200px', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', border: '1px solid var(--brand-blue)' }}
                            onClick={e => e.stopPropagation()}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                                <div>
                                    <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        <RefreshCw size={24} className={isEvolving ? 'animate-spin' : ''} style={{ color: 'var(--brand-blue)' }} />
                                        Strategy Evolution: {evolvingStrategy.name}
                                    </h2>
                                    <p style={{ fontSize: '0.85rem', opacity: 0.7, margin: 0 }}>Use AI to modify this logic and rerun a new deep backtest instantly.</p>
                                </div>
                                <button className="btn btn-ghost" onClick={() => setEvolvingStrategy(null)}><X size={20} /></button>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', flex: 1, overflow: 'hidden' }}>
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    <h3>Logic Editor</h3>
                                    <textarea
                                        className="code-editor"
                                        style={{ flex: 1, minHeight: 'unset', marginBottom: 0 }}
                                        value={evolvedCode}
                                        onChange={(e) => setEvolvedCode(e.target.value)}
                                    />
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                                    <div className="panel" style={{ background: 'rgba(59, 130, 246, 0.05)', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                                        <h3 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <Wand2 size={20} color="var(--brand-blue)" /> Evolution Instructions
                                        </h3>
                                        <textarea
                                            className="input"
                                            style={{ height: '150px', marginBottom: '1rem' }}
                                            placeholder="E.g. 'Add an RSI filter below 30', 'Include a 5% trailing stop', 'Change the SMA period to 100'..."
                                            value={evolutionInstruction}
                                            onChange={(e) => setEvolutionInstruction(e.target.value)}
                                        />
                                        <button
                                            className="btn btn-primary"
                                            style={{ width: '100%' }}
                                            onClick={handleEvolve}
                                            disabled={isEvolving || !evolutionInstruction}
                                        >
                                            {isEvolving ? <RefreshCw className="animate-spin" size={18} /> : <Wand2 size={18} />}
                                            {isEvolving ? 'Splicing Genes...' : 'Submit Evolution Prompt'}
                                        </button>
                                    </div>

                                    <div style={{ marginTop: 'auto' }}>
                                        <p style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: '1rem' }}>
                                            Rerunning will save this logic as a new custom strategy and trigger a fresh Deep Battle task using the original dataset and parameters.
                                        </p>
                                        <button
                                            className="btn"
                                            style={{ width: '100%', height: '60px', fontSize: '1.1rem', background: 'var(--brand-green)', color: 'white' }}
                                            onClick={() => handleRerun(evolvedCode, evolvingStrategy.name)}
                                            disabled={isEvolving}
                                        >
                                            <Play size={22} /> RERUN DEEP BATTLE
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default ResultsHistory;
