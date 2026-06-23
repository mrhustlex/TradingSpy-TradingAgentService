import React, { useState, useRef } from 'react';
import axios from 'axios';
import { FileCode, ShieldCheck, Trash2, Save, Copy, Sparkles, Wand2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BACKTEST_SERVICE } from '../config';
import { getApiSettings } from '../utils/apiKeyHelper';

const StrategyLibrary = ({ strategies, onRefresh, notify }) => {
    const [editingStrat, setEditingStrat] = useState(null);
    const [code, setCode] = useState('');
    const [description, setDescription] = useState('');
    const [ticker, setTicker] = useState('General');
    const [saving, setSaving] = useState(false);
    const [aiInstruction, setAiInstruction] = useState('');
    const [aiLoading, setAiLoading] = useState(false);
    const editorRef = useRef(null);

    const viewDetails = async (strat) => {
        try {
            const res = await axios.get(`${BACKTEST_SERVICE}/strategies/${strat.name}`);
            setEditingStrat(res.data);
            setCode(res.data.code);
            setDescription(res.data.description || '');
            setTicker(res.data.ticker || 'General');
            // Smooth swipe/scroll into view
            setTimeout(() => {
                editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        } catch (e) {
            notify("Failed to fetch strategy code", 'red');
        }
    };

    const handleUpdate = async () => {
        if (!editingStrat.is_custom) return;
        setSaving(true);
        try {
            await axios.put(`${BACKTEST_SERVICE}/strategies/${editingStrat.name}`, {
                name: editingStrat.name,
                code: code,
                class_name: editingStrat.class_name,
                description: description,
                ticker: ticker
            });
            notify("Logic updated successfully!", 'green');
            onRefresh();
        } catch (e) {
            notify("Save failed", 'red');
        }
        setSaving(false);
    };

    const handleDelete = async (name) => {
        if (!window.confirm(`Permanently delete strategy ${name}?`)) return;
        try {
            await axios.delete(`${BACKTEST_SERVICE}/strategies/${name}`);
            notify(`Strategy "${name}" deleted.`, 'blue');
            onRefresh();
            if (editingStrat?.name === name) setEditingStrat(null);
        } catch (e) {
            notify("Delete failed", 'red');
        }
    };

    const handleDuplicate = async (name) => {
        try {
            const res = await axios.post(`${BACKTEST_SERVICE}/strategies/${name}/duplicate`);
            notify(res.data.message, 'green');
            onRefresh();
            // Close the editor if it's the duplicated strategy being viewed
            if (editingStrat?.name === name) {
                setEditingStrat(null);
            }
        } catch (e) {
            notify("Duplicate failed: " + (e.response?.data?.detail || e.message), 'red');
        }
    };

    const handleAIEdit = async () => {
        if (!aiInstruction.trim()) return;
        setAiLoading(true);
        try {
            const { provider, model, api_key } = getApiSettings();
            const res = await axios.post(`${BACKTEST_SERVICE}/strategies/ai-edit`, {
                name: editingStrat.name,
                instruction: aiInstruction,
                code: code,
                provider,
                api_key,
                model
            });

            if (res.data.code) {
                setCode(res.data.code);
                notify("AI Logic Enhancement Applied!", 'purple');
                setAiInstruction('');
            }
        } catch (e) {
            notify("AI Refinement failed", 'red');
        }
        setAiLoading(false);
    };

    return (
        <div>
            <h1 style={{ marginBottom: '2rem' }}>Strategy Library</h1>

            <div className="panel">
                <table className="table">
                    <thead>
                        <tr><th>Strategy Name</th><th>Ticker</th><th>Description</th><th>Status</th><th>Actions</th></tr>
                    </thead>
                    <tbody>
                        {strategies.map(s => (
                            <tr key={s.name}>
                                <td><strong>{s.name}</strong></td>
                                <td>
                                    <span style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--brand-blue)' }}>
                                        {s.ticker || 'General'}
                                    </span>
                                </td>
                                <td style={{ fontSize: '0.85rem', opacity: 0.7, maxWidth: '250px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {s.description || 'No description'}
                                </td>
                                <td>
                                    <span className={`badge ${s.is_custom ? 'badge-blue' : 'badge-green'}`}>
                                        {s.is_custom ? 'AI-Forged' : 'Protected'}
                                    </span>
                                </td>
                                <td style={{ display: 'flex', gap: '0.5rem' }}>
                                    <button className="btn" style={{ padding: '0.4rem 1rem' }} onClick={() => viewDetails(s)}>
                                        {s.is_custom ? <FileCode size={16} /> : <ShieldCheck size={16} />}
                                        {s.is_custom ? 'Edit Logic' : 'View Source'}
                                    </button>
                                    <button className="btn btn-ghost" onClick={() => handleDuplicate(s.name)} title="Duplicate">
                                        <Copy size={16} />
                                    </button>
                                    {s.is_custom && (
                                        <button className="btn btn-red" onClick={() => handleDelete(s.name)}><Trash2 size={16} /></button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <AnimatePresence>
                {editingStrat && (
                    <motion.div
                        ref={editorRef}
                        initial={{ opacity: 0, y: 50 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 50 }}
                        className="panel"
                        style={{ marginTop: '2rem', border: '1px solid var(--brand-blue)' }}
                    >
                        <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1.5rem' }}>
                            <div style={{ flex: 2 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
                                    <div>
                                        <h3>{editingStrat.is_custom ? 'Logic Editor' : 'Built-in Source Representation'}</h3>
                                        <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>{editingStrat.name} ({editingStrat.class_name})</p>
                                    </div>
                                    <div style={{ display: 'flex', gap: '0.8rem' }}>
                                        {editingStrat.is_custom && (
                                            <button className="btn btn-primary" onClick={handleUpdate} disabled={saving}>
                                                <Save size={18} /> {saving ? 'Applying...' : 'Apply Changes'}
                                            </button>
                                        )}
                                        <button className="btn" onClick={() => setEditingStrat(null)}>Close</button>
                                    </div>
                                </div>
                                {editingStrat.is_custom && (
                                    <>
                                        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
                                            <div className="form-group" style={{ flex: 2 }}>
                                                <label>Internal Class Name</label>
                                                <input className="input" value={editingStrat.class_name} readOnly style={{ opacity: 0.6, background: 'rgba(0,0,0,0.1)' }} />
                                            </div>
                                            <div className="form-group" style={{ flex: 1 }}>
                                                <label>Ticker Category</label>
                                                <input
                                                    className="input"
                                                    value={ticker}
                                                    onChange={(e) => setTicker(e.target.value)}
                                                    placeholder="e.g. QQQ, BTC, General"
                                                />
                                            </div>
                                        </div>
                                        <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                                            <label>Strategy Summary & Logic Description</label>
                                            <textarea
                                                className="input"
                                                style={{ height: '80px', padding: '0.8rem', lineHeight: '1.5', resize: 'vertical' }}
                                                value={description}
                                                onChange={(e) => setDescription(e.target.value)}
                                                placeholder="Describe the core logic, indicators, and intended market conditions..."
                                            />
                                        </div>
                                    </>
                                )}
                                <textarea
                                    className="code-editor"
                                    style={{ height: '500px', opacity: editingStrat.is_custom ? 1 : 0.7 }}
                                    readOnly={!editingStrat.is_custom}
                                    value={code}
                                    onChange={(e) => setCode(e.target.value)}
                                />
                            </div>

                            {editingStrat.is_custom && (
                                <div style={{ flex: 1, borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '1.5rem' }}>
                                    <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', color: 'var(--brand-yellow)' }}>
                                        <Sparkles size={18} /> AI Enhancement
                                    </h4>
                                    <p style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '1rem' }}>
                                        Describe what you want to change or add to this strategy's logic.
                                    </p>
                                    <textarea
                                        className="input"
                                        style={{ width: '100%', height: '120px', marginBottom: '1rem', fontSize: '0.9rem', resize: 'none' }}
                                        placeholder="E.g., 'Add an RSI exit condition when RSI > 70' or 'Change moving average to EMA'"
                                        value={aiInstruction}
                                        onChange={(e) => setAiInstruction(e.target.value)}
                                    />
                                    <button
                                        className="btn btn-primary"
                                        style={{ width: '100%', background: 'linear-gradient(135deg, #a855f7 0%, #7c3aed 100%)', border: 'none' }}
                                        onClick={handleAIEdit}
                                        disabled={aiLoading || !aiInstruction.trim()}
                                    >
                                        <Wand2 size={16} /> {aiLoading ? 'AI Re-Forging...' : 'Refine with AI'}
                                    </button>

                                    <div style={{ marginTop: '2rem', padding: '1rem', background: 'rgba(168, 85, 247, 0.1)', borderRadius: '8px', border: '1px solid rgba(168, 85, 247, 0.2)' }}>
                                        <h5 style={{ fontSize: '0.8rem', color: '#a855f7', marginBottom: '0.5rem' }}>Pro Tip</h5>
                                        <p style={{ fontSize: '0.75rem', opacity: 0.8, lineHeight: '1.4' }}>
                                            The model is aware of the current code. You can ask for bug fixes, parameter additions, or entirely new indicator logic.
                                        </p>
                                    </div>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default StrategyLibrary;
