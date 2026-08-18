import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import axios from 'axios';
import {
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Loader2,
  Activity,
  BarChart3,
  Zap,
  MessageCircleQuestion,
  X,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { INTELLIGENCE_SERVICE, DATA_SERVICE } from '../config';
import MobileInsiderTrades from './components/MobileInsiderTrades';
import MobileSignals from './components/MobileSignals';
import MobileSymbolSearch from './components/MobileSymbolSearch';
import useSheetResize from './useSheetResize';

const ChartViewer = lazy(() => import('../components/ChartViewer'));

const MOVEMENT_WINDOWS = {
  '1m': { label: '1min', period: '1d', interval: '1m' },
  '5m': { label: '5min', period: '1d', interval: '5m' },
  '15m': { label: '15min', period: '1d', interval: '15m' },
  '1h': { label: '1H', period: '1d', interval: '60m' },
  '1d': { label: '1D', period: '1d', interval: null },
  '5d': { label: '5D', period: '5d', interval: null },
  '1mo': { label: '1Mo', period: '1mo', interval: null },
};

const UNIVERSE_TYPES = [
  { key: 'high-market-cap', label: 'Hot' },
  { key: 'market-etfs', label: 'Top Vol' },
  { key: 'leverage', label: 'Leveraged' },
];

const TABS = [
  { key: 'both', label: 'Gainers & Losers', icon: Activity },
  { key: 'volume', label: 'Volume', icon: BarChart3 },
  { key: 'volatility', label: 'Volatility', icon: Zap },
];

const CHART_INTERVALS = [
  { key: '1d', label: '1D' },
  { key: '5d', label: '5D' },
  { key: '1mo', label: '1Mo' },
  { key: '3mo', label: '3Mo' },
];

const formatPct = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};

const formatPrice = (value) => {
  if (value == null) return '-';
  return '$' + Number(value).toFixed(2);
};

