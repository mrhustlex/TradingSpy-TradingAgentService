import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
    TrendingUp, TrendingDown, RefreshCw, Search, X, DollarSign,
    User, Calendar, ExternalLink, Briefcase, Filter, FolderKanban, Hash
} from 'lucide-react';
import { motion } from 'framer-motion';
import { INTELLIGENCE_SERVICE, DATA_SERVICE } from '../config';
import CategoryManager from './CategoryManager';

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'JPM', 'V', 'WMT'];

const InsiderTrades = ({ notify }) => {
    const [trades, setTrades] = useState([]);
    const [loading, setLoading] = useState(false);
    const [tickerInput, setTickerInput] = useState('');
    const [tickers, setTickers] = useState(DEFAULT_TICKERS);
    const [sortField, setSortField] = useState('date');
    const [sortDir, setSortDir] = useState('desc');
    const [filterType, setFilterType] = useState('all');
    const [minShares, setMinShares] = useState(0);
    const [minValue, setMinValue] = useState(0);
    const [categories, setCategories] = useState([]);
    const [showCategoryManager, setShowCategoryManager] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [page, setPage] = useState(0);
    const [pageSize] = useState(50);
    const [total, setTotal] = useState(0);
    const [daysBack, setDaysBack] = useState(365);
    const [tickerMeta, setTickerMeta] = useState({});

    useEffect(() => {
        fetchCategories();
    }, []);

    const fetchCategories = async () => {
        try {
            const res = await axios.get(`${DATA_SERVICE}/watch`);
            setCategories(res.data.categories || []);
            if (res.data.watched_tickers?.length && tickers === DEFAULT_TICKERS) {
                setTickers(res.data.watched_tickers);
            }
        } catch (e) {
            // silent
        }
    };

    const applyCategory = (cat) => {
        setTickers(cat.tickers);
    };

    const toggleSort = (field) => {
        if (sortField === field) {
            setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDir('desc');
        }
    };

    const addTicker = () => {
        const t = tickerInput.trim().toUpperCase();
        if (!t) return;
        if (!tickers.includes(t)) {
            setTickers([...tickers, t]);
        }
        setTickerInput('');
    };

    const removeTicker = (t) => {
        setTickers(tickers.filter(x => x !== t));
    };

    const fetchInsiderTrades = async (newPage = 0) => {
        if (tickers.length === 0) {
            notify('Add at least one ticker', 'yellow');
            return;
        }
        setLoading(true);
        setPage(newPage);
        try {
            const res = await axios.post(`${INTELLIGENCE_SERVICE}/insider-trades`, {
                tickers,
                limit: pageSize,
                offset: newPage * pageSize,
                days_back: daysBack
            });
            setTrades(res.data.trades || []);
            setTotal(res.data.total || 0);
            setTickerMeta(res.data.ticker_meta || {});
        } catch (e) {
            notify('Failed to fetch insider trades: ' + (e.response?.data?.detail || e.message), 'red');
        } finally {
            setLoading(false);
        }
    };

    const handleSaveCategories = async (cats) => {
        try {
            await axios.post(`${DATA_SERVICE}/watch/categories`, { categories: cats });
            setCategories(cats);
            setShowCategoryManager(false);
            notify('Categories saved', 'green');
        } catch (e) {
            notify('Failed to save categories', 'red');
        }
    };

    const filtered = trades.filter(t => {
        if (filterType !== 'all' && t.transaction_type !== filterType) return false;
        if (minShares > 0 && (t.shares || 0) < minShares) return false;
        if (minValue > 0 && (t.value || 0) < minValue) return false;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            const fields = [t.insider, t.ticker, t.position, t.text, t.transaction_type, String(t.shares_owned || ''), String(t.portfolio_pct || '')];
            if (!fields.some(f => f && f.toLowerCase().includes(q))) return false;
        }
        return true;
    });

    const sorted = [...filtered].sort((a, b) => {
        let va = a[sortField] ?? '';
        let vb = b[sortField] ?? '';
        if (sortField === 'value' || sortField === 'shares' || sortField === 'price' || sortField === 'shares_owned' || sortField === 'portfolio_pct') {
            va = Number(va);
            vb = Number(vb);
        }
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
    });

    const buyCount = trades.filter(t => t.transaction_type === 'Buy').length;
    const sellCount = trades.filter(t => t.transaction_type === 'Sell').length;
    const totalValue = trades.reduce((s, t) => s + (t.value || 0), 0);

    const formatValue = (v) => {
        if (v == null) return '-';
        if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
        if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
        return '$' + Number(v).toLocaleString();
    };

    const sortArrow = (field) => {
        if (sortField !== field) return '';
        return sortDir === 'asc' ? ' ▲' : ' ▼';
    };

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <TrendingUp size={24} color="var(--brand-blue)" /> Insider Transactions
                </h2>
            </div>

            {categories.length > 0 && (
                <div className="panel" style={{ marginBottom: '1rem', padding: '0.75rem 1rem' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <FolderKanban size={16} opacity={0.5} />
                        {categories.map((cat, i) => (
                            <span key={i}
                                className="badge badge-blue"
                                style={{ cursor: 'pointer', padding: '0.4rem 0.8rem' }}
                                onClick={() => applyCategory(cat)}
                                title={cat.tickers.join(', ')}>
                                {cat.name} ({cat.tickers.length})
                            </span>
                        ))}
                        <button className="btn btn-ghost btn-xs" onClick={() => setShowCategoryManager(true)}
                            style={{ marginLeft: 'auto' }}>
                            <FolderKanban size={14} /> Edit
                        </button>
                    </div>
                </div>
            )}

            <div className="panel" style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', flex: 1 }}>
                        {tickers.map(t => {
                            const meta = tickerMeta[t];
                            const pct = meta?.insiders_pct_held;
                            return (
                            <span key={t} className="badge badge-blue" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.35rem 0.6rem', cursor: 'default' }} title={pct != null ? `Insiders own ${pct}% of ${t}` : ''}>
                                {t}{pct != null ? <span style={{ opacity: 0.6, fontSize: '0.7rem' }}>{pct}%</span> : null}
                                <X size={12} style={{ cursor: 'pointer' }} onClick={() => removeTicker(t)} />
                            </span>
                            );
                        })}
                        {categories.length === 0 && (
                            <button className="btn btn-ghost btn-xs" onClick={() => setShowCategoryManager(true)}
                                style={{ opacity: 0.5, fontSize: '0.8rem' }}>
                                <FolderKanban size={14} /> Manage Categories
                            </button>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <input
                            className="input"
                            style={{ width: '140px', height: '40px' }}
                            placeholder="Add ticker..."
                            value={tickerInput}
                            onChange={e => setTickerInput(e.target.value.toUpperCase())}
                            onKeyDown={e => e.key === 'Enter' && addTicker()}
                        />
                        <button className="btn btn-ghost btn-xs" onClick={addTicker}><Search size={16} /></button>
                        <input type="text" placeholder="Search..." value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            style={{ width: '130px', height: '40px', fontSize: '0.85rem', padding: '0 0.75rem', background: 'var(--input-bg)', border: '1px solid var(--border-subtle)', borderRadius: '8px', color: 'var(--text-main)' }} />
                        <select value={daysBack} onChange={e => setDaysBack(Number(e.target.value))}
                            style={{ height: '40px', fontSize: '0.85rem', padding: '0 0.5rem', background: 'var(--input-bg)', border: '1px solid var(--border-subtle)', borderRadius: '8px', color: 'var(--text-main)', cursor: 'pointer' }}>
                            <option value={7}>7 days</option>
                            <option value={30}>30 days</option>
                            <option value={90}>90 days</option>
                            <option value={365}>1 year</option>
                            <option value={0}>All time</option>
                        </select>
                        <button className="btn btn-primary" onClick={() => fetchInsiderTrades(0)} disabled={loading}>
                            {loading ? <RefreshCw size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                            Fetch
                        </button>
                    </div>
                </div>
            </div>

            {trades.length > 0 && (
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <Filter size={16} opacity={0.5} />
                        <button className={`btn btn-sm ${filterType === 'all' ? 'btn-primary' : ''}`} onClick={() => setFilterType('all')}>All ({trades.length})</button>
                        <button className={`btn btn-sm ${filterType === 'Buy' ? 'btn-primary' : ''}`} onClick={() => setFilterType('Buy')} style={filterType !== 'Buy' ? { borderColor: 'rgba(16,185,129,0.3)', color: 'var(--brand-green)' } : {}}>
                            <TrendingUp size={14} /> Buys ({buyCount})
                        </button>
                        <button className={`btn btn-sm ${filterType === 'Sell' ? 'btn-primary' : ''}`} onClick={() => setFilterType('Sell')} style={filterType !== 'Sell' ? { borderColor: 'rgba(239,68,68,0.3)', color: 'var(--brand-red)' } : {}}>
                            <TrendingDown size={14} /> Sells ({sellCount})
                        </button>
                    </div>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', opacity: 0.6 }}>
                            <Hash size={12} /> Shares &ge;
                            <input type="number" min="0" step="100"
                                value={minShares}
                                onChange={e => setMinShares(parseInt(e.target.value) || 0)}
                                style={{ width: '70px', height: '28px', fontSize: '0.8rem', padding: '0 0.4rem', background: 'var(--input-bg)', border: '1px solid var(--border-subtle)', borderRadius: '4px', color: 'var(--text-main)' }} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', opacity: 0.6 }}>
                            <DollarSign size={12} /> Value &ge;
                            <input type="number" min="0" step="10000"
                                value={minValue}
                                onChange={e => setMinValue(parseInt(e.target.value) || 0)}
                                style={{ width: '90px', height: '28px', fontSize: '0.8rem', padding: '0 0.4rem', background: 'var(--input-bg)', border: '1px solid var(--border-subtle)', borderRadius: '4px', color: 'var(--text-main)' }} />
                        </div>
                        {(minShares > 0 || minValue > 0) && (
                            <button className="btn btn-ghost btn-xs"
                                onClick={() => { setMinShares(0); setMinValue(0); }}
                                style={{ fontSize: '0.75rem' }}><X size={12} /> Clear</button>
                        )}
                    </div>
                    <div style={{ fontSize: '0.85rem', opacity: 0.6, marginLeft: 'auto', display: 'flex', gap: '1rem', alignItems: 'center' }}>
                        <span>Total Value: <strong>{formatValue(totalValue)}</strong></span>
                        <span>Trades: <strong>{trades.length}</strong></span>
                        {Object.keys(tickerMeta).length > 0 && (
                            <span style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', paddingLeft: '0.5rem', borderLeft: '1px solid var(--border-subtle)' }}>
                                {(() => {
                                    const buys = Object.values(tickerMeta).reduce((s, m) => s + (m.buy_6m_shares || 0), 0);
                                    const sells = Object.values(tickerMeta).reduce((s, m) => s + (m.sell_6m_shares || 0), 0);
                                    const buyTx = Object.values(tickerMeta).reduce((s, m) => s + (m.buy_6m_count || 0), 0);
                                    const sellTx = Object.values(tickerMeta).reduce((s, m) => s + (m.sell_6m_count || 0), 0);
                                    return <><span style={{ color: 'var(--brand-green)' }}>Buys: <strong>{buyTx}tx ({formatValue(buys)})</strong></span><span style={{ color: 'var(--brand-red)' }}>Sells: <strong>{sellTx}tx ({formatValue(sells)})</strong></span></>;
                                })()}
                            </span>
                        )}
                    </div>
                </div>
            )}

            <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                    <table className="table">
                        <thead>
                            <tr>
                                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('date')}>Date{sortArrow('date')}</th>
                                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('ticker')}>Ticker{sortArrow('ticker')}</th>
                                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('insider')}>Insider{sortArrow('insider')}</th>
                                <th style={{ fontSize: '0.78rem' }} title="D = Direct holding, I = Indirect (trust/entity)">Own</th>
                                <th>Position</th>
                                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('transaction_type')}>Type{sortArrow('transaction_type')}</th>
                                <th style={{ cursor: 'pointer', textAlign: 'right' }} onClick={() => toggleSort('shares')}>Shares{sortArrow('shares')}</th>
                                <th style={{ cursor: 'pointer', textAlign: 'right' }} onClick={() => toggleSort('shares_owned')} title="Current shares held">Held{sortArrow('shares_owned')}</th>
                                <th style={{ cursor: 'pointer', textAlign: 'right' }} onClick={() => toggleSort('portfolio_pct')}>%{sortArrow('portfolio_pct')}</th>
                                <th style={{ cursor: 'pointer', textAlign: 'right' }} onClick={() => toggleSort('price')}>Price{sortArrow('price')}</th>
                                <th style={{ cursor: 'pointer', textAlign: 'right' }} onClick={() => toggleSort('value')}>Value{sortArrow('value')}</th>
                                <th>Link</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sorted.length === 0 && (
                                <tr>
                                    <td colSpan={12} style={{ textAlign: 'center', padding: '3rem', opacity: 0.5 }}>
                                        {loading ? <div className="spinner" style={{ width: 24, height: 24, margin: 0 }} /> : trades.length === 0 ? 'No data. Add tickers and click Fetch.' : 'No trades match the filter.'}
                                    </td>
                                </tr>
                            )}
                            {sorted.map((trade, i) => (
                                <tr key={i}>
                                    <td style={{ whiteSpace: 'nowrap' }}><Calendar size={12} style={{ marginRight: '0.4rem', opacity: 0.5 }} />{trade.date || '-'}</td>
                                    <td><strong>{trade.ticker}</strong></td>
                                    <td style={{ whiteSpace: 'nowrap' }} title={trade.insider}>
                                        <User size={12} style={{ marginRight: '0.4rem', opacity: 0.5 }} />{trade.insider || 'N/A'}
                                    </td>
                                    <td style={{ textAlign: 'center', fontSize: '0.72rem', fontWeight: 700 }} title={trade.ownership_change === 'D' ? 'Direct holding' : trade.ownership_change === 'I' ? 'Indirect holding (trust/entity)' : ''}>
                                        {trade.ownership_change === 'D' ? <span style={{ color: 'var(--brand-green)' }}>D</span> : trade.ownership_change === 'I' ? <span style={{ color: 'var(--brand-yellow)' }}>I</span> : '-'}
                                    </td>
                                    <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem', opacity: 0.75 }} title={trade.position}>
                                        <Briefcase size={12} style={{ marginRight: '0.3rem', opacity: 0.4 }} />{trade.position || '-'}
                                    </td>
                                    <td>
                                        {trade.transaction_type === 'Buy' ? (
                                            <span className="badge badge-green"><TrendingUp size={12} /> Buy</span>
                                        ) : trade.transaction_type === 'Sell' ? (
                                            <span className="badge badge-red"><TrendingDown size={12} /> Sell</span>
                                        ) : (
                                            <span className="badge badge-yellow">{trade.transaction_type}</span>
                                        )}
                                    </td>
                                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{trade.shares?.toLocaleString() || '-'}</td>
                                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: 0.65, fontSize: '0.85rem' }}
                                        title={trade.last_tx ? `Last: ${trade.last_tx}${trade.last_tx_date ? ' on ' + trade.last_tx_date : ''}` : ''}>{trade.shares_owned?.toLocaleString() || '-'}</td>
                                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: trade.portfolio_pct != null && trade.portfolio_pct > 5 ? 'var(--brand-red)' : 'inherit' }}>
                                        {trade.portfolio_pct != null ? trade.portfolio_pct.toFixed(1) + '%' : '-'}
                                    </td>
                                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{trade.price != null ? '$' + trade.price.toFixed(2) : '-'}</td>
                                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                                        <DollarSign size={12} style={{ marginRight: '0.2rem', opacity: 0.5, display: 'inline' }} />
                                        {formatValue(trade.value)}
                                    </td>
                                    <td>
                                        {trade.url ? (
                                            <a href={trade.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-blue)', textDecoration: 'none' }}>
                                                <ExternalLink size={14} />
                                            </a>
                                        ) : '-'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <div style={{ fontSize: '0.8rem', opacity: 0.5, marginTop: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Data from yfinance. {total > 0 ? `${total} total trades` : ''}</span>
                {total > pageSize && (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <button className="btn btn-ghost btn-xs" disabled={page === 0} onClick={() => fetchInsiderTrades(0)} title="First">&laquo;</button>
                        <button className="btn btn-ghost btn-xs" disabled={page === 0} onClick={() => fetchInsiderTrades(page - 1)} title="Previous">&lsaquo;</button>
                        <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>Page {page + 1} of {Math.ceil(total / pageSize)}</span>
                        <button className="btn btn-ghost btn-xs" disabled={(page + 1) * pageSize >= total} onClick={() => fetchInsiderTrades(page + 1)} title="Next">&rsaquo;</button>
                        <button className="btn btn-ghost btn-xs" disabled={(page + 1) * pageSize >= total} onClick={() => fetchInsiderTrades(Math.ceil(total / pageSize) - 1)} title="Last">&raquo;</button>
                    </div>
                )}
            </div>

            {showCategoryManager && (
                <CategoryManager
                    categories={categories}
                    tickers={tickers}
                    onSave={handleSaveCategories}
                    onClose={() => setShowCategoryManager(false)}
                />
            )}
        </motion.div>
    );
};

export default InsiderTrades;
