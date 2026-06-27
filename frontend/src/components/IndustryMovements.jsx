import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { INTELLIGENCE_SERVICE } from '../config';
import { RefreshCw, TrendingUp, TrendingDown, Search, Newspaper, Filter, Loader2, MessageCircleQuestion, Activity, Save, Trash2, X, Bell, BellRing } from 'lucide-react';

const MAJOR_STOCKS = [
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO',
    'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'BLK',
    'JNJ', 'UNH', 'LLY', 'ABBV', 'MRK', 'PFE', 'TMO', 'AMGN',
    'WMT', 'COST', 'HD', 'MCD', 'SBUX', 'NKE', 'LOW', 'DIS',
    'XOM', 'CVX', 'COP', 'SLB', 'EOG',
    'CAT', 'BA', 'GE', 'HON', 'MMM', 'UPS', 'RTX', 'LMT',
    'NFLX', 'CMCSA', 'VZ', 'T', 'TMUS',
    'ORCL', 'CRM', 'ADBE', 'CSCO', 'AMD', 'INTC', 'IBM', 'QCOM',
    'PYPL', 'UBER', 'XYZ', 'SNAP',
    'PG', 'KO', 'PEP', 'PM',
];

const MOVEMENT_CHUNK_SIZE = 8;
const MOVEMENT_CHUNK_CONCURRENCY = 3;
const MOVEMENT_CACHE_TTL_MS = 60_000;
const NEWS_MOVER_PAGE_SIZE = 6;

const MOVEMENT_WINDOWS = {
    '5m': { label: '5 Min', period: '1d', interval: '5m' },
    '15m': { label: '15 Min', period: '1d', interval: '15m' },
    '30m': { label: '30 Min', period: '1d', interval: '30m' },
    '1h': { label: '1 Hour', period: '1d', interval: '60m' },
    '1d': { label: '1 Day', period: '1d', interval: null, quoteFastPath: true },
    '5d': { label: '5 Days', period: '5d', interval: null },
    '1mo': { label: '1 Month', period: '1mo', interval: null },
    '3mo': { label: '3 Months', period: '3mo', interval: null },
    '6mo': { label: '6 Months', period: '6mo', interval: null },
    '1y': { label: '1 Year', period: '1y', interval: null },
};

const SIGNAL_PERIOD_OPTIONS = [
    { value: '1d', label: '1D history' },
    { value: '5d', label: '5D history' },
    { value: '1mo', label: '1M history' },
    { value: '3mo', label: '3M history' },
    { value: '6mo', label: '6M history' },
    { value: '1y', label: '1Y history' },
];

const SIGNAL_INTERVAL_OPTIONS = [
    { value: '1m', label: '1 Min candles', style: 'Day', periods: ['1d', '5d'] },
    { value: '2m', label: '2 Min candles', style: 'Day', periods: ['1d', '5d', '1mo'] },
    { value: '5m', label: '5 Min candles', style: 'Day', periods: ['1d', '5d', '1mo'] },
    { value: '15m', label: '15 Min candles', style: 'Day', periods: ['1d', '5d', '1mo'] },
    { value: '30m', label: '30 Min candles', style: 'Day/Swing', periods: ['1d', '5d', '1mo'] },
    { value: '60m', label: '1H candles', style: 'Swing', periods: ['1d', '5d', '1mo', '3mo', '6mo', '1y'] },
    { value: '90m', label: '90M candles', style: 'Swing', periods: ['1d', '5d', '1mo'] },
    { value: '1d', label: '1D candles', style: 'Swing', periods: ['5d', '1mo', '3mo', '6mo', '1y'] },
];

const getSignalIntervalOption = (interval) => SIGNAL_INTERVAL_OPTIONS.find(option => option.value === interval) || SIGNAL_INTERVAL_OPTIONS[SIGNAL_INTERVAL_OPTIONS.length - 1];

const normalizeSignalPeriod = (period, interval) => {
    const option = getSignalIntervalOption(interval);
    if (option.periods.includes(period)) return period;
    if (option.periods.includes('1mo')) return '1mo';
    if (option.periods.includes('5d')) return '5d';
    return option.periods[0];
};

const STOCK_META = {
    AAPL: ['Technology', 'Consumer Electronics'], MSFT: ['Technology', 'Software'], NVDA: ['Technology', 'Semiconductors'], GOOGL: ['Communication Services', 'Internet'], AMZN: ['Consumer Cyclical', 'Internet Retail'], META: ['Communication Services', 'Internet'], TSLA: ['Consumer Cyclical', 'Auto Manufacturers'], AVGO: ['Technology', 'Semiconductors'],
    JPM: ['Financial Services', 'Banks'], V: ['Financial Services', 'Payments'], MA: ['Financial Services', 'Payments'], BAC: ['Financial Services', 'Banks'], WFC: ['Financial Services', 'Banks'], GS: ['Financial Services', 'Capital Markets'], MS: ['Financial Services', 'Capital Markets'], BLK: ['Financial Services', 'Asset Management'],
    JNJ: ['Healthcare', 'Drug Manufacturers'], UNH: ['Healthcare', 'Healthcare Plans'], LLY: ['Healthcare', 'Drug Manufacturers'], ABBV: ['Healthcare', 'Drug Manufacturers'], MRK: ['Healthcare', 'Drug Manufacturers'], PFE: ['Healthcare', 'Drug Manufacturers'], TMO: ['Healthcare', 'Diagnostics & Research'], AMGN: ['Healthcare', 'Biotechnology'],
    WMT: ['Consumer Defensive', 'Discount Stores'], COST: ['Consumer Defensive', 'Discount Stores'], HD: ['Consumer Cyclical', 'Home Improvement'], MCD: ['Consumer Cyclical', 'Restaurants'], SBUX: ['Consumer Cyclical', 'Restaurants'], NKE: ['Consumer Cyclical', 'Apparel'], LOW: ['Consumer Cyclical', 'Home Improvement'], DIS: ['Communication Services', 'Entertainment'],
    XOM: ['Energy', 'Oil & Gas Integrated'], CVX: ['Energy', 'Oil & Gas Integrated'], COP: ['Energy', 'Oil & Gas E&P'], SLB: ['Energy', 'Oil Services'], EOG: ['Energy', 'Oil & Gas E&P'],
    CAT: ['Industrials', 'Farm & Heavy Machinery'], BA: ['Industrials', 'Aerospace & Defense'], GE: ['Industrials', 'Specialty Industrial Machinery'], HON: ['Industrials', 'Conglomerates'], MMM: ['Industrials', 'Conglomerates'], UPS: ['Industrials', 'Integrated Freight'], RTX: ['Industrials', 'Aerospace & Defense'], LMT: ['Industrials', 'Aerospace & Defense'],
    NFLX: ['Communication Services', 'Entertainment'], CMCSA: ['Communication Services', 'Telecom Services'], VZ: ['Communication Services', 'Telecom Services'], T: ['Communication Services', 'Telecom Services'], TMUS: ['Communication Services', 'Telecom Services'],
    ORCL: ['Technology', 'Software'], CRM: ['Technology', 'Software'], ADBE: ['Technology', 'Software'], CSCO: ['Technology', 'Communication Equipment'], AMD: ['Technology', 'Semiconductors'], INTC: ['Technology', 'Semiconductors'], IBM: ['Technology', 'Information Technology Services'], QCOM: ['Technology', 'Semiconductors'],
    PYPL: ['Financial Services', 'Payments'], UBER: ['Technology', 'Software'], XYZ: ['Technology', 'Software'], SNAP: ['Communication Services', 'Internet'],
    PG: ['Consumer Defensive', 'Household Products'], KO: ['Consumer Defensive', 'Beverages'], PEP: ['Consumer Defensive', 'Beverages'], PM: ['Consumer Defensive', 'Tobacco'],
};

const FALLBACK_HIGH_VOLUME = [
    'SPY', 'QQQ', 'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'NVDA', 'TSLA', 'AMD', 'AAPL',
    'INTC', 'PLTR', 'SOFI', 'HOOD', 'AMZN', 'META', 'GOOGL', 'MSFT', 'BAC', 'F',
    'SNAP', 'NIO', 'RIVN', 'XOM', 'WFC', 'PFE', 'T', 'VZ', 'UBER', 'COIN',
];

const UNIVERSE_PRESETS = [
    { key: 'high-market-cap', label: 'High Market Cap', tickers: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'AMZN', 'META', 'AVGO', 'TSLA', 'LLY', 'JPM', 'V', 'MA', 'XOM', 'WMT', 'UNH', 'COST', 'NFLX', 'ORCL', 'JNJ'] },
    { key: 'market-etfs', label: 'Market ETFs', tickers: ['SPY', 'QQQ', 'IWM', 'DIA', 'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'XLK', 'SMH', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLC', 'XLP', 'XLRE', 'XLU'] },
    { key: 'semis', label: 'Semis', tickers: ['NVDA', 'AMD', 'AVGO', 'INTC', 'QCOM', 'MU', 'ARM', 'SMCI', 'TSM', 'ASML', 'MRVL', 'AMAT', 'LRCX', 'KLAC', 'TXN', 'ADI', 'ON', 'MCHP'] },
    { key: 'software-ai', label: 'Software / AI', tickers: ['MSFT', 'ORCL', 'CRM', 'ADBE', 'PLTR', 'SNOW', 'MDB', 'NOW', 'DDOG', 'NET', 'CRWD', 'PANW', 'ZS', 'SHOP', 'UBER'] },
    { key: 'financials', label: 'Financials', tickers: ['JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BLK', 'SCHW', 'SOFI', 'HOOD', 'COIN', 'V', 'MA', 'AXP', 'PYPL'] },
    { key: 'healthcare', label: 'Healthcare', tickers: ['LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'PFE', 'TMO', 'AMGN', 'GILD', 'BMY', 'CVS', 'ISRG', 'REGN', 'VRTX', 'ABT'] },
    { key: 'energy', label: 'Energy', tickers: ['XOM', 'CVX', 'COP', 'SLB', 'OXY', 'EOG', 'MPC', 'PSX', 'VLO', 'HAL', 'DVN', 'FANG', 'KMI', 'WMB'] },
    { key: 'consumer', label: 'Consumer', tickers: ['AMZN', 'TSLA', 'WMT', 'COST', 'TGT', 'HD', 'LOW', 'MCD', 'SBUX', 'NKE', 'LULU', 'DIS', 'NFLX', 'PG', 'KO', 'PEP'] },
    { key: 'industrials', label: 'Industrials', tickers: ['GE', 'BA', 'CAT', 'HON', 'RTX', 'LMT', 'MMM', 'UPS', 'FDX', 'DE', 'ETN', 'EMR', 'PH', 'ITW'] },
];

const cachedMovements = new Map();
const cachedMoverNews = new Map();
const cachedTradingSignals = new Map();
const cachedPeerLookups = new Map();

const chunkArray = (items, size) => {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
};

const parseTickers = (value) => [...new Set(String(value || '')
    .split(/[\s,]+/)
    .map(t => t.trim().replace(/^\$/, '').toUpperCase())
    .filter(Boolean))]
    .slice(0, 120);

const isPrimarySignalTicker = (ticker) => /^[A-Z][A-Z0-9-]{0,5}$/.test(String(ticker || '').toUpperCase());

const getCurrentSignalToken = (value) => {
    const parts = String(value || '').split(/[\s,]+/);
    return (parts[parts.length - 1] || '').replace(/^\$/, '').toUpperCase();
};

const replaceCurrentSignalToken = (value, ticker) => {
    const raw = String(value || '');
    const match = raw.match(/^(.*?)([^,\s]*)$/);
    const prefix = match?.[1] || '';
    const separator = prefix && !/[\s,]$/.test(prefix) ? ', ' : '';
    return `${prefix}${separator}${ticker}`;
};

const formatLarge = (value) => {
    if (value == null || Number.isNaN(Number(value))) return '-';
    const abs = Math.abs(Number(value));
    if (abs >= 1e12) return `${(Number(value) / 1e12).toFixed(1)}T`;
    if (abs >= 1e9) return `${(Number(value) / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${(Number(value) / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(Number(value) / 1e3).toFixed(1)}K`;
    return Number(value).toLocaleString();
};

const formatDate = (value) => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const formatSessionLabel = (session) => ({
    after_hours: 'after-hours start',
    premarket: 'premarket start',
    extended_day: '4:00am ET extended-day start',
    overnight: 'prior after-hours start',
}[session] || '');

const subTabStyle = (active) => ({
    border: '1px solid var(--border)',
    background: active ? 'var(--brand-blue)' : 'var(--bg-accent)',
    color: active ? 'white' : 'var(--text-secondary)',
    borderRadius: 8,
    padding: '0.45rem 0.75rem',
    fontSize: '0.8rem',
    fontWeight: 700,
    cursor: 'pointer',
});

const SignalMeter = ({ label, value, max = 5, suffix = '', color = 'var(--brand-blue)', help = '' }) => {
    const numeric = Number(value);
    const pct = Number.isFinite(numeric) ? Math.min(100, Math.abs(numeric) / max * 100) : 0;
    return (
        <div style={{ fontSize: '0.72rem' }} title={help}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-muted)', cursor: help ? 'help' : 'default' }}>{label}</span>
                <strong>{Number.isFinite(numeric) ? `${numeric}${suffix}` : '-'}</strong>
            </div>
            <div style={{ height: 6, background: 'var(--bg-accent)', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 999 }} />
            </div>
        </div>
    );
};

