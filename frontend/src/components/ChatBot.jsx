import React, { useState, useEffect, useRef, useMemo, Suspense, lazy } from 'react';
import axios from 'axios';
import { Send, Bot, User, Wand2, Play, Database, RefreshCw, Copy, Check, Trash2, MessageSquare, X, StopCircle, Plus, Edit2, Square, Share, Download, FileText, Printer, Eye, EyeOff } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { API_BASE, BACKTEST_SERVICE, DATA_SERVICE, OPTIMIZER_SERVICE, SETTINGS_URL } from '../config';
import { formatDatasetName } from '../utils/formatters';
import { getApiSettings } from '../utils/apiKeyHelper';

// Lazy load ChartViewer to prevent lightweight-charts bundling issues
const ChartViewer = lazy(() => import('./ChartViewer'));

// ── localStorage helpers ──────────────────────────────────────────────────────
const STORAGE_KEY = 'chatThreads';
const DEFAULT_PROVIDER = 'google_ai_studio';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_PROVIDERS = [
    { value: 'google_ai_studio', label: 'Google AI Studio' },
    { value: 'mistral', label: 'Mistral' },
    { value: 'openrouter', label: 'OpenRouter' },
];
const API_PROVIDER_VALUES = new Set(API_PROVIDERS.map(provider => provider.value));
const API_KEY_STORAGE = {
    openrouter: 'settings_openrouter_api_key',
    google_ai_studio: 'settings_google_ai_studio_api_key',
    googleaistudio: 'settings_google_ai_studio_api_key',
    gemini: 'settings_google_ai_studio_api_key',
    mistral: 'settings_mistral_api_key',
};
const AGENT_TERMINAL_STATUSES = ['completed', 'failed', 'stopped', 'stale'];
const isAgentTerminalStatus = (status) => AGENT_TERMINAL_STATUSES.includes(status);
const estimateTokens = (value) => {
    const text = String(value || '').trim();
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
};
const formatTokenCount = (value) => Number(value || 0).toLocaleString();
const getMessageSender = (message = {}) => message.sender || message.role || message.type;
const isUserMessage = (message = {}) => getMessageSender(message) === 'user';
const isAssistantMessage = (message = {}) => ['bot', 'assistant'].includes(getMessageSender(message));
const isFailedAssistantMessage = (message = {}) => {
    if (!isAssistantMessage(message)) return false;
    if (message.error || message.failed || message.status === 'failed') return true;
    const content = String(message.content || message.text || message.message || '').toLowerCase();
    return (
        content.startsWith('failed') ||
        content.startsWith('error') ||
        content.includes('failed to') ||
        content.includes('llm call failed') ||
        content.includes('provider setup failed') ||
        content.includes('model provider connection dropped')
    );
};

const EMPTY_CHART_ITEMS = Object.freeze([]);

const MiniChart = React.memo(function MiniChart({ symbol, bars }) {
    const chartData = useMemo(() => (
        (bars || []).map(bar => ({
            Date: bar.date,
            Open: bar.open,
            High: bar.high,
            Low: bar.low,
            Close: bar.close,
            Volume: bar.volume,
        }))
    ), [bars]);

    if (!bars?.length) return null;

    return (
        <div style={{ marginTop: '0.6rem' }}>
            <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center', opacity: 0.6 }}>Loading chart...</div>}>
                <ChartViewer
                    data={chartData}
                    markers={EMPTY_CHART_ITEMS}
                    fileName={`${symbol}-chart`}
                    allFiles={EMPTY_CHART_ITEMS}
                    height={400}
                    defaultShowIndicators={false}
                />
            </Suspense>
        </div>
    );
});

const normalizeProvider = (provider) => {
    const p = (provider || DEFAULT_PROVIDER).trim().toLowerCase().replace(/[-\s]/g, '_');
    if (p === 'googleaistudio' || p === 'google_ai' || p === 'gemini') return 'google_ai_studio';
    return API_PROVIDER_VALUES.has(p) ? p : DEFAULT_PROVIDER;
};
const isSupportedProviderInput = (provider) => {
    const p = (provider || '').trim().toLowerCase().replace(/[-\s]/g, '_');
    const normalized = p === 'googleaistudio' || p === 'google_ai' || p === 'gemini' ? 'google_ai_studio' : p;
    return API_PROVIDER_VALUES.has(normalized);
};

const readStoredAssistantConfig = () => {
    const rawProvider = localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER;
    return {
        provider: normalizeProvider(rawProvider),
        model: isSupportedProviderInput(rawProvider) ? (localStorage.getItem('settings_default_model') || DEFAULT_MODEL) : DEFAULT_MODEL,
    };
};

const WELCOME_MSG = (id) => ({
    id: `init-${id}`,
    type: 'bot',
    content: "Hi, I'm your TradingSpy assistant.\n\nTry these agent checks:\n\n1. \"Generate until it beats buy and hold for QQQ. Use daily candles.\"\n2. \"Improve EMA_Trend for QQQ using daily candles. Generate until it beats EMA_Trend.\"\n3. \"Generate a strict RSI + volume + breakout strategy for QQQ daily, but reject anything with zero trades.\"\n4. \"Deep dive CRWD: product growth, latest catalysts, insiders, valuation, technicals, and bull/bear case.\"\n5. After a run accepts a strategy, click Continue to make the next run beat the accepted version.\n\nBest smoke test: \"Improve EMA_Trend for QQQ using daily candles. Generate until it beats EMA_Trend, not buy and hold.\"\n\nI can read market breadth, industry heatmaps, news, fundamentals, insider trades, company/product context, charts, local datasets, strategy code, and backtest history.",
    timestamp: new Date().toISOString(),
});

function newThread(title = 'New Chat') {
    const id = `thread-${Date.now()}`;
    return { id, title, createdAt: new Date().toISOString(), messages: [WELCOME_MSG(id)], history: [] };
}

function loadThreads() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch { return null; }
}

function saveThreads(threads) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(threads)); } catch {}
}

