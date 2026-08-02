import React, { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import axios from 'axios';
import Papa from 'papaparse';
import { RefreshCw, X, Zap, Loader2, MessageCircleQuestion } from 'lucide-react';
import { motion } from 'framer-motion';
import { INTELLIGENCE_SERVICE, DATA_SERVICE } from '../config';
import MobileInsiderTrades from './components/MobileInsiderTrades';
import MobileSignals from './components/MobileSignals';
import MobileSymbolSearch from './components/MobileSymbolSearch';

const ChartViewer = lazy(() => import('../components/ChartViewer'));

const INDUSTRY_PROXY_TICKERS = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'SMH', 'IGV', 'FDN', 'CIBR', 'SKYY', 'ROBO', 'DRAM', 'XLF', 'KBE', 'KRE', 'KIE', 'XLV', 'XBI', 'IHI', 'IBB', 'PJP', 'XHS', 'XLE', 'OIH', 'XOP', 'URNM', 'UCO', 'ICLN', 'TAN', 'LIT', 'DRIV', 'XLY', 'XLP', 'XRT', 'PEJ', 'IBUY', 'FTCA', 'XLI', 'ITA', 'IYT', 'XHB', 'XLB', 'COPX', 'XLRE', 'RWR', 'VNQ', 'XLU', 'IDU', 'XLC', 'MJ', 'PHO', 'DBA'];

const INDUSTRY_PROXY_META = {
    SPY: { name: 'S&P 500', sector: 'Broad Market', industry: 'Large Cap' },
    QQQ: { name: 'NASDAQ 100', sector: 'Broad Market', industry: 'Tech/Growth' },
    IWM: { name: 'Russell 2000', sector: 'Broad Market', industry: 'Small Cap' },
    DIA: { name: 'Dow Jones', sector: 'Broad Market', industry: 'Blue Chip' },
    XLK: { name: 'Technology Select', sector: 'Technology', industry: 'Broad Technology' },
    SMH: { name: 'Semiconductors', sector: 'Technology', industry: 'Semiconductors' },
    IGV: { name: 'Software', sector: 'Technology', industry: 'Software' },
    FDN: { name: 'Internet', sector: 'Technology', industry: 'Internet' },
    CIBR: { name: 'Cybersecurity', sector: 'Technology', industry: 'Cybersecurity' },
    SKYY: { name: 'Cloud Computing', sector: 'Technology', industry: 'Cloud' },
    ROBO: { name: 'Robotics & AI', sector: 'Technology', industry: 'Robotics/AI' },
    DRAM: { name: 'Memory', sector: 'Technology', industry: 'Memory Chips' },
    XLF: { name: 'Financial Select', sector: 'Financial Services', industry: 'Broad Financials' },
    KBE: { name: 'Bank ETF', sector: 'Financial Services', industry: 'Banks' },
    KRE: { name: 'Regional Banks', sector: 'Financial Services', industry: 'Regional Banks' },
    KIE: { name: 'Insurance', sector: 'Financial Services', industry: 'Insurance' },
    XLV: { name: 'Healthcare Select', sector: 'Healthcare', industry: 'Broad Healthcare' },
    XBI: { name: 'Biotech', sector: 'Healthcare', industry: 'Biotechnology' },
    IHI: { name: 'Medical Devices', sector: 'Healthcare', industry: 'Medical Devices' },
    IBB: { name: 'Biotech NASDAQ', sector: 'Healthcare', industry: 'Biotech NASDAQ' },
    PJP: { name: 'Pharmaceuticals', sector: 'Healthcare', industry: 'Pharmaceuticals' },
    XHS: { name: 'Healthcare Services', sector: 'Healthcare', industry: 'Healthcare Services' },
    XLE: { name: 'Energy Select', sector: 'Energy', industry: 'Broad Energy' },
    OIH: { name: 'Oil Services', sector: 'Energy', industry: 'Oil Services' },
    XOP: { name: 'Oil & Gas E&P', sector: 'Energy', industry: 'Oil Exploration' },
    URNM: { name: 'Uranium/Nuclear', sector: 'Energy', industry: 'Uranium' },
    UCO: { name: 'Crude Oil 2x', sector: 'Energy', industry: 'Crude Oil' },
    ICLN: { name: 'Clean Energy', sector: 'Clean Energy', industry: 'Renewables' },
    TAN: { name: 'Solar Energy', sector: 'Clean Energy', industry: 'Solar' },
    LIT: { name: 'Lithium/Battery', sector: 'Clean Energy', industry: 'Lithium/Battery' },
    DRIV: { name: 'Electric Vehicles', sector: 'Clean Energy', industry: 'EVs' },
    XLY: { name: 'Consumer Disc.', sector: 'Consumer Cyclical', industry: 'Broad Discretionary' },
    XLP: { name: 'Consumer Staples', sector: 'Consumer Defensive', industry: 'Broad Staples' },
    XRT: { name: 'Retail', sector: 'Consumer Cyclical', industry: 'Retail' },
    PEJ: { name: 'Leisure & Travel', sector: 'Consumer Cyclical', industry: 'Leisure' },
    IBUY: { name: 'E-Commerce', sector: 'Consumer Cyclical', industry: 'E-Commerce' },
    FTCA: { name: 'Food & Beverage', sector: 'Consumer Defensive', industry: 'Food & Bev' },
    XLI: { name: 'Industrial Select', sector: 'Industrials', industry: 'Broad Industrials' },
    ITA: { name: 'Aerospace & Defense', sector: 'Industrials', industry: 'Aerospace/Defense' },
    IYT: { name: 'Transportation', sector: 'Industrials', industry: 'Transportation' },
    XHB: { name: 'Homebuilders', sector: 'Industrials', industry: 'Home Construction' },
    XLB: { name: 'Materials Select', sector: 'Basic Materials', industry: 'Broad Materials' },
    COPX: { name: 'Copper Miners', sector: 'Basic Materials', industry: 'Copper' },
    XLRE: { name: 'Real Estate Select', sector: 'Real Estate', industry: 'Broad Real Estate' },
    RWR: { name: 'REIT ETF', sector: 'Real Estate', industry: 'REITs' },
    VNQ: { name: 'Vanguard REIT', sector: 'Real Estate', industry: 'REITs Broad' },
    XLU: { name: 'Utilities Select', sector: 'Utilities', industry: 'Broad Utilities' },
    IDU: { name: 'Utilities iShares', sector: 'Utilities', industry: 'Utilities Broad' },
    XLC: { name: 'Comm. Services', sector: 'Communication Services', industry: 'Broad Communication' },
    MJ: { name: 'Cannabis', sector: 'Cannabis', industry: 'Cannabis' },
    PHO: { name: 'Water Resources', sector: 'Utilities', industry: 'Water' },
    DBA: { name: 'Agriculture', sector: 'Basic Materials', industry: 'Agriculture' },
};