const MetricCell = ({ label, value, help }) => (
    <div title={help}>
        <span style={{ cursor: help ? 'help' : 'default' }}>{label}</span> <strong>{value}</strong>
    </div>
);

const MoverStockDetail = ({ ticker, mover, onClose, onExplain }) => {
    const [info, setInfo] = useState(null);
    const [technicals, setTechnicals] = useState(null);
    const [news, setNews] = useState([]);
    const [earnings, setEarnings] = useState(null);
    const [recommendations, setRecommendations] = useState(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!ticker) return;
        setLoading(true);
        Promise.all([
            axios.get(`${INTELLIGENCE_SERVICE}/info/${ticker}`).then(r => r.data).catch(() => null),
            axios.get(`${INTELLIGENCE_SERVICE}/technicals/${ticker}`).then(r => r.data).catch(() => null),
            axios.get(`${INTELLIGENCE_SERVICE}/news/${ticker}?limit=6`).then(r => r.data.news || []).catch(() => []),
            axios.get(`${INTELLIGENCE_SERVICE}/earnings/${ticker}`).then(r => r.data).catch(() => null),
            axios.get(`${INTELLIGENCE_SERVICE}/recommendations/${ticker}`).then(r => r.data).catch(() => null),
        ]).then(([infoData, technicalData, newsData, earningsData, recommendationData]) => {
            setInfo(infoData);
            setTechnicals(technicalData);
            setNews(newsData);
            setEarnings(earningsData);
            setRecommendations(recommendationData);
        }).finally(() => setLoading(false));
    }, [ticker]);

    if (!ticker) return null;

    const change = mover?.change_percent ?? info?.change_percent;
    const explain = () => {
        const headlines = news.slice(0, 3).map(item => item.title).filter(Boolean).join('; ');
        const prompt = `Analyze ${ticker} from the Market Movers detail panel. Name: ${info?.name || mover?.name || ticker}. Sector: ${info?.sector || mover?.sector || 'unknown'}, industry: ${info?.industry || mover?.industry || 'unknown'}. Move: ${change != null ? `${change}%` : 'unknown'}, price: ${mover?.price ?? info?.current_price ?? '-'}, volume: ${mover?.volume ?? '-'}, market cap: ${mover?.market_cap ?? info?.market_cap ?? '-'}. Technicals: RSI ${technicals?.rsi_14 ?? '-'}, SMA20 ${technicals?.sma_20 ?? '-'}, SMA50 ${technicals?.sma_50 ?? '-'}, trend ${technicals?.trend || '-'}. Recent headlines: ${headlines || 'none loaded'}. Explain whether this looks stock-specific or industry-wide, key catalysts/risks, and what to watch next.`;
        onExplain?.(prompt, `Explaining ${ticker}`);
    };

    const statCards = [
        { label: 'Move', value: change != null ? `${change >= 0 ? '+' : ''}${Number(change).toFixed(2)}%` : '-', color: change >= 0 ? 'var(--brand-green)' : 'var(--brand-red)' },
        { label: 'Price', value: mover?.price != null ? `$${Number(mover.price).toFixed(2)}` : info?.current_price != null ? `$${Number(info.current_price).toFixed(2)}` : '-' },
        { label: 'Volume', value: formatLarge(mover?.volume) },
        { label: 'Market cap', value: formatLarge(mover?.market_cap ?? info?.market_cap) },
        { label: 'RSI', value: technicals?.rsi_14 != null ? Number(technicals.rsi_14).toFixed(1) : '-' },
        { label: 'Trend', value: technicals?.trend || '-' },
    ];

    return (
        <div className="terminal-card" style={{ marginTop: 0, padding: 0, border: '1px solid var(--border-subtle)', overflow: 'hidden', flexShrink: 0 }}>
            <div style={{ padding: '0.8rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
                <button className="btn btn-xs btn-ghost" onClick={onClose} title="Close detail" style={{ padding: '0.2rem 0.35rem' }}>
                    <X size={14} />
                </button>
                <strong style={{ fontSize: '1rem' }}>{ticker}</strong>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {info?.name || mover?.name || 'Loading stock detail'}{info?.sector || mover?.sector ? ` · ${info?.sector || mover?.sector}` : ''}{info?.industry || mover?.industry ? ` · ${info?.industry || mover?.industry}` : ''}
                </span>
                {loading && <Loader2 size={14} className="animate-spin" style={{ marginLeft: 'auto' }} />}
                <button className="btn btn-xs btn-ghost" onClick={explain} style={{ marginLeft: loading ? 0 : 'auto' }}>
                    <MessageCircleQuestion size={13} /> Explain
                </button>
            </div>
            <div style={{ padding: '0.9rem 1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.65rem' }}>
                {statCards.map(card => (
                    <div key={card.label} className="panel" style={{ margin: 0, padding: '0.65rem 0.75rem' }}>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{card.label}</div>
                        <div style={{ fontSize: '0.92rem', fontWeight: 800, color: card.color || 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.value}</div>
                    </div>
                ))}
            </div>
            <div style={{ padding: '0 1rem 1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.8rem' }}>
                <div className="panel" style={{ margin: 0, padding: '0.8rem' }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: 800, marginBottom: '0.55rem' }}>Recent News</div>
                    {news.length > 0 ? (
                        <div style={{ display: 'grid', gap: '0.55rem' }}>
                            {news.slice(0, 4).map((item, index) => (
                                <a key={`${item.title}-${index}`} href={item.link || '#'} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                                    <div style={{ fontSize: '0.78rem', fontWeight: 700, lineHeight: 1.35 }}>{item.title || 'Untitled headline'}</div>
                                    <div style={{ marginTop: '0.2rem', fontSize: '0.68rem', color: 'var(--text-muted)' }}>{item.publisher || 'Unknown'} {formatDate(item.published) ? `· ${formatDate(item.published)}` : ''}</div>
                                </a>
                            ))}
                        </div>
                    ) : (
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{loading ? 'Loading headlines...' : 'No recent headlines found.'}</div>
                    )}
                </div>
                <div className="panel" style={{ margin: 0, padding: '0.8rem' }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: 800, marginBottom: '0.55rem' }}>Context</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem', fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                        <MetricCell label="SMA20" value={technicals?.sma_20 != null ? Number(technicals.sma_20).toFixed(2) : '-'} />
                        <MetricCell label="SMA50" value={technicals?.sma_50 != null ? Number(technicals.sma_50).toFixed(2) : '-'} />
                        <MetricCell label="Prev close" value={info?.previous_close != null ? `$${Number(info.previous_close).toFixed(2)}` : '-'} />
                        <MetricCell label="Forward PE" value={info?.forward_pe ?? '-'} />
                        <MetricCell label="Earnings" value={earnings?.earnings_date || earnings?.next_earnings_date || '-'} />
                        <MetricCell label="Rating" value={recommendations?.recommendation || recommendations?.mean_recommendation || '-'} />
                    </div>
                </div>
            </div>
        </div>
    );
};

const SIGNAL_BADGE_HELP = {
    'Confirmed momentum': 'Move score is at least 1.8 and volume is at least 1.2x its recent average.',
    'Abnormal move': 'Move score is at least 1.8, but volume does not confirm the move at 1.2x or higher.',
    'Strong close': 'Price moved up and closed in the top 25% of the latest candle range.',
    'Weak close': 'Price moved down and closed in the bottom 25% of the latest candle range.',
    'Normal movement': 'None of the abnormal-move, momentum, strong-close, or weak-close conditions occurred.',
    'No signal': 'There is not enough usable price data to calculate a signal.',
};

