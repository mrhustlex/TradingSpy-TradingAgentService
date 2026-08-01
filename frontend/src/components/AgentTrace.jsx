import React, { useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

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

const renderToolJson = (value) => {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

const cleanToolLabel = (label) => String(label || '').replace(/^🔧\s*/, '').replace(/^❌\s*/, '').replace(/^✅\s*/, '').replace(/^⏱️\s*/, '');

const AgentTrace = ({ steps = [], reasoning = '', commentary = [], isRunning = false, variant = 'web' }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [showAll, setShowAll] = useState(false);
    const [expandedToolKeys, setExpandedToolKeys] = useState({});

    const mobile = variant === 'mobile';
    const compacted = compactTraceSteps(steps);
    const commentaryItems = (commentary || []).map(line => ({ _commentary: true, line }));
    const traceItems = [...compacted, ...commentaryItems];
    const hasReasoning = Boolean(reasoning);
    const open = isRunning || isExpanded;
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
    const reasoningLines = reasoning.split('\n').filter(Boolean);
    const preview = latestStep?._commentary ? latestStep.line
        : (latestStep?.label ? cleanToolLabel(latestStep.label)
        : (reasoningLines.length ? reasoningLines[reasoningLines.length - 1] : ''));

    const headerFont = mobile ? 'var(--mobile-text-sm)' : '0.78rem';
    const subFont = mobile ? 'var(--mobile-text-xs)' : '0.7rem';
    const detailFont = mobile ? 'var(--mobile-text-xs)' : '0.8rem';
    const labelFont = mobile ? 'var(--mobile-text-xs)' : '0.78rem';
    const noteFont = mobile ? 'var(--mobile-text-xs)' : '0.72rem';
    const jsonFont = mobile ? 'var(--mobile-text-xs)' : '0.66rem';

    return (
        <div style={{ marginBottom: '0.55rem' }}>
            <button
                onClick={() => setIsExpanded(prev => !prev)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: mobile ? 8 : '0.55rem', padding: mobile ? '0.35rem 0' : '0.42rem 0.1rem', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
            >
                <div style={{ width: mobile ? 20 : 22, height: mobile ? 20 : 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: isRunning ? 'rgba(59,130,246,0.14)' : 'rgba(255,255,255,0.06)', color: isRunning ? 'var(--brand-blue)' : 'rgba(255,255,255,0.58)', flexShrink: 0 }}>
                    {isRunning ? <RefreshCw className="animate-spin" size={mobile ? 12 : 14} /> : <Check size={mobile ? 12 : 14} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: headerFont, fontWeight: 750, color: 'rgba(255,255,255,0.78)' }}>{isRunning ? 'Thinking...' : 'Thought process'}</span>
                        {summary && <span style={{ fontSize: subFont, opacity: 0.42 }}>{summary}</span>}
                    </div>
                    <div style={{ fontSize: subFont, opacity: 0.48, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {preview || (isRunning ? 'Deciding whether tools are needed...' : 'Click to inspect the tool path')}
                    </div>
                </div>
                <span style={{ fontSize: subFont, opacity: 0.42 }}>{open ? 'Hide' : 'Show'}</span>
            </button>
            <AnimatePresence>
                {open && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
                        <div style={{ marginTop: '0.15rem', marginLeft: mobile ? '0.2rem' : '0.7rem', padding: '0.7rem 0 0.3rem 1rem', borderLeft: '1px solid rgba(148,163,184,0.18)' }}>
                            {hasReasoning && (
                                <div style={{ marginBottom: traceItems.length ? '0.75rem' : 0 }}>
                                    <div style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.42, marginBottom: '0.35rem' }}>Thought</div>
                                    <div style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '0.6rem 0.7rem', color: 'rgba(255,255,255,0.72)', fontSize: detailFont, lineHeight: 1.55, whiteSpace: 'pre-wrap', maxHeight: isRunning ? '160px' : '220px', overflowY: 'auto' }}>
                                        {reasoning}
                                        {isRunning && <span style={{ opacity: 0.55 }}> |</span>}
                                    </div>
                                </div>
                            )}
                            {traceItems.length > 0 && (
                                <div>
                                    <div style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.42, marginBottom: '0.45rem' }}>Tools</div>
                                    {traceItems.length > PREVIEW && !showAll && (
                                        <button onClick={() => setShowAll(true)}
                                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.46)', fontSize: subFont, textAlign: 'left', padding: '0 0 0.45rem 0' }}>
                                            Show {traceItems.length - PREVIEW} earlier events
                                        </button>
                                    )}
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 6 : '0.45rem' }}>
                                        {displayItems.map((item, i) => {
                                            if (item._commentary) {
                                                return (
                                                    <div key={`commentary-${i}`} style={{ display: 'flex', gap: '0.55rem', color: 'rgba(255,255,255,0.58)', fontSize: detailFont, lineHeight: 1.5 }}>
                                                        <span style={{ opacity: 0.35, flexShrink: 0 }}>note</span>
                                                        <span>{item.line}</span>
                                                    </div>
                                                );
                                            }
                                            const tone = getStepTone(item.status);
                                            const toolKey = item._tool_key || item.tool || i;
                                            const hasToolDetails = Boolean(item.tool_args || item.tool_result || item.tool_error);
                                            const showToolDetails = Boolean(expandedToolKeys[toolKey]);
                                            return (
                                                <div key={`step-${i}`} style={{ display: 'grid', gridTemplateColumns: mobile ? '64px minmax(0, 1fr)' : '76px minmax(0, 1fr)', gap: '0.65rem', alignItems: 'start' }}>
                                                    <span style={{ justifySelf: 'start', border: `1px solid ${tone.border}`, background: tone.background, color: tone.color, borderRadius: '999px', padding: '0.15rem 0.45rem', fontSize: '0.62rem', fontWeight: 800 }}>
                                                        {item._poll ? 'Poll' : tone.label}
                                                    </span>
                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{ color: item._poll ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.78)', fontSize: labelFont, fontWeight: item._poll ? 500 : 650, overflowWrap: 'anywhere' }}>
                                                            {cleanToolLabel(item.label) || item.tool || 'Tool step'}
                                                        </div>
                                                        {item.note && <div style={{ marginTop: '0.18rem', opacity: 0.45, fontSize: noteFont, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{String(item.note).slice(0, 180)}</div>}
                                                        {hasToolDetails && (
                                                            <button
                                                                type="button"
                                                                onClick={() => setExpandedToolKeys(prev => ({ ...prev, [toolKey]: !prev[toolKey] }))}
                                                                style={{ marginTop: '0.28rem', background: 'transparent', border: 'none', color: 'var(--brand-blue)', cursor: 'pointer', fontSize: subFont, padding: 0 }}
                                                            >
                                                                {showToolDetails ? 'Hide full tool JSON' : 'Show full tool JSON'}
                                                            </button>
                                                        )}
                                                        {hasToolDetails && showToolDetails && (
                                                            <div style={{ marginTop: '0.45rem', display: 'grid', gap: '0.45rem' }}>
                                                                {item.tool_args && (
                                                                    <div>
                                                                        <div style={{ fontSize: '0.62rem', fontWeight: 800, opacity: 0.42, textTransform: 'uppercase', marginBottom: '0.25rem' }}>Input</div>
                                                                        <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', padding: '0.55rem 0.65rem', borderRadius: 6, border: '1px solid rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.42)', color: 'rgba(226,232,240,0.76)', fontSize: jsonFont, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{renderToolJson(item.tool_args)}</pre>
                                                                    </div>
                                                                )}
                                                                {item.tool_result && (
                                                                    <div>
                                                                        <div style={{ fontSize: '0.62rem', fontWeight: 800, opacity: 0.42, textTransform: 'uppercase', marginBottom: '0.25rem' }}>Result</div>
                                                                        <pre style={{ margin: 0, maxHeight: 420, overflow: 'auto', padding: '0.55rem 0.65rem', borderRadius: 6, border: '1px solid rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.42)', color: 'rgba(226,232,240,0.76)', fontSize: jsonFont, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{renderToolJson(item.tool_result)}</pre>
                                                                    </div>
                                                                )}
                                                                {item.tool_error && (
                                                                    <div>
                                                                        <div style={{ fontSize: '0.62rem', fontWeight: 800, opacity: 0.42, textTransform: 'uppercase', marginBottom: '0.25rem' }}>Error</div>
                                                                        <pre style={{ margin: 0, maxHeight: 180, overflow: 'auto', padding: '0.55rem 0.65rem', borderRadius: 6, border: '1px solid rgba(239,68,68,0.22)', background: 'rgba(239,68,68,0.06)', color: 'rgba(254,202,202,0.85)', fontSize: jsonFont, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(item.tool_error)}</pre>
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
                                        <button onClick={() => setShowAll(false)}
                                            style={{ marginTop: '0.5rem', background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.46)', fontSize: subFont, textAlign: 'left', padding: 0 }}>
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

export default AgentTrace;
