import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { RefreshCw, Download, Layers, Activity, Trash2, PlusCircle, X, Loader2, Eye, List } from 'lucide-react';
import { DATA_SERVICE } from '../config';
import { formatDatasetName } from '../utils/formatters';

const TickerGroup = ({ symbol, files, onView, onDelete }) => {
    const [activeFile, setActiveFile] = useState(files[0]);

    // Sync activeFile if it's no longer in files (after deletion)
    useEffect(() => {
        if (files.length > 0 && !files.includes(activeFile)) {
            setActiveFile(files[0]);
        }
    }, [files, activeFile]);

    return (
        <div className="ticker-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, color: 'var(--brand-blue)' }}>{symbol}</h3>
                <div className="ticker-tabs">
                    {files.map(f => (
                        <div key={f} className={`ticker-tab ${activeFile === f ? 'active' : ''}`} onClick={() => setActiveFile(f)}>
                            {f.includes('1m') ? '1m' : f.includes('5m') ? '5m' : f.includes('1h') ? '1h' : 'Daily/Other'}
                        </div>
                    ))}
                </div>
            </div>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
                <div style={{ flex: 1, fontSize: '0.9rem', opacity: 0.8 }}>{formatDatasetName(activeFile)}</div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => onView(activeFile)}>
                        <Activity size={14} /> Analyze
                    </button>
                    <a href={`${DATA_SERVICE}/data/${activeFile}`} className="btn btn-ghost btn-sm">
                        <Download size={14} />
                    </a>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--brand-red)' }} onClick={() => onDelete(activeFile)}>
                        <Trash2 size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
};

