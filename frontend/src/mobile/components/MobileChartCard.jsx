import React, { useState } from 'react';

const formatPct = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};

const MobileChartCard = ({ chart }) => {
  const [hoverIndex, setHoverIndex] = useState(null);
  const data = (chart?.data || []).slice(-120);
  if (!data.length) {
    return (
      <div className="mobile-card" style={{ margin: '8px 0 0', padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)' }}>
        <strong style={{ fontSize: 'var(--mobile-text-xs)' }}>{chart.symbol || 'Chart'}</strong>
        <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
          {chart.error || 'No chart data available'}
        </div>
      </div>
    );
  }

  const closes = data.map(row => Number(row.close));
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = Math.max(max - min, Math.abs(max || 1) * 0.01);
  const yMin = min - range * 0.08;
  const yMax = max + range * 0.08;

  const W = 300;
  const H = 130;
  const PL = 6;
  const PR = 6;
  const PT = 10;
  const PB = 6;
  const x = i => PL + (i / Math.max(1, data.length - 1)) * (W - PL - PR);
  const y = v => PT + ((yMax - v) / (yMax - yMin)) * (H - PT - PB);

  const linePath = data.map((row, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(Number(row.close))}`).join(' ');

  const last = data[data.length - 1];
  const first = data[0];
  const changePct = first?.close ? ((last.close - first.close) / first.close) * 100 : null;
  const positive = changePct >= 0;

  const hovered = hoverIndex == null ? null : data[hoverIndex];

  const handleHover = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const viewX = ((e.clientX - rect.left) / rect.width) * W;
    const ratio = (viewX - PL) / (W - PL - PR);
    setHoverIndex(Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1)))));
  };

  return (
    <div className="mobile-card" style={{ margin: '8px 0 0', padding: 'var(--mobile-spacing-sm) var(--mobile-spacing-md)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--mobile-text-xs)' }}>{chart.symbol || 'Chart'}</strong>
        <span style={{ fontSize: 11, fontWeight: 700 }}>${Number(last.close).toFixed(2)}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: positive ? 'var(--brand-green)' : 'var(--brand-red)' }}>
          {formatPct(changePct)}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>
          {chart.period || ''}{chart.interval ? ` · ${chart.interval}` : ''} · {data.length} bars
        </span>
      </div>

      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: 'auto', display: 'block', cursor: 'crosshair' }}
          onMouseMove={handleHover}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <path d={linePath} fill="none" stroke="#60a5fa" strokeWidth={1.5} />
          {hoverIndex != null && (
            <line x1={x(hoverIndex)} y1={y(yMin)} x2={x(hoverIndex)} y2={y(yMax)} stroke="rgba(255,255,255,0.5)" strokeDasharray="3 3" strokeWidth={1} />
          )}
          <circle
            cx={x(data.length - 1)}
            cy={y(Number(last.close))}
            r={2.5}
            fill={positive ? 'var(--brand-green)' : 'var(--brand-red)'}
          />
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
            {String(hovered.date || '').slice(0, 10)} · <strong>${Number(hovered.close).toFixed(2)}</strong>
            {hovered.volume != null ? <> · vol {Number(hovered.volume) >= 1e6 ? (hovered.volume / 1e6).toFixed(1) + 'M' : (hovered.volume / 1e3).toFixed(0) + 'K'}</> : null}
          </div>
        )}
      </div>
    </div>
  );
};

export default MobileChartCard;
