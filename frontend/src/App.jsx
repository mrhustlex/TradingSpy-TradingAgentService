import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import axios from 'axios';
import {
  Database,
  Play,
  List,
  Activity,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Wand2,
  Sparkles,
  Layers,
  ShieldCheck,
  Sun,
  Moon,
  Zap,
  Settings as SettingsIcon,
  MessageSquare,
  Menu,
  X,
  Eye,
  ChevronLeft,
  ArrowUpDown,
  Square,
  Trash2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Papa from 'papaparse';
import AIForge from './components/AIForge';
import AIStrategyStudio from './components/AIStrategyStudio';
// import AgenticImprovement from './components/AgenticImprovement';
import BacktestingPanel from './components/BacktestingPanel';
import MarketDataHub from './components/MarketDataHub';
import ResultsHistory from './components/ResultsHistory';
import StrategyLibrary from './components/StrategyLibrary';
import TradingTerminal from './components/TradingTerminal';
import ChatBot from './components/ChatBot';
import SharedChatViewer from './components/SharedChatViewer';
import APITab from './components/APITab';
import SectorHeatmap from './components/SectorHeatmap';
import IndustryMovements from './components/IndustryMovements';
import InsiderTrades from './components/InsiderTrades';

// Lazy load ChartViewer to prevent lightweight-charts bundling issues
const ChartViewer = lazy(() => import('./components/ChartViewer'));
import Settings from './components/Settings';
import { API_BASE, DATA_SERVICE, BACKTEST_SERVICE, SETTINGS_URL } from './config';

const AGENT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'stale']);
const normalizeSupportedProvider = (provider) => {
  const p = (provider || 'google_ai_studio').trim().toLowerCase().replace(/[-\s]/g, '_');
  if (p === 'googleaistudio' || p === 'google_ai' || p === 'gemini') return 'google_ai_studio';
  if (p === 'lite_llm' || p === 'lite') return 'litellm';
  return ['google_ai_studio', 'mistral', 'openrouter', 'litellm', 'ollama'].includes(p) ? p : 'google_ai_studio';
};
const isSupportedProviderInput = (provider) => {
  const p = (provider || '').trim().toLowerCase().replace(/[-\s]/g, '_');
  let normalized = p === 'googleaistudio' || p === 'google_ai' || p === 'gemini' ? 'google_ai_studio' : p;
  if (normalized === 'lite_llm' || normalized === 'lite') normalized = 'litellm';
  return ['google_ai_studio', 'mistral', 'openrouter', 'litellm', 'ollama'].includes(normalized);
};
const isAgentTerminal = (status) => AGENT_TERMINAL_STATUSES.has(status);
const formatAgentElapsed = (seconds) => {
  const total = Math.max(0, Number(seconds || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
};
const agentStatusColor = (status) => {
  if (status === 'completed') return 'var(--brand-green)';
  if (status === 'failed') return 'var(--brand-red)';
  if (status === 'stopped' || status === 'stale') return 'var(--brand-yellow)';
  return 'var(--brand-blue)';
};

const App = () => {
  // Check if we're on a shared chat route
  const isSharedChatRoute = window.location.pathname.startsWith('/shared/');
  const shareId = isSharedChatRoute ? window.location.pathname.split('/shared/')[1] : null;

  // If we're viewing a shared chat, render only the shared chat viewer
  if (isSharedChatRoute && shareId) {
    return <SharedChatViewer shareId={shareId} />;
  }

  const [activeTab, setActiveTab] = useState(() => {
    const storedTab = localStorage.getItem('activeTab') || 'heatmap';
    if (storedTab === 'api') return 'heatmap';
    return storedTab === 'ai' ? 'studio' : storedTab;
  });
  const [showLegacyGenerator, setShowLegacyGenerator] = useState(false);
  const [files, setFiles] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [watchedTickers, setWatchedTickers] = useState([]);
  const [previewData, setPreviewData] = useState(null);
  const [previewFilename, setPreviewFilename] = useState('');
  const [fetchTimestamp, setFetchTimestamp] = useState(0);
  const [tasks, setTasks] = useState([]);
  const [agentRuns, setAgentRuns] = useState([]);
  const [agentMonitorError, setAgentMonitorError] = useState('');
  const [isTaskCenterOpen, setIsTaskCenterOpen] = useState(false);
  const taskCenterTimeout = useRef(null);
  const [notifications, setNotifications] = useState([]);
  const [previewMarkers, setPreviewMarkers] = useState([]);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [selectedTickerForBacktest, setSelectedTickerForBacktest] = useState(null);
  const [backtestPayload, setBacktestPayload] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(localStorage.getItem('sidebar_collapsed') === 'true');
  const [assistantPrompt, setAssistantPrompt] = useState(null);

  // Handler to switch to Battle Station with a specific ticker
  const handleBacktestTicker = (ticker) => {
    setSelectedTickerForBacktest(ticker);
    setActiveTab('terminal');
  };

  // Handler to view chart for a ticker
  const handleViewChart = (ticker) => {
    // Find daily data for this ticker
    const tickerFiles = files.filter(f => f.toLowerCase().startsWith(ticker.toLowerCase() + '-'));
    if (tickerFiles.length > 0) {
      const dailyFile = tickerFiles.find(f => f.includes('-1d-')) || tickerFiles[0];
      handlePreview(dailyFile);
      setActiveTab('data');
    } else {
      notify(`No data found for ${ticker}. Download it first from Data Hub.`, 'yellow');
    }
  };

  const explainWithAssistant = (prompt, label = 'Explain this view') => {
    setAssistantPrompt({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, prompt, label });
    setActiveTab('chat');
    setIsSidebarOpen(false);
    notify(label, 'blue');
  };

  // Apply theme to body data attribute
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Persist active tab
  useEffect(() => {
    if (activeTab === 'api') {
      setActiveTab('heatmap');
      return;
    }
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  // Persist sidebar collapse state
  useEffect(() => {
    localStorage.setItem('sidebar_collapsed', sidebarCollapsed);
  }, [sidebarCollapsed]);


  const notify = (message, type = 'blue') => {
    const id = Math.random().toString(36).substr(2, 9);
    setNotifications(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  };

  // Refresh data list
  const fetchFiles = async () => {
    try {
      const res = await axios.get(`${DATA_SERVICE}/files`);
      setFiles(res.data.files);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteStrategy = async (name) => {
    try {
      await axios.delete(`${BACKTEST_SERVICE}/strategies/${encodeURIComponent(name)}`);
      notify(`${name} deleted`, 'success');
      fetchStrategies();
    } catch (e) {
      notify(e.response?.data?.detail || 'Delete failed', 'error');
    }
  };

  const fetchStrategies = async () => {
    try {
      const res = await axios.get(`${BACKTEST_SERVICE}/strategies`);
      setStrategies(res.data.strategies);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchWatchlist = async () => {
    try {
      const res = await axios.get(`${DATA_SERVICE}/watch`);
      setWatchedTickers(res.data.watched_tickers);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchFiles();
    fetchStrategies();
    fetchWatchlist();
  }, []);

  const mergeAgentRun = (run) => {
    if (!run?.run_id) return;
    setAgentRuns(prev => {
      const next = [run, ...prev.filter(item => item.run_id !== run.run_id)];
      return next
        .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))
        .slice(0, 12);
    });
  };

  const fetchAgentRuns = async () => {
    try {
      const res = await axios.get(`${API_BASE}/agent/runs`, { params: { limit: 12, include_terminal: true } });
      setAgentRuns(res.data?.runs || []);
      setAgentMonitorError('');
    } catch (e) {
      setAgentMonitorError('Agent monitor unavailable');
    }
  };

  useEffect(() => {
    fetchAgentRuns();
    const interval = setInterval(fetchAgentRuns, 1500);
    return () => clearInterval(interval);
  }, []);

  const stopAgentFromMonitor = async (runId) => {
    if (!runId) return;
    const stoppedAt = new Date().toISOString();
    setAgentRuns(prev => prev.map(run => run.run_id === runId ? { ...run, status: 'stopped', current_step: 'Stop requested', updated_at: stoppedAt } : run));
    try {
      await axios.post(`${API_BASE}/agent/runs/${runId}/stop`);
      const res = await axios.get(`${API_BASE}/agent/runs/${runId}`);
      mergeAgentRun(res.data);
      notify('Agent stop requested', 'blue');
    } catch (e) {
      notify('Failed to stop agent run', 'red');
      fetchAgentRuns();
    }
  };

  const deleteAgentRun = async (runId) => {
    if (!runId) return;
    setAgentRuns(prev => prev.filter(run => run.run_id !== runId));
    try {
      await axios.delete(`${API_BASE}/agent/runs/${runId}`);
      notify('Agent run deleted', 'blue');
    } catch (e) {
      if (e.response?.status === 404) return;  // already gone, UI is correct
      notify('Failed to delete agent run', 'red');
      fetchAgentRuns();
    }
  };

  const clearTerminalAgentRuns = async () => {
    const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'error']);
    setAgentRuns(prev => prev.filter(run => !terminalStatuses.has(run.status)));
    try {
      const res = await axios.delete(`${API_BASE}/agent/runs`);
      notify(res.data?.message || 'Cleared completed agent runs', 'blue');
    } catch (e) {
      notify('Failed to clear agent runs', 'red');
      fetchAgentRuns();
    }
  };

  useEffect(() => {
    axios.get(SETTINGS_URL)
      .then(res => {
        const provider = res.data?.default_provider;
        const model = res.data?.default_model;
        localStorage.setItem('settings_default_provider', normalizeSupportedProvider(provider));
        localStorage.setItem('settings_default_model', isSupportedProviderInput(provider) && model ? model : 'gemini-2.5-flash');
      })
      .catch(() => {});
  }, []);

  // Poll for background task statuses
  useEffect(() => {
    const interval = setInterval(async () => {
      const updatedTasks = await Promise.all(tasks.map(async (task) => {
        if (task.status === 'completed' || task.status.startsWith('failed')) return task;

        try {
          const serviceUrl = (task.type === 'download' || task.type === 'sync') ? DATA_SERVICE : BACKTEST_SERVICE;
          const endpoint = (task.type === 'download' || task.type === 'sync') ? `/task/${task.id}` : `/results/${task.id}`;

          const res = await axios.get(`${serviceUrl}${endpoint}`);

          if (res.data.status === 'completed') {
            if (task.type === 'download') fetchFiles();
            return {
              ...task,
              status: 'completed',
              results: res.data.results,
              saved_names: res.data.saved_names,
              progressData: res.data,
              dataset_filename: res.data.dataset_filename
            };
          } else if (res.data.status && res.data.status.toString().startsWith('failed')) {
            return { ...task, status: res.data.status, error: res.data.error || res.data.detail || '' };
          } else if (res.data.status === 'running') {
            return {
              ...task,
              status: 'running',
              progressData: res.data,
              dataset_filename: res.data.dataset_filename
            };
          }
        } catch (e) {
          console.error("Error polling task:", e);
        }
        return task;
      }));

      setTasks(updatedTasks);
    }, 1000);

    return () => clearInterval(interval);
  }, [tasks]);


  // Removed Login Screen for local monolith


  const addTask = (id, type, description) => {
    setTasks(prev => [{ id, type, description, status: 'running', timestamp: new Date() }, ...prev]);
  };

  const handlePreview = async (filename) => {
    try {
      console.log('Loading preview for:', filename); // Debug log
      const now = new Date().getTime();
      const res = await axios.get(`${DATA_SERVICE}/data/${filename}?t=${now}`);
      const parsed = Papa.parse(res.data, {
        header: true,
        skipEmptyLines: true,
        transformHeader: h => h.trim() // Vital for matching Date/Open/etc
      });

      setPreviewData(parsed.data);
      setPreviewFilename(filename);
      setPreviewMarkers([]); // Clear markers when opening raw data
      setFetchTimestamp(now);
    } catch (e) {
      console.error("Error loading preview:", e);
      alert(`Error loading preview: ${e.response?.data?.detail || e.message}`);
    }
  };

  const handleDelete = async (filename) => {
    if (!window.confirm(`Are you sure you want to delete ${filename}?`)) return;
    try {
      await axios.delete(`${DATA_SERVICE}/data/${filename}`);
      fetchFiles();
      if (previewFilename === filename) {
        setPreviewData(null);
        setPreviewFilename('');
      }
    } catch (e) {
      alert("Error deleting file");
    }
  };

  const activeAgentRuns = agentRuns.filter(run => !isAgentTerminal(run.status));
  const runningTaskCount = tasks.filter(t => t.status === 'running').length;
  const taskCenterCount = runningTaskCount + activeAgentRuns.length;

  return (
    <div className="dashboard">
      <div className={`sidebar ${isSidebarOpen ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">
            <Layers size={24} />
            <span className="sidebar-label">Trading Spy</span>
          </div>
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <ChevronLeft size={16} style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none' }} />
          </button>
        </div>

        <nav>
          <div className={`nav-link ${activeTab === 'heatmap' ? 'active' : ''}`} onClick={() => { setActiveTab('heatmap'); setIsSidebarOpen(false); }}>
            <Layers size={20} /> <span className="sidebar-label">Market Overview</span>
          </div>
          <div className={`nav-link ${activeTab === 'movements' ? 'active' : ''}`} onClick={() => { setActiveTab('movements'); setIsSidebarOpen(false); }}>
            <ArrowUpDown size={20} /> <span className="sidebar-label">Movements</span>
          </div>
          <div className={`nav-link ${activeTab === 'terminal' ? 'active' : ''}`} onClick={() => { setActiveTab('terminal'); setIsSidebarOpen(false); }}>
            <Zap size={20} /> <span className="sidebar-label">Battle Station</span>
          </div>
          <div className={`nav-link ${activeTab === 'studio' ? 'active' : ''}`} onClick={() => { setActiveTab('studio'); setIsSidebarOpen(false); }}>
            <Sparkles size={20} color="var(--brand-yellow)" /> <span className="sidebar-label">AI Strategy Studio</span>
          </div>
          <div className={`nav-link ${activeTab === 'history' ? 'active' : ''}`} onClick={() => { setActiveTab('history'); setIsSidebarOpen(false); }}>
            <List size={20} /> <span className="sidebar-label">Backtest History</span>
          </div>
          <div className={`nav-link ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => { setActiveTab('chat'); setIsSidebarOpen(false); }}>
            <MessageSquare size={20} /> <span className="sidebar-label">Assistant</span>
          </div>
          <div className={`nav-link ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => { setActiveTab('settings'); setIsSidebarOpen(false); }}>
            <SettingsIcon size={20} /> <span className="sidebar-label">Settings</span>
          </div>
        </nav>

        <div className="sidebar-footer">
          <button
            className="btn btn-ghost sidebar-theme-btn"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Light Mode' : 'Night Mode'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            <span className="sidebar-label">{theme === 'dark' ? 'Light Mode' : 'Night Mode'}</span>
          </button>
          <div className="panel sidebar-status">
            <ShieldCheck size={14} color="var(--brand-green)" />
            <span className="sidebar-label">Network Active</span>
          </div>
        </div>
      </div>

      {/* Mobile menu button */}
      <button 
        className="btn btn-ghost"
        style={{ 
          position: 'fixed', 
          top: '1rem', 
          left: '1rem', 
          zIndex: 1001,
          display: 'none'
        }}
        id="mobile-menu-btn"
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
      >
        {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Mobile overlay */}
      {isSidebarOpen && (
        <div 
          style={{ 
            position: 'fixed', 
            inset: 0, 
            background: 'rgba(0,0,0,0.5)', 
            zIndex: 999,
            display: 'none'
          }}
          id="sidebar-overlay"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <main className={`main-content ${activeTab === 'chat' ? 'main-content--chat' : ''}`} style={activeTab === 'chat' ? { padding: 0, overflow: 'hidden' } : {}}>
        <div hidden={activeTab !== 'studio'}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <AIStrategyStudio
              onTrigger={(id, type, desc) => addTask(id, type, desc)}
              onRefreshStrats={fetchStrategies}
              tasks={tasks}
              notify={notify}
              files={files}
              strategies={strategies}
            />

            <div className="panel" style={{ padding: '1.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Legacy Generator Tools</div>
                  <div style={{ fontSize: '0.85rem', opacity: 0.6 }}>
                    Advanced fallback for features not yet moved into Studio.
                  </div>
                </div>
                <button
                  className={showLegacyGenerator ? 'btn btn-ghost' : 'btn btn-primary'}
                  onClick={() => setShowLegacyGenerator(prev => !prev)}
                >
                  <Wand2 size={16} />
                  {showLegacyGenerator ? 'Hide Legacy Tools' : 'Open Legacy Tools'}
                </button>
              </div>

              {showLegacyGenerator && (
                <div style={{ marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '1rem' }}>
                  <AIForge
                    onTrigger={(id, type, desc) => addTask(id, type, desc)}
                    onRefreshStrats={fetchStrategies}
                    tasks={tasks}
                    notify={notify}
                    files={files}
                    strategies={strategies}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {activeTab === 'heatmap' && (
            <motion.div key="heatmap" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <SectorHeatmap
                notify={notify}
                onBacktestTicker={handleBacktestTicker}
                onExplain={(prompt, label) => explainWithAssistant(prompt, label)}
              />
            </motion.div>
          )}
          {activeTab === 'movements' && (
            <motion.div key="movements" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <IndustryMovements
                notify={notify}
                onExplain={(prompt, label) => explainWithAssistant(prompt, label)}
                onOpenChart={(ticker) => handleViewChart(ticker)}
              />
            </motion.div>
          )}
          {activeTab === 'terminal' && (
            <motion.div key="terminal" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                <TradingTerminal
                 files={files}
                 strategies={strategies}
                 tasks={tasks}
                 onTrigger={addTask}
                 onRefreshFiles={fetchFiles}
                 onRefreshStrats={fetchStrategies}
                 onSwitchTab={setActiveTab}
                 notify={notify}
                 preSelectedTicker={selectedTickerForBacktest}
                 onClearPreSelection={() => setSelectedTickerForBacktest(null)}
                 onDeleteFile={handleDelete}
                 onDeleteStrategy={handleDeleteStrategy}
                 backtestPayload={backtestPayload}
                 onClearBacktestPayload={() => setBacktestPayload(null)}
               />
            </motion.div>
          )}
          {activeTab === 'data' && (
            <motion.div key="data" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              {previewData && (
                <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center', opacity: 0.6 }}>Loading chart...</div>}>
                  <ChartViewer
                    key={`${previewFilename}-${fetchTimestamp}-${previewData.length}`}
                    data={previewData}
                    markers={previewMarkers}
                    fileName={previewFilename}
                    allFiles={files}
                    onSwitch={handlePreview}
                    onClose={() => { setPreviewData(null); setPreviewFilename(''); }}
                  />
                </Suspense>
              )}
              <MarketDataHub
                files={files}
                onRefresh={fetchFiles}
                onView={handlePreview}
                onDelete={handleDelete}
                onTrigger={(id, desc) => addTask(id, 'download', desc)}
                watchedTickers={watchedTickers}
                onRefreshWatchlist={fetchWatchlist}
                notify={notify}
              />
            </motion.div>
          )}
          {/* Arsenal tab hidden — strategies shown inline in Battle Station
          {activeTab === 'library' && (
            <motion.div key="library" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <StrategyLibrary strategies={strategies} onRefresh={fetchStrategies} notify={notify} />
            </motion.div>
          )}
          */}
          {activeTab === 'backtest' && (
            <motion.div key="backtest" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <BacktestingPanel
                files={files}
                strategies={strategies}
                onTrigger={(id, desc) => addTask(id, 'backtest', desc)}
                tasks={tasks}
                onAnalyze={(filename, markers) => {
                  console.log('Analyzing file:', filename); // Debug log
                  handlePreview(filename);
                  setPreviewMarkers(markers);
                  setActiveTab('data');
                }}
              />
            </motion.div>
          )}
          {activeTab === 'history' && (
            <motion.div key="history" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <ResultsHistory
                onAnalyze={(filename, markers) => {
                  console.log('Analyzing historical file:', filename);
                  handlePreview(filename);
                  setPreviewMarkers(markers);
                  setActiveTab('data');
                }}
                notify={notify}
                files={files}
                onTrigger={(id, desc) => addTask(id, 'backtest', desc)}
                onRefreshStrats={fetchStrategies}
                onOpenInTerminal={(payload) => {
                  setBacktestPayload(payload);
                  const ticker = (payload.dataset || '').split('-')[0];
                  setSelectedTickerForBacktest(ticker);
                  setActiveTab('terminal');
                }}
                onSwitchTab={setActiveTab}
              />
            </motion.div>
          )}
          {activeTab === 'insider' && (
            <motion.div key="insider" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <InsiderTrades notify={notify} />
            </motion.div>
          )}
          {activeTab === 'library' && (
            <motion.div key="library" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <StrategyLibrary strategies={strategies} onRefresh={fetchStrategies} notify={notify} />
            </motion.div>
          )}
          {activeTab === 'chat' && (
            <motion.div key="chat" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <ChatBot
                files={files}
                strategies={strategies}
                onTrigger={addTask}
                notify={notify}
                onRefreshStrats={fetchStrategies}
                onRefreshFiles={fetchFiles}
                autoPrompt={assistantPrompt}
                onAutoPromptConsumed={() => setAssistantPrompt(null)}
                onAgentRunUpdate={mergeAgentRun}
              />
            </motion.div>
          )}
          {false && activeTab === 'api' && (
            <motion.div key="api" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <APITab />
            </motion.div>
          )}
          {activeTab === 'settings' && (
            <motion.div key="settings" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <Settings notify={notify} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Notifications */}
      <div style={{ position: 'fixed', top: '2rem', right: '2rem', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <AnimatePresence>
          {notifications.map(n => (
            <motion.div
              key={n.id}
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, scale: 0.9 }}
              className={`badge badge-${n.type}`}
              style={{ padding: '0.75rem 1.5rem', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)', fontSize: '0.9rem', border: '1px solid currentColor' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle size={16} />
                {n.message}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Task Center */}
      <div className="task-center">
        <div
          className="task-center-tab"
          onClick={() => setIsTaskCenterOpen(prev => !prev)}
          onMouseEnter={() => {
            if (taskCenterTimeout.current) clearTimeout(taskCenterTimeout.current);
            setIsTaskCenterOpen(true);
          }}
          title="Agent and task monitor"
        >
          <Activity size={14} />
          {taskCenterCount || ''}
        </div>
        {isTaskCenterOpen && (
          <div
            className="task-center-body"
            onMouseEnter={() => {
              if (taskCenterTimeout.current) clearTimeout(taskCenterTimeout.current);
            }}
            onMouseLeave={() => {
              taskCenterTimeout.current = setTimeout(() => setIsTaskCenterOpen(false), 400);
            }}
          >
            <div style={{ padding: '0.35rem 0.55rem 0.15rem', fontSize: '0.62rem', fontWeight: 800, opacity: 0.5, letterSpacing: 0.4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>ASSISTANT AGENTS</span>
              {agentRuns.some(run => isAgentTerminal(run.status)) && (
                <button
                  className="btn btn-ghost btn-xs"
                  title="Clear all completed agents"
                  onClick={clearTerminalAgentRuns}
                  style={{ padding: '0.1rem', opacity: 0.6 }}
                >
                  <Trash2 size={10} />
                </button>
              )}
            </div>
            {agentMonitorError && (
              <div className="task-item" style={{ color: 'var(--brand-yellow)' }}>{agentMonitorError}</div>
            )}
            {!agentRuns.length && !agentMonitorError && (
              <div className="task-item" style={{ opacity: 0.55 }}>No recent agent runs</div>
            )}
            {agentRuns.map(run => {
              const running = !isAgentTerminal(run.status);
              const progress = Math.max(0, Math.min(100, Number(run.progress || 0)));
              const title = run.workflow === 'fundamental_screener'
                ? 'Fundamental screen'
                : run.workflow === 'market_review'
                  ? 'Market review'
                  : run.ticker
                    ? `${run.ticker} strategy agent`
                    : 'Strategy agent';
              return (
                <div key={run.run_id} className="task-item">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.45rem' }}>
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => { setActiveTab('chat'); setIsTaskCenterOpen(false); }}
                      style={{ minWidth: 0, padding: 0, fontWeight: 750, fontSize: '0.68rem', color: 'var(--text-main)', justifyContent: 'flex-start', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={`Open Assistant for ${run.run_id}`}
                    >
                      {title}
                    </button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
                      {running ? <RefreshCw className="animate-spin" size={10} color={agentStatusColor(run.status)} /> :
                        run.status === 'completed' ? <CheckCircle size={10} color="var(--brand-green)" /> :
                          <AlertCircle size={10} color={agentStatusColor(run.status)} />}
                      {running && (
                        <button
                          className="btn btn-ghost btn-xs"
                          title="Stop agent"
                          onClick={() => stopAgentFromMonitor(run.run_id)}
                          style={{ padding: '0.1rem' }}
                        >
                          <Square size={10} />
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-xs"
                        title="Delete agent record"
                        onClick={() => deleteAgentRun(run.run_id)}
                        style={{ padding: '0.1rem', opacity: 0.45 }}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  </div>
                  <div style={{ opacity: 0.7, marginTop: 3, fontSize: '0.65rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {run.current_step || run.status || 'Queued'}
                  </div>
                  <div style={{ height: 3, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginTop: 5 }}>
                    <div style={{ width: `${progress}%`, height: '100%', background: agentStatusColor(run.status) }} />
                  </div>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', marginTop: 3, display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <span>{run.status || 'queued'} · {progress}%</span>
                    <span>{formatAgentElapsed(run.elapsed_seconds)}</span>
                  </div>
                </div>
              );
            })}

            <div style={{ padding: '0.45rem 0.55rem 0.15rem', fontSize: '0.62rem', fontWeight: 800, opacity: 0.5, letterSpacing: 0.4 }}>
              BACKGROUND TASKS
            </div>
            {!tasks.length && (
              <div className="task-item" style={{ opacity: 0.55 }}>No background tasks</div>
            )}
            {tasks.map(task => (
              <div key={task.id} className="task-item">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.68rem' }}>{task.type.toUpperCase()}</span>
                  {task.status === 'running' ? <RefreshCw className="animate-spin" size={10} /> :
                    task.status === 'completed' ? <CheckCircle size={10} color="var(--brand-green)" /> :
                      <AlertCircle size={10} color="var(--brand-red)" />}
                </div>
                <div style={{ opacity: 0.7, marginTop: 2, fontSize: '0.65rem' }}>{task.description}</div>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  {task.status === 'running' && task.progressData?.progress !== undefined
                    ? `${task.progressData.progress}% - ${task.progressData.current}`
                    : task.status}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