const IndustryMovements = ({ notify, onExplain, onOpenChart }) => {
    const [activeTab, setActiveTab] = useState('movers');
    const [period, setPeriod] = useState('1d');
    const [extended, setExtended] = useState(false);
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadingStage, setLoadingStage] = useState('');
    const [universeVersion, setUniverseVersion] = useState(0);
    const [loadedCount, setLoadedCount] = useState(0);
    const [search, setSearch] = useState('');
    const [tickerUniverseInput, setTickerUniverseInput] = useState(() => {
        try { return localStorage.getItem('movement_ticker_universe') || MAJOR_STOCKS.join(', '); }
        catch { return MAJOR_STOCKS.join(', '); }
    });
    const [tickerUniverse, setTickerUniverse] = useState(() => {
        try { return localStorage.getItem('movement_ticker_universe') || MAJOR_STOCKS.join(', '); }
        catch { return MAJOR_STOCKS.join(', '); }
    });
    const [activeUniverseLabel, setActiveUniverseLabel] = useState(() => {
        try { return localStorage.getItem('movement_universe_label') || 'Default universe'; }
        catch { return 'Default universe'; }
    });
    const [showUniverseEditor, setShowUniverseEditor] = useState(false);
    const [universeLoading, setUniverseLoading] = useState(false);
    const [presetLoading, setPresetLoading] = useState('');
    const [universeHistory, setUniverseHistory] = useState(() => {
        try { return JSON.parse(localStorage.getItem('movement_universe_history') || '[]'); }
        catch { return []; }
    });
    const [activeIndustry, setActiveIndustry] = useState('All');
    const [rankMetric, setRankMetric] = useState('change_percent');
    const [gainerSortBy, setGainerSortBy] = useState('change_percent');
    const [gainerSortAsc, setGainerSortAsc] = useState(false);
    const [loserSortBy, setLoserSortBy] = useState('change_percent');
    const [loserSortAsc, setLoserSortAsc] = useState(true);
    const [selectedMover, setSelectedMover] = useState(null);
    const [newsItems, setNewsItems] = useState([]);
    const [newsLoading, setNewsLoading] = useState(false);
    const [newsLoadedCount, setNewsLoadedCount] = useState(0);
    const [newsStatus, setNewsStatus] = useState('');
    const [newsMoverLimit, setNewsMoverLimit] = useState(NEWS_MOVER_PAGE_SIZE);
    const [newsPerTicker, setNewsPerTicker] = useState(1);
    const [newsSearchInput, setNewsSearchInput] = useState('');
    const [newsSearchTicker, setNewsSearchTicker] = useState('');
    const [newsRefreshToken, setNewsRefreshToken] = useState(0);
    const [newsVisibleCount, setNewsVisibleCount] = useState(12);
    const [showAllIndustries, setShowAllIndustries] = useState(false);
    const [signalStats, setSignalStats] = useState([]);
    const [signalLoading, setSignalLoading] = useState(false);
    const [signalInput, setSignalInput] = useState('');
    const [signalSuggestions, setSignalSuggestions] = useState([]);
    const [signalSuggestLoading, setSignalSuggestLoading] = useState(false);
    const [selectedSignalTickers, setSelectedSignalTickers] = useState([]);
    const [signalPrimaryTicker, setSignalPrimaryTicker] = useState('');
    const [signalPeriod, setSignalPeriod] = useState('3mo');
    const [signalInterval, setSignalInterval] = useState('1d');
    const [signalIncludePeers, setSignalIncludePeers] = useState(true);
    const [signalPeers, setSignalPeers] = useState([]);
    const [signalPeerSource, setSignalPeerSource] = useState('');
    const [savedSignals, setSavedSignals] = useState(() => {
        try { return JSON.parse(localStorage.getItem('movement_saved_signals') || '[]'); }
        catch { return []; }
    });
    const [signalWatches, setSignalWatches] = useState([]);
    const [signalEvents, setSignalEvents] = useState([]);
    const [unreadSignalEvents, setUnreadSignalEvents] = useState(0);
    const [watchForm, setWatchForm] = useState({ direction: 'either', threshold_percent: 2, window: '15m', require_volume: false, volume_multiplier: 1.2 });
    const [watchSaving, setWatchSaving] = useState(false);
    const requestIdRef = useRef(0);
    const notifyRef = useRef(notify);
    const newsRequestKeyRef = useRef('');

    useEffect(() => {
        notifyRef.current = notify;
    }, [notify]);

    const loadSignalWatches = useCallback(async () => {
        try {
            const [watchResponse, eventResponse] = await Promise.all([
                axios.get(`${INTELLIGENCE_SERVICE}/signal-watches`),
                axios.get(`${INTELLIGENCE_SERVICE}/signal-events?limit=30`),
            ]);
            setSignalWatches(watchResponse.data.watches || []);
            setSignalEvents(eventResponse.data.events || []);
            setUnreadSignalEvents(eventResponse.data.unread_count || 0);
        } catch (error) { console.warn('Failed to load signal watches', error); }
    }, []);

    useEffect(() => {
        loadSignalWatches();
        const timer = setInterval(loadSignalWatches, 30000);
        return () => clearInterval(timer);
    }, [loadSignalWatches]);

    const activeTickers = useMemo(() => {
        const parsed = parseTickers(tickerUniverse);
        return parsed.length ? parsed : MAJOR_STOCKS;
    }, [tickerUniverse]);

    const currentWindow = MOVEMENT_WINDOWS[period] || MOVEMENT_WINDOWS['1d'];

    const rememberUniverse = (label, tickers) => {
        const parsed = parseTickers(Array.isArray(tickers) ? tickers.join(', ') : tickers);
        if (!parsed.length) return;
        const item = { id: Date.now(), label, tickers: parsed, savedAt: new Date().toISOString() };
        setUniverseHistory(prev => {
            const signature = parsed.join(',');
            const next = [item, ...prev.filter(old => (old.tickers || []).join(',') !== signature)].slice(0, 8);
            localStorage.setItem('movement_universe_history', JSON.stringify(next));
            return next;
        });
    };

    const applyUniverseList = (tickers, label = 'Ticker universe', options = {}) => {
        const parsed = parseTickers(Array.isArray(tickers) ? tickers.join(', ') : tickers);
        if (parsed.length === 0) return notifyRef.current?.('Add at least one ticker', 'yellow');
        const next = parsed.join(', ');
        setTickerUniverseInput(next);
        setTickerUniverse(next);
        setActiveUniverseLabel(label);
        setUniverseVersion(v => v + 1);
        setLoading(true);
        setLoadingStage(`Applied ${label}; updating movers`);
        setLoadedCount(0);
        setShowUniverseEditor(false);
        localStorage.setItem('movement_ticker_universe', next);
        localStorage.setItem('movement_universe_label', label);
        cachedMovements.clear();
        cachedTradingSignals.clear();
        setActiveIndustry('All');
        setSearch('');
        setSignalStats([]);
        setSelectedSignalTickers([]);
        setSignalInput('');
        setSignalPrimaryTicker('');
        setSignalPeers([]);
        if (options.remember !== false) rememberUniverse(label, parsed);
        notifyRef.current?.(`${label} loaded (${parsed.length} tickers)`, 'green');
    };

    const applyTickerUniverse = () => {
        applyUniverseList(tickerUniverseInput, 'Ticker universe');
    };

    const resetTickerUniverse = () => {
        applyUniverseList(MAJOR_STOCKS, 'Default universe');
    };

    const loadHighVolumeUniverse = async () => {
        setUniverseLoading(true);
        try {
            const res = await axios.get(`${INTELLIGENCE_SERVICE}/high-volume-universe?limit=50`, { timeout: 30000 });
            const tickers = parseTickers((res.data.tickers || []).join(', '));
            if (!tickers.length) {
                applyUniverseList(FALLBACK_HIGH_VOLUME, 'Fallback high-volume universe');
                return;
            }
            applyUniverseList(tickers, 'High-volume universe');
        } catch {
            applyUniverseList(FALLBACK_HIGH_VOLUME, 'Fallback high-volume universe');
            notifyRef.current?.('Live high-volume query timed out, loaded fallback liquid tickers', 'yellow');
        } finally {
            setUniverseLoading(false);
        }
    };

    const loadUniversePreset = async (preset) => {
        setPresetLoading(preset.key);
        try {
            const res = await axios.get(`${INTELLIGENCE_SERVICE}/universe-preset/${preset.key}?limit=50`, { timeout: 16000 });
            const tickers = parseTickers((res.data.tickers || []).join(', '));
            if (!tickers.length) {
                applyUniverseList(preset.tickers, `${preset.label} fallback`);
                return;
            }
            applyUniverseList(tickers, `${res.data.label || preset.label}${res.data.dynamic ? ' latest' : ''}`);
            if (!res.data.dynamic) {
                notifyRef.current?.(`${preset.label} used fallback list because live screener was unavailable`, 'yellow');
            }
        } catch {
            applyUniverseList(preset.tickers, `${preset.label} fallback`);
            notifyRef.current?.(`${preset.label} latest screener failed, loaded fallback`, 'yellow');
        } finally {
            setPresetLoading('');
        }
    };

    const quoteToEntry = (quote, fallbackTicker) => {
        const ticker = (quote.symbol || fallbackTicker || '').toUpperCase();
        const [sector, industry] = STOCK_META[ticker] || ['Other', 'Other'];
        if (!ticker || quote.error) return null;
        return {
            sector,
            industry,
            ticker,
            name: quote.name || ticker,
            price: quote.price,
            change: quote.change,
            change_percent: quote.change_percent,
            volume: quote.volume,
            market_cap: quote.market_cap,
            avg_daily_move_pct: quote.avg_daily_move_pct,
            move_strength: quote.move_strength,
            avg_volume: quote.avg_volume,
            session: quote.session,
        };
    };

    const fetchData = useCallback(async (options = {}) => {
        const externalController = options?.controller;
        const forceRefresh = Boolean(options?.force);
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        setLoading(true);
        setLoadingStage('Checking cached movers');
        setLoadedCount(0);
        setNewsItems([]);
        newsRequestKeyRef.current = '';

        const quoteFastPath = Boolean(currentWindow.quoteFastPath);
        const params = `period=${currentWindow.period}${currentWindow.interval ? `&interval=${currentWindow.interval}` : ''}${!quoteFastPath && extended ? '&extended=true' : ''}`;
        const universeKey = activeTickers.join(',');
        const cacheKey = `movements:${params}${quoteFastPath ? ':quote-snapshot' : ''}:${universeKey}:v${universeVersion}:v3`;
        const cachedPayload = cachedMovements.get(cacheKey);
        if (!forceRefresh && cachedPayload && Date.now() - cachedPayload.savedAt < MOVEMENT_CACHE_TTL_MS) {
            setEntries(cachedPayload.items);
            setLoadedCount(activeTickers.length);
            setLoading(false);
            setLoadingStage('Loaded from cache');
            return;
        }

        const controller = externalController || new AbortController();
        const merged = new Map();
        let completedTickers = 0;
        let failedChunks = 0;
        const chunks = chunkArray(activeTickers, MOVEMENT_CHUNK_SIZE);
        try {
            setLoadingStage(currentWindow.interval ? `Fetching ${currentWindow.label} candles from yfinance` : 'Fetching latest prices from yfinance');
            let cursor = 0;
            const loadNextChunk = async () => {
                while (cursor < chunks.length && !controller.signal.aborted) {
                    const chunk = chunks[cursor];
                    cursor += 1;
                    if (requestIdRef.current !== requestId) return;
                    setLoadingStage(`${currentWindow.interval ? `Fetching ${currentWindow.label} candles` : 'Fetching latest prices'} · ${completedTickers}/${activeTickers.length}`);
                    try {
                        const res = await axios.post(`${INTELLIGENCE_SERVICE}/batch-price-changes?${params}`, chunk, {
                            signal: controller.signal,
                            timeout: 15000,
                        });
                        if (requestIdRef.current !== requestId || controller.signal.aborted) return;
                        const items = (res.data.quotes || [])
                            .map((q, index) => quoteToEntry(q, chunk[index]))
                            .filter(item => item && item.change_percent != null);
                        for (const item of items) {
                            if (item.ticker) merged.set(item.ticker.toUpperCase(), item);
                        }
                        const partialEntries = Array.from(merged.values()).sort((a, b) => (b.change_percent ?? -Infinity) - (a.change_percent ?? -Infinity));
                        setEntries(partialEntries);
                    } catch (e) {
                        if (!axios.isCancel(e)) failedChunks += 1;
                    } finally {
                        completedTickers += chunk.length;
                        if (requestIdRef.current === requestId && !controller.signal.aborted) {
                            setLoadedCount(Math.min(completedTickers, activeTickers.length));
                            setLoadingStage(`${currentWindow.interval ? `Fetching ${currentWindow.label} candles` : 'Fetching latest prices'} · ${Math.min(completedTickers, activeTickers.length)}/${activeTickers.length}`);
                        }
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(MOVEMENT_CHUNK_CONCURRENCY, chunks.length) }, loadNextChunk));
            if (requestIdRef.current !== requestId || controller.signal.aborted) return;
            const finalEntries = Array.from(merged.values()).sort((a, b) => (b.change_percent ?? -Infinity) - (a.change_percent ?? -Infinity));
            cachedMovements.set(cacheKey, { items: finalEntries, savedAt: Date.now() });
            setEntries(finalEntries);
            setLoadedCount(activeTickers.length);
            if (finalEntries.length === 0 && failedChunks > 0) {
                notifyRef.current?.('Movement price fetch timed out before any usable quotes loaded. Try fewer tickers or refresh.', 'yellow');
            } else if (finalEntries.length === 0) {
                notifyRef.current?.('Movement prices returned no usable changes yet. Try another interval or refresh.', 'yellow');
            }
        } catch (e) {
            if (!axios.isCancel(e)) {
                notifyRef.current?.('Movement price fetch failed or timed out', 'yellow');
            }
        } finally {
            if (requestIdRef.current === requestId) {
                if (merged.size === 0 && !controller.signal.aborted) {
                    setLoadedCount(activeTickers.length);
                }
                setLoading(false);
                setLoadingStage('');
            }
        }
    }, [currentWindow, extended, activeTickers, universeVersion]);

    useEffect(() => {
        const controller = new AbortController();
        fetchData({ controller });
        return () => controller.abort();
    }, [fetchData]);

    const sorter = (key, asc) => (a, b) => {
        const av = a[key], bv = b[key];
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'string') return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        return asc ? av - bv : bv - av;
    };

    const handleSort = (panel, key) => () => {
        if (panel === 'gainers') {
            if (gainerSortBy === key) setGainerSortAsc(a => !a);
            else { setGainerSortBy(key); setGainerSortAsc(key === 'ticker' || key === 'name' || key === 'industry'); }
        } else if (loserSortBy === key) {
            setLoserSortAsc(a => !a);
        } else {
            setLoserSortBy(key);
            setLoserSortAsc(key !== 'change_percent');
        }
    };

    const sortArrow = (panel, key) => {
        const active = panel === 'gainers' ? gainerSortBy : loserSortBy;
        const asc = panel === 'gainers' ? gainerSortAsc : loserSortAsc;
        if (active !== key) return null;
        return <span style={{ marginLeft: '0.25rem', opacity: 0.7 }}>{asc ? '▲' : '▼'}</span>;
    };

    const industries = useMemo(() => {
        const map = new Map();
        for (const entry of entries) {
            const key = entry.industry || entry.sector || 'Other';
            const current = map.get(key) || { name: key, count: 0, marketCap: 0, volume: 0 };
            current.count += 1;
            current.marketCap += Number(entry.market_cap) || 0;
            current.volume += Number(entry.volume) || 0;
            map.set(key, current);
        }
        return Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }, [entries]);

    const visibleIndustries = showAllIndustries ? industries : industries.slice(0, 12);
    const industryTitle = (industry) => {
        const parts = [`${formatLarge(industry.volume)} volume`];
        if (industry.marketCap > 0) parts.push(`${formatLarge(industry.marketCap)} cap`);
        return parts.join(', ');
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return entries.filter(e => {
            const matchesIndustry = activeIndustry === 'All' || e.industry === activeIndustry || e.sector === activeIndustry;
            const matchesSearch = !q ||
                e.ticker?.toLowerCase().includes(q) ||
                e.name?.toLowerCase().includes(q) ||
                e.sector?.toLowerCase().includes(q) ||
                e.industry?.toLowerCase().includes(q);
            return matchesIndustry && matchesSearch;
        });
    }, [entries, search, activeIndustry]);

    const metricLeaders = useMemo(() => {
        const direction = rankMetric === 'change_percent' ? -1 : -1;
        return [...filtered]
            .filter(e => e[rankMetric] != null && Number.isFinite(Number(e[rankMetric])))
            .sort((a, b) => direction * ((Number(a[rankMetric]) || 0) - (Number(b[rankMetric]) || 0)))
            .slice(0, 6);
    }, [filtered, rankMetric]);

    const gainers = useMemo(() => filtered.filter(e => e.change_percent != null && Number(e.change_percent) >= 0).sort(sorter(gainerSortBy, gainerSortAsc)), [filtered, gainerSortBy, gainerSortAsc]);
    const losers = useMemo(() => filtered.filter(e => e.change_percent != null && Number(e.change_percent) < 0).sort(sorter(loserSortBy, loserSortAsc)), [filtered, loserSortBy, loserSortAsc]);

    const coreMovers = useMemo(() => {
        const byChange = [...entries].filter(e => e.change_percent != null);
        const highest = [...byChange].sort((a, b) => b.change_percent - a.change_percent).slice(0, 3);
        const lowest = [...byChange].sort((a, b) => a.change_percent - b.change_percent).slice(0, 3);
        return [
            ...highest.map(e => ({ ...e, direction: 'highest' })),
            ...lowest.map(e => ({ ...e, direction: 'lowest' })),
        ];
    }, [entries]);

    const newsMovers = useMemo(() => {
        const searchTicker = newsSearchTicker.trim().toUpperCase();
        if (searchTicker) {
            const match = entries.find(e => e.ticker === searchTicker);
            return [{
                ...(match || { ticker: searchTicker, name: searchTicker, change_percent: null }),
                direction: match?.change_percent >= 0 ? 'highest' : match?.change_percent < 0 ? 'lowest' : 'search',
            }];
        }
        const byChange = [...entries].filter(e => e.change_percent != null);
        const perSide = Math.max(1, Math.ceil(newsMoverLimit / 2));
        const highest = [...byChange].sort((a, b) => b.change_percent - a.change_percent).slice(0, perSide);
        const lowest = [...byChange].sort((a, b) => a.change_percent - b.change_percent).slice(0, perSide);
        return [
            ...highest.map(e => ({ ...e, direction: 'highest' })),
            ...lowest.map(e => ({ ...e, direction: 'lowest' })),
        ].slice(0, newsMoverLimit);
    }, [entries, newsMoverLimit, newsSearchTicker]);

    const maxNewsMoverCount = useMemo(() => (
        newsSearchTicker ? 1 : entries.filter(e => e.change_percent != null).length
    ), [entries, newsSearchTicker]);

    const suggestedSignalTickers = useMemo(() => {
        const source = activeIndustry !== 'All' ? filtered : coreMovers;
        return [...new Set(source.map(e => e.ticker).filter(Boolean))].slice(0, 8);
    }, [activeIndustry, filtered, coreMovers]);

    useEffect(() => {
        localStorage.setItem('movement_saved_signals', JSON.stringify(savedSignals.slice(0, 30)));
    }, [savedSignals]);

    useEffect(() => {
        if (activeTab !== 'signal') {
            setSignalSuggestions([]);
            setSignalSuggestLoading(false);
            return;
        }
        const query = getCurrentSignalToken(signalInput);
        if (query.length < 1) {
            setSignalSuggestions([]);
            setSignalSuggestLoading(false);
            return;
        }

        const controller = new AbortController();
        const timer = setTimeout(async () => {
            setSignalSuggestLoading(true);
            try {
                const res = await axios.get(`${INTELLIGENCE_SERVICE}/search`, {
                    params: { q: query },
                    signal: controller.signal,
                    timeout: 6000,
                });
                const seen = new Set(parseTickers(signalInput).filter(t => t !== query));
                const results = (res.data?.results || [])
                    .map(item => ({
                        symbol: String(item.symbol || '').toUpperCase(),
                        name: item.name || '',
                        type: item.type || '',
                    }))
                    .filter(item => item.symbol && isPrimarySignalTicker(item.symbol) && !seen.has(item.symbol))
                    .sort((a, b) => {
                        const ax = a.symbol === query ? 0 : a.symbol.startsWith(query) ? 1 : 2;
                        const bx = b.symbol === query ? 0 : b.symbol.startsWith(query) ? 1 : 2;
                        return ax - bx || a.symbol.localeCompare(b.symbol);
                    })
                    .slice(0, 6);
                setSignalSuggestions(results);
            } catch {
                if (!controller.signal.aborted) setSignalSuggestions([]);
            } finally {
                if (!controller.signal.aborted) setSignalSuggestLoading(false);
            }
        }, 220);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [activeTab, signalInput]);

    const getPeerTickers = useCallback((ticker) => {
        const symbol = String(ticker || '').toUpperCase();
        const entry = entries.find(e => e.ticker === symbol);
        if (!entry) return [];
        const industry = entry.industry || entry.sector;
        return entries
            .filter(e => e.ticker !== symbol && (e.industry === industry || e.sector === industry))
            .sort((a, b) => (b.volume || 0) - (a.volume || 0))
            .map(e => e.ticker)
            .slice(0, 5);
    }, [entries]);

    const resolvePeerTickers = useCallback(async (ticker) => {
        const symbol = String(ticker || '').toUpperCase();
        if (!symbol) return { peers: [], source: 'none' };
        if (cachedPeerLookups.has(symbol)) return cachedPeerLookups.get(symbol);
        try {
            const res = await axios.get(`${INTELLIGENCE_SERVICE}/peers/${symbol}?limit=5`, { timeout: 10000 });
            const peers = parseTickers((res.data?.peers || []).join(', '))
                .filter(t => t !== symbol && isPrimarySignalTicker(t))
                .slice(0, 5);
            const payload = {
                peers,
                source: res.data?.source || 'peer resolver',
                sector: res.data?.sector,
                industry: res.data?.industry,
            };
            cachedPeerLookups.set(symbol, payload);
            return payload;
        } catch {
            const peers = getPeerTickers(symbol);
            return { peers, source: peers.length ? 'local same-industry fallback' : 'peer lookup unavailable' };
        }
    }, [getPeerTickers]);

    const loadSignalStats = useCallback(async (tickers, options = {}) => {
        const rawTargets = parseTickers(Array.isArray(tickers) ? tickers.join(', ') : tickers)
            .filter(isPrimarySignalTicker)
            .slice(0, 8);
        const primary = rawTargets[0] || '';
        if (!rawTargets.length) {
            notifyRef.current?.('Choose or type at least one ticker for signal scan', 'yellow');
            return;
        }
        setSignalLoading(true);
        setSignalStats([]);
        setSignalPrimaryTicker(primary);
        setSignalPeers([]);
        setSignalPeerSource(signalIncludePeers && rawTargets.length === 1 ? 'resolving peers...' : '');
        const peerResult = signalIncludePeers && rawTargets.length === 1
            ? await resolvePeerTickers(primary)
            : { peers: [], source: signalIncludePeers ? 'disabled for multi-ticker scan' : 'disabled' };
        const peers = peerResult.peers || [];
        const targets = [...new Set([...rawTargets, ...peers])].slice(0, 8);
        const requestedInterval = options.interval || signalInterval;
        let requestedPeriod = normalizeSignalPeriod(options.period || signalPeriod, requestedInterval);
        const originalPeriod = options.period || signalPeriod;
        if (requestedPeriod !== originalPeriod) {
            const intervalLabel = getSignalIntervalOption(requestedInterval).label;
            notifyRef.current?.(`${intervalLabel} uses ${requestedPeriod.toUpperCase()} history for yfinance compatibility`, 'yellow');
        }
        const key = `${requestedPeriod}:${requestedInterval}:${targets.join(',')}`;
        setSignalPrimaryTicker(primary);
        setSignalPeers(peers);
        setSignalPeerSource(peerResult.source || '');
        setSelectedSignalTickers(targets);
        setSignalInput(targets.join(', '));
        if (cachedTradingSignals.has(key)) {
            setSignalStats(cachedTradingSignals.get(key));
            setSignalLoading(false);
            return;
        }
        const controller = new AbortController();
        axios.post(`${INTELLIGENCE_SERVICE}/trading-signal`, {
            tickers: targets,
            period: requestedPeriod,
            interval: requestedInterval,
        }, { signal: controller.signal, timeout: 16000 }).then(res => {
            const stats = res.data.signals || [];
            cachedTradingSignals.set(key, stats);
            setSignalStats(stats);
        }).catch(e => {
            if (!axios.isCancel(e)) notifyRef.current?.('Trading signal stats failed to load', 'yellow');
        }).finally(() => {
            if (!controller.signal.aborted) setSignalLoading(false);
        });
    }, [signalPeriod, signalInterval, signalIncludePeers, resolvePeerTickers]);

    useEffect(() => {
        if (activeTab !== 'news' || newsMovers.length === 0) {
            setNewsLoading(false);
            setNewsLoadedCount(0);
            return;
        }
        const key = [
            `per=${newsPerTicker}`,
            `search=${newsSearchTicker || '-'}`,
            `refresh=${newsRefreshToken}`,
            newsMovers.map(m => `${m.ticker}:${m.change_percent}`).join('|'),
        ].join('::');
        if (key === newsRequestKeyRef.current) return;
        if (cachedMoverNews.has(key)) {
            const cached = cachedMoverNews.get(key);
            setNewsItems(cached);
            setNewsLoadedCount(newsMovers.length);
            setNewsLoading(false);
            setNewsStatus(`Loaded ${cached.length} cached headline${cached.length === 1 ? '' : 's'}`);
            newsRequestKeyRef.current = key;
            return;
        }

        const controller = new AbortController();
        setNewsLoading(true);
        setNewsLoadedCount(0);
        setNewsItems([]);
        setNewsStatus(`Starting headline scan for ${newsMovers.length} ticker${newsMovers.length === 1 ? '' : 's'}`);
        newsRequestKeyRef.current = key;
        const moverMap = new Map(newsMovers.map(m => [m.ticker, m]));
        const accumulated = [];
        let cursor = 0;
        let completed = 0;
        let finalized = false;
        const NEWS_CONCURRENCY = 4;

        console.info('[CoreHeadlines] start', { key, tickers: newsMovers.map(m => m.ticker), perTicker: newsPerTicker });

        const finalizeNews = (reason) => {
            if (finalized || controller.signal.aborted) return;
            finalized = true;
            console.info('[CoreHeadlines] finish', { reason, completed, total: newsMovers.length, items: accumulated.length });
            cachedMoverNews.set(key, accumulated);
            setNewsItems([...accumulated]);
            setNewsStatus(`Loaded ${accumulated.length} headline${accumulated.length === 1 ? '' : 's'} from ${completed}/${newsMovers.length} ticker${newsMovers.length === 1 ? '' : 's'}`);
            setNewsLoading(false);
        };

        const hardStop = setTimeout(() => {
            finalizeNews('timeout');
            controller.abort();
        }, 9000);

        const loadNextHeadline = async () => {
            while (cursor < newsMovers.length && !controller.signal.aborted) {
                const mover = newsMovers[cursor];
                cursor += 1;
                console.info('[CoreHeadlines] request', mover.ticker);
                setNewsStatus(`Checking ${mover.ticker} (${completed}/${newsMovers.length})`);
                try {
                    const res = await axios.post(`${INTELLIGENCE_SERVICE}/news-titles?limit=${newsPerTicker}`, [mover.ticker], {
                        signal: controller.signal,
                        timeout: 4500,
                    });
                    const items = (res.data.news || [])
                        .map(article => ({ ...article, mover: moverMap.get(article.ticker) }))
                        .filter(article => article.mover && article.title);
                    if (items.length) {
                        accumulated.push(...items);
                        if (!controller.signal.aborted) setNewsItems([...accumulated]);
                    }
                    console.info('[CoreHeadlines] response', { ticker: mover.ticker, items: items.length });
                } catch (e) {
                    if (!axios.isCancel(e)) console.warn('Core headline failed', mover.ticker, e);
                } finally {
                    completed += 1;
                    if (!controller.signal.aborted) {
                        setNewsLoadedCount(completed);
                        setNewsStatus(`Loaded ${accumulated.length} headline${accumulated.length === 1 ? '' : 's'} · ${completed}/${newsMovers.length} ticker${newsMovers.length === 1 ? '' : 's'} checked`);
                    }
                }
            }
        };

        Promise.all(Array.from({ length: Math.min(NEWS_CONCURRENCY, newsMovers.length) }, loadNextHeadline))
            .finally(() => {
                clearTimeout(hardStop);
                finalizeNews('complete');
            });

        return () => {
            clearTimeout(hardStop);
            controller.abort();
            console.info('[CoreHeadlines] abort', { key });
        };
    }, [activeTab, newsMovers, newsPerTicker, newsSearchTicker, newsRefreshToken]);

    const visibleNewsItems = newsItems.slice(0, newsVisibleCount);

    const submitNewsSearch = (event) => {
        event?.preventDefault();
        const nextTicker = parseTickers(newsSearchInput)[0] || '';
        setNewsSearchTicker(nextTicker);
        setNewsMoverLimit(NEWS_MOVER_PAGE_SIZE);
        setNewsVisibleCount(12);
    };

    const clearNewsSearch = () => {
        setNewsSearchInput('');
        setNewsSearchTicker('');
        setNewsMoverLimit(NEWS_MOVER_PAGE_SIZE);
        setNewsVisibleCount(12);
    };

    const loadMoreNews = () => {
        if (newsVisibleCount < newsItems.length) {
            setNewsVisibleCount(count => count + 12);
            return;
        }
        if (!newsSearchTicker && newsMoverLimit < maxNewsMoverCount) {
            setNewsMoverLimit(count => Math.min(count + NEWS_MOVER_PAGE_SIZE, maxNewsMoverCount));
            setNewsVisibleCount(count => count + 12);
        }
    };

    const renderRows = (rows, panel) => {
        if (rows.length === 0) {
            if (loading) {
                return (
                    <tr>
                        <td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2.25rem' }}>
                            <Loader2 size={18} className="animate-spin" style={{ verticalAlign: 'text-bottom', marginRight: '0.5rem' }} />
                            {loadingStage || 'Loading movement data'}
                        </td>
                    </tr>
                );
            }
            return <tr><td colSpan={9} style={{ textAlign: 'center', opacity: 0.5, padding: '2rem' }}>No stocks match the current filters</td></tr>;
        }
        return rows.map((e, i) => (
            <tr key={`${panel}-${e.ticker}`}>
                <td style={{ opacity: 0.4, fontSize: '0.75rem' }}>{i + 1}</td>
                <td>
                    <button
                        className="badge badge-blue"
                        onClick={() => setSelectedMover(e)}
                        title={`Show ${e.ticker} stock detail`}
                        style={{ fontSize: '0.7rem', border: 0, cursor: 'pointer' }}
                    >
                        {e.ticker}
                    </button>
                </td>
                <td style={{ fontSize: '0.78rem', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</td>
                <td>
                    <button
                        className="badge badge-ghost"
                        onClick={() => setActiveIndustry(e.industry || e.sector || 'All')}
                        style={{ border: 0, cursor: 'pointer', maxWidth: '135px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={`Filter ${e.industry || e.sector}`}
                    >
                        {e.industry || e.sector || '-'}
                    </button>
                </td>
                <td
                    title={formatSessionLabel(e.session) ? `Move measured from ${formatSessionLabel(e.session)}` : undefined}
                    style={{ textAlign: 'right', color: (e.change_percent ?? 0) >= 0 ? 'var(--brand-green)' : 'var(--brand-red)', fontWeight: 700, fontSize: '0.85rem' }}
                >
                    {e.change_percent != null ? `${e.change_percent >= 0 ? '+' : ''}${e.change_percent.toFixed(2)}%` : '-'}
                </td>
                <td style={{ textAlign: 'right', fontSize: '0.8rem' }}>{e.price != null ? `$${Number(e.price).toFixed(2)}` : '-'}</td>
                <td style={{ textAlign: 'center' }}>
                    {e.move_strength != null ? (
                        <span className="badge" style={{
                            background: e.move_strength > 2 ? 'rgba(239,68,68,0.2)' : e.move_strength > 1 ? 'rgba(251,191,36,0.2)' : 'rgba(148,163,184,0.12)',
                            color: e.move_strength > 2 ? 'rgb(248,113,113)' : e.move_strength > 1 ? 'rgb(252,211,77)' : 'rgba(255,255,255,0.55)',
                            fontSize: '0.7rem',
                            fontWeight: 800,
                        }}>
                            {e.move_strength > 2 ? '🔥' : e.move_strength > 0.5 ? '⚡' : '·'}
                            {Math.abs(e.move_strength) > 9 ? '9+' : Math.abs(e.move_strength).toFixed(1)}x
                        </span>
                    ) : e.avg_daily_move_pct != null ? (
                        <span style={{ fontSize: '0.68rem', opacity: 0.35 }}>~{e.avg_daily_move_pct.toFixed(2)}%/d</span>
                    ) : (
                        <span style={{ fontSize: '0.68rem', opacity: 0.28 }}>-</span>
                    )}
                </td>
                <td style={{ textAlign: 'right', fontSize: '0.75rem', opacity: 0.7 }}>{formatLarge(e.volume)}</td>
                <td style={{ textAlign: 'right', fontSize: '0.75rem', opacity: 0.7 }}>{formatLarge(e.market_cap)}</td>
            </tr>
        ));
    };

    const renderMoverTable = (title, rows, panel, icon, color, badgeClass) => (
        <div className="terminal-card" style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
            <div style={{ padding: '0.65rem 1rem', background: color, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                {icon}
                <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{title}</span>
                <span className={`badge ${badgeClass}`} style={{ marginLeft: 'auto' }}>{rows.length}</span>
                {loading && rows.length > 0 && (
                    <span style={{ fontSize: '0.68rem', opacity: 0.55, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                        <Loader2 size={11} className="animate-spin" />
                        {loadedCount}/{activeTickers.length}
                    </span>
                )}
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
                <table className="table" style={{ marginTop: 0, minWidth: 760 }}>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th onClick={handleSort(panel, 'ticker')} style={{ cursor: 'pointer', userSelect: 'none' }}>Ticker{sortArrow(panel, 'ticker')}</th>
                            <th onClick={handleSort(panel, 'name')} style={{ cursor: 'pointer', userSelect: 'none' }}>Name{sortArrow(panel, 'name')}</th>
                            <th onClick={handleSort(panel, 'industry')} style={{ cursor: 'pointer', userSelect: 'none' }}>Industry{sortArrow(panel, 'industry')}</th>
                            <th onClick={handleSort(panel, 'change_percent')} style={{ cursor: 'pointer', userSelect: 'none' }}>%{sortArrow(panel, 'change_percent')}</th>
                            <th onClick={handleSort(panel, 'price')} style={{ cursor: 'pointer', userSelect: 'none' }}>Price{sortArrow(panel, 'price')}</th>
                            <th onClick={handleSort(panel, 'move_strength')} style={{ cursor: 'pointer', userSelect: 'none' }}>Signal{sortArrow(panel, 'move_strength')}</th>
                            <th onClick={handleSort(panel, 'volume')} style={{ cursor: 'pointer', userSelect: 'none' }}>Vol{sortArrow(panel, 'volume')}</th>
                            <th onClick={handleSort(panel, 'market_cap')} style={{ cursor: 'pointer', userSelect: 'none' }}>Cap{sortArrow(panel, 'market_cap')}</th>
                        </tr>
                    </thead>
                    <tbody>{renderRows(rows, panel)}</tbody>
                </table>
            </div>
        </div>
    );

    const explainMovements = () => {
        const topGainers = gainers.slice(0, 5).map(e => `${e.ticker} ${e.change_percent >= 0 ? '+' : ''}${e.change_percent?.toFixed(2)}% (${e.industry || e.sector || 'Unknown'})`).join(', ');
        const topLosers = losers.slice(0, 5).map(e => `${e.ticker} ${e.change_percent?.toFixed(2)}% (${e.industry || e.sector || 'Unknown'})`).join(', ');
        const industryContext = industries.slice(0, 8).map(i => `${i.name} ${i.count}`).join(', ');
        const prompt = `Explain the Movements page for timeframe ${currentWindow.label}${currentWindow.interval ? ` using ${currentWindow.interval} candles` : ''}${extended ? ' including extended hours' : ''}. Use current market overview, sector/industry context, and fresh news/web search to explain why the biggest movers are moving. Current top gainers: ${topGainers || 'still loading'}. Current top losers: ${topLosers || 'still loading'}. Active industry filter: ${activeIndustry}. Visible industries: ${industryContext || 'still loading'}. If the current filters hide everything or data is still loading, say that plainly and explain what to refresh/check.`;
        onExplain?.(prompt, 'Explaining market movers');
    };

    const signalPeerStats = useMemo(() => {
        const usable = signalStats.filter(s => !s.error);
        const avg = (key) => {
            const values = usable.map(s => Number(s[key])).filter(Number.isFinite);
            return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        };
        return {
            avgMove: avg('current_move_pct'),
            avgRange: avg('current_range_pct'),
            avgVolumeRatio: avg('volume_ratio'),
            count: usable.length,
        };
    }, [signalStats]);

    const saveCurrentSignal = () => {
        const clean = signalStats.filter(s => !s.error);
        if (!clean.length) return notifyRef.current?.('No signal stats to save yet', 'yellow');
        const saved = {
            id: Date.now(),
            name: `${activeIndustry !== 'All' ? activeIndustry : 'Top movers'} ${new Date().toLocaleString()}`,
            industry: activeIndustry,
            period,
            tickers: clean.map(s => s.ticker),
            peer: signalPeerStats,
            signals: clean,
        };
        setSavedSignals(prev => [saved, ...prev].slice(0, 30));
        notifyRef.current?.('Trading signal saved', 'green');
    };

    const createSignalWatch = async () => {
        const tickers = parseTickers(signalInput || selectedSignalTickers.join(', ')).slice(0, 20);
        if (!tickers.length) return notifyRef.current?.('Choose ticker(s) before creating a watch', 'yellow');
        setWatchSaving(true);
        try {
            await axios.post(`${INTELLIGENCE_SERVICE}/signal-watches`, { tickers, ...watchForm });
            await loadSignalWatches();
            notifyRef.current?.(`Watching ${tickers.join(', ')}`, 'green');
        } catch (error) { notifyRef.current?.(error.response?.data?.detail || 'Could not create signal watch', 'red'); }
        finally { setWatchSaving(false); }
    };

    const toggleSignalWatch = async (watch) => {
        try { await axios.patch(`${INTELLIGENCE_SERVICE}/signal-watches/${watch.id}`, { enabled: !watch.enabled }); await loadSignalWatches(); }
        catch { notifyRef.current?.('Could not update signal watch', 'red'); }
    };

    const deleteSignalWatch = async (watch) => {
        try { await axios.delete(`${INTELLIGENCE_SERVICE}/signal-watches/${watch.id}`); await loadSignalWatches(); }
        catch { notifyRef.current?.('Could not delete signal watch', 'red'); }
    };

    const openSignalEvent = async (event) => {
        try { await axios.post(`${INTELLIGENCE_SERVICE}/signal-events/read`, { event_ids: [event.id] }); } catch { /* local navigation is still useful */ }
        setSignalEvents(prev => prev.map(item => item.id === event.id ? { ...item, read: true } : item));
        setUnreadSignalEvents(prev => Math.max(0, prev - (event.read ? 0 : 1)));
        setSignalInput(event.ticker);
        setSelectedSignalTickers([event.ticker]);
        onOpenChart?.(event.ticker, event.window);
    };

    const explainSignal = () => {
        const summary = signalStats.filter(s => !s.error).slice(0, 8).map(s =>
            `${s.ticker}: ${s.label}, move ${s.current_move_pct ?? '-'}%, range ${s.current_range_pct ?? '-'}%, avg range ${s.avg_range_pct ?? '-'}%, volume ${s.volume_ratio ?? '-'}x, close location ${s.close_location_pct ?? '-'}%`
        ).join('; ');
        const prompt = `Analyze these trading signals from the Movement tab. Context: ${activeIndustry !== 'All' ? `industry filter ${activeIndustry}` : 'top highest and lowest movers'}. Peer averages: move ${signalPeerStats.avgMove?.toFixed?.(2) ?? '-'}%, range ${signalPeerStats.avgRange?.toFixed?.(2) ?? '-'}%, volume ${signalPeerStats.avgVolumeRatio?.toFixed?.(2) ?? '-'}x. Signals: ${summary || 'still loading'}. Explain which moves look abnormal, which are industry-wide vs stock-specific, and what to watch next.`;
        onExplain?.(prompt, 'Explaining trading signal');
    };

    return (
        <div style={{ padding: '1.5rem 2rem', height: 'calc(100vh - 4rem)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexShrink: 0, flexWrap: 'wrap', gap: '0.75rem' }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Market Movers</h1>
                    <div style={{ marginTop: '0.25rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{activeUniverseLabel}</span>
                        {' · '}
                        {loading ? `${loadingStage || 'Loading movers'}${loadedCount > 0 ? ` · ${loadedCount}/${activeTickers.length}` : ''}` : `${entries.length}/${activeTickers.length} tracked stocks loaded`}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button style={subTabStyle(activeTab === 'movers')} onClick={() => setActiveTab('movers')}>
                        <TrendingUp size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} /> Movers
                    </button>
                    <button style={subTabStyle(activeTab === 'news')} onClick={() => setActiveTab('news')}>
                        <Newspaper size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} /> Core News
                    </button>
                    <button style={subTabStyle(activeTab === 'signal')} onClick={() => setActiveTab('signal')}>
                        <Activity size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} /> Trading Signal
                        {unreadSignalEvents > 0 && <span style={{ marginLeft: 5, minWidth: 16, height: 16, lineHeight: '16px', borderRadius: 8, display: 'inline-block', background: 'var(--brand-red)', color: '#fff', fontSize: '0.62rem' }}>{unreadSignalEvents}</span>}
                    </button>
                    <button style={subTabStyle(activeTab === 'watches')} onClick={() => setActiveTab('watches')}>
                        <Bell size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} /> Signal Watches
                        {unreadSignalEvents > 0 && <span style={{ marginLeft: 5, minWidth: 16, height: 16, lineHeight: '16px', borderRadius: 8, display: 'inline-block', background: 'var(--brand-red)', color: '#fff', fontSize: '0.62rem' }}>{unreadSignalEvents}</span>}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={explainMovements} title="Ask assistant to explain these movers with news">
                        <MessageCircleQuestion size={14} /> Explain
                    </button>
                    <select className="input" value={period} onChange={e => setPeriod(e.target.value)} style={{ width: 'auto', padding: '0.35rem 0.6rem', fontSize: '0.8rem' }}>
                        {Object.entries(MOVEMENT_WINDOWS).map(([value, option]) => (
                            <option key={value} value={value}>{option.label}</option>
                        ))}
                    </select>
                    <button className={`btn btn-xs ${extended ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setExtended(e => !e)} title={currentWindow.quoteFastPath ? '1D movers use latest quote snapshots for speed' : 'Extended hours'} style={{ fontSize: '0.7rem', padding: '0.3rem 0.5rem', opacity: currentWindow.quoteFastPath ? 0.55 : 1 }}>
                        Ext
                    </button>
                    <button className="btn btn-ghost btn-xs" onClick={() => fetchData({ force: true })} disabled={loading} title="Refresh">
                        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>

            <div style={{ marginBottom: '0.8rem', flexShrink: 0, display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: '420px' }}>
                    <Search size={14} style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }} />
                    <input className="input" placeholder="Search ticker, name, sector, industry..." value={search} onChange={e => setSearch(e.target.value)} style={{ paddingLeft: '2rem', fontSize: '0.85rem' }} />
                </div>
                <button className="btn btn-ghost btn-xs" onClick={() => setShowUniverseEditor(v => !v)} title="Edit ticker universe">
                    Universe {activeTickers.length} · {activeUniverseLabel}
                </button>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    <Filter size={14} />
                    Rank by
                </label>
                <select className="input" value={rankMetric} onChange={e => setRankMetric(e.target.value)} style={{ width: 'auto', padding: '0.35rem 0.6rem', fontSize: '0.8rem' }}>
                    <option value="change_percent">Movement %</option>
                    <option value="volume">Market volume</option>
                    <option value="market_cap">Market cap</option>
                </select>
                {activeIndustry !== 'All' && (
                    <button className="btn btn-ghost btn-xs" onClick={() => setActiveIndustry('All')}>Clear {activeIndustry}</button>
                )}
            </div>

            {showUniverseEditor && (
                <div className="terminal-card" style={{ marginBottom: '1rem', padding: '0.85rem', flexShrink: 0, border: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: '0.85rem' }}>Ticker Universe</strong>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Used by Movers, Core News, and Trading Signal</span>
                        <button className="btn btn-xs btn-ghost" onClick={loadHighVolumeUniverse} disabled={universeLoading} title="Load high-volume tickers from yfinance quotes">
                            {universeLoading && <Loader2 size={12} className="animate-spin" />} High Volume
                        </button>
                        <button className="btn btn-xs btn-primary" onClick={applyTickerUniverse} style={{ marginLeft: 'auto' }}>Apply</button>
                        <button className="btn btn-xs btn-ghost" onClick={resetTickerUniverse}>Reset</button>
                    </div>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
                        {UNIVERSE_PRESETS.map(preset => (
                            <button
                                key={preset.key}
                                className="badge badge-ghost"
                                onClick={() => loadUniversePreset(preset)}
                                title={`Fetch latest ${preset.label} from yfinance screener; fallback ${preset.tickers.length}: ${preset.tickers.slice(0, 12).join(', ')}${preset.tickers.length > 12 ? '...' : ''}`}
                                style={{ border: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}
                                disabled={Boolean(presetLoading)}
                            >
                                {presetLoading === preset.key && <Loader2 size={11} className="animate-spin" style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />}
                                {preset.label} <span style={{ opacity: 0.55 }}>{preset.tickers.length}</span>
                            </button>
                        ))}
                    </div>
                    {universeHistory.length > 0 && (
                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.6rem', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700 }}>Recent</span>
                            {universeHistory.slice(0, 5).map(item => (
                                <button
                                    key={item.id}
                                    className="badge badge-blue"
                                    onClick={() => applyUniverseList(item.tickers, item.label, { remember: false })}
                                    title={(item.tickers || []).join(', ')}
                                    style={{ border: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}
                                >
                                    {item.label} <span style={{ opacity: 0.7 }}>{(item.tickers || []).length}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    <textarea
                        className="input"
                        value={tickerUniverseInput}
                        onChange={e => setTickerUniverseInput(e.target.value)}
                        placeholder="NVDA, AMD, QCOM, AVGO, TSM"
                        style={{ width: '100%', minHeight: 58, resize: 'vertical', fontSize: '0.82rem', lineHeight: 1.35 }}
                    />
                    <div style={{ marginTop: '0.45rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        Parsed {parseTickers(tickerUniverseInput).length} ticker{parseTickers(tickerUniverseInput).length === 1 ? '' : 's'}: {parseTickers(tickerUniverseInput).slice(0, 20).join(', ')}{parseTickers(tickerUniverseInput).length > 20 ? '...' : ''}
                    </div>
                </div>
            )}

            <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.45rem', flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
                <button className={`badge ${activeIndustry === 'All' ? 'badge-blue' : 'badge-ghost'}`} onClick={() => setActiveIndustry('All')} style={{ border: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}>All industries</button>
                {visibleIndustries.map(industry => (
                    <button key={industry.name} className={`badge ${activeIndustry === industry.name ? 'badge-blue' : 'badge-ghost'}`} onClick={() => setActiveIndustry(industry.name)} style={{ border: 0, cursor: 'pointer', whiteSpace: 'nowrap' }} title={industryTitle(industry)}>
                        {industry.name} <span style={{ opacity: 0.55 }}>{industry.count}</span>
                    </button>
                ))}
                {industries.length > 12 && (
                    <button className="badge badge-ghost" onClick={() => setShowAllIndustries(v => !v)} style={{ border: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        {showAllIndustries ? 'Less' : `More +${industries.length - 12}`}
                    </button>
                )}
            </div>

            {metricLeaders.length > 0 && activeTab === 'movers' && (
                <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', marginBottom: '1rem', flexShrink: 0 }}>
                    {metricLeaders.map(entry => (
                        <button key={`leader-${entry.ticker}`} onClick={() => setSelectedMover(entry)} className="terminal-card" style={{ border: '1px solid var(--border-subtle)', padding: '0.6rem 0.75rem', minWidth: 150, textAlign: 'left', cursor: 'pointer', color: 'var(--text-primary)', background: 'var(--bg-card)' }} title={`Show ${entry.ticker} stock detail`}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center' }}>
                                <strong style={{ fontSize: '0.8rem' }}>{entry.ticker}</strong>
                                <span style={{ color: (entry.change_percent ?? 0) >= 0 ? 'var(--brand-green)' : 'var(--brand-red)', fontSize: '0.76rem', fontWeight: 700 }}>
                                    {entry.change_percent != null ? `${entry.change_percent >= 0 ? '+' : ''}${entry.change_percent.toFixed(2)}%` : '-'}
                                </span>
                            </div>
                            <div style={{ marginTop: '0.35rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                Vol {formatLarge(entry.volume)}{entry.market_cap ? ` · Cap ${formatLarge(entry.market_cap)}` : ''}
                            </div>
                        </button>
                    ))}
                </div>
            )}

            {activeTab === 'movers' ? (
                <div style={{ display: 'flex', gap: '1rem', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', gap: '1.5rem', flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
                        {renderMoverTable('Gainers', gainers, 'gainers', <TrendingUp size={16} style={{ color: 'var(--brand-green)' }} />, 'rgba(16, 185, 129, 0.1)', 'badge-green')}
                        {renderMoverTable('Losers', losers, 'losers', <TrendingDown size={16} style={{ color: 'var(--brand-red)' }} />, 'rgba(239, 68, 68, 0.1)', 'badge-red')}
                    </div>
                    {selectedMover && (
                        <div style={{ flex: '0 0 min(430px, 34vw)', minWidth: 340, maxWidth: 460, minHeight: 0, overflow: 'auto' }}>
                            <MoverStockDetail
                                ticker={selectedMover.ticker}
                                mover={selectedMover}
                                onClose={() => setSelectedMover(null)}
                                onExplain={onExplain}
                            />
                        </div>
                    )}
                </div>
            ) : activeTab === 'watches' ? (
                <div className="terminal-card" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.85rem' }}><BellRing size={17} color="var(--brand-blue)" /><strong>Signal Watches</strong><span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Use the Trading Signal tab to scan tickers, then create a watch here.</span><button className="btn btn-xs btn-ghost" style={{ marginLeft: 'auto' }} onClick={loadSignalWatches}><RefreshCw size={12} /> Refresh</button></div>
                    <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.75rem', background: 'var(--bg-accent)', borderRadius: 7 }}>
                        <input className="input" value={signalInput} onChange={e => setSignalInput(e.target.value)} placeholder="SOXL, NVDA" style={{ flex: '1 1 190px', maxWidth: 350, fontSize: '0.78rem' }} />
                        <select className="input" value={watchForm.direction} onChange={e => setWatchForm(prev => ({ ...prev, direction: e.target.value }))} style={{ width: 'auto', fontSize: '0.75rem' }}><option value="either">Up or down</option><option value="up">Up only</option><option value="down">Down only</option></select>
                        <input className="input" type="number" min="0.1" step="0.1" value={watchForm.threshold_percent} onChange={e => setWatchForm(prev => ({ ...prev, threshold_percent: Number(e.target.value) }))} style={{ width: 70, fontSize: '0.75rem' }} />
                        <select className="input" value={watchForm.window} onChange={e => setWatchForm(prev => ({ ...prev, window: e.target.value }))} style={{ width: 'auto', fontSize: '0.75rem' }}>{['1m', '5m', '15m', '30m', '1h', '1d'].map(window => <option key={window} value={window}>{window}</option>)}</select>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem' }}><input type="checkbox" checked={watchForm.require_volume} onChange={e => setWatchForm(prev => ({ ...prev, require_volume: e.target.checked }))} /> Volume</label>
                        <button className="btn btn-xs btn-primary" onClick={createSignalWatch} disabled={watchSaving}>{watchSaving ? <Loader2 size={12} className="animate-spin" /> : <Bell size={12} />} Create watch</button>
                    </div>
                    <div style={{ marginTop: '1rem', display: 'grid', gap: '0.45rem' }}>{signalWatches.length ? signalWatches.map(watch => <div key={watch.id} className="panel" style={{ margin: 0, padding: '0.7rem', display: 'flex', gap: '0.65rem', alignItems: 'center', flexWrap: 'wrap' }}><Bell size={14} color={watch.enabled ? 'var(--brand-green)' : 'var(--text-muted)'} /><strong>{watch.tickers.join(', ')}</strong><span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{watch.direction} {watch.threshold_percent}% in {watch.window}{watch.require_volume ? ` · ${watch.volume_multiplier}x volume` : ''}</span><span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{watch.last_status || 'Waiting for first check'}</span><button className="btn btn-xs btn-ghost" onClick={() => toggleSignalWatch(watch)}>{watch.enabled ? 'Pause' : 'Resume'}</button><button className="btn btn-xs btn-ghost" onClick={() => deleteSignalWatch(watch)}><Trash2 size={12} /></button></div>) : <div style={{ color: 'var(--text-muted)', padding: '1.5rem 0' }}>No signal watches yet.</div>}</div>
                    <div style={{ marginTop: '1rem' }}><strong style={{ fontSize: '0.82rem' }}>Alert Inbox</strong>{signalEvents.length ? signalEvents.map(event => <button key={event.id} onClick={() => openSignalEvent(event)} style={{ marginTop: '0.45rem', display: 'block', width: '100%', textAlign: 'left', border: '1px solid var(--border-subtle)', background: event.read ? 'transparent' : 'rgba(59,130,246,0.08)', color: 'var(--text-primary)', padding: '0.55rem', borderRadius: 6, cursor: 'pointer', fontSize: '0.76rem' }}><strong>{event.ticker}</strong> {event.move_percent >= 0 ? '+' : ''}{event.move_percent}% in {event.window} <span style={{ float: 'right', color: 'var(--text-muted)' }}>{formatDate(event.created_at)}</span></button>) : <div style={{ color: 'var(--text-muted)', padding: '0.8rem 0' }}>No triggered alerts yet.</div>}</div>
                </div>
            ) : activeTab === 'signal' ? (
                <div className="terminal-card" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 0 }}>
                    <div style={{ padding: '0.85rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <Activity size={16} />
                        <strong style={{ fontSize: '0.95rem' }}>Trading Signal</strong>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            {selectedSignalTickers.length ? `${selectedSignalTickers.join(', ')}` : 'Choose ticker(s) to scan'}
                        </span>
                        {signalLoading && <Loader2 size={15} className="animate-spin" style={{ marginLeft: 'auto' }} />}
                        <button className="btn btn-xs btn-ghost" onClick={explainSignal} style={{ marginLeft: signalLoading ? 0 : 'auto' }}>
                            <MessageCircleQuestion size={13} /> Explain
                        </button>
                        <button className="btn btn-xs btn-primary" onClick={saveCurrentSignal}>
                            <Save size={13} /> Save Signal
                        </button>
                    </div>
                    <div style={{ padding: '1rem 1rem 0', display: 'flex', gap: '0.55rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 460 }}>
                            {signalSuggestLoading ? (
                                <Loader2 size={14} className="animate-spin" style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.55 }} />
                            ) : (
                                <Search size={14} style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }} />
                            )}
                            <input
                                className="input"
                                value={signalInput}
                                onChange={e => setSignalInput(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') loadSignalStats(signalInput); }}
                                placeholder="Type ticker(s), e.g. ARM, AVGO"
                                autoComplete="off"
                                style={{ paddingLeft: '2rem', fontSize: '0.82rem' }}
                            />
                            {signalSuggestions.length > 0 && (
                                <div className="terminal-card" style={{ position: 'absolute', top: 'calc(100% + 0.35rem)', left: 0, right: 0, zIndex: 20, padding: '0.3rem', border: '1px solid var(--border)', boxShadow: '0 12px 28px rgba(0,0,0,0.28)' }}>
                                    {signalSuggestions.map(item => (
                                        <button
                                            key={`signal-autocomplete-${item.symbol}`}
                                            type="button"
                                            onMouseDown={e => {
                                                e.preventDefault();
                                                const next = replaceCurrentSignalToken(signalInput, item.symbol);
                                                setSignalInput(next);
                                                setSignalSuggestions([]);
                                            }}
                                            style={{ width: '100%', border: 0, background: 'transparent', color: 'var(--text-primary)', textAlign: 'left', padding: '0.45rem 0.55rem', borderRadius: 6, cursor: 'pointer', display: 'flex', gap: '0.6rem', alignItems: 'center' }}
                                            title={item.name}
                                        >
                                            <span className="badge badge-blue" style={{ fontSize: '0.68rem', flexShrink: 0 }}>{item.symbol}</span>
                                            <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name || item.type || 'Equity'}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <button className="btn btn-xs btn-primary" onClick={() => loadSignalStats(signalInput)} disabled={signalLoading}>
                            {signalLoading && <Loader2 size={12} className="animate-spin" />} Scan
                        </button>
                        <select
                            className="input"
                            value={signalPeriod}
                            onChange={e => setSignalPeriod(normalizeSignalPeriod(e.target.value, signalInterval))}
                            style={{ width: 'auto', padding: '0.32rem 0.55rem', fontSize: '0.76rem' }}
                            title="History window. Shorter intraday candles have smaller yfinance lookback limits."
                        >
                            {SIGNAL_PERIOD_OPTIONS.map(option => (
                                <option key={option.value} value={option.value} disabled={!getSignalIntervalOption(signalInterval).periods.includes(option.value)}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                        <select
                            className="input"
                            value={signalInterval}
                            onChange={e => {
                                const nextInterval = e.target.value;
                                setSignalInterval(nextInterval);
                                setSignalPeriod(prev => normalizeSignalPeriod(prev, nextInterval));
                            }}
                            style={{ width: 'auto', padding: '0.32rem 0.55rem', fontSize: '0.76rem' }}
                            title="Candle interval for day trading or swing trading signal stats"
                        >
                            {SIGNAL_INTERVAL_OPTIONS.map(option => (
                                <option key={option.value} value={option.value}>
                                    {option.label} · {option.style}
                                </option>
                            ))}
                        </select>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            <input type="checkbox" checked={signalIncludePeers} onChange={e => setSignalIncludePeers(e.target.checked)} />
                            Peers
                        </label>
                        {suggestedSignalTickers.map(ticker => (
                            <button key={`signal-suggest-${ticker}`} className="badge badge-ghost" onClick={() => loadSignalStats(ticker)} style={{ border: 0, cursor: 'pointer' }}>
                                {ticker}
                            </button>
                        ))}
                    </div>
                    <div style={{ padding: '0.55rem 1rem 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        Source: live yfinance OHLCV, not saved datasets. {signalPeers.length > 0 ? `Peers for ${signalPrimaryTicker}: ${signalPeers.join(', ')} (${signalPeerSource || 'peer resolver'})` : `Peer resolver: ${signalPeerSource || 'scan one ticker with Peers on to add comparable names.'}`}
                    </div>
                    <div className="terminal-card" style={{ margin: '0.9rem 1rem 0', padding: '0.8rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', marginBottom: '0.65rem' }}>
                            <BellRing size={15} color="var(--brand-blue)" />
                            <strong style={{ fontSize: '0.84rem' }}>Signal Watch</strong>
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>Background monitoring and in-app alerts</span>
                            <button className="btn btn-xs btn-ghost" style={{ marginLeft: 'auto' }} onClick={loadSignalWatches}><RefreshCw size={12} /> Refresh</button>
                        </div>
                        <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <select className="input" value={watchForm.direction} onChange={e => setWatchForm(prev => ({ ...prev, direction: e.target.value }))} style={{ width: 'auto', fontSize: '0.75rem' }}><option value="either">Up or down</option><option value="up">Up only</option><option value="down">Down only</option></select>
                            <input className="input" type="number" min="0.1" step="0.1" value={watchForm.threshold_percent} onChange={e => setWatchForm(prev => ({ ...prev, threshold_percent: Number(e.target.value) }))} style={{ width: 78, fontSize: '0.75rem' }} title="Percent move threshold" />
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>% in</span>
                            <select className="input" value={watchForm.window} onChange={e => setWatchForm(prev => ({ ...prev, window: e.target.value }))} style={{ width: 'auto', fontSize: '0.75rem' }}>{['1m', '5m', '15m', '30m', '1h', '1d'].map(window => <option key={window} value={window}>{window}</option>)}</select>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}><input type="checkbox" checked={watchForm.require_volume} onChange={e => setWatchForm(prev => ({ ...prev, require_volume: e.target.checked }))} /> Volume</label>
                            {watchForm.require_volume && <><span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>min</span><input className="input" type="number" min="1" step="0.1" value={watchForm.volume_multiplier} onChange={e => setWatchForm(prev => ({ ...prev, volume_multiplier: Number(e.target.value) }))} style={{ width: 65, fontSize: '0.75rem' }} /><span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>x</span></>}
                            <button className="btn btn-xs btn-primary" onClick={createSignalWatch} disabled={watchSaving}>{watchSaving ? <Loader2 size={12} className="animate-spin" /> : <Bell size={12} />} Watch selected</button>
                            {[{ threshold_percent: 2, window: '15m' }, { threshold_percent: 4, window: '1h' }].map(preset => <button key={preset.window} className="badge badge-ghost" style={{ border: 0, cursor: 'pointer' }} onClick={() => setWatchForm(prev => ({ ...prev, ...preset }))}>+/- {preset.threshold_percent}% / {preset.window}</button>)}
                        </div>
                        {signalWatches.length > 0 && <div style={{ marginTop: '0.7rem', display: 'grid', gap: '0.35rem' }}>{signalWatches.map(watch => <div key={watch.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.73rem', background: 'var(--bg-accent)', padding: '0.45rem 0.55rem', borderRadius: 6, flexWrap: 'wrap' }}><Bell size={12} color={watch.enabled ? 'var(--brand-green)' : 'var(--text-muted)'} /><strong>{watch.tickers.join(', ')}</strong><span>{watch.direction} {watch.threshold_percent}% / {watch.window}{watch.require_volume ? ` · ${watch.volume_multiplier}x volume` : ''}</span><span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>{watch.last_status || 'Waiting'}</span><button className="btn btn-xs btn-ghost" onClick={() => toggleSignalWatch(watch)}>{watch.enabled ? 'Pause' : 'Resume'}</button><button className="btn btn-xs btn-ghost" onClick={() => deleteSignalWatch(watch)} title="Delete watch"><Trash2 size={12} /></button></div>)}</div>}
                        {signalEvents.length > 0 && <div style={{ marginTop: '0.7rem' }}><div style={{ fontSize: '0.75rem', fontWeight: 700, marginBottom: '0.35rem' }}>Alert Inbox</div>{signalEvents.slice(0, 6).map(event => <button key={event.id} onClick={() => openSignalEvent(event)} style={{ width: '100%', textAlign: 'left', border: '1px solid var(--border-subtle)', background: event.read ? 'transparent' : 'rgba(59,130,246,0.08)', color: 'var(--text-primary)', padding: '0.45rem 0.55rem', borderRadius: 6, cursor: 'pointer', marginBottom: '0.3rem', fontSize: '0.73rem' }}><strong>{event.ticker}</strong> {event.move_percent >= 0 ? '+' : ''}{event.move_percent}% in {event.window} · {event.volume_ratio != null ? `${event.volume_ratio}x volume` : 'volume unavailable'} <span style={{ float: 'right', color: 'var(--text-muted)' }}>{event.created_at ? formatDate(event.created_at) : ''}</span></button>)}</div>}
                    </div>
                    <div style={{ padding: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.75rem' }}>
                        {[
                            { label: 'Peer Avg Move', value: signalPeerStats.avgMove != null ? `${signalPeerStats.avgMove.toFixed(2)}%` : '-', help: 'Average latest close-to-previous-close return across the loaded target and peer symbols.' },
                            { label: 'Peer Avg Candle', value: signalPeerStats.avgRange != null ? `${signalPeerStats.avgRange.toFixed(2)}%` : '-', help: 'Average latest candle high-low range across the loaded target and peer symbols.' },
                            { label: 'Peer Volume', value: signalPeerStats.avgVolumeRatio != null ? `${signalPeerStats.avgVolumeRatio.toFixed(2)}x` : '-', help: 'Average latest volume divided by recent average volume across loaded symbols.' },
                            { label: 'Samples', value: signalPeerStats.count || '-', help: 'Number of target/peer symbols with usable candle data in this scan.' },
                        ].map(card => (
                            <div key={card.label} className="panel" title={card.help} style={{ margin: 0, padding: '0.75rem 0.9rem' }}>
                                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.25rem', cursor: 'help' }}>{card.label}</div>
                                <div style={{ fontSize: '1rem', fontWeight: 800 }}>{card.value}</div>
                            </div>
                        ))}
                    </div>
                    {selectedSignalTickers.length === 0 && (
                        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                            {loading ? (
                                <>
                                    <Loader2 size={18} className="animate-spin" style={{ verticalAlign: 'text-bottom', marginRight: '0.5rem' }} />
                                    Loading movers before signal suggestions...
                                </>
                            ) : 'Select a ticker above or type one to calculate candle and peer stats.'}
                        </div>
                    )}
                    {signalLoading && signalStats.filter(s => !s.error).length === 0 && selectedSignalTickers.length > 0 && (
                        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                            <Loader2 size={18} className="animate-spin" style={{ verticalAlign: 'text-bottom', marginRight: '0.5rem' }} />
                            Calculating candle and peer stats for {selectedSignalTickers.join(', ')}...
                        </div>
                    )}
                    <div style={{ padding: '0 1rem 1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' }}>
                        {signalStats.filter(s => !s.error).map(s => (
                            <div key={s.ticker} className="terminal-card" style={{ padding: '0.9rem', border: `1px solid ${s.ticker === signalPrimaryTicker ? 'var(--brand-blue)' : 'var(--border-subtle)'}` }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center', marginBottom: '0.65rem' }}>
                                    <strong>{s.ticker} {s.ticker === signalPrimaryTicker && <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>target</span>}</strong>
                                    <span
                                        className={`badge ${String(s.label).includes('Weak') ? 'badge-red' : String(s.label).includes('momentum') || String(s.label).includes('Strong') ? 'badge-green' : 'badge-blue'}`}
                                        title={SIGNAL_BADGE_HELP[s.label] || 'Summary of the latest price and volume movement.'}
                                        style={{ cursor: 'help' }}
                                    >
                                        {s.label}
                                    </span>
                                </div>
                                <div style={{ display: 'grid', gap: '0.55rem' }}>
                                    <SignalMeter label="Move" value={s.current_move_pct} max={6} suffix="%" color={(s.current_move_pct ?? 0) >= 0 ? 'var(--brand-green)' : 'var(--brand-red)'} help="Latest close versus the previous candle close. For daily candles, this matches the usual market daily-change calculation and includes overnight gaps." />
                                    <SignalMeter label="Candle range" value={s.current_range_pct} max={8} suffix="%" color="var(--brand-purple)" help="Latest candle high-low range as a percent of open. Larger values mean wider intraday or daily movement." />
                                    <SignalMeter label="Volume ratio" value={s.volume_ratio} max={3} suffix="x" color="var(--brand-blue)" help="Latest candle volume divided by the recent average volume. Above 1.0 means volume is heavier than normal." />
                                    <SignalMeter label="Close location" value={s.close_location_pct} max={100} suffix="%" color={(s.close_location_pct ?? 50) >= 50 ? 'var(--brand-green)' : 'var(--brand-red)'} help="Where the latest close sits inside the candle range. Near 100% closed near the high; near 0% closed near the low." />
                                </div>
                                <div style={{ marginTop: '0.7rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                                    <MetricCell label="Avg candle" value={s.avg_range_pct != null ? `${s.avg_range_pct}%` : '-'} help="Average high-low candle range over the recent sample." />
                                    <MetricCell label="Move score" value={s.move_score ?? '-'} help="Current absolute move divided by average absolute move. Around 1 is normal; higher means unusual movement." />
                                    <MetricCell label="Avg up" value={s.avg_up_pct != null ? `${s.avg_up_pct}%` : '-'} help="Average positive close-to-previous-close return in the sample." />
                                    <MetricCell label="Avg down" value={s.avg_down_pct != null ? `${s.avg_down_pct}%` : '-'} help="Average negative close-to-previous-close return in the sample." />
                                    <MetricCell label="Max up" value={s.max_up_pct != null ? `${s.max_up_pct}%` : '-'} help="Largest close-to-previous-close gain in the sampled candles, including gaps." />
                                    <MetricCell label="Max down" value={s.max_down_pct != null ? `${s.max_down_pct}%` : '-'} help="Largest close-to-previous-close loss in the sampled candles, including gaps." />
                                </div>
                            </div>
                        ))}
                        {!signalLoading && signalStats.filter(s => !s.error).length === 0 && (
                            <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>No signal stats loaded yet.</div>
                        )}
                    </div>
                    {savedSignals.length > 0 && (
                        <div style={{ padding: '0 1rem 1rem' }}>
                            <div style={{ fontSize: '0.8rem', fontWeight: 800, marginBottom: '0.5rem' }}>Saved Signals</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                {savedSignals.slice(0, 6).map(s => (
                                    <div key={s.id} className="panel" style={{ margin: 0, padding: '0.6rem 0.75rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: '0.78rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{s.tickers.join(', ')}</div>
                                        </div>
                                        <button className="btn btn-xs btn-ghost" onClick={() => { setSignalStats(s.signals); setActiveTab('signal'); }}>Load</button>
                                        <button className="btn btn-xs btn-ghost" onClick={() => setSavedSignals(prev => prev.filter(x => x.id !== s.id))} title="Delete">
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            ) : (
                <div className="terminal-card" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 0 }}>
                    <div style={{ padding: '0.85rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <Newspaper size={16} />
                        <strong style={{ fontSize: '0.95rem' }}>{newsSearchTicker ? `${newsSearchTicker} Headlines` : 'Headlines From Market Movers'}</strong>
                        {newsLoading && (
                            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                                <Loader2 size={15} className="animate-spin" />
                                {newsLoadedCount}/{newsMovers.length}
                            </span>
                        )}
                    </div>
                    <div style={{ padding: '0.65rem 1rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
                        <span className="badge badge-blue" style={{ fontSize: '0.68rem' }}>
                            {newsSearchTicker ? 'Ticker search' : `${Math.min(newsMoverLimit, maxNewsMoverCount || newsMoverLimit)} movers loaded`}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                            {[1, 3, 5].map(count => (
                                <button
                                    key={count}
                                    className={`btn btn-xs ${newsPerTicker === count ? 'btn-primary' : 'btn-ghost'}`}
                                    onClick={() => { setNewsPerTicker(count); setNewsMoverLimit(NEWS_MOVER_PAGE_SIZE); setNewsVisibleCount(12); }}
                                    disabled={newsLoading}
                                >
                                    {count}/ticker
                                </button>
                            ))}
                        </div>
                        <form onSubmit={submitNewsSearch} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 220, flex: '0 1 320px' }}>
                            <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                                <Search size={14} style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }} />
                                <input
                                    className="input"
                                    value={newsSearchInput}
                                    onChange={e => setNewsSearchInput(e.target.value.toUpperCase())}
                                    placeholder="Search ticker news"
                                    disabled={newsLoading}
                                    style={{ paddingLeft: '2rem', fontSize: '0.8rem', textTransform: 'uppercase' }}
                                />
                            </div>
                            <button className="btn btn-xs btn-ghost" type="submit" disabled={newsLoading || !newsSearchInput.trim()}>Search</button>
                            {newsSearchTicker && (
                                <button className="btn btn-xs btn-ghost" type="button" onClick={clearNewsSearch} disabled={newsLoading} title="Clear ticker search">
                                    <X size={12} />
                                </button>
                            )}
                        </form>
                        <button className="btn btn-xs btn-ghost" onClick={() => { cachedMoverNews.clear(); setNewsMoverLimit(NEWS_MOVER_PAGE_SIZE); setNewsRefreshToken(t => t + 1); setNewsVisibleCount(12); }} disabled={newsLoading} title="Refresh headlines">
                            <RefreshCw size={13} /> Refresh
                        </button>
                    </div>
                    {newsStatus && (
                        <div style={{ padding: '0.55rem 1rem', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            {newsStatus}
                        </div>
                    )}
                    {newsMovers.length === 0 ? (
                        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Finish loading movers to identify core news.</div>
                    ) : newsItems.length > 0 ? (
                        <>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '0.75rem', padding: '1rem' }}>
                                {visibleNewsItems.map((article, i) => (
                                    <a key={`${article.mover.ticker}-${i}-${article.title}`} href={article.link || '#'} target="_blank" rel="noreferrer" className="terminal-card" style={{ padding: '0.85rem', textDecoration: 'none', color: 'inherit', border: '1px solid var(--border-subtle)' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '0.45rem' }}>
                                            <span className={`badge ${article.mover.direction === 'highest' ? 'badge-green' : article.mover.direction === 'lowest' ? 'badge-red' : 'badge-blue'}`} style={{ fontSize: '0.68rem' }}>
                                                {article.mover.ticker} {article.mover.change_percent != null ? `${article.mover.change_percent >= 0 ? '+' : ''}${article.mover.change_percent?.toFixed(2)}%` : ''}
                                            </span>
                                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{formatDate(article.published)}</span>
                                        </div>
                                        <div style={{ fontWeight: 700, fontSize: '0.86rem', lineHeight: 1.35 }}>{article.title}</div>
                                        <div style={{ marginTop: '0.55rem', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                                            {article.publisher || 'Unknown'} · {article.mover.name}
                                        </div>
                                    </a>
                                ))}
                            </div>
                            {(newsVisibleCount < newsItems.length || (!newsSearchTicker && newsMoverLimit < maxNewsMoverCount)) && (
                                <div style={{ padding: '0 1rem 1rem', textAlign: 'center' }}>
                                    <button className="btn btn-sm btn-ghost" onClick={loadMoreNews} disabled={newsLoading}>
                                        {newsVisibleCount < newsItems.length
                                            ? `Show more headlines (${newsItems.length - newsVisibleCount} ready)`
                                            : `Load next ${Math.min(NEWS_MOVER_PAGE_SIZE, maxNewsMoverCount - newsMoverLimit)} movers`}
                                    </button>
                                </div>
                            )}
                        </>
                    ) : (
                        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                            {newsLoading ? `Loading headlines...` : 'No recent headlines found for the selected tickers.'}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default IndustryMovements;
