import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { RefreshCw, Download, Layers, Activity, Trash2 } from 'lucide-react';
import { DATA_SERVICE } from '../config';
import { formatDatasetName } from '../utils/formatters';

const TickerGroup = ({ symbol, files, onView, onDelete }) => {
    const [activeFile, setActiveFile] = useState(files[0]);

    // Parse granularity from filename (e.g., "aapl-1d-5y.txt" -> "1d")
    const parseGranularity = (filename) => {
        const parts = filename.split('-');
        if (parts.length >= 2) {
            return parts[1]; // e.g., "1m", "5m", "1h", "1d"
        }
        return 'unknown';
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

    // Sort files by granularity priority (intraday first, then daily/weekly/monthly)
    const sortedFiles = [...files].sort((a, b) => {
        const order = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1wk', '1mo'];
        const granA = parseGranularity(a);
        const granB = parseGranularity(b);
        return order.indexOf(granA) - order.indexOf(granB);
    });

    // Sync activeFile if it's no longer in files (after deletion)
    useEffect(() => {
        if (files.length > 0 && !files.includes(activeFile)) {
            setActiveFile(sortedFiles[0]);
        }
    }, [files, activeFile]);

    return (
        <div className="ticker-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '1rem' }}>
                <h3 style={{ margin: 0, color: 'var(--brand-blue)' }}>{symbol}</h3>
                <div className="ticker-tabs" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {sortedFiles.map(f => {
                        const granularity = parseGranularity(f);
                        return (
                            <div 
                                key={f} 
                                className={`ticker-tab ${activeFile === f ? 'active' : ''}`} 
                                onClick={() => setActiveFile(f)}
                                style={{
                                    padding: '0.5rem 1rem',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem',
                                    fontWeight: 'bold',
                                    transition: 'all 0.2s',
                                    background: activeFile === f ? 'var(--brand-blue)' : 'rgba(59, 130, 246, 0.1)',
                                    color: activeFile === f ? 'white' : 'var(--brand-blue)',
                                    border: `1px solid ${activeFile === f ? 'var(--brand-blue)' : 'rgba(59, 130, 246, 0.3)'}`,
                                }}
                            >
                                {getGranularityLabel(granularity)}
                            </div>
                        );
                    })}
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

const DataManagement = ({ files, onRefresh, onView, onDelete, onTrigger }) => {
    const [ticker, setTicker] = useState('');
    const [period, setPeriod] = useState('max');
    const [frequency, setFrequency] = useState('1d');
    const [loading, setLoading] = useState(false);

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
    }, [frequency]);

    const handleDownload = async () => {
        if (!ticker) return alert("Please enter a ticker");

        setLoading(true);
        try {
            const res = await axios.post(`${DATA_SERVICE}/download`, {
                tickers: [ticker.toUpperCase()],
                period: period,
                interval: frequency
            });
            onTrigger(res.data.task_id, `Downloading ${ticker.toUpperCase()} (${frequency}, ${period})`);
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
                suite: true
            });
            onTrigger(res.data.task_id, `Full Suite: ${SYMBOL} (1m, 5m, 1h, 1d)`);
            alert(`Triggered full suite download for ${SYMBOL}. Track progress in Task Center.`);
        } catch (e) {
            alert("Failed to trigger suite download");
        }
        setLoading(false);
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

            <div className="panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
                    <h2>Available Tickers</h2>
                    <button className="btn" onClick={onRefresh}><RefreshCw size={16} /></button>
                </div>

                {Object.entries(groupedFiles).map(([symbol, tickerFiles]) => (
                    <TickerGroup key={symbol} symbol={symbol} files={tickerFiles} onView={onView} onDelete={onDelete} />
                ))}
                {files.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No datasets available.</p>}
            </div>
        </div>
    );
};

export default DataManagement;
