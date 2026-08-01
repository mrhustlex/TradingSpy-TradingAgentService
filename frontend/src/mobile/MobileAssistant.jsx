import React, { useState, useEffect, useRef } from 'react';
import {
  Send,
  Bot,
  User,
  Plus,
  Trash2,
  MessageSquare,
  X,
  Copy,
  Check,
  Share2,
  Settings,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toPng } from 'html-to-image';
import { BACKTEST_SERVICE } from '../config';
import renderMarkdown from '../utils/renderMarkdown';
import { getApiSettings } from '../utils/apiKeyHelper';
import { normalizeAssistantResponseText } from '../utils/assistantResponse';
import MobileExpectedPatternCard from './components/MobileExpectedPatternCard';
import MobileChartCard from './components/MobileChartCard';
import AgentTrace from '../components/AgentTrace';

const STORAGE_KEY = 'chatThreads';
const LEGACY_STORAGE_KEY = 'mobile_chatThreads';
const DEFAULT_PROVIDER = 'google_ai_studio';
const DEFAULT_MODEL = 'gemini-2.5-flash';

const buildApiConfig = () => {
  try {
    const s = getApiSettings();
    return {
      provider: s.provider,
      model: s.model,
      apiKey: s.provider === 'ollama' ? '' : (s.api_key || ''),
      providerConfig: s.provider_config || undefined,
    };
  } catch {
    return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, apiKey: '', providerConfig: undefined };
  }
};

const WELCOME_MSG = (threadId) => ({
  id: `init-${threadId}`,
  role: 'assistant',
  content: "Hi! I'm your Trading AI assistant. I can help you with:\n\n• Market analysis and research\n• Strategy generation and backtesting\n• Technical and fundamental analysis\n• Web research and news\n\nWhat would you like to explore?",
  timestamp: new Date().toISOString(),
});

