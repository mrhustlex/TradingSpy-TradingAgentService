import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Activity, BrainCircuit, Eye, EyeOff, Layers } from 'lucide-react';
import { INTELLIGENCE_SERVICE } from '../config';
import { calculateTradeAnalysis, isIntradayInterval } from '../utils/tradeAnalysis';

const tone = { pass: 'var(--brand-green)', watch: 'var(--brand-yellow)', fail: 'var(--brand-red)' };

export default function TradeSetupChecklist({ data, interval, startDate, endDate, analysisMode = 'swing', onAnalysisChange, compact = false }) {
    const [mode, setMode] = useState(analysisMode);
    const [setupId, setSetupId] = useState('pullback');
    const [showLevels, setShowLevels] = useState(true);
    const [showTrendlines, setShowTrendlines] = useState(true);
    const [showStructures, setShowStructures] = useState(true);
    const [explanation, setExplanation] = useState('');
    const [explaining, setExplaining] = useState(false);
    const analysis = useMemo(() => calculateTradeAnalysis(data, interval, mode, startDate, endDate), [data, interval, mode, startDate, endDate]);

    useEffect(() => { onAnalysisChange?.(analysis, { showLevels, showTrendlines, showStructures, mode }); }, [analysis, showLevels, showTrendlines, showStructures, mode, onAnalysisChange]);
    useEffect(() => { if (mode === 'day' && !isIntradayInterval(interval)) setMode('swing'); }, [interval, mode]);

    const explain = async () => {
        if (!analysis.available) return;
        setExplaining(true); setExplanation('');
        try {
            const response = await axios.post(`${INTELLIGENCE_SERVICE}/trade-setup/explain`, { analysis });
            setExplanation(response.data.explanation || response.data.detail || 'Explanation is unavailable.');
        } catch (error) { setExplanation(error.response?.data?.detail || 'Explanation is unavailable.'); }
        finally { setExplaining(false); }
    };
    if (!analysis.available) return <div className="terminal-card" style={{ padding: '0.8rem', color: 'var(--text-muted)', fontSize: '0.78rem' }}>Trade setup unavailable: {analysis.reason}</div>;
    const setup = analysis.setups.find((item) => item.id === setupId) || analysis.setups[0];
    return <div className="terminal-card" style={{ padding: compact ? '0.75rem' : '1rem', marginTop: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}><Activity size={15} color="var(--brand-blue)" /><strong style={{ fontSize: '0.85rem' }}>Trade Setup</strong><span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>{analysis.interval} · {new Date(analysis.asOf).toLocaleString()}</span></div>
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', margin: '0.65rem 0' }}>
            {['swing', 'day'].map((item) => <button key={item} className={`btn btn-xs ${mode === item ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode(item)} disabled={item === 'day' && !isIntradayInterval(interval)}>{item === 'day' ? 'Day' : 'Swing'}</button>)}
            {analysis.setups.map((item) => <button key={item.id} className={`btn btn-xs ${setupId === item.id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setSetupId(item.id)}>{item.title}</button>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))', gap: '0.5rem', fontSize: '0.74rem', marginBottom: '0.7rem' }}>
            {[['Entry', setup.entry], ['Invalidation', setup.stop], ['Target', setup.target], ['Stretch', setup.stretchTarget], ['R:R', setup.rewardRisk ? `${setup.rewardRisk}R` : '-']].map(([label, value]) => <div key={label} style={{ background: 'var(--bg-accent)', padding: '0.45rem', borderRadius: 6 }}><span style={{ color: 'var(--text-muted)', display: 'block' }}>{label}</span><strong>{value ?? '-'}</strong></div>)}
        </div>
        <div style={{ display: 'grid', gap: '0.35rem', fontSize: '0.75rem' }}>{setup.checks.map((item) => <div key={item.label} style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-between', borderLeft: `3px solid ${tone[item.status]}`, paddingLeft: '0.45rem' }}><span>{item.label}</span><span style={{ color: 'var(--text-muted)' }}>{item.detail}</span></div>)}</div>
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.7rem' }}>
            <button className={`btn btn-xs ${showLevels ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setShowLevels(v => !v)}><Layers size={12} /> Levels</button>
            <button className={`btn btn-xs ${showTrendlines ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setShowTrendlines(v => !v)}>{showTrendlines ? <Eye size={12} /> : <EyeOff size={12} />} Trendlines</button>
            <button className={`btn btn-xs ${showStructures ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setShowStructures(v => !v)}>{showStructures ? <Eye size={12} /> : <EyeOff size={12} />} Structures</button>
            <button className="btn btn-xs btn-ghost" onClick={explain} disabled={explaining}><BrainCircuit size={12} /> {explaining ? 'Explaining...' : 'Explain'}</button>
        </div>
        {showStructures && analysis.structures.length > 0 && <div style={{ marginTop: '0.65rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>{analysis.structures.map((item) => <span key={`${item.type}-${item.label}`} className="badge badge-blue">{item.label}</span>)}</div>}
        {explanation && <div style={{ marginTop: '0.65rem', color: 'var(--text-secondary)', fontSize: '0.76rem', lineHeight: 1.5 }}>{explanation}</div>}
        <div style={{ marginTop: '0.65rem', color: 'var(--text-muted)', fontSize: '0.66rem' }}>Calculated research checklist, not a buy or sell recommendation.</div>
    </div>;
}