const SECTOR_COLORS = {
    'Broad Market': '#6b7280',
    Technology: '#3b82f6',
    'Financial Services': '#f59e0b',
    Healthcare: '#10b981',
    Energy: '#ef4444',
    'Clean Energy': '#22d3ee',
    'Consumer Cyclical': '#ec4899',
    'Consumer Defensive': '#6366f1',
    Industrials: '#14b8a6',
    'Basic Materials': '#f97316',
    'Real Estate': '#a855f7',
    Utilities: '#22d3ee',
    'Communication Services': '#f43f5e',
    Cannabis: '#16a34a',
};

const BATCH_SIZE = 8;
const BATCH_CONCURRENCY = 3;

const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

const isEtfTicker = (ticker) => Boolean(INDUSTRY_PROXY_META[String(ticker || '').toUpperCase()]);

const PERIOD_OPTIONS = ['1d', '5d', '1mo', '3mo', '6mo', '1y', 'ytd', 'max'];

const CHART_INTERVALS = [
  { key: '1d', label: '1D' },
  { key: '5d', label: '5D' },
  { key: '1mo', label: '1Mo' },
  { key: '3mo', label: '3Mo' },
];

const getTileColor = (pct) => {
  if (pct == null || !Number.isFinite(Number(pct))) return 'var(--bg-accent)';
  const i = Math.min(Math.abs(pct) / 4, 1);
  if (pct >= 0) {
    const g = Math.round(190 - i * 140);
    const b = Math.round(120 - i * 90);
    return `rgb(0,${g},${b})`;
  }
  const r = Math.round(210 - i * 110);
  const g = Math.round(70 - i * 50);
  const b = Math.round(70 - i * 50);
  return `rgb(${r},${g},${b})`;
};

const formatPct = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};

const formatPrice = (value) => {
  if (value == null) return '-';
  return '$' + Number(value).toFixed(2);
};

const timeAgo = (iso) => {
  if (!iso) return '';
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
};

