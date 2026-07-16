import React, { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import axios from 'axios';
import Papa from 'papaparse';
import { TrendingUp, TrendingDown, RefreshCw, Layers, BarChart3, Activity, Tag, X, ArrowUpDown, Edit3, Plus, Trash2, Save, Search, ChevronLeft, ChevronRight, ChevronDown, ExternalLink, LayoutGrid, Download, MessageCircleQuestion } from 'lucide-react';
import { motion } from 'framer-motion';
import { INTELLIGENCE_SERVICE, DATA_SERVICE } from '../config';

const ChartViewer = lazy(() => import('./ChartViewer'));

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'JPM', 'V', 'WMT', 'JNJ', 'PG', 'XOM', 'BAC', 'DIS', 'NFLX', 'ADBE', 'CRM', 'INTC', 'AMD', 'PYPL', 'COST', 'UBER', 'SQ', 'ABNB'];

const STOCK_BATCH_SIZE = 20;
const STOCK_BATCH_CONCURRENCY = 4;
const ETF_QUOTE_BATCH_SIZE = 8;
const ETF_QUOTE_BATCH_CONCURRENCY = 3;
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

const PERIOD_OPTIONS = ['1min','5min','15min','30min','1h', '1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max'];
const INTRADAY_INTERVAL = { '1min':'1m', '5min':'5m', '15min':'15m', '30min':'30m', '1h':'60m' };
const PERIOD_LABEL = {
    '1min':'1min', '5min':'5min', '15min':'15min', '30min':'30min', '1h':'1h',
    '1d':'1D', '5d':'5D', '1mo':'1M', '3mo':'3M', '6mo':'6M',
    '1y':'1Y', '2y':'2Y', '5y':'5Y', '10y':'10Y', 'ytd':'YTD', 'max':'MAX',
};

const SUPPORTED_INTERVALS = ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h'];

const resolveInterval = (p) => {
    const mapped = INTRADAY_INTERVAL[p];
    if (mapped) return SUPPORTED_INTERVALS.includes(mapped) ? mapped : null;
    const m = p && p.match(/^(\d+)min$/);
    if (m) {
        const min = parseInt(m[1]);
        const closest = [...SUPPORTED_INTERVALS].sort((a, b) => {
            const va = parseInt(a) || (a === '1h' ? 60 : parseInt(a));
            const vb = parseInt(b) || (b === '1h' ? 60 : parseInt(b));
            return Math.abs(va - min) - Math.abs(vb - min);
        })[0];
        return closest || null;
    }
    return null;
};

const isExtendedHours = () => {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    const min = et.getHours() * 60 + et.getMinutes();
    if (day === 0 || day === 6) return true;
    return min < 570 || min >= 960;
};

const SECTOR_PALETTE = {
    'Technology': '#3b82f6',
    'Communication Services': '#8b5cf6',
    'Consumer Cyclical': '#f59e0b',
    'Consumer Defensive': '#10b981',
    'Financial Services': '#ec4899',
    'Healthcare': '#ef4444',
    'Energy': '#f97316',
    'Broad Market': '#6b7280',
    'Basic Materials': '#22c55e',
    'Industrials': '#6366f1',
    'Real Estate': '#d946ef',
    'Utilities': '#06b6d4',
};

const CUSTOM_COLOR = '#f472b6';