const createThread = () => ({
  id: `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  title: 'New Chat',
  messages: [],
  history: [],
  createdAt: new Date().toISOString(),
});

const normalizeThread = (t) => ({
  ...t,
  messages: (t.messages || []).map(m => ({
    ...m,
    role: m.role || (m.type === 'user' ? 'user' : 'assistant'),
    thinking: m.thinking ?? m.reasoning ?? '',
  })),
});

const loadThreads = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.threads || []);
    return list.map(normalizeThread);
  } catch {
    return [];
  }
};

const MobileAssistant = ({
  files,
  strategies,
  tasks,
  onTrigger,
  notify,
  onRefreshStrats,
  onRefreshFiles,
  autoPrompt,
  onAutoPromptConsumed,
  onAgentRunUpdate,
}) => {
  const [threads, setThreads] = useState(() => {
    try {
      return loadThreads();
    } catch {
      return [];
    }
  });
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMsgId, setStreamingMsgId] = useState(null);
  const [showThreadList, setShowThreadList] = useState(false);
  const [showApiPanel, setShowApiPanel] = useState(false);
  const [thinkingDetail, setThinkingDetail] = useState(localStorage.getItem('thinking_detail') || 'normal');
  const [responseLength, setResponseLength] = useState(localStorage.getItem('response_length') || 'mid');
  const [showThinking, setShowThinking] = useState(localStorage.getItem('show_live_thinking') !== 'false');
  const [agentMode, setAgentMode] = useState(localStorage.getItem('assistant_agent_mode') !== 'false');
  const [apiConfig, setApiConfig] = useState(buildApiConfig);

  const getMaxTokens = () => {
    const lengths = { short: 2048, mid: 8192, long: 16384 };
    return lengths[responseLength] || 8192;
  };

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortControllerRef = useRef(null);

  const activeThread = threads.find(t => t.id === activeThreadId);

  const ensureThread = () => {
    const newThread = createThread();
    newThread.messages = [WELCOME_MSG(newThread.id)];
    return newThread;
  };

  // Keep at least one thread and a valid active thread
  useEffect(() => {
    if (threads.length === 0) {
      const newThread = ensureThread();
      setThreads([newThread]);
      setActiveThreadId(newThread.id);
      return;
    }
    if (!activeThreadId || !threads.some(t => t.id === activeThreadId)) {
      setActiveThreadId(threads[0].id);
    }
  }, [threads, activeThreadId]);

  // Save threads to localStorage (shared with web assistant)
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
  }, [threads]);

  // Handle auto-prompt
  useEffect(() => {
    if (autoPrompt && autoPrompt.prompt) {
      setInput(autoPrompt.prompt);
      if (onAutoPromptConsumed) onAutoPromptConsumed();
    }
  }, [autoPrompt]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeThread?.messages]);

  const updateThread = (threadId, updater) => {
    setThreads(prev => prev.map(t => t.id === threadId ? updater(t) : t));
  };

  const createNewThread = () => {
    const newThread = ensureThread();
    setThreads(prev => [newThread, ...prev]);
    setActiveThreadId(newThread.id);
    setShowThreadList(false);
  };

  const deleteThread = (threadId) => {
    setThreads(prev => prev.filter(t => t.id !== threadId));
  };

  const handleSend = async () => {
    if (!input.trim() || isStreaming || !activeThreadId) return;

    const userMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };

    const assistantMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      thinking: '',
      steps: [],
      cards: [],
      timestamp: new Date().toISOString(),
    };

    updateThread(activeThreadId, t => ({
      ...t,
      messages: [...t.messages, userMessage, assistantMessage],
    }));

    setInput('');
    setIsStreaming(true);
    setStreamingMsgId(assistantMessage.id);
    abortControllerRef.current = new AbortController();

    try {
      const thread = threads.find(t => t.id === activeThreadId);
      
      const response = await fetch(`${BACKTEST_SERVICE}/ai/${agentMode ? 'chat-strands' : 'chat-with-tools'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage.content,
          history: thread?.history || [],
          provider: apiConfig.provider,
          model: apiConfig.model,
          api_key: apiConfig.apiKey || undefined,
          provider_config: apiConfig.providerConfig || undefined,
          max_tokens: getMaxTokens(),
          thinking_detail: thinkingDetail,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let responseText = '';
      let thinkingText = '';
      let cardData = {};
      const buildCards = () => {
        const cards = [];
        for (const result of Object.values(cardData)) {
          if (result?.type === 'expected_pattern' && Array.isArray(result?.forecast) && result.forecast.length) {
            cards.push({ kind: 'expected_pattern', data: result });
          } else if (result?.type === 'chart' && Array.isArray(result?.data) && result.data.length) {
            cards.push({ kind: 'chart', data: result });
          }
        }
        return cards;
      };

      const applyStreamUpdate = (patch) => {
        updateThread(activeThreadId, t => ({
          ...t,
          messages: t.messages.map(m => {
            if (m.id !== assistantMessage.id) return m;
            const next = { ...m };
            for (const [k, v] of Object.entries(patch)) {
              next[k] = typeof v === 'function' ? v(next[k]) : v;
            }
            return next;
          }),
        }));
      };

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
            if (data.type === 'response') {
              // Backend sends the FULL accumulated text in every response event.
              const normalized = normalizeAssistantResponseText(data.content);
              responseText = normalized || responseText;
              applyStreamUpdate({ content: responseText });
            } else if ((data.type === 'thinking' || data.type === 'status') && data.content) {
              if (!thinkingText.includes(data.content)) {
                thinkingText = thinkingText ? `${thinkingText}\n${data.content}` : data.content;
              }
              applyStreamUpdate({ thinking: thinkingText });
            } else if (data.type === 'step' && data.step) {
              const step = data.step;
              // Agent-loop (chat-strands) steps have no _tool_key; key by tool name or
              // label with leading emoji stripped so "🔧 tool" and "✅ tool" merge in place.
              const key = step._tool_key || step.tool || String(step.label || '').replace(/^[^\w]+/, '') || `step-${Date.now()}-${Math.random()}`;
              applyStreamUpdate({ steps: (prevSteps) => {
                const map = new Map(prevSteps.map(s => [s.key, s]));
                map.set(key, { key, ...step });
                return Array.from(map.values());
              } });
            } else if (data.type === 'task_started' && data.task_id) {
              if (onTrigger) onTrigger(data.task_id, data.task_type || 'forge', data.label || 'Agent Task');
            } else if (data.type === 'done' || data.type === 'result') {
              const payload = data.type === 'result' ? (data.payload || {}) : data;
              const raw = payload.data || payload.market_data || {};
              if (Array.isArray(raw)) {
                raw.forEach((result, idx) => {
                  if (result && typeof result === 'object') cardData[`item_${idx}_${result.type || 'data'}`] = result;
                });
              } else {
                for (const [name, result] of Object.entries(raw)) {
                  if (result && typeof result === 'object') cardData[name] = result;
                }
              }
              const cards = buildCards();
              if (cards.length) applyStreamUpdate({ cards });
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      if (!responseText) {
        responseText = 'No response received.';
        updateThread(activeThreadId, t => ({
          ...t,
          messages: t.messages.map(m =>
            m.id === assistantMessage.id
              ? { ...m, content: responseText }
              : m
          ),
        }));
      }
      
      updateThread(activeThreadId, t => ({
        ...t,
        history: [...(t.history || []),
          { role: 'user', content: userMessage.content },
          { role: 'assistant', content: responseText }
        ],
      }));

      if (thread?.messages.length <= 1) {
        const title = userMessage.content.slice(0, 30) + (userMessage.content.length > 30 ? '...' : '');
        updateThread(activeThreadId, t => ({ ...t, title }));
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('Chat error:', e);
        updateThread(activeThreadId, t => ({
          ...t,
          messages: t.messages.map(m =>
            m.id === assistantMessage.id
              ? { ...m, content: 'Failed to get response. Please try again.' }
              : m
          ),
        }));
      }
    }
    setIsStreaming(false);
    setStreamingMsgId(null);
  };

  const stopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsStreaming(false);
    setStreamingMsgId(null);
  };

  const stripMarkdown = (raw) => {
    const text = String(raw || '');
    return text
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
      .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
      .replace(/^>\s?/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/_{1,2}(.*?)_{1,2}/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  const TRADINGSPY_FOOTER = '\n\n---\nInsight by TradingSpy (https://github.com/mrhustlex/TradingSpy-TradingAgentService)';

  const copyToClipboard = async (text, addFooter = false) => {
    const payload = addFooter ? stripMarkdown(text) + TRADINGSPY_FOOTER : stripMarkdown(text);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = payload;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      notify('Copied with TradingSpy footer', addFooter ? 'green' : 'blue');
    } catch (e) {
      notify(`Copy failed: ${e?.message || 'clipboard access was denied'}`, 'error');
    }
  };

  const buildShareImage = async (messageId, messageContent) => {
    const node = document.getElementById(`mobile-msg-content-${messageId}`);
    if (!node) return null;
    const dataUrl = await toPng(node, {
      backgroundColor: '#0a0e1a',
      pixelRatio: 2,
      style: { borderRadius: '12px' },
    });
    const img = new Image();
    img.src = dataUrl;
    await new Promise(r => { img.onload = r; });

    const logoImg = new Image();
    logoImg.src = '/logo.png';
    await new Promise((resolve) => {
      logoImg.onload = resolve;
      logoImg.onerror = resolve;
    });
    const hasLogo = logoImg.complete && logoImg.naturalWidth > 0;

    const canvas = document.createElement('canvas');
    const minFooter = hasLogo ? 160 : 100;
    const footerHeight = Math.max(minFooter, Math.ceil(img.height * 0.25));
    const scale = footerHeight / (hasLogo ? 160 : 100);
    canvas.width = img.width;
    canvas.height = img.height + footerHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, img.height, canvas.width, footerHeight);
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.beginPath();
    ctx.moveTo(16, img.height + 1);
    ctx.lineTo(canvas.width - 16, img.height + 1);
    ctx.stroke();
    if (hasLogo) {
      const logoH = Math.round(50 * scale);
      const logoW = (logoImg.naturalWidth / logoImg.naturalHeight) * logoH;
      ctx.drawImage(logoImg, 20, img.height + Math.round(18 * scale), logoW, logoH);
      ctx.fillStyle = '#94a3b8';
      ctx.font = `600 ${Math.round(22 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillText('Insight by TradingSpy', 20, img.height + Math.round(95 * scale));
      ctx.fillStyle = '#64748b';
      ctx.font = `400 ${Math.round(17 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillText('github.com/mrhustlex/TradingSpy-TradingAgentService', 20, img.height + Math.round(120 * scale));
    } else {
      ctx.fillStyle = '#94a3b8';
      ctx.font = `600 ${Math.round(24 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillText('TradingSpy', 20, img.height + Math.round(40 * scale));
      ctx.fillStyle = '#64748b';
      ctx.font = `400 ${Math.round(18 * scale)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillText('github.com/mrhustlex/TradingSpy-TradingAgentService', 20, img.height + Math.round(68 * scale));
    }
    return canvas.toDataURL('image/png');
  };

  const shareMessageAsImage = async (messageId, messageContent) => {
    try {
      notify('Preparing share image...', 'blue');
      const dataUrl = await buildShareImage(messageId, messageContent);
      if (!dataUrl) {
        notify('Could not capture this message', 'error');
        return;
      }
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], `tradingspy-${messageId.slice(0, 8)}.png`, { type: 'image/png' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'TradingSpy insight',
          text: 'Insight by TradingSpy',
        });
      } else {
        const link = document.createElement('a');
        link.download = file.name;
        link.href = dataUrl;
        link.click();
        notify('Share not available; image downloaded', 'green');
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      notify(`Share failed: ${e?.message || 'could not share image'}`, 'error');
    }
  };

  const suggestedPrompts = [
    'Give me a daily market brief',
    'Analyze NVDA technicals',
    'What are the top gainers today?',
    'Explain the current market sentiment',
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Chat Header */}
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        padding: 'var(--mobile-spacing-md)',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-card)',
      }}>
        <button className="mobile-header-btn" onClick={createNewThread} title="New chat">
          <Plus size={20} />
        </button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 'var(--mobile-text-base)', fontWeight: 600 }}>
            {activeThread?.title || 'Chat'}
          </div>
          <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)' }}>
            {apiConfig.provider} · {apiConfig.model}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="mobile-header-btn" onClick={() => setShowThreadList(true)} title="History">
            <MessageSquare size={20} />
          </button>
          <button 
            className="mobile-header-btn"
            onClick={() => {
              setApiConfig(buildApiConfig());
              setShowApiPanel(true);
            }}
          >
            <Settings size={20} />
          </button>
        </div>
      </div>

      {/* Messages Area */}
      <div style={{ 
        flex: 1, 
        overflowY: 'auto', 
        padding: 'var(--mobile-spacing-md)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--mobile-spacing-md)',
      }}>
        {activeThread?.messages.map((message) => {
          const isUser = message.role === 'user';
          return (
            <motion.div
              key={message.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              style={{
                display: 'flex',
                flexDirection: isUser ? 'row-reverse' : 'row',
                gap: 'var(--mobile-spacing-sm)',
                alignItems: 'flex-start',
              }}
            >
              <div style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: isUser ? 'var(--brand-green)' : 'var(--brand-blue)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                {isUser ? <User size={14} color="white" /> : <Bot size={14} color="white" />}
              </div>
              <div style={{
                maxWidth: '80%',
                background: isUser ? 'rgba(34,197,94,0.13)' : 'rgba(15,23,42,0.72)',
                border: `1px solid ${isUser ? 'rgba(34,197,94,0.24)' : 'rgba(148,163,184,0.16)'}`,
                borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                padding: 'var(--mobile-spacing-md)',
              }}>
                {!isUser && (message.steps?.length > 0 || (message.thinking && showThinking)) && (
                  <AgentTrace
                    variant="mobile"
                    steps={message.steps || []}
                    reasoning={showThinking ? (message.thinking || '') : ''}
                    isRunning={isStreaming && message.id === streamingMsgId}
                  />
                )}
                <div id={isUser ? undefined : `mobile-msg-content-${message.id}`}>
                  <div style={{ 
                    fontSize: 'var(--mobile-text-base)', 
                    lineHeight: 1.5,
                    whiteSpace: isUser ? 'pre-wrap' : 'normal',
                  }}>
                    {isUser ? message.content : (message.content ? renderMarkdown(message.content) : 'Thinking...')}
                  </div>
                  {!isUser && message.cards && message.cards.length > 0 && (
                    <div style={{ marginTop: 'var(--mobile-spacing-sm)' }}>
                      {message.cards.map((card, idx) => (
                        <div key={idx}>
                          {card.kind === 'expected_pattern' && (
                            <MobileExpectedPatternCard data={card.data} notify={notify} />
                          )}
                          {card.kind === 'chart' && (
                            <MobileChartCard chart={card.data} />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {message.content && (
                  <div style={{ 
                    display: 'flex', 
                    gap: 'var(--mobile-spacing-sm)', 
                    marginTop: 'var(--mobile-spacing-sm)',
                    justifyContent: 'flex-end',
                  }}>
                    <button
                      onClick={() => copyToClipboard(message.content, true)}
                      title="Copy with TradingSpy footer"
                      style={{ 
                        background: 'none', 
                        border: 'none', 
                        color: 'var(--text-secondary)',
                        padding: 4,
                        cursor: 'pointer',
                      }}
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      onClick={() => shareMessageAsImage(message.id, message.content)}
                      title="Share as image with logo"
                      style={{ 
                        background: 'none', 
                        border: 'none', 
                        color: 'var(--text-secondary)',
                        padding: 4,
                        cursor: 'pointer',
                      }}
                    >
                      <Share2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div style={{ 
        padding: 'var(--mobile-spacing-md)',
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-card)',
      }}>
        {/* Suggested Prompts (show when no messages) */}
        {activeThread?.messages.length <= 1 && (
          <div style={{ 
            display: 'flex', 
            flexWrap: 'wrap', 
            gap: 'var(--mobile-spacing-sm)',
            marginBottom: 'var(--mobile-spacing-md)',
          }}>
            {suggestedPrompts.map((prompt, i) => (
              <button
                key={i}
                className="mobile-pill"
                onClick={() => setInput(prompt)}
                style={{ fontSize: 'var(--mobile-text-xs)' }}
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 'var(--mobile-spacing-sm)' }}>
          <div style={{ display: 'flex', gap: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 999, padding: 2, alignSelf: 'flex-end' }}>
            <button
              className={`mobile-pill ${!agentMode ? 'active' : ''}`}
              onClick={() => {
                setAgentMode(false);
                localStorage.setItem('assistant_agent_mode', 'false');
              }}
              style={{ fontSize: 'var(--mobile-text-xs)', padding: '5px 8px', minHeight: 40 }}
              title="Quick mode: single-pass. Picks tools once, then answers."
            >
              ⚡
            </button>
            <button
              className={`mobile-pill ${agentMode ? 'active' : ''}`}
              onClick={() => {
                setAgentMode(true);
                localStorage.setItem('assistant_agent_mode', 'true');
              }}
              style={{ fontSize: 'var(--mobile-text-xs)', padding: '5px 8px', minHeight: 40 }}
              title="Agent mode: loops until the task is done. Best for multi-step workflows like fundamental scanning."
            >
              🤖
            </button>
          </div>
          <textarea
            ref={inputRef}
            className="mobile-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask anything..."
            rows={1}
            style={{ flex: 1, resize: 'none', minHeight: 44, maxHeight: 120 }}
          />
          {isStreaming ? (
            <button
              className="mobile-btn mobile-btn-sm"
              onClick={stopStreaming}
              style={{ width: 44, height: 44, background: 'var(--brand-red)' }}
            >
              <X size={18} />
            </button>
          ) : (
            <button
              className="mobile-btn mobile-btn-sm"
              onClick={handleSend}
              disabled={!input.trim()}
              style={{ width: 44, height: 44 }}
            >
              <Send size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Thread List Sheet */}
      <AnimatePresence>
        {showThreadList && (
          <div className="mobile-sheet-overlay" onClick={() => setShowThreadList(false)}>
            <motion.div
              className="mobile-sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mobile-sheet-handle" />
              <div className="mobile-sheet-header">
                <span className="mobile-sheet-title">Conversations</span>
                <div style={{ display: 'flex', gap: 'var(--mobile-spacing-sm)' }}>
                  <button className="mobile-btn mobile-btn-sm mobile-btn-primary" onClick={createNewThread}>
                    <Plus size={14} /> New
                  </button>
                  <button className="mobile-header-btn" onClick={() => setShowThreadList(false)}>
                    <X size={20} />
                  </button>
                </div>
              </div>
              <div className="mobile-sheet-content">
                <div className="mobile-list">
                  {threads.map((thread) => (
                    <div
                      key={thread.id}
                      className={`mobile-list-item ${thread.id === activeThreadId ? 'selected' : ''}`}
                      onClick={() => {
                        setActiveThreadId(thread.id);
                        setShowThreadList(false);
                      }}
                    >
                      <div className="mobile-list-item-content">
                        <div className="mobile-list-item-title">{thread.title}</div>
                        <div className="mobile-list-item-subtitle">
                          {thread.messages.length} messages
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteThread(thread.id);
                        }}
                        style={{ 
                          background: 'none', 
                          border: 'none', 
                          color: 'var(--brand-red)',
                          padding: 8,
                          cursor: 'pointer',
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* API Panel Sheet */}
      <AnimatePresence>
        {showApiPanel && (
          <div className="mobile-sheet-overlay" onClick={() => setShowApiPanel(false)}>
            <motion.div
              className="mobile-sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mobile-sheet-handle" />
              <div className="mobile-sheet-header">
                <span className="mobile-sheet-title">Assistant Settings</span>
                <button className="mobile-header-btn" onClick={() => setShowApiPanel(false)}>
                  <X size={20} />
                </button>
              </div>
              <div className="mobile-sheet-content">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mobile-spacing-md)' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                      Provider
                    </label>
                    <select
                      className="mobile-input"
                      value={apiConfig.provider}
                      onChange={(e) => setApiConfig(prev => ({ ...prev, provider: e.target.value }))}
                    >
                      <option value="google_ai_studio">Google AI Studio</option>
                      <option value="mistral">Mistral</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="nvidia">NVIDIA</option>
                      <option value="litellm">LiteLLM</option>
                      <option value="ollama">Ollama (Local)</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                      Model
                    </label>
                    <input
                      className="mobile-input"
                      value={apiConfig.model}
                      onChange={(e) => setApiConfig(prev => ({ ...prev, model: e.target.value }))}
                      placeholder={DEFAULT_MODEL}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                      API Key (optional)
                    </label>
                    <input
                      className="mobile-input"
                      type="password"
                      value={apiConfig.apiKey}
                      onChange={(e) => setApiConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                      placeholder="Leave blank for server default"
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                      Run Detail (thinking)
                    </label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {['brief', 'normal', 'detailed'].map(level => (
                        <button
                          key={level}
                          className={`mobile-pill ${thinkingDetail === level ? 'active' : ''}`}
                          style={{ flex: 1, fontSize: 'var(--mobile-text-xs)', padding: '4px 0' }}
                          onClick={() => {
                            setThinkingDetail(level);
                            localStorage.setItem('thinking_detail', level);
                          }}
                        >
                          {level}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                      Response Length
                    </label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {['short', 'mid', 'long'].map(len => (
                        <button
                          key={len}
                          className={`mobile-pill ${responseLength === len ? 'active' : ''}`}
                          style={{ flex: 1, fontSize: 'var(--mobile-text-xs)', padding: '4px 0' }}
                          onClick={() => {
                            setResponseLength(len);
                            localStorage.setItem('response_length', len);
                          }}
                        >
                          {len}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--mobile-text-sm)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={showThinking}
                      onChange={(e) => {
                        setShowThinking(e.target.checked);
                        localStorage.setItem('show_live_thinking', e.target.checked);
                      }}
                      style={{ cursor: 'pointer', width: 16, height: 16 }}
                    />
                    Show thinking process
                  </label>
                  <button
                    className="mobile-btn"
                    onClick={() => {
                      localStorage.setItem('settings_default_provider', apiConfig.provider);
                      localStorage.setItem('settings_default_model', apiConfig.model);
                      const key = `settings_${apiConfig.provider}_api_key`;
                      if (apiConfig.apiKey) {
                        localStorage.setItem(key, apiConfig.apiKey);
                      } else {
                        localStorage.removeItem(key);
                      }
                      setShowApiPanel(false);
                      notify('Settings saved', 'green');
                    }}
                  >
                    Save Settings
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default MobileAssistant;