const MobileMarketOverview = ({ notify, onBacktestTicker, onExplain }) => {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [period, setPeriod] = useState('1d');
  const [marketIndices, setMarketIndices] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortAsc, setSortAsc] = useState(false);
  const [extended, setExtended] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailTab, setDetailTab] = useState('holdings');
  const [holdings, setHoldings] = useState(null);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [holdingsSortAsc, setHoldingsSortAsc] = useState(false);
  const [news, setNews] = useState([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsVisibleCount, setNewsVisibleCount] = useState(8);
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailIsEtf, setDetailIsEtf] = useState(true);
  const [chartData, setChartData] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartInterval, setChartInterval] = useState('1d');

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

  // Auto-load the chart when an item is selected (no manual "Load Chart" tap needed)
  useEffect(() => {
    if (selectedItem) {
      setChartData(null);
      loadChart(selectedItem.ticker, chartInterval);
    }
  }, [selectedItem, chartInterval, loadChart]);

  useEffect(() => {
    fetchMarketData();
  }, [period, extended]);

  const fetchMarketData = async () => {
    setLoading(true);
    setItems(null);
    setProgress({ completed: 0, total: INDUSTRY_PROXY_TICKERS.length, label: 'Fetching market indices...' });
    try {
      const params = `period=${period}`;
      const ext = extended ? '&extended=true' : '';
      const overviewRes = await axios.get(`${INTELLIGENCE_SERVICE}/market-overview?${params}${ext}`, { timeout: 20000 });
      const overviewData = overviewRes.data;
      if (overviewData.indices) {
        const indicesArray = Array.isArray(overviewData.indices)
          ? overviewData.indices
          : Object.values(overviewData.indices);
        setMarketIndices(indicesArray);
      }

      const batches = chunkArray(INDUSTRY_PROXY_TICKERS, BATCH_SIZE);
      let completed = 0;
      let cursor = 0;
      let accumulated = [];

      const fetchBatch = async (batch) => {
        try {
          const res = await axios.post(`${INTELLIGENCE_SERVICE}/batch-price-changes?${params}${ext}`, batch, { timeout: 25000 });
          const quotes = res.data.quotes || [];
          const mapped = quotes.map(q => {
            const ticker = String(q.symbol || q.ticker || '').toUpperCase();
            const meta = INDUSTRY_PROXY_META[ticker] || { name: ticker, sector: 'ETF', industry: ticker };
            return {
              ticker,
              name: meta.name,
              sector: meta.sector,
              industry: meta.industry,
              price: q.price,
              change: q.change,
              change_percent: q.change_percent != null ? Number(q.change_percent) : null,
              sectorColor: SECTOR_COLORS[meta.sector] || '#444',
            };
          });
          accumulated = [...accumulated, ...mapped];
          setItems([...accumulated]);
        } catch (e) {
          console.warn('Batch failed:', batch, e);
        } finally {
          completed += batch.length;
          setProgress({
            completed: Math.min(completed, INDUSTRY_PROXY_TICKERS.length),
            total: INDUSTRY_PROXY_TICKERS.length,
            label: `Loaded ${Math.min(completed, INDUSTRY_PROXY_TICKERS.length)} of ${INDUSTRY_PROXY_TICKERS.length} ETFs`,
          });
        }
      };

      await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, async () => {
        while (cursor < batches.length) {
          const batch = batches[cursor];
          cursor += 1;
          await fetchBatch(batch);
        }
      }));
    } catch (e) {
      console.error('Failed to fetch market data:', e);
      notify('Failed to load market data', 'red');
    }
    setProgress(null);
    setLoading(false);
  };

  const fetchTickerDetail = async (item) => {
    setSelectedItem(item);
    const isEtf = item.isEtf != null ? item.isEtf : isEtfTicker(item.ticker);
    setDetailIsEtf(isEtf);
    setDetailTab(isEtf ? 'holdings' : 'news');
    setDetailLoading(true);
    setDetailData(null);
    setChartData(null);
    setHoldings(null);
    setNews([]);
    setNewsVisibleCount(8);

    try {
      const params = `period=${period}`;
      const ext = extended ? '&extended=true' : '';
      setNewsLoading(true);
      const holdingsReq = isEtf
        ? axios.post(`${INTELLIGENCE_SERVICE}/etf-holdings?${params}${ext}`, [item.ticker], { timeout: 90000 }).catch(() => ({ data: {} }))
        : Promise.resolve({ data: {} });
      const [infoRes, holdingsRes, newsRes] = await Promise.all([
        axios.get(`${INTELLIGENCE_SERVICE}/info/${item.ticker}`).catch(() => ({ data: null })),
        holdingsReq,
        axios.get(`${INTELLIGENCE_SERVICE}/news/${item.ticker}?limit=30`).catch(() => ({ data: { news: [] } })),
      ]);

      if (infoRes.data) {
        const d = infoRes.data;
        if (d.current_price && d.previous_close && d.change_percent == null) {
          d.change_percent = ((d.current_price - d.previous_close) / d.previous_close) * 100;
        }
        setDetailData(d);
      }

      const h = holdingsRes.data.holdings || {};
      setHoldings(isEtf ? (h[item.ticker] || []) : []);

      setNews(newsRes.data.news || []);
    } catch (e) {
      console.error('Failed to fetch detail:', e);
      notify('Failed to load stock details', 'red');
    } finally {
      setNewsLoading(false);
    }
    setDetailLoading(false);
  };

  // Fetch chart data for ticker
  const fetchChartData = async (ticker) => {
    setChartLoading(true);
    try {
      const checkRes = await axios.get(`${DATA_SERVICE}/check/${ticker}`);
      if (checkRes.data.available && checkRes.data.files.length > 0) {
        const dailyFile = checkRes.data.files.find(f => f.includes('-1d-')) || checkRes.data.files[0];
        const dataRes = await axios.get(`${DATA_SERVICE}/data/${dailyFile}?t=${Date.now()}`);
        const parsed = Papa.parse(dataRes.data, { header: true, skipEmptyLines: true });
        setChartData(parsed.data);
      }
    } catch (e) {
      console.error('Failed to fetch chart data:', e);
    }
    setChartLoading(false);
  };

  // Filter sectors by search
  const filteredItems = useMemo(() => {
    let list = items;
    if (searchQuery && items) {
      const q = searchQuery.toLowerCase();
      list = items.filter(item =>
        item.ticker.toLowerCase().includes(q) ||
        item.industry.toLowerCase().includes(q) ||
        item.sector.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q)
      );
    }
    if (list) {
      list = [...list].sort((a, b) => {
        const va = a.change_percent ?? -999;
        const vb = b.change_percent ?? -999;
        return sortAsc ? va - vb : vb - va;
      });
    }
    return list;
  }, [items, searchQuery, sortAsc]);

  return (
    <div className="mobile-p-md">
      {/* Market Indices Bar */}
      {marketIndices && (
        <div className="mobile-pills" style={{ padding: 0, marginBottom: 'var(--mobile-spacing-md)' }}>
          {marketIndices.map((index) => {
            const changePercent = index.change_percent;
            const isPositive = changePercent >= 0;
            return (
              <div
                key={index.symbol}
                className="mobile-pill"
                style={{
                  minWidth: 100,
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)',
                }}
              >
                <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)' }}>
                  {index.name || index.symbol}
                </span>
                <span style={{ fontSize: 'var(--mobile-text-base)', fontWeight: 700 }}>
                  {formatPrice(index.price)}
                </span>
                <span style={{ 
                  fontSize: 'var(--mobile-text-xs)', 
                  color: isPositive ? 'var(--brand-green)' : 'var(--brand-red)',
                  fontWeight: 600,
                }}>
                  {formatPct(changePercent)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Period Selector + Refresh */}
      <div style={{ display: 'flex', gap: 'var(--mobile-spacing-sm)', marginBottom: 'var(--mobile-spacing-md)' }}>
        <div className="mobile-pills" style={{ padding: 0, flex: 1 }}>
          {PERIOD_OPTIONS.map((p) => (
            <button
              key={p}
              className={`mobile-pill ${period === p ? 'active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          className="mobile-pill"
          onClick={fetchMarketData}
          disabled={loading}
          style={{ flexShrink: 0 }}
        >
          {loading ? <Loader2 size={14} className="mobile-spinner" /> : <RefreshCw size={14} />}
        </button>
        <button
          className="mobile-pill"
          style={{ flexShrink: 0 }}
          onClick={() => onExplain?.(
            `Give me a concise market situation update for period ${period}${extended ? ' with extended-hours context' : ''}: breadth, strongest/weakest groups, key risks, and what to watch next.`,
            'Explain Market'
          )}
        >
          <MessageCircleQuestion size={14} />
        </button>
      </div>

      {/* Search + Sort */}
      <div style={{ display: 'flex', gap: 'var(--mobile-spacing-sm)', marginBottom: 'var(--mobile-spacing-md)' }}>
        <MobileSymbolSearch
          onSelect={(r) => {
            const fakeItem = {
              ticker: r.ticker,
              name: r.name || r.ticker,
              sector: 'Search',
              industry: r.name || r.ticker,
              change_percent: null,
              sectorColor: '#555',
              isEtf: String(r.type || '').toUpperCase() === 'ETF' ? true : undefined,
            };
            fetchTickerDetail(fakeItem);
          }}
          onSelectLocal={(m) => setSearchQuery(m.ticker)}
          localOptions={items ? items.map(i => ({ ticker: i.ticker, name: i.name })) : []}
          placeholder="Search tickers or companies..."
        />
        <button
          className={`mobile-pill ${sortAsc ? 'active' : ''}`}
          onClick={() => setSortAsc(!sortAsc)}
          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {sortAsc ? '↑ Low' : '↓ High'}
        </button>
        <button
          className={`mobile-pill ${extended ? 'active' : ''}`}
          onClick={() => setExtended(!extended)}
          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          AH
        </button>
      </div>

      {/* Progress Bar */}
      {progress && (
        <div style={{ marginBottom: 'var(--mobile-spacing-md)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)' }}>{progress.label}</span>
            <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)' }}>
              {progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0}%
            </span>
          </div>
          <div style={{ height: 4, background: 'var(--bg-accent)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%`,
              background: 'var(--brand-green)',
              borderRadius: 2,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}

      {/* Loading State */}
      {loading && !filteredItems && (
        <div className="mobile-loading">
          <div className="mobile-spinner" />
          <span>Loading market data...</span>
        </div>
      )}

      {/* Heatmap Grid */}
      {filteredItems && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', borderRadius: '8px', overflow: 'hidden' }}>
          {filteredItems.map((item) => (
            <button
              key={item.ticker}
              onClick={() => fetchTickerDetail(item)}
              style={{
                flex: '1 1 45%',
                minWidth: 100,
                padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)',
                paddingLeft: '12px',
                background: getTileColor(item.change_percent),
                border: 'none',
                borderLeft: `3px solid ${item.sectorColor}`,
                borderRadius: '2px',
                cursor: 'pointer',
                textAlign: 'center',
                minHeight: 60,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: 'var(--mobile-text-sm)', fontWeight: 700, color: 'rgba(255,255,255,0.95)' }}>
                {item.industry}
              </span>
              <span style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(255,255,255,0.6)', marginTop: 2, textTransform: 'uppercase' }}>
                {item.ticker}
              </span>
              <span style={{ fontSize: 'var(--mobile-text-sm)', fontWeight: 600, color: 'rgba(255,255,255,0.9)', marginTop: 4 }}>
                {formatPct(item.change_percent)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Detail Bottom Sheet */}
      {selectedItem && (
        <div className="mobile-sheet-overlay" onClick={() => setSelectedItem(null)}>
          <motion.div
            className="mobile-sheet"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mobile-sheet-handle" />
            <div className="mobile-sheet-header">
              <div>
                <span className="mobile-sheet-title">{selectedItem.industry}</span>
                <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', marginLeft: 8 }}>
                  {selectedItem.ticker} · {selectedItem.sector}
                </span>
              </div>
              <button className="mobile-header-btn" onClick={() => setSelectedItem(null)}>
                <X size={20} />
              </button>
            </div>

            {/* Change badge */}
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
                  color: (selectedItem.change_percent ?? 0) >= 0 ? 'var(--brand-green)' : 'var(--brand-red)',
                }}>
                  {formatPct(selectedItem.change_percent)}
                </span>
                {detailData && (
                  <span style={{ fontSize: 'var(--mobile-text-sm)', color: 'var(--text-secondary)' }}>
                    {formatPrice(detailData.current_price)}
                  </span>
                )}
              </div>
            </div>

            {/* Tabs */}
            <div className="mobile-pills" style={{ padding: 0, margin: '0 var(--mobile-p-md) var(--mobile-spacing-sm)' }}>
              {detailIsEtf && (
                <button
                  className={`mobile-pill ${detailTab === 'holdings' ? 'active' : ''}`}
                  onClick={() => setDetailTab('holdings')}
                >
                  Holdings {holdings && `(${holdings.length})`}
                </button>
              )}
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

            <div className="mobile-sheet-content">
              {detailLoading && (
                <div className="mobile-loading">
                  <div className="mobile-spinner" />
                  <span>Loading...</span>
                </div>
              )}

              {/* Holdings Tab */}
              {!detailLoading && detailTab === 'holdings' && (
                <>
                  {holdingsLoading && (
                    <div className="mobile-loading">
                      <div className="mobile-spinner" />
                      <span>Loading holdings...</span>
                    </div>
                  )}
                  {!holdingsLoading && holdings && holdings.length === 0 && (
                    <div className="mobile-loading" style={{ opacity: 0.5 }}>
                      <span>No holdings data</span>
                    </div>
                  )}
                  {!holdingsLoading && holdings && holdings.length > 0 && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                        <button
                          className="mobile-pill"
                          style={{ fontSize: 'var(--mobile-text-xs)', padding: '2px 8px' }}
                          onClick={() => setHoldingsSortAsc(!holdingsSortAsc)}
                        >
                          Change {holdingsSortAsc ? '↑ Low' : '↓ High'}
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {[...holdings].sort((a, b) => {
                          const va = a.change_percent ?? -999;
                          const vb = b.change_percent ?? -999;
                          return holdingsSortAsc ? va - vb : vb - va;
                        }).map((h) => (
                          <div key={h.ticker} onClick={() => {
                            const fakeItem = {
                              ticker: h.ticker,
                              name: h.name,
                              sector: selectedItem.sector,
                              industry: h.name || h.ticker,
                              change_percent: h.change_percent,
                              sectorColor: selectedItem.sectorColor,
                            };
                            fetchTickerDetail(fakeItem);
                          }} style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)',
                            background: getTileColor(h.change_percent),
                            borderRadius: 'var(--mobile-card-radius)',
                            cursor: 'pointer',
                            gap: 8,
                          }}>
                            <div style={{ fontWeight: 700, fontSize: 'var(--mobile-text-sm)', width: 55, flexShrink: 0 }}>
                              {h.ticker}
                            </div>
                            <div style={{ flex: 1, fontSize: 'var(--mobile-text-xs)', color: 'rgba(255,255,255,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {h.name || '-'}
                            </div>
                            {h.weight != null && (
                              <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'rgba(255,255,255,0.6)', width: 40, textAlign: 'right', flexShrink: 0 }}>
                                {h.weight.toFixed(1)}%
                              </div>
                            )}
                            <div style={{
                              fontSize: 'var(--mobile-text-xs)',
                              fontWeight: 600,
                              color: (h.change_percent ?? 0) >= 0 ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.95)',
                              width: 55,
                              textAlign: 'right',
                              flexShrink: 0,
                            }}>
                              {formatPct(h.change_percent)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {!holdings && !holdingsLoading && (
                    <div className="mobile-loading">
                      <div className="mobile-spinner" />
                      <span>Loading holdings...</span>
                    </div>
                  )}
                </>
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
              {detailTab === 'signals' && selectedItem && (
                <MobileSignals ticker={selectedItem.ticker} />
              )}

              {/* Insider Tab */}
              {detailTab === 'insider' && selectedItem && (
                <MobileInsiderTrades ticker={selectedItem.ticker} onClose={() => setDetailTab(detailIsEtf ? 'holdings' : 'news')} />
              )}

              {/* Chart Tab */}
              {detailTab === 'chart' && (
                <div className="mobile-chart-container">
                  <div style={{ display: 'flex', gap: 6, padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)', borderBottom: '1px solid var(--border-subtle)' }}>
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
                  <div className="mobile-chart-body">
                    {chartLoading && (
                      <div className="mobile-loading">
                        <div className="mobile-spinner" />
                      </div>
                    )}
                    {!chartLoading && chartData && (
                      <Suspense fallback={<div className="mobile-loading"><div className="mobile-spinner" /></div>}>
                        <ChartViewer
                          data={chartData}
                          fileName={`${selectedItem.ticker}-${chartInterval}-`}
                          simple
                          height={320}
                        />
                      </Suspense>
                    )}
                    {!chartLoading && !chartData && (
                      <div className="mobile-loading" style={{ height: '100%' }}>
                        <span style={{ fontSize: 'var(--mobile-text-sm)', color: 'var(--text-secondary)' }}>
                          Could not load price data
                        </span>
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

export default MobileMarketOverview;