const MarketDataHub = ({ files, onRefresh, onView, onDelete, onTrigger, watchedTickers, onRefreshWatchlist, notify }) => {
    const [activeSection, setActiveSection] = useState('download');
    const [ticker, setTicker] = useState('');
    const [period, setPeriod] = useState('max');
    const [frequency, setFrequency] = useState('1d');
    const [extendedHours, setExtendedHours] = useState(false);
    const [loading, setLoading] = useState(false);
    const [validating, setValidating] = useState(false);
    const [watchlistTicker, setWatchlistTicker] = useState('');

    // Smart validation based on frequency
    const getValidPeriods = (freq) => {
        if (freq === '1m') return ['1d', '5d'];
        if (freq === '5m' || freq === '15m') return ['1d', '5d', '1mo', '60d'];
        if (freq === '1h') return ['1d', '5d', '1mo', '6mo', '1y', '2y'];
        return ['1d', '5d', '1mo', '6mo', '1y', '5y', 'max'];
    };

    const validPeriods = getValidPeriods(frequency);

    // Auto-adjust period when frequency changes
    useEffect(() => {
        if (!validPeriods.includes(period)) {
            setPeriod(validPeriods[validPeriods.length - 1]); // Set to max valid period
        }
        if (['1d', '1wk', '1mo'].includes(frequency)) {
            setExtendedHours(false);
        }
    }, [frequency]);

    const handleDownload = async () => {
        if (!ticker) return alert("Please enter a ticker");

        setLoading(true);
        try {
            const res = await axios.post(`${DATA_SERVICE}/download`, {
                tickers: [ticker.toUpperCase()],
                period: period,
                interval: frequency,
                extended_hours: extendedHours
            });
            onTrigger(res.data.task_id, `Downloading ${ticker.toUpperCase()} (${frequency}, ${period}${extendedHours ? ', extended hours' : ''})`);
            notify(`${ticker.toUpperCase()} added to watchlist & download started`, 'green');
        } catch (e) {
            alert("Error starting download");
        }
        setLoading(false);
    };

    const handleBatchDownload = async () => {
        if (!ticker) return alert("Please enter a ticker");
        setLoading(true);

        const SYMBOL = ticker.toUpperCase();
        try {
            const res = await axios.post(`${DATA_SERVICE}/download`, {
                tickers: [SYMBOL],
                suite: true,
                extended_hours: extendedHours
            });
            onTrigger(res.data.task_id, `Full Suite: ${SYMBOL} (1m, 5m, 1h, 1d${extendedHours ? ', extended hours' : ''})`);
            notify(`${SYMBOL} added to watchlist & full suite download started`, 'green');
        } catch (e) {
            alert("Failed to trigger suite download");
        }
        setLoading(false);
    };

    const handleAddToWatchlist = async () => {
        if (!watchlistTicker) return;
        setValidating(true);
        try {
            const res = await axios.post(`${DATA_SERVICE}/watch`, [watchlistTicker.toUpperCase()]);
            const { added, failed } = res.data;

            if (added.length > 0) {
                notify(`Added ${added.join(', ')} to watchlist`, 'green');
                onRefreshWatchlist();
            }
            if (failed.length > 0) {
                notify(`Invalid ticker: ${failed.join(', ')}`, 'red');
            }
            setWatchlistTicker('');
        } catch (e) {
            notify("Error adding to watchlist", 'red');
        }
        setValidating(false);
    };

    const handleRemoveFromWatchlist = async (t) => {
        try {
            await axios.delete(`${DATA_SERVICE}/watch/${t}`);
            notify(`Removed ${t} from watchlist`, 'blue');
            onRefreshWatchlist();
        } catch (e) {
            notify("Error removing from watchlist", 'red');
        }
    };

    const triggerSync = async () => {
        try {
            const res = await axios.post(`${DATA_SERVICE}/sync-now`, {});
            if (res.data.task_id) {
                onTrigger(res.data.task_id, "Syncing all watched tickers");
                notify("System Sync initiated...", 'blue');
            } else {
                notify(res.data.message || "No tickers to sync (Watchlist empty after restart?)", 'yellow');
            }
        } catch (e) {
            notify("Error triggering sync", 'red');
        }
    };

    const groupedFiles = files.reduce((acc, f) => {
        const symbol = f.split('-')[0].toUpperCase();
        if (!acc[symbol]) acc[symbol] = [];
        acc[symbol].push(f);
        return acc;
    }, {});

    const getFrequencyLabel = (freq) => {
        const labels = {
            '1m': '1 Minute (Intraday)',
            '5m': '5 Minutes (Intraday)',
            '15m': '15 Minutes (Intraday)',
            '1h': '1 Hour (Intraday)',
            '1d': 'Daily (Historical)',
            '1wk': 'Weekly (Historical)',
            '1mo': 'Monthly (Historical)'
        };
        return labels[freq] || freq;
    };

    const getPeriodLabel = (per) => {
        const labels = {
            '1d': '1 Day',
            '5d': '5 Days',
            '1mo': '1 Month',
            '60d': '60 Days',
            '6mo': '6 Months',
            '1y': '1 Year',
            '2y': '2 Years',
            '5y': '5 Years',
            'max': 'Maximum Available'
        };
        return labels[per] || per;
    };

    return (
        <div>
            <h1 style={{ marginBottom: '2rem' }}>Market Data Hub</h1>

            {/* Section Tabs */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
                <button
                    className={`btn ${activeSection === 'download' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setActiveSection('download')}
                >
                    <Download size={18} /> Download Data
                </button>
                <button
                    className={`btn ${activeSection === 'watchlist' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setActiveSection('watchlist')}
                >
                    <List size={18} /> Watchlist & Auto-Sync
                </button>
                <button
                    className={`btn ${activeSection === 'library' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setActiveSection('library')}
                >
                    <Eye size={18} /> Data Library
                </button>
            </div>

            {/* Download Section */}
            {activeSection === 'download' && (
                <div className="panel">
                    <h2 style={{ marginBottom: '1.5rem' }}>Acquire Live Data</h2>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Symbol</label>
                            <input
                                className="input"
                                placeholder="AAPL, TSLA, BTC-USD..."
                                value={ticker}
                                onChange={(e) => setTicker(e.target.value)}
                            />
                        </div>
                        <div className="form-group">
                            <label>Data Frequency</label>
                            <select className="input" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                                <optgroup label="Intraday (Short-term)">
                                    <option value="1m">1 Minute</option>
                                    <option value="5m">5 Minutes</option>
                                    <option value="15m">15 Minutes</option>
                                    <option value="1h">1 Hour</option>
                                </optgroup>
                                <optgroup label="Historical (Long-term)">
                                    <option value="1d">Daily</option>
                                    <option value="1wk">Weekly</option>
                                    <option value="1mo">Monthly</option>
                                </optgroup>
                            </select>
                        </div>
                        <div className="form-group">
                            <label>Time Range</label>
                            <select className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>
                                {validPeriods.map(p => (
                                    <option key={p} value={p}>{getPeriodLabel(p)}</option>
                                ))}
                            </select>
                        </div>
                        <label className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1.55rem' }}>
                            <input
                                type="checkbox"
                                checked={extendedHours}
                                onChange={(e) => setExtendedHours(e.target.checked)}
                                disabled={frequency === '1d' || frequency === '1wk' || frequency === '1mo'}
                            />
                            Extended hours
                        </label>
                    </div>

                    <div style={{
                        fontSize: '0.8rem',
                        color: 'var(--brand-blue)',
                        marginBottom: '1rem',
                        padding: '0.75rem',
                        background: 'rgba(59, 130, 246, 0.1)',
                        borderRadius: '6px',
                        border: '1px solid rgba(59, 130, 246, 0.2)'
                    }}>
                        <strong>Selected:</strong> {getFrequencyLabel(frequency)} data for {getPeriodLabel(period)}
                        {extendedHours && frequency !== '1d' && frequency !== '1wk' && frequency !== '1mo' ? ' including premarket/postmarket' : ''}
                        {frequency.includes('m') && (
                            <div style={{ marginTop: '0.5rem', opacity: 0.8 }}>
                                ⚠️ Intraday data has limited historical availability due to exchange restrictions
                            </div>
                        )}
                    </div>

                    <div className="form-row" style={{ marginTop: '1rem' }}>
                        <div className="form-group">
                            <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleDownload} disabled={loading}>
                                {loading ? <RefreshCw className="animate-spin" size={18} /> : <Download size={18} />}
                                Download Selection
                            </button>
                        </div>
                        <div className="form-group">
                            <button
                                className="btn"
                                style={{ width: '100%', border: '1px solid var(--brand-blue)', color: 'var(--brand-blue)' }}
                                onClick={handleBatchDownload}
                                disabled={loading}
                            >
                                <Layers size={18} /> Download Full Suite (All Timeframes)
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Watchlist Section */}
            {activeSection === 'watchlist' && (
                <div>
                    <div className="panel">
                        <h2 style={{ marginBottom: '1.5rem' }}>Monitor & Auto-Sync</h2>
                        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
                            <div style={{ flex: 1 }}>
                                <input
                                    className="input"
                                    placeholder="Add ticker to watchlist..."
                                    value={watchlistTicker}
                                    onChange={(e) => setWatchlistTicker(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleAddToWatchlist()}
                                    disabled={validating}
                                />
                            </div>
                            <button className="btn btn-primary" onClick={handleAddToWatchlist} disabled={validating}>
                                {validating ? <Loader2 className="animate-spin" size={18} /> : <PlusCircle size={18} />}
                                Add to Watchlist
                            </button>
                            <button className="btn" onClick={triggerSync}>
                                <RefreshCw size={18} /> Sync All
                            </button>
                        </div>

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
                            {watchedTickers.map(t => (
                                <div key={t} className="badge badge-green" style={{ fontSize: '1rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    {t}
                                    <div
                                        style={{ cursor: 'pointer', opacity: 0.7, display: 'flex', alignItems: 'center' }}
                                        onClick={() => handleRemoveFromWatchlist(t)}
                                        className="hover:opacity-100"
                                    >
                                        <X size={14} />
                                    </div>
                                </div>
                            ))}
                            {watchedTickers.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No tickers being watched yet.</p>}
                        </div>
                    </div>
                </div>
            )}

            {/* Data Library Section */}
            {activeSection === 'library' && (
                <div className="panel">
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
                        <h2>Available Datasets</h2>
                        <button className="btn" onClick={onRefresh}><RefreshCw size={16} /></button>
                    </div>

                    {Object.entries(groupedFiles).map(([symbol, tickerFiles]) => (
                        <TickerGroup key={symbol} symbol={symbol} files={tickerFiles} onView={onView} onDelete={onDelete} />
                    ))}
                    {files.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No datasets available.</p>}
                </div>
            )}
        </div>
    );
};

export default MarketDataHub;
