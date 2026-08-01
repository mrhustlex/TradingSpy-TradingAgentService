import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { TrendingUp, TrendingDown, RefreshCw, X } from 'lucide-react';
import { INTELLIGENCE_SERVICE } from '../../config';

const formatValue = (v) => {
  if (v == null) return '-';
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Number(v).toLocaleString();
};

const formatShares = (v) => {
  if (v == null) return '-';
  return Number(v).toLocaleString();
};

const MobileInsiderTrades = ({ ticker, onClose }) => {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState('all');
  const [meta, setMeta] = useState(null);
  const PAGE_SIZE = 20;

  const fetchTrades = useCallback(async (nextOffset = 0, append = false) => {
    if (!ticker) return;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const res = await axios.post(`${INTELLIGENCE_SERVICE}/insider-trades`, {
        tickers: [ticker],
        limit: PAGE_SIZE,
        offset: nextOffset,
        days_back: 365,
      });
      const incoming = res.data.trades || [];
      setTrades(prev => append ? [...prev, ...incoming] : incoming);
      setMeta(res.data.ticker_meta?.[ticker] || null);
      setOffset(nextOffset + incoming.length);
      setHasMore(incoming.length >= PAGE_SIZE);
    } catch (e) {
      if (!append) {
        setTrades([]);
        setMeta(null);
      }
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    setFilter('all');
    setOffset(0);
    setHasMore(false);
    fetchTrades(0, false);
  }, [fetchTrades]);

  const filtered = filter === 'all'
    ? trades
    : trades.filter(t => t.transaction_type === filter);

  const buyCount = trades.filter(t => t.transaction_type === 'Buy').length;
  const sellCount = trades.filter(t => t.transaction_type === 'Sell').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {loading && (
        <div className="mobile-loading">
          <div className="mobile-spinner" />
          <span>Loading insider trades...</span>
        </div>
      )}

      {!loading && trades.length === 0 && (
        <div className="mobile-loading" style={{ opacity: 0.5 }}>
          <span>No insider trades in the last year</span>
        </div>
      )}

      {!loading && trades.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              className={`mobile-pill ${filter === 'all' ? 'active' : ''}`}
              style={{ fontSize: 'var(--mobile-text-xs)', padding: '3px 10px' }}
              onClick={() => setFilter('all')}
            >
              All ({trades.length})
            </button>
            <button
              className={`mobile-pill ${filter === 'Buy' ? 'active' : ''}`}
              style={{ fontSize: 'var(--mobile-text-xs)', padding: '3px 10px' }}
              onClick={() => setFilter('Buy')}
            >
              <TrendingUp size={12} /> Buys ({buyCount})
            </button>
            <button
              className={`mobile-pill ${filter === 'Sell' ? 'active' : ''}`}
              style={{ fontSize: 'var(--mobile-text-xs)', padding: '3px 10px' }}
              onClick={() => setFilter('Sell')}
            >
              <TrendingDown size={12} /> Sells ({sellCount})
            </button>
            <button
              className="mobile-pill"
              style={{ fontSize: 'var(--mobile-text-xs)', padding: '3px 10px' }}
              onClick={() => {
                setOffset(0);
                setHasMore(false);
                fetchTrades(0, false);
              }}
              disabled={loading}
            >
              <RefreshCw size={12} /> Refresh
            </button>
            {onClose && (
              <button
                className="mobile-pill"
                style={{ fontSize: 'var(--mobile-text-xs)', padding: '3px 10px' }}
                onClick={onClose}
                aria-label="Close"
              >
                <X size={12} /> Close
              </button>
            )}
          </div>

          {meta && (meta.buy_6m_count != null || meta.sell_6m_count != null) && (
            <div className="mobile-card" style={{ margin: 0, padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)', display: 'flex', gap: 12, alignItems: 'center' }}>
              {meta.buy_6m_count != null && (
                <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--brand-green)' }}>
                  6m Buys: {meta.buy_6m_count}tx ({formatValue(meta.buy_6m_shares)})
                </span>
              )}
              {meta.sell_6m_count != null && (
                <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--brand-red)' }}>
                  6m Sells: {meta.sell_6m_count}tx ({formatValue(meta.sell_6m_shares)})
                </span>
              )}
              {meta.insiders_pct_held != null && (
                <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)' }}>
                  Insiders own {meta.insiders_pct_held}%
                </span>
              )}
            </div>
          )}

          {filtered.length === 0 && (
            <div className="mobile-loading" style={{ opacity: 0.5 }}>
              <span>No {filter} trades</span>
            </div>
          )}

          {filtered.map((t, i) => (
            <div key={i} className="mobile-card" style={{ margin: 0, padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ fontSize: 'var(--mobile-text-sm)', fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.insider || 'N/A'}
                </div>
                {t.transaction_type === 'Buy' ? (
                  <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--brand-green)', background: 'rgba(16,185,129,0.15)', padding: '2px 8px', borderRadius: 8 }}>
                    <TrendingUp size={10} /> BUY
                  </span>
                ) : t.transaction_type === 'Sell' ? (
                  <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--brand-red)', background: 'rgba(239,68,68,0.15)', padding: '2px 8px', borderRadius: 8 }}>
                    <TrendingDown size={10} /> SELL
                  </span>
                ) : (
                  <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--brand-yellow)', background: 'rgba(234,179,8,0.15)', padding: '2px 8px', borderRadius: 8 }}>
                    {t.transaction_type}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', marginTop: 2 }}>
                {t.date || '-'}{t.position ? ` · ${t.position}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--mobile-text-xs)' }}>
                  {t.shares != null ? formatShares(t.shares) + ' sh' : '-'}
                  {t.price != null ? ` @ $${t.price.toFixed(2)}` : ''}
                </span>
                {t.value != null && (
                  <span style={{ fontSize: 'var(--mobile-text-xs)', fontWeight: 600 }}>
                    {formatValue(t.value)}
                  </span>
                )}
                {t.portfolio_pct != null && (
                  <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)' }}>
                    {t.portfolio_pct.toFixed(1)}% of holdings
                  </span>
                )}
              </div>
              {t.shares_owned != null && (
                <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', marginTop: 2 }}>
                  Now holds {formatShares(t.shares_owned)} shares
                </div>
              )}
            </div>
          ))}

          {hasMore && (
            <button
              className="mobile-pill"
              style={{ alignSelf: 'center', marginTop: 4 }}
              onClick={() => fetchTrades(offset, true)}
              disabled={loadingMore}
            >
              {loadingMore ? <RefreshCw size={12} className="mobile-spinner" /> : 'Show more'}
            </button>
          )}
        </>
      )}
    </div>
  );
};

export default MobileInsiderTrades;
