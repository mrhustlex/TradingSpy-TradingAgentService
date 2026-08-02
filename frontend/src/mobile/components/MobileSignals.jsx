import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Activity, TrendingUp, TrendingDown, RefreshCw, X, BrainCircuit, Users } from 'lucide-react';
import { INTELLIGENCE_SERVICE } from '../../config';
import { getApiSettings } from '../../utils/apiKeyHelper';

const PATTERN_MODES = [
  ['calculation', 'Calculation'],
  ['llm', 'LLM'],
  ['hybrid', 'Hybrid'],
];

const SIGNAL_INTERVALS = [
  ['1m', '1m'],
  ['5m', '5m'],
  ['15m', '15m'],
  ['30m', '30m'],
  ['60m', '1H'],
  ['90m', '90m'],
  ['1d', '1D'],
  ['1wk', '1W'],
];

const periodForInterval = (interval) => ({
  '1m': '5d', '2m': '1mo', '5m': '1mo', '15m': '1mo', '30m': '1mo',
  '60m': '1mo', '90m': '1mo', '1d': '3mo', '1wk': '6mo', '1mo': '1y',
}[interval] || '3mo');

const SignalMeter = ({ label, value, max = 5, suffix = '', color = '#60a5fa' }) => {
  const numeric = Number(value);
  const pct = Number.isFinite(numeric) ? Math.min(100, Math.abs(numeric) / max * 100) : 0;
  return (
    <div style={{ fontSize: 'var(--mobile-text-xs)', flex: 1, minWidth: 100 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
        <strong>{Number.isFinite(numeric) ? `${numeric}${suffix}` : '-'}</strong>
      </div>
      <div style={{ height: 5, background: 'rgba(255,255,255,0.08)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 999 }} />
      </div>
    </div>
  );
};

const MetricRow = ({ label, value }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--mobile-text-xs)', padding: '2px 0' }}>
    <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
    <strong>{value}</strong>
  </div>
);

const SignalBadge = ({ label }) => {
  const text = String(label || '');
  const color = text.includes('Weak') ? 'var(--brand-red)'
    : text.includes('momentum') || text.includes('Strong') ? 'var(--brand-green)'
    : text.includes('Abnormal') ? 'var(--brand-yellow)' : 'var(--brand-blue)';
  const bg = color === 'var(--brand-blue)' ? 'rgba(96,165,250,0.15)'
    : color === 'var(--brand-red)' ? 'rgba(239,68,68,0.15)'
    : color === 'var(--brand-green)' ? 'rgba(16,185,129,0.15)' : 'rgba(234,179,8,0.15)';
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color, background: bg, padding: '2px 8px', borderRadius: 8 }}>
      {text || 'No signal'}
    </span>
  );
};

