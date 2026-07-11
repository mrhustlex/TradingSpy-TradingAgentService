import React, { useState, useEffect, Suspense, lazy, useRef, useCallback } from 'react';
import axios from 'axios';
import Papa from 'papaparse';
import {
    Activity,
    Database,
    Play,
    PlusCircle,
    RefreshCw,
    Search,
    Settings,
    ShieldCheck,
    TrendingUp,
    X,
    Layers,
    Download,
    Filter,
    ChevronRight,
    ChevronLeft,
    Code,
    Cpu,
    Zap,
    Plus,
    Loader2,
    CheckSquare
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { DATA_SERVICE, BACKTEST_SERVICE, INTELLIGENCE_SERVICE } from '../config';
import { formatDatasetName, cleanTicker } from '../utils/formatters';

const ChartViewer = lazy(() => import('./ChartViewer'));
const MAX_BATTLE_STRATEGIES = 5;

    const TradingTerminal = ({
        files,
        strategies,
        tasks,
        onTrigger,
        onRefreshFiles,
        onRefreshStrats,
        onSwitchTab,
        notify,
        preSelectedTicker,
        onClearPreSelection,
        onDeleteFile,
        onDeleteStrategy,
        backtestPayload,
        onClearBacktestPayload
    }) => {
    // Selection state
    const [selectedFile, setSelectedFile] = useState(localStorage.getItem('terminal_selected_file') || '');
    const [selectedStrats, setSelectedStrats] = useState([]);

    // Handle pre-selected ticker from Market Intelligence
    useEffect(() => {
        if (preSelectedTicker) {
            // Find files that match this ticker
            const matchingFiles = files.filter(f => 
                f.toLowerCase().startsWith(preSelectedTicker.toLowerCase() + '-')
            );
            
            if (matchingFiles.length > 0) {
                // Prefer daily data if available, otherwise use first match
                const dailyFile = matchingFiles.find(f => f.includes('-1d-'));
                setSelectedFile(dailyFile || matchingFiles[0]);
                notify(`Selected ${preSelectedTicker} data for backtesting`, 'blue');
            } else {
                notify(`No data found for ${preSelectedTicker}. Download it first from Data Hub.`, 'yellow');
            }
            
            // Clear the pre-selection
            if (onClearPreSelection) {
                onClearPreSelection();
            }
        }
    }, [preSelectedTicker, files]);

    // UI state
    const [loading, setLoading] = useState(false);
    const [showDownloader, setShowDownloader] = useState(false);
    const [terminalSidebarCollapsed, setTerminalSidebarCollapsed] = useState(localStorage.getItem('terminal_sidebar_collapsed') === 'true');
    const [terminalSidebarWidth, setTerminalSidebarWidth] = useState(parseInt(localStorage.getItem('terminal_sidebar_width') || '320'));
    const sidebarResizeRef = useRef(null);
    const isDragging = useRef(false);
    const startX = useRef(0);
    const startWidth = useRef(0);
    const [downloading, setDownloading] = useState(false);
    const [chartData, setChartData] = useState(null);
    const [chartMarkers, setChartMarkers] = useState([]);
    const [chartFileName, setChartFileName] = useState('');
    const [loadedResults, setLoadedResults] = useState(null);
    const [loadedSummary, setLoadedSummary] = useState(null);
    const [searchFile, setSearchFile] = useState('');
    const [searchStrat, setSearchStrat] = useState('');
    const [intervalFilter, setIntervalFilter] = useState(localStorage.getItem('terminal_interval_filter') || 'all');
    const [expandedFileGroups, setExpandedFileGroups] = useState(new Set());
    const [expandedStratGroups, setExpandedStratGroups] = useState(new Set());
    const [assetLibraryCollapsed, setAssetLibraryCollapsed] = useState(localStorage.getItem('terminal_asset_library_collapsed') === 'true');
    const [strategyArsenalCollapsed, setStrategyArsenalCollapsed] = useState(localStorage.getItem('terminal_strategy_arsenal_collapsed') === 'true');
    const [selectFiles, setSelectFiles] = useState(false);
    const [selectStrats, setSelectStrats] = useState(false);
    const [bulkFileSelection, setBulkFileSelection] = useState(new Set());
    const [bulkStratSelection, setBulkStratSelection] = useState(new Set());
    const ITEMS_PER_GROUP = 3;

    const toggleAssetLibraryCollapsed = () => setAssetLibraryCollapsed(prev => !prev);
    const toggleStrategyArsenalCollapsed = () => setStrategyArsenalCollapsed(prev => !prev);

    const toggleFileGroup = (ticker) => {
        setExpandedFileGroups(prev => {
            const next = new Set(prev);
            if (next.has(ticker)) next.delete(ticker); else next.add(ticker);
            return next;
        });
    };

    const handleFileGroupToggle = (event, ticker) => {
        event?.preventDefault();
        event?.stopPropagation();
        toggleFileGroup(ticker);
    };

    const toggleStratGroup = (ticker) => {
        setExpandedStratGroups(prev => {
            const next = new Set(prev);
            if (next.has(ticker)) next.delete(ticker); else next.add(ticker);
            return next;
        });
    };

    const handleStratGroupToggle = (event, ticker) => {
        event?.preventDefault();
        event?.stopPropagation();
        toggleStratGroup(ticker);
    };

    const toggleSelectedStrategy = (strategyName) => {
        setSelectedStrats(prev => {
            if (prev.includes(strategyName)) return prev.filter(x => x !== strategyName);
            if (prev.length >= MAX_BATTLE_STRATEGIES) {
                notify?.(`Battle selection is capped at ${MAX_BATTLE_STRATEGIES} strategies for speed.`, 'yellow');
                return prev;
            }
            return [...prev, strategyName];
        });
    };

    const toggleSelectedStrategyGroup = (strategyItems) => {
        setSelectedStrats(prev => {
            const names = strategyItems.map(s => s.name);
            const allSelected = names.every(n => prev.includes(n));
            if (allSelected) return prev.filter(n => !names.includes(n));
            const remaining = Math.max(0, MAX_BATTLE_STRATEGIES - prev.length);
            if (remaining === 0) {
                notify?.(`Battle selection is capped at ${MAX_BATTLE_STRATEGIES} strategies for speed.`, 'yellow');
                return prev;
            }
            const additions = names.filter(n => !prev.includes(n)).slice(0, remaining);
            if (additions.length < names.filter(n => !prev.includes(n)).length) {
                notify?.(`Added ${additions.length}; cap is ${MAX_BATTLE_STRATEGIES} strategies per battle.`, 'yellow');
            }
            return [...new Set([...prev, ...additions])];
        });
    };

    // Downloader form
    const [tickerInput, setTickerInput] = useState('');
    const [tickerSuggestions, setTickerSuggestions] = useState([]);
    const [freqInput, setFreqInput] = useState('1d');
    const [periodInput, setPeriodInput] = useState('max');
    const [stakeRange, setStakeRange] = useState('10, 50, 95');
    const [showTickerSuggestions, setShowTickerSuggestions] = useState(false);
    const tickerInputRef = useRef(null);
    const tickerDebounceRef = useRef(null);
    const [trailRange, setTrailRange] = useState('0.0, 0.05, 0.15');
    const [syncingTicker, setSyncingTicker] = useState(null);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [initialCash, setInitialCash] = useState('100000');
    const [commission, setCommission] = useState('0.001');
    const [sequential, setSequential] = useState(false);

    // Sync selections to localStorage
    useEffect(() => {
        if (selectedFile) localStorage.setItem('terminal_selected_file', selectedFile);
    }, [selectedFile]);

    const initialLoadDone = useRef(false);

    // Load chart when file selected
    useEffect(() => {
        if (!selectedFile) {
            setChartData(null);
            return;
        }
        // On mount, skip if backtestPayload will load chart directly
        if (!initialLoadDone.current && backtestPayload && backtestPayload.dataset) {
            initialLoadDone.current = true;
            return;
        }
        initialLoadDone.current = true;
        handleView(selectedFile);
        fetchMeta(selectedFile);
    }, [selectedFile]);

    const fetchMeta = async (filename) => {
        try {
            const res = await axios.get(`${DATA_SERVICE}/data/${filename}/meta`);
            if (res.data.start && res.data.end) {
                setStartDate(res.data.start);
                setEndDate(res.data.end);
            }
        } catch (e) {
            console.error("Failed to fetch metadata", e);
        }
    };

    const handleView = async (filename) => {
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
            setChartFileName(filename);
            setChartMarkers([]);
        } catch (e) {
            notify("Error loading chart data", 'red');
        }
        setLoading(false);
    };

    const handleDownload = async () => {
        if (!tickerInput) return;
        setDownloading(true);
        try {
            const res = await axios.post(`${DATA_SERVICE}/download`, {
                tickers: [tickerInput.toUpperCase()],
                period: periodInput,
                interval: freqInput
            });
            onTrigger(res.data.task_id, 'download', `Download: ${tickerInput.toUpperCase()}`);
            notify(`Download quest started for ${tickerInput.toUpperCase()}`, 'blue');
            setShowDownloader(false);
            setTickerInput('');
            setShowTickerSuggestions(false);
        } catch (e) {
            notify("Download initiation failed", 'red');
        }
        setDownloading(false);
    };

    // Search tickers via yfinance backend
    const searchTickers = async (query) => {
        if (!query || query.length < 1) { setTickerSuggestions([]); return; }
        try {
            const res = await axios.get(`${INTELLIGENCE_SERVICE}/search`, { params: { q: query } });
            setTickerSuggestions(res.data.results || []);
        } catch { setTickerSuggestions([]); }
    };

    // Handle ticker input change with debounce
    const handleTickerInputChange = (e) => {
        const value = e.target.value;
        setTickerInput(value);
        if (tickerDebounceRef.current) clearTimeout(tickerDebounceRef.current);
        if (value.length > 0) {
            tickerDebounceRef.current = setTimeout(() => searchTickers(value), 250);
        } else {
            setTickerSuggestions([]);
        }
    };

    // Handle suggestion selection
    const handleSelectSuggestion = (symbol) => {
        setTickerInput(symbol.toUpperCase());
        setTickerSuggestions([]);
        setShowTickerSuggestions(false);
    };

    const syncTaskRef = useRef(null);

    const handleSyncTicker = async (ticker) => {
        setSyncingTicker(ticker);
        try {
            const res = await axios.post(`${DATA_SERVICE}/download`, {
                tickers: [ticker.toUpperCase()],
                period: 'max',
                interval: '1d'
            });
            syncTaskRef.current = res.data.task_id;
            onTrigger(res.data.task_id, 'download', `Sync: ${cleanTicker(ticker)}`);
            notify(`Sync started for ${cleanTicker(ticker)}`, 'blue');
        } catch (e) {
            notify(`Sync failed for ${cleanTicker(ticker)}`, 'red');
        }
        setSyncingTicker(null);
    };

    // Watch for sync task completion and auto-reload chart
    useEffect(() => {
        if (!syncTaskRef.current) return;
        const syncTask = tasks.find(t => t.id === syncTaskRef.current);
        if (syncTask?.status === 'completed') {
            syncTaskRef.current = null;
            onRefreshFiles?.();
            if (selectedFile) {
                setTimeout(() => handleView(selectedFile), 500);
            }
        } else if (syncTask?.status === 'failed' || syncTask?.status?.startsWith?.('failed')) {
            syncTaskRef.current = null;
        }
    }, [tasks]);

    const runBattle = async () => {
        if (!selectedFile || selectedStrats.length === 0) {
            notify("Select a dataset and at least one strategy", 'yellow');
            return;
        }
        if (selectedStrats.length > MAX_BATTLE_STRATEGIES) {
            notify(`Select ${MAX_BATTLE_STRATEGIES} strategies or fewer for one battle. Clear a few or split it into batches.`, 'yellow');
            return;
        }

        setLoading(true);
        try {
            const sRange = stakeRange.split(',').map(s => parseInt(s.trim())).filter(s => !isNaN(s));
            const tRange = trailRange.split(',').map(t => parseFloat(t.trim())).filter(t => !isNaN(t));

            const res = await axios.post(`${BACKTEST_SERVICE}/backtest`, {
                dataset_filename: selectedFile,
                strategies: selectedStrats,
                stake_range: sRange.length ? sRange : null,
                trail_range: tRange.length ? tRange : null,
                start_date: startDate || null,
                end_date: endDate || null,
                sequential: sequential,
                initial_cash: parseFloat(initialCash) || 100000,
                commission: parseFloat(commission) || 0.001
            });
            onTrigger(res.data.task_id, 'backtest', `Battle: ${selectedFile} (${selectedStrats.length} strats)`);
            notify("Hyper-Battle initiated!", 'green');
        } catch (e) {
            notify("Error starting battle", 'red');
        }
        setLoading(false);
    };

    // Find active task for progress visualization
    const activeTask = tasks.find(t => t.type === 'backtest' && t.status === 'running');
    const latestResults = activeTask?.progressData?.partial_results || tasks.find(t => t.type === 'backtest' && t.status === 'completed')?.results;

    const getFileIntervalGroup = (filename) => {
        const clean = (filename || '').split('.')[0];
        const parts = clean.split('-');
        const interval = parts.length >= 3 ? parts[parts.length - 2] : parts[1] || '';
        if (['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h'].includes(interval)) return 'intraday';
        if (interval === '1d') return 'daily';
        if (['1wk', '1mo', '3mo'].includes(interval)) return 'long';
        return 'other';
    };

    const getStrategyIntervalGroup = (strategy) => {
        const name = (strategy?.name || '').toLowerCase();
        const category = (strategy?.category || '').toLowerCase();
        if (category.includes('short interval') || name.includes('scalper') || name.includes('short_')) return 'intraday';
        if (category.includes('daily') || category.includes('swing') || name.includes('swing')) return 'daily';
        if (category.includes('position') || category.includes('long') || category.includes('multi-month') || name.includes('position') || name.includes('buyandhold') || name.includes('sma_cross')) return 'long';
        if (strategy?.is_custom) return 'custom';
        return 'other';
    };

    const intervalMatches = (itemGroup) => (
        intervalFilter === 'all' ||
        itemGroup === intervalFilter ||
        itemGroup === 'custom'
    );

    const selectedStakeCount = stakeRange.split(',').map(s => parseInt(s.trim())).filter(s => !isNaN(s)).length || 3;
    const selectedTrailCount = trailRange.split(',').map(t => parseFloat(t.trim())).filter(t => !isNaN(t)).length || 2;
    const estimatedBattleRuns = selectedStrats.length * selectedStakeCount * selectedTrailCount;

    const intervalFilterOptions = [
        { key: 'all', label: 'All' },
        { key: 'intraday', label: 'Intra' },
        { key: 'daily', label: 'Daily' },
    ];
    const hasLongIntervalItems = files.some(f => getFileIntervalGroup(f) === 'long') ||
        strategies.some(s => getStrategyIntervalGroup(s) === 'long');
    if (hasLongIntervalItems) {
        intervalFilterOptions.push({ key: 'long', label: 'Long' });
    }

    useEffect(() => {
        if (intervalFilter === 'long' && !hasLongIntervalItems) {
            setIntervalFilter('all');
        }
    }, [intervalFilter, hasLongIntervalItems]);

    const filteredFiles = files.filter(f =>
        f.toLowerCase().includes(searchFile.toLowerCase()) &&
        intervalMatches(getFileIntervalGroup(f))
    );
    const filteredStrats = strategies.filter(s =>
        s.name.toLowerCase().includes(searchStrat.toLowerCase()) &&
        intervalMatches(getStrategyIntervalGroup(s))
    );

    // Persist terminal sidebar collapse
    useEffect(() => {
        localStorage.setItem('terminal_sidebar_collapsed', terminalSidebarCollapsed);
    }, [terminalSidebarCollapsed]);

    useEffect(() => {
        localStorage.setItem('terminal_asset_library_collapsed', assetLibraryCollapsed);
    }, [assetLibraryCollapsed]);

    useEffect(() => {
        localStorage.setItem('terminal_strategy_arsenal_collapsed', strategyArsenalCollapsed);
    }, [strategyArsenalCollapsed]);

    useEffect(() => {
        localStorage.setItem('terminal_interval_filter', intervalFilter);
    }, [intervalFilter]);

    useEffect(() => {
        localStorage.setItem('terminal_sidebar_width', String(terminalSidebarWidth));
    }, [terminalSidebarWidth]);

    // Load backtest payload from history
    useEffect(() => {
        if (backtestPayload && backtestPayload.dataset) {
            if (backtestPayload.strategies) {
                const incoming = backtestPayload.strategies.slice(0, MAX_BATTLE_STRATEGIES);
                setSelectedStrats(incoming);
                if (backtestPayload.strategies.length > incoming.length) {
                    notify?.(`Loaded first ${MAX_BATTLE_STRATEGIES} strategies for speed.`, 'yellow');
                }
            }
            if (onClearBacktestPayload) onClearBacktestPayload();
            // Load chart and apply markers directly (bypass handleView to avoid marker clearing)
            (async () => {
                try {
                    setLoading(true);
                    const now = new Date().getTime();
                    const res = await axios.get(`${DATA_SERVICE}/data/${backtestPayload.dataset}?t=${now}`);
                    const parsed = Papa.parse(res.data, {
                        header: true,
                        skipEmptyLines: true,
                        transformHeader: h => h.trim()
                    });
                    setChartData(parsed.data);
                    setChartFileName(backtestPayload.dataset);
                    if (backtestPayload.markers && backtestPayload.markers.length > 0) {
                        setChartMarkers(backtestPayload.markers);
                    } else {
                        setChartMarkers([]);
                    }
                    if (backtestPayload.results) {
                        setLoadedResults(backtestPayload.results);
                        setLoadedSummary(backtestPayload.summary || null);
                    }
                } catch (e) {
                    notify("Error loading chart data", 'red');
                }
                setLoading(false);
            })();
        }
    }, [backtestPayload]);

    const handleDividerMouseDown = useCallback((e) => {
        e.preventDefault();
        isDragging.current = true;
        startX.current = e.clientX;
        startWidth.current = terminalSidebarWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, [terminalSidebarWidth]);

    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!isDragging.current) return;
            const delta = e.clientX - startX.current;
            const newWidth = Math.max(180, Math.min(500, startWidth.current + delta));
            setTerminalSidebarWidth(newWidth);
        };
        const handleMouseUp = () => {
            if (isDragging.current) {
                isDragging.current = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        };
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    const fileGroups = React.useMemo(() => {
        const groups = {};
        for (const f of filteredFiles) {
            const clean = f.split('.')[0];
            const ticker = clean.split('-')[0].toUpperCase();
            if (!groups[ticker]) groups[ticker] = [];
            groups[ticker].push(f);
        }
        return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
    }, [filteredFiles]);

    const stratGroups = React.useMemo(() => {
        const groups = {};
        for (const s of filteredStrats) {
            const cat = s.category || 'General';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(s);
        }
        return Object.entries(groups).sort((a, b) => {
            if (a[0] === 'Uncategorized' || a[0] === 'General') return 1;
            if (b[0] === 'Uncategorized' || b[0] === 'General') return -1;
            return a[0].localeCompare(b[0]);
        });
    }, [filteredStrats]);

    return (
        <div className="terminal-layout">
            {/* Sidebar: Library & Arsenal */}
            <div className={`terminal-sidebar ${terminalSidebarCollapsed ? 'collapsed' : ''}`}
                 style={terminalSidebarCollapsed ? {} : { width: terminalSidebarWidth + 'px', minWidth: terminalSidebarWidth + 'px' }}>
                {!terminalSidebarCollapsed && (
                <>
                <div className="terminal-card" style={{ flex: '0 0 auto', padding: '0.75rem' }}>
                    <div className="terminal-section-title" style={{ marginBottom: '0.6rem' }}>
                        <Filter size={14} /> Interval Filter
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${intervalFilterOptions.length}, 1fr)`, gap: '0.35rem' }}>
                        {intervalFilterOptions.map(opt => (
                            <button
                                key={opt.key}
                                className={`btn btn-xs ${intervalFilter === opt.key ? 'btn-primary' : 'btn-ghost'}`}
                                onClick={() => setIntervalFilter(opt.key)}
                                title={`Filter assets and strategies by ${opt.label}`}
                                style={{ fontSize: '0.68rem', padding: '0.3rem 0.25rem' }}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="terminal-card" style={{ flex: assetLibraryCollapsed ? '0 0 auto' : 1, display: 'flex', flexDirection: 'column' }}>
                    <div
                        className="terminal-section-header"
                        style={{ cursor: 'pointer' }}
                    >
                        <button
                            className="btn btn-ghost btn-xs"
                            type="button"
                            onClick={toggleAssetLibraryCollapsed}
                            title={assetLibraryCollapsed ? 'Expand Asset Library' : 'Collapse Asset Library'}
                            style={{ padding: '4px', marginRight: '0.25rem', minWidth: '24px', height: '24px' }}
                        >
                            <ChevronRight size={12} style={{ transform: assetLibraryCollapsed ? '' : 'rotate(90deg)', transition: 'transform 0.15s' }} />
                        </button>
                        <button
                            type="button"
                            className="terminal-section-title"
                            onClick={toggleAssetLibraryCollapsed}
                            style={{ flex: 1, border: 0, background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                        >
                            <Database size={16} /> Asset Library
                        </button>
                        {intervalFilter !== 'all' && (
                            <span className="badge badge-blue" style={{ fontSize: '0.58rem', marginRight: '0.35rem' }}>{filteredFiles.length}</span>
                        )}
                        <div style={{ display: 'flex', gap: '0.4rem' }} onClick={e => e.stopPropagation()}>
                            {selectFiles && bulkFileSelection.size > 0 && (
                                <button className="btn btn-ghost btn-xs" onClick={() => { if (window.confirm(`Delete ${bulkFileSelection.size} file(s)?`)) { bulkFileSelection.forEach(f => onDeleteFile?.(f)); setBulkFileSelection(new Set()); setSelectFiles(false); } }} title="Delete selected" style={{ color: 'var(--brand-red)' }}>
                                    <X size={12} /> {bulkFileSelection.size}
                                </button>
                            )}
                            <button className={`btn btn-ghost btn-xs ${selectFiles ? 'active' : ''}`} onClick={() => { setSelectFiles(s => !s); setBulkFileSelection(new Set()); }} title="Toggle select mode">
                                <CheckSquare size={12} />
                            </button>
                            <button className="btn btn-ghost btn-xs" onClick={() => setShowDownloader(true)} title="Acquire New Data">
                                <Plus size={12} />
                            </button>
                            <button className="btn btn-ghost btn-xs" onClick={onRefreshFiles} title="Sync Filesystem">
                                <RefreshCw size={12} />
                            </button>
                        </div>
                    </div>
                    {!assetLibraryCollapsed && (
                    <>
                    <div style={{ position: 'relative', marginBottom: '1rem' }}>
                        <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
                        <input
                            className="input"
                            style={{ height: '32px', paddingLeft: '30px', fontSize: '0.8rem' }}
                            placeholder="Filter library..."
                            value={searchFile}
                            onChange={e => setSearchFile(e.target.value)}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        {fileGroups.map(([ticker, items]) => {
                            const isExpanded = expandedFileGroups.has(ticker);
                            const visible = isExpanded ? items : items.slice(0, ITEMS_PER_GROUP);
                            const displayTicker = cleanTicker(ticker);
                            return (
                                <div key={ticker} style={{ marginBottom: '0.25rem' }}>
                                    <div
                                        onClick={(e) => handleFileGroupToggle(e, ticker)}
                                        style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.4rem', cursor: 'pointer', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 600, background: 'var(--bg-accent)', marginBottom: '2px' }}
                                    >
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-xs"
                                            onClick={(e) => handleFileGroupToggle(e, ticker)}
                                            title={isExpanded ? `Collapse ${displayTicker}` : `Expand ${displayTicker}`}
                                            style={{ padding: '1px', minWidth: '16px', height: '16px' }}
                                        >
                                            <ChevronRight size={12} style={{ transform: isExpanded ? 'rotate(90deg)' : '', transition: 'transform 0.15s', opacity: 0.5 }} />
                                        </button>
                                        {displayTicker}
                                        <span style={{ fontSize: '0.65rem', opacity: 0.5, fontWeight: 400 }}>({items.length})</span>
                                        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.2rem' }}>
                                            <button
                                                className="btn btn-ghost btn-xs"
                                                title="Download/sync data (Daily · Max)"
                                                onClick={e => { e.stopPropagation(); handleSyncTicker(ticker); }}
                                                disabled={syncingTicker === ticker}
                                                style={{ padding: '2px' }}
                                            >
                                                {syncingTicker === ticker ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                                            </button>
                                        </div>
                                    </div>
                                    {visible.map(f => {
                                        const clean = f.replace('.txt', '');
                                        const parts = clean.split('-');
                                        const interval = parts.length >= 3 ? parts[parts.length - 2] : '';
                                        const range = parts.length >= 3 ? parts[parts.length - 1] : '';
                                        const freqLabel = interval === '1d' ? 'Daily' : interval === '1m' ? '1-Min' : interval === '5m' ? '5-Min' : interval;
                                        return (
                                        <div
                                            key={f}
                                            className={`list-item ${selectedFile === f ? 'selected' : ''}`}
                                            onClick={() => setSelectedFile(f)}
                                            style={{ padding: '0.25rem 0.4rem 0.25rem 1.2rem', display: 'flex', alignItems: 'center' }}
                                            title={f}
                                        >
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div className="list-item-title" style={{ fontSize: '0.72rem' }}>{freqLabel} · {range || interval}</div>
                                                <div className="list-item-meta" style={{ fontSize: '0.6rem' }}>{interval}</div>
                                            </div>
                                            <button
                                                className="btn btn-ghost btn-xs"
                                                title={`Delete ${f}`}
                                                onClick={e => { e.stopPropagation(); if (onDeleteFile) onDeleteFile(f); }}
                                                style={{ padding: '2px', opacity: 0.4, flexShrink: 0 }}
                                            >
                                                <X size={10} />
                                            </button>
                                        </div>
                                    )})}
                                </div>
                            );
                        })}
                    </div>
                    </>
                    )}
                </div>

                <div className="terminal-card" style={{ flex: strategyArsenalCollapsed ? '0 0 auto' : 1, display: 'flex', flexDirection: 'column' }}>
                    <div
                        className="terminal-section-header"
                        style={{ cursor: 'pointer' }}
                    >
                        <button
                            className="btn btn-ghost btn-xs"
                            type="button"
                            onClick={toggleStrategyArsenalCollapsed}
                            title={strategyArsenalCollapsed ? 'Expand Strategy Arsenal' : 'Collapse Strategy Arsenal'}
                            style={{ padding: '4px', marginRight: '0.25rem', minWidth: '24px', height: '24px' }}
                        >
                            <ChevronRight size={12} style={{ transform: strategyArsenalCollapsed ? '' : 'rotate(90deg)', transition: 'transform 0.15s' }} />
                        </button>
                        <button
                            type="button"
                            className="terminal-section-title"
                            onClick={toggleStrategyArsenalCollapsed}
                            style={{ flex: 1, border: 0, background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                        >
                            <ShieldCheck size={16} /> Strategy Arsenal
                        </button>
                        {intervalFilter !== 'all' && (
                            <span className="badge badge-blue" style={{ fontSize: '0.58rem', marginRight: '0.35rem' }}>{filteredStrats.length}</span>
                        )}
                        <div style={{ display: 'flex', gap: '0.4rem' }} onClick={e => e.stopPropagation()}>
                            {selectStrats && bulkStratSelection.size > 0 && (
                                <button className="btn btn-ghost btn-xs" onClick={() => { if (window.confirm(`Delete ${bulkStratSelection.size} strategy(s)?`)) { bulkStratSelection.forEach(n => onDeleteStrategy?.(n)); setBulkStratSelection(new Set()); setSelectStrats(false); } }} title="Delete selected" style={{ color: 'var(--brand-red)' }}>
                                    <X size={12} /> {bulkStratSelection.size}
                                </button>
                            )}
                            <button className={`btn btn-ghost btn-xs ${selectStrats ? 'active' : ''}`} onClick={() => { setSelectStrats(s => !s); setBulkStratSelection(new Set()); }} title="Toggle select mode">
                                <CheckSquare size={12} />
                            </button>
                            <button className="btn btn-ghost btn-xs" onClick={() => onSwitchTab('studio')} title="Generate Strategy Logic">
                                <Plus size={12} />
                            </button>
                            <button className="btn btn-ghost btn-xs" onClick={onRefreshStrats} title="Refurbish Arsenal">
                                <RefreshCw size={12} />
                            </button>
                        </div>
                    </div>
                    {!strategyArsenalCollapsed && (
                    <>
                    <div style={{ position: 'relative', marginBottom: '1rem' }}>
                        <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
                        <input
                            className="input"
                            style={{ height: '32px', paddingLeft: '30px', fontSize: '0.8rem' }}
                            placeholder="Search arsenal..."
                            value={searchStrat}
                            onChange={e => setSearchStrat(e.target.value)}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        {stratGroups.map(([cat, items]) => {
                            const isExpanded = expandedStratGroups.has(cat);
                            const visible = isExpanded ? items : items.slice(0, ITEMS_PER_GROUP);
                            return (
                                <div key={cat} style={{ marginBottom: '0.25rem' }}>
                                    <div
                                        onClick={(e) => handleStratGroupToggle(e, cat)}
                                        style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.4rem', cursor: 'pointer', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 600, background: 'var(--bg-accent)', marginBottom: '2px' }}
                                    >
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-xs"
                                            onClick={(e) => handleStratGroupToggle(e, cat)}
                                            title={isExpanded ? `Collapse ${cat}` : `Expand ${cat}`}
                                            style={{ padding: '1px', minWidth: '16px', height: '16px' }}
                                        >
                                            <ChevronRight size={12} style={{ transform: isExpanded ? 'rotate(90deg)' : '', transition: 'transform 0.15s', opacity: 0.5 }} />
                                        </button>
                                        {cat}
                                        <span style={{ fontSize: '0.65rem', opacity: 0.5, fontWeight: 400 }}>({items.length})</span>
                                        <button
                                            className="btn btn-ghost btn-xs"
                                            title="Select all in category"
                                            onClick={e => { e.stopPropagation(); toggleSelectedStrategyGroup(items); }}
                                            style={{ padding: '2px', marginLeft: 'auto' }}
                                        >
                                            <CheckSquare size={10} />
                                        </button>
                                    </div>
                                    {visible.map(s => (
                                        <div
                                            key={s.name}
                                            className={`list-item ${selectedStrats.includes(s.name) ? 'selected' : ''}`}
                                            onClick={() => {
                                                if (selectStrats) {
                                                    setBulkStratSelection(prev => { const n = new Set(prev); n.has(s.name) ? n.delete(s.name) : n.add(s.name); return n; });
                                                } else {
                                                    toggleSelectedStrategy(s.name);
                                                }
                                            }}
                                            style={{ padding: '0.25rem 0.4rem 0.25rem 1.2rem' }}
                                        >
                                            {selectStrats && (
                                                <input type="checkbox" checked={bulkStratSelection.has(s.name)} onChange={() => {}} style={{ marginRight: '0.3rem' }} />
                                            )}
                                            <div>
                                                <div className="list-item-title" style={{ fontSize: '0.72rem' }}>{s.name}</div>
                                                {s.ticker && <div style={{ fontSize: '0.6rem', color: 'var(--brand-blue)' }}>{s.ticker}</div>}
                                            </div>
                                            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                                <div className="list-item-meta" style={{ fontSize: '0.6rem' }}>{s.is_custom ? 'AI' : 'Def'}</div>
                                                {s.is_custom && (
                                                    <button
                                                        className="btn btn-ghost btn-xs"
                                                        title="Delete strategy"
                                                        onClick={e => { e.stopPropagation(); if (window.confirm(`Delete strategy "${s.name}"?`)) onDeleteStrategy?.(s.name); }}
                                                        style={{ padding: '1px', color: 'var(--brand-red)', opacity: 0.6 }}
                                                    >
                                                        <X size={10} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                    {selectedStrats.length > 0 && (
                        <button className="btn btn-ghost btn-xs" style={{ marginTop: '0.5rem' }} onClick={() => setSelectedStrats([])}>
                            Clear Selected ({selectedStrats.length})
                        </button>
                    )}
                    </>
                    )}
                </div>
                </>
                )}
            </div>

            {/* Draggable Divider */}
            <div
                className="terminal-divider"
                onMouseDown={handleDividerMouseDown}
                onClick={() => setTerminalSidebarCollapsed(!terminalSidebarCollapsed)}
                title={terminalSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
                <ChevronLeft size={12} style={{ transform: terminalSidebarCollapsed ? 'rotate(180deg)' : 'none' }} />
            </div>

            {/* Main Section */}
            <div className="terminal-main">
                {/* Visualizer Panel */}
                <div className="terminal-card" style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'visible' }}>
                    {chartData ? (
                        <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center', opacity: 0.6 }}>Loading chart...</div>}>
                          <ChartViewer
                              data={chartData}
                              markers={chartMarkers}
                              fileName={chartFileName}
                              allFiles={files}
                              height={650}
                              onClose={() => setChartData(null)}
                              externalStartDate={startDate}
                              externalEndDate={endDate}
                          />
                        </Suspense>
                    ) : (
                        <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', opacity: 0.3 }}>
                            <Activity size={48} />
                            <p style={{ marginTop: '1rem' }}>Select an asset to visualize market flow</p>
                        </div>
                    )}
                </div>

                {activeTask && (
                    <div className="terminal-card" style={{ border: '1px solid rgba(59,130,246,0.4)' }}>
                        <div style={{ padding: '0.75rem 1rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <RefreshCw className="animate-spin" size={14} style={{ color: 'var(--brand-blue)' }} />
                                    <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>Battle in Progress</span>
                                </div>
                                <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>{activeTask.progressData?.progress || 0}%</span>
                            </div>
                            <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '4px', overflow: 'hidden', marginBottom: '0.5rem' }}>
                                <motion.div
                                    initial={{ width: 0 }}
                                    animate={{ width: `${activeTask.progressData?.progress || 0}%` }}
                                    transition={{ type: 'tween', duration: 0.4, ease: 'easeOut' }}
                                    style={{ height: '100%', background: 'var(--brand-blue)', borderRadius: '4px', boxShadow: '0 0 8px var(--brand-blue)' }}
                                />
                            </div>
                            <div style={{ fontSize: '0.78rem', opacity: 0.7 }}>{activeTask.progressData?.current || 'Initializing...'}</div>
                            {activeTask.progressData?.partial_results?.length > 0 && (
                                <div style={{ marginTop: '0.75rem', fontSize: '0.72rem' }}>
                                    <div style={{ fontWeight: 600, marginBottom: '0.35rem', opacity: 0.6 }}>Partial Results ({activeTask.progressData.partial_results.length})</div>
                                    {activeTask.progressData.partial_results.slice(0, 5).map((r, i) => (
                                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.2rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                            <span>{r.strategy}</span>
                                            <span style={{ color: r.roi >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>{r.roi?.toFixed(2)}%</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Configuration & Launch Panel */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '1.5rem' }}>
                    <div className="terminal-card">
                        <div className="terminal-section-title" style={{ marginBottom: '1.5rem' }}><Zap size={16} /> Battle Parameters</div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Stake Optimization Range (%)</label>
                                <input className="input" style={{ height: '40px' }} value={stakeRange} onChange={e => setStakeRange(e.target.value)} />
                            </div>
                            <div className="form-group">
                                <label>T-Stop Matrix (%)</label>
                                <input className="input" style={{ height: '40px' }} value={trailRange} onChange={e => setTrailRange(e.target.value)} />
                            </div>
                        </div>
                        <div className="form-row" style={{ marginTop: '1rem' }}>
                            <div className="form-group">
                                <label>Start Date</label>
                                <input type="date" className="input" style={{ height: '40px' }} value={startDate} onChange={e => setStartDate(e.target.value)} />
                            </div>
                            <div className="form-group">
                                <label>End Date</label>
                                <input type="date" className="input" style={{ height: '40px' }} value={endDate} onChange={e => setEndDate(e.target.value)} />
                            </div>
                        </div>
                        <div className="form-row" style={{ marginTop: '1rem' }}>
                            <div className="form-group">
                                <label>Initial Capital ($)</label>
                                <input type="number" className="input" style={{ height: '40px' }} value={initialCash} onChange={e => setInitialCash(e.target.value)} min="1000" step="1000" />
                            </div>
                            <div className="form-group">
                                <label>Commission (decimal)</label>
                                <input type="number" className="input" style={{ height: '40px' }} value={commission} onChange={e => setCommission(e.target.value)} min="0" step="0.001" max="1" />
                            </div>
                        </div>
                        <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <input type="checkbox" id="seq-check" checked={sequential} onChange={e => setSequential(e.target.checked)} />
                            <label htmlFor="seq-check" style={{ fontSize: '0.85rem', opacity: 0.8 }}>Sequential Execution (Low Resource Mode)</label>
                        </div>
                    </div>

                    <div className="terminal-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', border: '1px solid var(--brand-blue)' }}>
                        {/* Selection Visualizer */}
                        {selectedFile && (
                            <div style={{ padding: '0.65rem', background: 'var(--bg-accent)', borderRadius: 'var(--radius)', fontSize: '0.75rem' }}>
                                <div style={{ fontWeight: 700, fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.5, marginBottom: '0.35rem' }}>Target</div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{(() => { 
                                        const parts = selectedFile.split('-');
                                        return parts[0].toUpperCase();
                                    })()}</span>
                                    <span className="badge badge-blue" style={{ fontSize: '0.6rem' }}>
                                        {(() => {
                                            const parts = selectedFile.split('-');
                                            const interval = parts[1] || '';
                                            return interval === '1d' ? 'Daily' : interval === '1m' ? '1-Min' : interval || '';
                                        })()}
                                    </span>
                                    <span className="badge badge-green" style={{ fontSize: '0.6rem', marginLeft: 'auto' }}>
                                        {(() => {
                                            const parts = selectedFile.split('.')[0].split('-');
                                            return parts.length > 2 ? parts.slice(2).join('-').charAt(0).toUpperCase() + parts.slice(2).join('-').slice(1) : '';
                                        })()}
                                    </span>
                                </div>
                            </div>
                        )}
                        {selectedStrats.length > 0 && (
                            <div style={{ padding: '0.65rem', background: 'var(--bg-accent)', borderRadius: 'var(--radius)', fontSize: '0.75rem' }}>
                                <div style={{ fontWeight: 700, fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.5, marginBottom: '0.35rem' }}>Strategies ({selectedStrats.length}/{MAX_BATTLE_STRATEGIES})</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                                    {selectedStrats.slice(0, MAX_BATTLE_STRATEGIES).map(s => (
                                        <span key={s} style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem', background: 'rgba(255,255,255,0.08)', borderRadius: '4px', color: 'rgba(255,255,255,0.8)' }}>{s.length > 18 ? s.slice(0, 16) + '…' : s}</span>
                                    ))}
                                    {selectedStrats.length > MAX_BATTLE_STRATEGIES && (
                                        <span style={{ fontSize: '0.6rem', opacity: 0.5 }}>+{selectedStrats.length - MAX_BATTLE_STRATEGIES} more</span>
                                    )}
                                </div>
                                <div style={{ marginTop: '0.45rem', fontSize: '0.64rem', opacity: 0.55 }}>
                                    Estimated optimization runs: {estimatedBattleRuns}
                                </div>
                            </div>
                        )}
                        {selectedStrats.length >= MAX_BATTLE_STRATEGIES && (
                            <div style={{ padding: '0.55rem 0.65rem', borderRadius: 'var(--radius)', background: 'rgba(245,158,11,0.09)', border: '1px solid rgba(245,158,11,0.2)', color: 'var(--brand-yellow)', fontSize: '0.68rem', lineHeight: 1.35 }}>
                                Max {MAX_BATTLE_STRATEGIES} strategies per battle for speed. Split larger comparisons into batches.
                            </div>
                        )}
                        <button
                            className="btn btn-primary"
                            style={{ height: '64px', fontSize: '1.1rem' }}
                            onClick={runBattle}
                            disabled={loading || activeTask}
                        >
                            {activeTask ? <RefreshCw className="animate-spin" /> : <Play size={18} />}
                            {activeTask ? 'Battle Underway' : 'Commence Battle'}
                        </button>
                    </div>
                </div>

                {/* Live Results Panel */}
                {(activeTask || latestResults || loadedResults) && (
                    <div className="terminal-card">
                        <div className="terminal-section-header">
                            <div className="terminal-section-title"><TrendingUp size={16} /> {activeTask ? 'Live Battle Feed' : loadedResults ? 'Pre-loaded Results' : 'Latest Battle Summary'}</div>
                            {activeTask && <div className="badge badge-blue">Processing {activeTask.progressData?.progress}%</div>}
                            {loadedSummary && <div className="badge badge-green">Best: {loadedSummary.best_strategy} ({loadedSummary.best_roi.toFixed(2)}%)</div>}
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                            <table className="table" style={{ marginTop: 0 }}>
                                <thead>
                                    <tr><th>Strategy</th><th>ROI</th><th>Sharpe</th><th>Trades</th><th>Win Rate</th><th>Actions</th></tr>
                                </thead>
                                <tbody>
                                    {(latestResults || loadedResults || []).map(r => (
                                        <tr key={r.strategy}>
                                            <td style={{ fontWeight: 'bold' }}>
                                                {r.strategy}
                                                {(r.statistics?.total_trades || 0) === 0 && (
                                                    <span className="badge badge-yellow" style={{ marginLeft: '0.45rem', fontSize: '0.62rem' }}>No trades</span>
                                                )}
                                            </td>
                                            <td style={{ color: r.roi >= 0 ? 'var(--brand-green)' : 'var(--brand-red)' }}>{r.roi.toFixed(2)}%</td>
                                            <td>{r.statistics?.sharpe_ratio || 'N/A'}</td>
                                            <td>{(r.statistics?.total_trades || 0) === 0 ? '0 - inactive' : r.statistics?.total_trades}</td>
                                            <td>{r.statistics?.win_rate || 0}%</td>
                                            <td>
                                                <button
                                                    className="btn btn-ghost btn-xs"
                                                    onClick={() => {
                                                        setChartMarkers(r.markers);
                                                        window.scrollTo({ top: 0, behavior: 'smooth' });
                                                    }}
                                                >
                                                    View Chart
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>

            {/* Downloader Modal */}
            <AnimatePresence>
                {showDownloader && (
                    <div className="modal-overlay" onClick={() => setShowDownloader(false)}>
                        <motion.div
                            className="terminal-card"
                            style={{ width: '400px', padding: '2rem' }}
                            initial={{ scale: 0.9, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.9, opacity: 0 }}
                            onClick={e => e.stopPropagation()}
                        >
                            <div className="terminal-layout-header" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
                                <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Acquire Market Data</h2>
                                <button className="btn btn-ghost btn-xs" onClick={() => setShowDownloader(false)}><X size={16} /></button>
                            </div>

                            <div className="form-group" style={{ marginBottom: '1rem', position: 'relative' }}>
                                <label>Symbol (AAPL, TSLA, BTC-USD)</label>
                                <input
                                    ref={tickerInputRef}
                                    className="input"
                                    value={tickerInput}
                                    onChange={handleTickerInputChange}
                                    onFocus={() => { if (tickerInput.length > 0) { setShowTickerSuggestions(true); searchTickers(tickerInput); } }}
                                    onBlur={() => setTimeout(() => setShowTickerSuggestions(false), 150)}
                                    placeholder="Search any ticker..."
                                    autoFocus
                                    style={{ position: 'relative', zIndex: 10 }}
                                />
                                {showTickerSuggestions && tickerSuggestions.length > 0 && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -5 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -5 }}
                                        transition={{ duration: 0.15 }}
                                        style={{
                                            position: 'absolute',
                                            top: '100%',
                                            left: 0,
                                            right: 0,
                                            background: 'var(--card-bg)',
                                            border: '1px solid rgba(255,255,255,0.1)',
                                            borderRadius: '8px',
                                            marginTop: '4px',
                                            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                                            zIndex: 1000,
                                            maxHeight: '240px',
                                            overflowY: 'auto',
                                        }}
                                    >
                                        {tickerSuggestions.map((item, idx) => (
                                            <div
                                                key={idx}
                                                onMouseDown={() => handleSelectSuggestion(item.symbol)}
                                                style={{
                                                    padding: '0.65rem 1rem',
                                                    cursor: 'pointer',
                                                    borderBottom: idx < tickerSuggestions.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                                                    transition: 'background 0.15s',
                                                }}
                                                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                            >
                                                <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{item.symbol}</div>
                                                <div style={{ fontSize: '0.75rem', opacity: 0.65, marginTop: '2px' }}>{item.name}</div>
                                            </div>
                                        ))}
                                    </motion.div>
                                )}
                            </div>

                            <div className="form-row">
                                <div className="form-group">
                                    <label>Frequency</label>
                                    <select className="input" value={freqInput} onChange={e => setFreqInput(e.target.value)}>
                                        <option value="1m">1 Minute</option>
                                        <option value="5m">5 Minutes</option>
                                        <option value="1h">1 Hour</option>
                                        <option value="1d">1 Day</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>Period</label>
                                    <select className="input" value={periodInput} onChange={e => setPeriodInput(e.target.value)}>
                                        <option value="1d">1 Day</option>
                                        <option value="5d">5 Days</option>
                                        <option value="1mo">1 Month</option>
                                        <option value="1y">1 Year</option>
                                        <option value="max">Max</option>
                                    </select>
                                </div>
                            </div>

                            <button
                                className="btn btn-primary"
                                style={{ width: '100%', marginTop: '2rem', height: '48px' }}
                                onClick={handleDownload}
                                disabled={downloading || !tickerInput}
                            >
                                {downloading ? <Loader2 className="animate-spin" /> : <Download size={18} />}
                                {downloading ? 'Connecting to Exchange...' : 'Initialize Download'}
                            </button>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default TradingTerminal;
