import React from 'react';
import { RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';

/**
 * Unified animated progress indicator for tasks across the application.
 * Used in: Backtest, Strategy Generation, Data Download, Optimization, etc.
 * 
 * Props:
 *   - label: Task label or title (e.g., "🧪 Backtest: TQQQ")
 *   - detail: Current task detail (e.g., "Processing strategy 1 of 5")
 *   - progress: Number 0-100, or null for indeterminate
 *   - status: 'running' | 'completed' | 'failed' | 'paused' (optional, for styling)
 *   - size: 'small' | 'medium' | 'large' (default: 'medium')
 *   - variant: 'inline' | 'card' | 'minimal' (default: 'card')
 */
const AnimatedProgressIndicator = ({
  label = "Processing...",
  detail = "",
  progress = null,
  status = "running",
  size = "medium",
  variant = "card",
  showSpinner = true,
  animated = true
}) => {
  // Size configurations
  const sizeConfig = {
    small: { padding: '0.5rem 0.75rem', height: '6px', fontSize: '0.8rem' },
    medium: { padding: '0.75rem 1rem', height: '8px', fontSize: '0.9rem' },
    large: { padding: '1rem 1.25rem', height: '10px', fontSize: '1rem' },
  };

  const config = sizeConfig[size] || sizeConfig.medium;

  // Status colors
  const statusColors = {
    running: 'rgba(59,130,246,0.2)',
    completed: 'rgba(34,197,94,0.2)',
    failed: 'rgba(239,68,68,0.2)',
    paused: 'rgba(234,179,8,0.2)',
  };

  const borderColors = {
    running: 'rgba(59,130,246,0.35)',
    completed: 'rgba(34,197,94,0.35)',
    failed: 'rgba(239,68,68,0.35)',
    paused: 'rgba(234,179,8,0.35)',
  };

  const progressColors = {
    running: 'var(--brand-blue)',
    completed: '#22c55e',
    failed: '#ef4444',
    paused: 'var(--brand-yellow)',
  };

  // Render inline variant (minimal, horizontal)
  if (variant === 'inline') {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: config.padding,
        fontSize: config.fontSize,
      }}>
        {showSpinner && (
          <RefreshCw
            className={animated ? "animate-spin" : ""}
            size={size === 'small' ? 12 : size === 'large' ? 18 : 14}
            style={{ flexShrink: 0, opacity: status === 'paused' ? 0.5 : 1 }}
          />
        )}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
            <span style={{ fontWeight: 600 }}>{label}</span>
            {progress !== null && (
              <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>{Math.round(progress)}%</span>
            )}
          </div>
          {detail && (
            <div style={{ fontSize: '0.75rem', opacity: 0.6, fontStyle: 'italic' }}>{detail}</div>
          )}
        </div>
      </div>
    );
  }

  // Render minimal variant (just progress bar)
  if (variant === 'minimal') {
    return (
      <div style={{ width: '100%' }}>
        <div style={{
          height: config.height,
          background: 'rgba(255,255,255,0.08)',
          borderRadius: '4px',
          overflow: 'hidden',
          position: 'relative',
        }}>
          {progress !== null ? (
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(progress, 100)}%` }}
              transition={{ type: 'tween', duration: 0.5, ease: 'easeOut' }}
              style={{
                height: '100%',
                background: progressColors[status],
                borderRadius: '4px',
                boxShadow: `0 0 10px ${progressColors[status]}`,
              }}
            />
          ) : (
            <motion.div
              animate={{ x: ['-100%', '100%'] }}
              transition={{ repeat: Infinity, duration: 1.4, ease: 'easeInOut' }}
              style={{
                height: '100%',
                width: '40%',
                background: progressColors[status],
                borderRadius: '4px',
                boxShadow: `0 0 10px ${progressColors[status]}`,
              }}
            />
          )}
        </div>
      </div>
    );
  }

  // Render card variant (default, full featured)
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: statusColors[status],
        border: `1px solid ${borderColors[status]}`,
        borderRadius: '10px',
        padding: config.padding,
      }}
    >
      {/* Header: Label + Spinner + Progress % */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.35rem' }}>
        {showSpinner && (
          <RefreshCw
            className={animated ? "animate-spin" : ""}
            size={size === 'small' ? 12 : size === 'large' ? 16 : 13}
            style={{
              color: progressColors[status],
              flexShrink: 0,
              opacity: status === 'paused' ? 0.5 : 1,
            }}
          />
        )}
        <span style={{
          fontSize: config.fontSize,
          fontWeight: 600,
          color: progressColors[status],
          flex: 1,
        }}>
          {label}
        </span>
        {progress !== null && (
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            {Math.round(progress)}%
          </span>
        )}
      </div>

      {/* Detail text */}
      {detail && (
        <div style={{
          fontSize: '0.75rem',
          opacity: 0.55,
          paddingLeft: showSpinner ? '1.6rem' : '0',
          fontStyle: 'italic',
          marginBottom: '0.4rem',
        }}>
          {detail}
        </div>
      )}

      {/* Progress bar */}
      <div style={{
        height: config.height,
        background: 'rgba(255,255,255,0.08)',
        borderRadius: '4px',
        overflow: 'hidden',
        position: 'relative',
      }}>
        {progress !== null ? (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(progress, 100)}%` }}
            transition={{ type: 'tween', duration: 0.5, ease: 'easeOut' }}
            style={{
              height: '100%',
              background: progressColors[status],
              borderRadius: '4px',
              boxShadow: `0 0 10px ${progressColors[status]}`,
            }}
          />
        ) : (
          <motion.div
            animate={{ x: ['-100%', '100%'] }}
            transition={{ repeat: Infinity, duration: 1.4, ease: 'easeInOut' }}
            style={{
              height: '100%',
              width: '40%',
              background: progressColors[status],
              borderRadius: '4px',
              boxShadow: `0 0 10px ${progressColors[status]}`,
            }}
          />
        )}
      </div>
    </motion.div>
  );
};

export default AnimatedProgressIndicator;