const PatternChart = ({ pattern }) => {
  const [hoverIndex, setHoverIndex] = useState(null);
  const history = (pattern?.history || []).slice(-40);
  const forecast = pattern?.forecast || [];
  if (!history.length && !forecast.length) return null;

  const values = [
    ...history.map(row => Number(row.close)),
    ...forecast.flatMap(row => [Number(row.lower_80), Number(row.upper_80), Number(row.expected_close)]),
  ].filter(Number.isFinite);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const range = Math.max(max - min, Math.abs(max || 1) * 0.01);
  const yMin = min - range * 0.08;
  const yMax = max + range * 0.08;

  const W = 340;
  const H = 160;
  const PL = 8;
  const PR = 8;
  const PT = 10;
  const PB = 6;
  const total = history.length + forecast.length;
  const anchorIndex = Math.max(0, history.length - 1);
  const anchor = Number(history[anchorIndex]?.close || pattern?.inputs?.latest_close || 0);
  const x = i => PL + (i / Math.max(1, total - 1)) * (W - PL - PR);
  const y = v => PT + ((yMax - v) / (yMax - yMin)) * (H - PT - PB);

  const historyPath = history.map((row, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(Number(row.close))}`).join(' ');
  const forecastPath = [{ expected_close: anchor }, ...forecast]
    .map((row, i) => `${i ? 'L' : 'M'} ${x(anchorIndex + i)} ${y(Number(row.expected_close))}`).join(' ');
  const band = forecast.length ? [
    `${x(anchorIndex)},${y(anchor)}`,
    ...forecast.map((row, i) => `${x(history.length + i)},${y(Number(row.upper_80))}`),
    ...[...forecast].reverse().map((row, ri) => `${x(history.length + forecast.length - 1 - ri)},${y(Number(row.lower_80))}`),
  ].join(' ') : '';

  const hovered = hoverIndex == null ? null : hoverIndex < history.length
    ? { type: 'actual', time: history[hoverIndex]?.time, price: Number(history[hoverIndex]?.close) }
    : (() => {
        const row = forecast[hoverIndex - history.length];
        return row ? { type: 'forecast', time: row.time, price: Number(row.expected_close), lower: Number(row.lower_80), upper: Number(row.upper_80) } : null;
      })();

  const handleHover = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || total < 1) return;
    const viewX = ((e.clientX - rect.left) / rect.width) * W;
    const ratio = (viewX - PL) / (W - PL - PR);
    setHoverIndex(Math.max(0, Math.min(total - 1, Math.round(ratio * (total - 1)))));
  };

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleHover}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {band && <polygon points={band} fill="rgba(96,165,250,0.18)" stroke="none" />}
        {historyPath && <path d={historyPath} fill="none" stroke="#94a3b8" strokeWidth={1.5} />}
        {forecastPath && <path d={forecastPath} fill="none" stroke="#60a5fa" strokeWidth={2} />}
        <line x1={x(anchorIndex)} y1={y(yMin)} x2={x(anchorIndex)} y2={y(yMax)} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" strokeWidth={1} />
        {hoverIndex != null && (
          <line x1={x(hoverIndex)} y1={y(yMin)} x2={x(hoverIndex)} y2={y(yMax)} stroke="rgba(255,255,255,0.5)" strokeDasharray="3 3" strokeWidth={1} />
        )}
      </svg>
      {hovered && (
        <div style={{
          position: 'absolute',
          top: 4,
          left: 4,
          fontSize: 9,
          lineHeight: 1.35,
          color: 'var(--text-secondary)',
          background: 'rgba(0,0,0,0.75)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 5,
          padding: '3px 6px',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          {hovered.type === 'actual'
            ? <>Actual · {String(hovered.time || '').slice(0, 10)} · <strong>${hovered.price.toFixed(2)}</strong></>
            : <>Forecast · {String(hovered.time || '').slice(0, 10)} · <strong>${hovered.price.toFixed(2)}</strong>
              {hovered.lower != null && hovered.upper != null ? <> · <span style={{ opacity: 0.7 }}>${hovered.lower.toFixed(2)}–${hovered.upper.toFixed(2)}</span></> : null}</>}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
        <span>History</span>
        <span>Forecast (80% band)</span>
      </div>
    </div>
  );
};

const MobileSignals = ({ ticker, onClose }) => {
  const [signal, setSignal] = useState(null);
  const [signalError, setSignalError] = useState('');
  const [allSignals, setAllSignals] = useState([]);
  const [signalLoading, setSignalLoading] = useState(false);
  const [pattern, setPattern] = useState(null);
  const [patternLoading, setPatternLoading] = useState(false);
  const [patternError, setPatternError] = useState('');
  const [mode, setMode] = useState('calculation');
  const [interval, setInterval] = useState('1d');
  const [includeAnalysis, setIncludeAnalysis] = useState(true);
  const [includePeers, setIncludePeers] = useState(false);
  const [peers, setPeers] = useState([]);
  const [peersSource, setPeersSource] = useState('');

  const symbol = String(ticker || '').trim().toUpperCase();

  const loadPattern = useCallback(async (target) => {
    if (!target) return;
    setPatternLoading(true);
    setPatternError('');
    setPattern(null);
    try {
      const api = getApiSettings();
      const res = await axios.post(`${INTELLIGENCE_SERVICE}/expected-pattern/${encodeURIComponent(target)}/scenario`, {
        mode,
        interval,
        horizon: 20,
        lookback: 180,
        extended_hours: false,
        provider: api.provider,
        model: api.model,
        api_key: api.api_key,
        provider_config: api.provider_config,
        include_analysis: includeAnalysis,
      }, {
        timeout: mode === 'calculation' ? 30000 : 180000,
      });
      if (res.data.error) {
        setPatternError(res.data.error);
        setPattern(null);
      } else {
        setPattern(res.data);
      }
    } catch (e) {
      setPatternError('Prediction unavailable');
      setPattern(null);
    } finally {
      setPatternLoading(false);
    }
  }, [mode, interval, includeAnalysis]);

  const loadSignals = useCallback(async (targets) => {
    setSignalLoading(true);
    setSignal(null);
    setSignalError('');
    setAllSignals([]);
    try {
      const res = await axios.post(`${INTELLIGENCE_SERVICE}/trading-signal`, {
        tickers: targets,
        period: periodForInterval(interval),
        interval,
      }, { timeout: 20000 });
      const list = res.data.signals || [];
      setAllSignals(list);
      const mine = list.find(x => String(x.ticker).toUpperCase() === symbol);
      if (mine && !mine.error) {
        setSignal(mine);
      } else {
        setSignal(null);
        const reason = mine?.error || (list.find(x => x.error)?.error) || 'No signal data';
        setSignalError(reason);
      }
    } catch (e) {
      setSignal(null);
      setSignalError('Signal service unreachable');
    } finally {
      setSignalLoading(false);
    }
  }, [interval, symbol]);

  const fetchAll = useCallback(async () => {
    if (!symbol) return;
    let targets = [symbol];
    let resolvedPeers = [];
    let peerSource = 'disabled';
    if (includePeers) {
      setPeersSource('resolving peers...');
      try {
        const res = await axios.get(`${INTELLIGENCE_SERVICE}/peers/${encodeURIComponent(symbol)}?limit=5`, { timeout: 10000 });
        resolvedPeers = (res.data?.peers || []).filter(Boolean).slice(0, 5);
        peerSource = res.data?.source || (resolvedPeers.length ? 'peer resolver' : 'none');
      } catch (e) {
        peerSource = 'peer lookup failed';
      }
      targets = [...new Set([symbol, ...resolvedPeers])].slice(0, 6);
    }
    setPeers(resolvedPeers);
    setPeersSource(peerSource);
    loadSignals(targets);
    loadPattern(symbol);
  }, [symbol, includePeers, loadSignals, loadPattern]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (symbol) loadPattern(symbol);
  }, [mode, includeAnalysis, symbol, loadPattern]);

  const endReturn = Number(pattern?.expected_end_return_pct || 0);
  const peerRows = allSignals.filter(s => s.ticker !== symbol && !s.error);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Header with controls */}
      <div className="mobile-card" style={{ margin: 0, padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <BrainCircuit size={14} color="var(--brand-purple)" />
          <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)' }}>Prediction mode</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {PATTERN_MODES.map(([value, label]) => (
              <button
                key={value}
                className={`mobile-pill ${mode === value ? 'active' : ''}`}
                style={{ fontSize: 'var(--mobile-text-xs)', padding: '2px 10px' }}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Activity size={11} color="var(--text-secondary)" />
            <span style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)' }}>Interval</span>
            {SIGNAL_INTERVALS.map(([value, label]) => (
              <button
                key={value}
                className={`mobile-pill ${interval === value ? 'active' : ''}`}
                style={{ fontSize: 'var(--mobile-text-xs)', padding: '2px 8px' }}
                onClick={() => setInterval(value)}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includePeers}
              onChange={e => setIncludePeers(e.target.checked)}
              style={{ cursor: 'pointer', width: 14, height: 14 }}
            />
            <Users size={12} /> Peers
          </label>
          {mode !== 'calculation' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeAnalysis}
                onChange={e => setIncludeAnalysis(e.target.checked)}
                style={{ cursor: 'pointer', width: 14, height: 14 }}
              />
              AI reasoning summary
            </label>
          )}
          <button className="mobile-pill" style={{ fontSize: 'var(--mobile-text-xs)', padding: '2px 10px', marginLeft: 'auto' }} onClick={fetchAll}>
            <RefreshCw size={10} /> Refresh
          </button>
          {onClose && (
            <button className="mobile-header-btn" style={{ width: 28, height: 28 }} onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Peers info line */}
      {includePeers && (
        <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)' }}>
          {peersSource === 'resolving peers...' ? (
            <span>Resolving peers...</span>
          ) : peers.length > 0 ? (
            <span>Peers for <strong>{symbol}</strong>: {peers.join(', ')} <span style={{ opacity: 0.6 }}>({peersSource})</span></span>
          ) : (
            <span>Peer resolver: {peersSource || 'no comparable names found'}</span>
          )}
        </div>
      )}

      {/* Trading Signal */}
      {signalLoading && (
        <div className="mobile-loading">
          <div className="mobile-spinner" />
          <span>Calculating {interval} signals...</span>
        </div>
      )}
      {!signalLoading && !signal && (
        <div className="mobile-loading" style={{ opacity: 0.6 }}>
          <span style={{ textAlign: 'center' }}>{signalError || 'No signal data'}</span>
        </div>
      )}
      {!signalLoading && signal && (
        <div className="mobile-card" style={{ margin: 0, padding: 'var(--mobile-spacing-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <Activity size={14} color="var(--brand-blue)" />
            <strong style={{ fontSize: 'var(--mobile-text-sm)' }}>{signal.ticker} Signal</strong>
            <span style={{ marginLeft: 'auto' }}>
              <SignalBadge label={signal.label} />
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <SignalMeter label="Move" value={signal.current_move_pct} max={6} suffix="%" color={(signal.current_move_pct ?? 0) >= 0 ? 'var(--brand-green)' : 'var(--brand-red)'} />
            <SignalMeter label="Candle range" value={signal.current_range_pct} max={8} suffix="%" color="var(--brand-purple)" />
            <SignalMeter label="Volume ratio" value={signal.volume_ratio} max={3} suffix="x" color="var(--brand-blue)" />
            <SignalMeter label="Close location" value={signal.close_location_pct} max={100} suffix="%" color={(signal.close_location_pct ?? 50) >= 50 ? 'var(--brand-green)' : 'var(--brand-red)'} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 16px', marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
            <MetricRow label="Avg candle" value={signal.avg_range_pct != null ? `${signal.avg_range_pct}%` : '-'} />
            <MetricRow label="Move score" value={signal.move_score ?? '-'} />
            <MetricRow label="Avg up" value={signal.avg_up_pct != null ? `${signal.avg_up_pct}%` : '-'} />
            <MetricRow label="Avg down" value={signal.avg_down_pct != null ? `${signal.avg_down_pct}%` : '-'} />
            <MetricRow label="Max up" value={signal.max_up_pct != null ? `${signal.max_up_pct}%` : '-'} />
            <MetricRow label="Max down" value={signal.max_down_pct != null ? `${signal.max_down_pct}%` : '-'} />
            <MetricRow label="Max move" value={signal.max_move_pct != null ? `${signal.max_move_pct}%` : '-'} />
            <MetricRow label="Up / Down" value={signal.up_times != null || signal.down_times != null ? `${signal.up_times ?? 0}↑ / ${signal.down_times ?? 0}↓` : '-'} />
          </div>
        </div>
      )}

      {/* Peer move rows */}
      {peerRows.length > 0 && (
        <div className="mobile-card" style={{ margin: 0, padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)' }}>
          <div style={{ fontSize: 'var(--mobile-text-xs)', fontWeight: 600, marginBottom: 4, color: 'var(--text-secondary)' }}>
            Comparable peers
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {peerRows.map(p => (
              <div key={p.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--mobile-text-xs)', padding: '2px 0' }}>
                <span style={{ fontWeight: 700, width: 60 }}>{p.ticker}</span>
                <span style={{ color: (p.current_move_pct ?? 0) >= 0 ? 'var(--brand-green)' : 'var(--brand-red)', fontWeight: 600, width: 70, textAlign: 'right' }}>
                  {(p.current_move_pct ?? 0) >= 0 ? '+' : ''}{p.current_move_pct ?? '-'}%
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  <SignalBadge label={p.label} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expected Pattern */}
      {patternLoading && (
        <div className="mobile-loading">
          <div className="mobile-spinner" />
          <span>Calculating {interval} prediction...</span>
        </div>
      )}
      {!patternLoading && patternError && !pattern && (
        <div className="mobile-loading" style={{ opacity: 0.5 }}>
          <span>{patternError}</span>
        </div>
      )}
      {!patternLoading && pattern && (
        <div className="mobile-card" style={{ margin: 0, padding: 'var(--mobile-spacing-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            <TrendingUp size={14} color="var(--brand-blue)" />
            <strong style={{ fontSize: 'var(--mobile-text-sm)' }}>Trend Prediction</strong>
            <span style={{ fontSize: 10, fontWeight: 700, color: endReturn >= 0 ? 'var(--brand-green)' : 'var(--brand-red)', background: endReturn >= 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)', padding: '2px 8px', borderRadius: 8 }}>
              {pattern.direction} {endReturn >= 0 ? '+' : ''}{endReturn.toFixed(2)}%
            </span>
            {pattern.scenario_label && (
              <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--brand-purple)', background: 'rgba(139,92,246,0.15)', padding: '2px 8px', borderRadius: 8 }}>
                {pattern.scenario_label}{pattern.llm_model ? ` · ${pattern.llm_model}` : ''}
              </span>
            )}
            {pattern.interval && (
              <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: 8 }}>
                {pattern.interval} · {pattern.horizon} bars
              </span>
            )}
          </div>
          <PatternChart pattern={pattern} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '2px 12px', marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
            <MetricRow label="Latest" value={pattern.inputs?.latest_close != null ? `$${Number(pattern.inputs.latest_close).toFixed(2)}` : '-'} />
            <MetricRow label="RSI" value={pattern.inputs?.rsi14 ?? '-'} />
            <MetricRow label="Volatility" value={pattern.inputs?.per_bar_volatility_pct != null ? `${pattern.inputs.per_bar_volatility_pct}%` : '-'} />
            <MetricRow label="Volume ratio" value={pattern.inputs?.recent_volume_ratio ?? '-'} />
            <MetricRow label="Bars used" value={pattern.inputs?.bars ?? '-'} />
            <MetricRow label="Horizon" value={pattern.horizon ?? '-'} />
          </div>
          {pattern.llm_rationale && (
            <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, background: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.16)', fontSize: 'var(--mobile-text-xs)', lineHeight: 1.45 }}>
              {pattern.llm_regime && <><strong>Regime:</strong> {pattern.llm_regime}. </>}
              <strong>AI scenario:</strong> {pattern.llm_rationale}
              {pattern.llm_invalidation ? ` Invalidation: ${pattern.llm_invalidation}` : ''}
            </div>
          )}
          {pattern.explanation && !pattern.llm_rationale && (
            <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.16)', fontSize: 'var(--mobile-text-xs)', lineHeight: 1.45 }}>
              <strong>How this forecast works:</strong> {pattern.explanation}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MobileSignals;
