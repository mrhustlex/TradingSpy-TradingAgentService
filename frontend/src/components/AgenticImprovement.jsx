import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
    RefreshCw, Wand2, TrendingUp, Save, Play, X, Check, Activity, AlertCircle,
    Zap, Code, CheckCircle2, Terminal, Info, ChevronRight, Layers, Target, CPU, Cpu, History, Clock, Edit3, Sparkles, Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BACKTEST_SERVICE, OPTIMIZER_SERVICE } from '../config';
import { formatDatasetName } from '../utils/formatters';

const AgenticImprovement = ({ files, strategies, notify }) => {
    const [selectedStrategy, setSelectedStrategy] = useState('');
    const [selectedFile, setSelectedFile] = useState('');
    const [iterations, setIterations] = useState(3);
    const [userPrompt, setUserPrompt] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [activeSessionId, setActiveSessionId] = useState(localStorage.getItem('agentic_last_session'));
    const [sessionData, setSessionData] = useState(null);
    const [allSessions, setAllSessions] = useState([]);
    const [autoMode, setAutoMode] = useState(false);
    const [rejectionFeedback, setRejectionFeedback] = useState('');
    const [isRefining, setIsRefining] = useState(false);
    const [viewingCode, setViewingCode] = useState(null);
    const [isApproving, setIsApproving] = useState(false);
    const [isRejecting, setIsRejecting] = useState(false);
    const [isEditingProposal, setIsEditingProposal] = useState(false);
    const [editedProposal, setEditedProposal] = useState('');
    const [editReason, setEditReason] = useState('');
    const [isStopping, setIsStopping] = useState(false);
    const [continuousMode, setContinuousMode] = useState(false);
    const [cooldownMinutes, setCooldownMinutes] = useState(360); // 6 hours default

    // Helper for relative time
    const formatTimeAgo = (dateStr) => {
        if (!dateStr) return 'Unknown';
        const date = new Date(dateStr);
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 60) return 'seconds ago';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        return `${Math.floor(minutes / 60)}h ago`;
    };

    const fetchAllSessions = async () => {
        try {
            const res = await axios.get(`${OPTIMIZER_SERVICE}/ai/improve/sessions`, { timeout: 10000 });
            setAllSessions(res.data.sessions || []);
        } catch (e) {
            console.error("Failed to fetch sessions", e);
        }
    };

    useEffect(() => {
        fetchAllSessions();
        const interval = setInterval(fetchAllSessions, 8000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (!activeSessionId) {
            setSessionData(null);
            return;
        }
        localStorage.setItem('agentic_last_session', activeSessionId);

        // Fetch immediately when session changes
        const fetchSession = async () => {
            try {
                const res = await axios.get(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}`, { timeout: 10000 });
                setSessionData(res.data);
            } catch (e) {
                if (e.response?.status === 404) {
                    setActiveSessionId(null);
                    localStorage.removeItem('agentic_last_session');
                }
            }
        };

        fetchSession(); // Initial fetch

        const interval = setInterval(fetchSession, 2000);
        return () => clearInterval(interval);
    }, [activeSessionId]);

    const startImprovement = async () => {
        if (!selectedStrategy || !selectedFile) {
            notify("Please select both a strategy and a dataset", "blue");
            return;
        }
        try {
            // Use the autonomous endpoint for fully automatic optimization
            const endpoint = autoMode ? '/api/optimizer/ai/improve-auto' : '/api/optimizer/ai/improve';
            
            const res = await axios.post(`${OPTIMIZER_SERVICE}${endpoint}`, {
                strategy_name: selectedStrategy,
                dataset_filename: selectedFile,
                iterations: parseInt(iterations),
                user_prompt: userPrompt,
                auto_mode: autoMode,
                continuous_mode: continuousMode,
                cooldown_minutes: parseInt(cooldownMinutes),
                start_date: startDate || null,
                end_date: endDate || null,
                provider: "mistral",
                model: "mistral-large-latest",
                api_key: null
            }, { timeout: 15000 });

            setActiveSessionId(res.data.session_id);
            setSessionData(null);
            notify(autoMode ? "🤖 Autonomous optimization started!" : "AI Optimization Agent deployed.", "green");
            fetchAllSessions();
        } catch (e) {
            notify(e.response?.data?.detail || "Launch failed", "red");
        }
    };

    const handleApprove = async () => {
        setIsApproving(true);
        try {
            await axios.post(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}/approve`);
            notify("✓ Proposal approved! Strategy saved and optimization starting...", "green");

            // Show immediate feedback
            setTimeout(() => {
                notify("🔄 Running deep backtest optimization...", "blue");
            }, 2000);

            // Wait a moment for backend to process, then refresh
            setTimeout(async () => {
                try {
                    const res = await axios.get(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}`, { timeout: 10000 });
                    setSessionData(res.data);
                } catch (e) {
                    console.error("Failed to refresh session data:", e);
                }
            }, 1000);

        } catch (e) {
            notify("Approval failed", "red");
        } finally {
            setIsApproving(false);
        }
    };

    const handleReject = async () => {
        setIsRejecting(true);
        try {
            await axios.post(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}/reject`, { feedback: rejectionFeedback });
            setRejectionFeedback('');
            notify("✗ Proposal rejected. AI will generate new proposal...", "blue");

            // Show what happens next
            setTimeout(() => {
                notify("🤖 AI analyzing feedback for next iteration...", "blue");
            }, 1500);

            // Force immediate refresh to show updated status
            const res = await axios.get(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}`);
            setSessionData(res.data);
        } catch (e) {
            notify("Rejection failed", "red");
        } finally {
            setIsRejecting(false);
        }
    };

    const handleEditProposal = async () => {
        if (!editedProposal.trim()) {
            notify("Please provide the edited code", "red");
            return;
        }

        try {
            await axios.post(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}/edit-code`, {
                code: editedProposal,
                reason: editReason
            });

            notify("✓ Code updated successfully", "green");

            // Show what happens next
            setTimeout(() => {
                notify("📝 Manual changes saved. Ready for approval...", "blue");
            }, 1000);

            // Refresh session data to show updated proposal
            const res = await axios.get(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}`);
            setSessionData(res.data);
            setIsEditingProposal(false);
            setEditedProposal('');
            setEditReason('');
        } catch (e) {
            notify("Failed to update code", "red");
        }
    };

    const handleAIRefine = async () => {
        if (!rejectionFeedback.trim()) {
            notify("Please provide feedback for AI refinement", "red");
            return;
        }

        setIsRefining(true);
        try {
            notify("🤖 AI is refining the proposal based on your feedback...", "blue");

            await axios.post(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}/ai-refine`, {
                feedback: rejectionFeedback
            });

            notify("✓ AI refined the proposal successfully", "green");

            // Show what happens next
            setTimeout(() => {
                notify("🔍 Review the refined proposal above", "blue");
            }, 1000);

            // Refresh session data to show refined proposal
            const res = await axios.get(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}`);
            setSessionData(res.data);
            setRejectionFeedback('');
        } catch (e) {
            notify("AI refinement failed", "red");
        } finally {
            setIsRefining(false);
        }
    };

    const handleStop = async () => {
        if (!window.confirm('Are you sure you want to stop this optimization session?')) {
            return;
        }

        setIsStopping(true);
        try {
            await axios.post(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}/stop`);
            notify("⏹ Stop signal sent to agent", "blue");

            // Refresh session data to show stopped status
            setTimeout(async () => {
                try {
                    const res = await axios.get(`${OPTIMIZER_SERVICE}/ai/improve/${activeSessionId}`);
                    setSessionData(res.data);
                } catch (e) {
                    console.error("Failed to refresh session data:", e);
                }
            }, 1000);
        } catch (e) {
            notify("Failed to stop session", "red");
        } finally {
            setIsStopping(false);
        }
    };

    const startEditingProposal = () => {
        setEditedProposal(sessionData.proposal);
        setIsEditingProposal(true);
    };

    const deleteSession = async (sessionId) => {
        if (!window.confirm('Are you sure you want to delete this optimization session?')) {
            return;
        }

        try {
            await axios.delete(`${OPTIMIZER_SERVICE}/ai/improve/${sessionId}`);

            // If we deleted the active session, clear it
            if (sessionId === activeSessionId) {
                setActiveSessionId(null);
                setSessionData(null);
                localStorage.removeItem('agentic_last_session');
            }

            // Refresh the sessions list
            fetchAllSessions();
            notify("✓ Session deleted", "green");
        } catch (e) {
            notify("Failed to delete session", "red");
        }
    };

    const cleanupUnusedSessions = async () => {
        if (!window.confirm('This will delete all completed and failed sessions. Continue?')) {
            return;
        }

        try {
            const res = await axios.delete(`${OPTIMIZER_SERVICE}/ai/improve/cleanup/unused`);
            fetchAllSessions();
            notify(`✓ Cleaned up ${res.data.deleted_count} unused sessions`, "green");
        } catch (e) {
            notify("Cleanup failed", "red");
        }
    };

    return (
        <div style={{ padding: '2rem', maxWidth: '1600px', margin: '0 auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '2rem', alignItems: 'start' }}>

                {/* Task History Sidebar */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                    <div className="panel" style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                            <h4 style={{ margin: 0, fontSize: '0.7rem', opacity: 0.6, letterSpacing: '1px' }}>OPTIMIZATION QUEUE</h4>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <button
                                    className="btn btn-ghost btn-xs"
                                    onClick={cleanupUnusedSessions}
                                    title="Delete all completed/failed sessions"
                                    style={{ color: 'var(--brand-red)', borderColor: 'var(--brand-red)' }}
                                >
                                    <Trash2 size={12} />
                                </button>
                                <button className="btn btn-ghost btn-xs" onClick={fetchAllSessions}>
                                    <RefreshCw size={12} />
                                </button>
                            </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '400px', overflowY: 'auto' }}>
                            {allSessions.length === 0 && <p style={{ fontSize: '0.75rem', opacity: 0.4, textAlign: 'center', py: '1rem' }}>No active runs.</p>}
                            {allSessions.map(s => (
                                <div
                                    key={s.session_id}
                                    style={{
                                        padding: '0.75rem', borderRadius: '10px', background: activeSessionId === s.session_id ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255,255,255,0.03)',
                                        border: activeSessionId === s.session_id ? '1px solid var(--brand-blue)' : '1px solid transparent',
                                        cursor: 'pointer', transition: 'all 0.2s ease', position: 'relative'
                                    }}
                                >
                                    <div
                                        onClick={() => setActiveSessionId(s.session_id)}
                                        style={{ flex: 1 }}
                                    >
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: '0.85rem', fontWeight: 'bold', color: activeSessionId === s.session_id ? 'white' : 'rgba(255,255,255,0.8)' }}>
                                                    {s.strategy_name}
                                                </div>
                                                <div style={{ fontSize: '0.65rem', opacity: 0.5, marginTop: '2px' }}>
                                                    {formatDatasetName(s.dataset)}
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                {s.status === 'running' ? (
                                                    <RefreshCw className="animate-spin" size={14} color="var(--brand-blue)" />
                                                ) : s.status === 'waiting_for_approval' ? (
                                                    <AlertCircle size={14} color="var(--brand-yellow)" />
                                                ) : s.status === 'completed' ? (
                                                    <CheckCircle2 size={14} color="var(--brand-green)" />
                                                ) : (
                                                    <X size={14} color="var(--brand-red)" />
                                                )}
                                                <button
                                                    className="btn btn-ghost btn-xs"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        deleteSession(s.session_id);
                                                    }}
                                                    style={{
                                                        padding: '0.25rem',
                                                        minWidth: 'auto',
                                                        height: 'auto',
                                                        color: 'var(--brand-red)',
                                                        opacity: 0.6,
                                                        border: 'none'
                                                    }}
                                                    title="Delete session"
                                                >
                                                    <Trash2 size={12} />
                                                </button>
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                                <span style={{ fontSize: '0.65rem', color: 'var(--brand-blue)', fontWeight: 'bold' }}>{s.iteration_count} rounds</span>
                                                <span
                                                    className={`badge ${s.status === 'running' ? 'badge-blue' :
                                                        s.status === 'waiting_for_approval' ? 'badge-yellow' :
                                                            s.status === 'completed' ? 'badge-green' :
                                                            s.status === 'cooldown' ? 'badge-purple' : 'badge-red'
                                                        }`}
                                                    style={{ fontSize: '0.6rem', padding: '0.15rem 0.4rem' }}
                                                >
                                                    {s.status === 'waiting_for_approval' ? 'pending' : s.status}
                                                </span>
                                                {s.config?.continuous_mode && (
                                                    <span 
                                                        className="badge badge-purple" 
                                                        style={{ fontSize: '0.55rem', padding: '0.1rem 0.3rem' }}
                                                        title="24/7 Continuous Mode - Auto-restarts after completion"
                                                    >
                                                        ♾️ 24/7
                                                    </span>
                                                )}
                                            </div>
                                            <span style={{ fontSize: '0.6rem', opacity: 0.4 }}>{formatTimeAgo(s.created_at)}</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <button
                            className="btn btn-primary btn-sm"
                            style={{ width: '100%', marginTop: '1.25rem', height: '36px', fontSize: '0.8rem' }}
                            onClick={() => { setActiveSessionId(null); setSessionData(null); }}
                        >
                            + New Optimization
                        </button>
                    </div>

                    {/* New Task Config Panel */}
                    {!activeSessionId && (
                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="panel">
                            <h3 style={{ margin: '0 0 1.5rem 0', fontSize: '1.1rem' }}>Configure Agent</h3>

                            <div className="form-group" style={{ marginBottom: '1rem' }}>
                                <label style={{ fontSize: '0.75rem', opacity: 0.6, marginBottom: '0.4rem', display: 'block' }}>TARGET SIGNAL</label>
                                <select className="input input-sm" style={{ width: '100%' }} value={selectedStrategy} onChange={e => setSelectedStrategy(e.target.value)}>
                                    <option value="">Select strategy...</option>
                                    {strategies.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                                </select>
                            </div>

                            <div className="form-group" style={{ marginBottom: '1rem' }}>
                                <label style={{ fontSize: '0.75rem', opacity: 0.6, marginBottom: '0.4rem', display: 'block' }}>BACKTEST DATA</label>
                                <select className="input input-sm" style={{ width: '100%' }} value={selectedFile} onChange={e => setSelectedFile(e.target.value)}>
                                    <option value="">Select data...</option>
                                    {files.map(f => <option key={f} value={f}>{formatDatasetName(f)}</option>)}
                                </select>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                                <div className="form-group">
                                    <label style={{ fontSize: '0.75rem', opacity: 0.6, marginBottom: '0.4rem', display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>START DATE</label>
                                    <input
                                        type="date"
                                        className="input input-sm"
                                        style={{ width: '100%' }}
                                        value={startDate}
                                        onChange={e => setStartDate(e.target.value)}
                                        title="Optional: Filter backtest from this date"
                                    />
                                </div>
                                <div className="form-group">
                                    <label style={{ fontSize: '0.75rem', opacity: 0.6, marginBottom: '0.4rem', display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>END DATE</label>
                                    <input
                                        type="date"
                                        className="input input-sm"
                                        style={{ width: '100%' }}
                                        value={endDate}
                                        onChange={e => setEndDate(e.target.value)}
                                        title="Optional: Filter backtest until this date"
                                    />
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                                <div>
                                    <label style={{ fontSize: '0.75rem', opacity: autoMode ? 0.4 : 0.6, display: 'block', marginBottom: '0.4rem' }}>
                                        {autoMode ? 'ROUNDS (Auto - runs until no improvement)' : `ROUNDS (${iterations})`}
                                    </label>
                                    <input
                                        type="range"
                                        min="1"
                                        max="100"
                                        style={{ width: '100%', opacity: autoMode ? 0.4 : 1, cursor: autoMode ? 'not-allowed' : 'pointer' }}
                                        value={iterations}
                                        onChange={e => setIterations(e.target.value)}
                                        disabled={autoMode}
                                    />
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '0.5rem' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.8rem' }}>
                                        <input type="checkbox" checked={autoMode} onChange={e => setAutoMode(e.target.checked)} />
                                        Auto-Mode
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.8rem', opacity: autoMode ? 1 : 0.4 }}>
                                        <input 
                                            type="checkbox" 
                                            checked={continuousMode} 
                                            onChange={e => setContinuousMode(e.target.checked)}
                                            disabled={!autoMode}
                                        />
                                        24/7 Continuous
                                    </label>
                                </div>
                            </div>

                            {continuousMode && autoMode && (
                                <div className="form-group" style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '8px', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                                    <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '0.5rem' }}>
                                        COOLDOWN BETWEEN RUNS (minutes)
                                    </label>
                                    <input
                                        type="number"
                                        className="input input-sm"
                                        style={{ width: '100%' }}
                                        value={cooldownMinutes}
                                        onChange={e => setCooldownMinutes(e.target.value)}
                                        min="30"
                                        max="1440"
                                        step="30"
                                    />
                                    <div style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '0.25rem' }}>
                                        Agent will restart automatically after {cooldownMinutes} minutes ({(cooldownMinutes / 60).toFixed(1)} hours)
                                    </div>
                                </div>
                            )}

                            <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                                <label style={{ fontSize: '0.75rem', opacity: 0.6, display: 'block', marginBottom: '0.4rem' }}>AGENT GUIDANCE</label>
                                <textarea
                                    className="input"
                                    style={{ width: '100%', height: '80px', fontSize: '0.8rem', padding: '0.5rem' }}
                                    placeholder="e.g. Reduce drawdown, better RSI exit..."
                                    value={userPrompt}
                                    onChange={e => setUserPrompt(e.target.value)}
                                />
                            </div>

                            <button className="btn btn-primary" style={{ width: '100%', height: '48px', gap: '0.5rem' }} onClick={startImprovement}>
                                <Zap size={18} /> Launch Agent
                            </button>
                        </motion.div>
                    )}
                </div>

                {/* Execution Dashboard */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                    {!sessionData ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', pt: '8rem', opacity: 0.1 }}>
                            <Cpu size={120} />
                            <h1 style={{ marginTop: '2rem' }}>OPTIMIZER KERNEL</h1>
                            <p>Select a task from the sidebar or launch a new run.</p>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                            {/* Header Stats Panel */}
                            <div className="panel" style={{ padding: '2rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                                    <div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
                                            <div style={{ background: 'var(--brand-blue)', padding: '10px', borderRadius: '12px' }}>
                                                <Target size={24} color="white" />
                                            </div>
                                            <h1 style={{ margin: 0, fontSize: '1.8rem' }}>Improving: {sessionData.strategy_name}</h1>
                                        </div>
                                        <div style={{ display: 'flex', gap: '1rem', opacity: 0.6, fontSize: '0.9rem' }}>
                                            <span>Dataset: {formatDatasetName(sessionData.dataset)}</span>
                                            <span>•</span>
                                            <span>ID: {activeSessionId}</span>
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                                        {(sessionData.status === 'running' || sessionData.status === 'waiting_for_approval') && (
                                            <button
                                                className="btn btn-ghost btn-sm"
                                                onClick={handleStop}
                                                disabled={isStopping}
                                                style={{ color: 'var(--brand-red)', borderColor: 'var(--brand-red)', display: 'flex', alignItems: 'center', gap: '0.4rem', opacity: isStopping ? 0.6 : 1 }}
                                            >
                                                {isStopping ? <RefreshCw className="animate-spin" size={14} /> : <X size={14} />}
                                                Stop Agent
                                            </button>
                                        )}
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{ fontSize: '0.8rem', opacity: 0.5, textTransform: 'uppercase', letterSpacing: '1px' }}>Engine ROI Max</div>
                                            <div style={{ fontSize: '2.5rem', fontWeight: '900', color: 'var(--brand-green)', lineHeight: 1 }}>{sessionData.best_roi ? `${sessionData.best_roi.toFixed(2)}%` : '---'}</div>
                                        </div>
                                    </div>
                                </div>

                                <div style={{ marginBottom: '2.5rem' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem', fontSize: '0.85rem', fontWeight: 'bold' }}>
                                        <span style={{ opacity: 0.7 }}>CYCLE COMPLETION</span>
                                        <span style={{ color: 'var(--brand-blue)' }}>{sessionData.progress}%</span>
                                    </div>
                                    <div style={{ height: '10px', background: 'var(--bg-app)', borderRadius: '5px', overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
                                        <motion.div animate={{ width: `${sessionData.progress}%` }} style={{ height: '100%', background: 'linear-gradient(90deg, var(--brand-blue), #60a5fa)' }} />
                                    </div>

                                    {/* Process Steps Indicator */}
                                    {sessionData.status === 'running' && (
                                        <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.8rem' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                <div style={{
                                                    width: '8px',
                                                    height: '8px',
                                                    borderRadius: '50%',
                                                    background: sessionData.current?.includes('AI') ? 'var(--brand-blue)' : 'var(--border-subtle)'
                                                }} />
                                                <span style={{ opacity: sessionData.current?.includes('AI') ? 1 : 0.5 }}>AI Generation</span>
                                            </div>
                                            <ChevronRight size={12} style={{ opacity: 0.3 }} />
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                <div style={{
                                                    width: '8px',
                                                    height: '8px',
                                                    borderRadius: '50%',
                                                    background: sessionData.current?.includes('Saving') || sessionData.current?.includes('Approved') ? 'var(--brand-green)' : 'var(--border-subtle)'
                                                }} />
                                                <span style={{ opacity: sessionData.current?.includes('Saving') || sessionData.current?.includes('Approved') ? 1 : 0.5 }}>Strategy Save</span>
                                            </div>
                                            <ChevronRight size={12} style={{ opacity: 0.3 }} />
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                <div style={{
                                                    width: '8px',
                                                    height: '8px',
                                                    borderRadius: '50%',
                                                    background: sessionData.current?.includes('backtest') || sessionData.current?.includes('optimization') ? 'var(--brand-purple)' : 'var(--border-subtle)'
                                                }} />
                                                <span style={{ opacity: sessionData.current?.includes('backtest') || sessionData.current?.includes('optimization') ? 1 : 0.5 }}>Backtesting</span>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div style={{ background: '#0a0a0c', padding: '1.25rem', borderRadius: '12px', border: '1px solid #1a1a1e' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--brand-blue)' }}>
                                            {sessionData.status === 'running' ? <RefreshCw className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
                                            <span style={{ fontWeight: 'bold', fontSize: '1rem' }}>{sessionData.current}</span>
                                        </div>
                                        <div style={{ display: 'flex', gap: '4px' }}>
                                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ff5f56' }} />
                                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ffbd2e' }} />
                                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#27c93f' }} />
                                        </div>
                                    </div>

                                    {/* Enhanced Status Display */}
                                    {sessionData.status === 'running' && sessionData.current && (
                                        <div style={{ marginBottom: '0.75rem', padding: '0.75rem', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '8px', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--brand-blue)', fontWeight: 'bold', marginBottom: '0.25rem' }}>
                                                Current Operation
                                            </div>
                                            <div style={{ fontSize: '0.85rem', color: '#d1d5db' }}>
                                                {sessionData.current}
                                            </div>
                                            {sessionData.progress > 0 && (
                                                <div style={{ marginTop: '0.5rem' }}>
                                                    <div style={{ fontSize: '0.7rem', color: 'var(--brand-blue)', marginBottom: '0.25rem' }}>
                                                        Progress: {sessionData.progress}%
                                                    </div>
                                                    <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                                                        <div style={{ width: `${sessionData.progress}%`, height: '100%', background: 'var(--brand-blue)', transition: 'width 0.3s ease' }} />
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    <div style={{ maxHeight: '180px', overflowY: 'auto', fontSize: '0.8rem', fontFamily: 'monospace', color: '#d1d5db', lineHeight: '1.6' }}>
                                        {sessionData.logs.slice(-10).map((log, idx) => (
                                            <div key={idx} style={{ opacity: 0.9, marginBottom: '0.25rem' }}>
                                                <span style={{ color: '#27c93f' }}>[SYST]</span> {log}
                                            </div>
                                        ))}
                                        {sessionData.status === 'running' && (
                                            <div className="animate-pulse" style={{ color: 'var(--brand-blue)' }}>_</div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '2rem' }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                                    {/* Post-Action Feedback Panel */}
                                    {sessionData.status === 'running' && sessionData.logs.length > 0 &&
                                        sessionData.logs[sessionData.logs.length - 1].includes('Approved') && (
                                            <motion.div
                                                initial={{ opacity: 0, y: -10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                className="panel"
                                                style={{ border: '1px solid var(--brand-green)', background: 'rgba(16, 185, 129, 0.05)' }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                                                    <CheckCircle2 size={20} color="var(--brand-green)" />
                                                    <h3 style={{ margin: 0, color: 'var(--brand-green)' }}>Proposal Approved</h3>
                                                </div>
                                                <div style={{ fontSize: '0.9rem', marginBottom: '1rem', opacity: 0.9 }}>
                                                    ✓ Strategy code has been saved to the backtesting service<br />
                                                    ✓ Deep optimization backtest is now running<br />
                                                    ✓ Results will appear in the iteration history below
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', opacity: 0.7 }}>
                                                    <RefreshCw className="animate-spin" size={14} />
                                                    Running optimization with approved changes...
                                                </div>
                                            </motion.div>
                                        )}

                                    {sessionData.status === 'running' && sessionData.logs.length > 0 &&
                                        sessionData.logs[sessionData.logs.length - 1].includes('Rejected') && (
                                            <motion.div
                                                initial={{ opacity: 0, y: -10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                className="panel"
                                                style={{ border: '1px solid var(--brand-red)', background: 'rgba(239, 68, 68, 0.05)' }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                                                    <X size={20} color="var(--brand-red)" />
                                                    <h3 style={{ margin: 0, color: 'var(--brand-red)' }}>Proposal Rejected</h3>
                                                </div>
                                                <div style={{ fontSize: '0.9rem', marginBottom: '1rem', opacity: 0.9 }}>
                                                    ✗ Proposal was not saved<br />
                                                    ✓ AI will generate a new proposal in the next iteration<br />
                                                    ✓ Your feedback has been recorded for improvement
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', opacity: 0.7 }}>
                                                    <RefreshCw className="animate-spin" size={14} />
                                                    Preparing next iteration...
                                                </div>
                                            </motion.div>
                                        )}

                                    {sessionData.status === 'waiting_for_approval' && (
                                        <motion.div initial={{ scale: 0.98 }} animate={{ scale: 1 }} className="panel" style={{ border: '1px solid var(--brand-yellow)' }}>
                                            <h3 style={{ margin: '0 0 1rem 0', color: 'var(--brand-yellow)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                <AlertCircle size={20} /> Proposal Verification
                                            </h3>
                                            <div style={{ background: 'rgba(255,193,7,0.05)', padding: '1rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.9rem', borderLeft: '3px solid var(--brand-yellow)' }}>
                                                <b>Reasoning:</b> {sessionData.reasoning}
                                            </div>

                                            {!isEditingProposal ? (
                                                <>
                                                    <textarea className="code-editor" style={{ height: '300px', width: '100%', fontSize: '0.75rem', marginBottom: '1rem' }} value={sessionData.proposal} readOnly />

                                                    {/* Action Buttons */}
                                                    <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
                                                        <button
                                                            className="btn btn-primary"
                                                            onClick={handleApprove}
                                                            disabled={isApproving || isRejecting || isRefining}
                                                            style={{ flex: 2, background: 'var(--brand-green)', color: 'white', border: 'none', opacity: (isApproving || isRejecting || isRefining) ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                                                        >
                                                            {isApproving ? <><RefreshCw className="animate-spin" size={16} /> Approving...</> : <>✓ Approve & Save</>}
                                                        </button>
                                                        <button
                                                            className="btn btn-ghost"
                                                            onClick={startEditingProposal}
                                                            disabled={isApproving || isRejecting || isRefining}
                                                            style={{ flex: 1, color: 'var(--brand-blue)', borderColor: 'var(--brand-blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                                                        >
                                                            <Edit3 size={16} /> Edit Code
                                                        </button>
                                                    </div>

                                                    {/* Rejection Section */}
                                                    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '1rem' }}>
                                                        <textarea
                                                            className="input"
                                                            style={{ width: '100%', height: '60px', fontSize: '0.8rem', marginBottom: '0.75rem' }}
                                                            placeholder="Provide feedback for rejection or AI refinement..."
                                                            value={rejectionFeedback}
                                                            onChange={e => setRejectionFeedback(e.target.value)}
                                                        />
                                                        <div style={{ display: 'flex', gap: '0.75rem' }}>
                                                            <button
                                                                className="btn"
                                                                onClick={handleReject}
                                                                disabled={isApproving || isRejecting || isRefining}
                                                                style={{ flex: 1, color: 'var(--brand-red)', borderColor: 'var(--brand-red)', opacity: (isApproving || isRejecting || isRefining) ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                                                            >
                                                                {isRejecting ? <><RefreshCw className="animate-spin" size={16} /> Rejecting...</> : <>✗ Reject</>}
                                                            </button>
                                                            <button
                                                                className="btn btn-ghost"
                                                                onClick={handleAIRefine}
                                                                disabled={isApproving || isRejecting || isRefining || !rejectionFeedback.trim()}
                                                                style={{ flex: 1, color: 'var(--brand-purple)', borderColor: 'var(--brand-purple)', opacity: (isApproving || isRejecting || isRefining || !rejectionFeedback.trim()) ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                                                            >
                                                                {isRefining ? <><RefreshCw className="animate-spin" size={16} /> Refining...</> : <><Sparkles size={16} /> AI Refine</>}
                                                            </button>
                                                        </div>
                                                    </div>
                                                </>
                                            ) : (
                                                /* Code Editing Mode */
                                                <>
                                                    <div style={{ marginBottom: '1rem' }}>
                                                        <label style={{ fontSize: '0.75rem', opacity: 0.6, display: 'block', marginBottom: '0.4rem' }}>EDIT REASON (OPTIONAL)</label>
                                                        <input
                                                            className="input"
                                                            style={{ width: '100%', fontSize: '0.8rem' }}
                                                            placeholder="Describe your changes..."
                                                            value={editReason}
                                                            onChange={e => setEditReason(e.target.value)}
                                                        />
                                                    </div>
                                                    <textarea
                                                        className="code-editor"
                                                        style={{ height: '300px', width: '100%', fontSize: '0.75rem', marginBottom: '1rem' }}
                                                        value={editedProposal}
                                                        onChange={e => setEditedProposal(e.target.value)}
                                                        placeholder="Edit the proposed code..."
                                                    />
                                                    <div style={{ display: 'flex', gap: '1rem' }}>
                                                        <button
                                                            className="btn btn-primary"
                                                            onClick={handleEditProposal}
                                                            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                                                        >
                                                            <Save size={16} /> Save Changes
                                                        </button>
                                                        <button
                                                            className="btn btn-ghost"
                                                            onClick={() => {
                                                                setIsEditingProposal(false);
                                                                setEditedProposal('');
                                                                setEditReason('');
                                                            }}
                                                            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                                                        >
                                                            <X size={16} /> Cancel
                                                        </button>
                                                    </div>
                                                </>
                                            )}
                                        </motion.div>
                                    )}

                                    {sessionData.best_code && sessionData.status === 'completed' && (
                                        <motion.div
                                            initial={{ opacity: 0, y: 10 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            className="panel"
                                            style={{ border: '1px solid var(--brand-green)', background: 'rgba(16, 185, 129, 0.05)' }}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
                                                <CheckCircle2 size={24} color="var(--brand-green)" />
                                                <div>
                                                    <h3 style={{ margin: 0, color: 'var(--brand-green)' }}>Optimization Complete</h3>
                                                    <div style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: '0.25rem' }}>
                                                        Best ROI: {sessionData.best_roi?.toFixed(2)}% • {sessionData.iterations.length} iterations completed
                                                    </div>
                                                </div>
                                            </div>

                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
                                                <div style={{ padding: '1rem', background: 'var(--bg-accent)', borderRadius: '8px' }}>
                                                    <div style={{ fontSize: '0.7rem', opacity: 0.6, marginBottom: '0.25rem' }}>FINAL PERFORMANCE</div>
                                                    <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--brand-green)' }}>
                                                        {sessionData.best_roi?.toFixed(2)}%
                                                    </div>
                                                </div>
                                                <div style={{ padding: '1rem', background: 'var(--bg-accent)', borderRadius: '8px' }}>
                                                    <div style={{ fontSize: '0.7rem', opacity: 0.6, marginBottom: '0.25rem' }}>IMPROVEMENT</div>
                                                    <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: sessionData.best_roi > (sessionData.baseline_roi || 0) ? 'var(--brand-green)' : 'var(--brand-red)' }}>
                                                        {sessionData.baseline_roi ?
                                                            `${((sessionData.best_roi - sessionData.baseline_roi) / Math.abs(sessionData.baseline_roi) * 100).toFixed(1)}%` :
                                                            'N/A'
                                                        }
                                                    </div>
                                                </div>
                                            </div>

                                            <div style={{ fontSize: '0.9rem', opacity: 0.9 }}>
                                                ✓ Best performing strategy has been saved<br />
                                                ✓ All iterations logged in history<br />
                                                ✓ Strategy is ready for live deployment
                                            </div>

                                            {/* Next Steps for Completed Session */}
                                            <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '8px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                                                <div style={{ fontSize: '0.8rem', fontWeight: 'bold', marginBottom: '0.5rem', color: 'var(--brand-green)' }}>
                                                    What's Next?
                                                </div>
                                                <div style={{ fontSize: '0.8rem', opacity: 0.9, lineHeight: '1.4' }}>
                                                    • Strategy is saved and ready to use<br />
                                                    • You can run new backtests with the optimized strategy<br />
                                                    • Consider starting a new optimization session for further improvements
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}

                                    {/* What Happens Next - For Running Sessions */}
                                    {sessionData.status === 'running' && (
                                        <div className="panel" style={{ border: '1px solid var(--brand-blue)', background: 'rgba(59, 130, 246, 0.05)' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                                                <Info size={20} color="var(--brand-blue)" />
                                                <h3 style={{ margin: 0, color: 'var(--brand-blue)' }}>What's Happening Now</h3>
                                            </div>

                                            <div style={{ fontSize: '0.9rem', lineHeight: '1.5', marginBottom: '1rem' }}>
                                                {sessionData.current?.includes('AI') && (
                                                    <>🤖 <strong>AI Generation:</strong> Creating improved strategy logic based on previous results and feedback</>
                                                )}
                                                {sessionData.current?.includes('Saving') && (
                                                    <>💾 <strong>Strategy Save:</strong> Approved code is being saved to the backtesting service</>
                                                )}
                                                {(sessionData.current?.includes('backtest') || sessionData.current?.includes('optimization')) && (
                                                    <>⚡ <strong>Deep Optimization:</strong> Running comprehensive backtests to find optimal parameters and measure performance</>
                                                )}
                                                {sessionData.current?.includes('Waiting') && (
                                                    <>⏳ <strong>Awaiting Review:</strong> New proposal is ready for your approval or feedback</>
                                                )}
                                            </div>

                                            <div style={{ padding: '0.75rem', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '8px', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                                                <div style={{ fontSize: '0.8rem', fontWeight: 'bold', marginBottom: '0.5rem', color: 'var(--brand-blue)' }}>
                                                    Next Steps
                                                </div>
                                                <div style={{ fontSize: '0.8rem', opacity: 0.9, lineHeight: '1.4' }}>
                                                    {sessionData.current?.includes('AI') && "• Wait for AI to complete proposal generation\n• Review the new proposal when ready"}
                                                    {sessionData.current?.includes('Saving') && "• Strategy save will complete automatically\n• Backtesting will start immediately after"}
                                                    {(sessionData.current?.includes('backtest') || sessionData.current?.includes('optimization')) && "• Deep optimization is running automatically\n• Results will appear in iteration history\n• Next AI proposal will be generated after completion"}
                                                    {sessionData.current?.includes('Waiting') && "• Review the proposal above\n• Approve, edit, or provide feedback for refinement"}
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {sessionData.best_code && sessionData.status !== 'completed' && (
                                        <div className="panel" style={{ border: '1px solid var(--brand-green)' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
                                                <Zap size={20} color="var(--brand-green)" />
                                                <h3 style={{ margin: 0 }}>Optimal Logic Blueprint</h3>
                                            </div>
                                            <textarea className="code-editor" style={{ height: '500px', width: '100%', fontSize: '0.8rem' }} value={sessionData.best_code} readOnly />
                                        </div>
                                    )}
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                    <h4 style={{ margin: 0, fontSize: '0.7rem', opacity: 0.5, letterSpacing: '1px' }}>ITERATION HISTORY</h4>

                                    {/* Action Timeline */}
                                    {sessionData.status === 'running' && sessionData.iterations.length > 0 && (
                                        <div style={{ padding: '1rem', background: 'var(--bg-accent)', borderRadius: '12px', border: '1px solid var(--border-subtle)' }}>
                                            <div style={{ fontSize: '0.75rem', opacity: 0.6, marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
                                                Current Round Progress
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
                                                    <CheckCircle2 size={12} color="var(--brand-green)" />
                                                    <span>Proposal generated & approved</span>
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
                                                    <CheckCircle2 size={12} color="var(--brand-green)" />
                                                    <span>Strategy saved to backtesting service</span>
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
                                                    {sessionData.current?.includes('backtest') || sessionData.current?.includes('optimization') ? (
                                                        <>
                                                            <RefreshCw className="animate-spin" size={12} color="var(--brand-blue)" />
                                                            <span style={{ color: 'var(--brand-blue)' }}>Running deep optimization backtest...</span>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <div style={{ width: '12px', height: '12px', borderRadius: '50%', border: '2px solid var(--border-subtle)' }} />
                                                            <span style={{ opacity: 0.5 }}>Awaiting backtest results</span>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Performance Trend Chart */}
                                    {sessionData.iterations.length > 1 && (
                                        <div style={{ padding: '1rem', background: 'var(--bg-accent)', borderRadius: '12px', border: '1px solid var(--border-subtle)' }}>
                                            <div style={{ fontSize: '0.75rem', opacity: 0.6, marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
                                                Performance Trend
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                                {sessionData.iterations.slice(-5).map((iter, idx) => {
                                                    const maxRoi = Math.max(...sessionData.iterations.map(i => i.roi));
                                                    const minRoi = Math.min(...sessionData.iterations.map(i => i.roi));
                                                    const range = maxRoi - minRoi || 1;
                                                    const width = ((iter.roi - minRoi) / range) * 100;

                                                    return (
                                                        <div key={iter.iteration} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                            <span style={{ fontSize: '0.7rem', opacity: 0.6, minWidth: '20px' }}>R{iter.iteration}</span>
                                                            <div style={{ flex: 1, height: '6px', background: 'var(--bg-dark)', borderRadius: '3px', overflow: 'hidden' }}>
                                                                <div
                                                                    style={{
                                                                        width: `${Math.max(width, 5)}%`,
                                                                        height: '100%',
                                                                        background: iter.is_improvement ? 'var(--brand-green)' : 'var(--brand-red)',
                                                                        transition: 'width 0.3s ease'
                                                                    }}
                                                                />
                                                            </div>
                                                            <span style={{
                                                                fontSize: '0.7rem',
                                                                fontWeight: 'bold',
                                                                color: iter.roi >= 0 ? 'var(--brand-green)' : 'var(--brand-red)',
                                                                minWidth: '45px',
                                                                textAlign: 'right'
                                                            }}>
                                                                {iter.roi >= 0 ? '+' : ''}{iter.roi.toFixed(1)}%
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Iteration Results */}
                                    {[...sessionData.iterations].reverse().map((iter, idx) => (
                                        <div key={idx} style={{ padding: '1rem', background: 'var(--bg-card)', borderRadius: '14px', border: '1px solid var(--border-subtle)', borderLeft: `5px solid ${iter.is_improvement ? 'var(--brand-green)' : 'var(--brand-red)'}` }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span style={{ fontWeight: 'bold' }}>Round {iter.iteration}</span>
                                                <div style={{ fontSize: '1.1rem', fontWeight: '900', color: iter.roi >= 0 ? 'var(--brand-green)' : 'var(--brand-red)' }}>{iter.roi >= 0 ? '+' : ''}{iter.roi.toFixed(2)}%</div>
                                            </div>
                                            {iter.reasoning && <p style={{ fontSize: '0.75rem', opacity: 0.7, margin: '8px 0', lineHeight: 1.4 }}>&ldquo;{iter.reasoning}&rdquo;</p>}
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px' }}>
                                                <div style={{ display: 'flex', gap: '0.8rem', fontSize: '0.7rem' }}>
                                                    <span style={{ opacity: 0.5 }}>DD: <b style={{ color: 'var(--text-primary)' }}>{iter.stats.max_drawdown}%</b></span>
                                                    <span style={{ opacity: 0.5 }}>Win: <b style={{ color: 'var(--text-primary)' }}>{iter.stats.win_rate}%</b></span>
                                                </div>
                                                <button className="btn btn-ghost btn-xs" onClick={() => setViewingCode({ iteration: iter.iteration, code: iter.code })}>Source</button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <AnimatePresence>
                {viewingCode && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="modal-overlay" onClick={() => setViewingCode(null)}>
                        <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="panel" style={{ width: '80%', maxWidth: '1000px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                                <h3 style={{ margin: 0 }}>Round {viewingCode.iteration} Logic State</h3>
                                <button className="btn btn-ghost" onClick={() => setViewingCode(null)}><X size={20} /></button>
                            </div>
                            <textarea className="code-editor" style={{ flex: 1, fontSize: '0.8rem' }} value={viewingCode.code} readOnly />
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default AgenticImprovement;
