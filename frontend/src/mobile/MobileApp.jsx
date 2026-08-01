import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
  Layers,
  ArrowUpDown,
  Zap,
  MessageSquare,
  Settings,
  Sun,
  Moon,
  Activity,
} from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import MobileMarketOverview from './MobileMarketOverview';
import MobileMovements from './MobileMovements';
import MobileBattleStation from './MobileBattleStation';
import MobileAssistant from './MobileAssistant';
import MobileSettings from './MobileSettings';
import { API_BASE, DATA_SERVICE, BACKTEST_SERVICE } from '../config';

const TABS = [
  { key: 'market', label: 'Market', icon: Layers },
  { key: 'movements', label: 'Moves', icon: ArrowUpDown },
  { key: 'battle', label: 'Battle', icon: Zap },
  { key: 'chat', label: 'Chat', icon: MessageSquare },
  { key: 'settings', label: 'Settings', icon: Settings },
];

const MobileApp = () => {
  const [activeTab, setActiveTab] = useState(() => {
    return localStorage.getItem('mobile_activeTab') || 'market';
  });
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [notifications, setNotifications] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [files, setFiles] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [watchedTickers, setWatchedTickers] = useState([]);
  const [agentRuns, setAgentRuns] = useState([]);
  const [assistantPrompt, setAssistantPrompt] = useState(null);

  // Persist active tab
  useEffect(() => {
    localStorage.setItem('mobile_activeTab', activeTab);
  }, [activeTab]);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Notification helper
  const notify = (message, type = 'blue') => {
    const id = Math.random().toString(36).substr(2, 9);
    setNotifications(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 3000);
  };

  // Fetch initial data
  useEffect(() => {
    fetchFiles();
    fetchStrategies();
    fetchWatchlist();
    fetchAgentRuns();
  }, []);

  const fetchFiles = async () => {
    try {
      const res = await axios.get(`${DATA_SERVICE}/files`);
      setFiles(res.data.files || []);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchStrategies = async () => {
    try {
      const res = await axios.get(`${BACKTEST_SERVICE}/strategies`);
      setStrategies(res.data.strategies || []);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchWatchlist = async () => {
    try {
      const res = await axios.get(`${DATA_SERVICE}/watch`);
      setWatchedTickers(res.data.watched_tickers || []);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchAgentRuns = async () => {
    try {
      const res = await axios.get(`${API_BASE}/agent/runs`, { params: { limit: 12, include_terminal: true } });
      setAgentRuns(res.data?.runs || []);
    } catch (e) {
      console.error(e);
    }
  };

  // Poll for agent runs
  useEffect(() => {
    const interval = setInterval(fetchAgentRuns, 5000);
    return () => clearInterval(interval);
  }, []);

  // Add task helper
  const addTask = (id, type, description) => {
    setTasks(prev => [{ id, type, description, status: 'running', timestamp: new Date() }, ...prev]);
  };

  // Navigate to chat with prompt
  const navigateToChat = (prompt, label) => {
    setAssistantPrompt({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, prompt, label });
    setActiveTab('chat');
  };

  // Task count for badge
  const runningTaskCount = tasks.filter(t => t.status === 'running').length;
  const activeAgentCount = agentRuns.filter(run => !['completed', 'failed', 'stopped', 'stale'].includes(run.status)).length;
  const badgeCount = runningTaskCount + activeAgentCount;

  // Render active tab content
  const renderTabContent = () => {
    switch (activeTab) {
      case 'market':
        return (
          <MobileMarketOverview
            notify={notify}
            onBacktestTicker={(ticker) => {
              setActiveTab('battle');
            }}
            onExplain={(prompt, label) => navigateToChat(prompt, label)}
          />
        );
      case 'movements':
        return (
          <MobileMovements
            notify={notify}
            onExplain={(prompt, label) => navigateToChat(prompt, label)}
          />
        );
      case 'battle':
        return (
          <MobileBattleStation
            files={files}
            strategies={strategies}
            tasks={tasks}
            onTrigger={addTask}
            onRefreshFiles={fetchFiles}
            onRefreshStrats={fetchStrategies}
            notify={notify}
          />
        );
      case 'chat':
        return (
          <MobileAssistant
            files={files}
            strategies={strategies}
            tasks={tasks}
            onTrigger={addTask}
            notify={notify}
            onRefreshStrats={fetchStrategies}
            onRefreshFiles={fetchFiles}
            autoPrompt={assistantPrompt}
            onAutoPromptConsumed={() => setAssistantPrompt(null)}
            onAgentRunUpdate={(run) => {
              setAgentRuns(prev => {
                const next = [run, ...prev.filter(item => item.run_id !== run.run_id)];
                return next.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''))).slice(0, 12);
              });
            }}
          />
        );
      case 'settings':
        return (
          <MobileSettings notify={notify} />
        );
      default:
        return null;
    }
  };

  return (
    <div className="mobile-app" data-theme={theme}>
      {/* Mobile Header */}
      <header className="mobile-header">
        <div className="mobile-header-logo">
          <Layers size={20} />
          <span>Trading Spy</span>
        </div>
        <div className="mobile-header-actions">
          <button
            className="mobile-header-btn"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          >
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          {badgeCount > 0 && (
            <button className="mobile-header-btn" style={{ position: 'relative' }}>
              <Activity size={20} />
              <span className="badge">{badgeCount}</span>
            </button>
          )}
        </div>
      </header>

      {/* Mobile Content */}
      <main className="mobile-content">
        <AnimatePresence mode="wait">
          {renderTabContent()}
        </AnimatePresence>
      </main>

      {/* Mobile Bottom Tab Bar */}
      <nav className="mobile-tab-bar">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              className={`mobile-tab ${isActive ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <span className="mobile-tab-icon">
                <Icon size={22} />
                {tab.key === 'battle' && badgeCount > 0 && (
                  <span style={{
                    position: 'absolute',
                    top: -2,
                    right: -4,
                    minWidth: 14,
                    height: 14,
                    padding: '0 3px',
                    fontSize: 9,
                    fontWeight: 700,
                    background: 'var(--brand-red)',
                    color: 'white',
                    borderRadius: 7,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    {badgeCount}
                  </span>
                )}
              </span>
              <span className="mobile-tab-label">{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Toast Notifications */}
      <div className="mobile-toast-container">
        <AnimatePresence>
          {notifications.map(n => (
            <div
              key={n.id}
              className={`mobile-toast mobile-badge-${n.type}`}
            >
              {n.message}
            </div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default MobileApp;