const formatVolume = (value) => {
  if (value == null) return '-';
  const abs = Math.abs(Number(value));
  if (abs >= 1e9) return (value / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (value / 1e3).toFixed(1) + 'K';
  return Number(value).toLocaleString();
};

const timeAgo = (iso) => {
  if (!iso) return '';
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
};

const MoverRow = ({ mover, color, onClick, signal, signalLoading }) => (
  <div
    onClick={onClick}
    style={{
      display: 'flex',
      alignItems: 'center',
      padding: '10px 10px',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
      cursor: 'pointer',
      gap: 6,
    }}
  >
    <div style={{ fontWeight: 700, fontSize: 'var(--mobile-text-base)', width: 58, flexShrink: 0 }}>
      {mover.ticker}
    </div>
    <div style={{ flex: 1, fontSize: 'var(--mobile-text-sm)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {mover.price != null ? formatPrice(mover.price) : '·'} · {formatVolume(mover.volume)} vol
      {signal && (
        <span style={{ marginLeft: 6 }}>
          <span style={{ color: 'var(--brand-blue)' }}>{signal.volume_ratio != null ? `${signal.volume_ratio}x` : '·'}</span>
          {' '}
          <span style={{ color: 'var(--brand-green)' }}>{signal.up_times ?? 0}↑</span>
          <span style={{ color: 'var(--brand-red)' }}>{signal.down_times ?? 0}↓</span>
        </span>
      )}
    </div>
    <div style={{
      fontSize: 'var(--mobile-text-base)',
      fontWeight: 700,
      color,
      width: 64,
      textAlign: 'right',
      flexShrink: 0,
    }}>
      {formatPct(mover.change_percent)}
    </div>
  </div>
);

const MobileMovements = ({ notify, onExplain }) => {
  const [movers, setMovers] = useState([]);
  const [signalMap, setSignalMap] = useState({});
  const [signalLoading, setSignalLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [window, setWindow] = useState('1d');
  const [universe, setUniverse] = useState('high-market-cap');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('both');
  const [sortAsc, setSortAsc] = useState(false);
  const [extended, setExtended] = useState(false);
  const [selectedTicker, setSelectedTicker] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [news, setNews] = useState([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsVisibleCount, setNewsVisibleCount] = useState(8);
  const [detailTab, setDetailTab] = useState('info');
  const [chartData, setChartData] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartInterval, setChartInterval] = useState('1d');
  const lastGoodMoversRef = useRef({ key: '', items: [] });

  // Sheet pull-to-resize: drag the handle up/down to enlarge or shrink the sheet.
  const { sheetHeight, handleProps, sheetStyle } = useSheetResize();

  const loadChart = useCallback(async (ticker, period = '1d') => {
    if (!ticker) return;
    setChartLoading(true);
    try {
      const res = await axios.get(`${DATA_SERVICE}/chart/${ticker}?period=${period}&t=${Date.now()}`, { timeout: 20000 });
      const rows = res.data?.rows || [];
      setChartData(rows.length ? rows : null);
    } catch (e) {
      setChartData(null);
    } finally {
      setChartLoading(false);
    }
  }, []);

  // Auto-load the chart when a ticker is selected (no manual "Load Chart" tap needed)
  useEffect(() => {
    if (selectedTicker) {
      setChartData(null);
      loadChart(selectedTicker, chartInterval);
    }
  }, [selectedTicker, chartInterval, loadChart]);

  const fetchTickerDetail = async (ticker) => {
    setSelectedTicker(ticker);
    setDetailTab('info');
    setDetailLoading(true);
    setNews([]);
    setNewsVisibleCount(8);
    setChartData(null);

    // Use already-fetched batch data for consistency
    const batchMover = movers.find(m => m.ticker === ticker);
    if (batchMover) {
      setDetailData({
        symbol: batchMover.ticker,
        name: batchMover.ticker,
        current_price: batchMover.price,
        change_percent: batchMover.change_percent,
        volume: batchMover.volume,
      });
    }

    try {
      setNewsLoading(true);
      const [infoRes, newsRes] = await Promise.all([
        axios.get(`${INTELLIGENCE_SERVICE}/info/${ticker}`).catch(() => ({ data: null })),
        axios.get(`${INTELLIGENCE_SERVICE}/news/${ticker}?limit=30`).catch(() => ({ data: { news: [] } })),
      ]);

      // Merge info data but keep batch change_percent for consistency
      if (infoRes.data) {
        const d = infoRes.data;
        setDetailData(prev => ({
          ...d,
          // Prefer batch data for change_percent to stay consistent with list
          change_percent: batchMover?.change_percent ?? d.change_percent,
          current_price: batchMover?.price ?? d.current_price,
        }));
      }
      setNews(newsRes.data.news || []);
    } catch (e) {
      console.error('Failed to fetch detail:', e);
    } finally {
      setNewsLoading(false);
    }
    setDetailLoading(false);
  };

  const fetchMovers = useCallback(async () => {
    setLoading(true);
    try {
      const config = MOVEMENT_WINDOWS[window];

      let tickers = [];
      try {
        const presetRes = await axios.get(`${INTELLIGENCE_SERVICE}/universe-preset/${universe}?limit=20`, { timeout: 20000 });
        tickers = presetRes.data.tickers || [];
      } catch {
        tickers = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'JPM', 'V'];
      }

      if (tickers.length === 0) {
        setMovers([]);
        setLoading(false);
        return;
      }

      const params = new URLSearchParams({ period: config.period });
      if (config.interval) params.set('interval', config.interval);
      if (extended) params.set('extended', 'true');

      const fetchKey = `${window}:${universe}:${extended}`;
      // Seed with the last successful rows for this exact window+universe so a
      // flaky refresh never wipes previously-loaded movers.
      const merged = new Map();
      if (lastGoodMoversRef.current.key === fetchKey) {
        for (const m of lastGoodMoversRef.current.items) merged.set(m.ticker.toUpperCase(), m);
      }

      // Load in small batches with limited concurrency (mirrors the desktop view):
      // yfinance bulk downloads are flaky, so partial results are kept and rendered
      // progressively instead of failing the whole tab.
      const chunks = [];
      for (let i = 0; i < tickers.length; i += 8) chunks.push(tickers.slice(i, i + 8));

      const fetchChunk = async (chunk) => {
        const res = await axios.post(`${INTELLIGENCE_SERVICE}/batch-price-changes?${params}`, chunk, { timeout: 60000 });
        const data = (res.data.quotes || []).map(m => ({
          ticker: m.symbol,
          price: m.price,
          change: m.change,
          change_percent: m.change_percent,
          volume: m.volume,
          avg_volume: m.avg_volume,
        }));
        for (const m of data) {
          if (m.ticker && m.change_percent != null) merged.set(m.ticker.toUpperCase(), m);
        }
        setMovers(Array.from(merged.values()));
      };

      let cursor = 0;
      const loadNextChunk = async () => {
        while (cursor < chunks.length) {
          const chunk = chunks[cursor];
          cursor += 1;
          try {
            await fetchChunk(chunk);
          } catch (e) {
            console.warn('Movers chunk failed:', chunk, e);
            // One retry with backoff: transient yfinance/network failures often
            // resolve on the second attempt.
            try {
              await new Promise(r => setTimeout(r, 1200));
              await fetchChunk(chunk);
            } catch (e2) {
              console.warn('Movers chunk retry failed:', chunk, e2);
            }
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, loadNextChunk));

      // Top-up pass: retry any ticker that still has no usable row so a transient
      // batch failure can't leave permanent gaps in the list.
      const stillMissing = tickers.filter(t => !merged.has(t.toUpperCase()));
      if (stillMissing.length > 0) {
        const missingChunks = [];
        for (let i = 0; i < stillMissing.length; i += 8) missingChunks.push(stillMissing.slice(i, i + 8));
        let mCursor = 0;
        const loadMissing = async () => {
          while (mCursor < missingChunks.length) {
            const chunk = missingChunks[mCursor];
            mCursor += 1;
            try {
              await fetchChunk(chunk);
            } catch (e) {
              console.warn('Movers top-up chunk failed:', chunk, e);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, missingChunks.length) }, loadMissing));
      }

      const finalMovers = Array.from(merged.values());
      setMovers(finalMovers);
      lastGoodMoversRef.current = { key: fetchKey, items: finalMovers };
      if (finalMovers.length < tickers.length) {
        notify(`Loaded ${finalMovers.length}/${tickers.length} movers. yfinance may be rate-limited — refresh to retry the rest.`, 'yellow');
      }
      loadSignals(finalMovers.map(m => m.ticker));
    } catch (e) {
      console.error('Failed to fetch movers:', e);
      notify('Failed to load market movements', 'red');
    }
    setLoading(false);
  }, [window, universe, extended]);

  const loadSignals = useCallback(async (tickers) => {
    if (!tickers || tickers.length === 0) return;
    setSignalLoading(true);
    try {
      const res = await axios.post(`${INTELLIGENCE_SERVICE}/trading-signal`, {
        tickers: tickers.slice(0, 20),
        period: '1mo',
        interval: '1d',
      }, { timeout: 30000 });
      const map = {};
      for (const s of res.data.signals || []) {
        if (s.ticker && !s.error) map[s.ticker.toUpperCase()] = s;
      }
      setSignalMap(prev => ({ ...prev, ...map }));
    } catch (e) {
      console.warn('Failed to fetch mover signals:', e);
    } finally {
      setSignalLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMovers();
  }, [fetchMovers]);

  const filtered = useMemo(() => {
    if (!searchQuery) return movers;
    const q = searchQuery.toLowerCase();
    return movers.filter(m => m.ticker.toLowerCase().includes(q));
  }, [movers, searchQuery]);

  const gainers = useMemo(() =>
    filtered.filter(m => (m.change_percent || 0) > 0)
      .sort((a, b) => sortAsc
        ? (a.change_percent || 0) - (b.change_percent || 0)
        : (b.change_percent || 0) - (a.change_percent || 0)
      ),
    [filtered, sortAsc]
  );

  const losers = useMemo(() =>
    filtered.filter(m => (m.change_percent || 0) < 0)
      .sort((a, b) => sortAsc
        ? (a.change_percent || 0) - (b.change_percent || 0)
        : (b.change_percent || 0) - (a.change_percent || 0)
      ),
    [filtered, sortAsc]
  );

  const byVolume = useMemo(() =>
    [...filtered].sort((a, b) => sortAsc
      ? (a.volume || 0) - (b.volume || 0)
      : (b.volume || 0) - (a.volume || 0)
    ),
    [filtered, sortAsc]
  );

  const byVolatility = useMemo(() =>
    [...filtered].sort((a, b) => sortAsc
      ? Math.abs(a.change_percent || 0) - Math.abs(b.change_percent || 0)
      : Math.abs(b.change_percent || 0) - Math.abs(a.change_percent || 0)
    ),
    [filtered, sortAsc]
  );

  return (
    <div className="mobile-p-md">
      {/* Window Selector */}
      <div className="mobile-pills" style={{ padding: 0, marginBottom: 'var(--mobile-spacing-sm)' }}>
        {Object.entries(MOVEMENT_WINDOWS).map(([key, config]) => (
          <button
            key={key}
            className={`mobile-pill ${window === key ? 'active' : ''}`}
            onClick={() => setWindow(key)}
          >
            {config.label}
          </button>
        ))}
      </div>

      {/* Universe Type Selector */}
      <div className="mobile-pills" style={{ padding: 0, marginBottom: 'var(--mobile-spacing-sm)' }}>
        {UNIVERSE_TYPES.map((type) => (
          <button
            key={type.key}
            className={`mobile-pill ${universe === type.key ? 'active' : ''}`}
            onClick={() => setUniverse(type.key)}
          >
            {type.label}
          </button>
        ))}
      </div>

      {/* Tabs + Search + Sort */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 'var(--mobile-spacing-sm)' }}>
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`mobile-pill ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => { setActiveTab(tab.key); setSortAsc(false); }}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 'var(--mobile-text-xs)' }}
          >
            <tab.icon size={12} />
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 'var(--mobile-spacing-sm)', marginBottom: 'var(--mobile-spacing-md)' }}>
        <MobileSymbolSearch
          compact
          onSelect={(r) => fetchTickerDetail(r.ticker)}
          onSelectLocal={(m) => setSearchQuery(m.ticker)}
          localOptions={movers.map(m => ({ ticker: m.ticker, name: m.ticker }))}
          placeholder="Search ticker or company..."
        />
        <button
          className={`mobile-pill ${sortAsc ? '' : 'active'}`}
          onClick={() => setSortAsc(!sortAsc)}
          style={{ flexShrink: 0, fontSize: 'var(--mobile-text-xs)' }}
        >
          {sortAsc ? '↑ Low' : '↓ High'}
        </button>
        <button
          className={`mobile-pill ${extended ? 'active' : ''}`}
          onClick={() => setExtended(!extended)}
          style={{ flexShrink: 0, fontSize: 'var(--mobile-text-xs)' }}
        >
          AH
        </button>
        <button
          className="mobile-pill"
          onClick={fetchMovers}
          disabled={loading}
          style={{ flexShrink: 0 }}
        >
          {loading ? <Loader2 size={14} className="mobile-spinner" /> : <RefreshCw size={14} />}
        </button>
        <button
          className="mobile-pill"
          style={{ flexShrink: 0 }}
          onClick={() => onExplain?.(
            `Explain today's movers view (${MOVEMENT_WINDOWS[window]?.label || window}, universe: ${universe}${extended ? ', extended-hours' : ''}): strongest/weakest names, unusual volume, likely catalysts, and what to watch next.`,
            'Explain Moves'
          )}
        >
          <MessageCircleQuestion size={14} />
        </button>
      </div>

      {/* Loading */}
      {loading && movers.length === 0 && (
        <div className="mobile-loading">
          <div className="mobile-spinner" />
          <span>Loading movements...</span>
        </div>
      )}

      {/* Updating with previously loaded rows still visible */}
      {loading && movers.length > 0 && (
        <div className="mobile-updating-bar">
          <div className="mobile-spinner" />
          <span>Updating movers · {movers.length} loaded</span>
        </div>
      )}

      {/* Empty */}
      {!loading && filtered.length === 0 && (
        <div className="mobile-loading">
          <Activity size={32} style={{ opacity: 0.3 }} />
          <span>No movements found</span>
        </div>
      )}

      {/* Gainers & Losers stacked full-width for readability on narrow screens */}
      {!loading && activeTab === 'both' && filtered.length > 0 && (
        <div>
          {/* Gainers */}
          <div>
            <div style={{
              fontSize: 'var(--mobile-text-sm)',
              fontWeight: 700,
              color: 'var(--brand-green)',
              padding: '6px 10px',
              borderBottom: '2px solid var(--brand-green)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}>
              <TrendingUp size={12} />
              Gainers ({gainers.length})
            </div>
            <div style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
              {gainers.length === 0 && (
                <div style={{ padding: '12px 10px', fontSize: 'var(--mobile-text-sm)', color: 'var(--text-secondary)', textAlign: 'center' }}>
                  None
                </div>
              )}
              {gainers.map(m => (
                <MoverRow
                  key={m.ticker}
                  mover={m}
                  color="var(--brand-green)"
                  onClick={() => fetchTickerDetail(m.ticker)}
                  signal={signalMap[m.ticker]}
                  signalLoading={signalLoading}
                />
              ))}
            </div>
          </div>

          {/* Losers */}
          <div style={{ marginTop: 10 }}>
            <div style={{
              fontSize: 'var(--mobile-text-sm)',
              fontWeight: 700,
              color: 'var(--brand-red)',
              padding: '6px 10px',
              borderBottom: '2px solid var(--brand-red)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}>
              <TrendingDown size={12} />
              Losers ({losers.length})
            </div>
            <div style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
              {losers.length === 0 && (
                <div style={{ padding: '12px 10px', fontSize: 'var(--mobile-text-sm)', color: 'var(--text-secondary)', textAlign: 'center' }}>
                  None
                </div>
              )}
              {losers.map(m => (
                <MoverRow
                  key={m.ticker}
                  mover={m}
                  color="var(--brand-red)"
                  onClick={() => fetchTickerDetail(m.ticker)}
                  signal={signalMap[m.ticker]}
                  signalLoading={signalLoading}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Volume tab */}
      {!loading && activeTab === 'volume' && byVolume.length > 0 && (
        <div>
          <div style={{
            fontSize: 'var(--mobile-text-xs)',
            fontWeight: 700,
            color: 'var(--brand-blue)',
            padding: '6px 8px',
            borderBottom: '2px solid var(--brand-blue)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}>
            <BarChart3 size={12} />
            Most Active by Volume ({byVolume.length})
          </div>
          <div style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
            {byVolume.map(m => (
              <div
                key={m.ticker}
                onClick={() => fetchTickerDetail(m.ticker)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '6px 8px',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  cursor: 'pointer',
                  gap: 6,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 'var(--mobile-text-xs)', width: 46, flexShrink: 0 }}>
                  {m.ticker}
                </div>
                <div style={{ flex: 1, fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {formatPrice(m.price)}
                  {signalMap[m.ticker] && (
                    <span style={{ marginLeft: 6, fontSize: 9 }}>
                      <span style={{ color: 'var(--brand-blue)' }}>{signalMap[m.ticker].volume_ratio != null ? `${signalMap[m.ticker].volume_ratio}x` : '·'}</span>
                      {' '}
                      <span style={{ color: 'var(--brand-green)' }}>{signalMap[m.ticker].up_times ?? 0}↑</span>
                      <span style={{ color: 'var(--brand-red)' }}>{signalMap[m.ticker].down_times ?? 0}↓</span>
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', width: 55, textAlign: 'right', flexShrink: 0 }}>
                  {formatVolume(m.volume)}
                </div>
                <div style={{
                  fontSize: 'var(--mobile-text-xs)',
                  fontWeight: 700,
                  color: (m.change_percent || 0) >= 0 ? 'var(--brand-green)' : 'var(--brand-red)',
                  width: 58,
                  textAlign: 'right',
                  flexShrink: 0,
                }}>
                  {formatPct(m.change_percent)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Volatility tab */}
      {!loading && activeTab === 'volatility' && byVolatility.length > 0 && (
        <div>
          <div style={{
            fontSize: 'var(--mobile-text-xs)',
            fontWeight: 700,
            color: '#f59e0b',
            padding: '6px 8px',
            borderBottom: '2px solid #f59e0b',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}>
            <Zap size={12} />
            Most Volatile ({byVolatility.length})
          </div>
          <div style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
            {byVolatility.map(m => (
              <div
                key={m.ticker}
                onClick={() => fetchTickerDetail(m.ticker)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '6px 8px',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  cursor: 'pointer',
                  gap: 6,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 'var(--mobile-text-xs)', width: 46, flexShrink: 0 }}>
                  {m.ticker}
                </div>
                <div style={{ flex: 1, fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {formatPrice(m.price)}
                  {signalMap[m.ticker] && (
                    <span style={{ marginLeft: 6, fontSize: 9 }}>
                      <span style={{ color: 'var(--brand-blue)' }}>{signalMap[m.ticker].volume_ratio != null ? `${signalMap[m.ticker].volume_ratio}x` : '·'}</span>
                      {' '}
                      <span style={{ color: 'var(--brand-green)' }}>{signalMap[m.ticker].up_times ?? 0}↑</span>
                      <span style={{ color: 'var(--brand-red)' }}>{signalMap[m.ticker].down_times ?? 0}↓</span>
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', width: 55, textAlign: 'right', flexShrink: 0 }}>
                  {formatVolume(m.volume)}
                </div>
                <div style={{
                  fontSize: 'var(--mobile-text-xs)',
                  fontWeight: 700,
                  color: (m.change_percent || 0) >= 0 ? 'var(--brand-green)' : 'var(--brand-red)',
                  width: 58,
                  textAlign: 'right',
                  flexShrink: 0,
                }}>
                  {formatPct(m.change_percent)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Detail Bottom Sheet */}
      {selectedTicker && (
        <div className="mobile-sheet-overlay" onClick={() => setSelectedTicker(null)}>
          <motion.div
            className="mobile-sheet"
            style={sheetStyle}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="mobile-sheet-handle"
              {...handleProps}
            />
            <div className="mobile-sheet-header">
              <div>
                <span className="mobile-sheet-title">{selectedTicker}</span>
                {detailData && detailData.name && detailData.name !== selectedTicker && (
                  <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', marginLeft: 8 }}>
                    {detailData.name}
                  </span>
                )}
              </div>
              <button className="mobile-header-btn" onClick={() => setSelectedTicker(null)}>
                <X size={20} />
              </button>
            </div>

            {detailData && (
              <div style={{ padding: '0 var(--mobile-p-md)', marginBottom: 'var(--mobile-spacing-sm)' }}>
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 10px',
                  borderRadius: 10,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}>
                  <span style={{
                    fontSize: 'var(--mobile-text-lg)',
                    fontWeight: 700,
                    color: (detailData.change_percent ?? 0) >= 0 ? 'var(--brand-green)' : 'var(--brand-red)',
                  }}>
                    {formatPct(detailData.change_percent)}
                  </span>
                  <span style={{ fontSize: 'var(--mobile-text-sm)', color: 'var(--text-secondary)' }}>
                    {formatPrice(detailData.current_price)}
                  </span>
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="mobile-pills" style={{ padding: 0, margin: '0 var(--mobile-p-md) var(--mobile-spacing-sm)' }}>
              <button
                className={`mobile-pill ${detailTab === 'info' ? 'active' : ''}`}
                onClick={() => setDetailTab('info')}
              >
                Info
              </button>
              <button
                className={`mobile-pill ${detailTab === 'news' ? 'active' : ''}`}
                onClick={() => setDetailTab('news')}
              >
                News {news.length > 0 && `(${news.length})`}
              </button>
              <button
                className={`mobile-pill ${detailTab === 'chart' ? 'active' : ''}`}
                onClick={() => setDetailTab('chart')}
              >
                Chart
              </button>
              <button
                className={`mobile-pill ${detailTab === 'signals' ? 'active' : ''}`}
                onClick={() => setDetailTab('signals')}
              >
                Signals
              </button>
              <button
                className={`mobile-pill ${detailTab === 'insider' ? 'active' : ''}`}
                onClick={() => setDetailTab('insider')}
              >
                Insider
              </button>
            </div>

            <div className="mobile-sheet-content" style={detailTab === 'chart' ? { padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } : {}}>
              {detailLoading && (
                <div className="mobile-loading">
                  <div className="mobile-spinner" />
                  <span>Loading...</span>
                </div>
              )}

              {/* Info Tab */}
              {!detailLoading && detailTab === 'info' && detailData && (
                <div className="mobile-card" style={{ margin: 0 }}>
                  <div className="mobile-stats-grid">
                    <div className="mobile-stat">
                      <div className="mobile-stat-label">Price</div>
                      <div className="mobile-stat-value">{formatPrice(detailData.current_price)}</div>
                    </div>
                    <div className="mobile-stat">
                      <div className="mobile-stat-label">Change</div>
                      <div className={`mobile-stat-value ${(detailData.change_percent ?? 0) >= 0 ? 'positive' : 'negative'}`}>
                        {formatPct(detailData.change_percent)}
                      </div>
                    </div>
                    <div className="mobile-stat">
                      <div className="mobile-stat-label">Market Cap</div>
                      <div className="mobile-stat-value">
                        {detailData.market_cap != null ? '$' + (detailData.market_cap / 1e9).toFixed(1) + 'B' : '-'}
                      </div>
                    </div>
                    <div className="mobile-stat">
                      <div className="mobile-stat-label">P/E</div>
                      <div className="mobile-stat-value">{detailData.pe_ratio?.toFixed(2) ?? '-'}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* News Tab */}
              {detailTab === 'news' && (
                <>
                  {newsLoading && (
                    <div className="mobile-loading">
                      <div className="mobile-spinner" />
                      <span>Loading news...</span>
                    </div>
                  )}
                  {!newsLoading && news.length === 0 && (
                    <div className="mobile-loading" style={{ opacity: 0.5 }}>
                      <span>No recent news</span>
                    </div>
                  )}
                  {!newsLoading && news.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {news.slice(0, newsVisibleCount).map((a, i) => (
                        <a key={i} href={a.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                          <div className="mobile-card" style={{ margin: 0, padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, fontSize: 'var(--mobile-text-sm)' }}>{a.title}</div>
                            <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                              {a.publisher || ''} · {timeAgo(a.published)}
                            </div>
                          </div>
                        </a>
                      ))}
                      {newsVisibleCount < news.length && (
                        <button
                          className="mobile-pill"
                          style={{ alignSelf: 'center', marginTop: 4 }}
                          onClick={() => setNewsVisibleCount(count => Math.min(count + 8, news.length))}
                        >
                          Show more ({news.length - newsVisibleCount})
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Signals Tab */}
              {detailTab === 'signals' && selectedTicker && (
                <MobileSignals ticker={selectedTicker} />
              )}

              {/* Insider Tab */}
              {detailTab === 'insider' && selectedTicker && (
                <MobileInsiderTrades ticker={selectedTicker} onClose={() => setDetailTab('info')} />
              )}

              {/* Chart Tab */}
              {detailTab === 'chart' && (
                <div className="mobile-chart-container" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  <div style={{ display: 'flex', gap: 6, padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
                    {CHART_INTERVALS.map(iv => (
                      <button
                        key={iv.key}
                        className={`mobile-pill ${chartInterval === iv.key ? 'active' : ''}`}
                        onClick={() => setChartInterval(iv.key)}
                        style={{ fontSize: 'var(--mobile-text-xs)', padding: '4px 10px' }}
                      >
                        {iv.label}
                      </button>
                    ))}
                  </div>
                  <div className="mobile-chart-body" style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
                    {chartLoading && (
                      <div className="mobile-loading">
                        <div className="mobile-spinner" />
                      </div>
                    )}
                    {!chartLoading && chartData && (
                      <Suspense fallback={<div className="mobile-loading"><div className="mobile-spinner" /></div>}>
                        <ChartViewer
                          data={chartData}
                          fileName={`${selectedTicker}-${chartInterval}-`}
                          simple
                          height={320}
                        />
                      </Suspense>
                    )}
                    {!chartLoading && !chartData && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12 }}>
                        <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)' }}>
                          Could not load price data
                        </span>
                        <button className="mobile-pill active" onClick={() => loadChart(selectedTicker, chartInterval)}>
                          <Activity size={16} /> Retry
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default MobileMovements;
