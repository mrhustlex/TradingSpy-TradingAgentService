import React, { useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import { RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { INTELLIGENCE_SERVICE } from '../../config';
import { getApiSettings } from '../../utils/apiKeyHelper';

const MODES = [
  ['calculation', 'Calc'],
  ['llm', 'LLM'],
  ['hybrid', 'Hybrid'],
];

const INTERVALS = [
  ['15m', '15m'],
  ['30m', '30m'],
  ['60m', '1H'],
  ['1d', '1D'],
  ['1wk', '1W'],
];

const HORIZONS = [10, 20, 40, 60];

const formatPct = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};

const PatternChartSvg = ({ pattern }) => {
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

  const W = 300;
  const H = 150;
  const PL = 6;
  const PR = 6;
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-secondary)', marginTop: 2 }}>
        <span>History</span>
        <span>Forecast (80% band)</span>
      </div>
    </div>
  );
};

const MobileExpectedPatternCard = ({ data, notify }) => {
  const [pattern, setPattern] = useState(data);
  const [mode, setMode] = useState(data?.scenario_mode || 'calculation');
  const [interval, setInterval] = useState(data?.interval || '1d');
  const [horizon, setHorizon] = useState(data?.horizon || 20);
  const [recalculating, setRecalculating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setPattern(data);
    setMode(data?.scenario_mode || 'calculation');
    setInterval(data?.interval || '1d');
    setHorizon(data?.horizon || 20);
  }, [data]);

  const recalculate = useCallback(async (overrides = {}) => {
    if (!pattern?.symbol) return;
    const nextMode = overrides.mode || mode;
    const nextInterval = overrides.interval || interval;
    const nextHorizon = overrides.horizon || horizon;
    setRecalculating(true);
    setError('');
    try {
      const api = getApiSettings();
      const res = await axios.post(
        `${INTELLIGENCE_SERVICE}/expected-pattern/${encodeURIComponent(pattern.symbol)}/scenario`,
        {
          mode: nextMode,
          interval: nextInterval,
          horizon: nextHorizon,
          lookback: pattern.lookback_used || 180,
          provider: api.provider,
          model: api.model,
          api_key: api.api_key,
          provider_config: api.provider_config,
          include_analysis: true,
        },
        { timeout: nextMode === 'calculation' ? 30000 : 180000 }
      );
      setPattern(res.data);
      setMode(res.data?.scenario_mode || nextMode);
      setInterval(res.data?.interval || nextInterval);
      setHorizon(res.data?.horizon || nextHorizon);
    } catch (e) {
      const msg = e?.response?.data?.detail?.message || e?.response?.data?.detail || 'Failed to recalculate';
      setError(typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200));
      notify && notify('Expected pattern recalculation failed', 'red');
    } finally {
      setRecalculating(false);
    }
  }, [pattern, mode, interval, horizon, notify]);

  if (!pattern) return null;

  const direction = pattern.direction;
  const dirColor = direction === 'upward' ? 'var(--brand-green)' : direction === 'downward' ? 'var(--brand-red)' : 'var(--text-secondary)';
  const DirectionIcon = direction === 'upward' ? TrendingUp : direction === 'downward' ? TrendingDown : Minus;

  const metric = (label, value, color) => (
    <div style={{ flex: 1, minWidth: 90 }}>
      <div style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: color || 'var(--text-main)' }}>{value}</div>
    </div>
  );

  return (
    <div className="mobile-card" style={{ margin: '8px 0 0', padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--mobile-text-xs)' }}>{pattern.symbol} · Expected Pattern</strong>
        <span style={{ fontSize: 10, fontWeight: 700, color: dirColor, display: 'flex', alignItems: 'center', gap: 3 }}>
          <DirectionIcon size={12} /> {pattern.direction || 'neutral'}
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, color: dirColor }}>
          {formatPct(pattern.expected_end_return_pct)}
        </span>
      </div>

      <PatternChartSvg pattern={pattern} />

      {error && (
        <div style={{ fontSize: 10, color: 'var(--brand-red)', marginTop: 6 }}>{error}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {MODES.map(([value, label]) => (
          <button
            key={value}
            className={`mobile-pill ${mode === value ? 'active' : ''}`}
            style={{ fontSize: 9, padding: '2px 8px' }}
            onClick={() => {
              if (value === mode) return;
              setMode(value);
              recalculate({ mode: value });
            }}
          >
            {label}
          </button>
        ))}
        <span style={{ width: 6 }} />
        {INTERVALS.map(([value, label]) => (
          <button
            key={value}
            className={`mobile-pill ${interval === value ? 'active' : ''}`}
            style={{ fontSize: 9, padding: '2px 8px' }}
            onClick={() => {
              if (value === interval) return;
              setInterval(value);
              recalculate({ interval: value });
            }}
          >
            {label}
          </button>
        ))}
        <span style={{ width: 6 }} />
        {HORIZONS.map(h => (
          <button
            key={h}
            className={`mobile-pill ${horizon === h ? 'active' : ''}`}
            style={{ fontSize: 9, padding: '2px 8px' }}
            onClick={() => {
              if (h === horizon) return;
              setHorizon(h);
              recalculate({ horizon: h });
            }}
          >
            {h}
          </button>
        ))}
        <button
          className="mobile-pill"
          style={{ fontSize: 9, padding: '2px 8px', marginLeft: 'auto' }}
          onClick={recalculate}
          disabled={recalculating}
        >
          {recalculating ? <RefreshCw size={10} className="mobile-spinner" /> : <RefreshCw size={10} />} Recalc
        </button>
      </div>

      {pattern.scenario_label && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--brand-purple)', background: 'rgba(139,92,246,0.15)', padding: '2px 8px', borderRadius: 8 }}>
            {pattern.scenario_label}
          </span>
          {pattern.interval && (
            <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: 8 }}>
              {pattern.interval} · {pattern.horizon} bars
            </span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        {metric('RSI', pattern.inputs?.rsi14 != null ? pattern.inputs.rsi14.toFixed(1) : '-')}
        {metric('SMA20', pattern.inputs?.sma20 != null ? '$' + pattern.inputs.sma20.toFixed(2) : '-')}
        {metric('Volatility', pattern.inputs?.per_bar_volatility_pct != null ? pattern.inputs.per_bar_volatility_pct.toFixed(2) + '%' : '-')}
        {metric('Latest Close', pattern.inputs?.latest_close != null ? '$' + pattern.inputs.latest_close.toFixed(2) : '-')}
      </div>

      {pattern.llm_rationale && (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--text-main)' }}>Why:</strong> {pattern.llm_rationale}
        </div>
      )}
    </div>
  );
};

export default MobileExpectedPatternCard;