const ChatBot = ({ files, strategies, onTrigger, notify, onRefreshStrats, onRefreshFiles, autoPrompt, onAutoPromptConsumed, onAgentRunUpdate }) => {
    const [aiConfig, setAiConfig] = useState(readStoredAssistantConfig);

    // Read the active API key from localStorage based on provider
    const getActiveApiKey = (provider) => {
        const p = normalizeProvider(provider || aiConfig.provider || localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER);
        const keyStorage = API_KEY_STORAGE[p] || API_KEY_STORAGE[DEFAULT_PROVIDER];
        const storedKey = localStorage.getItem(keyStorage) || null;
        const serverConfigured = localStorage.getItem(`${keyStorage}_configured`) === 'true';
        const key = serverConfigured && !storedKey
                ? null
                : storedKey;
        console.log('🔑 [ChatBot] getActiveApiKey called:', {
            requestedProvider: provider,
            resolvedProvider: p,
            aiConfigProvider: aiConfig.provider,
            keyExists: !!key,
            keyLength: key?.length,
            keyPreview: key ? key.substring(0, 10) + '...' : 'NULL'
        });
        return key;
    };
    const getProviderConfig = (provider) => {
        const p = normalizeProvider(provider || aiConfig.provider || localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER);
        const cfg = {};
        if (p === 'openrouter') cfg.openrouter_api_key = localStorage.getItem('settings_openrouter_api_key') || '';
        if (p === 'google_ai_studio') cfg.google_ai_studio_api_key = localStorage.getItem('settings_google_ai_studio_api_key') || '';
        if (p === 'mistral') cfg.mistral_api_key = localStorage.getItem('settings_mistral_api_key') || '';
        return Object.fromEntries(Object.entries(cfg).filter(([, value]) => value !== ''));
    };
    const hasConfiguredApiKey = (provider) => {
        const p = normalizeProvider(provider || aiConfig.provider || localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER);
        const keyStorage = API_KEY_STORAGE[p] || API_KEY_STORAGE[DEFAULT_PROVIDER];
        const serverConfigured = localStorage.getItem(`${keyStorage}_configured`) === 'true';
        return Boolean(localStorage.getItem(keyStorage) || serverConfigured);
    };
    const [responseLength, setResponseLength] = useState(localStorage.getItem('response_length') || 'mid');
    const [thinkingDetail, setThinkingDetail] = useState(localStorage.getItem('thinking_detail') || 'normal');
    const [showLiveThinking, setShowLiveThinking] = useState(localStorage.getItem('show_live_thinking') !== 'false');
    const [agentInstructions, setAgentInstructions] = useState(localStorage.getItem('agent_instructions') || '');
    const [useAgentBattleParams, setUseAgentBattleParams] = useState(localStorage.getItem('agent_use_battle_params') === 'true');
    const [agentStakeRange, setAgentStakeRange] = useState(localStorage.getItem('agent_stake_range') || '10, 50, 95');
    const [agentTrailRange, setAgentTrailRange] = useState(localStorage.getItem('agent_trail_range') || '0.0, 0.05, 0.15');
    const [agentStartDate, setAgentStartDate] = useState(localStorage.getItem('agent_start_date') || '');
    const [agentEndDate, setAgentEndDate] = useState(localStorage.getItem('agent_end_date') || '');
    const [agentInitialCash, setAgentInitialCash] = useState(localStorage.getItem('agent_initial_cash') || '100000');
    const [agentCommission, setAgentCommission] = useState(localStorage.getItem('agent_commission') || '0.001');
    const [agentSequential, setAgentSequential] = useState(localStorage.getItem('agent_sequential') === 'true');
    const [agentAskBattleParams, setAgentAskBattleParams] = useState(localStorage.getItem('agent_ask_battle_params') === 'true');
    const [historyLimit, setHistoryLimit] = useState(() => {
        const stored = Number(localStorage.getItem('chat_history_limit') || 20);
        return Number.isFinite(stored) ? Math.min(80, Math.max(0, stored)) : 20;
    });

    // ── thread state ──────────────────────────────────────────────────────────
    const initThreads = () => {
        const saved = loadThreads();
        if (saved && saved.threads?.length) return saved;
        const t = newThread('New Chat');
        return { activeId: t.id, threads: [t] };
    };
    const [threadState, setThreadState] = useState(initThreads);
    const [editingId, setEditingId] = useState(null);
    const [editTitle, setEditTitle] = useState('');

    const activeThread = threadState.threads.find(t => t.id === threadState.activeId) || threadState.threads[0];

    // persist on every change
    useEffect(() => { saveThreads(threadState); }, [threadState]);

    // ── ui state ──────────────────────────────────────────────────────────────
    const [input, setInput] = useState('');
    const [inputHistoryIndex, setInputHistoryIndex] = useState(null);
    const [inputHistoryDraft, setInputHistoryDraft] = useState('');
    const [copiedId, setCopiedId] = useState(null);
    const [expandedReasoning, setExpandedReasoning] = useState({}); // msgId -> bool (true = expanded)
    const [expandedSteps, setExpandedSteps] = useState({}); // msgId -> bool (true = expanded)
    const [replyThreadId, setReplyThreadId] = useState(null); // msgId of message being replied to
    const [replyInput, setReplyInput] = useState(''); // input for reply thread
    const [shareModalOpen, setShareModalOpen] = useState(false);
    const [shareUrl, setShareUrl] = useState('');
    const [shareLoading, setShareLoading] = useState(false);
    const [shareError, setShareError] = useState('');
    const [limitToFourLines, setLimitToFourLines] = useState(false);
    const [apiPanelOpen, setApiPanelOpen] = useState(false);
    const [showApiKey, setShowApiKey] = useState(false);
    const [agentRun, setAgentRun] = useState(null);
    const [agentRunLoading, setAgentRunLoading] = useState(false);
    const [agentNow, setAgentNow] = useState(Date.now());
    const [agentConnectionIssue, setAgentConnectionIssue] = useState('');
    const [expandedAgentLogs, setExpandedAgentLogs] = useState({});
    const [apiDraft, setApiDraft] = useState(() => {
        const rawProvider = localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER;
        const provider = normalizeProvider(rawProvider);
        return {
            provider,
            model: isSupportedProviderInput(rawProvider) ? (localStorage.getItem('settings_default_model') || DEFAULT_MODEL) : DEFAULT_MODEL,
            apiKey: localStorage.getItem(API_KEY_STORAGE[provider] || API_KEY_STORAGE[DEFAULT_PROVIDER]) || '',
        };
    });
    
    // Per-thread streaming state: threadId -> { isStreaming, streamingMessage, currentStreamingId, abortController, agentProgress, confirmRequest, queuedInput, pendingAgentRequest, liveCommentary }
    const [threadStreamingState, setThreadStreamingState] = useState({});
    const defaultThreadStreamingState = { isStreaming: false, streamingMessage: '', currentStreamingId: null, abortController: null, agentProgress: null, confirmRequest: null, queuedInput: null, pendingAgentRequest: null, liveCommentary: [] };
    const threadStreamingStateRef = useRef(threadStreamingState);
    useEffect(() => {
        threadStreamingStateRef.current = threadStreamingState;
    }, [threadStreamingState]);
    
    // Helper to get/set per-thread state
    const getThreadState = (threadId, source = threadStreamingState) => source[threadId] || defaultThreadStreamingState;
    const updateThreadStreamState = (threadId, updates) => {
        setThreadStreamingState(prev => ({
            ...prev,
            [threadId]: { ...getThreadState(threadId, prev), ...updates }
        }));
    };
    const messagesEndRef = useRef(null);
    const agentPollFailureRef = useRef(0);

    // Get current thread's streaming state
    const currentThreadStreaming = getThreadState(activeThread.id);
    const { isStreaming, streamingMessage, agentProgress, confirmRequest, queuedInput, pendingAgentRequest, liveCommentary, currentStreamingId } = currentThreadStreaming;
    const isAssistantBusy = isStreaming || !!currentStreamingId || !!pendingAgentRequest;
    const mainInputPlaceholder = 'Ask about markets, generate strategies, run backtests, download data...';
    const chatTokenUsage = useMemo(() => {
        const usage = { input: 0, output: 0 };
        (activeThread?.messages || []).forEach(message => {
            const tokenUsage = message.tokenUsage || message.usage || {};
            const inputTokens = tokenUsage.input_tokens ?? tokenUsage.prompt_tokens ?? tokenUsage.input ?? null;
            const outputTokens = tokenUsage.output_tokens ?? tokenUsage.completion_tokens ?? tokenUsage.output ?? null;
            const sender = message.sender || message.role || message.type;
            if (inputTokens != null || outputTokens != null) {
                usage.input += Number(inputTokens || 0);
                usage.output += Number(outputTokens || 0);
                return;
            }
            const estimated = estimateTokens(message.content || message.text || message.message || '');
            if (sender === 'user') usage.input += estimated;
            else usage.output += estimated;
        });
        if (streamingMessage) usage.output += estimateTokens(streamingMessage);
        return { ...usage, total: usage.input + usage.output };
    }, [activeThread?.messages, streamingMessage]);
    const retryableFailedPrompt = useMemo(() => {
        const messages = activeThread?.messages || [];
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (!isFailedAssistantMessage(messages[i])) continue;
            for (let j = i - 1; j >= 0; j -= 1) {
                if (isUserMessage(messages[j])) {
                    return String(messages[j].content || messages[j].text || messages[j].message || '').trim();
                }
            }
        }
        return '';
    }, [activeThread?.messages]);
    const isLoading = isStreaming; // alias for compatibility

    useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); },
        [activeThread?.messages, streamingMessage]);

    useEffect(() => {
        axios.get(SETTINGS_URL).then(res => {
            if (res.data) {
                Object.entries(res.data).forEach(([key, value]) => {
                    if (key.endsWith('_configured')) {
                        localStorage.setItem(`settings_${key}`, value ? 'true' : 'false');
                    }
                });
                const rawProvider = localStorage.getItem('settings_default_provider') || res.data.default_provider || DEFAULT_PROVIDER;
                setAiConfig({
                    provider: normalizeProvider(rawProvider),
                    model: isSupportedProviderInput(rawProvider) ? (localStorage.getItem('settings_default_model') || res.data.default_model || DEFAULT_MODEL) : DEFAULT_MODEL,
                });
            }
        }).catch(() => {});
    }, []);

    useEffect(() => {
        const syncAssistantConfig = () => setAiConfig(readStoredAssistantConfig());
        window.addEventListener('tradingspy:llm-settings-updated', syncAssistantConfig);
        window.addEventListener('storage', syncAssistantConfig);
        return () => {
            window.removeEventListener('tradingspy:llm-settings-updated', syncAssistantConfig);
            window.removeEventListener('storage', syncAssistantConfig);
        };
    }, []);

    useEffect(() => {
        if (!apiPanelOpen) return;
        const rawProvider = aiConfig.provider || localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER;
        const provider = normalizeProvider(rawProvider);
        setApiDraft({
            provider,
            model: isSupportedProviderInput(rawProvider) ? (aiConfig.model || localStorage.getItem('settings_default_model') || DEFAULT_MODEL) : DEFAULT_MODEL,
            apiKey: localStorage.getItem(API_KEY_STORAGE[provider] || API_KEY_STORAGE[DEFAULT_PROVIDER]) || '',
        });
    }, [apiPanelOpen, aiConfig.provider, aiConfig.model]);

    useEffect(() => {
        if (!agentRun?.run_id || isAgentTerminalStatus(agentRun.status)) return;
        const timer = setInterval(async () => {
            try {
                setAgentNow(Date.now());
                const res = await axios.get(`${API_BASE}/agent/runs/${agentRun.run_id}`);
                agentPollFailureRef.current = 0;
                setAgentConnectionIssue('');
                setAgentRun(res.data);
                onAgentRunUpdate?.(res.data);
                updateAgentRunMessages(res.data);
            } catch (e) {
                agentPollFailureRef.current += 1;
                if (agentPollFailureRef.current >= 2) {
                    setAgentConnectionIssue(
                        navigator.onLine === false
                            ? 'Browser is offline. The backend run may still be active and will refresh after reconnect.'
                            : 'Cannot reach the backend. This card may be stale until the server responds again.'
                    );
                }
                console.error('Failed to poll agent run', e);
            }
        }, 800);
        return () => clearInterval(timer);
    }, [agentRun?.run_id, agentRun?.status]);

    useEffect(() => {
        if (!agentRun?.run_id || isAgentTerminalStatus(agentRun.status)) return;
        const timer = setInterval(() => setAgentNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [agentRun?.run_id, agentRun?.status]);

    useEffect(() => {
        const handleOffline = () => {
            setAgentConnectionIssue('Browser is offline. The backend run may still be active and will refresh after reconnect.');
        };
        const handleOnline = () => {
            agentPollFailureRef.current = 0;
            setAgentConnectionIssue('Back online. Refreshing the agent run status...');
            setTimeout(() => setAgentConnectionIssue(''), 3000);
        };
        window.addEventListener('offline', handleOffline);
        window.addEventListener('online', handleOnline);
        return () => {
            window.removeEventListener('offline', handleOffline);
            window.removeEventListener('online', handleOnline);
        };
    }, []);

    const saveAssistantApi = async () => {
        const provider = normalizeProvider(apiDraft.provider || DEFAULT_PROVIDER);
        const model = apiDraft.model?.trim() || DEFAULT_MODEL;
        localStorage.setItem('settings_default_provider', provider);
        localStorage.setItem('settings_default_model', model);
        const keyStorage = API_KEY_STORAGE[provider] || API_KEY_STORAGE[DEFAULT_PROVIDER];
        if (apiDraft.apiKey?.trim()) {
            localStorage.setItem(keyStorage, apiDraft.apiKey.trim());
        }
        setAiConfig({ provider, model });
        window.dispatchEvent(new CustomEvent('tradingspy:llm-settings-updated'));
        setApiPanelOpen(false);
        try {
            await axios.post(SETTINGS_URL, { default_provider: provider, default_model: model });
            notify?.('Assistant API settings saved.', 'green');
        } catch {
            notify?.('Assistant API saved in browser. Server settings were not updated.', 'yellow');
        }
    };

    const shouldUseBackgroundAgent = (message, intentDecision) => {
        const l = (message || '').toLowerCase();
        const intent = typeof intentDecision === 'string' ? intentDecision : intentDecision?.intent;
        const isInsiderActivityRequest = /\binsider\s+(buy|buys|buying|sell|sells|selling|trade|trades|trading|activity|transactions?)\b/.test(l);
        if (isInsiderActivityRequest) return false;
        if (typeof intentDecision === 'object' && intentDecision?.should_start_agent !== undefined) {
            return Boolean(intentDecision.should_start_agent);
        }
        if (
            l.startsWith('explain ') ||
            l.includes('strategy code') ||
            l.includes('explain this strategy') ||
            l.includes('explain strategy') ||
            l.includes('explain the movements page') ||
            l.includes('explain the market heatmap') ||
            l.includes('explaining market movers') ||
            l.includes('fresh news/web search')
        ) return false;
        if (intent === 'strategy_generate' || intent === 'strategy_improve' || intent === 'create_strategy' || intent === 'backtest' || intent === 'optimize' || intent === 'download_data' || intent === 'data_task' || intent === 'fundamental_screen') return true;
        return [
            'generate strategy',
            'create strategy',
            'find a strategy',
            'backtest',
            'improve',
            'optimize',
            'download data',
            'freshness',
            'fresh data',
            'buy and hold',
            'buy-and-hold',
            'undervalued stock',
            'undervalued stocks',
            'screen stocks',
            'stock screen',
            'peg below',
            'price/sales',
        ].some(token => l.includes(token));
    };

    const workflowForMessage = (message, intentDecision) => {
        const l = (message || '').toLowerCase();
        const intent = typeof intentDecision === 'string' ? intentDecision : intentDecision?.intent;
        const isInsiderActivityRequest = /\binsider\s+(buy|buys|buying|sell|sells|selling|trade|trades|trading|activity|transactions?)\b/.test(l);
        if (isInsiderActivityRequest) return null;
        if (typeof intentDecision === 'object' && intentDecision?.workflow) return intentDecision.workflow;
        if (intent === 'fundamental_screen' || l.includes('undervalued stock') || l.includes('undervalued stocks') || l.includes('screen stocks') || l.includes('stock screen') || l.includes('peg below') || l.includes('price/sales')) return 'fundamental_screener';
        if (intent === 'optimize' || l.includes('improve') || l.includes('optimize')) return 'strategy_race';
        if (intent === 'backtest' || l.includes('backtest') || l.includes('buy and hold') || l.includes('buy-and-hold')) return 'strategy_race';
        if (intent === 'download_data' || intent === 'data_task' || l.includes('freshness') || l.includes('fresh data') || l.includes('download data')) return 'market_review';
        return 'strategy_create';
    };

    const companyTickerAliases = {
        crowdstrike: 'CRWD',
        'crowd strike': 'CRWD',
        nvidia: 'NVDA',
        tesla: 'TSLA',
        apple: 'AAPL',
        microsoft: 'MSFT',
        amazon: 'AMZN',
        meta: 'META',
        google: 'GOOGL',
        alphabet: 'GOOGL',
        netflix: 'NFLX',
        broadcom: 'AVGO',
        amd: 'AMD',
    };

    const inferRunWindow = (message) => {
        const l = (message || '').toLowerCase();
        const end = new Date();
        const toIso = (date) => date.toISOString().slice(0, 10);
        const minuteMatch = l.match(/\b(1|2|5|15|30|60|90)\s*(?:m|min|mins|minute|minutes)\b/);
        const hasDaily = /\b(daily|1d|day|swing)\b/.test(l);
        const hasHourly = /\b(1h|hourly|hour|4h)\b/.test(l);
        const hasWeekly = /\b(weekly|1w|week)\b/.test(l);
        const hasExtendedHours = /\b(extended[-\s]?hours?|premarket|pre[-\s]?market|postmarket|post[-\s]?market|after[-\s]?hours?)\b/.test(l);
        const monthsAgo = (months) => {
            const date = new Date(end);
            date.setMonth(date.getMonth() - months);
            return date;
        };
        const yearsAgo = (years) => {
            const date = new Date(end);
            date.setFullYear(date.getFullYear() - years);
            return date;
        };
        if (minuteMatch) {
            const interval = `${minuteMatch[1]}m`;
            return { period: interval === '1m' ? '5d' : '60d', interval, start_date: null, end_date: null, extended_hours: hasExtendedHours };
        }
        if (/\b(this year|year to date|ytd|current year|2026)\b/.test(l)) {
            return { period: 'ytd', interval: hasHourly ? '1h' : hasWeekly ? '1wk' : '1d', start_date: `${end.getFullYear()}-01-01`, end_date: toIso(end), extended_hours: hasExtendedHours && hasHourly };
        }
        if (l.includes('half year') || l.includes('half-year') || l.includes('6 month') || l.includes('six month')) {
            return { period: '6mo', start_date: toIso(monthsAgo(6)), end_date: toIso(end) };
        }
        if (l.includes('recent quarter') || l.includes('3 month') || l.includes('three month')) {
            return { period: '3mo', start_date: toIso(monthsAgo(3)), end_date: toIso(end) };
        }
        if (l.includes('last year') || l.includes('1 year') || l.includes('one year')) {
            return { period: '1y', start_date: toIso(yearsAgo(1)), end_date: toIso(end) };
        }
        if (hasHourly) {
            return { period: '6mo', interval: '1h', start_date: null, end_date: null, extended_hours: hasExtendedHours };
        }
        if (hasWeekly) {
            return { period: '5y', interval: '1wk', start_date: null, end_date: null, extended_hours: false };
        }
        if (hasDaily) {
            return { period: '5y', interval: '1d', start_date: null, end_date: null, extended_hours: false };
        }
        return { period: '5y', interval: '1d', start_date: null, end_date: null, extended_hours: false };
    };

    const hasExplicitRunWindow = (message) => {
        const l = (message || '').toLowerCase();
        return /\b(this year|year to date|ytd|current year|2026|1d|daily|day|swing|1h|hourly|hour|4h|weekly|1w|week|3mo|6mo|1y|5y|month|monthly|extended[-\s]?hours?|premarket|pre[-\s]?market|postmarket|post[-\s]?market|after[-\s]?hours?)\b/.test(l)
            || /\b(?:1|2|5|15|30|60|90)\s*(?:m|min|mins|minute|minutes)\b/.test(l);
    };

    const needsStrategyClarification = (message) => {
        const l = (message || '').toLowerCase();
        return !hasExplicitRunWindow(message) && (
            l.includes('generate') ||
            l.includes('create') ||
            l.includes('build') ||
            l.includes('strategy') ||
            l.includes('backtest')
        );
    };

    const inferCandidateCount = (message) => {
        const l = (message || '').toLowerCase();
        const match = l.match(/\b(?:generate|create|make|build|backtest|run)\s+(\d{1,2})\s+(?:strategy|strategies|candidates?)\b/) ||
            l.match(/\b(\d{1,2})\s+(?:strategy|strategies|candidates?)\b/);
        if (!match) return null;
        const count = Number(match[1]);
        return Number.isFinite(count) ? Math.max(1, Math.min(count, 10)) : null;
    };

    const parseNumberList = (value, { integer = false, min = null, max = null } = {}) => (
        String(value || '')
            .split(',')
            .map(item => Number(item.trim()))
            .filter(Number.isFinite)
            .map(number => integer ? Math.round(number) : number)
            .map(number => min == null ? number : Math.max(min, number))
            .map(number => max == null ? number : Math.min(max, number))
    );

    const buildAgentBattleParams = (enabled = useAgentBattleParams) => {
        if (!enabled) return {};
        const stakeRange = parseNumberList(agentStakeRange, { integer: true, min: 1, max: 100 });
        const trailRange = parseNumberList(agentTrailRange, { min: 0, max: 1 });
        const initialCash = Number(agentInitialCash);
        const commission = Number(agentCommission);
        return {
            stake_range: stakeRange.length ? stakeRange : null,
            trail_range: trailRange.length ? trailRange : null,
            start_date: agentStartDate || null,
            end_date: agentEndDate || null,
            initial_cash: Number.isFinite(initialCash) && initialCash > 0 ? initialCash : 100000,
            commission: Number.isFinite(commission) && commission >= 0 ? commission : 0.001,
            sequential: agentSequential,
        };
    };

    const startAgentRun = async (workflow, overrides = {}) => {
        const sourceText = overrides.prompt || input || '';
        const workflowNeedsTicker = !['market_review', 'fundamental_screener'].includes(workflow);
        const ticker = workflowNeedsTicker ? (overrides.ticker || inferTickerFromContext(sourceText) || '').toUpperCase() : '';
        const inferredWindow = inferRunWindow(sourceText);
        const thread = threadState.threads.find(t => t.id === activeThread.id);
        setAgentRunLoading(true);
        try {
            const { provider, model, api_key } = getApiSettings();
            const provider_config = getProviderConfig(provider);
            const candidateCount = overrides.candidate_count || inferCandidateCount(sourceText) || 3;
            const requestHistory = buildHistoryWithAgentMemory(thread, historyLimit, 4);
            const battleParams = buildAgentBattleParams(overrides.use_battle_params ?? useAgentBattleParams);
            const res = await axios.post(`${API_BASE}/agent/runs`, {
                workflow,
                ticker: ticker || null,
                prompt: overrides.prompt || input || `Run ${workflow.replace('_', ' ')}${ticker ? ` for ${ticker}` : ''}`,
                period: overrides.period || inferredWindow.period,
                interval: overrides.interval || inferredWindow.interval || '1d',
                extended_hours: overrides.extended_hours ?? inferredWindow.extended_hours ?? false,
                ...battleParams,
                start_date: battleParams.start_date || overrides.start_date || inferredWindow.start_date,
                end_date: battleParams.end_date || overrides.end_date || inferredWindow.end_date,
                max_backtest_workers: overrides.max_backtest_workers || 4,
                require_fresh_data: true,
                benchmark_buy_hold: true,
                benchmark_strategy: overrides.benchmark_strategy || null,
                benchmark_mode: overrides.benchmark_mode || 'auto',
                available_files: files,
                available_strategies: strategies.map(s => s.name),
                history: requestHistory,
                history_limit: historyLimit,
                max_tokens: getMaxTokens(),
                thinking_detail: thinkingDetail,
                agent_instructions: agentInstructions.trim() || null,
                provider,
                model,
                api_key,
                provider_config,
                candidate_count: candidateCount,
            });
            setAgentRun(res.data);
            onAgentRunUpdate?.(res.data);
            notify?.('Agent is working in the workspace', 'blue');
            return res.data;
        } catch (e) {
            notify?.(e.response?.data?.detail || 'Failed to start agent run', 'red');
        } finally {
            setAgentRunLoading(false);
        }
        return null;
    };

    const stopAgentRun = async (runId = null) => {
        const targetRunId = runId || agentRun?.run_id;
        if (!targetRunId) return;
        const stoppedAt = new Date().toISOString();
        const stoppedRun = {
            ...(agentRun || {}),
            run_id: targetRunId,
            status: 'stopped',
            current_step: 'Stop requested',
            updated_at: stoppedAt,
        };
        if (agentRun?.run_id === targetRunId) setAgentRun(stoppedRun);
        onAgentRunUpdate?.(stoppedRun);
        updateAgentRunMessages(stoppedRun);
        try {
            await axios.post(`${API_BASE}/agent/runs/${targetRunId}/stop`);
            const res = await axios.get(`${API_BASE}/agent/runs/${targetRunId}`);
            setAgentRun(res.data);
            onAgentRunUpdate?.(res.data);
            updateAgentRunMessages(res.data);
        } catch (e) {
            notify?.('Failed to stop agent run', 'red');
        }
    };

    const continueAgentRun = async () => {
        if (!agentRun?.run_id) return;
        setAgentRunLoading(true);
        try {
            const res = await axios.post(`${API_BASE}/agent/runs/${agentRun.run_id}/continue`);
            setAgentRun(res.data);
            onAgentRunUpdate?.(res.data);
            addMessage(
                activeThread.id,
                'bot',
                'I continued the run. I will update the new progress card below.',
                null,
                null,
                [],
                null,
                null,
                null,
                null,
                null,
                { agentRun: res.data }
            );
            notify?.('Started follow-up agent run', 'blue');
        } catch (e) {
            notify?.(e.response?.data?.detail || 'Failed to continue agent run', 'red');
        } finally {
            setAgentRunLoading(false);
        }
    };

    // ── thread helpers ────────────────────────────────────────────────────────
    const updateThread = (id, updater) => {
        setThreadState(prev => ({
            ...prev,
            threads: prev.threads.map(t => t.id === id ? { ...t, ...updater(t) } : t)
        }));
    };

    const switchThread = (id) => {
        setInputHistoryIndex(null);
        setInputHistoryDraft('');
        updateThreadStreamState(activeThread.id, { pendingAgentRequest: null });
        setThreadState(prev => ({ ...prev, activeId: id }));
    };

    const createThread = () => {
        const t = newThread('New Chat');
        setThreadState(prev => ({ activeId: t.id, threads: [t, ...prev.threads] }));
    };

    const deleteThread = (id, e) => {
        e.stopPropagation();
        const thread = threadState.threads.find(t => t.id === id);
        const runningRunIds = [...new Set((thread?.messages || [])
            .map(message => message.agentRun)
            .filter(run => run?.run_id && !isAgentTerminalStatus(run.status))
            .map(run => run.run_id))];
        runningRunIds.forEach(runId => {
            axios.post(`${API_BASE}/agent/runs/${runId}/stop`).catch(err => {
                console.warn('Failed to stop agent run for deleted thread', runId, err);
            });
        });
        const deletedThreadState = getThreadState(id);
        deletedThreadState.abortController?.abort?.();
        if (agentRun?.run_id && runningRunIds.includes(agentRun.run_id)) {
            setAgentRun(null);
        }
        setThreadStreamingState(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
        setThreadState(prev => {
            const threads = prev.threads.filter(t => t.id !== id);
            if (!threads.length) {
                const t = newThread('New Chat');
                return { activeId: t.id, threads: [t] };
            }
            const activeId = prev.activeId === id ? threads[0].id : prev.activeId;
            return { activeId, threads };
        });
    };

    const startRename = (t, e) => {
        e.stopPropagation();
        setEditingId(t.id);
        setEditTitle(t.title);
    };

    const commitRename = (id) => {
        if (editTitle.trim()) updateThread(id, t => ({ ...t, title: editTitle.trim() }));
        setEditingId(null);
    };

    // auto-title thread from first user message
    const autoTitle = (threadId, userMsg) => {
        updateThread(threadId, t => {
            if (t.title !== 'New Chat') return t;
            const title = userMsg.length > 40 ? userMsg.slice(0, 40) + '…' : userMsg;
            return { ...t, title };
        });
    };

    // ── message helpers ───────────────────────────────────────────────────────
    const addMessage = (threadId, type, content, actions = null, reasoning = null, steps = [], marketData = null, backtestResults = null, replyTo = null, taskId = null, usage = null, meta = {}) => {
        const msg = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type, content, actions, reasoning, steps, marketData, backtestResults,
            timestamp: new Date().toISOString(),
            replyTo,
            replies: [],
            progress: null,
            taskId: taskId,
            usage: usage,
            ...meta,
        };
        updateThread(threadId, t => {
            if (replyTo) {
                // Add as reply to parent message
                return {
                    ...t,
                    messages: t.messages.map(m => 
                        m.id === replyTo 
                            ? { ...m, replies: [...(m.replies || []), msg] }
                            : m
                    )
                };
            } else {
                // Add as main message
                return { ...t, messages: [...t.messages, msg] };
            }
        });
        return msg.id;
    };

    const updateMessage = (threadId, id, content, actions = null, reasoning = null, steps = [], marketData = null, backtestResults = null, progress = null, taskId = null, commentary = null, usage = null, meta = {}) => {
        updateThread(threadId, t => ({
            ...t,
            messages: t.messages.map(m => {
                if (m.id === id) {
                    return { ...m, content, actions, reasoning, steps, marketData, backtestResults, progress, taskId, ...(commentary !== null && { commentary }), ...(usage !== null && { usage }), ...meta };
                }
                if (m.replies?.length) {
                    return {
                        ...m,
                        replies: m.replies.map(r => r.id === id ? { ...r, content, actions, reasoning, steps, marketData, backtestResults, progress, ...(usage !== null && { usage }), ...meta } : r)
                    };
                }
                return m;
            })
        }));
    };

    const updateAgentRunMessages = (run) => {
        if (!run?.run_id) return;
        const terminal = isAgentTerminalStatus(run.status);
        const memoryPrefix = `[Agent run summary:${run.run_id}]`;
        const visibleSummaryPrefix = `[Agent run visible summary:${run.run_id}]`;
        const newEventMessages = [];
        const existingEventIds = new Set();
        const importantEventTypes = ['backtest_result', 'step_completed', 'error', 'generation_complete', 'task_completed', 'strategy_found', 'generation_progress'];
        setThreadState(prev => ({
            ...prev,
            threads: prev.threads.map(thread => {
                const existingIds = new Set(thread.messages.map(m => m.id));
                let touchedRun = false;
                const messages = thread.messages.map(message => {
                    if (message.agentRun?.run_id !== run.run_id) return message;
                    touchedRun = true;
                    return { ...message, agentRun: { ...message.agentRun, ...run } };
                });
                const freshMessages = [];
                if (run.events?.length) {
                    for (const event of run.events) {
                        const key = `${run.run_id}:${event.ts || event.message}:${event.type}`;
                        const msgId = `agent-event-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                        if (existingIds.has(msgId) || existingEventIds.has(msgId)) continue;
                        existingEventIds.add(msgId);
                        if (importantEventTypes.includes(event.type)) {
                            let content = event.message;
                            if (event.error) content += `: ${String(event.error).slice(0, 300)}`;
                            freshMessages.push({
                                id: msgId,
                                type: 'bot',
                                content,
                                timestamp: new Date(),
                            });
                        }
                    }
                }
                const history = thread.history || [];
                const hasMemory = history.some(item => String(item.content || '').startsWith(memoryPrefix));
                const hasVisibleSummary = history.some(item => String(item.content || '').startsWith(visibleSummaryPrefix));
                const hasEventHistory = history.some(item => item.content?.startsWith(`[Agent event:${run.run_id}]`));
                const eventHistory = hasEventHistory ? [] : freshMessages.map(m => ({ role: 'assistant', content: `[Agent event:${run.run_id}] ${m.content}` }));
                if (!touchedRun && !freshMessages.length) {
                    return { ...thread };
                }
                let tempMessages = messages;
                if (freshMessages.length && touchedRun) {
                    tempMessages = [...messages, ...freshMessages];
                }
                if (!touchedRun || !terminal || (hasMemory && hasVisibleSummary)) {
                    return { ...thread, messages: tempMessages, history: [...history, ...eventHistory] };
                }
                const summary = summarizeAgentRunForChat(run);
                if (!summary) return { ...thread, messages: tempMessages, history: [...history, ...eventHistory] };
                const visibleSummary = summarizeAgentRunForVisibleChat(run);
                const nextMessages = visibleSummary && !hasVisibleSummary
                    ? [
                        ...tempMessages,
                        {
                            id: `agent-summary-${run.run_id}`,
                            type: 'bot',
                            content: visibleSummary,
                            timestamp: new Date(),
                        },
                    ]
                    : tempMessages;
                return {
                    ...thread,
                    messages: nextMessages,
                    history: [
                        ...history,
                        ...eventHistory,
                        ...(hasMemory ? [] : [{ role: 'assistant', content: `${memoryPrefix} ${summary}` }]),
                        ...(visibleSummary && !hasVisibleSummary ? [{ role: 'assistant', content: `${visibleSummaryPrefix} emitted` }] : []),
                    ],
                };
            }),
        }));
    };

    const summarizeAgentRunForVisibleChat = (run) => {
        if (!run?.run_id || !isAgentTerminalStatus(run.status)) return '';
        if (run.assistant_summary || run.outcome?.assistant_summary) {
            return run.assistant_summary || run.outcome.assistant_summary;
        }
        if (run.status === 'failed') {
            return `Agent run failed: ${run.error || run.events?.slice(-1)?.[0]?.message || 'No error detail returned.'}`;
        }
        if (run.status === 'stopped') {
            return `Agent run stopped: ${run.current_step || 'Stopped by user.'}`;
        }
        if (run.workflow === 'fundamental_screener' || run.screen_result) {
            const screen = run.screen_result || {};
            const candidates = screen.candidates || run.candidates || [];
            if (!candidates.length) return run.outcome?.message || 'Screen completed, but no candidates matched.';
            const thresholds = screen.thresholds || {};
            const universe = screen.universe || run.config?.screen_universe || 'default';
            const asOf = screen.as_of ? ` Data as of ${String(screen.as_of).slice(0, 19).replace('T', ' ')}.` : '';
            const methodParts = [
                `Universe: ${universe}`,
                `checked ${screen.checked ?? 'selected'} symbol(s)`,
                thresholds.max_forward_pe != null ? `forward P/E <= ${thresholds.max_forward_pe}` : null,
                thresholds.max_peg != null ? `PEG <= ${thresholds.max_peg}` : null,
                thresholds.max_price_to_sales != null ? `P/S <= ${thresholds.max_price_to_sales}` : null,
                thresholds.min_revenue_growth != null ? `revenue growth >= ${(Number(thresholds.min_revenue_growth) * 100).toFixed(0)}%` : null,
                thresholds.require_profit_margin ? 'positive profit margin preferred/required' : null,
            ].filter(Boolean);
            const topLines = candidates.slice(0, 5).map((candidate, index) => {
                const quote = candidate.quote || {};
                const reasons = (candidate.reasons || []).slice(0, 3).join('; ');
                const cautions = (candidate.cautions || []).slice(0, 2).join('; ');
                const news = (candidate.recent_news || []).slice(0, 2).map(item => item.title).filter(Boolean).join(' | ');
                const latestBar = quote.latest_bar;
                const latestBarText = latestBar ? ` Latest bar: ${String(latestBar).slice(0, 10)}${quote.latest_bar_age_days != null ? ` (${quote.latest_bar_age_days} day(s) old)` : ''}.` : '';
                const symbol = candidate.symbol || candidate.ticker || candidate.name || `Candidate ${index + 1}`;
                const price = quote.price != null ? ` $${Number(quote.price).toFixed(2)}` : '';
                const volume = quote.relative_volume_30d != null ? `, volume ${Number(quote.relative_volume_30d).toFixed(2)}x` : '';
                return `${index + 1}. ${symbol}${price}${volume}: ${reasons || 'matched the screen'}.${latestBarText}${cautions ? ` Watch: ${cautions}.` : ''}${news ? ` News: ${news}.` : ''}`;
            });
            return `Fundamental screen completed. It found ${candidates.length} candidate(s).\n\nHow it screened: ${methodParts.join('; ')}. It scored candidates on reasonable valuation, growth, profitability, analyst upside, trend/volume context, and then enriched passing names with news, options, insider activity, and latest-bar freshness.${asOf}\n\n${topLines.join('\n')}`;
        }
        if (run.outcome?.message) {
            const accepted = run.accepted_version || run.outcome?.accepted;
            const roi = accepted?.roi != null ? ` ROI ${Number(accepted.roi).toFixed(2)}%.` : '';
            return `${run.outcome.title || 'Agent run completed'}: ${run.outcome.message}${roi}`;
        }
        return '';
    };

    const summarizeAgentRunForChat = (run) => {
        if (!run?.run_id) return '';
        if (run.workflow === 'fundamental_screener' || run.screen_result) {
            const screen = run.screen_result || {};
            const candidates = screen.candidates || run.candidates || [];
            const top = candidates[0] || run.outcome?.accepted || null;
            const topQuote = top?.quote || {};
            const topMetrics = top?.metrics || top?.fundamentals || {};
            const latestBar = topQuote.latest_bar || {};
            const symbols = candidates.slice(0, 5).map(c => c.symbol || c.ticker).filter(Boolean).join(', ');
            const pieces = [
                `Agent run ${run.run_id}`,
                'workflow fundamental screener',
                run.status ? `status ${run.status}` : null,
                screen.universe ? `universe ${screen.universe}` : run.config?.screen_universe ? `universe ${run.config.screen_universe}` : null,
                screen.requirements ? `requirements ${String(screen.requirements).slice(0, 220)}` : run.config?.prompt ? `requirements ${String(run.config.prompt).slice(0, 220)}` : null,
                candidates.length ? `matched candidates ${symbols}` : 'matched candidates none',
                top ? `top candidate ${top.symbol || top.ticker || top.name}` : null,
                topQuote.price != null ? `top price ${Number(topQuote.price).toFixed(2)}` : null,
                topMetrics.forward_pe != null ? `forward P/E ${Number(topMetrics.forward_pe).toFixed(2)}` : null,
                topMetrics.peg_ratio != null ? `PEG ${Number(topMetrics.peg_ratio).toFixed(2)}` : null,
                topMetrics.price_to_sales != null ? `P/S ${Number(topMetrics.price_to_sales).toFixed(2)}` : null,
                topMetrics.revenue_growth != null ? `revenue growth ${(Number(topMetrics.revenue_growth) * 100).toFixed(1)}%` : null,
                topQuote.relative_volume_30d != null ? `relative volume ${Number(topQuote.relative_volume_30d).toFixed(2)}x` : null,
                latestBar.date ? `latest bar ${latestBar.date}` : null,
                run.outcome?.message ? `outcome: ${run.outcome.message}` : null,
            ].filter(Boolean);
            return pieces.join('; ');
        }
        const accepted = run.accepted_version || run.outcome?.accepted || null;
        const best = run.best_attempt || run.outcome?.best_attempt || accepted || null;
        const benchmark = run.benchmark?.comparison || run.comparison_benchmark || run.benchmark?.buy_hold || null;
        const strategyName = accepted?.strategy || best?.strategy || accepted?.name || best?.name || '';
        const issueSummary = (run.events || [])
            .filter(event => ['generation_retry', 'warning', 'error', 'validation_error'].includes(event.type))
            .slice(-3)
            .map(event => `${event.message}${event.error ? `: ${String(event.error).slice(0, 240)}` : ''}`)
            .join(' | ');
        const pieces = [
            `Agent run ${run.run_id}`,
            run.ticker ? `ticker ${run.ticker}` : null,
            run.interval ? `interval ${run.interval}` : null,
            run.status ? `status ${run.status}` : null,
            strategyName ? `selected strategy: ${strategyName}` : null,
            best?.roi != null ? `strategy ROI ${Number(best.roi).toFixed(2)}%` : null,
            benchmark?.label ? `benchmark ${benchmark.label}` : null,
            benchmark?.roi != null ? `benchmark ROI ${Number(benchmark.roi).toFixed(2)}%` : null,
            best?.benchmark_delta != null ? `delta ${Number(best.benchmark_delta).toFixed(2)} percentage points` : null,
            run.dataset_filename ? `dataset ${run.dataset_filename}` : null,
            run.outcome?.message ? `outcome: ${run.outcome.message}` : null,
            issueSummary ? `recent issues: ${issueSummary}` : null,
        ].filter(Boolean);
        return pieces.join('; ');
    };

    const recentAgentContextMessages = (thread, limit = 4) => {
        const rememberedRunIds = new Set(
            (thread?.history || [])
                .map(item => String(item.content || '').match(/^\[Agent run summary:([^\]]+)\]/)?.[1])
                .filter(Boolean)
        );
        const runs = (thread?.messages || [])
            .map(message => message.agentRun)
            .filter(Boolean)
            .filter(run => !isAgentTerminalStatus(run.status) || !rememberedRunIds.has(run.run_id))
            .slice(-limit);
        return runs
            .map(summarizeAgentRunForChat)
            .filter(Boolean)
            .map(content => ({ role: 'assistant', content: `[Agent run context] ${content}` }));
    };

    const recentAgentMemoryMessages = (thread, limit = 3) => (
        (thread?.history || [])
            .filter(item => String(item.content || '').startsWith('[Agent run summary:'))
            .slice(-limit)
    );

    const visibleChatHistoryMessages = (thread, limit = historyLimit) => {
        if (!limit) return [];
        return (thread?.messages || [])
            .filter(message => {
                const sender = getMessageSender(message);
                return (sender === 'user' || sender === 'bot' || sender === 'assistant') && String(message.content || '').trim();
            })
            .map(message => ({
                role: isUserMessage(message) ? 'user' : 'assistant',
                content: String(message.content || '').trim(),
            }))
            .slice(-limit);
    };

    const recentChatHistoryMessages = (thread, limit = historyLimit) => {
        if (!limit) return [];
        const persisted = (thread?.history || [])
            .filter(item => !String(item.content || '').startsWith('[Agent run summary:'))
            .filter(item => !String(item.content || '').startsWith('[Agent run visible summary:'))
            .slice(-limit);
        const visible = visibleChatHistoryMessages(thread, limit);
        const seen = new Set();
        return [...persisted, ...visible]
            .filter(item => {
                const key = `${item.role}:${String(item.content || '').trim()}`;
                if (!item.content || seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .slice(-limit);
    };

    const buildHistoryWithAgentMemory = (thread, chatLimit = historyLimit, agentLimit = 4) => {
        const agentMemories = recentAgentMemoryMessages(thread, agentLimit);
        const visibleAgentRuns = recentAgentContextMessages(thread, agentLimit);
        const chatHistory = chatLimit > 0 ? recentChatHistoryMessages(thread, chatLimit) : [];
        return [...chatHistory, ...agentMemories, ...visibleAgentRuns];
    };

    const effectiveHistoryCount = useMemo(
        () => recentChatHistoryMessages(activeThread, historyLimit).length,
        [activeThread?.history, activeThread?.messages, historyLimit]
    );

    const enrichPromptWithAgentContext = (prompt, thread, intent) => {
        const agentContexts = [
            ...recentAgentMemoryMessages(thread, 3),
            ...recentAgentContextMessages(thread, 3),
        ].slice(-4);
        if (!agentContexts.length) return prompt;
        const lower = String(prompt || '').toLowerCase();
        const needsImplicitContext = (
            intent === 'strategy_explain' ||
            lower.includes('this strategy') ||
            lower.includes('that strategy') ||
            lower.includes('last strategy') ||
            lower.includes('accepted strategy') ||
            lower.includes('explain this') ||
            lower.includes('last run') ||
            lower.includes('previous run') ||
            lower.includes('what is the issue') ||
            lower.includes("what's the issue") ||
            lower.includes('what happened') ||
            lower.includes('what did you do') ||
            lower.includes('what we did') ||
            lower.includes('above') ||
            lower.includes('rate limited') ||
            lower.includes('google') ||
            (/^(what|why|how|is it|did it|was it)\b/.test(lower) && lower.length < 80)
        );
        if (!needsImplicitContext) return prompt;
        return `${prompt}\n\nRecent agent run context for resolving follow-up references like "this", "that", "above", "the issue", "rate limited", or "what did you do":\n${agentContexts.map(item => `- ${item.content}`).join('\n')}\n\nUse the most recent agent run when the user asks a vague follow-up. If the latest run failed or found no deployable strategy, explain the rejection/error reasons from that run. If the user asks about rate limits, mention provider errors from the recent run when present.`;
    };

    const copyToClipboard = async (text, msgId) => {
        try {
            if (navigator.clipboard?.writeText && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
            } else {
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.opacity = '0';
                document.body.appendChild(textArea);
                textArea.select();
                const copied = document.execCommand('copy');
                document.body.removeChild(textArea);
                if (!copied) throw new Error('Browser denied clipboard access');
            }
            setCopiedId(msgId);
            setTimeout(() => setCopiedId(null), 2000);
        } catch (error) {
            notify?.(`Copy failed: ${error?.message || 'clipboard access was denied'}`, 'error');
        }
    };

    const openReplyThread = (msgId) => {
        setReplyThreadId(msgId);
        setReplyInput('');
    };

    const closeReplyThread = () => {
        setReplyThreadId(null);
        setReplyInput('');
    };

    const sendReply = async () => {
        if (!replyInput.trim() || !replyThreadId) return;
        const tid = activeThread.id;
        const msg = replyInput.trim();
        
        // Add reply as nested message
        addMessage(tid, 'user', msg, null, null, [], null, null, replyThreadId);
        setReplyInput('');
        
        // Send to AI with context about the reply
        const intent = analyzeIntent(msg);
        const replyContext = `(Replying to previous message) ${msg}`;
        await handleStreamingResponse(replyContext, intent, tid);
        
        closeReplyThread();
    };

    const shareThread = async () => {
        setShareLoading(true);
        setShareError('');
        try {
            const shareData = {
                thread_id: activeThread.id,
                title: activeThread.title,
                messages: activeThread.messages,
                history: activeThread.history || []
            };
            
            if (limitToFourLines) {
                shareData.limit_lines = 4;
            }
            
            const response = await axios.post(`${API_BASE}/chat/share`, shareData);
            const shareId = response.data.share_id;
            const url = `${window.location.origin}${response.data.url || `/shared/${shareId}`}`;
            setShareUrl(url);
            setShareModalOpen(true);
        } catch (error) {
            const detail = error?.response?.data?.detail || error?.message || 'Unknown error';
            setShareError(`Could not generate a link: ${detail}`);
            notify?.('Failed to generate a share link', 'error');
        } finally {
            setShareLoading(false);
        }
    };

    const getExportMessages = () => limitToFourLines ? activeThread.messages.slice(-4) : activeThread.messages;

    const formatAsMarkdown = () => {
        const title = activeThread.title || 'Assistant chat';
        const transcript = getExportMessages().map(msg => {
            const sender = isAssistantMessage(msg) ? 'Assistant' : 'You';
            const timestamp = msg.timestamp ? ` · ${new Date(msg.timestamp).toLocaleString()}` : '';
            return `## ${sender}${timestamp}\n\n${String(msg.content || '').trim()}`;
        }).filter(section => section.trim()).join('\n\n---\n\n');
        return `# ${title}\n\n${transcript}\n`;
    };

    const downloadMarkdown = () => {
        const blob = new Blob([formatAsMarkdown()], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${String(activeThread.title || 'assistant-chat').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '') || 'assistant-chat'}.md`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const printAsPdf = () => {
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            notify?.('PDF export was blocked. Allow pop-ups and try again.', 'error');
            return;
        }
        printWindow.opener = null;
        printWindow.document.write('<!doctype html><html><head><title>Assistant chat</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:850px;margin:40px auto;padding:0 28px;color:#172033}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit} @media print{body{margin:0;max-width:none}}</style></head><body><pre id="transcript"></pre></body></html>');
        printWindow.document.close();
        printWindow.document.title = activeThread.title || 'Assistant chat';
        printWindow.document.getElementById('transcript').textContent = formatAsMarkdown();
        printWindow.focus();
        setTimeout(() => printWindow.print(), 150);
    };

    const formatAsWhatsAppText = () => {
        const messages = getExportMessages();
        
        return messages.map(msg => {
            const time = new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            const sender = msg.type === 'bot' ? 'AI Assistant' : 'You';
            let content = String(msg.content || '');
            
            // Remove thinking sections and tool calls
            content = content.replace(/🧠\s*Thinking[\s\S]*?(?=\n\n|$)/g, '');
            content = content.replace(/●[\s\S]*?(?=\n\n|$)/g, '');
            content = content.replace(/💬\s*Final Response[\s\S]*?(?=\n|$)/g, '');
            content = content.trim();
            
            return `[${time}] ${sender}: ${content}`;
        }).join('\n\n');
    };

    const stopStreaming = () => {
        const ts = getThreadState(activeThread.id);
        ts.abortController?.abort();
        updateThreadStreamState(activeThread.id, { isStreaming: false, streamingMessage: '', abortController: null });
        if (ts.currentStreamingId) {
            updateMessage(activeThread.id, ts.currentStreamingId, '❌ Response interrupted by user.');
        }
    };

    const sendConfirmAnswer = async (answer) => {
        const ts = getThreadState(activeThread.id);
        if (!ts.confirmRequest) return;
        const { confirm_id } = ts.confirmRequest;
        updateThreadStreamState(activeThread.id, { confirmRequest: null, agentProgress: { label: `✅ You chose: ${answer}`, pct: null, detail: 'Agent continuing…' } });
        try {
            await fetch(`http://${window.location.hostname}:8000/api/ai/confirm/${confirm_id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ answer }),
            });
        } catch (e) { /* agent will timeout gracefully */ }
    };

    // ── intent / ticker helpers ───────────────────────────────────────────────
    const analyzeIntent = (msg) => {
        const l = msg.toLowerCase();
        if (/\binsider\s+(buy|buys|buying|sell|sells|selling|trade|trades|trading|activity|transactions?)\b/.test(l)) return 'market_analysis';
        if (/\b(explain|review|what does|how does|show code)\b/.test(l)) return 'strategy_explain';
        if (l.includes('optimize') || l.includes('improve') || l.includes('enhance') || l.includes('beat')) return 'strategy_improve';
        if (l.includes('create') || l.includes('generate') || l.includes('build') || l.includes('algorithm') || l.includes('find a strategy')) return 'strategy_generate';
        if (l.includes('backtest') || l.includes('test') || l.includes('simulate')) return 'backtest';
        if (l.includes('download') || l.includes('get data') || l.includes('fetch') || l.includes('market data')) return 'download_data';
        return 'general';
    };

    const classifyIntentWithLLM = async (message, threadId) => {
        const fallbackIntent = analyzeIntent(message);
        const activeProvider = normalizeProvider(aiConfig.provider || localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER);
        const activeKey = getActiveApiKey(activeProvider);
        const providerConfig = getProviderConfig(activeProvider);
        const thread = threadState.threads.find(t => t.id === threadId);
        if (!activeKey) {
            return { intent: fallbackIntent, fallback: true };
        }
        try {
            const res = await axios.post(`${API_BASE}/agent/intent`, {
                message,
                provider: activeProvider,
                model: aiConfig.model || localStorage.getItem('settings_default_model') || DEFAULT_MODEL,
                api_key: activeKey,
                provider_config: providerConfig,
                available_files: files,
                available_strategies: strategies.map(s => ({ name: s.name, class_name: s.class_name, ticker: s.ticker, category: s.category })),
                history: buildHistoryWithAgentMemory(thread, historyLimit, 4),
                agent_instructions: agentInstructions.trim() || null,
                context: {
                    files_count: files.length,
                    strategies_count: strategies.length,
                    pending_agent_request: getThreadState(threadId).pendingAgentRequest || null,
                },
                max_tokens: 1024,
            });
            return { intent: fallbackIntent, ...(res.data || {}) };
        } catch (err) {
            console.warn('Intent classifier failed; using local fallback', err);
            return { intent: fallbackIntent, fallback: true, error: err?.message };
        }
    };

    const isShortPendingClarificationFallback = (message) => {
        const text = String(message || '').trim();
        if (!text || text.length > 80 || /[?.!]\s*$/.test(text)) return false;
        const hasTicker = Boolean(extractTickers(text)[0] || extractTickerFromAliases(text));
        const hasWindow = hasExplicitRunWindow(text) || /\b(defaults?|custom|battle|sidebar|usual|standard|normal)\b/i.test(text);
        return hasTicker || hasWindow;
    };

    const extractTickers = (msg) => {
        const text = msg || '';
        const ignored = new Set(['A', 'I', 'AI', 'API', 'CEO', 'CFO', 'USA', 'US', 'USD', 'ETF', 'ROI', 'SMA', 'EMA', 'RSI', 'ATR', 'MACD']);
        const commonLowercaseSymbols = new Set([
            'spy', 'qqq', 'tqqq', 'sqqq', 'iwm', 'dia', 'vti', 'voo',
            'soxl', 'soxs', 'uvxy', 'svxy',
            'nvda', 'tsla', 'aapl', 'msft', 'amzn', 'meta', 'googl', 'goog',
            'nflx', 'amd', 'mu', 'avgo', 'crwd',
        ]);
        const cashtags = (text.match(/\$[A-Za-z][A-Za-z0-9.-]{0,9}/g) || []).map(t => t.slice(1).toUpperCase());
        const uppercase = (text.match(/\b[A-Z]{1,5}(?:-USD)?\b/g) || []).map(t => t.toUpperCase());
        const commonLowercase = (text.match(/\b[a-z]{2,5}(?:-usd)?\b/g) || [])
            .filter(t => commonLowercaseSymbols.has(t.toLowerCase()))
            .map(t => t.toUpperCase());
        return [...new Set([...cashtags, ...uppercase, ...commonLowercase].filter(t => !ignored.has(t)))];
    };

    const extractTickerFromAliases = (msg) => {
        const normalized = (msg || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!normalized) return '';
        for (const [name, symbol] of Object.entries(companyTickerAliases)) {
            const alias = name.replace(/[^a-z0-9]+/g, ' ').trim();
            if (new RegExp(`(^|\\s)${alias}(\\s|$)`).test(normalized)) return symbol;
        }
        return '';
    };

    const inferTickerFromContext = (msg, thread = activeThread) => {
        const direct = extractTickers(msg)[0] || extractTickerFromAliases(msg);
        if (direct) return direct;
        const recentMessages = [...(thread?.messages || [])]
            .filter(message => message?.role === 'user')
            .slice(-8)
            .reverse();
        for (const message of recentMessages) {
            const content = message?.content || '';
            const contextual = extractTickers(content)[0] || extractTickerFromAliases(content);
            if (contextual) return contextual;
        }
        return '';
    };

    const getInputHistory = () => (activeThread?.messages || [])
        .filter(m => m.role === 'user' && m.content?.trim())
        .map(m => m.content.trim());

    const isCursorOnFirstLine = (el) => {
        const beforeCursor = el.value.slice(0, el.selectionStart ?? 0);
        return !beforeCursor.includes('\n');
    };

    const isCursorOnLastLine = (el) => {
        const afterCursor = el.value.slice(el.selectionEnd ?? el.value.length);
        return !afterCursor.includes('\n');
    };

    const handleMainInputKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
            return;
        }

        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

        const el = e.currentTarget;
        if (e.key === 'ArrowUp' && !isCursorOnFirstLine(el)) return;
        if (e.key === 'ArrowDown' && !isCursorOnLastLine(el)) return;

        const history = getInputHistory();
        if (!history.length) return;

        e.preventDefault();
        if (e.key === 'ArrowUp') {
            const nextIndex = inputHistoryIndex == null
                ? history.length - 1
                : Math.max(0, inputHistoryIndex - 1);
            if (inputHistoryIndex == null) setInputHistoryDraft(input);
            setInputHistoryIndex(nextIndex);
            setInput(history[nextIndex] || '');
            return;
        }

        if (inputHistoryIndex == null) return;
        const nextIndex = inputHistoryIndex + 1;
        if (nextIndex >= history.length) {
            setInputHistoryIndex(null);
            setInput(inputHistoryDraft);
            setInputHistoryDraft('');
        } else {
            setInputHistoryIndex(nextIndex);
            setInput(history[nextIndex] || '');
        }
    };

    const getMaxTokens = () => {
        const lengths = { short: 2048, mid: 8192, long: 16384 };
        return lengths[responseLength] || 8192;
    };

    // ── LLM call with streaming support ──────────────────────────────────────────
    const handleStreamingResponse = async (prompt, intent, threadId) => {
        updateThreadStreamState(threadId, { isStreaming: true, streamingMessage: '' });
        const msgId = addMessage(threadId, 'bot', '');
        updateThreadStreamState(threadId, { currentStreamingId: msgId });
        const controller = new AbortController();
        updateThreadStreamState(threadId, { abortController: controller });

        try {
            const activeKey = getActiveApiKey(aiConfig.provider);
            const activeProvider = normalizeProvider(aiConfig.provider || localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER);
            if (!activeKey && !hasConfiguredApiKey(activeProvider)) {
                addMessage(threadId, 'bot', '⚠️ No API key configured. Go to **LLM Settings** in the sidebar to add your API key before using the Assistant.');
                updateThreadStreamState(threadId, { isStreaming: false, streamingMessage: '' });
                return;
            }

            const endpoint = `${BACKTEST_SERVICE}/ai/chat-with-tools`;

            const thread = threadState.threads.find(t => t.id === threadId);
            const agentHistory = recentAgentContextMessages(thread, 4);
            const requestHistory = buildHistoryWithAgentMemory(thread, historyLimit, 4);
            const enrichedPrompt = enrichPromptWithAgentContext(prompt, thread, intent);

            const payload = {
                message: enrichedPrompt, intent,
                provider: activeProvider,
                model: aiConfig.model || localStorage.getItem('settings_default_model') || DEFAULT_MODEL,
                api_key: activeKey,
                provider_config: getProviderConfig(activeProvider),
                available_files: files,
                available_strategies: strategies.map(s => s.name),
                context: { files_count: files.length, strategies_count: strategies.length, recent_agent_runs: agentHistory },
                history: requestHistory,
                history_limit: historyLimit,
                max_tokens: getMaxTokens(),
                thinking_detail: thinkingDetail,
                agent_instructions: agentInstructions.trim() || null,
            };
            
            console.log('📤 [ChatBot] Sending streaming request:', {
                endpoint,
                provider: payload.provider,
                model: payload.model,
                hasApiKey: !!payload.api_key,
                messagePreview: payload.message.substring(0, 50)
            });

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let thinking = '';
            let steps = [];
            let responseText = '';
            let toolData = {};
            let triggeredTasks = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim() || !line.startsWith('data: ')) continue;
                        
                    try {
                        const data = JSON.parse(line.slice(6));
                            
                            if (data.type === 'status') {
                                const statusText = data.content || 'Backend is working...';
                                updateMessage(threadId, msgId, responseText || statusText, null, thinking || null, steps, null, null);
                            } else if (data.type === 'thinking') {
                                if (data.content && !thinking.includes(data.content)) {
                                    thinking = thinking ? `${thinking}\n${data.content}` : data.content;
                                }
                                updateMessage(threadId, msgId, responseText || '', null, thinking, steps, null, null);
                            } else if (data.type === 'step') {
                                // Backend sends {'type': 'step', 'step': {...}}
                                const stepData = data.step || data;
                                const existingStepIndex = stepData._tool_key
                                    ? steps.findIndex(step => step._tool_key === stepData._tool_key)
                                    : -1;
                                if (existingStepIndex >= 0) {
                                    steps[existingStepIndex] = stepData;
                                } else {
                                    steps.push(stepData);
                                }
                                updateMessage(threadId, msgId, responseText || '', null, thinking || null, steps, null, null);
                                
                                // Keep Actions Taken collapsed by default - user can click to expand if interested
                                // Don't auto-expand even for running steps
                            } else if (data.type === 'progress') {
                                // Show progress in the UI with label, percentage, and detail
                                const progressData = {
                                    label: data.label || 'Processing',
                                    pct: data.pct || 0,
                                    detail: data.detail || ''
                                };
                                const progressText = `⏳ ${progressData.label}${progressData.pct > 0 ? ` (${progressData.pct}%)` : ''}${progressData.detail ? `: ${progressData.detail}` : ''}`;
                                updateMessage(threadId, msgId, responseText || progressText, null, thinking || null, steps, null, null, progressData);
                            } else if (data.type === 'intermediate_response') {
                                const existing = getThreadState(threadId).liveCommentary || [];
                                const updated = data.content && !existing.includes(data.content) ? [...existing, data.content] : existing;
                                updateThreadStreamState(threadId, { liveCommentary: updated });
                                // Keep commentary as ↳ lines only; don't set as bubble content during streaming
                                updateMessage(threadId, msgId, '', null, thinking || null, steps, null, null, null, null, updated);
                            } else if (data.type === 'market_data') {
                                console.log('📊 market_data event received:', data);
                                toolData = data.data || toolData;
                                console.log('📊 toolData set to:', toolData);
                                updateMessage(threadId, msgId, responseText || '', null, thinking || null, steps, toolData, null);
                            } else if (data.type === 'response') {
                                responseText = data.content;
                                updateMessage(threadId, msgId, responseText, null, thinking || null, steps, Array.isArray(toolData) && toolData.length ? toolData : null, null);
                            } else if (data.type === 'task_started') {
                                // Register task in Task Center
                                triggeredTasks.push({
                                    task_id: data.task_id,
                                    task_type: data.task_type || 'forge',
                                    label: data.label || 'Agent Task'
                                });
                                onTrigger(data.task_id, data.task_type || 'forge', data.label || 'Agent Task');
                            } else if (data.type === 'result') {
                                // Final result payload from agent
                                const payload = data.payload || {};
                                responseText = payload.response || responseText;
                                if (payload.reasoning && !thinking.includes(payload.reasoning)) {
                                    thinking = thinking ? `${thinking}\n${payload.reasoning}` : payload.reasoning;
                                }
                                steps = payload.execution_steps || steps;
                                toolData = payload.market_data || {};
                                
                                // Register any triggered tasks from the final payload
                                if (payload.triggered_tasks && Array.isArray(payload.triggered_tasks)) {
                                    payload.triggered_tasks.forEach(t => {
                                        onTrigger(t.task_id, t.task_type || 'forge', t.label || 'Agent Task');
                                    });
                                }
                                
                                const usage = payload.usage || null;
                                updateMessage(threadId, msgId, responseText, null, thinking || null, steps, toolData, payload.backtest_results, null, null, null, usage);
                                
                                // Refresh data after agent completion (strategy generation, downloads, etc.)
                                if (steps.some(s => s.label && s.label.includes('generate'))) {
                                    onRefreshStrats();
                                    setTimeout(() => onRefreshStrats(), 2000);
                                }
                                if (steps.some(s => s.label && s.label.includes('Download'))) {
                                    onRefreshFiles();
                                    setTimeout(() => onRefreshFiles(), 2000);
                                }
                            } else if (data.type === 'done') {
                                if (data.thinking && !thinking.includes(data.thinking)) {
                                    thinking = thinking ? `${thinking}\n${data.thinking}` : data.thinking;
                                }
                                steps = (data.steps || steps).reduce((merged, step) => {
                                    const existingIndex = step?._tool_key
                                        ? merged.findIndex(item => item._tool_key === step._tool_key)
                                        : -1;
                                    if (existingIndex >= 0) merged[existingIndex] = step;
                                    else merged.push(step);
                                    return merged;
                                }, []);
                                // Convert tool_data dict to array format for MarketDataCards
                                const rawToolData = data.data || {};
                                toolData = [];
                                for (const [toolName, result] of Object.entries(rawToolData)) {
                                    // Check if result has chart data
                                    if (result?.type === 'chart' && result?.data) {
                                        toolData.push(result);
                                    }
                                }
                                const finalCommentary = getThreadState(threadId).liveCommentary || [];
                                const usage = data.usage || null;
                                updateMessage(threadId, msgId, responseText, null, thinking || null, steps, toolData, null, null, data.task_id, finalCommentary.length ? finalCommentary : null, usage);
                                // Don't auto-expand - let user click to expand if interested
                                
                                // Refresh data after agent completion (strategy generation, downloads, etc.)
                                if (steps.some(s => s.label && s.label.includes('generate'))) {
                                    onRefreshStrats();
                                    setTimeout(() => onRefreshStrats(), 2000);
                                }
                                if (steps.some(s => s.label && s.label.includes('Download'))) {
                                    onRefreshFiles();
                                    setTimeout(() => onRefreshFiles(), 2000);
                                }
                            } else if (data.type === 'error') {
                                updateMessage(threadId, msgId, `❌ Error: ${data.content}`);
                                break;
                            }
                    } catch (e) {
                        console.error('Failed to parse SSE data:', e, line);
                    }
                }
            }

            // Persist history
            updateThread(threadId, t => ({
                ...t,
                history: [...(t.history || []),
                    { role: 'user', content: prompt },
                    { role: 'assistant', content: responseText }
                ]
            }));

        } catch (err) {
            if (err.name === 'AbortError' || err.code === 'ERR_CANCELED') return;
            console.error('Streaming error:', err);
            updateMessage(threadId, msgId, '❌ Sorry, I encountered an error. Please try again or check your API key in Settings.');
        } finally {
            updateThreadStreamState(threadId, { isStreaming: false, streamingMessage: '', abortController: null, currentStreamingId: null, agentProgress: null, confirmRequest: null, liveCommentary: [] });
        }
    };

    // fire queued message once the assistant is fully idle for the active thread
    useEffect(() => {
        if (!isAssistantBusy && queuedInput) {
            const msg = queuedInput;
            updateThreadStreamState(activeThread.id, { queuedInput: null });
            setInput('');
            // small delay so state settles
            setTimeout(() => {
                submitUserMessage(msg, { clearInput: true });
            }, 50);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAssistantBusy, queuedInput, activeThread.id]);

    // ── stream a generation task and update a message bubble live ─────────────
    const streamGenerationTask = async (tid, msgId, taskId, stratLabel) => {
        const controller = new AbortController();
        let streamText = '';
        let marketAnalysis = '';
        let latestProgress = {
            label: 'Preparing generation',
            pct: 10,
            detail: stratLabel || 'Starting strategy generation',
            streamText: '',
        };

        const applyProgress = () => {
            updateMessage(tid, msgId, '', null, null, [], null, null, latestProgress, taskId);
        };

        try {
            const response = await fetch(`${BACKTEST_SERVICE}/ai/generate/stream/${taskId}`, {
                method: 'GET',
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            applyProgress();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim() || !line.startsWith('data: ')) continue;

                    try {
                        const event = JSON.parse(line.slice(6));

                        if (event.type === 'progress' || event.type === 'heartbeat') {
                            latestProgress = {
                                ...latestProgress,
                                label: event.label || latestProgress.label || 'Generating strategy',
                                pct: event.progress ?? latestProgress.pct ?? 0,
                                detail: event.current || event.detail || latestProgress.detail || '',
                                streamText,
                                marketAnalysis,
                            };
                            applyProgress();
                        } else if (event.type === 'analysis') {
                            marketAnalysis = event.market_analysis || '';
                            latestProgress = {
                                ...latestProgress,
                                label: 'Pattern analysis complete',
                                pct: event.progress ?? 50,
                                detail: event.current || 'Pattern analysis complete',
                                streamText,
                                marketAnalysis,
                            };
                            applyProgress();
                        } else if (event.type === 'token') {
                            if (event.delta) streamText += event.delta;
                            latestProgress = {
                                ...latestProgress,
                                label: 'Generating strategy code',
                                pct: event.progress ?? latestProgress.pct ?? 0,
                                detail: event.current || 'Receiving model output...',
                                streamText,
                                marketAnalysis,
                            };
                            applyProgress();
                        } else if (event.type === 'strategy_saved') {
                            latestProgress = {
                                ...latestProgress,
                                label: 'Saving strategies',
                                pct: event.progress ?? latestProgress.pct ?? 0,
                                detail: `Saved ${event.name}`,
                                streamText,
                                marketAnalysis,
                            };
                            applyProgress();
                        } else if (event.type === 'validation_error') {
                            latestProgress = {
                                ...latestProgress,
                                label: 'Validation issues',
                                pct: event.progress ?? latestProgress.pct ?? 0,
                                detail: event.detail || event.current || 'One candidate failed validation',
                                streamText,
                                marketAnalysis,
                            };
                            applyProgress();
                        } else if (event.type === 'complete') {
                            const strats = event.results?.strategies || [];
                            const savedNames = event.saved_names || [];
                            const name = savedNames[0] || strats[0]?.name || strats[0]?.class_name || stratLabel;
                            const extra = savedNames.length > 1 ? `\nAlso saved: ${savedNames.slice(1).join(', ')}` : '';
                            updateMessage(tid, msgId, `✅ Strategy ready: **${name}**${extra}\n\nYou can now ask me to backtest it.`, null, null, [], null, null, null, taskId);
                            setTimeout(() => onRefreshStrats(), 1000);
                            return;
                        } else if (event.type === 'error') {
                            updateMessage(tid, msgId, `❌ Generation failed: ${event.error || 'Unknown error'}`, null, null, [], null, null, null, taskId);
                            return;
                        }
                    } catch (err) {
                        console.error('Failed to parse generation stream event:', err, line);
                    }
                }
            }

            const { data } = await axios.get(`${BACKTEST_SERVICE}/results/${taskId}`);
            if (data.status === 'completed') {
                const strats = data.results?.strategies || [];
                const name = data.saved_names?.[0] || strats[0]?.name || strats[0]?.class_name || stratLabel;
                updateMessage(tid, msgId, `✅ Strategy ready: **${name}**\n\nYou can now ask me to backtest it.`, null, null, [], null, null, null, taskId);
                setTimeout(() => onRefreshStrats(), 1000);
                return;
            }
            if (data.status === 'failed') {
                updateMessage(tid, msgId, `❌ Generation failed: ${data.error || 'Unknown error'}`, null, null, [], null, null, null, taskId);
                return;
            }
            updateMessage(tid, msgId, `⏳ Generation is still running. Check the AI Forge tab for progress.`, null, null, [], null, null, null, taskId);
        } catch (err) {
            console.error('Generation stream error:', err);
            updateMessage(tid, msgId, `⏳ Live generation stream disconnected. Check the AI Forge tab for progress.`, null, null, [], null, null, null, taskId);
        }
    };

    // ── manual action executor ────────────────────────────────────────────────
    const executeAction = async (action) => {
        const tid = activeThread.id;
        const execId = addMessage(tid, 'bot', `🔄 Executing: ${action.label}...`);
        try {
            switch (action.type) {
                case 'create_strategy': {
                    const r = await axios.post(`${BACKTEST_SERVICE}/ai/generate`, { prompt: action.prompt, count: 1, mode: 'agnostic', provider: aiConfig.provider, model: aiConfig.model, api_key: getActiveApiKey() });
                    onTrigger(r.data.task_id, 'AI Chat: Creating strategy');
                    updateMessage(tid, execId, '', null, null, [], null, null, { label: 'Preparing generation', pct: 10, detail: 'Consulting AI Experts...', streamText: '' }, r.data.task_id);
                    streamGenerationTask(tid, execId, r.data.task_id, action.label);
                    break;
                }
                case 'backtest': {
                    const r = await axios.post(`${BACKTEST_SERVICE}/backtest`, { strategies: [action.strategy], dataset_filename: action.dataset });
                    onTrigger(r.data.task_id, `AI Chat: Backtesting ${action.strategy}`);
                    updateMessage(tid, execId, `✅ Backtest started!\nStrategy: ${action.strategy}\nDataset: ${formatDatasetName(action.dataset)}`);
                    break;
                }
                case 'download_data': {
                    const r = await axios.post(`${DATA_SERVICE}/download`, { tickers: action.tickers, period: action.period || 'max', interval: action.interval || '1d' });
                    onTrigger(r.data.task_id, `AI Chat: Downloading ${action.tickers.join(', ')}`);
                    updateMessage(tid, execId, `✅ Download started!\nTickers: ${action.tickers.join(', ')}`);
                    setTimeout(() => onRefreshFiles(), 2000);
                    break;
                }
                case 'optimize': {
                    const r = await axios.post(`${OPTIMIZER_SERVICE}/ai/improve-auto`, { strategy_name: action.strategy, dataset_filename: action.dataset, iterations: action.iterations || 3, user_prompt: action.prompt, auto_mode: true });
                    updateMessage(tid, execId, `✅ Optimization started!\nStrategy: ${action.strategy}\nSession: ${r.data.session_id}\n\nCheck the Strategic Optimizer tab for progress.`);
                    break;
                }
                case 'list_strategies':
                    updateMessage(tid, execId, strategies.length ? `📚 Strategies (${strategies.length}):\n\n${strategies.map(s => `• ${s.name}`).join('\n')}` : 'No strategies yet.');
                    break;
                case 'list_data':
                    updateMessage(tid, execId, files.length ? `📊 Datasets (${files.length}):\n\n${files.slice(0, 10).map(f => `• ${formatDatasetName(f)}`).join('\n')}` : 'No datasets yet.');
                    break;
                case 'generate_strategy': {
                    const r = await axios.post(`${BACKTEST_SERVICE}/ai/generate`, { prompt: action.description, count: action.count || 1, mode: 'agnostic', provider: aiConfig.provider, model: aiConfig.model, api_key: getActiveApiKey() });
                    onTrigger(r.data.task_id, `AI Chat: Generating strategy`);
                    updateMessage(tid, execId, '', null, null, [], null, null, { label: 'Preparing generation', pct: 10, detail: action.description, streamText: '' }, r.data.task_id);
                    streamGenerationTask(tid, execId, r.data.task_id, action.description);
                    break;
                }
                case 'run_backtest': {
                    const r = await axios.post(`${BACKTEST_SERVICE}/backtest`, { strategies: [action.strategy], dataset_filename: action.dataset });
                    onTrigger(r.data.task_id, `AI Chat: Backtesting ${action.strategy}`);
                    updateMessage(tid, execId, `✅ Backtest started!\nStrategy: ${action.strategy}\nDataset: ${formatDatasetName(action.dataset)}`);
                    break;
                }
                case 'download_market_data': {
                    const r = await axios.post(`${DATA_SERVICE}/download`, { tickers: [action.ticker], period: action.period || '1y', interval: action.interval || '1d' });
                    onTrigger(r.data.task_id, `AI Chat: Downloading ${action.ticker}`);
                    updateMessage(tid, execId, `✅ Download started!\nTicker: ${action.ticker}\nPeriod: ${action.period}\nInterval: ${action.interval}`);
                    setTimeout(() => onRefreshFiles(), 2000);
                    break;
                }
                default:
                    updateMessage(tid, execId, `❌ Unknown action type: ${action.type}`);
            }
        } catch (err) {
            updateMessage(tid, execId, `❌ Failed: ${err.response?.data?.detail || err.message}`);
        }
    };

    const submitUserMessage = async (rawMessage, { clearInput = true } = {}) => {
        if (!rawMessage?.trim()) return;
        const userMsg = rawMessage.trim();
        setInputHistoryIndex(null);
        setInputHistoryDraft('');

        // if currently waiting or streaming, queue the message instead of starting a parallel response
        if (isAssistantBusy) {
            updateThreadStreamState(activeThread.id, { queuedInput: userMsg });
            if (clearInput) setInput('');
            return;
        }

        const tid = activeThread.id;
        if (clearInput) setInput('');
        addMessage(tid, 'user', userMsg);
        autoTitle(tid, userMsg);

        const intentDecision = await classifyIntentWithLLM(userMsg, tid);
        const intent = intentDecision.intent || analyzeIntent(userMsg);

        if (pendingAgentRequest) {
            const ticker = inferTickerFromContext(userMsg) || '';
            const useDefaults = /\b(default|defaults|usual|standard|normal)\b/i.test(userMsg);
            const useCustomBattleParams = /\b(custom|battle|sidebar|these|shown|my params|parameters|settings)\b/i.test(userMsg);
            if (pendingAgentRequest.kind === 'battle_params_confirm' && (useDefaults || useCustomBattleParams)) {
                updateThreadStreamState(tid, { pendingAgentRequest: null });
                const run = await startAgentRun(pendingAgentRequest.workflow, {
                    ...pendingAgentRequest.overrides,
                    ticker: pendingAgentRequest.ticker,
                    prompt: `${pendingAgentRequest.prompt}\nBacktest parameter choice: ${useDefaults ? 'use default agent backtest parameters' : 'use custom sidebar Battle Parameters'}`,
                    use_battle_params: useCustomBattleParams,
                });
                if (run) {
                    addMessage(
                        tid,
                        'bot',
                        `I started the saved request${pendingAgentRequest.ticker ? ` for ${pendingAgentRequest.ticker}` : ''} using ${useDefaults ? 'default backtest parameters' : 'the sidebar Battle Parameters'}. I will keep working here and update the run below.`,
                        null,
                        null,
                        [],
                        null,
                        null,
                        null,
                        null,
                        null,
                        { agentRun: run }
                    );
                    return;
                }
            }
            if (pendingAgentRequest.kind === 'battle_params_confirm') {
                addMessage(tid, 'bot', 'Please reply `defaults` to use the agent defaults, or `custom` to use the sidebar Battle Parameters.');
                return;
            }
            const shouldContinuePending = intentDecision.continues_pending === true || isShortPendingClarificationFallback(userMsg);
            if (!shouldContinuePending) {
                updateThreadStreamState(tid, { pendingAgentRequest: null });
            } else {
            const clarification = pendingAgentRequest.kind === 'strategy_clarify'
                ? {
                    ...inferRunWindow(userMsg),
                    prompt: `${pendingAgentRequest.overrides?.prompt || pendingAgentRequest.prompt}\nUser clarification: ${userMsg}`,
                }
                : {};
            const resolvedTicker = ticker || pendingAgentRequest.ticker || '';
            if (pendingAgentRequest.kind === 'strategy_clarify' || ticker || pendingAgentRequest.ticker) {
                updateThreadStreamState(tid, { pendingAgentRequest: null });
                const run = await startAgentRun(pendingAgentRequest.workflow, {
                    ...pendingAgentRequest.overrides,
                    ...clarification,
                    ticker: resolvedTicker,
                    prompt: clarification.prompt || `${pendingAgentRequest.overrides?.prompt || pendingAgentRequest.prompt}\nConfirmed ticker: ${resolvedTicker || ticker}`,
                });
                if (run) {
                    addMessage(
                        tid,
                        'bot',
                        `I started the saved request${resolvedTicker ? ` for ${resolvedTicker}` : ''}. I will keep working here and update the run below.`,
                        null,
                        null,
                        [],
                        null,
                        null,
                        null,
                        null,
                        null,
                        { agentRun: run }
                    );
                    return;
                }
            } else {
                addMessage(tid, 'bot', 'I still need a ticker symbol before I can start that workflow. Use a symbol like `ARTY`, `$NVDA`, `QQQ`, or `SPY`.');
                return;
            }
            }
        }

        if (shouldUseBackgroundAgent(userMsg, intentDecision)) {
            const workflow = workflowForMessage(userMsg, intentDecision);
            const ticker = intentDecision.ticker || inferTickerFromContext(userMsg) || '';
            const workflowNeedsTicker = !['market_review', 'fundamental_screener'].includes(workflow);
            if (workflowNeedsTicker && !ticker) {
                updateThreadStreamState(tid, {
                    pendingAgentRequest: {
                        workflow,
                        prompt: userMsg,
                        overrides: { prompt: userMsg },
                    },
                });
                addMessage(
                    tid,
                    'bot',
                    'Which ticker should I use for that strategy workflow? Reply with a symbol like `ARTY`, `QQQ`, `$NVDA`, `SPY`, or `AAPL`, then I can download data and continue.'
                );
                return;
            }
            const hasRunWindow = hasExplicitRunWindow(userMsg);
            const shouldAskStrategyClarification = intentDecision.needs_clarification === true
                ? !hasRunWindow
                : Boolean(intentDecision.fallback && needsStrategyClarification(userMsg));
            if (workflowNeedsTicker && shouldAskStrategyClarification) {
                updateThreadStreamState(tid, {
                    pendingAgentRequest: {
                        workflow,
                        prompt: userMsg,
                        overrides: { prompt: userMsg, ticker },
                        kind: 'strategy_clarify',
                        ticker,
                    },
                });
                addMessage(
                    tid,
                    'bot',
                    `What timeframe should I use for ${ticker || 'that ticker'}? Daily swing, 1h intraday, weekly, or something else. If you want, say \`defaults\` and I’ll use the usual setup.`
                );
                return;
            }
            if (workflowNeedsTicker && agentAskBattleParams) {
                updateThreadStreamState(tid, {
                    pendingAgentRequest: {
                        workflow,
                        prompt: userMsg,
                        overrides: { prompt: userMsg, ticker },
                        kind: 'battle_params_confirm',
                        ticker,
                    },
                });
                addMessage(
                    tid,
                    'bot',
                    `Use default backtest parameters for ${ticker || 'this run'}, or use the sidebar Battle Parameters? Reply \`defaults\` or \`custom\`.`
                );
                return;
            }
            const run = await startAgentRun(workflow, { prompt: userMsg, ticker: workflowNeedsTicker ? ticker : '' });
            if (run) {
                const startMessage = workflow === 'fundamental_screener'
                    ? 'I started a fundamental screener run. You can keep chatting while I load market context, screen candidates, enrich them, and update the run below.'
                    : 'I started working on that. You can keep chatting while I check data freshness, run the needed jobs, and update the run below.';
                addMessage(
                    tid,
                    'bot',
                    startMessage,
                    null,
                    null,
                    [],
                    null,
                    null,
                    null,
                    null,
                    null,
                    { agentRun: run }
                );
                return;
            }
        }

        await handleStreamingResponse(userMsg, intent, tid);
    };

    // ── send ──────────────────────────────────────────────────────────────────
    const handleSend = async () => {
        const userMsg = input.trim();
        if (!userMsg) return;
        const latest = getThreadState(activeThread.id, threadStreamingStateRef.current);
        const latestBusy = latest.isStreaming || !!latest.currentStreamingId || !!latest.pendingAgentRequest;
        if (latestBusy) {
            setInputHistoryIndex(null);
            setInputHistoryDraft('');
            updateThreadStreamState(activeThread.id, { queuedInput: userMsg });
            setInput('');
            return;
        }
        await submitUserMessage(input, { clearInput: true });
    };

    const consumedAutoPromptRef = useRef(null);
    useEffect(() => {
        if (!autoPrompt?.id || !autoPrompt.prompt) return;
        if (consumedAutoPromptRef.current === autoPrompt.id) return;
        if (isLoading) return;
        consumedAutoPromptRef.current = autoPrompt.id;
        submitUserMessage(autoPrompt.prompt, { clearInput: false }).finally(() => {
            onAutoPromptConsumed?.();
        });
    }, [autoPrompt?.id, isLoading]);

    const formatTs = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formatDate = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const formatElapsed = (seconds = 0) => {
        const s = Math.max(0, Number(seconds) || 0);
        const m = Math.floor(s / 60);
        const r = s % 60;
        return m > 0 ? `${m}m ${r}s` : `${r}s`;
    };

    // ── render reply thread ────────────────────────────────────────────────────
    const ReplyThread = ({ replies, parentId }) => {
        if (!replies?.length) return null;
        return (
            <div style={{ marginTop: '0.75rem', paddingLeft: '1rem', borderLeft: '2px solid rgba(59,130,246,0.3)' }}>
                {replies.map(reply => (
                    <motion.div key={reply.id}
                        initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                        style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'flex-start' }}
                    >
                        <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: reply.type === 'bot' ? 'var(--brand-blue)' : 'var(--brand-green)', fontSize: '0.7rem' }}>
                            {reply.type === 'bot' ? <Bot size={14} color="white" /> : <User size={14} color="white" />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
                                <span style={{ fontWeight: 600, fontSize: '0.8rem' }}>{reply.type === 'bot' ? 'AI' : 'You'}</span>
                                <span style={{ fontSize: '0.65rem', opacity: 0.4 }}>{formatTs(reply.timestamp)}</span>
                            </div>
                            <div style={{ background: reply.type === 'bot' ? 'rgba(59,130,246,0.08)' : 'rgba(34,197,94,0.08)', padding: '0.6rem 0.8rem', borderRadius: '8px', border: `1px solid ${reply.type === 'bot' ? 'rgba(59,130,246,0.15)' : 'rgba(34,197,94,0.15)'}`, lineHeight: 1.5, fontSize: '0.85rem' }}>
                                {reply.type === 'bot' ? renderMarkdown(reply.content) : reply.content}
                            </div>
                            {reply.replies?.length > 0 && <ReplyThread replies={reply.replies} parentId={reply.id} />}
                        </div>
                    </motion.div>
                ))}
            </div>
        );
    };

    // ── market data card renderers ─────────────────────────────────────────────
    const QuoteCard = ({ data }) => {
        if (!data) return null;
        const up = data.change >= 0;
        return (
            <div className="terminal-card" style={{ marginTop: '0.6rem', display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center', padding: '0.85rem 1rem' }}>
                <div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 800 }}>{data.symbol}</div>
                    <div style={{ fontSize: '0.72rem', opacity: 0.5 }}>{data.name}</div>
                </div>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>${data.price?.toLocaleString()}</div>
                    <div style={{ fontSize: '0.82rem', color: up ? 'var(--brand-green)' : 'var(--brand-red)', fontWeight: 600 }}>
                        {up ? '▲' : '▼'} {Math.abs(data.change)} ({Math.abs(data.change_percent)}%)
                    </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem 1.2rem', fontSize: '0.75rem', opacity: 0.7 }}>
                    <span>H: ${data.high}</span><span>L: ${data.low}</span>
                    <span>Vol: {data.volume?.toLocaleString()}</span>
                    <span>P/E: {data.pe_ratio?.toFixed(1) ?? 'N/A'}</span>
                </div>
            </div>
        );
    };

    const TechnicalsCard = ({ data }) => {
        if (!data) return null;
        const trendColor = data.trend === 'bullish' ? 'var(--brand-green)' : data.trend === 'bearish' ? 'var(--brand-red)' : 'var(--brand-yellow)';
        const rsi = data.rsi_14;
        const rsiColor = rsi > 70 ? 'var(--brand-red)' : rsi < 30 ? 'var(--brand-green)' : 'var(--brand-yellow)';
        return (
            <div className="terminal-card" style={{ marginTop: '0.6rem', padding: '0.85rem 1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
                    <span style={{ fontWeight: 700 }}>{data.symbol} Technicals</span>
                    <span style={{ fontSize: '0.78rem', fontWeight: 700, color: trendColor, textTransform: 'uppercase' }}>{data.trend}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', fontSize: '0.78rem' }}>
                    {[['SMA 20', data.sma_20], ['SMA 50', data.sma_50], ['SMA 200', data.sma_200],
                      ['Support', data.support], ['Resistance', data.resistance], ['Volatility', data.volatility ? `${data.volatility}%` : null]
                    ].map(([label, val]) => (
                        <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '6px', padding: '0.4rem 0.6rem' }}>
                            <div style={{ opacity: 0.5, fontSize: '0.68rem' }}>{label}</div>
                            <div style={{ fontWeight: 600 }}>{val != null ? (typeof val === 'number' ? `$${val}` : val) : 'N/A'}</div>
                        </div>
                    ))}
                </div>
                {rsi != null && (
                    <div style={{ marginTop: '0.6rem', fontSize: '0.78rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                            <span style={{ opacity: 0.6 }}>RSI 14</span>
                            <span style={{ color: rsiColor, fontWeight: 700 }}>{rsi} {rsi > 70 ? '(Overbought)' : rsi < 30 ? '(Oversold)' : '(Neutral)'}</span>
                        </div>
                        <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px' }}>
                            <div style={{ height: '100%', width: `${rsi}%`, background: rsiColor, borderRadius: '2px', transition: 'width 0.5s' }} />
                        </div>
                    </div>
                )}
            </div>
        );
    };

    const NewsCard = ({ items }) => {
        if (!items?.length) return null;
        return (
            <div className="terminal-card" style={{ marginTop: '0.6rem', padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '0.5rem 0.85rem', fontSize: '0.68rem', opacity: 0.45, borderBottom: '1px solid rgba(255,255,255,0.05)', letterSpacing: '0.06em' }}>LATEST NEWS</div>
                {items.slice(0, 4).map((n, i) => (
                    <a key={i} href={n.link} target="_blank" rel="noreferrer" style={{ display: 'block', padding: '0.55rem 0.85rem', borderBottom: i < Math.min(items.length, 4) - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', textDecoration: 'none', color: 'inherit' }}>
                        <div style={{ fontSize: '0.8rem', fontWeight: 500, lineHeight: 1.35 }}>{n.title}</div>
                        <div style={{ fontSize: '0.68rem', opacity: 0.4, marginTop: '2px' }}>{n.publisher}</div>
                    </a>
                ))}
            </div>
        );
    };

    const BacktestResultsCard = ({ results }) => {
        if (!results?.length) return null;
        const best = results[0];
        return (
            <div className="terminal-card" style={{ marginTop: '0.6rem', padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '0.5rem 0.85rem', fontSize: '0.68rem', opacity: 0.45, borderBottom: '1px solid rgba(255,255,255,0.05)', letterSpacing: '0.06em', display: 'flex', justifyContent: 'space-between' }}>
                    <span>BACKTEST RESULTS</span>
                    <span style={{ color: best.roi >= 0 ? 'var(--brand-green)' : 'var(--brand-red)' }}>Best: {best.roi?.toFixed(2)}% ROI</span>
                </div>
                {results.slice(0, 6).map((r, i) => {
                    const up = r.roi >= 0;
                    const stats = r.statistics || {};
                    return (
                        <div key={i} style={{ padding: '0.55rem 0.85rem', borderBottom: i < results.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: '0.82rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.strategy}</div>
                                <div style={{ fontSize: '0.7rem', opacity: 0.45, marginTop: '2px', display: 'flex', gap: '0.75rem' }}>
                                    {stats.total_trades != null && <span>{stats.total_trades} trades</span>}
                                    {stats.win_rate != null && <span>Win: {(stats.win_rate * 100).toFixed(0)}%</span>}
                                    {stats.max_drawdown != null && <span>DD: {stats.max_drawdown?.toFixed(1)}%</span>}
                                </div>
                            </div>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color: up ? 'var(--brand-green)' : 'var(--brand-red)', flexShrink: 0 }}>
                                {up ? '+' : ''}{r.roi?.toFixed(2)}%
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    };

    const MarketDataCards = ({ marketData }) => {
        console.log('MarketDataCards received:', marketData);
        if (!marketData?.length) {
            console.warn('MarketDataCards: No marketData', marketData);
            return null;
        }
        const itemKey = (item, i) => {
            if (item.type === 'chart') {
                const first = item.data?.[0]?.date || item.data?.[0]?.Date || '';
                const last = item.data?.[item.data.length - 1]?.date || item.data?.[item.data.length - 1]?.Date || '';
                return `chart:${item.symbol || 'unknown'}:${item.data?.length || 0}:${first}:${last}`;
            }
            return `${item.type || 'data'}:${item.symbol || item.ticker || i}`;
        };
        return (
            <div>
                {marketData.map((item, i) => {
                    console.log(`MarketDataCards item ${i}:`, item);
                    const key = itemKey(item, i);
                    if (item.type === 'quote') return <QuoteCard key={key} data={item.data} />;
                    if (item.type === 'technicals') return <TechnicalsCard key={key} data={item.data} />;
                    if (item.type === 'chart') {
                        console.log(`Rendering MiniChart for ${item.symbol} with ${item.data?.length} bars`);
                        return <MiniChart key={key} symbol={item.symbol} bars={item.data} />;
                    }
                    if (item.type === 'news') return <NewsCard key={key} items={item.data} />;
                    if (item.type === 'full') return (
                        <div key={key}>
                            <QuoteCard data={item.quote} />
                            <TechnicalsCard data={item.technicals} />
                            <NewsCard items={item.news} />
                        </div>
                    );
                    return null;
                })}
            </div>
        );
    };

    // ── enhanced markdown renderer ──────────────────────────────────────────────
    const renderMarkdown = (text) => {
        // Guard: coerce to string, handle null/undefined/objects/numbers
        if (text === null || text === undefined) return null;
        if (typeof text !== 'string') text = String(text);
        if (!text.trim()) return null;
        const lines = text.split('\n');
        const elements = [];
        let i = 0;

        const inlineFormat = (str, key) => {
            // Guard against non-string input
            if (str === null || str === undefined) return null;
            if (typeof str !== 'string') str = String(str);
            const parts = [];
            
            // Enhanced regex to support links, bold, italic, code, strikethrough, and inline math
            // Added support for \text{...} and \frac{...}{...}
            const re = /(\[([^\]]+)\]\(([^)]+)\)|\\text\{([^}]+)\}|\\frac\{([^}]+)\}\{([^}]+)\}|\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|~~(.+?)~~|\*([^*]+)\*|_([^_]+)_)/g;
            let last = 0, m;
            while ((m = re.exec(str)) !== null) {
                if (m.index > last) parts.push(str.slice(last, m.index));
                
                // Link: [text](url)
                if (m[1] && m[2] && m[3]) {
                    parts.push(
                        <a key={m.index} href={m[3]} target="_blank" rel="noopener noreferrer" 
                           style={{ color: 'var(--brand-blue)', textDecoration: 'underline', cursor: 'pointer' }}>
                            {m[2]}
                        </a>
                    );
                }
                // LaTeX text: \text{...}
                else if (m[4]) {
                    parts.push(
                        <span key={m.index} style={{ 
                            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
                            fontSize: '0.9em'
                        }}>
                            {m[4]}
                        </span>
                    );
                }
                // LaTeX fraction: \frac{numerator}{denominator}
                else if (m[5] && m[6]) {
                    parts.push(
                        <span key={m.index} style={{ 
                            display: 'inline-flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            fontSize: '0.85em',
                            verticalAlign: 'middle',
                            margin: '0 0.2em'
                        }}>
                            <span style={{ borderBottom: '1px solid currentColor', paddingBottom: '1px' }}>{m[5]}</span>
                            <span style={{ paddingTop: '1px' }}>{m[6]}</span>
                        </span>
                    );
                }
                // Bold: **text** or __text__
                else if (m[7] || m[8]) {
                    parts.push(<strong key={m.index} style={{ fontWeight: 700 }}>{m[7] || m[8]}</strong>);
                }
                // Inline code: `code`
                else if (m[9]) {
                    parts.push(
                        <code key={m.index} style={{ 
                            background: 'rgba(255,255,255,0.12)', 
                            borderRadius: '4px', 
                            padding: '2px 6px', 
                            fontSize: '0.88em', 
                            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
                            color: 'rgba(255,255,255,0.95)',
                            border: '1px solid rgba(255,255,255,0.08)'
                        }}>
                            {m[9]}
                        </code>
                    );
                }
                // Strikethrough: ~~text~~
                else if (m[10]) {
                    parts.push(<del key={m.index} style={{ opacity: 0.6 }}>{m[10]}</del>);
                }
                // Italic: *text* or _text_
                else if (m[11] || m[12]) {
                    parts.push(<em key={m.index} style={{ fontStyle: 'italic' }}>{m[11] || m[12]}</em>);
                }
                
                last = m.index + m[0].length;
            }
            if (last < str.length) parts.push(str.slice(last));
            return <span key={key}>{parts}</span>;
        };

        while (i < lines.length) {
            const line = lines[i];

            // LaTeX-style math blocks: \[ ... \] (display math)
            if (line.trim().startsWith('\\[')) {
                const mathLines = [line.replace('\\[', '').trim()];
                i++;
                while (i < lines.length && !lines[i].includes('\\]')) {
                    mathLines.push(lines[i]);
                    i++;
                }
                if (i < lines.length) {
                    mathLines.push(lines[i].replace('\\]', '').trim());
                }
                // Render as formatted code block for math
                elements.push(
                    <div key={i} style={{ 
                        background: 'rgba(59,130,246,0.08)', 
                        borderRadius: '8px', 
                        padding: '0.75rem 1rem', 
                        margin: '0.6rem 0',
                        border: '1px solid rgba(59,130,246,0.2)',
                        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
                        fontSize: '0.9rem',
                        textAlign: 'center',
                        color: 'rgba(255,255,255,0.95)'
                    }}>
                        {mathLines.join(' ')}
                    </div>
                );
                i++;
                continue;
            }

            // fenced code block with syntax highlighting styles
            if (line.startsWith('```')) {
                const lang = line.slice(3).trim();
                const codeLines = [];
                i++;
                while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
                elements.push(
                    <pre key={i} style={{ 
                        background: 'rgba(0,0,0,0.4)', 
                        borderRadius: '8px', 
                        padding: '0.75rem 1rem', 
                        overflowX: 'auto', 
                        fontSize: '0.85rem', 
                        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
                        margin: '0.6rem 0',
                        border: '1px solid rgba(255,255,255,0.08)',
                        lineHeight: 1.5
                    }}>
                        {lang && (
                            <div style={{ 
                                fontSize: '0.7rem', 
                                opacity: 0.5, 
                                marginBottom: '6px', 
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                                fontWeight: 600
                            }}>
                                {lang}
                            </div>
                        )}
                        <code style={{ color: 'rgba(255,255,255,0.9)' }}>{codeLines.join('\n')}</code>
                    </pre>
                );
                i++;
                continue;
            }

            // blockquote
            if (line.startsWith('> ')) {
                const quoteLines = [];
                while (i < lines.length && lines[i].startsWith('> ')) {
                    quoteLines.push(lines[i].slice(2));
                    i++;
                }
                elements.push(
                    <div key={i} style={{ 
                        borderLeft: '3px solid var(--brand-blue)', 
                        paddingLeft: '0.85rem', 
                        marginLeft: '0.25rem',
                        opacity: 0.85,
                        fontStyle: 'italic',
                        margin: '0.5rem 0'
                    }}>
                        {quoteLines.map((q, idx) => (
                            <div key={idx} style={{ lineHeight: 1.6 }}>{inlineFormat(q, `${i}-${idx}`)}</div>
                        ))}
                    </div>
                );
                continue;
            }

            // table detection (simple markdown tables)
            if (line.includes('|') && lines[i + 1]?.match(/^\|?[\s:-]+\|/)) {
                const tableLines = [line];
                i++;
                // separator line
                tableLines.push(lines[i]);
                i++;
                // data rows
                while (i < lines.length && lines[i].includes('|')) {
                    tableLines.push(lines[i]);
                    i++;
                }
                
                const rows = tableLines.map(l => 
                    l.split('|').map(cell => cell.trim()).filter(cell => cell)
                );
                
                if (rows.length >= 2) {
                    elements.push(
                        <div key={i} style={{ overflowX: 'auto', margin: '0.6rem 0' }}>
                            <table style={{ 
                                width: '100%', 
                                borderCollapse: 'collapse',
                                fontSize: '0.85rem',
                                background: 'rgba(0,0,0,0.2)',
                                borderRadius: '6px',
                                overflow: 'hidden'
                            }}>
                                <thead>
                                    <tr style={{ background: 'rgba(255,255,255,0.05)' }}>
                                        {rows[0].map((cell, idx) => (
                                            <th key={idx} style={{ 
                                                padding: '0.5rem 0.75rem', 
                                                textAlign: 'left',
                                                fontWeight: 700,
                                                borderBottom: '2px solid rgba(255,255,255,0.1)'
                                            }}>
                                                {inlineFormat(cell, `th-${idx}`)}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.slice(2).map((row, rowIdx) => (
                                        <tr key={rowIdx} style={{ 
                                            borderBottom: rowIdx < rows.length - 3 ? '1px solid rgba(255,255,255,0.05)' : 'none'
                                        }}>
                                            {row.map((cell, cellIdx) => (
                                                <td key={cellIdx} style={{ 
                                                    padding: '0.5rem 0.75rem',
                                                    lineHeight: 1.5
                                                }}>
                                                    {inlineFormat(cell, `td-${rowIdx}-${cellIdx}`)}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    );
                }
                continue;
            }

            // heading with better styling
            const hMatch = line.match(/^(#{1,6})\s+(.+)/);
            if (hMatch) {
                const level = hMatch[1].length;
                const sizes = ['1.25rem', '1.1rem', '1rem', '0.95rem', '0.9rem', '0.85rem'];
                const weights = [800, 700, 700, 600, 600, 600];
                const margins = ['0.8rem 0 0.4rem', '0.7rem 0 0.35rem', '0.6rem 0 0.3rem', '0.5rem 0 0.25rem', '0.4rem 0 0.2rem', '0.3rem 0 0.15rem'];
                elements.push(
                    <div key={i} style={{ 
                        fontWeight: weights[level - 1], 
                        fontSize: sizes[level - 1], 
                        margin: margins[level - 1],
                        color: 'rgba(255,255,255,0.95)',
                        letterSpacing: level <= 2 ? '0.01em' : '0'
                    }}>
                        {inlineFormat(hMatch[2], i)}
                    </div>
                );
                i++; 
                continue;
            }

            // horizontal rule with better styling
            if (/^[-*_]{3,}$/.test(line.trim())) {
                elements.push(
                    <hr key={i} style={{ 
                        border: 'none', 
                        borderTop: '2px solid rgba(255,255,255,0.12)', 
                        margin: '0.75rem 0',
                        borderRadius: '1px'
                    }} />
                );
                i++; 
                continue;
            }

            // bullet list with better spacing
            if (/^[\-\*]\s/.test(line)) {
                const items = [];
                while (i < lines.length && /^[\-\*]\s/.test(lines[i])) {
                    items.push(
                        <li key={i} style={{ 
                            marginBottom: '0.3rem',
                            lineHeight: 1.6,
                            paddingLeft: '0.25rem'
                        }}>
                            {inlineFormat(lines[i].replace(/^[\-\*]\s/, ''), i)}
                        </li>
                    );
                    i++;
                }
                elements.push(
                    <ul key={`ul-${i}`} style={{ 
                        paddingLeft: '1.5rem', 
                        margin: '0.5rem 0', 
                        listStyle: 'disc',
                        listStylePosition: 'outside'
                    }}>
                        {items}
                    </ul>
                );
                continue;
            }

            // numbered list with better spacing
            if (/^\d+\.\s/.test(line)) {
                const items = [];
                while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
                    items.push(
                        <li key={i} style={{ 
                            marginBottom: '0.3rem',
                            lineHeight: 1.6,
                            paddingLeft: '0.25rem'
                        }}>
                            {inlineFormat(lines[i].replace(/^\d+\.\s/, ''), i)}
                        </li>
                    );
                    i++;
                }
                elements.push(
                    <ol key={`ol-${i}`} style={{ 
                        paddingLeft: '1.5rem', 
                        margin: '0.5rem 0',
                        listStylePosition: 'outside'
                    }}>
                        {items}
                    </ol>
                );
                continue;
            }

            // blank line → spacing
            if (line.trim() === '') {
                elements.push(<div key={i} style={{ height: '0.5rem' }} />);
                i++; 
                continue;
            }

            // normal paragraph with better line height
            elements.push(
                <div key={i} style={{ 
                    lineHeight: 1.65,
                    marginBottom: '0.25rem',
                    color: 'rgba(255,255,255,0.9)'
                }}>
                    {inlineFormat(line, i)}
                </div>
            );
            i++;
        }
        return elements;
    };

    const getStepTone = (status) => {
        if (status === 'success') return { color: 'var(--brand-green)', background: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.22)', label: 'Done' };
        if (status === 'error') return { color: 'var(--brand-red)', background: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.24)', label: 'Error' };
        if (status === 'running') return { color: 'var(--brand-blue)', background: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.24)', label: 'Running' };
        return { color: 'rgba(255,255,255,0.55)', background: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.12)', label: 'Queued' };
    };

    const compactTraceSteps = (steps = []) => {
        const visibleSteps = steps.filter(s => s.status !== 'info');
        const compacted = [];
        let pollCount = 0;
        for (const step of visibleSteps) {
            if (step.label?.includes('check_task_status')) {
                pollCount += 1;
                continue;
            }
            if (pollCount > 0) {
                compacted.push({ label: `Polled task status ${pollCount} times`, status: 'success', _poll: true });
                pollCount = 0;
            }
            compacted.push(step);
        }
        if (pollCount > 0) compacted.push({ label: `Polled task status ${pollCount} times`, status: 'success', _poll: true });
        return compacted;
    };

    const renderReactTrace = (msg) => {
        const isRunning = msg.id === currentStreamingId;
        const isExpanded = isRunning ? true : Boolean(expandedSteps[msg.id]);
        const showAll = Boolean(expandedReasoning[msg.id + '_all']);
        const compacted = compactTraceSteps(msg.steps || []);
        const commentary = (msg.commentary || []).map(line => ({ _commentary: true, line }));
        const traceItems = [...compacted, ...commentary];
        const hasReasoning = Boolean(msg.reasoning);
        const PREVIEW = isRunning ? 8 : 5;
        const displayItems = showAll ? traceItems : traceItems.slice(-PREVIEW);
        const successCount = compacted.filter(s => s.status === 'success').length;
        const runningCount = compacted.filter(s => s.status === 'running').length;
        const errorCount = compacted.filter(s => s.status === 'error').length;
        const summary = [
            `${compacted.length} actions`,
            successCount ? `${successCount} done` : null,
            runningCount ? `${runningCount} running` : null,
            errorCount ? `${errorCount} errors` : null,
            hasReasoning ? 'thoughts' : null,
        ].filter(Boolean).join(' · ');
        const latestStep = [...traceItems].reverse().find(item => item.label || item.line);
        const preview = latestStep?._commentary ? latestStep.line : latestStep?.label;
        const renderToolJson = (value) => {
            try {
                return JSON.stringify(value, null, 2);
            } catch {
                return String(value);
            }
        };

        return (
            <div style={{ marginBottom: '0.55rem' }}>
                <button
                    onClick={() => setExpandedSteps(prev => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.55rem', padding: '0.42rem 0.1rem', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                >
                    <div style={{ width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: isRunning ? 'rgba(59,130,246,0.14)' : 'rgba(255,255,255,0.06)', color: isRunning ? 'var(--brand-blue)' : 'rgba(255,255,255,0.58)', flexShrink: 0 }}>
                        {isRunning ? <RefreshCw className="animate-spin" size={14} /> : <Check size={14} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontSize: '0.78rem', fontWeight: 750, color: 'rgba(255,255,255,0.78)' }}>{isRunning ? 'Thinking...' : 'Thought process'}</span>
                            {summary && <span style={{ fontSize: '0.66rem', opacity: 0.42 }}>{summary}</span>}
                        </div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.48, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {preview || (isRunning ? 'Deciding whether tools are needed...' : 'Click to inspect the tool path')}
                        </div>
                    </div>
                    <span style={{ fontSize: '0.68rem', opacity: 0.42 }}>{isExpanded ? 'Hide' : 'Show'}</span>
                </button>
                <AnimatePresence>
                    {isExpanded && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
                            <div style={{ marginTop: '0.15rem', marginLeft: '0.7rem', padding: '0.7rem 0 0.3rem 1rem', borderLeft: '1px solid rgba(148,163,184,0.18)' }}>
                                {hasReasoning && (
                                    <div style={{ marginBottom: traceItems.length ? '0.75rem' : 0 }}>
                                        <div style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.42, marginBottom: '0.35rem' }}>Thought</div>
                                        <div style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '0.6rem 0.7rem', color: 'rgba(255,255,255,0.72)', fontSize: '0.8rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', maxHeight: isRunning ? '160px' : '220px', overflowY: 'auto' }}>
                                            {msg.reasoning}
                                            {isRunning && <span style={{ opacity: 0.55 }}> |</span>}
                                        </div>
                                    </div>
                                )}
                                {traceItems.length > 0 && (
                                    <div>
                                        <div style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.42, marginBottom: '0.45rem' }}>Tools</div>
                                        {traceItems.length > PREVIEW && !showAll && (
                                            <button onClick={() => setExpandedReasoning(prev => ({ ...prev, [msg.id + '_all']: true }))}
                                                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.46)', fontSize: '0.72rem', textAlign: 'left', padding: '0 0 0.45rem 0' }}>
                                                Show {traceItems.length - PREVIEW} earlier events
                                            </button>
                                        )}
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                                            {displayItems.map((item, i) => {
                                                if (item._commentary) {
                                                    return (
                                                        <div key={`commentary-${i}`} style={{ display: 'flex', gap: '0.55rem', color: 'rgba(255,255,255,0.58)', fontSize: '0.78rem', lineHeight: 1.5 }}>
                                                            <span style={{ opacity: 0.35, flexShrink: 0 }}>note</span>
                                                            <span>{item.line}</span>
                                                        </div>
                                                    );
                                                }
                                                const tone = getStepTone(item.status);
                                                const toolDetailsKey = `${msg.id}_tool_${item._tool_key || item.tool || i}`;
                                                const hasToolDetails = Boolean(item.tool_args || item.tool_result || item.tool_error);
                                                const showToolDetails = Boolean(expandedReasoning[toolDetailsKey]);
                                                return (
                                                    <div key={`step-${i}`} style={{ display: 'grid', gridTemplateColumns: '76px minmax(0, 1fr)', gap: '0.65rem', alignItems: 'start' }}>
                                                        <span style={{ justifySelf: 'start', border: `1px solid ${tone.border}`, background: tone.background, color: tone.color, borderRadius: '999px', padding: '0.15rem 0.45rem', fontSize: '0.62rem', fontWeight: 800 }}>
                                                            {item._poll ? 'Poll' : tone.label}
                                                        </span>
                                                        <div style={{ minWidth: 0 }}>
                                                            <div style={{ color: item._poll ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.78)', fontSize: '0.78rem', fontWeight: item._poll ? 500 : 650, overflowWrap: 'anywhere' }}>
                                                                {item.label || item.tool || 'Tool step'}
                                                            </div>
                                                            {item.note && <div style={{ marginTop: '0.18rem', opacity: 0.45, fontSize: '0.72rem', lineHeight: 1.45, overflowWrap: 'anywhere' }}>{String(item.note).slice(0, 180)}</div>}
                                                            {hasToolDetails && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setExpandedReasoning(prev => ({ ...prev, [toolDetailsKey]: !prev[toolDetailsKey] }))}
                                                                    style={{ marginTop: '0.28rem', background: 'transparent', border: 'none', color: 'var(--brand-blue)', cursor: 'pointer', fontSize: '0.68rem', padding: 0 }}
                                                                >
                                                                    {showToolDetails ? 'Hide full tool JSON' : 'Show full tool JSON'}
                                                                </button>
                                                            )}
                                                            {hasToolDetails && showToolDetails && (
                                                                <div style={{ marginTop: '0.45rem', display: 'grid', gap: '0.45rem' }}>
                                                                    {item.tool_args && (
                                                                        <div>
                                                                            <div style={{ fontSize: '0.62rem', fontWeight: 800, opacity: 0.42, textTransform: 'uppercase', marginBottom: '0.25rem' }}>Input</div>
                                                                            <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', padding: '0.55rem 0.65rem', borderRadius: 6, border: '1px solid rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.42)', color: 'rgba(226,232,240,0.76)', fontSize: '0.66rem', lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{renderToolJson(item.tool_args)}</pre>
                                                                        </div>
                                                                    )}
                                                                    {item.tool_result && (
                                                                        <div>
                                                                            <div style={{ fontSize: '0.62rem', fontWeight: 800, opacity: 0.42, textTransform: 'uppercase', marginBottom: '0.25rem' }}>Result</div>
                                                                            <pre style={{ margin: 0, maxHeight: 420, overflow: 'auto', padding: '0.55rem 0.65rem', borderRadius: 6, border: '1px solid rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.42)', color: 'rgba(226,232,240,0.76)', fontSize: '0.66rem', lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{renderToolJson(item.tool_result)}</pre>
                                                                        </div>
                                                                    )}
                                                                    {item.tool_error && (
                                                                        <div>
                                                                            <div style={{ fontSize: '0.62rem', fontWeight: 800, opacity: 0.42, textTransform: 'uppercase', marginBottom: '0.25rem' }}>Error</div>
                                                                            <pre style={{ margin: 0, maxHeight: 180, overflow: 'auto', padding: '0.55rem 0.65rem', borderRadius: 6, border: '1px solid rgba(239,68,68,0.22)', background: 'rgba(239,68,68,0.06)', color: 'rgba(254,202,202,0.85)', fontSize: '0.66rem', lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(item.tool_error)}</pre>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        {traceItems.length > PREVIEW && showAll && (
                                            <button onClick={() => setExpandedReasoning(prev => ({ ...prev, [msg.id + '_all']: false }))}
                                                style={{ marginTop: '0.5rem', background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.46)', fontSize: '0.72rem', textAlign: 'left', padding: 0 }}>
                                                Show less
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        );
    };

    const AgentEventDetail = ({ event, muted = false }) => {
        if (!event) return null;
        const detail = event.detail ? String(event.detail).slice(0, 520) : '';
        const preview = event.preview ? String(event.preview).slice(0, 1400) : '';
        if (!detail && !preview) return null;
        return (
            <div style={{ marginTop: '0.28rem', display: 'flex', flexDirection: 'column', gap: '0.28rem' }}>
                {detail && (
                    <div style={{ opacity: muted ? 0.52 : 0.66, overflowWrap: 'anywhere' }}>
                        {detail}
                    </div>
                )}
                {preview && (
                    <pre style={{
                        margin: 0,
                        maxHeight: 118,
                        overflow: 'auto',
                        padding: '0.45rem 0.5rem',
                        borderRadius: 6,
                        border: '1px solid rgba(148,163,184,0.16)',
                        background: 'rgba(15,23,42,0.38)',
                        color: 'rgba(226,232,240,0.72)',
                        fontSize: '0.66rem',
                        lineHeight: 1.45,
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    }}>
                        {preview}
                    </pre>
                )}
            </div>
        );
    };

    const parseAgentTimestamp = (value) => {
        if (!value) return NaN;
        const raw = String(value);
        const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
        if (hasTimezone) return new Date(raw).getTime();
        const localMs = new Date(raw).getTime();
        const utcMs = new Date(`${raw}Z`).getTime();
        if (!Number.isFinite(localMs)) return utcMs;
        if (!Number.isFinite(utcMs)) return localMs;
        return Math.abs(agentNow - localMs) <= Math.abs(agentNow - utcMs) ? localMs : utcMs;
    };

    const agentEventAge = (event) => {
        if (!event?.ts) return '';
        const ts = parseAgentTimestamp(event.ts);
        if (!Number.isFinite(ts)) return '';
        const seconds = Math.max(0, Math.floor((agentNow - ts) / 1000));
        if (seconds < 3) return 'just now';
        return `${formatElapsed(seconds)} ago`;
    };

    const AgentRunCard = ({ run }) => {
        if (!run) return null;
        const planSteps = run.plan_steps || [];
        const isRunningRun = !isAgentTerminalStatus(run.status);
        const canContinueRun = isAgentTerminalStatus(run.status);
        const stepColor = (status) => {
            if (status === 'completed') return 'var(--brand-green)';
            if (status === 'running') return 'var(--brand-blue)';
            if (status === 'failed') return 'var(--brand-red)';
            if (status === 'skipped' || status === 'stopped' || status === 'stale') return 'var(--brand-yellow)';
            return 'rgba(255,255,255,0.28)';
        };
        const runLabel = run.status === 'completed'
            ? `Done (${formatElapsed(run.elapsed_seconds)})`
            : run.status === 'failed'
                ? `Failed (${formatElapsed(run.elapsed_seconds)})`
                : run.status === 'stopped'
                    ? `Stopped (${formatElapsed(run.elapsed_seconds)})`
                    : run.status === 'stale'
                        ? `Stale (${formatElapsed(run.elapsed_seconds)})`
                        : 'Working';
        const connectionIssue = run.run_id === agentRun?.run_id ? agentConnectionIssue : '';
        const accepted = run.accepted_version;
        const bestAttempt = run.best_attempt || run.outcome?.best_attempt;
        const outcome = run.outcome;
        const screenCandidates = run.workflow === 'fundamental_screener' || run.screen_result ? (run.screen_result?.candidates || run.candidates || []) : [];
        const isScreenRun = run.workflow === 'fundamental_screener' || Boolean(run.screen_result);
        const buyHold = run.benchmark?.buy_hold;
        const comparison = run.benchmark?.comparison || (buyHold?.available ? { type: 'buy_hold', label: 'buy and hold', roi: buyHold.roi, available: true } : null);
        const issueEvents = (run.events || [])
            .filter(event => ['generation_retry', 'warning', 'error'].includes(event.type))
            .slice(-3)
            .reverse();
        const issueItems = issueEvents.length
            ? issueEvents
            : (run.last_generation_error ? [{ message: `Round ${run.last_generation_round || '?'} generation issue`, error: run.last_generation_error }] : []);
        const activityEvents = (run.events || []).slice(-6).reverse();
        const latestActivity = activityEvents[0];
        const showActivityLog = Boolean(expandedAgentLogs[run.run_id]);

        return (
            <div style={{ marginTop: '0.75rem', border: '1px solid rgba(148,163,184,0.18)', borderRadius: 8, overflow: 'hidden', background: 'rgba(2,6,23,0.34)' }}>
                <div style={{ padding: '0.75rem 0.85rem', borderBottom: '1px solid rgba(148,163,184,0.14)', display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', fontWeight: 850 }}>
                            {isRunningRun && <RefreshCw className="animate-spin" size={12} style={{ color: 'var(--brand-blue)', flexShrink: 0 }} />}
                            <span>{runLabel}</span>
                        </div>
                        <div style={{ marginTop: '0.18rem', fontSize: '0.7rem', opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.current_step || run.workflow}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.35rem', flexShrink: 0 }}>
                        {isRunningRun && <button className="btn btn-ghost btn-xs" onClick={() => stopAgentRun(run.run_id)}><Square size={12} /> Stop</button>}
                        {canContinueRun && <button className="btn btn-ghost btn-xs" onClick={continueAgentRun} disabled={agentRunLoading}>Continue</button>}
                    </div>
                </div>
                <div style={{ height: 5, background: 'rgba(255,255,255,0.08)' }}>
                    <div style={{ width: `${run.progress || 0}%`, height: '100%', background: run.status === 'failed' ? 'var(--brand-red)' : 'var(--brand-blue)' }} />
                </div>
                <div style={{ padding: '0.75rem 0.85rem' }}>
                    {connectionIssue && (
                        <div style={{
                            marginBottom: '0.75rem',
                            padding: '0.55rem 0.65rem',
                            borderRadius: 6,
                            border: '1px solid rgba(234,179,8,0.28)',
                            background: 'rgba(234,179,8,0.06)',
                            color: 'rgba(254,240,138,0.92)',
                            fontSize: '0.72rem',
                            lineHeight: 1.45,
                        }}>
                            {connectionIssue}
                        </div>
                    )}
                    {latestActivity && (
                        <div style={{
                            marginBottom: '0.75rem',
                            padding: '0.55rem 0.65rem',
                            borderRadius: 6,
                            border: '1px solid rgba(59,130,246,0.18)',
                            background: 'rgba(59,130,246,0.055)',
                            fontSize: '0.72rem',
                            lineHeight: 1.45,
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center' }}>
                                <strong>Latest{agentEventAge(latestActivity) ? ` · ${agentEventAge(latestActivity)}` : ''}</strong>
                                {activityEvents.length > 1 && (
                                    <button
                                        type="button"
                                        onClick={() => setExpandedAgentLogs(prev => ({ ...prev, [run.run_id]: prev[run.run_id] === undefined ? false : !prev[run.run_id] }))}
                                        style={{ border: 0, background: 'transparent', color: 'var(--brand-blue)', cursor: 'pointer', fontSize: '0.68rem', padding: 0 }}
                                    >
                                        {showActivityLog === false ? 'Show log' : 'Hide log'}
                                    </button>
                                )}
                            </div>
                            <div style={{ marginTop: '0.24rem', opacity: 0.78, overflowWrap: 'anywhere' }}>
                                {latestActivity.message}{latestActivity.error ? `: ${String(latestActivity.error).slice(0, 220)}` : ''}
                            </div>
                            <AgentEventDetail event={latestActivity} />
                            {showActivityLog !== false && (
                                <div style={{ marginTop: '0.45rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                    {activityEvents.slice(1).map((event, i) => (
                                        <div key={`${event.ts || event.message}-${i}`} style={{ opacity: 0.55, overflowWrap: 'anywhere' }}>
                                            <div>{event.message}{event.error ? `: ${String(event.error).slice(0, 180)}` : ''}</div>
                                            <AgentEventDetail event={event} muted />
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {planSteps.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                            {planSteps.map((step, i) => (
                                <div key={step.id || `${step.label}-${i}`} style={{ display: 'grid', gridTemplateColumns: '16px 1fr auto', gap: '0.45rem', alignItems: 'start' }}>
                                    <span className={step.status === 'running' ? 'status-dot-running' : ''} style={{ width: 9, height: 9, marginTop: 5, borderRadius: '50%', background: stepColor(step.status), boxShadow: step.status === 'running' ? '0 0 0 4px rgba(59,130,246,0.12)' : 'none' }} />
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontSize: '0.74rem', fontWeight: 750 }}>{step.label}</div>
                                        {step.observation && <div style={{ marginTop: '0.12rem', fontSize: '0.69rem', lineHeight: 1.4, opacity: 0.55 }}>{step.observation}</div>}
                                    </div>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.6rem', opacity: 0.38, textTransform: 'uppercase' }}>
                                        {step.status === 'running' && <RefreshCw className="animate-spin" size={9} />}
                                        {step.status}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                    {run.error && (
                        <div style={{ marginTop: planSteps.length ? '0.75rem' : 0, padding: '0.65rem', borderRadius: 6, border: '1px solid rgba(239,68,68,0.28)', background: 'rgba(239,68,68,0.08)', fontSize: '0.74rem', lineHeight: 1.45 }}>
                            {run.error}
                        </div>
                    )}
                    {issueItems.length > 0 && (
                        <div style={{
                            marginTop: planSteps.length || run.error ? '0.75rem' : 0,
                            padding: '0.65rem',
                            borderRadius: 6,
                            border: '1px solid rgba(234,179,8,0.24)',
                            background: 'rgba(234,179,8,0.06)',
                            fontSize: '0.72rem',
                            lineHeight: 1.45,
                        }}>
                            <strong>Recent issues</strong>
                            {issueItems.map((event, i) => (
                                <div key={`${event.ts || event.message}-${i}`} style={{ marginTop: '0.32rem', opacity: 0.72, overflowWrap: 'anywhere' }}>
                                    {event.message}{event.error ? `: ${String(event.error).slice(0, 260)}` : ''}
                                </div>
                            ))}
                        </div>
                    )}
                    {outcome?.message && (
                        <div style={{
                            marginTop: planSteps.length || run.error || issueItems.length ? '0.75rem' : 0,
                            padding: '0.65rem',
                            borderRadius: 6,
                            border: outcome.status === 'accepted' ? '1px solid rgba(34,197,94,0.28)' : '1px solid rgba(234,179,8,0.28)',
                            background: outcome.status === 'accepted' ? 'rgba(34,197,94,0.08)' : 'rgba(234,179,8,0.08)',
                            fontSize: '0.74rem',
                            lineHeight: 1.45,
                        }}>
                            <strong>{outcome.title || (outcome.status === 'accepted' ? 'Strategy found' : 'No worthwhile strategy found')}</strong>
                            <div style={{ marginTop: '0.25rem', opacity: 0.78 }}>{outcome.message}</div>
                            {bestAttempt && !accepted && !isScreenRun && (
                                <div style={{ marginTop: '0.35rem', opacity: 0.62 }}>
                                    Best attempted ROI {Number(bestAttempt.roi || 0).toFixed(2)}%
                                    {comparison?.available ? ` vs ${comparison.label || 'benchmark'} ${Number(comparison.roi).toFixed(2)}%` : ''}
                                    {(bestAttempt.statistics?.total_trades ?? null) != null ? ` · ${bestAttempt.statistics.total_trades} trades` : ''}
                                </div>
                            )}
                        </div>
                    )}
                    {screenCandidates.length > 0 && (
                        <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                            {screenCandidates.slice(0, 3).map((candidate, i) => {
                                const quote = candidate.quote || {};
                                const metrics = candidate.metrics || candidate.fundamentals || {};
                                const getMetric = (key) => metrics[key] ?? candidate[key];
                                const latestBar = quote.latest_bar || {};
                                const latestBarDate = typeof latestBar === 'string' ? latestBar : latestBar.date;
                                const symbol = candidate.symbol || candidate.ticker || candidate.name || `Candidate ${i + 1}`;
                                const reasons = (candidate.reasons || []).slice(0, 2).join('; ');
                                return (
                                    <div key={`${symbol}-${i}`} style={{ padding: '0.55rem 0.65rem', border: '1px solid rgba(148,163,184,0.14)', borderRadius: 6, background: 'rgba(255,255,255,0.025)' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'baseline' }}>
                                            <strong style={{ fontSize: '0.76rem' }}>{symbol}</strong>
                                            {quote.price != null && <span style={{ fontSize: '0.7rem', opacity: 0.65 }}>${Number(quote.price).toFixed(2)}</span>}
                                        </div>
                                        <div style={{ marginTop: '0.25rem', fontSize: '0.68rem', lineHeight: 1.45, opacity: 0.62 }}>
                                            {getMetric('forward_pe') != null ? `P/E ${Number(getMetric('forward_pe')).toFixed(1)} · ` : ''}
                                            {getMetric('peg_ratio') != null ? `PEG ${Number(getMetric('peg_ratio')).toFixed(2)} · ` : ''}
                                            {getMetric('price_to_sales') != null ? `P/S ${Number(getMetric('price_to_sales')).toFixed(1)} · ` : ''}
                                            {getMetric('revenue_growth') != null ? `Rev ${(Number(getMetric('revenue_growth')) * 100).toFixed(1)}%` : ''}
                                            {quote.relative_volume_30d != null ? ` · Vol ${Number(quote.relative_volume_30d).toFixed(2)}x` : ''}
                                            {latestBarDate ? ` · Bar ${String(latestBarDate).slice(0, 10)}` : ''}
                                        </div>
                                        {reasons && (
                                            <div style={{ marginTop: '0.22rem', fontSize: '0.67rem', lineHeight: 1.42, opacity: 0.55 }}>
                                                Why: {reasons}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {accepted && !isScreenRun && (
                        <div style={{ marginTop: '0.75rem', fontSize: '0.74rem', lineHeight: 1.5, opacity: 0.78 }}>
                            Best: <strong>{accepted.strategy}</strong>
                            {accepted.roi != null ? ` · Strategy ROI ${Number(accepted.roi).toFixed(2)}%` : ''}
                            {comparison?.available ? ` · Benchmark ${comparison.label || 'benchmark'} ${Number(comparison.roi).toFixed(2)}%` : ''}
                            {accepted.benchmark_delta != null ? ` · Delta ${accepted.benchmark_delta >= 0 ? '+' : ''}${Number(accepted.benchmark_delta).toFixed(2)}%` : ''}
                                        </div>
                    )}
                    {comparison?.available && !accepted && !isScreenRun && (
                        <div style={{ marginTop: '0.75rem', fontSize: '0.72rem', opacity: 0.58 }}>
                            Benchmark: {comparison.label || 'benchmark'} {Number(comparison.roi).toFixed(2)}%
                        </div>
                    )}
                    <div style={{ marginTop: '0.65rem', fontSize: '0.62rem', opacity: 0.32 }}>{run.run_id}</div>
                </div>
            </div>
        );
    };

    const AgentWorkspace = () => {
        if (!agentRun) return null;

        const ds = agentRun?.dataset_status;
        const events = agentRun?.events || [];
        const candidates = agentRun?.candidates || [];
        const screenCandidates = agentRun.workflow === 'fundamental_screener' || agentRun.screen_result ? (agentRun.screen_result?.candidates || candidates || []) : [];
        const planSteps = agentRun?.plan_steps || [];
        const buyHold = agentRun?.benchmark?.buy_hold;
        const comparison = agentRun?.benchmark?.comparison || (buyHold?.available ? { type: 'buy_hold', label: 'buy and hold', roi: buyHold.roi, available: true } : null);
        const warningEvents = events
            .filter(event => ['generation_retry', 'warning', 'error'].includes(event.type))
            .slice(-5)
            .reverse();
        const warningItems = warningEvents.length
            ? warningEvents
            : (agentRun.last_generation_error ? [{ message: `Round ${agentRun.last_generation_round || '?'} generation issue`, error: agentRun.last_generation_error }] : []);
        const isRunningRun = agentRun && !isAgentTerminalStatus(agentRun.status);
        const canContinueRun = agentRun && isAgentTerminalStatus(agentRun.status);
        const getEventRound = (event) => {
            if (event.round != null) return Number(event.round);
            const match = String(event.message || '').match(/round\s+(\d+)/i);
            return match ? Number(match[1]) : null;
        };
        const roundEvents = events
            .filter(event => getEventRound(event) != null || ['backtest_optimization', 'backtest_progress', 'backtest_result', 'strategy_saved', 'validation_error', 'validation_check', 'validation_start', 'generation_retry', 'generation_complete', 'generation_plan', 'generation_analysis', 'data_note', 'llm_waiting', 'llm_call', 'llm_generation_progress', 'llm_generation_complete', 'screen_parse', 'screen_progress', 'screen_complete', 'screen_candidate'].includes(event.type))
            .slice(-80);
        const roundGroups = roundEvents.reduce((acc, event) => {
            const round = getEventRound(event) || 'current';
            if (!acc[round]) acc[round] = [];
            acc[round].push(event);
            return acc;
        }, {});
        const roundTimeline = Object.entries(roundGroups)
            .map(([round, items]) => ({ round, items }))
            .sort((a, b) => {
                if (a.round === 'current') return 1;
                if (b.round === 'current') return -1;
                return Number(b.round) - Number(a.round);
            })
            .slice(0, 5);
        const eventTone = (type) => {
            if (['generation_complete', 'strategy_saved', 'complete', 'screen_complete', 'screen_candidate'].includes(type)) return { color: 'var(--brand-green)', label: 'Saved' };
            if (['generation_retry', 'validation_error', 'warning', 'error'].includes(type)) return { color: 'var(--brand-yellow)', label: 'Rejected' };
            if (['backtest_optimization', 'backtest_progress', 'backtest_result'].includes(type)) return { color: 'var(--brand-blue)', label: 'Backtest' };
            if (['data_note', 'generation_analysis'].includes(type)) return { color: 'rgba(125,211,252,0.85)', label: 'Context' };
            if (['llm_waiting'].includes(type)) return { color: 'var(--brand-blue)', label: 'Waiting' };
            if (['screen_parse', 'screen_progress'].includes(type)) return { color: 'var(--brand-blue)', label: 'Screen' };
            if (['generation_plan', 'llm_call', 'llm_generation_progress', 'llm_generation_complete'].includes(type)) return { color: 'var(--brand-blue)', label: 'Generate' };
            if (['validation_start', 'validation_check'].includes(type)) return { color: 'rgba(192,132,252,0.85)', label: 'Check' };
            return { color: 'rgba(255,255,255,0.5)', label: 'Step' };
        };
        const stepColor = (status) => {
            if (status === 'completed') return 'var(--brand-green)';
            if (status === 'running') return 'var(--brand-blue)';
            if (status === 'failed') return 'var(--brand-red)';
            if (status === 'skipped' || status === 'stopped' || status === 'stale') return 'var(--brand-yellow)';
            return 'rgba(255,255,255,0.28)';
        };
        const runLabel = agentRun.status === 'completed'
                ? `Done (${formatElapsed(agentRun.elapsed_seconds)})`
                : agentRun.status === 'failed'
                    ? `Failed (${formatElapsed(agentRun.elapsed_seconds)})`
                    : agentRun.status === 'stopped'
                        ? `Stopped (${formatElapsed(agentRun.elapsed_seconds)})`
                        : agentRun.status === 'stale'
                            ? `Stale (${formatElapsed(agentRun.elapsed_seconds)})`
                            : `Working (${formatElapsed(agentRun.elapsed_seconds)})`;
        return (
            <div style={{ width: 330, flexShrink: 0, borderLeft: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
                        <div>
                            <div style={{ fontSize: '0.8rem', fontWeight: 800, letterSpacing: '0.05em', opacity: 0.7 }}>AGENT WORKSPACE</div>
                            <div style={{ marginTop: '0.2rem', fontSize: '0.8rem', fontWeight: 800, color: isRunningRun ? 'var(--brand-blue)' : 'var(--text-primary)' }}>{runLabel}</div>
                            <div style={{ marginTop: '0.18rem', fontSize: '0.72rem', opacity: 0.5 }}>{agentRun ? agentRun.current_step : 'No active run'}</div>
                        </div>
                        {isRunningRun && (
                            <button className="btn btn-ghost btn-xs" onClick={() => stopAgentRun(agentRun.run_id)}><Square size={12} /> Interrupt</button>
                        )}
                        {canContinueRun && (
                            <button className="btn btn-ghost btn-xs" onClick={continueAgentRun} disabled={agentRunLoading}>Continue</button>
                        )}
                    </div>
                    <div style={{ marginTop: '0.75rem', fontSize: '0.74rem', lineHeight: 1.45, opacity: 0.55 }}>
                        Just chat normally. I will start background runs here when your request needs data freshness checks, generation, backtests, or optimization.
                    </div>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: '0.85rem 1rem' }}>
                    <>
                            <div className="terminal-card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center' }}>
                                    <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem' }}>
                                        {isRunningRun && <RefreshCw className="animate-spin" size={13} style={{ color: 'var(--brand-blue)', flexShrink: 0 }} />}
                                        {runLabel}
                                    </strong>
                                    <span className={`badge ${agentRun.status === 'completed' ? 'badge-green' : agentRun.status === 'failed' ? 'badge-red' : agentRun.status === 'stale' || agentRun.status === 'stopped' ? 'badge-yellow' : 'badge-blue'} ${isRunningRun ? 'status-running-pulse' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.65rem' }}>
                                        {isRunningRun && <RefreshCw className="animate-spin" size={9} />}
                                        {agentRun.status}
                                    </span>
                                </div>
                                <div style={{ marginTop: '0.55rem', height: 6, borderRadius: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.08)' }}>
                                    <div style={{ width: `${agentRun.progress || 0}%`, height: '100%', background: agentRun.status === 'failed' ? 'var(--brand-red)' : (agentRun.status === 'stale' || agentRun.status === 'stopped') ? 'var(--brand-yellow)' : 'var(--brand-blue)' }} />
                                </div>
                                <div style={{ marginTop: '0.45rem', fontSize: '0.72rem', opacity: 0.55 }}>{agentRun.progress || 0}% · {agentRun.current_step}</div>
                                <div style={{ marginTop: '0.2rem', fontSize: '0.66rem', opacity: 0.35 }}>{agentRun.run_id}</div>
                            </div>

                            {agentConnectionIssue && isRunningRun && (
                                <div className="terminal-card" style={{ padding: '0.75rem', marginBottom: '0.75rem', borderColor: 'rgba(234,179,8,0.3)', background: 'rgba(234,179,8,0.045)' }}>
                                    <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--brand-yellow)', marginBottom: '0.4rem' }}>CONNECTION</div>
                                    <div style={{ fontSize: '0.76rem', lineHeight: 1.5, opacity: 0.78 }}>{agentConnectionIssue}</div>
                                </div>
                            )}

                            {(agentRun.status === 'failed' || agentRun.status === 'stale') && (
                                <div className="terminal-card" style={{ padding: '0.75rem', marginBottom: '0.75rem', borderColor: 'rgba(239,68,68,0.35)' }}>
                                    <div style={{ fontSize: '0.72rem', fontWeight: 800, color: agentRun.status === 'stale' ? 'var(--brand-yellow)' : 'var(--brand-red)', marginBottom: '0.4rem' }}>{agentRun.status === 'stale' ? 'WHY IT IS STALE' : 'WHY IT FAILED'}</div>
                                    <div style={{ fontSize: '0.76rem', lineHeight: 1.5, opacity: 0.78, whiteSpace: 'pre-wrap' }}>{agentRun.error || events.slice(-1)[0]?.message || 'No error detail returned.'}</div>
                                </div>
                            )}

                            {warningItems.length > 0 && (
                                <div className="terminal-card" style={{ padding: '0.75rem', marginBottom: '0.75rem', borderColor: 'rgba(234,179,8,0.3)', background: 'rgba(234,179,8,0.045)' }}>
                                    <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--brand-yellow)', marginBottom: '0.5rem' }}>GENERATION WARNINGS</div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                                        {warningItems.map((event, i) => (
                                            <div key={`${event.ts || event.message}-${i}`} style={{ fontSize: '0.72rem', lineHeight: 1.45 }}>
                                                <div style={{ fontWeight: 750 }}>{event.message}</div>
                                                {event.error && (
                                                    <div style={{ marginTop: '0.16rem', opacity: 0.62, overflowWrap: 'anywhere' }}>
                                                        {String(event.error).slice(0, 420)}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {roundTimeline.length > 0 && (
                                <div className="terminal-card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
                                    <div style={{ fontSize: '0.72rem', fontWeight: 800, opacity: 0.55, marginBottom: '0.6rem' }}>ROUND TRACE</div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                                        {roundTimeline.map(group => (
                                            <div key={`round-${group.round}`} style={{ borderLeft: '1px solid rgba(148,163,184,0.18)', paddingLeft: '0.65rem' }}>
                                                <div style={{ fontSize: '0.72rem', fontWeight: 850, marginBottom: '0.35rem' }}>
                                                    {group.round === 'current' ? 'Current round' : `Round ${group.round}`}
                                                </div>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.32rem' }}>
                                                    {group.items.slice(-6).map((event, i) => {
                                                        const tone = eventTone(event.type);
                                                        return (
                                                            <div key={`${event.ts || event.message}-${i}`} style={{ display: 'grid', gridTemplateColumns: '62px 1fr', gap: '0.45rem', alignItems: 'start', fontSize: '0.7rem', lineHeight: 1.4 }}>
                                                                <span style={{ color: tone.color, fontWeight: 800, fontSize: '0.62rem', textTransform: 'uppercase' }}>{tone.label}</span>
                                                                <div style={{ opacity: 0.68, overflowWrap: 'anywhere', minWidth: 0 }}>
                                                                    <div>
                                                                        {event.message}
                                                                        {event.error ? `: ${String(event.error).slice(0, 180)}` : ''}
                                                                    </div>
                                                                    <AgentEventDetail event={event} muted />
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {planSteps.length > 0 && (
                                <div className="terminal-card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
                                    <div style={{ fontSize: '0.72rem', fontWeight: 800, opacity: 0.55, marginBottom: '0.55rem' }}>RUN LOOP</div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                        {planSteps.map((step, i) => (
                                            <div key={step.id || `${step.label}-${i}`} style={{ display: 'grid', gridTemplateColumns: '18px 1fr', gap: '0.45rem' }}>
                                                <div className={step.status === 'running' ? 'status-dot-running' : ''} style={{ width: 10, height: 10, marginTop: 4, borderRadius: '50%', background: stepColor(step.status), boxShadow: step.status === 'running' ? `0 0 0 4px rgba(59,130,246,0.12)` : 'none' }} />
                                                <div style={{ minWidth: 0 }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'baseline' }}>
                                                        <div style={{ fontSize: '0.74rem', fontWeight: 800 }}>{step.label}</div>
                                                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.62rem', opacity: 0.42, textTransform: 'uppercase' }}>
                                                            {step.status === 'running' && <RefreshCw className="animate-spin" size={9} />}
                                                            {step.status}
                                                        </div>
                                                    </div>
                                                    {step.observation && (
                                                        <div style={{ marginTop: '0.15rem', fontSize: '0.7rem', lineHeight: 1.4, opacity: 0.58 }}>{step.observation}</div>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {agentRun.approach && (
                                <div className="terminal-card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.45rem' }}>
                                        <div style={{ fontSize: '0.72rem', fontWeight: 800, opacity: 0.55 }}>APPROACH</div>
                                        <div style={{ fontSize: '0.66rem', opacity: 0.42, textTransform: 'uppercase' }}>{agentRun.approach.detail || thinkingDetail}</div>
                                    </div>
                                    <div style={{ fontSize: '0.76rem', fontWeight: 750, lineHeight: 1.45 }}>{agentRun.approach.summary}</div>
                                    <div style={{ marginTop: '0.45rem', display: 'flex', flexDirection: 'column', gap: '0.28rem' }}>
                                        {(agentRun.approach.steps || []).map((step, i) => (
                                            <div key={`${step}-${i}`} style={{ display: 'grid', gridTemplateColumns: '18px 1fr', gap: '0.35rem', fontSize: '0.72rem', lineHeight: 1.4, opacity: 0.68 }}>
                                                <span style={{ opacity: 0.45 }}>{i + 1}</span>
                                                <span>{step}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {agentRun.workflow !== 'fundamental_screener' && (
                                <div className="terminal-card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
                                    <div style={{ fontSize: '0.72rem', fontWeight: 800, opacity: 0.55, marginBottom: '0.5rem' }}>DATASET FRESHNESS</div>
                                    {ds ? (
                                        <div style={{ fontSize: '0.76rem', lineHeight: 1.55 }}>
                                            <div><strong>{ds.filename}</strong></div>
                                            <div style={{ opacity: 0.65 }}>{ds.start || '-'} to {ds.end || '-'} · {ds.rows || 0} rows</div>
                                            <div style={{ color: ds.fresh ? 'var(--brand-green)' : 'var(--brand-yellow)', fontWeight: 700 }}>{ds.fresh ? 'Fresh for requested window' : 'Missing or stale; agent will sync when required'}</div>
                                        </div>
                                    ) : <div style={{ fontSize: '0.75rem', opacity: 0.5 }}>No dataset checked yet.</div>}
                                </div>
                            )}

                            {comparison?.available && (
                                <div className="terminal-card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
                                    <div style={{ fontSize: '0.72rem', fontWeight: 800, opacity: 0.55, marginBottom: '0.45rem' }}>COMPARISON BENCHMARK</div>
                                    <div style={{ fontSize: '0.76rem', fontWeight: 750, marginBottom: '0.25rem' }}>{comparison.label || 'benchmark'}</div>
                                    <div style={{ color: comparison.roi >= 0 ? 'var(--brand-green)' : 'var(--brand-red)', fontWeight: 800 }}>{Number(comparison.roi).toFixed(2)}%</div>
                                    {comparison.start && comparison.end && <div style={{ fontSize: '0.72rem', opacity: 0.55 }}>{comparison.start} to {comparison.end}</div>}
                                    {comparison.type === 'strategy' && comparison.trade_count != null && <div style={{ fontSize: '0.72rem', opacity: 0.55 }}>{comparison.trade_count} baseline trades</div>}
                                </div>
                            )}

                            {screenCandidates.length > 0 && (
                                <div className="terminal-card" style={{ padding: 0, marginBottom: '0.75rem', overflow: 'hidden' }}>
                                    <div style={{ padding: '0.55rem 0.75rem', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.72rem', fontWeight: 800, opacity: 0.55 }}>FUNDAMENTAL CANDIDATES</div>
                                    {screenCandidates.slice(0, 8).map((c, i) => {
                                        const quote = c.quote || {};
                                        const metrics = c.metrics || c.fundamentals || {};
                                        const getMetric = (key) => metrics[key] ?? c[key];
                                        const latestBar = quote.latest_bar || {};
                                        const latestBarDate = typeof latestBar === 'string' ? latestBar : latestBar.date;
                                        const symbol = c.symbol || c.ticker || c.name || `Candidate ${i + 1}`;
                                        const reasons = (c.reasons || []).slice(0, 3).join('; ');
                                        return (
                                            <div key={`${symbol}-${i}`} style={{ padding: '0.6rem 0.75rem', borderBottom: i < Math.min(screenCandidates.length, 8) - 1 ? '1px solid rgba(255,255,255,0.05)' : 0 }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'baseline' }}>
                                                    <strong style={{ fontSize: '0.76rem' }}>{symbol}</strong>
                                                    {quote.price != null && <span style={{ fontSize: '0.7rem', opacity: 0.62 }}>${Number(quote.price).toFixed(2)}</span>}
                                                </div>
                                                <div style={{ marginTop: '0.25rem', fontSize: '0.72rem', opacity: 0.68, lineHeight: 1.45 }}>
                                                    {getMetric('forward_pe') != null ? `Forward P/E ${Number(getMetric('forward_pe')).toFixed(1)} · ` : ''}
                                                    {getMetric('peg_ratio') != null ? `PEG ${Number(getMetric('peg_ratio')).toFixed(2)} · ` : ''}
                                                    {getMetric('price_to_sales') != null ? `P/S ${Number(getMetric('price_to_sales')).toFixed(1)} · ` : ''}
                                                    {getMetric('revenue_growth') != null ? `Rev ${(Number(getMetric('revenue_growth')) * 100).toFixed(1)}%` : ''}
                                                </div>
                                                <div style={{ marginTop: '0.18rem', fontSize: '0.68rem', opacity: 0.48 }}>
                                                    {quote.relative_volume_30d != null ? `Rel volume ${Number(quote.relative_volume_30d).toFixed(2)}x` : 'Rel volume n/a'}
                                                    {quote.return_5d != null ? ` · 5D ${(Number(quote.return_5d) * 100).toFixed(1)}%` : ''}
                                                    {latestBarDate ? ` · Latest bar ${String(latestBarDate).slice(0, 10)}` : ''}
                                                </div>
                                                {reasons && <div style={{ marginTop: '0.22rem', fontSize: '0.68rem', opacity: 0.58, lineHeight: 1.42 }}>Why: {reasons}</div>}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {agentRun.workflow !== 'fundamental_screener' && candidates.length > 0 && (
                                <div className="terminal-card" style={{ padding: 0, marginBottom: '0.75rem', overflow: 'hidden' }}>
                                    <div style={{ padding: '0.55rem 0.75rem', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.72rem', fontWeight: 800, opacity: 0.55 }}>CANDIDATES</div>
                                    {candidates.map((c, i) => (
                                        <div key={`${c.strategy}-${i}`} style={{ padding: '0.6rem 0.75rem', borderBottom: i < candidates.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 0 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                                                <strong style={{ fontSize: '0.76rem' }}>{c.strategy}</strong>
                                                {c.accepted && <span className="badge badge-green" style={{ fontSize: '0.62rem' }}>Accepted</span>}
                                                {!c.accepted && c.rejected && <span className="badge badge-yellow" style={{ fontSize: '0.62rem' }}>Rejected</span>}
                                            </div>
                                            {c.roi != null && <div style={{ marginTop: '0.25rem', fontSize: '0.74rem', opacity: 0.7 }}>Strategy ROI {c.roi.toFixed(2)}%{comparison?.available ? ` · Benchmark ${Number(comparison.roi).toFixed(2)}%` : ''}{c.benchmark_delta != null ? ` · Delta ${c.benchmark_delta >= 0 ? '+' : ''}${c.benchmark_delta.toFixed(2)}%` : ''}{c.trade_count != null ? ` · ${c.trade_count} trades` : ''}</div>}
                                            {c.rejection_reason && <div style={{ marginTop: '0.2rem', fontSize: '0.68rem', color: 'var(--brand-yellow)', opacity: 0.78 }}>{c.rejection_reason}</div>}
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="terminal-card" style={{ padding: '0.75rem' }}>
                                <div style={{ fontSize: '0.72rem', fontWeight: 800, opacity: 0.55, marginBottom: '0.5rem' }}>EVENTS</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                                    {events.slice(-8).reverse().map((event, i) => (
                                        <div key={`${event.ts}-${i}`} style={{ fontSize: '0.72rem', lineHeight: 1.45 }}>
                                            <div style={{ fontWeight: 700 }}>{event.message}</div>
                                            <div style={{ opacity: 0.42 }}>{event.type}</div>
                                        </div>
                                    ))}
                                    {events.length === 0 && <div style={{ fontSize: '0.75rem', opacity: 0.5 }}>No events yet.</div>}
                                </div>
                            </div>
                    </>
                </div>
            </div>
        );
    };

    // ── render ────────────────────────────────────────────────────────────────
    return (
        <div style={{ height: '100vh', display: 'flex', overflow: 'hidden' }}>

            {/* ── SIDEBAR ── */}
            <div style={{
                width: '240px', flexShrink: 0,
                borderRight: '1px solid var(--border-subtle)',
                display: 'flex', flexDirection: 'column',
                background: 'rgba(0,0,0,0.15)',
            }}>
                {/* sidebar header */}
                <div style={{ padding: '1rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.85rem', opacity: 0.7, letterSpacing: '0.05em' }}>CHATS</span>
                    <button className="btn btn-ghost btn-xs" onClick={createThread} title="New chat" style={{ padding: '0.3rem' }}>
                        <Plus size={15} />
                    </button>
                </div>

                {/* thread list */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}>
                    {threadState.threads.map(t => (
                        <div
                            key={t.id}
                            onClick={() => switchThread(t.id)}
                            style={{
                                padding: '0.6rem 0.75rem',
                                borderRadius: '8px',
                                marginBottom: '2px',
                                cursor: 'pointer',
                                background: t.id === threadState.activeId ? 'rgba(59,130,246,0.15)' : 'transparent',
                                border: `1px solid ${t.id === threadState.activeId ? 'rgba(59,130,246,0.3)' : 'transparent'}`,
                                transition: 'all 0.15s',
                            }}
                        >
                            {editingId === t.id ? (
                                <input
                                    autoFocus
                                    className="input"
                                    style={{ padding: '0.2rem 0.4rem', fontSize: '0.8rem', height: '28px' }}
                                    value={editTitle}
                                    onChange={e => setEditTitle(e.target.value)}
                                    onBlur={() => commitRename(t.id)}
                                    onKeyDown={e => { if (e.key === 'Enter') commitRename(t.id); if (e.key === 'Escape') setEditingId(null); }}
                                    onClick={e => e.stopPropagation()}
                                />
                            ) : (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                    <MessageSquare size={13} style={{ flexShrink: 0, opacity: 0.5 }} />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: '0.82rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                                        <div style={{ fontSize: '0.68rem', opacity: 0.4, marginTop: '1px' }}>{formatDate(t.createdAt)} · {t.messages.length - 1} msgs</div>
                                    </div>
                                    {t.id === threadState.activeId && (
                                        <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                                            <button className="btn btn-ghost btn-xs" onClick={e => startRename(t, e)} style={{ padding: '2px', opacity: 0.5 }}><Edit2 size={11} /></button>
                                            <button className="btn btn-ghost btn-xs" onClick={e => deleteThread(t.id, e)} style={{ padding: '2px', opacity: 0.5, color: 'var(--brand-red)' }}><Trash2 size={11} /></button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {/* compact preferences */}
                <div style={{ padding: '0.75rem', borderTop: '1px solid var(--border-subtle)' }}>
                    <div style={{ marginTop: '0.75rem' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, opacity: 0.6, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Answer Budget</label>
                        <div style={{ display: 'flex', gap: '0.3rem' }}>
                            {['short', 'mid', 'long'].map(len => (
                                <button
                                    key={len}
                                    onClick={() => {
                                        setResponseLength(len);
                                        localStorage.setItem('response_length', len);
                                    }}
                                    style={{
                                        flex: 1,
                                        padding: '0.4rem 0.5rem',
                                        fontSize: '0.75rem',
                                        fontWeight: 600,
                                        borderRadius: '6px',
                                        border: `1px solid ${responseLength === len ? 'var(--brand-blue)' : 'rgba(255,255,255,0.1)'}`,
                                        background: responseLength === len ? 'rgba(59,130,246,0.2)' : 'transparent',
                                        color: responseLength === len ? 'var(--brand-blue)' : 'rgba(255,255,255,0.6)',
                                        cursor: 'pointer',
                                        transition: 'all 0.15s',
                                        textTransform: 'capitalize'
                                    }}
                                >
                                    {len}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div style={{ marginTop: '0.75rem' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, opacity: 0.6, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Run Detail</label>
                        <div style={{ display: 'flex', gap: '0.3rem' }}>
                            {['brief', 'normal', 'detailed'].map(level => (
                                <button
                                    key={level}
                                    onClick={() => {
                                        setThinkingDetail(level);
                                        localStorage.setItem('thinking_detail', level);
                                    }}
                                    style={{
                                        flex: 1,
                                        padding: '0.4rem 0.5rem',
                                        fontSize: '0.75rem',
                                        fontWeight: 600,
                                        borderRadius: '6px',
                                        border: `1px solid ${thinkingDetail === level ? 'var(--brand-purple)' : 'rgba(255,255,255,0.1)'}`,
                                        background: thinkingDetail === level ? 'rgba(139,92,246,0.2)' : 'transparent',
                                        color: thinkingDetail === level ? 'var(--brand-purple)' : 'rgba(255,255,255,0.6)',
                                        cursor: 'pointer',
                                        transition: 'all 0.15s',
                                        textTransform: 'capitalize'
                                    }}
                                >
                                    {level}
                                </button>
                            ))}
                        </div>

                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', fontWeight: 700, opacity: 0.6, marginTop: '1rem', textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={showLiveThinking}
                                onChange={(e) => {
                                    setShowLiveThinking(e.target.checked);
                                    localStorage.setItem('show_live_thinking', e.target.checked);
                                }}
                                style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                            />
                            <span>Show Thinking</span>
                        </label>

                        <div style={{ marginTop: '1rem' }}>
                            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', fontSize: '0.75rem', fontWeight: 700, opacity: 0.6, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                <span>Agent Instructions</span>
                                {agentInstructions.trim() && (
                                    <button
                                        className="btn btn-ghost btn-xs"
                                        onClick={() => {
                                            setAgentInstructions('');
                                            localStorage.removeItem('agent_instructions');
                                        }}
                                        title="Clear agent instructions"
                                    >
                                        Reset
                                    </button>
                                )}
                            </label>
                            <textarea
                                className="input"
                                value={agentInstructions}
                                onChange={(e) => {
                                    const value = e.target.value.slice(0, 1600);
                                    setAgentInstructions(value);
                                    localStorage.setItem('agent_instructions', value);
                                }}
                                placeholder="Example: prefer faster rounds, reject zero-trade strategies, show public progress notes, stop after 10 weak rounds."
                                rows={4}
                                style={{
                                    width: '100%',
                                    minHeight: '92px',
                                    resize: 'vertical',
                                    fontSize: '0.75rem',
                                    lineHeight: 1.45,
                                }}
                            />
                            <div style={{ marginTop: '0.3rem', fontSize: '0.66rem', opacity: 0.42 }}>
                                Sent with chat, intent routing, and strategy-agent runs.
                            </div>
                        </div>

                        <div style={{ marginTop: '1rem', paddingTop: '0.9rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', fontWeight: 700, opacity: 0.65, marginBottom: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={useAgentBattleParams}
                                    onChange={(e) => {
                                        setUseAgentBattleParams(e.target.checked);
                                        localStorage.setItem('agent_use_battle_params', String(e.target.checked));
                                    }}
                                    style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                                />
                                <span>Use Battle Parameters</span>
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.72rem', opacity: 0.68, marginBottom: useAgentBattleParams ? '0.65rem' : 0, cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={agentAskBattleParams}
                                    onChange={(e) => {
                                        setAgentAskBattleParams(e.target.checked);
                                        localStorage.setItem('agent_ask_battle_params', String(e.target.checked));
                                    }}
                                />
                                <span>Ask before strategy backtests</span>
                            </label>
                            {useAgentBattleParams && (
                                <div style={{ display: 'grid', gap: '0.55rem' }}>
                                    <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.68rem', opacity: 0.66 }}>
                                        <span>Stake Optimization Range (%)</span>
                                        <input
                                            className="input"
                                            value={agentStakeRange}
                                            onChange={(e) => {
                                                setAgentStakeRange(e.target.value);
                                                localStorage.setItem('agent_stake_range', e.target.value);
                                            }}
                                            style={{ height: '34px', fontSize: '0.74rem' }}
                                        />
                                    </label>
                                    <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.68rem', opacity: 0.66 }}>
                                        <span>T-Stop Matrix (%)</span>
                                        <input
                                            className="input"
                                            value={agentTrailRange}
                                            onChange={(e) => {
                                                setAgentTrailRange(e.target.value);
                                                localStorage.setItem('agent_trail_range', e.target.value);
                                            }}
                                            style={{ height: '34px', fontSize: '0.74rem' }}
                                        />
                                    </label>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
                                        <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.68rem', opacity: 0.66 }}>
                                            <span>Start Date</span>
                                            <input
                                                type="date"
                                                className="input"
                                                value={agentStartDate}
                                                onChange={(e) => {
                                                    setAgentStartDate(e.target.value);
                                                    localStorage.setItem('agent_start_date', e.target.value);
                                                }}
                                                style={{ height: '34px', fontSize: '0.72rem' }}
                                            />
                                        </label>
                                        <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.68rem', opacity: 0.66 }}>
                                            <span>End Date</span>
                                            <input
                                                type="date"
                                                className="input"
                                                value={agentEndDate}
                                                onChange={(e) => {
                                                    setAgentEndDate(e.target.value);
                                                    localStorage.setItem('agent_end_date', e.target.value);
                                                }}
                                                style={{ height: '34px', fontSize: '0.72rem' }}
                                            />
                                        </label>
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
                                        <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.68rem', opacity: 0.66 }}>
                                            <span>Initial Capital ($)</span>
                                            <input
                                                type="number"
                                                className="input"
                                                value={agentInitialCash}
                                                min="1"
                                                step="1000"
                                                onChange={(e) => {
                                                    setAgentInitialCash(e.target.value);
                                                    localStorage.setItem('agent_initial_cash', e.target.value);
                                                }}
                                                style={{ height: '34px', fontSize: '0.72rem' }}
                                            />
                                        </label>
                                        <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.68rem', opacity: 0.66 }}>
                                            <span>Commission</span>
                                            <input
                                                type="number"
                                                className="input"
                                                value={agentCommission}
                                                min="0"
                                                max="1"
                                                step="0.0001"
                                                onChange={(e) => {
                                                    setAgentCommission(e.target.value);
                                                    localStorage.setItem('agent_commission', e.target.value);
                                                }}
                                                style={{ height: '34px', fontSize: '0.72rem' }}
                                            />
                                        </label>
                                    </div>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.72rem', opacity: 0.68, cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={agentSequential}
                                            onChange={(e) => {
                                                setAgentSequential(e.target.checked);
                                                localStorage.setItem('agent_sequential', String(e.target.checked));
                                            }}
                                        />
                                        <span>Sequential Execution (Low Resource Mode)</span>
                                    </label>
                                    <div style={{ fontSize: '0.66rem', opacity: 0.42 }}>
                                        Off uses agent defaults; on sends these values to strategy backtests.
                                    </div>
                                </div>
                            )}
                        </div>

                        <div style={{ marginTop: '1rem' }}>
                            <label style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', fontSize: '0.75rem', fontWeight: 700, opacity: 0.6, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                <span>History Reuse</span>
                                <span>{historyLimit === 0 ? 'Off' : `${historyLimit} msgs`}</span>
                            </label>
                            <input
                                type="range"
                                min="0"
                                max="80"
                                step="4"
                                value={historyLimit}
                                onChange={(e) => {
                                    const value = Number(e.target.value);
                                    setHistoryLimit(value);
                                    localStorage.setItem('chat_history_limit', String(value));
                                }}
                                style={{ width: '100%', cursor: 'pointer' }}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* ── MAIN CHAT AREA ── */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

                {/* header */}
                <div style={{ padding: '0.85rem 1.5rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexShrink: 0 }}>
                    <div style={{ minWidth: 0 }}>
                        <h2 style={{ margin: 0, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <MessageSquare size={18} /> {activeThread?.title}
                        </h2>
                        <p style={{ margin: 0, fontSize: '0.72rem', opacity: 0.5 }}>
                            ReAct assistant · {historyLimit === 0 ? 'no history reused' : `reusing up to ${historyLimit} history messages`} · {effectiveHistoryCount ? `${Math.floor(effectiveHistoryCount / 2)} exchanges in context` : 'no context yet'} · est. tokens in {formatTokenCount(chatTokenUsage.input)} / out {formatTokenCount(chatTokenUsage.output)} / total {formatTokenCount(chatTokenUsage.total)}
                            {retryableFailedPrompt && !isAssistantBusy && (
                                <button
                                    className="btn btn-ghost btn-xs"
                                    onClick={() => handleSend(retryableFailedPrompt)}
                                    title="Retry the last failed assistant request"
                                    style={{ marginLeft: '0.5rem', color: 'var(--brand-yellow)' }}
                                >
                                    <RefreshCw size={12} /> Retry
                                </button>
                            )}
                        </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
                        <button
                            type="button"
                            onClick={() => setApiPanelOpen(true)}
                            style={{ padding: '0.4rem 0.65rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)', color: 'inherit', minWidth: '190px', textAlign: 'left', cursor: 'pointer' }}
                            title="Manage assistant API"
                        >
                            <div style={{ fontSize: '0.66rem', opacity: 0.45, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.12rem' }}>Assistant API</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.76rem', fontWeight: 700 }}>
                                <span style={{ width: 7, height: 7, borderRadius: '50%', background: hasConfiguredApiKey(aiConfig.provider) ? 'var(--brand-green)' : 'var(--brand-red)', flexShrink: 0 }} />
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {normalizeProvider(aiConfig.provider || localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER)} · {(aiConfig.model || localStorage.getItem('settings_default_model') || DEFAULT_MODEL)}
                                </span>
                            </div>
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShareModalOpen(true)}>
                            <Share size={14} /> Share
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => {
                            updateThread(activeThread.id, t => ({ ...t, messages: [WELCOME_MSG(t.id)], history: [] }));
                        }}>
                            <Trash2 size={14} /> Clear
                        </button>
                    </div>
                </div>

                {/* messages */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.5rem' }}>
                    <AnimatePresence>
                        {activeThread?.messages.map(message => {
                            const assistantMessage = isAssistantMessage(message);
                            const userMessage = isUserMessage(message);
                            return (
                            <motion.div key={message.id}
                                initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                                style={{
                                    display: 'flex',
                                    flexDirection: userMessage ? 'row-reverse' : 'row',
                                    gap: '0.75rem',
                                    marginBottom: '1.25rem',
                                    alignItems: 'flex-start'
                                }}
                            >
                                <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: assistantMessage ? 'var(--brand-blue)' : 'var(--brand-green)' }}>
                                    {assistantMessage ? <Bot size={18} color="white" /> : <User size={18} color="white" />}
                                </div>
                                <div style={{ flex: userMessage ? '0 1 auto' : 1, minWidth: 0, maxWidth: userMessage ? '72%' : 'min(860px, 100%)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: userMessage ? 'flex-end' : 'flex-start', gap: '0.5rem', marginBottom: '0.35rem' }}>
                                        <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>{assistantMessage ? 'AI Assistant' : 'You'}</span>
                                        <span style={{ fontSize: '0.68rem', opacity: 0.4 }}>{formatTs(message.timestamp)}</span>
                                        {message.id === currentStreamingId && (
                                            <RefreshCw className="animate-spin" size={11} style={{ opacity: 0.5 }} />
                                        )}
                                        {assistantMessage && message.content && message.id !== currentStreamingId && (
                                            <button className="btn btn-ghost btn-xs" onClick={() => copyToClipboard(message.content, message.id)} style={{ opacity: 0.4, padding: '0.2rem' }}>
                                                {copiedId === message.id ? <Check size={11} /> : <Copy size={11} />}
                                            </button>
                                        )}
                                        {assistantMessage && message.id !== currentStreamingId && (
                                        <button className="btn btn-ghost btn-xs" onClick={() => openReplyThread(message.id)} style={{ opacity: 0.4, padding: '0.2rem', marginLeft: 'auto' }}>
                                            <MessageSquare size={11} />
                                        </button>
                                        )}
                                    </div>
                                    {message.replyTo && (
                                        <div style={{ fontSize: '0.75rem', opacity: 0.5, marginBottom: '0.35rem', fontStyle: 'italic', paddingLeft: '0.5rem', borderLeft: '2px solid rgba(255,255,255,0.2)' }}>
                                            ↳ Reply to message
                                        </div>
                                    )}
                                    {showLiveThinking && assistantMessage && (message.reasoning || message.steps?.filter(s => s.status !== 'info').length > 0 || message.commentary?.length > 0 || message.id === currentStreamingId) && renderReactTrace(message)}

                                    {/* message bubble — now always at the bottom */}
                                    <div style={{
                                        background: assistantMessage ? 'rgba(15,23,42,0.72)' : 'rgba(34,197,94,0.13)',
                                        padding: '0.78rem 0.95rem',
                                        borderRadius: assistantMessage ? '8px' : '8px 8px 2px 8px',
                                        border: `1px solid ${assistantMessage ? 'rgba(148,163,184,0.16)' : 'rgba(34,197,94,0.24)'}`,
                                        lineHeight: 1.55,
                                        fontSize: '0.9rem',
                                        boxShadow: assistantMessage ? '0 8px 24px rgba(0,0,0,0.12)' : 'none'
                                    }}>
                                        {message.id === currentStreamingId && (
                                            <div style={{ marginBottom: message.content ? '0.75rem' : '0' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                                                    <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} style={{ width: 10, height: 10, border: '2px solid rgba(59,130,246,0.3)', borderTopColor: 'var(--brand-blue)', borderRadius: '50%', flexShrink: 0 }} />
                                                    <motion.span animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 1.8 }} style={{ fontSize: '0.78rem', color: 'var(--brand-blue)', flex: 1 }}>
                                                        {agentProgress?.label || 'Agent working…'}
                                                    </motion.span>
                                                    <button onClick={stopStreaming} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '5px', cursor: 'pointer', padding: '0.2rem 0.55rem', color: 'rgb(239,68,68)', fontSize: '0.75rem', fontWeight: 600 }}>
                                                        <Square size={9} fill="currentColor" /> Stop
                                                    </button>
                                                </div>
                                                <div style={{ height: '2px', background: 'rgba(59,130,246,0.12)', borderRadius: '2px', overflow: 'hidden', marginBottom: message.content ? '0' : '0.5rem' }}>
                                                    <motion.div animate={{ x: ['-100%', '100%'] }} transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }} style={{ height: '100%', width: '45%', background: 'linear-gradient(90deg, transparent, var(--brand-blue), transparent)' }} />
                                                </div>
                                                {confirmRequest && (
                                                    <div style={{ background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.35)', borderRadius: '8px', padding: '0.75rem', marginTop: '0.5rem' }}>
                                                        <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>{confirmRequest.question}</div>
                                                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                            {confirmRequest.options.map((opt, i) => (
                                                                <button key={i} className={i === 0 ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'} onClick={() => sendConfirmAnswer(opt)}>{opt}</button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {!message.content && assistantMessage && (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', color: 'rgba(255,255,255,0.62)', minHeight: '24px' }}>
                                                <div style={{ display: 'flex', gap: '0.22rem', alignItems: 'center' }}>
                                                    {[0, 1, 2].map(i => (
                                                        <motion.span
                                                            key={i}
                                                            animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
                                                            transition={{ repeat: Infinity, duration: 1.1, delay: i * 0.16 }}
                                                            style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--brand-blue)', display: 'block' }}
                                                        />
                                                    ))}
                                                </div>
                                                <span style={{ fontSize: '0.86rem' }}>
                                                    {message.id === currentStreamingId ? (agentProgress?.label || 'Thinking...') : 'Waiting for response...'}
                                                </span>
                                                {isAssistantBusy && (
                                                    <button onClick={stopStreaming} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '5px', cursor: 'pointer', padding: '0.2rem 0.55rem', color: 'rgb(239,68,68)', fontSize: '0.75rem', fontWeight: 600, marginLeft: 'auto' }}>
                                                        <Square size={9} fill="currentColor" /> Stop
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                        {message.content && (
                                            <div style={{ fontSize: '0.95rem', lineHeight: 1.6, whiteSpace: assistantMessage ? 'normal' : 'pre-wrap' }}>
                                                {assistantMessage ? renderMarkdown(message.content) : message.content}
                                                {message.agentRun && <AgentRunCard run={message.agentRun} />}
                                                {message.usage && (
                                                    <div style={{ marginTop: '0.65rem', paddingTop: '0.45rem', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: '0.68rem', opacity: 0.45, display: 'flex', gap: '1rem' }}>
                                                        <span>In: {message.usage.prompt_tokens?.toLocaleString() || '?'}</span>
                                                        <span>Out: {message.usage.completion_tokens?.toLocaleString() || '?'}</span>
                                                        <span>Total: {message.usage.total_tokens?.toLocaleString() || '?'}</span>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* progress bar for async tasks */}
                                    {message.progress && (
                                        <motion.div
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            style={{ marginTop: '0.75rem' }}
                                        >
                                            <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)', marginBottom: '0.3rem' }}>
                                                {message.progress.label}
                                                {message.progress.pct > 0 && <span style={{ marginLeft: '0.5rem', fontWeight: 600, color: 'rgb(59,130,246)' }}>{message.progress.pct}%</span>}
                                            </div>
                                            <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                                                <motion.div
                                                    animate={{ width: `${Math.min(message.progress.pct || 0, 100)}%` }}
                                                    transition={{ duration: 0.3 }}
                                                    style={{ height: '100%', background: 'linear-gradient(90deg, rgb(59,130,246), rgb(34,197,94))', borderRadius: '3px' }}
                                                />
                                            </div>
                                            {message.progress.detail && (
                                                <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', marginTop: '0.3rem', fontStyle: 'italic' }}>
                                                    {message.progress.detail}
                                                </div>
                                            )}
                                            {message.progress.marketAnalysis && (
                                                <div style={{
                                                    marginTop: '0.6rem',
                                                    padding: '0.65rem 0.75rem',
                                                    borderRadius: '8px',
                                                    background: 'rgba(245,158,11,0.08)',
                                                    border: '1px solid rgba(245,158,11,0.18)',
                                                    fontSize: '0.74rem',
                                                    lineHeight: 1.5,
                                                    color: 'rgba(255,255,255,0.72)',
                                                    whiteSpace: 'pre-wrap'
                                                }}>
                                                    {message.progress.marketAnalysis}
                                                </div>
                                            )}
                                            {message.progress.streamText && (
                                                <div style={{
                                                    marginTop: '0.6rem',
                                                    borderRadius: '8px',
                                                    background: 'rgba(0,0,0,0.22)',
                                                    border: '1px solid rgba(59,130,246,0.18)',
                                                    overflow: 'hidden'
                                                }}>
                                                    <div style={{
                                                        padding: '0.35rem 0.65rem',
                                                        fontSize: '0.62rem',
                                                        fontWeight: 700,
                                                        textTransform: 'uppercase',
                                                        letterSpacing: '0.08em',
                                                        opacity: 0.55,
                                                        borderBottom: '1px solid rgba(255,255,255,0.05)'
                                                    }}>
                                                        Live Generation Feed
                                                    </div>
                                                    <div style={{
                                                        padding: '0.7rem',
                                                        maxHeight: '180px',
                                                        overflowY: 'auto',
                                                        whiteSpace: 'pre-wrap',
                                                        wordBreak: 'break-word',
                                                        fontFamily: 'monospace',
                                                        fontSize: '0.72rem',
                                                        lineHeight: 1.5,
                                                        color: 'rgba(255,255,255,0.78)'
                                                    }}>
                                                        {message.progress.streamText}
                                                    </div>
                                                </div>
                                            )}
                                        </motion.div>
                                    )}

                                    {/* stop button for running tasks */}
                                    {message.taskId && isLoading && (
                                        <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
                                            <button
                                                onClick={async () => {
                                                    try {
                                                        const response = await fetch(`${BACKTEST_SERVICE}/ai/chat-strands/${message.taskId}/stop`, {
                                                            method: 'DELETE'
                                                        });
                                                        if (response.ok) {
                                                            console.log('✅ Stop signal sent');
                                                        }
                                                    } catch (e) {
                                                        console.error('Failed to stop task:', e);
                                                    }
                                                }}
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '0.4rem',
                                                    background: 'rgba(239,68,68,0.15)',
                                                    border: '1px solid rgba(239,68,68,0.3)',
                                                    borderRadius: '6px',
                                                    cursor: 'pointer',
                                                    padding: '0.4rem 0.8rem',
                                                    color: 'rgb(239,68,68)',
                                                    fontSize: '0.8rem',
                                                    fontWeight: 500
                                                }}
                                                title="Stop this task"
                                            >
                                                <Square size={13} />
                                                Stop Task
                                            </button>
                                        </div>
                                    )}

                                    {/* reply thread */}
                                    {message.replies?.length > 0 && <ReplyThread replies={message.replies} parentId={message.id} />}

                                    {/* market data cards */}
                                    {message.marketData && MarketDataCards({ marketData: message.marketData })}

                                    {/* backtest results card */}
                                    {message.backtestResults && <BacktestResultsCard results={message.backtestResults} />}

                                    {/* manual action buttons */}
                                    {message.actions?.filter(a => a.type !== 'api_call').length > 0 && (
                                        <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                            {message.actions.filter(a => a.type !== 'api_call').map((action, idx) => (
                                                <button key={idx} className="btn btn-primary btn-sm" onClick={() => executeAction(action)} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                    {action.type === 'create_strategy' && <Wand2 size={13} />}
                                                    {action.type === 'backtest' && <Play size={13} />}
                                                    {action.type === 'download_data' && <Database size={13} />}
                                                    {action.type === 'optimize' && <RefreshCw size={13} />}
                                                    {action.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </motion.div>
                            );
                        })}
                    </AnimatePresence>

                    <div ref={messagesEndRef} />
                </div>

                {/* reply thread panel */}
                <AnimatePresence>
                {replyThreadId && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        style={{ padding: '0.75rem 1.5rem', borderTop: '1px solid var(--border-subtle)', background: 'rgba(59,130,246,0.05)' }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                            <MessageSquare size={14} style={{ color: 'var(--brand-blue)' }} />
                            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--brand-blue)' }}>Reply Thread</span>
                            <button className="btn btn-ghost btn-xs" onClick={closeReplyThread} style={{ marginLeft: 'auto', padding: '0.2rem' }}>
                                <X size={13} />
                            </button>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                            <textarea className="input" style={{ flex: 1, minHeight: '40px', maxHeight: '100px', resize: 'vertical', fontSize: '0.9rem' }}
                                placeholder="Write your reply..."
                                value={replyInput}
                                onChange={e => setReplyInput(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
                            />
                            <button className="btn btn-primary btn-sm" onClick={sendReply}
                                disabled={!replyInput.trim()}
                                style={{ height: '40px', minWidth: '70px' }}>
                                <Send size={14} /> Reply
                            </button>
                        </div>
                    </motion.div>
                )}
                </AnimatePresence>

                {/* input bar */}
                <div style={{ padding: '0.85rem 1.5rem', borderTop: '1px solid var(--border-subtle)', flexShrink: 0 }}>
                    <div style={{ minHeight: '1.1rem', marginBottom: '0.5rem', fontSize: '0.78rem', color: 'var(--text-secondary)', opacity: queuedInput ? 1 : 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                        {queuedInput ? `Queued: "${queuedInput.slice(0, 80)}${queuedInput.length > 80 ? '...' : ''}"` : 'No queued message'}
                    </div>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
                        <textarea className="input chat-main-input" style={{ flex: 1, minHeight: '46px', maxHeight: '120px', resize: 'vertical' }}
                            placeholder={mainInputPlaceholder}
                            value={input}
                            onChange={e => {
                                setInput(e.target.value);
                                setInputHistoryIndex(null);
                                setInputHistoryDraft('');
                            }}
                            onKeyDown={handleMainInputKeyDown}
                        />
                        <button className="btn btn-primary" onClick={handleSend}
                            disabled={!input.trim()}
                            style={{ height: '46px', minWidth: '80px' }}>
                            {isAssistantBusy ? <><Send size={17} /> Queue</> : <><Send size={17} /> Send</>}
                        </button>
                    </div>
                </div>
            </div>

            {/* Assistant API Panel */}
            {apiPanelOpen && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div style={{ backgroundColor: 'var(--bg-card)', color: 'var(--text-main)', border: '1px solid var(--border-subtle)', padding: '1.4rem', borderRadius: '12px', width: 'min(500px, 92vw)', boxShadow: '0 18px 60px rgba(0,0,0,0.5)', opacity: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem' }}>
                            <div>
                                <h3 style={{ margin: 0, fontSize: '1rem' }}>Assistant API</h3>
                                <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>The provider and model used for assistant replies and tool selection.</p>
                            </div>
                            <button className="btn btn-ghost btn-sm" onClick={() => setApiPanelOpen(false)}><X size={14} /></button>
                        </div>
                        <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>Provider</label>
                        <select
                            className="input"
                            value={apiDraft.provider}
                            onChange={(e) => {
                                const provider = e.target.value;
                                setApiDraft(prev => ({
                                    ...prev,
                                    provider,
                                    apiKey: localStorage.getItem(API_KEY_STORAGE[provider] || API_KEY_STORAGE[DEFAULT_PROVIDER]) || '',
                                }));
                            }}
                            style={{ width: '100%', marginBottom: '0.8rem' }}
                        >
                            {API_PROVIDERS.map(provider => (
                                <option key={provider.value} value={provider.value}>{provider.label}</option>
                            ))}
                        </select>
                        <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>Model ID</label>
                        <input
                            className="input"
                            value={apiDraft.model}
                            onChange={(e) => setApiDraft(prev => ({ ...prev, model: e.target.value }))}
                            placeholder={DEFAULT_MODEL}
                            style={{ width: '100%', marginBottom: '0.8rem' }}
                        />
                        <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>API key</label>
                        <div style={{ display: 'flex', gap: '0.45rem' }}>
                            <input
                                className="input"
                                type={showApiKey ? 'text' : 'password'}
                                value={apiDraft.apiKey}
                                onChange={(e) => setApiDraft(prev => ({ ...prev, apiKey: e.target.value }))}
                                placeholder={
                                    localStorage.getItem(`${API_KEY_STORAGE[normalizeProvider(apiDraft.provider)] || API_KEY_STORAGE[DEFAULT_PROVIDER]}_configured`) === 'true'
                                        ? 'Server/environment key available'
                                        : 'Enter a browser-local key'
                                }
                                style={{ flex: 1 }}
                            />
                            <button className="btn btn-ghost" type="button" onClick={() => setShowApiKey(value => !value)} title={showApiKey ? 'Hide API key' : 'Show API key'}>
                                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.45rem 0 1rem', lineHeight: 1.5 }}>
                            {localStorage.getItem(`${API_KEY_STORAGE[normalizeProvider(apiDraft.provider)] || API_KEY_STORAGE[DEFAULT_PROVIDER]}_configured`) === 'true'
                                ? 'A server/environment key is configured but hidden. Leave this blank to use it, or type a browser-local override.'
                                : 'Saved in this browser only. It is not shown again on other browsers or devices.'}
                        </div>
                        <div style={{ background: 'var(--bg-accent)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem', fontSize: '0.75rem', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                            <strong style={{ color: 'var(--text-primary)' }}>Active route:</strong> {API_PROVIDERS.find(item => item.value === normalizeProvider(apiDraft.provider))?.label || apiDraft.provider} → {apiDraft.model || 'model not set'}<br />
                            Browser-local keys are sent to the TradingSpy backend with each assistant request. Server keys remain hidden from the browser.
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                            <button className="btn btn-ghost" onClick={() => setApiPanelOpen(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={saveAssistantApi}>Save</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Share Modal */}
            {shareModalOpen && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div style={{ backgroundColor: 'var(--bg-card)', color: 'var(--text-main)', border: '1px solid var(--border-subtle)', padding: '1.5rem', borderRadius: '12px', maxWidth: '620px', width: '92%', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 18px 60px rgba(0,0,0,0.5)', opacity: 1 }}>
                        <h3 style={{ margin: '0 0 0.25rem' }}>Share or export chat</h3>
                        <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Copy it directly, save a Markdown file, print to PDF, or create a public link.</p>
                        
                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                <input 
                                    type="checkbox" 
                                    checked={limitToFourLines}
                                    onChange={(e) => setLimitToFourLines(e.target.checked)}
                                />
                                Only share latest 4 messages
                            </label>
                        </div>
                        
                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.82rem', fontWeight: 700 }}>Plain-text preview</label>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <textarea 
                                    value={formatAsWhatsAppText()} 
                                    readOnly 
                                    className="input" 
                                    style={{ flex: 1, minHeight: '100px', fontSize: '0.85rem', fontFamily: 'monospace' }}
                                />
                                <button
                                    className="btn btn-ghost btn-sm" 
                                    onClick={() => copyToClipboard(formatAsWhatsAppText(), 'whatsapp-text')}
                                    style={{ alignSelf: 'flex-start' }}
                                    title="Copy plain text"
                                >
                                    {copiedId === 'whatsapp-text' ? <Check size={14} /> : <Copy size={14} />} Copy
                                </button>
                            </div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.5rem', marginBottom: '1rem' }}>
                            <button className="btn btn-ghost" onClick={() => copyToClipboard(formatAsMarkdown(), 'markdown-copy')}>
                                {copiedId === 'markdown-copy' ? <Check size={14} /> : <FileText size={14} />} Copy Markdown
                            </button>
                            <button className="btn btn-ghost" onClick={downloadMarkdown}>
                                <Download size={14} /> Download .md
                            </button>
                            <button className="btn btn-ghost" onClick={printAsPdf}>
                                <Printer size={14} /> Print / PDF
                            </button>
                        </div>

                        {shareError && (
                            <div style={{ padding: '0.7rem', marginBottom: '1rem', borderRadius: 8, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', color: 'var(--brand-red)', fontSize: '0.78rem' }}>{shareError}</div>
                        )}
                        
                        {shareUrl && (
                            <div style={{ marginBottom: '1rem' }}>
                                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', opacity: 0.7 }}>Share URL:</label>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <input 
                                        type="text" 
                                        value={shareUrl} 
                                        readOnly 
                                        className="input" 
                                        style={{ flex: 1 }}
                                    />
                                    <button 
                                        className="btn btn-ghost btn-sm" 
                                        onClick={() => copyToClipboard(shareUrl, 'share-url')}
                                    >
                                        {copiedId === 'share-url' ? <Check size={14} /> : <Copy size={14} />}
                                    </button>
                                </div>
                            </div>
                        )}
                        
                        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                            <button 
                                className="btn btn-ghost" 
                                onClick={() => {
                                    setShareModalOpen(false);
                                    setShareUrl('');
                                    setShareError('');
                                    setShareLoading(false);
                                    setLimitToFourLines(false);
                                }}
                            >
                                Cancel
                            </button>
                            {!shareUrl && (
                                <button className="btn btn-primary" onClick={shareThread} disabled={shareLoading}>
                                    {shareLoading ? <RefreshCw className="animate-spin" size={14} /> : <Share size={14} />} {shareLoading ? 'Generating…' : 'Generate public link'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ChatBot;