const getTileColor = (pct) => {
    if (pct == null || !Number.isFinite(Number(pct))) return '#1e1e2e';
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

const getTileSize = (changePct) => {
    const mag = Number.isFinite(Number(changePct)) ? Math.abs(Number(changePct)) : 0;
    return Math.max(0.35, Math.min(3, 0.35 + 2.65 * mag / (mag + 3)));
};

const hasChangeValue = (item) => item?.change_percent != null && Number.isFinite(Number(item.change_percent));

const formatPct = (value, digits = 2) => {
    if (value == null || !Number.isFinite(Number(value))) return '-';
    const n = Number(value);
    return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
};

const timeAgo = (iso) => {
    if (!iso) return '';
    const sec = (Date.now() - new Date(iso).getTime()) / 1000;
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return Math.floor(sec / 86400) + 'd ago';
};

const HEATMAP_CACHE_TTL = 120000; // 2 minutes
const heatmapCacheStore = {};

const chunkArray = (items, size) => {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
};

const mergeSectorData = (base = {}, incoming = {}) => {
    const merged = {};
    for (const [sector, industries] of Object.entries(base || {})) {
        merged[sector] = {};
        for (const [industry, entries] of Object.entries(industries || {})) {
            merged[sector][industry] = [...entries];
        }
    }
    for (const [sector, industries] of Object.entries(incoming || {})) {
        if (!merged[sector]) merged[sector] = {};
        for (const [industry, entries] of Object.entries(industries || {})) {
            if (!merged[sector][industry]) merged[sector][industry] = [];
            const seen = new Set(merged[sector][industry].map(e => e.ticker));
            for (const entry of entries || []) {
                if (!entry?.ticker || !seen.has(entry.ticker)) {
                    merged[sector][industry].push(entry);
                    if (entry?.ticker) seen.add(entry.ticker);
                }
            }
        }
    }
    return merged;
};

const buildIndustryProxySectors = (quotes = []) => {
    const sectors = {};
    for (const quote of quotes || []) {
        const ticker = String(quote?.symbol || quote?.ticker || '').toUpperCase();
        if (!ticker) continue;
        const meta = INDUSTRY_PROXY_META[ticker] || { name: ticker, sector: 'ETF', industry: ticker };
        if (!sectors[meta.sector]) sectors[meta.sector] = {};
        if (!sectors[meta.sector][meta.industry]) sectors[meta.sector][meta.industry] = [];
        sectors[meta.sector][meta.industry].push({
            ticker,
            name: meta.name,
            price: quote.price,
            change: quote.change,
            change_percent: quote.change_percent != null ? Number(quote.change_percent) : null,
            market_cap: quote.market_cap,
            volume: quote.volume,
            avg_daily_move_pct: quote.avg_daily_move_pct,
            move_strength: quote.move_strength,
            avg_volume: quote.avg_volume,
            session: quote.session,
        });
    }
    return sectors;
};

const normalizeIndices = (indices) => {
    if (Array.isArray(indices)) return indices;
    return Object.entries(indices || {}).map(([symbol, data]) => ({ symbol, ...data }));
};

const SectorHeatmap = ({ notify, onBacktestTicker, onExplain }) => {
    const [sectors, setSectors] = useState(null);
    const [loading, setLoading] = useState(false);
    const [heatmapProgress, setHeatmapProgress] = useState(null);
    const [mode, setMode] = useState('etfs');
    const [tickerInput, setTickerInput] = useState('');
    const [tickers, setTickers] = useState(DEFAULT_TICKERS);
    const [hovered, setHovered] = useState(null);
    const [categories, setCategories] = useState([]);
    const [activeCategory, setActiveCategory] = useState(null);
    const [sortAsc, setSortAsc] = useState(false);
    const [customGroups, setCustomGroups] = useState(() => {
        try { return JSON.parse(localStorage.getItem('heatmap_groups') || '[]'); }
        catch { return []; }
    });
    const [showGroupEditor, setShowGroupEditor] = useState(false);
    const [editingGroup, setEditingGroup] = useState(null);
    const [customSectors, setCustomSectors] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [period, setPeriod] = useState('1d');
    const [selectedDetail, setSelectedDetail] = useState(null);
    const [intelTicker, setIntelTicker] = useState(null);
    const [showCustomMin, setShowCustomMin] = useState(false);
    const [customMinInput, setCustomMinInput] = useState('');
    const [marketIndices, setMarketIndices] = useState(null);
    const [marketIndicesLoading, setMarketIndicesLoading] = useState(false);
    const [downloading, setDownloading] = useState(null);
    const [suggestions, setSuggestions] = useState([]);
    const [extraEtfInput, setExtraEtfInput] = useState('');
    const [extraEtfs, setExtraEtfs] = useState(() => {
        try { return JSON.parse(localStorage.getItem('heatmap_extra_etfs') || '[]'); }
        catch { return []; }
    });
    const [extended, setExtended] = useState(false);
    const [showUnavailableEtfs, setShowUnavailableEtfs] = useState(false);
    const [sectorFilter, setSectorFilter] = useState(null);
    const heatmapRequestRef = useRef(0);

    useEffect(() => {
        const iv = resolveInterval(period);
        const params = iv ? `period=1d&interval=${iv}` : `period=${period}`;
        const cacheKey = `indices:${params}`;
        const cached = heatmapCacheStore[cacheKey];
        if (cached && Date.now() - cached.ts < HEATMAP_CACHE_TTL) {
            setMarketIndices(cached.data);
            return;
        }
        setMarketIndicesLoading(true);
        axios.get(`${INTELLIGENCE_SERVICE}/market-overview?${params}`).then(r => {
            const indices = normalizeIndices(r.data.indices);
            setMarketIndices(indices);
            heatmapCacheStore[cacheKey] = { ts: Date.now(), data: indices };
        }).catch(() => {}).finally(() => setMarketIndicesLoading(false));
    }, [period]);

    useEffect(() => {
        localStorage.setItem('heatmap_groups', JSON.stringify(customGroups));
    }, [customGroups]);

    useEffect(() => {
        localStorage.setItem('heatmap_extra_etfs', JSON.stringify(extraEtfs));
    }, [extraEtfs]);

    useEffect(() => {
        if (mode === 'stocks') {
            axios.get(`${DATA_SERVICE}/watch`).then(res => {
                const data = res.data;
                if (data.categories?.length) {
                    setCategories(data.categories);
                    const all = data.watched_tickers || [];
                    const customGrpTickers = customGroups.flatMap(g => g.tickers);
                    const merged = [...new Set([...all, ...customGrpTickers])];
                    if (merged.length > 0) {
                        setTickers(merged);
                        setActiveCategory(null);
                    }
                }
            }).catch(() => {});
        }
    }, [mode, customGroups.length]);

    const fetchHeatmap = async (force = false) => {
        const requestId = heatmapRequestRef.current + 1;
        heatmapRequestRef.current = requestId;
        const isCurrentRequest = () => heatmapRequestRef.current === requestId;
        const iv = resolveInterval(period);
        const params = iv ? `period=1d&interval=${iv}` : `period=${period}`;
        const ext = extended ? '&extended=true' : '';
        const cacheKey = `${mode}:${params}${ext}:${tickers.join(',')}`;
        const cached = heatmapCacheStore[cacheKey];

        if (!force && cached && Date.now() - cached.ts < HEATMAP_CACHE_TTL) {
            setSectors(cached.sectors);
            setCustomSectors(cached.customSectors);
            setHeatmapProgress(null);
            return;
        }

        setLoading(true);
        setHeatmapProgress(mode === 'stocks' ? { completed: 0, total: tickers.length, label: 'Fetching stocks' } : { completed: 0, total: null, label: 'Fetching market groups' });
        try {
            let newSectors = null, newCustomSectors = null;
            if (mode === 'etfs') {
                const allCustomTickers = [...new Set([
                    ...customGroups.flatMap(g => g.tickers),
                    ...extraEtfs,
                ])];
                setSectors({});
                const batches = chunkArray(INDUSTRY_PROXY_TICKERS, ETF_QUOTE_BATCH_SIZE);
                let completed = 0;
                let cursor = 0;
                let accumulated = {};
                const fetchIndustryBatch = async (batch) => {
                    if (!isCurrentRequest()) return;
                    try {
                        const res = await axios.post(`${INTELLIGENCE_SERVICE}/batch-price-changes?${params}${ext}`, batch);
                        if (!isCurrentRequest()) return;
                        accumulated = mergeSectorData(accumulated, buildIndustryProxySectors(res.data.quotes || []));
                        setSectors(accumulated);
                    } catch (e) {
                        console.warn('Industry ETF quote batch failed', batch, e);
                    } finally {
                        if (!isCurrentRequest()) return;
                        completed += batch.length;
                        setHeatmapProgress({
                            completed: Math.min(completed, INDUSTRY_PROXY_TICKERS.length),
                            total: INDUSTRY_PROXY_TICKERS.length,
                            label: `Loaded ${Math.min(completed, INDUSTRY_PROXY_TICKERS.length)} of ${INDUSTRY_PROXY_TICKERS.length} ETF proxies`,
                        });
                    }
                };
                const industryPromise = Promise.all(Array.from({ length: Math.min(ETF_QUOTE_BATCH_CONCURRENCY, batches.length) }, async () => {
                    while (cursor < batches.length) {
                        const batch = batches[cursor];
                        cursor += 1;
                        await fetchIndustryBatch(batch);
                    }
                })).then(() => accumulated);
                const customPromise = allCustomTickers.length > 0
                    ? axios.post(`${INTELLIGENCE_SERVICE}/sector-heatmap?${params}${ext}`, allCustomTickers).then(cres => {
                        if (!isCurrentRequest()) return null;
                        newCustomSectors = cres.data.sectors;
                        setCustomSectors(newCustomSectors);
                        setHeatmapProgress(prev => ({ completed: prev?.completed || INDUSTRY_PROXY_TICKERS.length, total: prev?.total || INDUSTRY_PROXY_TICKERS.length, label: 'Loaded custom groups' }));
                        return newCustomSectors;
                    })
                    : Promise.resolve(null);
                const [industrySectors, customSectorData] = await Promise.all([industryPromise, customPromise]);
                newSectors = industrySectors || newSectors;
                newCustomSectors = customSectorData || newCustomSectors;
            } else {
                if (tickers.length === 0) return;
                setSectors({});
                setCustomSectors(null);
                const batches = chunkArray(tickers, STOCK_BATCH_SIZE);
                let completed = 0;
                let cursor = 0;
                let accumulated = {};
                const fetchBatch = async (batch) => {
                    if (!isCurrentRequest()) return;
                    try {
                        const res = await axios.post(`${INTELLIGENCE_SERVICE}/sector-heatmap?${params}${ext}`, batch);
                        if (!isCurrentRequest()) return;
                        accumulated = mergeSectorData(accumulated, res.data.sectors);
                        setSectors(accumulated);
                    } catch (e) {
                        console.warn('Heatmap batch failed', batch, e);
                    } finally {
                        if (!isCurrentRequest()) return;
                        completed += batch.length;
                        setHeatmapProgress({
                            completed: Math.min(completed, tickers.length),
                            total: tickers.length,
                            label: `Loaded ${Math.min(completed, tickers.length)} of ${tickers.length} stocks`,
                        });
                    }
                };
                const workers = Array.from({ length: Math.min(STOCK_BATCH_CONCURRENCY, batches.length) }, async () => {
                    while (cursor < batches.length) {
                        const batch = batches[cursor];
                        cursor += 1;
                        await fetchBatch(batch);
                    }
                });
                await Promise.all(workers);
                newSectors = accumulated;
            }
            if (!isCurrentRequest()) return;
            setSectors(newSectors);
            setCustomSectors(newCustomSectors);
            heatmapCacheStore[cacheKey] = { ts: Date.now(), sectors: newSectors, customSectors: newCustomSectors };
        } catch (e) {
            if (!isCurrentRequest()) return;
            notify('Failed to fetch sector data: ' + (e.response?.data?.detail || e.message), 'red');
        } finally {
            if (isCurrentRequest()) {
                setLoading(false);
                setHeatmapProgress(null);
            }
        }
    };

    useEffect(() => {
        fetchHeatmap();
    }, [mode, period, extended, tickers.join(',')]);

    const addTicker = () => {
        const t = tickerInput.trim().toUpperCase();
        if (!t || tickers.includes(t)) return;
        setTickers([...tickers, t]);
        setTickerInput('');
    };

    const addTickerToWatch = (t) => {
        if (!t || tickers.includes(t)) return;
        setTickers([...tickers, t]);
    };

    const removeTicker = (t) => setTickers(tickers.filter(x => x !== t));

    const downloadFile = async (t) => {
        if (!t || downloading) return;
        setDownloading(t);
        try {
            await axios.post(`${DATA_SERVICE}/download`, { tickers: [t.toUpperCase()], period: 'max', interval: '1d' });
            if (notify) notify(`Download started for ${t.toUpperCase()}`, 'blue');
        } catch {
            if (notify) notify(`Failed to download ${t}`, 'red');
        } finally {
            setDownloading(null);
        }
    };

    const formatValue = (v) => {
        if (v == null) return '-';
        if (Math.abs(v) >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
        if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
        if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
        return '$' + Number(v).toLocaleString();
    };

    const selectCategory = (catName) => {
        setActiveCategory(catName);
        if (catName === null) {
            const all = [];
            categories.forEach(c => all.push(...c.tickers));
            customGroups.forEach(g => all.push(...g.tickers));
            const unique = [...new Set(all)];
            setTickers(unique.length > 0 ? unique : DEFAULT_TICKERS);
        } else {
            const cat = categories.find(c => c.name === catName);
            if (cat) setTickers(cat.tickers);
            else {
                const grp = customGroups.find(g => g.name === catName);
                if (grp) setTickers(grp.tickers);
            }
        }
    };

    const flatItems = useMemo(() => {
        if (!sectors) return [];
        if (mode === 'etfs') {
            const map = {};
            for (const [sector, industries] of Object.entries(sectors)) {
                for (const [industry, entries] of Object.entries(industries)) {
                    const validEntries = entries.filter(e => hasChangeValue(e));
                    const sum = validEntries.reduce((a, e) => a + Number(e.change_percent), 0);
                    map[`${sector}::${industry}`] = {
                        key: `${sector}::${industry}`,
                        ticker: entries[0]?.ticker || industry,
                        name: industry,
                        sector,
                        industry,
                        change_percent: validEntries.length > 0 ? sum / validEntries.length : null,
                        market_cap: entries.reduce((a, e) => a + (e.market_cap || 0), 0),
                        price: entries[0]?.price,
                        count: entries.length,
                        validCount: validEntries.length,
                        etfs: entries.map(e => e.ticker).join(', '),
                        isCustom: false,
                    };
                }
            }
            const builtin = Object.values(map);
            if (customSectors && customGroups.length > 0) {
                const tickerMap = {};
                for (const entries of Object.values(customSectors)) {
                    for (const items of Object.values(entries)) {
                        for (const item of items) {
                            tickerMap[item.ticker] = item;
                        }
                    }
                }
                for (const group of customGroups) {
                    if (!group.tickers.length) continue;
                    let sum = 0, count = 0;
                    for (const t of group.tickers) {
                        const d = tickerMap[t];
                        if (d && hasChangeValue(d)) { sum += Number(d.change_percent); count++; }
                    }
                    const avg = count > 0 ? sum / count : null;
                    builtin.push({
                        key: `custom::${group.name}`,
                        ticker: group.name,
                        name: group.name,
                        sector: 'Custom',
                        industry: group.name,
                        change_percent: avg,
                        market_cap: null,
                        count: group.tickers.length,
                        validCount: count,
                        etfs: group.tickers.join(', '),
                        isCustom: true,
                    });
                }
            }
            // Add individual extra ETFs as separate tiles
            if (customSectors && extraEtfs.length > 0) {
                const allEntries = [];
                for (const entries of Object.values(customSectors)) {
                    for (const items of Object.values(entries)) {
                        allEntries.push(...items);
                    }
                }
                for (const etf of extraEtfs) {
                    const found = allEntries.find(e => e.ticker === etf);
                    if (found) {
                        builtin.push({
                            key: `extra::${etf}`,
                            ticker: etf,
                            name: found.name || etf,
                            sector: 'Extra',
                            industry: etf,
                            change_percent: found.change_percent,
                            market_cap: found.market_cap,
                            price: found.price,
                            count: 1,
                            validCount: hasChangeValue(found) ? 1 : 0,
                            isExtra: true,
                            isCustom: false,
                        });
                    } else {
                        builtin.push({
                            key: `extra::${etf}`,
                            ticker: etf,
                            name: etf,
                            sector: 'Extra',
                            industry: etf,
                            change_percent: null,
                            market_cap: null,
                            count: 1,
                            validCount: 0,
                            isExtra: true,
                            isCustom: false,
                        });
                    }
                }
            }
            return builtin;
        }
        const items = [];
        for (const [sector, industries] of Object.entries(sectors)) {
            for (const [industry, entries] of Object.entries(industries)) {
                for (const e of entries) {
                    items.push({ ...e, sector, industry, isCustom: false });
                }
            }
        }
        // Add custom groups as tiles in stocks mode
        if (customGroups.length > 0) {
            const tickerMap = {};
            for (const item of items) {
                tickerMap[item.ticker] = item;
            }
            for (const group of customGroups) {
                if (!group.tickers.length) continue;
                let sum = 0, count = 0;
                const groupItems = [];
                for (const t of group.tickers) {
                    const d = tickerMap[t];
                    if (d && hasChangeValue(d)) { sum += Number(d.change_percent); count++; }
                    if (d) groupItems.push(d);
                }
                const avg = count > 0 ? sum / count : null;
                items.push({
                    key: `custom::${group.name}`,
                    ticker: group.name,
                    name: group.name,
                    sector: 'Custom',
                    industry: group.name,
                    change_percent: avg,
                    market_cap: groupItems.reduce((a, d) => a + (d.market_cap || 0), 0),
                    count: group.tickers.length,
                    isCustom: true,
                    isGroup: true,
                });
            }
        }
        return items;
    }, [sectors, mode, customSectors, customGroups]);

    const unavailableItems = useMemo(() => {
        if (mode !== 'etfs') return [];
        return flatItems.filter(item => !hasChangeValue(item));
    }, [flatItems, mode]);

    const sortedItems = useMemo(() => {
        let visible = mode === 'etfs' && !showUnavailableEtfs
            ? flatItems.filter(item => hasChangeValue(item))
            : flatItems;
        if (sectorFilter && sectorFilter.length > 0) {
            visible = visible.filter(item => sectorFilter.includes(item.sector));
        }
        return [...visible].sort((a, b) => {
            const aHas = hasChangeValue(a);
            const bHas = hasChangeValue(b);
            if (aHas !== bHas) return aHas ? -1 : 1;
            const aVal = aHas ? Number(a.change_percent) : 0;
            const bVal = bHas ? Number(b.change_percent) : 0;
            return sortAsc ? aVal - bVal : bVal - aVal;
        });
    }, [flatItems, sortAsc, mode, showUnavailableEtfs, sectorFilter]);

    const searchResults = useMemo(() => {
        if (!searchQuery) return sortedItems;
        const q = searchQuery.toLowerCase();
        return sortedItems.filter(s =>
            (s.ticker || '').toLowerCase().includes(q) ||
            (s.industry || '').toLowerCase().includes(q) ||
            (s.sector || '').toLowerCase().includes(q) ||
            (s.name || '').toLowerCase().includes(q) ||
            (s.etfs || '').toLowerCase().includes(q)
        );
    }, [sortedItems, searchQuery]);

    const sortedSectors = useMemo(() => {
        const map = {};
        for (const item of flatItems) {
            if (mode === 'etfs' && !showUnavailableEtfs && !hasChangeValue(item)) continue;
            if (!map[item.sector]) map[item.sector] = { items: [], sum: 0, count: 0 };
            map[item.sector].items.push(item);
            if (hasChangeValue(item)) { map[item.sector].sum += Number(item.change_percent); map[item.sector].count++; }
        }
        return Object.entries(map)
            .map(([name, d]) => ({ name, items: d.items, avg: d.count > 0 ? d.sum / d.count : 0 }))
            .sort((a, b) => b.avg - a.avg);
    }, [flatItems, mode, showUnavailableEtfs]);

    const handleModeChange = (newMode) => {
        if (newMode === mode) return;
        setMode(newMode);
        setSectors(null);
        setSortAsc(false);
        setSectorFilter(null);
    };

    const explainHeatmap = () => {
        const leaders = sortedItems.slice(0, 5).map(item => `${item.name || item.industry || item.ticker} (${item.ticker || item.etfs || 'proxy'} ${formatPct(item.change_percent)})`).join(', ');
        const laggards = [...sortedItems].reverse().slice(0, 5).map(item => `${item.name || item.industry || item.ticker} (${item.ticker || item.etfs || 'proxy'} ${formatPct(item.change_percent)})`).join(', ');
        const unavailable = unavailableItems.length ? ` ${unavailableItems.length} ETF proxies are unavailable and hidden by default.` : '';
        const prompt = `Explain why the Market Overview heatmap looks like this for timeframe ${PERIOD_LABEL[period] || period}${extended ? ' including extended hours' : ''}. Use the current market overview, industry/sector heatmap, and fresh news/web search to explain likely catalysts. Focus on strongest ETF proxy groups: ${leaders || 'none loaded yet'}. Weakest groups: ${laggards || 'none loaded yet'}.${unavailable} Mention if data looks stale or incomplete. Keep it concise but useful.`;
        onExplain?.(prompt, 'Explaining market heatmap');
    };

    const saveGroup = (group) => {
        if (editingGroup !== null) {
            const updated = [...customGroups];
            updated[editingGroup] = group;
            setCustomGroups(updated);
            setEditingGroup(null);
        } else {
            setCustomGroups([...customGroups, group]);
        }
        setShowGroupEditor(false);
    };

    const deleteGroup = (idx) => {
        setCustomGroups(customGroups.filter((_, i) => i !== idx));
        if (editingGroup === idx) setEditingGroup(null);
    };

    const legendEntries = useMemo(() => {
        return [-3, -2, -1, 0, 1, 2, 3].map(v => ({ value: v, color: getTileColor(v) }));
    }, []);

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.1rem' }}>
                        <Layers size={20} color="var(--brand-purple)" /> Heatmap
                    </h2>
                    {flatItems.length > 0 && (
                        <span style={{ fontSize: '0.78rem', opacity: 0.5 }}>
                            {sortedItems.length} {mode === 'etfs' ? 'ETF proxies' : 'stocks'} · {sortedSectors.length} sectors
                        </span>
                    )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '0.7rem', opacity: 0.5 }}>
                        {legendEntries.map(l => (
                            <div key={l.value} style={{ width: '14px', height: '14px', borderRadius: '2px', background: l.color }} title={`${l.value >= 0 ? '+' : ''}${l.value}%`} />
                        ))}
                        <span style={{ marginLeft: '4px' }}>%</span>
                    </div>
                    <div className="btn-group" style={{ display: 'flex', gap: '2px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {PERIOD_OPTIONS.map(p => (
                            <button key={p} className={`btn btn-xs ${period === p ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPeriod(p)} style={{ fontSize: '0.7rem', padding: '0.2rem 0.35rem', textTransform: 'uppercase' }}>
                                {PERIOD_LABEL[p]}
                            </button>
                        ))}
                        {showCustomMin ? (
                            <input
                                className="input"
                                type="number"
                                min="1"
                                max="120"
                                placeholder="min"
                                value={customMinInput}
                                onChange={e => setCustomMinInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && customMinInput) {
                                        setPeriod(`${customMinInput}min`);
                                        setShowCustomMin(false);
                                        setCustomMinInput('');
                                    }
                                    if (e.key === 'Escape') setShowCustomMin(false);
                                }}
                                onBlur={() => { setShowCustomMin(false); setCustomMinInput(''); }}
                                style={{ width: '48px', height: '24px', fontSize: '0.7rem', padding: '0 4px' }}
                                autoFocus
                            />
                        ) : (
                            <button className="btn btn-xs btn-ghost" onClick={() => setShowCustomMin(true)} style={{ fontSize: '0.7rem', padding: '0.2rem 0.35rem', opacity: 0.5 }} title="Custom interval">
                                +
                            </button>
                        )}
                        {period && period.match(/^\d+min$/) && !INTRADAY_INTERVAL[period] && (
                            <span style={{ fontSize: '0.65rem', opacity: 0.5, marginLeft: '2px' }}>{period}</span>
                        )}
                        {extended && (
                            <span style={{ fontSize: '0.6rem', background: 'var(--bg-accent)', color: 'var(--accent)', padding: '0.1rem 0.3rem', borderRadius: '3px', whiteSpace: 'nowrap' }}>Extended hour</span>
                        )}
                    </div>
                    <button className="btn btn-xs btn-ghost" onClick={() => setSortAsc(!sortAsc)} title={sortAsc ? 'Sorted ascending' : 'Sorted descending'} style={{ fontSize: '0.7rem', padding: '0.25rem 0.4rem' }}>
                        <ArrowUpDown size={12} style={{ marginRight: '2px' }} />
                        {sortAsc ? 'Low' : 'High'}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={explainHeatmap} title="Ask assistant to explain this heatmap with news">
                        <MessageCircleQuestion size={13} /> Explain
                    </button>
                    {mode === 'etfs' && unavailableItems.length > 0 && (
                        <button
                            className={`btn btn-xs ${showUnavailableEtfs ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => setShowUnavailableEtfs(v => !v)}
                            title={showUnavailableEtfs ? 'Hide ETF proxies without price movement data' : 'Show ETF proxies without price movement data'}
                            style={{ fontSize: '0.7rem', padding: '0.25rem 0.4rem' }}
                        >
                            {showUnavailableEtfs ? 'Hide' : 'Show'} {unavailableItems.length} unavailable
                        </button>
                    )}
                    <div className="btn-group" style={{ display: 'flex', gap: '0.25rem' }}>
                        <button className={`btn btn-sm ${mode === 'etfs' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleModeChange('etfs')}>
                            <BarChart3 size={13} /> Industries
                        </button>
                        <button className={`btn btn-sm ${mode === 'stocks' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => handleModeChange('stocks')}>
                            <Activity size={13} /> Stocks
                        </button>
                    </div>
                    <button
                        className={`btn btn-sm ${extended ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => setExtended(e => !e)}
                        title={extended ? 'Extended hours on' : 'Extended hours off'}
                        style={{ fontSize: '0.7rem', padding: '0.25rem 0.4rem' }}
                    >Ext</button>
                    <button className="btn btn-sm btn-ghost" onClick={fetchHeatmap} disabled={loading}>
                        <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>

            {mode === 'etfs' && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.75rem', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.65rem', opacity: 0.4, marginRight: '0.2rem' }}>Filter:</span>
                    <button
                        className={`btn btn-xs ${!sectorFilter || sectorFilter.length === 0 ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => setSectorFilter(null)}
                        style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem' }}
                    >All</button>
                    {[...new Set(flatItems.map(i => i.sector).filter(Boolean))].sort().map(sector => {
                        const active = sectorFilter?.includes(sector);
                        return (
                            <button
                                key={sector}
                                className={`btn btn-xs ${active ? 'btn-primary' : 'btn-ghost'}`}
                                onClick={() => {
                                    if (active) {
                                        const next = sectorFilter.filter(s => s !== sector);
                                        setSectorFilter(next.length > 0 ? next : null);
                                    } else {
                                        setSectorFilter([...(sectorFilter || []), sector]);
                                    }
                                }}
                                style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem' }}
                            >{sector}</button>
                        );
                    })}
                </div>
            )}

            {mode === 'stocks' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
                    <div style={{ position: 'relative', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                        <input
                            className="input"
                            style={{ flex: 1, fontSize: '0.82rem', padding: '0.4rem 0.75rem' }}
                            placeholder="Search ticker or company..."
                            value={tickerInput}
                            onChange={e => {
                                setTickerInput(e.target.value.toUpperCase());
                                if (e.target.value.length >= 1) {
                                    axios.get(`${INTELLIGENCE_SERVICE}/search?q=${encodeURIComponent(e.target.value)}`)
                                        .then(r => setSuggestions(r.data.results || [])).catch(() => setSuggestions([]));
                                } else { setSuggestions([]); }
                            }}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && tickerInput) {
                                    setIntelTicker(tickerInput);
                                    setTickerInput('');
                                    setSuggestions([]);
                                }
                            }}
                        />
                        <span title="Add to watchlist" onClick={() => { addTickerToWatch(tickerInput); setTickerInput(''); setSuggestions([]); }}
                            style={{ fontSize: '1.1rem', lineHeight: 1, cursor: 'pointer', opacity: 0.4, padding: '0 0.2rem' }}
                            onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                            onMouseLeave={e => e.currentTarget.style.opacity = '0.4'}>+</span>
                        <span title="Download data" onClick={() => { downloadFile(tickerInput); }}
                            style={{ fontSize: '0.7rem', lineHeight: 1, cursor: downloading ? 'wait' : 'pointer', opacity: downloading ? 0.7 : 0.4, padding: '0 0.2rem' }}
                            onMouseEnter={e => { if (!downloading) e.currentTarget.style.opacity = '1'; }}
                            onMouseLeave={e => { if (!downloading) e.currentTarget.style.opacity = '0.4'; }}>{downloading ? '...' : '↓'}</span>
                        {suggestions.length > 0 && (
                            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden', boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
                                {suggestions.map((s, i) => (
                                    <div key={s.symbol} style={{ fontSize: '0.75rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: i < suggestions.length - 1 ? '1px solid var(--border-subtle)' : 'none', background: 'var(--bg-card)' }}
                                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-accent)'}
                                        onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-card)'}>
                                        <div style={{ flex: 1, display: 'flex', gap: '0.5rem', alignItems: 'center', minWidth: 0 }}
                                            onMouseDown={() => { setIntelTicker(s.symbol); setTickerInput(''); setSuggestions([]); }}>
                                            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                                            <span style={{ opacity: 0.5, whiteSpace: 'nowrap', fontSize: '0.7rem' }}>{s.symbol}</span>
                                        </div>
                                        <span title="Add to watchlist" style={{ opacity: 0.4, cursor: 'pointer', padding: '0 0.2rem', whiteSpace: 'nowrap', fontSize: '0.7rem' }}
                                            onMouseDown={e => { e.stopPropagation(); addTickerToWatch(s.symbol); setTickerInput(''); setSuggestions([]); }}
                                            onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                            onMouseLeave={e => e.currentTarget.style.opacity = '0.4'}>+ Watch</span>
                                        <span title="Download data" style={{ opacity: 0.4, cursor: 'pointer', padding: '0 0.2rem', whiteSpace: 'nowrap', fontSize: '0.7rem' }}
                                            onMouseDown={e => { e.stopPropagation(); downloadFile(s.symbol); setTickerInput(''); setSuggestions([]); }}
                                            onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                            onMouseLeave={e => e.currentTarget.style.opacity = '0.4'}>↓ Data</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', alignItems: 'center', position: 'relative' }}>
                        {tickers.map(t => (
                            <span key={t} style={{ fontSize: '0.7rem', background: 'var(--bg-accent)', padding: '0.15rem 0.4rem', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.2rem' }}
                                onClick={() => setIntelTicker(t)}>
                                {t}
                                <X size={10} style={{ opacity: 0.4, cursor: 'pointer' }} onClick={e => { e.stopPropagation(); removeTicker(t); }} />
                            </span>
                        ))}
                        <button className="btn btn-xs btn-ghost" onClick={() => setShowGroupEditor(true)} style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', opacity: 0.6 }}>
                            <Edit3 size={10} /> Groups
                        </button>
                        {customGroups.length > 0 && (
                            <>
                                <span style={{ fontSize: '0.65rem', opacity: 0.3, margin: '0 0.15rem' }}>|</span>
                                <button
                                    className={`btn btn-xs ${!activeCategory ? 'btn-primary' : 'btn-ghost'}`}
                                    onClick={() => selectCategory(null)}
                                    style={{ fontSize: '0.65rem', padding: '0.15rem 0.35rem' }}
                                >All</button>
                                {customGroups.map(g => (
                                    <button
                                        key={g.name}
                                        className={`btn btn-xs ${activeCategory === g.name ? 'btn-primary' : 'btn-ghost'}`}
                                        onClick={() => selectCategory(activeCategory === g.name ? null : g.name)}
                                        style={{ fontSize: '0.65rem', padding: '0.15rem 0.35rem' }}
                                    >{g.name}</button>
                                ))}
                            </>
                        )}
                    </div>
                    {activeCategory && (
                        <div className="panel" style={{ padding: '0.75rem 1rem', cursor: 'pointer' }} onClick={() => {
                            const grp = customGroups.find(g => g.name === activeCategory);
                            if (grp) setSelectedDetail({ ticker: grp.name, name: grp.name, isGroup: true, tickers: grp.tickers });
                        }}>
                            <div style={{ fontSize: '0.72rem', opacity: 0.5 }}>Active Category</div>
                            <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{activeCategory}</div>
                        </div>
                    )}
                </div>
            )}

            {Array.isArray(marketIndices) && marketIndices.length > 0 && (
                <div className="panel" style={{ marginBottom: '1rem', padding: '1rem 1.25rem', position: 'relative', display: 'flex', gap: '1.2rem', flexWrap: 'wrap', fontSize: '0.78rem' }}>
                    {marketIndicesLoading && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', borderRadius: 'inherit', opacity: 0.7, zIndex: 2 }}>
                            <RefreshCw size={18} className="animate-spin" />
                        </div>
                    )}
                    {marketIndices.map((idx, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{ fontWeight: 600 }}>{idx.name || idx.symbol}</span>
                            <span style={{ color: (idx.change || 0) >= 0 ? '#4ade80' : '#f87171' }}>
                                {idx.change == null || !Number.isFinite(Number(idx.change)) ? '-' : `${idx.change >= 0 ? '+' : ''}${Number(idx.change).toFixed(2)}`}
                            </span>
                            <span style={{ opacity: 0.6, fontSize: '0.7rem' }}>
                                {formatPct(idx.change_percent)}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {loading && !sectors && (
                <div className="panel" style={{ padding: '4rem', textAlign: 'center' }}>
                    <div className="spinner" />
                    <p style={{ fontSize: '0.9rem', opacity: 0.6 }}>{heatmapProgress?.label || 'Loading market data...'}</p>
                </div>
            )}
            {loading && sectors && (
                <div className="panel" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <RefreshCw size={14} className="animate-spin" />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700 }}>{heatmapProgress?.label || 'Updating market data...'}</div>
                        {heatmapProgress?.total && (
                            <div style={{ height: '5px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden', marginTop: '0.4rem' }}>
                                <div
                                    style={{
                                        height: '100%',
                                        width: `${Math.min(100, Math.round((heatmapProgress.completed / heatmapProgress.total) * 100))}%`,
                                        background: 'var(--brand-blue)',
                                        transition: 'width 0.2s ease',
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {!loading && sectors && sortedItems.length === 0 && (
                <div className="panel" style={{ padding: '4rem', textAlign: 'center', opacity: 0.5 }}>
                    <Layers size={48} style={{ margin: '0 auto 1rem' }} />
                    <p>{mode === 'etfs' && unavailableItems.length > 0 ? 'No ETF proxies have movement data for this timeframe' : 'No sector data available'}</p>
                </div>
            )}

            {searchQuery && searchResults.length === 0 && (
                <div className="panel" style={{ padding: '2rem', textAlign: 'center', opacity: 0.5 }}>
                    <p style={{ fontSize: '0.85rem' }}>No results for "{searchQuery}"</p>
                </div>
            )}

            {sectors && sortedItems.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', borderRadius: '8px', overflow: 'hidden' }}>
                    {searchResults.map(s => {
                        const ratio = getTileSize(s.change_percent);
                        const sectorColor = s.isCustom ? CUSTOM_COLOR : (SECTOR_PALETTE[s.sector] || '#444');
                        const isHovered = hovered === s.key || hovered === s.ticker;
                        const label = mode === 'etfs' ? s.industry : s.ticker;
                        const proxyLabel = mode === 'etfs' ? (s.isCustom ? 'Custom' : (s.etfs || s.ticker)) : null;
                        return (
                            <div
                                key={s.key || s.ticker}
                                onMouseEnter={() => setHovered(s.key || s.ticker)}
                                onMouseLeave={() => setHovered(null)}
                                onClick={() => mode === 'stocks' && !s.isGroup ? setIntelTicker(s.ticker) : setSelectedDetail(s)}
                                style={{
                                    flex: `${ratio} 1 ${Math.max(85, ratio * 50)}px`,
                                    minWidth: '85px',
                                    padding: `${Math.max(8, 6 + ratio * 5)}px 10px`,
                                    paddingLeft: '12px',
                                    background: getTileColor(s.change_percent),
                                    cursor: 'pointer',
                                    transition: 'all 0.12s ease',
                                    opacity: hovered && !isHovered ? 0.45 : 1,
                                    filter: isHovered ? 'brightness(1.3) contrast(1.1)' : 'none',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    minHeight: `${Math.min(95, Math.max(58, 40 + ratio * 20))}px`,
                                    border: isHovered ? '1px solid rgba(255,255,255,0.35)' : '1px solid transparent',
                                    borderRadius: '2px',
                                    boxSizing: 'border-box',
                                    position: 'relative',
                                    boxShadow: isHovered ? `inset 0 0 0 2px ${sectorColor}` : 'none',
                                }}
                            >
                                <div style={{
                                    position: 'absolute', left: '2px', top: '2px', bottom: '2px',
                                    width: '3px', borderRadius: '2px', background: sectorColor,
                                    opacity: isHovered ? 1 : 0.7, transition: 'opacity 0.12s',
                                }} />
                                {s.isCustom && (
                                    <div style={{ position: 'absolute', top: '2px', right: '3px', fontSize: '0.5rem', opacity: 0.5 }}>✎</div>
                                )}
                                <div style={{ fontWeight: 700, fontSize: '0.78rem', letterSpacing: '0.01em', textShadow: '0 1px 3px rgba(0,0,0,0.4)', textAlign: 'center', lineHeight: 1.2 }}>
                                    {label}
                                </div>
                                {proxyLabel && (
                                    <div style={{ fontSize: '0.58rem', fontWeight: 700, opacity: 0.72, marginTop: '2px', textTransform: 'uppercase', textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
                                        {proxyLabel}
                                    </div>
                                )}
                                <div style={{ fontSize: '0.75rem', fontWeight: 600, opacity: 0.9, marginTop: '2px', textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
                                    {formatPct(s.change_percent)}
                                </div>
                                {isHovered && (
                                    <div style={{ fontSize: '0.6rem', opacity: 0.8, marginTop: '2px', textAlign: 'center', textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
                                        <div>{s.isCustom ? 'Custom Group' : s.sector}</div>
                                        {mode === 'etfs' ? (
                                            <div>{s.validCount || 0}/{s.count} {s.isCustom ? 'tickers' : 'ETF proxies'} with data · {s.etfs || s.ticker}</div>
                                        ) : (
                                            <div>{s.price != null ? '$' + s.price : '-'} · {formatValue(s.market_cap)}</div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {selectedDetail && (
                <DetailPanel
                    key={selectedDetail.key || selectedDetail.ticker}
                    item={selectedDetail}
                    mode={mode}
                    sectors={sectors}
                    customSectors={customSectors}
                    customGroups={customGroups}
                    formatValue={formatValue}
                    getTileColor={getTileColor}
                    period={period}
                    extended={extended}
                    onIntelTicker={t => setIntelTicker(t)}
                    onClose={() => setSelectedDetail(null)}
                />
            )}

            {intelTicker && (
                <IntelPanel
                    key={intelTicker}
                    ticker={intelTicker}
                    onBacktestTicker={onBacktestTicker}
                    onExplain={onExplain}
                    onClose={() => setIntelTicker(null)}
                    notify={notify}
                />
            )}

            {showGroupEditor && (
                <GroupEditor
                    groups={customGroups}
                    editingIndex={editingGroup}
                    onEdit={setEditingGroup}
                    onSave={saveGroup}
                    onDelete={deleteGroup}
                    onCancel={() => { setShowGroupEditor(false); setEditingGroup(null); }}
                />
            )}

        </motion.div>
    );
};

const GroupEditor = ({ groups, editingIndex, onEdit, onSave, onDelete, onCancel }) => {
    const [name, setName] = useState('');
    const [tickerInput, setTickerInput] = useState('');
    const [groupTickers, setGroupTickers] = useState([]);

    useEffect(() => {
        if (editingIndex !== null && groups[editingIndex]) {
            setName(groups[editingIndex].name);
            setGroupTickers([...groups[editingIndex].tickers]);
        } else {
            setName('');
            setGroupTickers([]);
        }
    }, [editingIndex]);

    const addTicker = () => {
        const t = tickerInput.trim().toUpperCase();
        if (!t || groupTickers.includes(t)) return;
        setGroupTickers([...groupTickers, t]);
        setTickerInput('');
    };

    const removeTicker = (t) => setGroupTickers(groupTickers.filter(x => x !== t));

    const handleSave = () => {
        if (!name.trim() || !groupTickers.length) return;
        onSave({ name: name.trim(), tickers: groupTickers });
    };

    return (
        <div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                <input className="input" style={{ width: '160px', height: '30px', fontSize: '0.78rem' }} placeholder="Group name..." value={name} onChange={e => setName(e.target.value)} />
                <input className="input" style={{ width: '100px', height: '30px', fontSize: '0.78rem' }} placeholder="Ticker..." value={tickerInput} onChange={e => setTickerInput(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && addTicker()} />
                <button className="btn btn-xs btn-ghost" onClick={addTicker} style={{ fontSize: '0.72rem', padding: '0.25rem 0.5rem' }}>
                    <Plus size={12} /> Add
                </button>
            </div>
            <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                {groupTickers.map(t => (
                    <span key={t} className="badge" style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', padding: '0.15rem 0.4rem', fontSize: '0.7rem', background: 'rgba(244,114,182,0.15)', color: CUSTOM_COLOR, border: `1px solid rgba(244,114,182,0.3)` }}>
                        {t}
                        <X size={8} style={{ cursor: 'pointer', opacity: 0.6 }} onClick={() => removeTicker(t)} />
                    </span>
                ))}
            </div>
            {groups.length > 0 && (
                <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem', paddingTop: '0.4rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <span style={{ fontSize: '0.68rem', opacity: 0.4, marginRight: '0.25rem', alignSelf: 'center' }}>Saved:</span>
                    {groups.map((g, i) => (
                        <button key={i} className={`btn btn-xs ${editingIndex === i ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onEdit(i)} style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem' }}>
                            {g.name} ({g.tickers.length})
                            <Trash2 size={9} style={{ marginLeft: '0.2rem', opacity: 0.4, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); onDelete(i); }} />
                        </button>
                    ))}
                </div>
            )}
            <div style={{ display: 'flex', gap: '0.35rem' }}>
                <button className="btn btn-xs btn-primary" onClick={handleSave} disabled={!name.trim() || !groupTickers.length} style={{ fontSize: '0.72rem' }}>
                    <Save size={11} /> {editingIndex !== null ? 'Update' : 'Save Group'}
                </button>
                <button className="btn btn-xs btn-ghost" onClick={onCancel} style={{ fontSize: '0.72rem' }}>Done</button>
            </div>
        </div>
    );
};

const DetailPanel = ({ item, mode, sectors, customSectors, customGroups, formatValue, getTileColor, period, extended, onIntelTicker, onClose }) => {
    const entries = useMemo(() => {
        if (!sectors) return [];
        const result = [];
        if (mode === 'etfs' && !item.isCustom) {
            for (const [sector, industries] of Object.entries(sectors)) {
                for (const [industry, list] of Object.entries(industries)) {
                    if (industry === item.industry && sector === item.sector) {
                        for (const e of list) {
                            result.push({ ...e, sector, industry });
                        }
                    }
                }
            }
        } else if (mode === 'etfs' && item.isCustom && customSectors) {
            const tickers = item.etfs.split(', ');
            const tickerMap = {};
            for (const entries of Object.values(customSectors)) {
                for (const items of Object.values(entries)) {
                    for (const e of items) {
                        tickerMap[e.ticker] = e;
                    }
                }
            }
            for (const t of tickers) {
                const found = tickerMap[t];
                if (found) result.push({ ...found, ticker: t });
            }
        }
        return result;
    }, [item, sectors, mode, customSectors]);

    const groupEntries = useMemo(() => {
        if (!(mode === 'stocks' && item.isGroup) || !sectors) return [];
        const tickerMap = {};
        for (const [sector, industries] of Object.entries(sectors)) {
            for (const [industry, list] of Object.entries(industries)) {
                for (const e of list) {
                    tickerMap[e.ticker] = { ...e, sector, industry };
                }
            }
        }
        if (customSectors) {
            for (const entries of Object.values(customSectors)) {
                for (const items of Object.values(entries)) {
                    for (const e of items) {
                        if (!tickerMap[e.ticker]) tickerMap[e.ticker] = { ...e };
                    }
                }
            }
        }
        return (item.tickers || []).map(t => tickerMap[t] || { ticker: t }).filter(Boolean);
    }, [mode, item, sectors, customSectors]);

    const [holdings, setHoldings] = useState(null);
    const [expanded, setExpanded] = useState({});
    const [holdingsSortAsc, setHoldingsSortAsc] = useState(false);
    const [news, setNews] = useState([]);
    const [newsLoading, setNewsLoading] = useState(false);
    const [subTab, setSubTab] = useState('etfs');
    const [insiderTrades, setInsiderTrades] = useState([]);
    const [insiderLoading, setInsiderLoading] = useState(false);
    const [insiderPage, setInsiderPage] = useState(0);
    const [insiderTotal, setInsiderTotal] = useState(0);
    const [insiderSearch, setInsiderSearch] = useState('');
    const [insiderTypeFilter, setInsiderTypeFilter] = useState('all');
    const insiderFetchParams = useRef({});
    const insiderPageSize = 30;

    const filteredInsiderTrades = useMemo(() => {
        let result = insiderTrades;
        if (insiderSearch) {
            const q = insiderSearch.toLowerCase();
            result = result.filter(t =>
                (t.ticker || '').toLowerCase().includes(q) ||
                (t.insider || '').toLowerCase().includes(q)
            );
        }
        if (insiderTypeFilter !== 'all') {
            result = result.filter(t => t.transaction_type === insiderTypeFilter);
        }
        return result;
    }, [insiderTrades, insiderSearch, insiderTypeFilter]);
    const toggleExpand = (ticker) => setExpanded(prev => ({ ...prev, [ticker]: !prev[ticker] }));

    const componentTickers = useMemo(() => {
        if (!holdings) return [];
        const seen = new Set();
        const tickers = [];
        for (const hList of Object.values(holdings)) {
            for (const h of hList) {
                if (!seen.has(h.ticker)) {
                    seen.add(h.ticker);
                    tickers.push(h.ticker);
                }
            }
        }
        return tickers;
    }, [holdings]);

    const insiderDaysBack = useMemo(() => {
        if (!period) return 90;
        const map = { '1d': 7, '5d': 7, '1mo': 30, '3mo': 30, '6mo': 90, '1y': 365, '2y': 365, '5y': 365, '10y': 365, 'ytd': 90, 'max': 365 };
        return map[period] || 90;
    }, [period]);

    useEffect(() => {
        const tickers = mode === 'etfs' ? entries.slice(0, 5).map(e => e.ticker) :
            (mode === 'stocks' && item.isGroup ? (item.tickers || []).slice(0, 5) : []);
        if (tickers.length > 0) {
            setNewsLoading(true);
            Promise.all(tickers.map(t =>
                axios.get(`${INTELLIGENCE_SERVICE}/news/${t}?limit=5`).then(r => r.data.news || []).catch(() => [])
            )).then(results => {
                const seen = new Set();
                const combined = results.flat().filter(a => {
                    const key = a.title;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                }).sort((a, b) => new Date(b.published) - new Date(a.published)).slice(0, 10);
                setNews(combined);
            }).finally(() => setNewsLoading(false));
        }
    }, [mode, entries, item.isGroup, item.tickers, period]);

    useEffect(() => {
        if (mode === 'etfs' && entries.length > 0) {
            const etfTickers = entries.map(e => e.ticker);
            const iv = resolveInterval(period);
            const params = iv ? `period=1d&interval=${iv}` : `period=${period}`;
            const ext = extended ? '&extended=true' : '';
            axios.post(`${INTELLIGENCE_SERVICE}/etf-holdings?${params}${ext}`, etfTickers)
                .then(res => setHoldings(res.data.holdings))
                .catch(() => {});
        }
    }, [mode, entries, period, extended]);

    const insiderTickerSource = useMemo(() => {
        if (mode === 'stocks' && item.isGroup) {
            return (item.tickers || []).filter(Boolean);
        }
        if (mode === 'etfs' && item.isCustom) {
            return entries.map(e => e.ticker).filter(Boolean);
        }
        return componentTickers;
    }, [mode, item.isCustom, item.isGroup, item.tickers, entries, componentTickers]);

    const fetchInsiderTrades = (page = 0) => {
        const tickers = insiderTickerSource.slice(0, 100);
        if (tickers.length === 0) return;
        setInsiderLoading(true);
        setInsiderPage(page);
        axios.post(`${INTELLIGENCE_SERVICE}/insider-trades`, {
            tickers,
            limit: insiderPageSize,
            offset: page * insiderPageSize,
            days_back: insiderDaysBack,
        }).then(res => {
            setInsiderTrades(res.data.trades || []);
            setInsiderTotal(res.data.total || 0);
        }).catch(() => {}).finally(() => setInsiderLoading(false));
    };

    useEffect(() => {
        if (subTab !== 'insider' || insiderTickerSource.length === 0) return;
        const params = { daysBack: insiderDaysBack, tickerCount: insiderTickerSource.length };
        const prev = insiderFetchParams.current;
        if (prev.daysBack === params.daysBack && prev.tickerCount === params.tickerCount && insiderTrades.length > 0) return;
        insiderFetchParams.current = params;
        fetchInsiderTrades(0);
    }, [subTab, insiderTickerSource, insiderDaysBack]);

    useEffect(() => {
        if (holdings) {
            const all = {};
            entries.forEach(e => { all[e.ticker] = true; });
            setExpanded(all);
        }
    }, [holdings]);

    const isEtfMode = mode === 'etfs';

    const subTabStyle = (tab) => ({
        padding: '0.4rem 1rem',
        fontSize: '0.78rem',
        fontWeight: 600,
        borderRadius: '6px',
        cursor: 'pointer',
        background: subTab === tab ? 'var(--brand-blue)' : 'var(--bg-accent)',
        color: subTab === tab ? 'white' : 'var(--text-secondary)',
        border: 'none',
        transition: 'all 0.15s ease',
    });

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="panel"
            style={{ marginTop: '1rem', padding: '1rem 1.25rem', position: 'relative' }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <h3 style={{ margin: 0, fontSize: '1rem' }}>{item.isGroup ? item.name : isEtfMode ? item.industry : item.ticker}</h3>
                        <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>{item.isGroup ? 'Custom Group' : item.sector}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '1rem', marginTop: '0.3rem', fontSize: '0.78rem' }}>
                        <span style={{ color: hasChangeValue(item) && Number(item.change_percent) < 0 ? '#f87171' : '#4ade80', fontWeight: 700 }}>
                            {formatPct(item.change_percent)}
                        </span>
                        {isEtfMode && (
                            <span style={{ opacity: 0.5 }}>{item.count || entries.length} {item.isCustom ? 'stock' : 'constituent'}{((item.count || entries.length) !== 1) ? 's' : ''}</span>
                        )}
                        {!isEtfMode && !item.isGroup && (
                            <>
                                <span style={{ opacity: 0.5 }}>${item.price != null ? item.price : '-'}</span>
                                <span style={{ opacity: 0.5 }}>{formatValue(item.market_cap)}</span>
                            </>
                        )}
                        {item.isGroup && (
                            <span style={{ opacity: 0.5 }}>{item.tickers?.length || 0} stocks</span>
                        )}
                    </div>
                </div>
                <button className="btn btn-xs btn-ghost" onClick={onClose} style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}>
                    <X size={14} />
                </button>
            </div>

            <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                {isEtfMode || item.isGroup ? (
                    <button onClick={() => setSubTab('etfs')} style={subTabStyle('etfs')}>{item.isGroup ? 'Stocks' : item.isCustom ? 'Stocks' : 'ETFs'}</button>
                ) : null}
                <button onClick={() => setSubTab('news')} style={subTabStyle('news')}>
                    News {news.length > 0 && <span style={{ opacity: 0.7 }}>({news.length})</span>}
                </button>
                {isEtfMode || item.isGroup ? (
                    <button onClick={() => setSubTab('insider')} style={subTabStyle('insider')}>
                        Insider Trades {insiderTickerSource.length > 0 && !insiderLoading && <span style={{ opacity: 0.7 }}>({insiderTrades.length})</span>}
                    </button>
                ) : null}
            </div>

            {subTab === 'etfs' && isEtfMode && entries.length > 0 && (
                <div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {entries.map(e => {
                            const isOpen = expanded[e.ticker];
                            const h = holdings?.[e.ticker];
                            return (
                                <div key={e.ticker} style={{
                                    background: getTileColor(e.change_percent),
                                    borderRadius: '4px',
                                    fontSize: '0.78rem',
                                    overflow: 'hidden',
                                }}>
                                    <div
                                        onClick={() => toggleExpand(e.ticker)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.5rem',
                                            padding: '0.5rem 0.75rem',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        <div style={{ opacity: 0.6, display: 'flex', alignItems: 'center' }}>
                                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                        </div>
                                        <div style={{ fontWeight: 700 }}>{e.ticker}</div>
                                        <div style={{ opacity: 0.6, flex: 1 }}>{e.name || '-'}</div>
                                        <div style={{ color: hasChangeValue(e) && Number(e.change_percent) < 0 ? '#f87171' : '#4ade80', fontWeight: 600 }}>
                                            {formatPct(e.change_percent)}
                                        </div>
                                        <div style={{ opacity: 0.5, fontSize: '0.7rem' }}>
                                            ${e.price != null ? e.price : '-'}
                                        </div>
                                        {h && <div style={{ fontSize: '0.65rem', opacity: 0.5 }}>{h.length} holdings</div>}
                                    </div>
                                    {isOpen && h && h.length > 0 && (
                                        <div style={{ padding: '0 0.5rem 0.5rem 2rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                            <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.65rem', opacity: 0.5, fontWeight: 600, padding: '0.25rem 0.5rem' }}>
                                                <div style={{ width: '80px' }}>Ticker</div>
                                                <div style={{ flex: 1 }}>Name</div>
                                                <div style={{ width: '45px', textAlign: 'right' }}>Wt%</div>
                                                <div style={{ width: '60px', textAlign: 'right', cursor: 'pointer' }} onClick={() => setHoldingsSortAsc(!holdingsSortAsc)}>
                                                    Change% {holdingsSortAsc ? '↑' : '↓'}
                                                </div>
                                                <div style={{ width: '60px', textAlign: 'right' }}>Price</div>
                                            </div>
                                            {[...h].sort((a, b) => {
                                                const aHas = hasChangeValue(a);
                                                const bHas = hasChangeValue(b);
                                                if (aHas !== bHas) return aHas ? -1 : 1;
                                                const diff = Number(b.change_percent) - Number(a.change_percent);
                                                return holdingsSortAsc ? -diff : diff;
                                            }).map(hd => (
                                                <div key={hd.ticker} onClick={() => onIntelTicker(hd.ticker)} style={{
                                                    display: 'flex',
                                                    gap: '0.5rem',
                                                    alignItems: 'center',
                                                    padding: '0.2rem 0.5rem',
                                                    borderRadius: '2px',
                                                    background: hd.change_percent != null ? getTileColor(hd.change_percent) : 'rgba(255,255,255,0.03)',
                                                    fontSize: '0.72rem',
                                                    cursor: 'pointer',
                                                }}>
                                                    <div style={{ width: '80px', fontWeight: 600 }}>{hd.ticker}</div>
                                                    <div style={{ flex: 1, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hd.name || '-'}</div>
                                                    <div style={{ width: '45px', textAlign: 'right', opacity: 0.7 }}>{hd.weight != null ? hd.weight.toFixed(1) : '-'}</div>
                                                    <div style={{ width: '60px', textAlign: 'right', color: hasChangeValue(hd) && Number(hd.change_percent) < 0 ? '#f87171' : '#4ade80', fontWeight: 600 }}>
                                                        {formatPct(hd.change_percent, 3)}
                                                    </div>
                                                    <div style={{ width: '60px', textAlign: 'right', opacity: 0.7 }}>
                                                        ${hd.price != null ? hd.price : '-'}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {isOpen && !h && (
                                        <div style={{ padding: '0.25rem 0.5rem 0.5rem 2rem', fontSize: '0.68rem', opacity: 0.4 }}>
                                            Loading holdings...
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {subTab === 'etfs' && item.isGroup && groupEntries.length > 0 && (
                <div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        {groupEntries.map(e => (
                            <div key={e.ticker} onClick={() => onIntelTicker(e.ticker)} style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                                padding: '0.4rem 0.75rem',
                                background: e.change_percent != null ? getTileColor(e.change_percent) : 'rgba(255,255,255,0.03)',
                                borderRadius: '4px',
                                fontSize: '0.78rem',
                                cursor: 'pointer',
                            }}>
                                <div style={{ fontWeight: 700, width: '70px' }}>{e.ticker}</div>
                                <div style={{ flex: 1, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name || '-'}</div>
                                <div style={{ color: hasChangeValue(e) && Number(e.change_percent) < 0 ? '#f87171' : '#4ade80', fontWeight: 600 }}>
                                    {formatPct(e.change_percent)}
                                </div>
                                <div style={{ opacity: 0.5 }}>${e.price != null ? e.price : '-'}</div>
                                <div style={{ opacity: 0.5, fontSize: '0.7rem' }}>{e.sector || ''}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {subTab === 'etfs' && !isEtfMode && !item.isGroup && (
                <div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.5rem' }}>
                        {[
                            { label: 'Price', value: item.price != null ? '$' + item.price : '-' },
                            { label: 'Change', value: item.change != null ? (item.change >= 0 ? '+' : '') + item.change : '-', color: (item.change || 0) >= 0 ? '#4ade80' : '#f87171' },
                            { label: 'Change %', value: formatPct(item.change_percent), color: hasChangeValue(item) && Number(item.change_percent) < 0 ? '#f87171' : '#4ade80' },
                            { label: 'Market Cap', value: formatValue(item.market_cap) },
                            { label: 'Sector', value: item.sector || '-' },
                            { label: 'Industry', value: item.industry || '-' },
                            { label: 'Volume', value: item.volume != null ? formatValue(item.volume) : '-' },
                        ].map(d => (
                            <div key={d.label} className="panel" style={{ padding: '0.5rem 0.75rem', margin: 0 }}>
                                <div style={{ fontSize: '0.65rem', opacity: 0.5, marginBottom: '0.2rem' }}>{d.label}</div>
                                <div style={{ fontWeight: 700, fontSize: '0.85rem', color: d.color || 'inherit' }}>{d.value}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {subTab === 'news' && (
                <div>
                    {newsLoading && (
                        <div style={{ padding: '1rem', textAlign: 'center', opacity: 0.5, fontSize: '0.78rem' }}>
                            <RefreshCw className="animate-spin" size={14} style={{ display: 'inline', marginRight: '0.4rem' }} />
                            Loading news...
                        </div>
                    )}
                    {!newsLoading && news.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            {news.map((a, i) => (
                                <a key={i} href={a.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                                    <div className="panel" style={{ padding: '0.5rem 0.75rem', margin: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                                        <div style={{ flex: 1, fontSize: '0.78rem' }}>{a.title}</div>
                                        <div style={{ fontSize: '0.65rem', opacity: 0.4, whiteSpace: 'nowrap' }}>{a.publisher || ''} · {timeAgo(a.published)}</div>
                                    </div>
                                </a>
                            ))}
                        </div>
                    )}
                    {!newsLoading && news.length === 0 && (
                        <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5, fontSize: '0.85rem' }}>
                            No recent news{isEtfMode ? ' for this industry' : ' for this group'}
                        </div>
                    )}
                </div>
            )}

            {subTab === 'insider' && isEtfMode && (
                <div>
                    {!item.isGroup && !item.isCustom && !holdings && (
                        <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5, fontSize: '0.85rem' }}>
                            Loading component stocks...
                        </div>
                    )}
                    {!item.isGroup && !item.isCustom && holdings && insiderTickerSource.length === 0 && (
                        <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5, fontSize: '0.85rem' }}>
                            No component stock data available
                        </div>
                    )}
                    {insiderLoading && (
                        <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5 }}>
                            <RefreshCw className="animate-spin" size={20} style={{ margin: '0 auto 0.5rem' }} />
                            <p style={{ fontSize: '0.85rem' }}>Loading insider trades...</p>
                        </div>
                    )}
                    {!insiderLoading && ((isEtfMode && !item.isCustom && holdings) || (item.isGroup)) && insiderTrades.length === 0 && (
                        <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5, fontSize: '0.85rem' }}>
                            No recent insider trades{isEtfMode ? ' for this industry' : ' for this group'}
                        </div>
                    )}
                    {!insiderLoading && insiderTrades.length > 0 && (
                        <div>
                            <div style={{ fontSize: '0.72rem', opacity: 0.5, marginBottom: '0.5rem', display: 'flex', justifyContent: 'space-between' }}>
                                <span>{insiderTickerSource.length} {item.isCustom ? 'stocks' : 'component stocks'} tracked · {insiderTotal > 0 ? `${insiderTotal} total trades` : ''}</span>
                            </div>
                            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                <input
                                    className="input"
                                    style={{ width: '180px', height: '26px', fontSize: '0.72rem' }}
                                    placeholder="Filter by ticker or insider..."
                                    value={insiderSearch}
                                    onChange={e => setInsiderSearch(e.target.value)}
                                />
                                {['all', 'Buy', 'Sell'].map(t => (
                                    <button
                                        key={t}
                                        className={`btn btn-xs ${insiderTypeFilter === t ? 'btn-primary' : 'btn-ghost'}`}
                                        onClick={() => setInsiderTypeFilter(t)}
                                        style={{ fontSize: '0.7rem', padding: '0.15rem 0.45rem' }}
                                    >
                                        {t === 'all' ? 'All' : t}
                                    </button>
                                ))}
                                {(insiderSearch || insiderTypeFilter !== 'all') && (
                                    <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>
                                        {filteredInsiderTrades.length} of {insiderTrades.length} shown
                                    </span>
                                )}
                            </div>
                            <div style={{ width: '100%', fontSize: '0.72rem' }}>
                                <table className="table" style={{ width: '100%', tableLayout: 'fixed', fontSize: '0.72rem' }}>
                                    <colgroup>
                                        <col style={{ width: '12%' }} />
                                        <col style={{ width: '7%' }} />
                                        <col style={{ width: '14%' }} />
                                        <col style={{ width: '10%' }} />
                                        <col style={{ width: '10%' }} />
                                        <col style={{ width: '10%' }} />
                                        <col style={{ width: '7%' }} />
                                        <col style={{ width: '8%' }} />
                                        <col style={{ width: '14%' }} />
                                        <col style={{ width: '4%' }} />
                                    </colgroup>
                                    <thead>
                                        <tr>
                                            <th>Date</th>
                                            <th>Tkr</th>
                                            <th>Insider</th>
                                            <th>Role</th>
                                            <th>Type</th>
                                            <th style={{ textAlign: 'right' }}>Shares</th>
                                            <th style={{ textAlign: 'right' }}>%</th>
                                            <th style={{ textAlign: 'right' }}>Price</th>
                                            <th style={{ textAlign: 'right' }}>Value</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredInsiderTrades.map((t, i) => (
                                            <tr key={i}>
                                                <td style={{ fontSize: '0.68rem' }}>{t.date || '-'}</td>
                                                <td style={{ fontWeight: 700, fontSize: '0.7rem' }}>{t.ticker}</td>
                                                <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.insider}>{t.insider || '-'}</td>
                                                <td style={{ fontSize: '0.65rem', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.position}>{t.position || '-'}</td>
                                                <td>
                                                    {t.transaction_type === 'Buy' ? (
                                                        <span className="badge badge-green" style={{ fontSize: '0.62rem', padding: '0.1rem 0.3rem', whiteSpace: 'nowrap' }}>Buy</span>
                                                    ) : t.transaction_type === 'Sell' ? (
                                                        <span className="badge badge-red" style={{ fontSize: '0.62rem', padding: '0.1rem 0.3rem', whiteSpace: 'nowrap' }}>Sell</span>
                                                    ) : (
                                                        <span className="badge badge-yellow" style={{ fontSize: '0.62rem', padding: '0.1rem 0.3rem', whiteSpace: 'nowrap' }}>{t.transaction_type || 'Other'}</span>
                                                    )}
                                                </td>
                                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '0.68rem' }}>{t.shares?.toLocaleString() || '-'}</td>
                                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '0.68rem', color: t.portfolio_pct != null ? (t.transaction_type === 'Sell' ? '#f87171' : '#4ade80') : 'inherit' }}>
                                                    {t.portfolio_pct != null ? t.portfolio_pct.toFixed(1) + '%' : '-'}
                                                </td>
                                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '0.68rem' }}>{t.price != null ? '$' + t.price.toFixed(2) : '-'}</td>
                                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: '0.68rem' }}>
                                                    {t.value != null ? '$' + (Math.abs(t.value) >= 1e6 ? (t.value / 1e6).toFixed(2) + 'M' : Math.abs(t.value) >= 1e3 ? (t.value / 1e3).toFixed(1) + 'K' : Number(t.value).toLocaleString()) : '-'}
                                                </td>
                                                <td style={{ textAlign: 'center', fontSize: '0.65rem' }}>
                                                    {t.url ? (
                                                        <a href={t.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-blue)' }}>
                                                            <ExternalLink size={10} />
                                                        </a>
                                                    ) : ''}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {insiderTotal > insiderPageSize && (
                                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', fontSize: '0.78rem' }}>
                                    <button className="btn btn-xs btn-ghost" disabled={insiderPage === 0} onClick={() => fetchInsiderTrades(0)} title="First">&laquo;</button>
                                    <button className="btn btn-xs btn-ghost" disabled={insiderPage === 0} onClick={() => fetchInsiderTrades(insiderPage - 1)} title="Previous">&lsaquo;</button>
                                    <span style={{ opacity: 0.6 }}>Page {insiderPage + 1} of {Math.ceil(insiderTotal / insiderPageSize)}</span>
                                    <button className="btn btn-xs btn-ghost" disabled={(insiderPage + 1) * insiderPageSize >= insiderTotal} onClick={() => fetchInsiderTrades(insiderPage + 1)} title="Next">&rsaquo;</button>
                                    <button className="btn btn-xs btn-ghost" disabled={(insiderPage + 1) * insiderPageSize >= insiderTotal} onClick={() => fetchInsiderTrades(Math.ceil(insiderTotal / insiderPageSize) - 1)} title="Last">&raquo;</button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

        </motion.div>
    );
};

const IntelPanel = ({ ticker, onBacktestTicker, onExplain, onClose, notify }) => {
    const [info, setInfo] = useState(null);
    const [technicals, setTechnicals] = useState(null);
    const [news, setNews] = useState([]);
    const [loading, setLoading] = useState(true);
    const [subTab, setSubTab] = useState('fundamental');
    const [insiderTrades, setInsiderTrades] = useState([]);
    const [insiderLoading, setInsiderLoading] = useState(false);
    const [insiderFetched, setInsiderFetched] = useState(false);
    const [insiderSearch, setInsiderSearch] = useState('');
    const [insiderTypeFilter, setInsiderTypeFilter] = useState('all');
    const [chartData, setChartData] = useState(null);
    const [chartDataFiles, setChartDataFiles] = useState([]);
    const [chartLoading, setChartLoading] = useState(false);
    const [chartDownloading, setChartDownloading] = useState(false);

    const filteredInsiderTrades = useMemo(() => {
        let result = insiderTrades;
        if (insiderSearch) {
            const q = insiderSearch.toLowerCase();
            result = result.filter(t =>
                (t.insider || '').toLowerCase().includes(q)
            );
        }
        if (insiderTypeFilter !== 'all') {
            result = result.filter(t => t.transaction_type === insiderTypeFilter);
        }
        return result;
    }, [insiderTrades, insiderSearch, insiderTypeFilter]);

    useEffect(() => {
        setLoading(true);
        Promise.all([
            axios.get(`${INTELLIGENCE_SERVICE}/info/${ticker}`),
            axios.get(`${INTELLIGENCE_SERVICE}/technicals/${ticker}`),
            axios.get(`${INTELLIGENCE_SERVICE}/news/${ticker}?limit=10`),
        ]).then(([infoRes, techRes, newsRes]) => {
            setInfo(infoRes.data);
            setTechnicals(techRes.data);
            setNews(newsRes.data.news || []);
        }).catch(() => {}).finally(() => setLoading(false));
    }, [ticker]);

    useEffect(() => {
        if (subTab === 'insider' && !insiderFetched) {
            setInsiderLoading(true);
            axios.post(`${INTELLIGENCE_SERVICE}/insider-trades`, {
                tickers: [ticker],
                limit: 50,
                offset: 0,
                days_back: 365,
            }).then(res => {
                setInsiderTrades(res.data.trades || []);
                setInsiderFetched(true);
            }).catch(() => {}).finally(() => setInsiderLoading(false));
        }
    }, [subTab, ticker, insiderFetched]);

    useEffect(() => {
        if (subTab !== 'chart' || chartData) return;
        setChartLoading(true);
        axios.get(`${DATA_SERVICE}/check/${ticker}`).then(res => {
            if (res.data.available && res.data.files.length > 0) {
                setChartDataFiles(res.data.files);
                const dailyFile = res.data.files.find(f => f.includes('-1d-'));
                const bestFile = dailyFile || res.data.files[0];
                return axios.get(`${DATA_SERVICE}/data/${bestFile}?t=${Date.now()}`);
            }
        }).then(res => {
            if (res) {
                const parsed = Papa.parse(res.data, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
                setChartData(parsed.data);
            }
        }).catch(() => {}).finally(() => setChartLoading(false));
    }, [subTab, ticker, chartData]);

    const downloadAndShowChart = async () => {
        if (chartDownloading) return;
        setChartDownloading(true);
        try {
            await axios.post(`${DATA_SERVICE}/download`, { tickers: [ticker.toUpperCase()], period: 'max', interval: '1d' });
            if (notify) notify(`Download started for ${ticker.toUpperCase()}, refresh tab shortly`, 'blue');
        } catch {
            if (notify) notify('Download failed', 'red');
        } finally {
            setChartDownloading(false);
        }
    };    const formatLarge = (v) => {
        if (v == null) return '-';
        if (Math.abs(v) >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
        if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
        if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
        return '$' + Number(v).toLocaleString();
    };

    const subTabStyle = (tab) => ({
        padding: '0.4rem 1rem',
        fontSize: '0.78rem',
        fontWeight: 600,
        borderRadius: '6px',
        cursor: 'pointer',
        background: subTab === tab ? 'var(--brand-blue)' : 'var(--bg-accent)',
        color: subTab === tab ? 'white' : 'var(--text-secondary)',
        border: 'none',
        transition: 'all 0.15s ease',
    });

    const explainStock = () => {
        const headlineNews = news.slice(0, 4).map(n => `${n.title} (${n.publisher || 'Unknown'})`).join('; ');
        const prompt = `Analyze ${ticker} from the Market Overview stock detail panel. Company context: ${info?.name || ticker}, sector ${info?.sector || 'unknown'}, industry ${info?.industry || 'unknown'}. Price ${info?.current_price ?? '-'}, previous close ${info?.previous_close ?? '-'}, market cap ${info?.market_cap ?? '-'}, trailing PE ${info?.pe_ratio ?? '-'}, forward PE ${info?.forward_pe ?? '-'}. Technicals: RSI ${technicals?.rsi_14 ?? '-'}, SMA20 ${technicals?.sma_20 ?? '-'}, SMA50 ${technicals?.sma_50 ?? '-'}, SMA200 ${technicals?.sma_200 ?? '-'}, trend ${technicals?.trend || '-'}. Recent news: ${headlineNews || 'none loaded'}. Explain the stock setup, key risks/catalysts, whether movement looks stock-specific or market/industry-driven, and what to watch next.`;
        onExplain?.(prompt, `Explaining ${ticker}`);
    };

    return (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="panel" style={{ marginTop: '1rem', padding: '1.25rem', position: 'relative' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <button className="btn btn-xs btn-ghost" onClick={onClose} style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}>
                        <X size={14} />
                    </button>
                    <h3 style={{ margin: 0, fontSize: '1rem' }}>{ticker}</h3>
                    {info && <span style={{ fontSize: '0.78rem', opacity: 0.6 }}>{info.name} · {info.sector} · {info.industry}</span>}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-xs btn-ghost" onClick={explainStock} style={{ fontSize: '0.72rem', padding: '0.25rem 0.5rem' }}>
                        <MessageCircleQuestion size={13} /> Explain
                    </button>
                    {onBacktestTicker && (
                        <button className="btn btn-xs btn-ghost" onClick={() => onBacktestTicker(ticker)} style={{ fontSize: '0.72rem', padding: '0.25rem 0.5rem' }}>
                            ⚡ Backtest
                        </button>
                    )}
                    <button className="btn btn-xs btn-ghost" onClick={onClose} style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}>
                        <X size={14} />
                    </button>
                </div>
            </div>

            <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                <button style={subTabStyle('fundamental')} onClick={() => setSubTab('fundamental')}>Fundamental</button>
                <button style={subTabStyle('news')} onClick={() => setSubTab('news')}>
                    News {!loading && news.length > 0 && <span style={{ opacity: 0.7 }}>({news.length})</span>}
                </button>
                <button style={subTabStyle('insider')} onClick={() => setSubTab('insider')}>
                    Insider Trades {insiderTrades.length > 0 && <span style={{ opacity: 0.7 }}>({insiderTrades.length})</span>}
                </button>
                <button style={subTabStyle('chart')} onClick={() => setSubTab('chart')}>Chart</button>
            </div>

            {loading && (
                <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5 }}>
                    <RefreshCw className="animate-spin" size={24} style={{ margin: '0 auto 0.5rem' }} />
                    <p style={{ fontSize: '0.85rem' }}>Loading details...</p>
                </div>
            )}

            {!loading && subTab === 'fundamental' && (
                <div>
                    {info && !info.error && (
                        <div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                {[
                                    { label: 'Price', value: info.current_price != null ? '$' + info.current_price : '-' },
                                    { label: 'Prev Close', value: info.previous_close != null ? '$' + info.previous_close : '-' },
                                    { label: 'Market Cap', value: formatLarge(info.market_cap) },
                                    { label: 'P/E', value: info.pe_ratio != null ? info.pe_ratio.toFixed(2) : '-' },
                                    { label: 'Fwd P/E (Yr)', value: info.forward_pe != null ? info.forward_pe.toFixed(2) : '-' },
                                    { label: 'P/E (Next Q)*', value: info.pe_next_q != null ? info.pe_next_q.toFixed(2) : '-' },
                                    { label: 'Est. EPS (Q)', value: info.eps_estimate_next_q != null ? '$' + info.eps_estimate_next_q.toFixed(2) : '-' },
                                    { label: 'Div Yield', value: info.dividend_yield != null ? (info.dividend_yield * 100).toFixed(2) + '%' : '-' },
                                    { label: 'Beta', value: info.beta?.toFixed(2) ?? '-' },
                                    { label: '52W High', value: info['52w_high'] != null ? '$' + info['52w_high'] : '-' },
                                    { label: '52W Low', value: info['52w_low'] != null ? '$' + info['52w_low'] : '-' },
                                    { label: 'Volume', value: formatLarge(info.volume) },
                                    { label: 'Avg Volume', value: formatLarge(info.avg_volume) },
                                ].map(d => (
                                    <div key={d.label} className="panel" style={{ padding: '0.5rem 0.75rem', margin: 0 }}>
                                        <div style={{ fontSize: '0.65rem', opacity: 0.5, marginBottom: '0.2rem' }}>{d.label}</div>
                                        <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{d.value}</div>
                                    </div>
                                ))}
                            </div>
                            <div style={{ fontSize: '0.6rem', opacity: 0.4 }}>* annualized from next quarter estimate</div>
                        </div>
                    )}
                    {technicals && !technicals.error && (
                        <div className="panel" style={{ padding: '1rem', marginTop: '1rem' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 600, opacity: 0.6, marginBottom: '0.5rem' }}>Technical Analysis</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '0.5rem' }}>
                                {[
                                    { label: 'RSI (14)', value: technicals.rsi_14?.toFixed(1), color: technicals.rsi_14 > 70 ? '#f87171' : technicals.rsi_14 < 30 ? '#4ade80' : undefined },
                                    { label: 'SMA 20', value: technicals.sma_20 != null ? '$' + technicals.sma_20.toFixed(2) : '-' },
                                    { label: 'SMA 50', value: technicals.sma_50 != null ? '$' + technicals.sma_50.toFixed(2) : '-' },
                                    { label: 'SMA 200', value: technicals.sma_200 != null ? '$' + technicals.sma_200.toFixed(2) : '-' },
                                ].map(d => (
                                    <div key={d.label}>
                                        <div style={{ fontSize: '0.65rem', opacity: 0.5 }}>{d.label}</div>
                                        <div style={{ fontWeight: 700, fontSize: '0.85rem', color: d.color || 'inherit' }}>{d.value ?? '-'}</div>
                                    </div>
                                ))}
                            </div>
                            <div style={{ marginTop: '0.5rem', padding: '0.4rem 0.75rem', borderRadius: '4px', background: technicals.trend === 'bullish' ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)', display: 'flex', gap: '1rem', fontSize: '0.78rem' }}>
                                <span>Trend: <strong style={{ color: technicals.trend === 'bullish' ? '#4ade80' : '#f87171', textTransform: 'uppercase' }}>{technicals.trend}</strong></span>
                                <span>Support: <strong>${technicals.support?.toFixed(2)}</strong></span>
                                <span>Resistance: <strong>${technicals.resistance?.toFixed(2)}</strong></span>
                                <span>Volatility: <strong>{technicals.volatility?.toFixed(1)}%</strong></span>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {!loading && subTab === 'news' && (
                <div>
                    {news.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            {news.map((a, i) => (
                                <a key={i} href={a.link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                                    <div className="panel" style={{ padding: '0.5rem 0.75rem', margin: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                                        <div style={{ flex: 1, fontSize: '0.78rem' }}>{a.title}</div>
                                        <div style={{ fontSize: '0.65rem', opacity: 0.4, whiteSpace: 'nowrap' }}>{a.publisher || ''} · {timeAgo(a.published)}</div>
                                    </div>
                                </a>
                            ))}
                        </div>
                    ) : (
                        <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5, fontSize: '0.85rem' }}>
                            No recent news for {ticker}
                        </div>
                    )}
                </div>
            )}

            {!loading && subTab === 'insider' && (
                <div>
                    {insiderLoading && (
                        <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5 }}>
                            <RefreshCw className="animate-spin" size={20} style={{ margin: '0 auto 0.5rem' }} />
                            <p style={{ fontSize: '0.85rem' }}>Loading insider trades...</p>
                        </div>
                    )}
                    {!insiderLoading && insiderTrades.length === 0 && (
                        <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5, fontSize: '0.85rem' }}>
                            No insider trades found for {ticker}
                        </div>
                    )}
                    {!insiderLoading && insiderTrades.length > 0 && (
                        <div>
                            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                <input
                                    className="input"
                                    style={{ width: '160px', height: '26px', fontSize: '0.72rem' }}
                                    placeholder="Filter by insider..."
                                    value={insiderSearch}
                                    onChange={e => setInsiderSearch(e.target.value)}
                                />
                                {['all', 'Buy', 'Sell'].map(t => (
                                    <button
                                        key={t}
                                        className={`btn btn-xs ${insiderTypeFilter === t ? 'btn-primary' : 'btn-ghost'}`}
                                        onClick={() => setInsiderTypeFilter(t)}
                                        style={{ fontSize: '0.7rem', padding: '0.15rem 0.45rem' }}
                                    >
                                        {t === 'all' ? 'All' : t}
                                    </button>
                                ))}
                                {(insiderSearch || insiderTypeFilter !== 'all') && (
                                    <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>
                                        {filteredInsiderTrades.length} of {insiderTrades.length} shown
                                    </span>
                                )}
                            </div>
                            <div style={{ width: '100%', fontSize: '0.72rem' }}>
                                <table className="table" style={{ width: '100%', tableLayout: 'fixed', fontSize: '0.72rem' }}>
                                    <colgroup>
                                        <col style={{ width: '13%' }} />
                                        <col style={{ width: '18%' }} />
                                    <col style={{ width: '15%' }} />
                                    <col style={{ width: '7%' }} />
                                    <col style={{ width: '12%' }} />
                                    <col style={{ width: '8%' }} />
                                    <col style={{ width: '10%' }} />
                                    <col style={{ width: '13%' }} />
                                    <col style={{ width: '4%' }} />
                                </colgroup>
                                <thead>
                                    <tr>
                                        <th>Date</th>
                                        <th>Insider</th>
                                        <th>Role</th>
                                        <th>Txn</th>
                                        <th style={{ textAlign: 'right' }}>Shares</th>
                                        <th style={{ textAlign: 'right' }}>%</th>
                                        <th style={{ textAlign: 'right' }}>Price</th>
                                        <th style={{ textAlign: 'right' }}>Value</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredInsiderTrades.length === 0 && (
                                        <tr>
                                            <td colSpan={9} style={{ textAlign: 'center', padding: '1.25rem', color: 'var(--text-muted)' }}>
                                                No insider trades match the current filters.
                                            </td>
                                        </tr>
                                    )}
                                    {filteredInsiderTrades.map((t, i) => (
                                        <tr key={i}>
                                            <td style={{ fontSize: '0.68rem' }}>{t.date || '-'}</td>
                                            <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.insider}>{t.insider || '-'}</td>
                                            <td style={{ fontSize: '0.65rem', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.position}>{t.position || '-'}</td>
                                            <td>
                                                {t.transaction_type === 'Buy' ? (
                                                    <span className="badge badge-green" style={{ fontSize: '0.62rem', padding: '0.1rem 0.3rem', whiteSpace: 'nowrap' }}>Buy</span>
                                                ) : t.transaction_type === 'Sell' ? (
                                                    <span className="badge badge-red" style={{ fontSize: '0.62rem', padding: '0.1rem 0.3rem', whiteSpace: 'nowrap' }}>Sell</span>
                                                ) : (
                                                    <span className="badge badge-yellow" style={{ fontSize: '0.62rem', padding: '0.1rem 0.3rem', whiteSpace: 'nowrap' }}>{t.transaction_type || 'Other'}</span>
                                                )}
                                            </td>
                                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '0.68rem' }}>{t.shares?.toLocaleString() || '-'}</td>
                                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '0.68rem', color: t.portfolio_pct != null ? (t.transaction_type === 'Sell' ? '#f87171' : '#4ade80') : 'inherit' }}>
                                                {t.portfolio_pct != null ? t.portfolio_pct.toFixed(1) + '%' : '-'}
                                            </td>
                                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '0.68rem' }}>{t.price != null ? '$' + t.price.toFixed(2) : '-'}</td>
                                            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: '0.68rem' }}>
                                                {t.value != null ? '$' + (Math.abs(t.value) >= 1e6 ? (t.value / 1e6).toFixed(2) + 'M' : Math.abs(t.value) >= 1e3 ? (t.value / 1e3).toFixed(1) + 'K' : Number(t.value).toLocaleString()) : '-'}
                                            </td>
                                            <td style={{ textAlign: 'center', fontSize: '0.65rem' }}>
                                                {t.url ? (
                                                    <a href={t.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-blue)' }}>
                                                        <ExternalLink size={10} />
                                                    </a>
                                                ) : ''}
                                            </td>
                                        </tr>
                                        ))}
                                </tbody>
                            </table>
                        </div>
                        </div>
                    )}
                </div>
            )}

            {subTab === 'chart' && (
                <div>
                    {chartLoading && (
                        <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5 }}>
                            <RefreshCw className="animate-spin" size={20} style={{ margin: '0 auto 0.5rem' }} />
                            <p style={{ fontSize: '0.85rem' }}>Checking data availability...</p>
                        </div>
                    )}
                    {!chartLoading && chartData && (
                        <div style={{ height: '500px' }}>
                            <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center', opacity: 0.6 }}>Loading chart...</div>}>
                                <ChartViewer data={chartData} fileName={(chartDataFiles.find(f => f.includes('-1d-')) || chartDataFiles[0] || ticker)} height={500} />
                            </Suspense>
                        </div>
                    )}
                    {!chartLoading && !chartData && chartDataFiles.length === 0 && (
                        <div style={{ padding: '2rem', textAlign: 'center' }}>
                            <p style={{ fontSize: '0.85rem', opacity: 0.6, marginBottom: '1rem' }}>No data available for {ticker}. Download it first.</p>
                            <button
                                className="btn btn-xs btn-primary"
                                onClick={downloadAndShowChart}
                                disabled={chartDownloading}
                                style={{ fontSize: '0.78rem', padding: '0.4rem 1rem' }}
                            >
                                {chartDownloading ? 'Downloading...' : <><Download size={14} style={{ marginRight: '0.3rem' }} /> Download Data</>}
                            </button>
                        </div>
                    )}
                    {!chartLoading && chartDataFiles.length > 0 && !chartData && (
                        <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.5 }}>
                            <p style={{ fontSize: '0.85rem' }}>Failed to load chart data</p>
                        </div>
                    )}
                </div>
            )}

        </motion.div>
    );
};

export default SectorHeatmap;
