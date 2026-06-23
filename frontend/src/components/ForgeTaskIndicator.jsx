import React, { useState, useEffect, useRef } from 'react';
import { Cpu, FileSearch, RefreshCw, CheckCircle } from 'lucide-react';

const STAGES = [
  { key: 'consulting', label: 'Consulting AI Experts...', icon: Cpu, progress: 10 },
  { key: 'analyzing', label: 'Analyzing Market Patterns...', icon: FileSearch, progress: 30 },
  { key: 'generating', label: 'Generating Strategy Code...', icon: RefreshCw, progress: 55 },
  { key: 'validating', label: 'Validating & Saving Strategies...', icon: CheckCircle, progress: 80 },
  { key: 'done', label: 'Complete!', icon: CheckCircle, progress: 100 },
];

function getStage(current) {
  if (!current || typeof current !== 'string') return STAGES[0];
  const lower = current.toLowerCase();
  if (lower.includes('pattern') || lower.includes('analyz')) return STAGES[1];
  if (lower.includes('generat') || lower.includes('token')) return STAGES[2];
  if (lower.includes('valid') || lower.includes('sav')) return STAGES[3];
  if (lower.includes('complete') || lower.includes('done')) return STAGES[4];
  return STAGES[0];
}

function useElapsed(startTime) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startTime) return;
    const interval = setInterval(() => setElapsed(Date.now() - startTime), 200);
    return () => clearInterval(interval);
  }, [startTime]);
  return elapsed;
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

const Spinner = ({ size = 32 }) => (
  <div style={{
    width: size, height: size,
    borderRadius: '50%',
    border: '3px solid rgba(59,130,246,0.15)',
    borderTopColor: '#3b82f6',
    animation: 'forge-spin 0.8s linear infinite',
    flexShrink: 0,
  }} />
);

const ForgeTaskIndicator = ({ tasks, activeTaskId, progressData: progressOverride = null }) => {
  const task = tasks.find(t => t.id === activeTaskId);
  const [startTime] = useState(() => Date.now());
  const elapsed = useElapsed(startTime);
  const previewRef = useRef(null);
  const [showElapsed, setShowElapsed] = useState(false);

  // Auto-scroll streaming preview
  useEffect(() => {
    if (previewRef.current) {
      previewRef.current.scrollTop = previewRef.current.scrollHeight;
    }
  }, [task?.progressData?.stream_preview]);

  // Show elapsed time after 3 seconds (don't crowd the UI initially)
  useEffect(() => {
    if (!task) return;
    const t = setTimeout(() => setShowElapsed(true), 3000);
    return () => clearTimeout(t);
  }, [task]);

  // Fallback: manually inject CSS keyframes once
  useEffect(() => {
    if (document.getElementById('forge-spinner-style')) return;
    const style = document.createElement('style');
    style.id = 'forge-spinner-style';
    style.textContent = `@keyframes forge-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
    return () => { const s = document.getElementById('forge-spinner-style'); if (s) s.remove(); };
  }, []);

  if (!task) return null;

  const progressData = progressOverride || task?.progressData || {};
  const progress = progressData.progress != null ? progressData.progress : 0;
  const stage = getStage(progressData.current);
  const StageIcon = stage.icon;
  const isStreaming = progressData.stream_preview && progressData.stream_preview.length > 0;

  return (
    <div style={{
      marginTop: '1rem',
      padding: '1.25rem',
      background: 'rgba(59,130,246,0.06)',
      border: '1px solid rgba(59,130,246,0.2)',
      borderRadius: '12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Spinner size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--brand-blue)' }}>
            {progressData.current || stage.label}
          </div>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '4px', alignItems: 'center' }}>
            <span style={{ fontSize: '0.78rem', opacity: 0.5 }}>{Math.round(progress)}%</span>
            {showElapsed && (
              <span style={{ fontSize: '0.78rem', opacity: 0.45 }}>⏱ {formatTime(elapsed)}</span>
            )}
            {progressData.current?.toLowerCase().includes('token') && (
              <span style={{ fontSize: '0.7rem', opacity: 0.4, fontStyle: 'italic' }}>receiving AI response...</span>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        marginTop: '0.75rem',
        height: '6px',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: '4px',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${Math.min(progress, 100)}%`,
          height: '100%',
          background: 'linear-gradient(90deg, #2563eb, #60a5fa)',
          borderRadius: '4px',
          transition: 'width 0.5s ease',
        }} />
      </div>

      {/* Streaming preview */}
      {isStreaming && (
        <div style={{
          marginTop: '0.75rem',
          background: 'rgba(0,0,0,0.25)',
          borderRadius: '8px',
          border: '1px solid rgba(59,130,246,0.12)',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '0.35rem 0.65rem',
            fontSize: '0.6rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--brand-blue)',
            opacity: 0.5,
            borderBottom: '1px solid rgba(255,255,255,0.04)',
          }}>
            Live Generation Feed
          </div>
          <div
            ref={previewRef}
            style={{
              padding: '0.65rem',
              fontSize: '0.72rem',
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              lineHeight: 1.5,
              color: 'rgba(255,255,255,0.75)',
              maxHeight: '120px',
              overflow: 'auto',
            }}
          >
            {progressData.stream_preview}
            <span style={{
              display: 'inline-block',
              width: '2px',
              height: '1em',
              background: 'var(--brand-blue)',
              marginLeft: '2px',
              verticalAlign: 'text-bottom',
              animation: 'forge-blink 1s step-end infinite',
            }} />
          </div>
        </div>
      )}

      <div style={{ marginTop: '0.4rem', textAlign: 'right', fontSize: '0.6rem', opacity: 0.25 }}>
        {task.description || ''}
      </div>

      <style>{`
        @keyframes forge-blink {
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
};

export default ForgeTaskIndicator;
