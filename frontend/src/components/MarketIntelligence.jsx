import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import axios from 'axios';
import Papa from 'papaparse';
import {
    TrendingUp, TrendingDown, Activity, RefreshCw, Plus, X, 
    Clock, DollarSign, BarChart3, Newspaper, Target, Zap,
    AlertCircle, CheckCircle2, Settings, Play, Pause, FolderKanban
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { DATA_SERVICE, INTELLIGENCE_SERVICE } from '../config';
import CategoryManager from './CategoryManager';

const ChartViewer = lazy(() => import('./ChartViewer'));

const MarketIntelligence = ({ notify, onBacktestTicker, files }) => {
    const [watchlist, setWatchlist] = useState([]);
    const [categories, setCategories] = useState([]);
    const [activeCategory, setActiveCategory] = useState(null);
    const [showCategoryManager, setShowCategoryManager] = useState(false);
    const [quotes, setQuotes] = useState({});
    const [selectedTicker, setSelectedTicker] = useState(null);
    const [tickerDetails, setTickerDetails] = useState(null);
    const [tickerNews, setTickerNews] = useState([]);
    const [tickerTechnicals, setTickerTechnicals] = useState(null);
    const [newTicker, setNewTicker] = useState('');
    const [marketOverview, setMarketOverview] = useState(null);
    const [syncConfig, setSyncConfig] = useState({
        enabled: false,
        interval_minutes: 60,
        tickers: [],
        data_interval: '1d',
        data_period: '5d',
        use_multi_granularity: false,
        sync_granularities: [
            { interval: '1m', period: '1d', sync_every_minutes: 5 },
            { interval: '5m', period: '5d', sync_every_minutes: 15 },
            { interval: '1h', period: '1mo', sync_every_minutes: 60 },
            { interval: '1d', period: 'max', sync_every_minutes: 360 }
        ]
    });
    const [syncStatus, setSyncStatus] = useState(null);
    const [showSyncSettings, setShowSyncSettings] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadingOverview, setLoadingOverview] = useState(true);
    const [loadingWatchlist, setLoadingWatchlist] = useState(true);
    const [loadingDetails, setLoadingDetails] = useState(false);
    const [detailsCache, setDetailsCache] = useState({});
    const [chartData, setChartData] = useState(null);
    const [chartFileName, setChartFileName] = useState('');
    const [chartMarkers, setChartMarkers] = useState([]);
    const [overviewRefreshing, setOverviewRefreshing] = useState(false);

    // Fetch watchlist
    const fetchWatchlist = async () => {
        setLoadingWatchlist(true);
        try {
            const res = await axios.get(`${DATA_SERVICE}/watch`);
            setWatchlist(res.data.watched_tickers || []);
            setCategories(res.data.categories || []);
        } catch (e) {
            console.error('Failed to fetch watchlist', e);
        } finally {
            setLoadingWatchlist(false);
        }
    };

    // Fetch quotes for all watchlist tickers
    const fetchQuotes = async () => {
        if (watchlist.length === 0) return;
        
        try {
            const res = await axios.post(`${INTELLIGENCE_SERVICE}/batch-quotes`, watchlist);
            const quotesMap = {};
            res.data.quotes.forEach(q => {
                quotesMap[q.symbol] = q;
            });
            setQuotes(quotesMap);
        } catch (e) {
            console.error('Failed to fetch quotes', e);
        }
    };

    // Fetch market overview
    const fetchMarketOverview = useCallback(async () => {
        const initialLoad = !marketOverview;
        if (initialLoad) setLoadingOverview(true);
        else setOverviewRefreshing(true);
        try {
            const res = await axios.get(`${INTELLIGENCE_SERVICE}/market-overview`);
            setMarketOverview(res.data);
        } catch (e) {
            console.error('Failed to fetch market overview', e);
        } finally {
            if (initialLoad) setLoadingOverview(false);
            else setOverviewRefreshing(false);
        }
    }, [marketOverview]);

    // Fetch sync config
    const fetchSyncConfig = async () => {
        try {
            const res = await axios.get(`${INTELLIGENCE_SERVICE}/sync-config`);
            const config = res.data;
            
            // Ensure sync_granularities exists with default values
            if (!config.sync_granularities || config.sync_granularities.length === 0) {
                config.sync_granularities = [
                    { interval: '1m', period: '1d', sync_every_minutes: 5 },
                    { interval: '5m', period: '5d', sync_every_minutes: 15 },
                    { interval: '1h', period: '1mo', sync_every_minutes: 60 },
                    { interval: '1d', period: 'max', sync_every_minutes: 360 }
                ];
            }
            
            // Ensure use_multi_granularity is set
            if (config.use_multi_granularity === undefined || config.use_multi_granularity === null) {
                config.use_multi_granularity = false;
            }
            
            setSyncConfig(config);
        } catch (e) {
            console.error('Failed to fetch sync config', e);
        }
    };

    // Fetch sync status
    const fetchSyncStatus = async () => {
        try {
            const res = await axios.get(`${INTELLIGENCE_SERVICE}/sync-status`);
            setSyncStatus(res.data);
        } catch (e) {
            console.error('Failed to fetch sync status', e);
        }
    };

    // Add ticker to watchlist
    const addTicker = async () => {
        if (!newTicker.trim()) return;
        
        try {
            await axios.post(`${DATA_SERVICE}/watch`, [newTicker.toUpperCase()]);
            setNewTicker('');
            fetchWatchlist();
            notify(`Added ${newTicker.toUpperCase()} to watchlist`, 'green');
        } catch (e) {
            notify('Failed to add ticker', 'red');
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

    const filteredWatchlist = activeCategory
        ? watchlist.filter(t => activeCategory.tickers.includes(t))
        : watchlist;

    // Remove ticker from watchlist
    const removeTicker = async (ticker) => {
        try {
            await axios.delete(`${DATA_SERVICE}/watch/${ticker}`);
            fetchWatchlist();
            if (selectedTicker === ticker) {
                setSelectedTicker(null);
            }
            notify(`Removed ${ticker}`, 'blue');
        } catch (e) {
            notify('Failed to remove ticker', 'red');
        }
    };

    // Fetch ticker details (cached per ticker)
    const fetchTickerDetails = async (ticker) => {
        if (detailsCache[ticker]) {
            const cached = detailsCache[ticker];
            setTickerDetails(cached.info);
            setTickerNews(cached.news);
            setTickerTechnicals(cached.technicals);
            return;
        }
        setLoadingDetails(true);
        try {
            const [info, news, technicals] = await Promise.all([
                axios.get(`${INTELLIGENCE_SERVICE}/info/${ticker}`),
                axios.get(`${INTELLIGENCE_SERVICE}/news/${ticker}?limit=10`),
                axios.get(`${INTELLIGENCE_SERVICE}/technicals/${ticker}`)
            ]);
            
            setTickerDetails(info.data);
            setTickerNews(news.data.news || []);
            setTickerTechnicals(technicals.data);
            setDetailsCache(prev => ({ ...prev, [ticker]: { info: info.data, news: news.data.news || [], technicals: technicals.data } }));
        } catch (e) {
            console.error('Error fetching ticker details:', e);
            notify('Failed to fetch ticker details', 'red');
        } finally {
            setLoadingDetails(false);
        }
    };

    // Update sync config
    const updateSyncConfig = async () => {
        try {
            console.log('Sending sync config:', syncConfig);
            const response = await axios.post(`${INTELLIGENCE_SERVICE}/sync-config`, syncConfig);
            console.log('Sync config response:', response.data);
            notify(syncConfig.enabled ? 'Auto-sync enabled' : 'Auto-sync disabled', 'green');
            fetchSyncStatus();
            setShowSyncSettings(false);
        } catch (e) {
            console.error('Failed to update sync config:', e.response?.data || e.message);
            notify(`Failed to update sync config: ${e.response?.data?.detail || e.message}`, 'red');
        }
    };

    // Trigger manual sync
    const triggerSync = async () => {
        try {
            await axios.post(`${INTELLIGENCE_SERVICE}/sync-now`);
            notify('Sync triggered', 'blue');
        } catch (e) {
            notify('Failed to trigger sync', 'red');
        }
    };

    // Load chart for ticker
    const handleViewChart = async (ticker) => {
        setLoading(true);
        try {
            // Find daily data for this ticker, or first available
            const tickerFiles = (files || []).filter(f => f.toLowerCase().startsWith(ticker.toLowerCase() + '-'));
            
            if (tickerFiles.length === 0) {
                notify(`No data found for ${ticker}. Download it first from Data Hub.`, 'yellow');
                setLoading(false);
                return;
            }

            const dailyFile = tickerFiles.find(f => f.includes('-1d-')) || tickerFiles[0];
            
            const now = new Date().getTime();
            const res = await axios.get(`${DATA_SERVICE}/data/${dailyFile}?t=${now}`);
            const parsed = Papa.parse(res.data, {
                header: true,
                skipEmptyLines: true,
                transformHeader: h => h.trim()
            });

            setChartData(parsed.data);
            setChartFileName(dailyFile);
            setChartMarkers([]);
            notify(`Loaded chart for ${ticker}`, 'green');
        } catch (e) {
            console.error("Error loading chart:", e);
            notify(`Failed to load chart: ${e.response?.data?.detail || e.message}`, 'red');
        } finally {
            setLoading(false);
        }
    };

    // Initial load
    useEffect(() => {
        fetchWatchlist();
        fetchMarketOverview();
        fetchSyncConfig();
        fetchSyncStatus();
        
        // Auto-sync downloaded files to watchlist on first load
        syncFilesToWatchlist();
    }, []);

    useEffect(() => {
        const interval = setInterval(fetchMarketOverview, 60000);
        return () => clearInterval(interval);
    }, [fetchMarketOverview]);
    
    // Sync downloaded files to watchlist
    const syncFilesToWatchlist = async () => {
        try {
            const res = await axios.post(`${DATA_SERVICE}/sync-files-to-watchlist`);
            if (res.data.added && res.data.added.length > 0) {
                console.log('Auto-synced tickers to watchlist:', res.data.added);
                fetchWatchlist(); // Refresh watchlist
            }
        } catch (e) {
            console.error('Failed to sync files to watchlist', e);
        }
    };

    // Fetch quotes when watchlist changes
    useEffect(() => {
        if (watchlist.length > 0) {
            fetchQuotes();
            const interval = setInterval(fetchQuotes, 30000); // Update every 30 seconds
            return () => clearInterval(interval);
        }
    }, [watchlist]);

    // Fetch details when ticker selected
    useEffect(() => {
        if (selectedTicker) {
            fetchTickerDetails(selectedTicker);
        }
    }, [selectedTicker]);

    const formatNumber = (num) => {
        if (!num) return 'N/A';
        if (num >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
        if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
        if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
        return `$${num.toFixed(2)}`;
    };

    const formatTimeAgo = (dateStr) => {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    };

    return (
        <div style={{ padding: '2rem', maxWidth: '1800px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '2rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <Activity size={32} color="var(--brand-blue)" />
                        Market Intelligence
                    </h1>
                    <p style={{ margin: '0.5rem 0 0 0', opacity: 0.6 }}>
                        Real-time market data, news, and analytics
                    </p>
                    {marketOverview?.timestamp && (
                        <p style={{ margin: '0.35rem 0 0 0', fontSize: '0.8rem', opacity: 0.45 }}>
                            Market overview updated {formatTimeAgo(marketOverview.timestamp)}
                            {overviewRefreshing ? ' · refreshing…' : ''}
                        </p>
                    )}
                </div>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                    {syncStatus && syncStatus.enabled && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '8px', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                            <CheckCircle2 size={16} color="var(--brand-green)" />
                            <span style={{ fontSize: '0.8rem', color: 'var(--brand-green)' }}>
                                Auto-sync active {syncStatus.total_jobs > 1 ? `(${syncStatus.total_jobs} jobs)` : ''}
                            </span>
                        </div>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowSyncSettings(!showSyncSettings)}>
                        <Settings size={18} />
                        Sync Settings
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={triggerSync}>
                        <RefreshCw size={18} />
                        Sync Now
                    </button>
                </div>
            </div>

            {/* Sync Settings Panel */}
            <AnimatePresence>
                {showSyncSettings && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="panel"
                        style={{ marginBottom: '2rem', padding: '1.5rem' }}
                    >
                        <h3 style={{ margin: '0 0 1rem 0' }}>Auto-Sync Configuration</h3>
                        
                        <div style={{ marginBottom: '1.5rem' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '1rem' }}>
                                <input
                                    type="checkbox"
                                    checked={syncConfig.enabled}
                                    onChange={(e) => setSyncConfig({ ...syncConfig, enabled: e.target.checked })}
                                />
                                <span style={{ fontWeight: 'bold' }}>Enable Auto-Sync</span>
                            </label>
                            
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={syncConfig.use_multi_granularity}
                                    onChange={(e) => setSyncConfig({ ...syncConfig, use_multi_granularity: e.target.checked })}
                                />
                                <span>Use Multi-Granularity Mode (recommended)</span>
                            </label>
                            <p style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: '0.5rem', marginLeft: '1.5rem' }}>
                                Automatically sync different timeframes at optimal intervals
                            </p>
                        </div>

                        {syncConfig.use_multi_granularity ? (
                            <div style={{ marginBottom: '1rem' }}>
                                <h4 style={{ fontSize: '0.9rem', marginBottom: '1rem', opacity: 0.8 }}>Sync Schedule</h4>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                    {(syncConfig.sync_granularities || []).map((gran, idx) => (
                                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.75rem', background: 'var(--bg-accent)', borderRadius: '6px' }}>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
                                                    {gran.interval} data ({gran.period} history)
                                                </div>
                                                <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                                                    Syncs every {gran.sync_every_minutes} minutes
                                                </div>
                                            </div>
                                            <input
                                                type="number"
                                                className="input input-sm"
                                                value={gran.sync_every_minutes}
                                                onChange={(e) => {
                                                    const newGrans = [...(syncConfig.sync_granularities || [])];
                                                    newGrans[idx].sync_every_minutes = parseInt(e.target.value);
                                                    setSyncConfig({ ...syncConfig, sync_granularities: newGrans });
                                                }}
                                                min="1"
                                                style={{ width: '80px' }}
                                            />
                                            <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>min</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                                <div>
                                    <label style={{ fontSize: '0.8rem', opacity: 0.7, display: 'block', marginBottom: '0.5rem' }}>
                                        Sync Interval (minutes)
                                    </label>
                                    <input
                                        type="number"
                                        className="input"
                                        value={syncConfig.interval_minutes}
                                        onChange={(e) => setSyncConfig({ ...syncConfig, interval_minutes: parseInt(e.target.value) })}
                                        min="5"
                                        max="1440"
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: '0.8rem', opacity: 0.7, display: 'block', marginBottom: '0.5rem' }}>
                                        Data Interval
                                    </label>
                                    <select
                                        className="input"
                                        value={syncConfig.data_interval}
                                        onChange={(e) => setSyncConfig({ ...syncConfig, data_interval: e.target.value })}
                                    >
                                        <option value="1m">1 minute</option>
                                        <option value="5m">5 minutes</option>
                                        <option value="15m">15 minutes</option>
                                        <option value="1h">1 hour</option>
                                        <option value="1d">1 day</option>
                                    </select>
                                </div>
                            </div>
                        )}
                        
                        <div style={{ display: 'flex', gap: '1rem' }}>
                            <button className="btn btn-primary" onClick={updateSyncConfig}>
                                Save Configuration
                            </button>
                            <button className="btn btn-ghost" onClick={() => setShowSyncSettings(false)}>
                                Cancel
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Market Overview */}
            {loadingOverview ? (
                <div className="panel" style={{ marginBottom: '2rem', padding: '1.5rem' }}>
                    <h3 style={{ margin: '0 0 1rem 0', fontSize: '0.9rem', opacity: 0.6, letterSpacing: '1px' }}>MARKET INDICES</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
                        {[1,2,3,4].map(i => (
                            <div key={i} className="skeleton" style={{ height: '5.5rem' }} />
                        ))}
                    </div>
                </div>
            ) : marketOverview && marketOverview.indices && (
                <div className="panel" style={{ marginBottom: '2rem', padding: '1.5rem' }}>
                    <h3 style={{ margin: '0 0 1rem 0', fontSize: '0.9rem', opacity: 0.6, letterSpacing: '1px' }}>MARKET INDICES</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
                        {Object.entries(marketOverview.indices).map(([symbol, data]) => (
                            <div key={symbol} style={{ padding: '1rem', background: 'var(--bg-accent)', borderRadius: '8px' }}>
                                <div style={{ fontSize: '0.75rem', opacity: 0.6, marginBottom: '0.25rem' }}>{data.name}</div>
                                <div style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '0.25rem' }}>
                                    {data.price?.toFixed(2)}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    {data.change >= 0 ? <TrendingUp size={14} color="var(--brand-green)" /> : <TrendingDown size={14} color="var(--brand-red)" />}
                                    <span style={{ color: data.change >= 0 ? 'var(--brand-green)' : 'var(--brand-red)', fontSize: '0.9rem' }}>
                                        {data.change >= 0 ? '+' : ''}{data.change?.toFixed(2)} ({data.change_percent?.toFixed(2)}%)
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: selectedTicker ? '400px 1fr' : '1fr', gap: '2rem' }}>
                {/* Watchlist Panel */}
                <div className="panel" style={{ padding: '1.5rem' }}>
                    <h3 style={{ margin: '0 0 1rem 0' }}>Watchlist</h3>

                    {categories.length > 0 && (
                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '1rem', alignItems: 'center' }}>
                            <FolderKanban size={14} opacity={0.4} />
                            <span
                                className={`badge ${!activeCategory ? 'badge-blue' : ''}`}
                                style={{ cursor: 'pointer', padding: '0.3rem 0.6rem', opacity: !activeCategory ? 1 : 0.5 }}
                                onClick={() => setActiveCategory(null)}>
                                All ({watchlist.length})
                            </span>
                            {categories.map((cat, i) => (
                                <span key={i}
                                    className={`badge ${activeCategory?.name === cat.name ? 'badge-blue' : ''}`}
                                    style={{ cursor: 'pointer', padding: '0.3rem 0.6rem', opacity: activeCategory?.name === cat.name ? 1 : 0.5 }}
                                    onClick={() => setActiveCategory(cat)}>
                                    {cat.name} ({cat.tickers.length})
                                </span>
                            ))}
                            <button className="btn btn-ghost btn-xs" onClick={() => setShowCategoryManager(true)}
                                style={{ fontSize: '0.75rem', opacity: 0.5, marginLeft: 'auto' }}>
                                <FolderKanban size={12} /> Edit
                            </button>
                        </div>
                    )}

                    {/* Add Ticker */}
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
                        <input
                            className="input input-sm"
                            placeholder="Add ticker (e.g., AAPL)"
                            value={newTicker}
                            onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
                            onKeyPress={(e) => e.key === 'Enter' && addTicker()}
                            style={{ flex: 1 }}
                        />
                        <button className="btn btn-primary btn-sm" onClick={addTicker}>
                            <Plus size={16} />
                        </button>
                    </div>

                    {/* Ticker List */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '600px', overflowY: 'auto' }}>
                        {loadingWatchlist ? (
                            [1,2,3,4,5].map(i => (
                                <div key={i} className="skeleton" style={{ height: '5rem' }} />
                            ))
                        ) : filteredWatchlist.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '2rem', opacity: 0.4 }}>
                                <Activity size={48} style={{ margin: '0 auto 1rem' }} />
                                <p>{activeCategory ? `No tickers in "${activeCategory.name}"` : 'No tickers in watchlist'}</p>
                            </div>
                        ) : (
                        filteredWatchlist.map(ticker => {
                            const quote = quotes[ticker] || {};
                            const isSelected = selectedTicker === ticker;
                            
                            return (
                                <div
                                    key={ticker}
                                    style={{
                                        padding: '1rem',
                                        background: isSelected ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg-accent)',
                                        borderRadius: '8px',
                                        cursor: 'pointer',
                                        border: isSelected ? '1px solid var(--brand-blue)' : '1px solid transparent',
                                        transition: 'all 0.2s'
                                    }}
                                    onClick={() => setSelectedTicker(ticker)}
                                >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                                        <div>
                                            <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{ticker}</div>
                                            <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>{quote.name || 'Loading...'}</div>
                                        </div>
                                        <button
                                            className="btn btn-ghost btn-xs"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                removeTicker(ticker);
                                            }}
                                            style={{ color: 'var(--brand-red)' }}
                                        >
                                            <X size={14} />
                                        </button>
                                    </div>
                                    {quote.price && (
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div style={{ fontSize: '1.3rem', fontWeight: 'bold' }}>
                                                ${quote.price}
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                                {quote.change >= 0 ? <TrendingUp size={14} color="var(--brand-green)" /> : <TrendingDown size={14} color="var(--brand-red)" />}
                                                <span style={{ color: quote.change >= 0 ? 'var(--brand-green)' : 'var(--brand-red)', fontSize: '0.85rem' }}>
                                                    {quote.change >= 0 ? '+' : ''}{quote.change} ({quote.change_percent}%)
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                        )}
                    </div>
                </div>

                {/* Ticker Details Panel */}
                {selectedTicker && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                        {loadingDetails ? (
                            <div className="panel" style={{ padding: '2rem' }}>
                                <div className="skeleton" style={{ height: '1.5rem', width: '60%', marginBottom: '1rem' }} />
                                <div className="skeleton" style={{ height: '0.9rem', width: '40%', marginBottom: '2rem' }} />
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                                    {[1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: '3rem' }} />)}
                                </div>
                                <div className="skeleton" style={{ height: '4rem' }} />
                            </div>
                        ) : (
                            <>
                                {/* Overview */}
                                {tickerDetails && (
                                    <div className="panel" style={{ padding: '2rem' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                                            <div>
                                                <h2 style={{ margin: '0 0 0.5rem 0' }}>{tickerDetails.name}</h2>
                                                <div style={{ fontSize: '0.9rem', opacity: 0.6 }}>
                                                    {tickerDetails.sector} • {tickerDetails.industry}
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                <button 
                                                    className="btn btn-ghost"
                                                    onClick={() => handleViewChart(selectedTicker)}
                                                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                                                >
                                                    <Activity size={16} /> Chart
                                                </button>
                                                <button 
                                                    className="btn btn-primary"
                                                    onClick={() => onBacktestTicker && onBacktestTicker(selectedTicker)}
                                                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                                                >
                                                    <Zap size={16} /> Backtest
                                                </button>
                                            </div>
                                        </div>
                                        
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                                            <div>
                                                <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>MARKET CAP</div>
                                                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{formatNumber(tickerDetails.market_cap)}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>P/E RATIO</div>
                                                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{tickerDetails.pe_ratio?.toFixed(2) || 'N/A'}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>DIVIDEND YIELD</div>
                                                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>
                                                    {tickerDetails.dividend_yield ? `${(tickerDetails.dividend_yield * 100).toFixed(2)}%` : 'N/A'}
                                                </div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>BETA</div>
                                                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{tickerDetails.beta?.toFixed(2) || 'N/A'}</div>
                                            </div>
                                        </div>

                                        {tickerDetails.description && (
                                            <div style={{ padding: '1rem', background: 'var(--bg-accent)', borderRadius: '8px', fontSize: '0.9rem', lineHeight: '1.6' }}>
                                                {tickerDetails.description}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Technicals */}
                                {tickerTechnicals && !tickerTechnicals.error && (
                                    <div className="panel" style={{ padding: '2rem' }}>
                                        <h3 style={{ margin: '0 0 1.5rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <BarChart3 size={20} />
                                            Technical Analysis
                                        </h3>
                                        
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                                            <div>
                                                <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>RSI (14)</div>
                                                <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: tickerTechnicals.rsi_14 > 70 ? 'var(--brand-red)' : tickerTechnicals.rsi_14 < 30 ? 'var(--brand-green)' : 'inherit' }}>
                                                    {tickerTechnicals.rsi_14 || 'N/A'}
                                                </div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>SMA 20</div>
                                                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>${tickerTechnicals.sma_20 || 'N/A'}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>SMA 50</div>
                                                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>${tickerTechnicals.sma_50 || 'N/A'}</div>
                                            </div>
                                            <div>
                                                <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>SMA 200</div>
                                                <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>${tickerTechnicals.sma_200 || 'N/A'}</div>
                                            </div>
                                        </div>

                                        <div style={{ padding: '1rem', background: tickerTechnicals.trend === 'bullish' ? 'rgba(16, 185, 129, 0.1)' : tickerTechnicals.trend === 'bearish' ? 'rgba(239, 68, 68, 0.1)' : 'var(--bg-accent)', borderRadius: '8px', border: `1px solid ${tickerTechnicals.trend === 'bullish' ? 'var(--brand-green)' : tickerTechnicals.trend === 'bearish' ? 'var(--brand-red)' : 'var(--border-subtle)'}` }}>
                                            <div style={{ fontSize: '0.8rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                                                Trend: <span style={{ textTransform: 'uppercase', color: tickerTechnicals.trend === 'bullish' ? 'var(--brand-green)' : tickerTechnicals.trend === 'bearish' ? 'var(--brand-red)' : 'inherit' }}>{tickerTechnicals.trend}</span>
                                            </div>
                                            <div style={{ fontSize: '0.8rem', opacity: 0.8 }}>
                                                Support: ${tickerTechnicals.support} • Resistance: ${tickerTechnicals.resistance}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* News */}
                                {tickerNews.length > 0 && (
                                    <div className="panel" style={{ padding: '2rem' }}>
                                        <h3 style={{ margin: '0 0 1.5rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <Newspaper size={20} />
                                            Recent News
                                        </h3>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                            {tickerNews.map((article, idx) => (
                                                <a
                                                    key={idx}
                                                    href={article.link}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    style={{ padding: '1rem', background: 'var(--bg-accent)', borderRadius: '8px', textDecoration: 'none', color: 'inherit', transition: 'all 0.2s' }}
                                                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(59, 130, 246, 0.1)'}
                                                    onMouseLeave={(e) => e.currentTarget.style.background = 'var(--bg-accent)'}
                                                >
                                                    <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>{article.title || 'No title available'}</div>
                                                    <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                                                        {article.publisher || 'Unknown'} • {article.published ? formatTimeAgo(article.published) : 'Unknown'}
                                                    </div>
                                                </a>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>

            {showCategoryManager && (
                <CategoryManager
                    categories={categories}
                    tickers={watchlist}
                    onSave={handleSaveCategories}
                    onClose={() => setShowCategoryManager(false)}
                />
            )}
        </div>
    );
};

export default MarketIntelligence;
