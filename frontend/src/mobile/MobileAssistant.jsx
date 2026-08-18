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
  ListTodo,
  Zap,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BACKTEST_SERVICE } from '../config';
import useSheetResize from './useSheetResize';
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
  const { sheetHeight: threadSheetHeight, handleProps: threadHandleProps, sheetStyle: threadSheetStyle } = useSheetResize();
  const { sheetHeight: apiSheetHeight, handleProps: apiHandleProps, sheetStyle: apiSheetStyle } = useSheetResize();
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
  const [queuedMessages, setQueuedMessages] = useState([]);
  const [showThreadList, setShowThreadList] = useState(false);
  const [showApiPanel, setShowApiPanel] = useState(false);
  const [thinkingDetail, setThinkingDetail] = useState(localStorage.getItem('thinking_detail') || 'normal');
  const [responseLength, setResponseLength] = useState(localStorage.getItem('response_length') || 'mid');
  const [customMaxOutput, setCustomMaxOutput] = useState(localStorage.getItem('custom_max_output') || '');
  const [showThinking, setShowThinking] = useState(localStorage.getItem('show_live_thinking') !== 'false');
  const [agentMode, setAgentMode] = useState(localStorage.getItem('assistant_agent_mode') !== 'false');
  const [apiConfig, setApiConfig] = useState(buildApiConfig);

  const getMaxTokens = () => {
    const custom = Number(customMaxOutput);
    if (customMaxOutput && custom > 0) {
      return Math.min(20000, Math.max(1024, Math.round(custom * 1.4)));
    }
    const lengths = { short: 2048, mid: 8192, long: 16384 };
    return lengths[responseLength] || 8192;
  };

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortControllerRef = useRef(null);
  const processingQueuedRef = useRef(false);

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

  // Fire queued messages once the assistant is fully idle for the active thread
  useEffect(() => {
    if (isStreaming || queuedMessages.length === 0) {
      processingQueuedRef.current = false;
      return;
    }
    if (processingQueuedRef.current) return;
    processingQueuedRef.current = true;
    const msg = queuedMessages[0];
    const rest = queuedMessages.slice(1);
    setQueuedMessages(rest);
    handleSend(msg, { clearInput: false }).finally(() => {
      processingQueuedRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, queuedMessages, activeThreadId]);

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

  const handleSend = async (rawMessage, { clearInput = true } = {}) => {
    const userText = (rawMessage ?? input ?? '').trim();
    if (!userText || !activeThreadId) return;

    // If the assistant is busy, queue the message instead of starting a parallel
    // response. Queued messages fire automatically once the thread is idle.
    if (isStreaming) {
      if (clearInput) setInput('');
      setQueuedMessages(prev => [...prev, userText]);
      return;
    }

    const userMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userText,
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

    if (clearInput) setInput('');
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
          max_output_chars: customMaxOutput ? Number(customMaxOutput) : undefined,
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
            } else if (data.type === 'error') {
              const errText = String(data.content || data.message || 'Assistant error.').replace(/^Assistant error:\s*/, '');
              responseText = `⚠️ ${errText}`;
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

  const cancelQueuedInput = () => {
    setQueuedMessages([]);
  };

  const steerQueuedInput = () => {
    if (!queuedMessages.length) return;
    const steeringMessage = queuedMessages[0];
    const remaining = queuedMessages.slice(1);
    setQueuedMessages(remaining);

    const wasStreaming = isStreaming;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsStreaming(false);
    setStreamingMsgId(null);

    // Mark the interrupted message so it doesn't look like a dropped response.
    if (streamingMsgId) {
      updateThread(activeThreadId, t => ({
        ...t,
        messages: t.messages.map(m =>
          m.id === streamingMsgId
            ? { ...m, content: '⚠️ Response interrupted by steering.' }
            : m
        ),
      }));
    }

    // Send the steering message immediately with context once the abort settles.
    const messageToSend = wasStreaming ? `[Steering] ${steeringMessage}` : steeringMessage;
    setTimeout(() => {
      handleSend(messageToSend, { clearInput: false });
    }, 100);
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

  const buildShareImage = async (_messageId, messageContent) => {
    const raw = String(messageContent || '').trim();
    if (!raw) return null;

    const WIDTH = 1080;
    const PAD_X = 56;
    const PAD_Y = 56;
    const FOOTER_GAP = 40;
    const FOOTER_H = 150;
    const CONTENT_W = WIDTH - PAD_X * 2;

    const SANS = '-apple-system, BlinkMacSystemFont, sans-serif';
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

    const FONTS = {
      h1: { size: 42, lh: 60, color: '#e2e8f0', bold: true },
      h2: { size: 36, lh: 52, color: '#e2e8f0', bold: true },
      h3: { size: 31, lh: 47, color: '#cbd5e1', bold: true },
      text: { size: 28, lh: 44, color: '#e2e8f0', bold: false },
      code: { size: 25, lh: 39, color: '#cbd5e1', bold: false },
      quote: { size: 26, lh: 42, color: '#94a3b8', bold: false },
    };

    const segFont = (seg, base) => {
      if (seg.style === 'code') return `400 ${base.size - 3}px ${MONO}`;
      const w = seg.style === 'bold' || base.bold ? '700' : '400';
      return `${w} ${base.size}px ${SANS}`;
    };

    const tokenize = (line) => {
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
      const segs = [];
      let last = 0;
      let m;
      while ((m = re.exec(line))) {
        if (m.index > last) segs.push({ text: line.slice(last, m.index), style: 'normal' });
        const tok = m[0];
        if (tok.startsWith('**')) segs.push({ text: tok.slice(2, -2), style: 'bold' });
        else if (tok.startsWith('`')) segs.push({ text: tok.slice(1, -1), style: 'code' });
        else {
          const im = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
          segs.push({ text: im ? im[1] : tok, style: 'link' });
        }
        last = m.index + tok.length;
      }
      if (last < line.length) segs.push({ text: line.slice(last), style: 'normal' });
      return segs.length ? segs : [{ text: ' ', style: 'normal' }];
    };

    const blockKind = (line) => {
      if (/^#{1,6}\s/.test(line)) {
        const n = line.match(/^#+/)[0].length;
        return n === 1 ? 'h1' : n === 2 ? 'h2' : 'h3';
      }
      if (/^[-*_]{3,}\s*$/.test(line.trim())) return 'hr';
      if (line.startsWith('```') || /^ {4}/.test(line)) return 'code';
      return 'text';
    };

    const parseBlocks = (content) => {
      const blocks = [];
      const paragraphs = content.replace(/\r\n/g, '\n').split(/\n{2,}/);
      for (const para of paragraphs) {
        const lines = para.split('\n');
        if (lines[0].startsWith('```')) {
          lines.filter(l => !l.startsWith('```')).forEach(cl =>
            blocks.push({ kind: 'code', indent: 0, segs: [{ text: cl || ' ', style: 'code' }] })
          );
          continue;
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          const kind = blockKind(line);
          if (kind === 'hr') { blocks.push({ kind: 'hr', indent: 0, segs: [] }); continue; }
          if (kind === 'code') {
            blocks.push({ kind: 'code', indent: 0, segs: [{ text: line.replace(/^ {4}/, ''), style: 'code' }] });
            continue;
          }
          let indent = 0;
          let body = line;
          let prefix = '';
          if (/^[-*•]\s/.test(body)) { prefix = '•'; indent = 34; body = body.replace(/^[-*•]\s/, ''); }
          else if (/^\d+[.)]\s/.test(body)) {
            const nm = body.match(/^(\d+[.)])\s/);
            prefix = nm[1];
            indent = 44;
            body = body.slice(nm[0].length);
          }
          else if (body.startsWith('> ')) { prefix = '▍'; indent = 38; body = body.slice(2); }
          const segs = prefix
            ? [{ text: prefix, style: 'bullet' }, ...tokenize(body)]
            : tokenize(body);
          blocks.push({ kind, indent, segs });
        }
      }
      return blocks;
    };

    const scratch = document.createElement('canvas');
    const mctx = scratch.getContext('2d');

    const wrapBlock = (ctx, block) => {
      const base = FONTS[block.kind] || FONTS.text;
      const maxW = CONTENT_W - block.indent;
      const segW = (seg) => { ctx.font = segFont(seg, base); return ctx.measureText(seg.text).width; };
      const spaceW = () => { ctx.font = segFont({ style: 'normal' }, base); return ctx.measureText(' ').width; };
      const lines = [];
      let cur = [];
      const lineW = () => cur.reduce((a, s, i) => a + segW(s) + (i > 0 ? spaceW() : 0), 0);
      const flush = () => { if (cur.length) { lines.push(cur); cur = []; } };

      for (const seg of block.segs) {
        if (seg.style === 'code' || !/\s/.test(seg.text)) {
          const w = segW(seg);
          if (w <= maxW) {
            if (cur.length && lineW() + spaceW() + w > maxW) flush();
            cur.push(seg);
          } else {
            if (cur.length) flush();
            let chunk = '';
            for (const ch of seg.text) {
              ctx.font = segFont({ ...seg, text: chunk + ch }, base);
              if (ctx.measureText(chunk + ch).width > maxW && chunk) {
                cur.push({ ...seg, text: chunk });
                flush();
                chunk = ch;
              } else chunk += ch;
            }
            if (chunk) cur.push({ ...seg, text: chunk });
          }
          continue;
        }
        for (const word of seg.text.split(/\s+/).filter(Boolean)) {
          const tmp = { ...seg, text: word };
          if (cur.length && lineW() + spaceW() + segW(tmp) > maxW) flush();
          cur.push(tmp);
        }
      }
      flush();
      return lines;
    };

    const roundRect = (ctx, x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    // Layout & measure first (needs a ctx to wrap text)
    const blocks = parseBlocks(raw);
    const layout = [];
    let contentH = 0;
    for (const block of blocks) {
      if (block.kind === 'hr') {
        layout.push({ ...block, h: 40 });
        contentH += 40;
        continue;
      }
      const base = FONTS[block.kind] || FONTS.text;
      const lines = wrapBlock(mctx, block);
      const blockH = lines.length * base.lh;
      const extra = block.kind === 'code' ? 0 : block.kind === 'h1' || block.kind === 'h2' ? 12 : 6;
      layout.push({ ...block, base, lines, h: blockH + extra });
      contentH += blockH + extra;
    }

    const logoImg = new Image();
    logoImg.src = '/logo.png';
    await new Promise((resolve) => {
      logoImg.onload = resolve;
      logoImg.onerror = resolve;
    });
    const hasLogo = logoImg.complete && logoImg.naturalWidth > 0;

    const canvasH = PAD_Y + contentH + FOOTER_GAP + FOOTER_H + PAD_Y;
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, 0, WIDTH, canvasH);

    // Content
    let top = PAD_Y;
    for (const blk of layout) {
      if (blk.kind === 'hr') {
        ctx.strokeStyle = 'rgba(148,163,184,0.22)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(PAD_X, top + 20);
        ctx.lineTo(WIDTH - PAD_X, top + 20);
        ctx.stroke();
        top += blk.h;
        continue;
      }
      const x = PAD_X + blk.indent;
      if (blk.kind === 'quote') {
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(x - 24, top, 5, blk.lines.length * blk.base.lh);
      }
      if (blk.kind === 'code') {
        ctx.fillStyle = 'rgba(148,163,184,0.09)';
        ctx.fillRect(PAD_X, top, CONTENT_W, blk.lines.length * blk.base.lh);
      }
      let ly = top;
      for (const line of blk.lines) {
        let cx = x;
        const baseline = ly + blk.base.size * 0.82;
        const n = line.length;
        line.forEach((seg, i) => {
          ctx.font = segFont(seg, blk.base);
          if (seg.style === 'bullet') {
            ctx.fillStyle = '#3b82f6';
            ctx.fillText(seg.text, cx, baseline);
          } else if (seg.style === 'code') {
            const w = ctx.measureText(seg.text).width;
            ctx.fillStyle = 'rgba(148,163,184,0.16)';
            roundRect(ctx, cx - 5, ly + blk.base.size * 0.12, w + 10, blk.base.size * 1.15, 6);
            ctx.fill();
            ctx.fillStyle = '#e2e8f0';
            ctx.fillText(seg.text, cx, baseline);
          } else if (seg.style === 'link') {
            ctx.fillStyle = '#60a5fa';
            ctx.fillText(seg.text, cx, baseline);
            ctx.strokeStyle = '#60a5fa';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(cx, baseline + 5);
            ctx.lineTo(cx + ctx.measureText(seg.text).width, baseline + 5);
            ctx.stroke();
          } else {
            ctx.fillStyle = seg.style === 'bold' ? '#f1f5f9' : blk.base.color;
            ctx.fillText(seg.text, cx, baseline);
          }
          if (i < n - 1) cx += ctx.measureText(seg.text).width + mctx.measureText(' ').width;
        });
        ly += blk.base.lh;
      }
      top += blk.h;
    }

    // Footer
    const footerTop = canvasH - PAD_Y - FOOTER_H;
    ctx.strokeStyle = 'rgba(148,163,184,0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD_X, footerTop);
    ctx.lineTo(WIDTH - PAD_X, footerTop);
    ctx.stroke();
    if (hasLogo) {
      const logoH = 56;
      const logoW = (logoImg.naturalWidth / logoImg.naturalHeight) * logoH;
      ctx.drawImage(logoImg, PAD_X, footerTop + 34, logoW, logoH);
      ctx.fillStyle = '#94a3b8';
      ctx.font = `600 26px ${SANS}`;
      ctx.fillText('Insight by TradingSpy', PAD_X + logoW + 22, footerTop + 62);
      ctx.fillStyle = '#64748b';
      ctx.font = `400 20px ${SANS}`;
      ctx.fillText('github.com/mrhustlex/TradingSpy-TradingAgentService', PAD_X + logoW + 22, footerTop + 96);
    } else {
      ctx.fillStyle = '#94a3b8';
      ctx.font = `600 30px ${SANS}`;
      ctx.fillText('TradingSpy', PAD_X, footerTop + 58);
      ctx.fillStyle = '#64748b';
      ctx.font = `400 22px ${SANS}`;
      ctx.fillText('github.com/mrhustlex/TradingSpy-TradingAgentService', PAD_X, footerTop + 92);
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
      const filesSupported = typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function'
        && navigator.canShare({ files: [file] });
      if (filesSupported) {
        await navigator.share({
          files: [file],
          title: 'TradingSpy insight',
          text: 'Insight by TradingSpy',
        });
        return;
      }
      // Image sharing unsupported in this browser: fall back to plain-text share.
      const textPayload = `${stripMarkdown(messageContent)}${TRADINGSPY_FOOTER}`;
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share({ title: 'TradingSpy insight', text: textPayload });
          return;
        } catch (textErr) {
          if (textErr?.name === 'AbortError') return;
        }
      }
      const link = document.createElement('a');
      link.download = file.name;
      link.href = dataUrl;
      link.click();
      notify('Share not supported; image downloaded', 'green');
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      {/* Floating chat actions (no full-width header) */}
      <div style={{
        position: 'absolute',
        top: 'var(--mobile-spacing-sm)',
        right: 'var(--mobile-spacing-md)',
        zIndex: 5,
        display: 'flex',
        gap: 2,
        background: 'rgba(15,23,42,0.78)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 999,
        padding: 2,
        backdropFilter: 'blur(4px)',
      }}>
        <button className="mobile-header-btn" onClick={createNewThread} title="New chat">
          <Plus size={18} />
        </button>
        <button className="mobile-header-btn" onClick={() => setShowThreadList(true)} title="History">
          <MessageSquare size={18} />
        </button>
        <button
          className="mobile-header-btn"
          onClick={() => {
            setApiConfig(buildApiConfig());
            setShowApiPanel(true);
          }}
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </div>

      {/* Messages Area */}
      <div style={{ 
        flex: 1, 
        overflowY: 'auto', 
        padding: 'var(--mobile-spacing-md)',
        paddingTop: 'calc(var(--mobile-spacing-md) + 34px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--mobile-spacing-lg)',
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
                maxWidth: '85%',
                background: isUser ? 'rgba(34,197,94,0.13)' : 'rgba(15,23,42,0.72)',
                border: `1px solid ${isUser ? 'rgba(34,197,94,0.24)' : 'rgba(148,163,184,0.16)'}`,
                borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)',
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
                {!isUser && message.content && message.id !== streamingMsgId && (
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

        {queuedMessages.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.14)',
              borderRadius: 10,
              padding: '6px 8px',
              marginBottom: 6,
              minWidth: 0,
            }}
          >
            <ListTodo size={14} style={{ flexShrink: 0, color: 'var(--mobile-text-muted, var(--text-secondary, #9ca3af))' }} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 'var(--mobile-text-xs)',
                color: 'var(--mobile-text-muted, var(--text-secondary, #9ca3af))',
              }}
            >
              Queued ({queuedMessages.length}): "{queuedMessages[0]}"
              {queuedMessages.length > 1 ? ` +${queuedMessages.length - 1} more` : ''}
            </span>
            <button
              onClick={steerQueuedInput}
              title="Stop the current response and send this message immediately"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(59,130,246,0.2)',
                border: '1px solid rgba(59,130,246,0.35)',
                borderRadius: 8,
                color: '#60a5fa',
                padding: 6,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <Zap size={14} />
            </button>
            <button
              onClick={cancelQueuedInput}
              title="Cancel queued messages"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(239,68,68,0.15)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 8,
                color: '#ef4444',
                padding: 6,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <X size={14} />
            </button>
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
              className="mobile-btn mobile-send-btn"
              onClick={stopStreaming}
              style={{ background: 'var(--brand-red)' }}
            >
              <X size={18} />
            </button>
          ) : (
            <button
              className="mobile-btn mobile-send-btn"
              onClick={handleSend}
              disabled={!input.trim()}
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
              style={threadSheetStyle}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mobile-sheet-handle" {...threadHandleProps} />
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
              style={apiSheetStyle}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mobile-sheet-handle" {...apiHandleProps} />
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
                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                      Max Output (chars)
                    </label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="mobile-input"
                        type="number"
                        min="512"
                        max="20000"
                        placeholder="Blank = use preset"
                        value={customMaxOutput}
                        onChange={(e) => {
                          setCustomMaxOutput(e.target.value);
                          localStorage.setItem('custom_max_output', e.target.value);
                        }}
                        style={{ flex: 1, minHeight: 40 }}
                      />
                      {customMaxOutput && (
                        <button
                          className="mobile-btn mobile-btn-sm mobile-btn-ghost"
                          onClick={() => {
                            setCustomMaxOutput('');
                            localStorage.removeItem('custom_max_output');
                          }}
                          title="Clear custom output"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', marginTop: 4 }}>
                      ~{Math.max(512, Math.min(20000, Math.round((Number(customMaxOutput) || 8192 * 4) / 4)))} tokens used
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
