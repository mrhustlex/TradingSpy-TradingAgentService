import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { RefreshCw, Wand2, Save, Play, CheckCircle, XCircle, AlertTriangle, ShieldCheck, Upload, Link, FileText } from 'lucide-react';
import { motion } from 'framer-motion';
import { BACKTEST_SERVICE, DATA_SERVICE } from '../config';
import ForgeTaskIndicator from './ForgeTaskIndicator';
import { formatDatasetName } from '../utils/formatters';
import { getApiSettings } from '../utils/apiKeyHelper';
import useGenerationStream from '../hooks/useGenerationStream';
import { normalizeReadableContent, renderReadableMarkdown } from '../utils/readableMarkdown';

const AIForge = ({ onTrigger, onRefreshStrats, tasks, notify, files, strategies = [] }) => {
    const [prompt, setPrompt] = useState('');
    const [count, setCount] = useState('1');
    const [generatedStrats, setGeneratedStrats] = useState([]); // Array of {name, code, class_name}
    const [activeTaskId, setActiveTaskId] = useState(null);
    const [mode, setMode] = useState(() => files?.length > 0 ? 'pattern_fit' : 'user_defined');
    const [lookback, setLookback] = useState(100);
    const [saving, setSaving] = useState(false);
    const [selectedFile, setSelectedFile] = useState('');
    const [datasetMeta, setDatasetMeta] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [targetCategory, setTargetCategory] = useState('General');
    const [currentPage, setCurrentPage] = useState(1);
    const [isRefining, setIsRefining] = useState(false);
    const [testingStates, setTestingStates] = useState({}); // Track testing state for each strategy
    const [uploadMode, setUploadMode] = useState('file'); // 'file' or 'url'
    const [uploadedCode, setUploadedCode] = useState('');
    const [uploadFileName, setUploadFileName] = useState('');
    const [fetchUrl, setFetchUrl] = useState('');
    const [fetchingUrl, setFetchingUrl] = useState(false);
    const resultsPerPage = 10;
    const handledTaskRef = useRef(null);
    const generationStream = useGenerationStream(activeTaskId);

    const liveProgressData = useMemo(() => {
        if (!activeTaskId) return null;
        return {
            progress: generationStream.progress,
            current: generationStream.current,
            stream_preview: generationStream.streamPreview,
            market_analysis: generationStream.marketAnalysis,
        };
    }, [activeTaskId, generationStream]);

    // Auto-fetch metadata for selected file
    useEffect(() => {
        if (!selectedFile) return;
        const fetchMeta = async () => {
            try {
                const res = await axios.get(`${DATA_SERVICE}/data/${selectedFile}/meta`);
                setDatasetMeta(res.data);
                if (res.data.ticker) setTargetCategory(res.data.ticker);
            } catch (e) {
                console.error("Failed to fetch metadata", e);
            }
        };
        fetchMeta();
    }, [selectedFile]);

    // Initialize first file
    useEffect(() => {
        if (files && files.length > 0 && !selectedFile) {
            setSelectedFile(files[0]);
        }
    }, [files]);

    const applyGenerationResults = async (taskLike) => {
        const results = taskLike.results || {};
        const strategiesList = (results.strategies
            || (results.response?.strategies)
            || (Array.isArray(results.actions) && results.actions.find(a => a?.strategies)?.strategies)
            || []);
        if (strategiesList.length > 0) {
            setGeneratedStrats(strategiesList);
            setCurrentPage(1);
            notify(`Generated ${strategiesList.length} strategy variants!`, 'green');
        } else if (results.code) {
            setGeneratedStrats([{
                name: 'AI Strategy',
                code: results.code,
                class_name: results.code.match(/class\s+(\w+)\s*\(/)?.[1] || 'MyStrategy',
                ticker: results.ticker || datasetMeta?.ticker
            }]);
            notify("Strategy generated successfully!", 'green');
        } else if (taskLike.saved_names?.length > 0) {
            notify("Loading saved strategies...", 'blue');
            try {
                const fetched = await Promise.all(taskLike.saved_names.map(async (name) => {
                    const r = await axios.get(`${BACKTEST_SERVICE}/strategies/${encodeURIComponent(name)}`);
                    return r.data;
                }));
                setGeneratedStrats(fetched);
                setCurrentPage(1);
                notify(`Loaded ${fetched.length} saved strategies!`, 'green');
            } catch (e) {
                notify("Strategies auto-saved to Battle Station Arsenal! Click the dropdown to see them.", 'green');
            }
        }
        setActiveTaskId(null);
        onRefreshStrats?.();
        if (taskLike.saved_names?.length > 0 && (datasetMeta?.ticker || targetCategory)) {
            notify(`✅ ${taskLike.saved_names.length} strategies saved to Battle Station — check the "${datasetMeta?.ticker || targetCategory}" group in Arsenal.`, 'green');
        }
        requestAnimationFrame(() => {
            const el = document.getElementById('generated-strats');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    };

    // Watch for task completion
    useEffect(() => {
        if (!activeTaskId) return;
        const task = tasks.find(t => t.id === activeTaskId);
        if (!task) return;
        if (task.status === 'completed' && handledTaskRef.current !== `${task.id}:completed`) {
            handledTaskRef.current = `${task.id}:completed`;
            applyGenerationResults(task);
        } else if (task && (task.status === 'failed' || (typeof task.status === 'string' && task.status.startsWith('failed')))) {
            notify("Generation failed: " + (task.error || task.status), 'red');
            setActiveTaskId(null);
        }
    }, [tasks, activeTaskId]);

    useEffect(() => {
        if (!activeTaskId) return;
        if (generationStream.status === 'completed' && handledTaskRef.current !== `${activeTaskId}:stream-complete`) {
            handledTaskRef.current = `${activeTaskId}:stream-complete`;
            applyGenerationResults({
                id: activeTaskId,
                results: generationStream.results,
                saved_names: generationStream.savedNames,
            });
        } else if (generationStream.status === 'failed' && handledTaskRef.current !== `${activeTaskId}:stream-failed`) {
            handledTaskRef.current = `${activeTaskId}:stream-failed`;
            notify("Generation failed: " + (generationStream.error || 'Unknown error'), 'red');
            setActiveTaskId(null);
        }
    }, [activeTaskId, generationStream.status, generationStream.results, generationStream.savedNames, generationStream.error]);

    const generateCode = async () => {
        if (!prompt) return;
        const strategyCount = parseInt(count, 10);
        if (!Number.isFinite(strategyCount) || strategyCount < 1) {
            notify('Enter the number of strategies to generate.', 'blue');
            return;
        }

        const { provider, model, api_key } = getApiSettings();
        if (!api_key) {
            notify('⚠️ No API key configured. Go to Setup in the sidebar to add your API key.', 'red');
            return;
        }

        const datasetContext = datasetMeta ? `
Target Dataset Characteristics:
- Ticker/Symbol: ${datasetMeta.ticker || 'Unknown'}
- Interval: ${datasetMeta.interval || 'Unknown'}
- Data Range: ${datasetMeta.start} to ${datasetMeta.end}
- Bar Count: ${datasetMeta.total_bars}
Please optimize the strategy logic specifically for this dataset's characteristics.
` : '';

        try {
            console.log('📤 [AIForge] Sending generate request:', {
                provider,
                model,
                hasApiKey: !!api_key,
                promptPreview: prompt.substring(0, 50)
            });
            
            const res = await axios.post(`${BACKTEST_SERVICE}/ai/generate`, {
                prompt: prompt + datasetContext,
                count: strategyCount,
                ticker: datasetMeta?.ticker,
                dataset_filename: mode === 'pattern_fit' ? selectedFile : null,
                mode: mode,
                learn_lookback: parseInt(lookback),
                target_category: targetCategory,
                provider,
                model,
                api_key
            });

            setActiveTaskId(res.data.task_id);
            handledTaskRef.current = null;
            onTrigger(res.data.task_id, 'forge', `Generate: ${strategyCount} strategies for ${datasetMeta?.ticker || 'General'}`);

        } catch (e) {
            notify(e.response?.data?.detail || "AI Request failed.", 'red');
        }
    };

    const saveOne = async (strat) => {
        try {
            await axios.post(`${BACKTEST_SERVICE}/strategies/custom`, {
                ...strat,
                ticker: strat.ticker || datasetMeta?.ticker || targetCategory,
                category: targetCategory,
                description: strat.description
            });
            onRefreshStrats();
            notify(`Saved "${strat.name}" categorized for ${strat.ticker || datasetMeta?.ticker || targetCategory || 'General'}`, 'green');
            return true;
        } catch (e) {
            notify(`Save failed for "${strat.name}"`, 'red');
            return false;
        }
    };

    const saveAll = async () => {
        setSaving(true);
        let success = 0;
        let skipped = 0;
        for (let i = 0; i < generatedStrats.length; i++) {
            if (testingStates[i]?.status === 'error') {
                skipped++;
                continue;
            }
            if (await saveOne(generatedStrats[i])) success++;
        }

        if (skipped > 0) {
            notify(`Batch save: ${success} saved. ${skipped} skipped due to code issues.`, 'blue');
        } else {
            notify(`Batch save complete: ${success}/${generatedStrats.length} secured.`, 'blue');
        }
        setSaving(false);
    };

    const testCode = async (strat, stratIndex) => {
        setTestingStates(prev => ({ ...prev, [stratIndex]: { status: 'testing', message: 'Validating code...' } }));

        try {
            const response = await axios.post(`${BACKTEST_SERVICE}/strategies/validate`, {
                code: strat.code,
                class_name: strat.class_name
            }, { timeout: 15000 });

            if (response.data.valid) {
                setTestingStates(prev => ({
                    ...prev,
                    [stratIndex]: {
                        status: 'success',
                        message: 'Code is valid and ready for backtesting!',
                        details: response.data.details
                    }
                }));
                notify(`✓ "${strat.name}" code validation passed`, 'green');
                return true;
            } else {
                setTestingStates(prev => ({
                    ...prev,
                    [stratIndex]: {
                        status: 'error',
                        message: response.data.error || 'Code validation failed',
                        details: response.data.details
                    }
                }));
                notify(`✗ "${strat.name}" has code issues`, 'red');
                return false;
            }
        } catch (error) {
            const errorMessage = error.response?.data?.detail || error.message || 'Test failed';
            setTestingStates(prev => ({
                ...prev,
                [stratIndex]: {
                    status: 'error',
                    message: errorMessage,
                    details: error.response?.data?.details
                }
            }));
            notify(`Test failed for "${strat.name}": ${errorMessage}`, 'red');
            return false;
        }
    };

    const validateAll = async () => {
        if (generatedStrats.length === 0) return;
        notify(`Starting batch validation for ${generatedStrats.length} strategies...`, 'blue');
        let success = 0, failure = 0;
        for (let i = 0; i < generatedStrats.length; i++) {
            if (await testCode(generatedStrats[i], i)) success++; else failure++;
        }
        notify(failure > 0 ? `Batch validation: ${success} passed, ${failure} failed` : `All ${success} strategies passed validation!`, failure > 0 ? 'blue' : 'green');
    };

    const clearTestResult = (stratIndex) => {
        setTestingStates(prev => {
            const newState = { ...prev };
            delete newState[stratIndex];
            return newState;
        });
    };

    const parseClassName = (code) => {
        const match = code.match(/class\s+(\w+)\s*\(/);
        return match ? match[1] : 'MyStrategy';
    };

    const parseStrategyName = (code) => {
        const cn = parseClassName(code);
        return cn.replace(/([A-Z])/g, ' $1').trim().split(' ').slice(0, 4).join(' ');
    };

    const handleFileUpload = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.name.endsWith('.py')) {
            notify('Only .py files are supported', 'red');
            return;
        }
        setUploadFileName(file.name);
        const reader = new FileReader();
        reader.onload = (ev) => {
            const code = ev.target?.result || '';
            setUploadedCode(code);
        };
        reader.readAsText(file);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        if (!file.name.endsWith('.py')) {
            notify('Only .py files are supported', 'red');
            return;
        }
        setUploadFileName(file.name);
        const reader = new FileReader();
        reader.onload = (ev) => {
            const code = ev.target?.result || '';
            setUploadedCode(code);
        };
        reader.readAsText(file);
    };

    const handleDragOver = (e) => e.preventDefault();

    const fetchFromUrl = async () => {
        if (!fetchUrl) return;
        setFetchingUrl(true);
        try {
            const res = await axios.get(fetchUrl, { timeout: 15000 });
            const code = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
            setUploadedCode(code);
            setUploadFileName(fetchUrl.split('/').pop() || 'strategy.py');
            notify('Code fetched successfully', 'green');
        } catch (e) {
            notify('Failed to fetch code from URL', 'red');
        }
        setFetchingUrl(false);
    };

    const injectUploadedCode = () => {
        if (!uploadedCode) return;
        const cn = parseClassName(uploadedCode);
        const sn = parseStrategyName(uploadedCode);
        const newStrat = {
            name: sn,
            code: uploadedCode,
            class_name: cn,
            ticker: datasetMeta?.ticker || targetCategory,
            description: `Uploaded strategy from ${uploadFileName || fetchUrl || 'source'}`
        };
        setGeneratedStrats([newStrat]);
        setCurrentPage(1);
        setUploadedCode('');
        setUploadFileName('');
        setFetchUrl('');
        notify('Strategy loaded from upload', 'green');
    };

    const refineIntent = async () => {
        if (!prompt) {
            notify("Type a basic idea first, then click the wand!", "blue");
            return;
        }

        setIsRefining(true);
        try {
            const res = await axios.post(`${BACKTEST_SERVICE}/ai/refine-intent`, {
                intent: prompt
            });
            setPrompt(res.data.refined_intent);
            notify("Intent refined by AI!", "green");
        } catch (e) {
            notify("Refinement failed.", "red");
        }
        setIsRefining(false);
    };

    return (
        <div className="forge-container">
            <div>
                <h1 style={{ marginBottom: '2rem' }}>Strategy Generator</h1>
                <div className="panel">
                    <div className="form-row">
                        <div className="form-group" style={{ flex: 0.5, minWidth: '120px' }}>
                            <label>Number of Strategies</label>
                            <input
                                className="input"
                                type="number"
                                min="1"
                                step="1"
                                value={count}
                                onChange={(e) => setCount(e.target.value)}
                                placeholder="e.g. 5"
                                disabled={activeTaskId}
                            />
                        </div>
                        <div className="form-group" style={{ flex: 2, minWidth: '350px' }}>
                            <label>Generation Mode</label>
                            <div style={{ display: 'flex', gap: '0.4rem' }}>
                                <button className={`btn ${mode === 'pattern_fit' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('pattern_fit')} style={{ flex: 1, padding: '0.5rem', fontSize: '0.85rem' }} disabled={activeTaskId}>Fit to Dataset</button>
                                <button className={`btn ${mode === 'user_defined' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('user_defined')} style={{ flex: 1, padding: '0.5rem', fontSize: '0.85rem' }} disabled={activeTaskId}>Prompt Only</button>
                                <button className={`btn ${mode === 'random_agnostic' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('random_agnostic')} style={{ flex: 1, padding: '0.5rem', fontSize: '0.85rem' }} disabled={activeTaskId}>Explore Ideas</button>
                                <button className={`btn ${mode === 'upload' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('upload')} style={{ flex: 1, padding: '0.5rem', fontSize: '0.85rem' }}>Import Code</button>
                            </div>
                            <div style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: '0.5rem', lineHeight: 1.4 }}>
                                {mode === 'pattern_fit' && 'Uses the selected dataset and lookback window before generating code.'}
                                {mode === 'user_defined' && 'Follows your written rules directly; no chart pattern fitting.'}
                                {mode === 'random_agnostic' && 'Invents diverse strategy ideas; prompt is optional inspiration.'}
                                {mode === 'upload' && 'Imports existing Python into the editable result editor for validation and saving.'}
                            </div>
                        </div>
                        <div className="form-group" style={{ flex: 1 }}>
                            <label>Target Category</label>
                            <input
                                className="input"
                                value={targetCategory}
                                onChange={(e) => setTargetCategory(e.target.value)}
                                placeholder="e.g. QQQ, Scalping..."
                                disabled={activeTaskId}
                            />
                        </div>
                    </div>

                    <div style={{ marginTop: '1.5rem', display: 'flex', gap: '2rem' }}>
                        {mode === 'pattern_fit' && (
                            <div style={{ flex: 1 }}>
                                <h3>1. Select Reference Ticker</h3>
                                <p style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '0.75rem' }}>The AI will analyze this dataset's characteristics to fit the strategy.</p>
                                {datasetMeta && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', padding: '0.65rem 0.85rem', background: 'var(--bg-accent)', borderRadius: 'var(--radius)', border: '1px solid var(--border-subtle)' }}>
                                        <span style={{ fontWeight: 800, fontSize: '1.1rem' }}>{datasetMeta.ticker || '—'}</span>
                                        <span className="badge badge-blue" style={{ fontSize: '0.65rem' }}>{datasetMeta.interval || '—'}</span>
                                        <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>{datasetMeta.total_bars || '—'} bars</span>
                                        <span style={{ fontSize: '0.7rem', opacity: 0.5, marginLeft: 'auto' }}>{datasetMeta.start} – {datasetMeta.end}</span>
                                    </div>
                                )}
                                <select
                                    className="input"
                                    value={selectedFile}
                                    onChange={(e) => setSelectedFile(e.target.value)}
                                    style={{ borderColor: 'var(--brand-blue)', fontWeight: 'bold' }}
                                    disabled={activeTaskId}
                                >
                                    <option value="">Select Target...</option>
                                    {files.map(f => <option key={f} value={f}>{formatDatasetName(f)}</option>)}
                                </select>
                                
                                <div style={{ marginTop: '1.5rem' }}>
                                    <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                                        <span>Learning Depth</span>
                                        <span style={{ color: 'var(--brand-blue)', fontWeight: 'bold' }}>{lookback} Bars</span>
                                    </label>
                                    <input
                                        type="range"
                                        min="20"
                                        max="500"
                                        step="10"
                                        value={lookback}
                                        onChange={(e) => setLookback(e.target.value)}
                                        style={{ width: '100%', accentColor: 'var(--brand-blue)' }}
                                        disabled={activeTaskId}
                                    />
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', opacity: 0.5, marginTop: '0.25rem' }}>
                                        <span>Shallow (20b)</span>
                                        <span>Deep (500b)</span>
                                    </div>
                                </div>


                            </div>
                        )}

                        <div style={{ flex: mode === 'pattern_fit' ? 2 : 1 }}>
                            {mode === 'upload' ? (
                                <>
                                    <h3 style={{ margin: '0 0 0.5rem 0' }}>Upload Strategy Code</h3>
                                    <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
                                        <button className={`btn btn-xs ${uploadMode === 'file' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setUploadMode('file')} style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}>
                                            <Upload size={12} /> File
                                        </button>
                                        <button className={`btn btn-xs ${uploadMode === 'url' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setUploadMode('url')} style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}>
                                            <Link size={12} /> URL
                                        </button>
                                    </div>
                                    {uploadMode === 'file' ? (
                                        <div
                                            onDrop={handleDrop}
                                            onDragOver={handleDragOver}
                                            onClick={() => document.getElementById('forge-file-input')?.click()}
                                            style={{
                                                border: '2px dashed var(--border-subtle)',
                                                borderRadius: 'var(--radius)',
                                                padding: '2rem',
                                                textAlign: 'center',
                                                cursor: 'pointer',
                                                transition: 'border-color 0.2s',
                                                marginBottom: '0.75rem'
                                            }}
                                            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--brand-blue)'}
                                            onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
                                        >
                                            <Upload size={32} style={{ opacity: 0.4, marginBottom: '0.5rem' }} />
                                            <p style={{ margin: 0, fontSize: '0.85rem', opacity: 0.7 }}>Drop a <strong>.py</strong> file here or click to browse</p>
                                            <input
                                                id="forge-file-input"
                                                type="file"
                                                accept=".py"
                                                onChange={handleFileUpload}
                                                style={{ display: 'none' }}
                                            />
                                        </div>
                                    ) : (
                                        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                            <input
                                                className="input"
                                                style={{ flex: 1, height: '36px', fontSize: '0.85rem' }}
                                                placeholder="https://raw.githubusercontent.com/.../strategy.py"
                                                value={fetchUrl}
                                                onChange={e => setFetchUrl(e.target.value)}
                                            />
                                            <button
                                                className="btn btn-primary btn-sm"
                                                onClick={fetchFromUrl}
                                                disabled={fetchingUrl || !fetchUrl}
                                                style={{ whiteSpace: 'nowrap' }}
                                            >
                                                {fetchingUrl ? <RefreshCw className="animate-spin" size={14} /> : <Link size={14} />}
                                                Fetch
                                            </button>
                                        </div>
                                    )}
                                    {uploadedCode && (
                                        <div style={{ background: 'var(--bg-accent)', borderRadius: 'var(--radius)', padding: '0.75rem', marginBottom: '0.75rem' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
                                                    <FileText size={14} />
                                                    <span style={{ fontWeight: 600 }}>{uploadFileName || 'strategy.py'}</span>
                                                    <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>({uploadedCode.length} chars)</span>
                                                </div>
                                                <div style={{ display: 'flex', gap: '0.4rem' }}>
                                                    <button className="btn btn-ghost btn-xs" onClick={() => { setUploadedCode(''); setUploadFileName(''); }}>
                                                        Clear
                                                    </button>
                                                    <button className="btn btn-primary btn-xs" onClick={injectUploadedCode}>
                                                        <Play size={12} /> Load into Editor
                                                    </button>
                                                </div>
                                            </div>
                                            <pre style={{ fontSize: '0.7rem', maxHeight: '120px', overflow: 'auto', background: 'rgba(0,0,0,0.2)', padding: '0.5rem', borderRadius: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                                {uploadedCode.slice(0, 800)}{uploadedCode.length > 800 ? '\n...' : ''}
                                            </pre>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                        <h3 style={{ margin: 0 }}>{mode === 'random_agnostic' ? 'Strategic Inspiration' : mode === 'pattern_fit' ? 'Pattern-Fit Intent' : 'Strategy Rules'}</h3>
                                        <button
                                            className="btn btn-ghost btn-xs"
                                            style={{ color: 'var(--brand-yellow)', gap: '0.25rem', fontSize: '0.75rem' }}
                                            onClick={refineIntent}
                                            disabled={isRefining || activeTaskId}
                                        >
                                            {isRefining ? <RefreshCw className="animate-spin" size={12} /> : <Wand2 size={12} />}
                                            Refine with AI
                                        </button>
                                    </div>
                                    <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                                        <textarea
                                            className="input"
                                            style={{ height: mode === 'pattern_fit' ? '195px' : '140px' }}
                                            placeholder={
                                                mode === 'pattern_fit' ? "Identify specific patterns in the selected bars, e.g. mean reversion after RSI oversold near SMA support..." :
                                                    mode === 'user_defined' ? "Write exact rules, e.g. buy when EMA20 crosses above EMA50 and RSI > 55; close below EMA20..." :
                                                        "Leave blank for full AI creativity or provide a theme like 'Aggressive Volatility Scalping'..."
                                            }
                                            value={prompt}
                                            onChange={(e) => setPrompt(e.target.value)}
                                            disabled={activeTaskId}
                                        />
                                    </div>
                                </>
                            )}
                        </div>
                    </div>

                    {mode !== 'upload' && (
                    <button
                        className="btn btn-primary"
                        style={{ marginTop: '2rem', width: '100%', height: '50px', fontSize: '1.1rem' }}
                        onClick={generateCode}
                        disabled={activeTaskId}
                    >
                        {activeTaskId ? <RefreshCw className="animate-spin" size={20} /> : <Wand2 size={20} />}
                        {activeTaskId ? 'Generating...' :
                            mode === 'pattern_fit' ? (parseInt(count, 10) > 1 ? `Generate ${count} Strategies for ${datasetMeta?.ticker || 'Market'}` : `Generate Strategy from Chart`) :
                                mode === 'user_defined' ? `Generate My Strategy` :
                                    `Generate Random Strategies`}
                    </button>
                    )}

                    {activeTaskId && <ForgeTaskIndicator tasks={tasks} activeTaskId={activeTaskId} progressData={liveProgressData} />}
                </div>

                {generatedStrats.length > 0 && (
                    <div id="generated-strats" style={{ marginTop: '2rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '1.5rem' }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                                    <h3>Generated Strategies</h3>
                                    <div style={{ fontSize: '0.8rem', color: 'var(--brand-blue)', fontWeight: 'bold' }}>
                                        TARGET: {datasetMeta?.ticker || targetCategory || 'GENERAL'}
                                    </div>
                                </div>
                                <input
                                    className="input"
                                    style={{ width: '250px', height: '32px', fontSize: '0.8rem' }}
                                    placeholder="Search strategies..."
                                    value={searchTerm}
                                    onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                                />
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <button className="btn btn-ghost btn-sm" onClick={() => setGeneratedStrats([])}>Clear All</button>
                                {generatedStrats.length > 1 && (
                                    <>
                                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--brand-blue)' }} onClick={validateAll}>
                                            <ShieldCheck size={18} /> Validate All
                                        </button>
                                        <button className="btn btn-primary" onClick={saveAll} disabled={saving}>
                                            <Save size={18} /> Save All {generatedStrats.length} Arsenal
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>

                        {(() => {
                            const filtered = generatedStrats.filter(s =>
                                (s.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                                (s.description || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                                (normalizeReadableContent(s.analysis).toLowerCase().includes(searchTerm.toLowerCase()))
                            );
                            const totalPages = Math.ceil(filtered.length / resultsPerPage);
                            const currentStrats = filtered.slice((currentPage - 1) * resultsPerPage, currentPage * resultsPerPage);

                            return (
                                <>
                                    {currentStrats.map((strat, idx) => {
                                        const originalIdx = generatedStrats.findIndex(s => s === strat);
                                        return (
                                            <motion.div key={originalIdx} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="panel" style={{ marginBottom: '1rem' }}>
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
                                                    {/* Row 1: Technical Meta */}
                                                    <div style={{ display: 'flex', gap: '1rem', width: '100%' }}>
                                                        <div className="form-group" style={{ flex: 2 }}>
                                                            <label>Strategy Name</label>
                                                            <input className="input" value={strat.name} onChange={(e) => {
                                                                const newStrats = [...generatedStrats];
                                                                newStrats[originalIdx].name = e.target.value;
                                                                setGeneratedStrats(newStrats);
                                                            }} />
                                                        </div>
                                                        <div className="form-group" style={{ flex: 1 }}>
                                                            <label>Class Name</label>
                                                            <input className="input" value={strat.class_name} onChange={(e) => {
                                                                const newStrats = [...generatedStrats];
                                                                newStrats[originalIdx].class_name = e.target.value;
                                                                setGeneratedStrats(newStrats);
                                                            }} />
                                                        </div>
                                                        <div className="form-group" style={{ flex: 1 }}>
                                                            <label>Ticker Category</label>
                                                            <input className="input" value={strat.ticker || datasetMeta?.ticker || targetCategory || 'General'} onChange={(e) => {
                                                                const newStrats = [...generatedStrats];
                                                                newStrats[originalIdx].ticker = e.target.value;
                                                                setGeneratedStrats(newStrats);
                                                            }} placeholder="e.g. QQQ, General" />
                                                        </div>
                                                        <div className="form-group" style={{ alignSelf: 'flex-end', flex: 0.8, display: 'flex', gap: '0.5rem' }}>
                                                            <button
                                                                className="btn btn-ghost btn-sm"
                                                                onClick={() => testCode(strat, originalIdx)}
                                                                disabled={testingStates[originalIdx]?.status === 'testing'}
                                                                style={{
                                                                    color: testingStates[originalIdx]?.status === 'success' ? 'var(--brand-green)' :
                                                                        testingStates[originalIdx]?.status === 'error' ? 'var(--brand-red)' : 'var(--brand-blue)',
                                                                    borderColor: testingStates[originalIdx]?.status === 'success' ? 'var(--brand-green)' :
                                                                        testingStates[originalIdx]?.status === 'error' ? 'var(--brand-red)' : 'var(--brand-blue)',
                                                                    minWidth: '80px'
                                                                }}
                                                            >
                                                                {testingStates[originalIdx]?.status === 'testing' ? (
                                                                    <RefreshCw className="animate-spin" size={14} />
                                                                ) : testingStates[originalIdx]?.status === 'success' ? (
                                                                    <CheckCircle size={14} />
                                                                ) : testingStates[originalIdx]?.status === 'error' ? (
                                                                    <XCircle size={14} />
                                                                ) : (
                                                                    <Play size={14} />
                                                                )}
                                                                {testingStates[originalIdx]?.status === 'testing' ? 'Testing' :
                                                                    testingStates[originalIdx]?.status === 'success' ? 'Valid' :
                                                                        testingStates[originalIdx]?.status === 'error' ? 'Issues' : 'Test'}
                                                            </button>
                                                            <button
                                                                className="btn"
                                                                onClick={() => saveOne(strat)}
                                                                disabled={testingStates[originalIdx]?.status === 'error'}
                                                                title={testingStates[originalIdx]?.status === 'error' ? "Fix issues first" : "Save Strategy"}
                                                            >
                                                                Save
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {/* Row 2: Description Textarea */}
                                                    <div className="form-group" style={{ width: '100%', flex: 'none' }}>
                                                        <label>Strategy Summary</label>
                                                        <textarea
                                                            className="input"
                                                            style={{ height: '70px', padding: '0.8rem', lineHeight: '1.4', resize: 'vertical' }}
                                                            value={strat.description}
                                                            onChange={(e) => {
                                                                const newStrats = [...generatedStrats];
                                                                newStrats[originalIdx].description = e.target.value;
                                                                setGeneratedStrats(newStrats);
                                                            }}
                                                        />
                                                    </div>
                                                </div>

                                                {/* Test Results Display */}
                                                {testingStates[originalIdx] && (
                                                    <div
                                                        style={{
                                                            marginBottom: '1rem',
                                                            padding: '1rem',
                                                            borderRadius: '8px',
                                                            background: testingStates[originalIdx].status === 'success' ? 'rgba(16, 185, 129, 0.1)' :
                                                                testingStates[originalIdx].status === 'error' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(59, 130, 246, 0.1)',
                                                            border: `1px solid ${testingStates[originalIdx].status === 'success' ? 'var(--brand-green)' :
                                                                testingStates[originalIdx].status === 'error' ? 'var(--brand-red)' : 'var(--brand-blue)'}`,
                                                            borderLeft: `4px solid ${testingStates[originalIdx].status === 'success' ? 'var(--brand-green)' :
                                                                testingStates[originalIdx].status === 'error' ? 'var(--brand-red)' : 'var(--brand-blue)'}`
                                                        }}
                                                    >
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                                            <div style={{ flex: 1 }}>
                                                                <div style={{
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    gap: '0.5rem',
                                                                    marginBottom: '0.5rem',
                                                                    fontSize: '0.85rem',
                                                                    fontWeight: 'bold',
                                                                    color: testingStates[originalIdx].status === 'success' ? 'var(--brand-green)' :
                                                                        testingStates[originalIdx].status === 'error' ? 'var(--brand-red)' : 'var(--brand-blue)'
                                                                }}>
                                                                    {testingStates[originalIdx].status === 'success' ? (
                                                                        <>
                                                                            <CheckCircle size={16} />
                                                                            Code Validation Passed
                                                                        </>
                                                                    ) : testingStates[originalIdx].status === 'error' ? (
                                                                        <>
                                                                            <XCircle size={16} />
                                                                            Code Validation Failed
                                                                        </>
                                                                    ) : (
                                                                        <>
                                                                            <AlertTriangle size={16} />
                                                                            Testing in Progress
                                                                        </>
                                                                    )}
                                                                </div>
                                                                <div style={{ fontSize: '0.8rem', marginBottom: '0.5rem', opacity: 0.9 }}>
                                                                    {testingStates[originalIdx].message}
                                                                </div>
                                                                {testingStates[originalIdx].details && (
                                                                    <div style={{
                                                                        fontSize: '0.75rem',
                                                                        fontFamily: 'monospace',
                                                                        background: 'rgba(0,0,0,0.2)',
                                                                        padding: '0.5rem',
                                                                        borderRadius: '4px',
                                                                        whiteSpace: 'pre-wrap',
                                                                        opacity: 0.8
                                                                    }}>
                                                                        {testingStates[originalIdx].details}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <button
                                                                className="btn btn-ghost btn-xs"
                                                                onClick={() => clearTestResult(originalIdx)}
                                                                style={{ opacity: 0.6 }}
                                                            >
                                                                ×
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}

                                                {strat.analysis && (
                                                    <div style={{ marginBottom: '1rem', padding: '1rem', background: 'rgba(59, 130, 246, 0.05)', borderRadius: '8px', borderLeft: '4px solid var(--brand-blue)' }}>
                                                        <div style={{ fontSize: '0.7rem', fontWeight: 'bold', textTransform: 'uppercase', color: 'var(--brand-blue)', marginBottom: '0.4rem' }}>
                                                            Market Pattern Analysis:
                                                        </div>
                                                        <div style={{ fontSize: '0.85rem', lineHeight: '1.4', margin: 0, opacity: 0.9 }}>
                                                            {renderReadableMarkdown(strat.analysis)}
                                                        </div>
                                                    </div>
                                                )}

                                                <textarea
                                                    className="code-editor"
                                                    style={{ height: '200px' }}
                                                    value={strat.code}
                                                    onChange={(e) => {
                                                        const newStrats = [...generatedStrats];
                                                        newStrats[originalIdx] = { ...newStrats[originalIdx], code: e.target.value };
                                                        setGeneratedStrats(newStrats);
                                                        setTestingStates(prev => {
                                                            const next = { ...prev };
                                                            delete next[originalIdx];
                                                            return next;
                                                        });
                                                    }}
                                                />
                                            </motion.div>
                                        );
                                    })}

                                    {totalPages > 1 && (
                                        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginTop: '1.5rem', alignItems: 'center' }}>
                                            <button className="btn btn-ghost btn-sm" disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)}>Prev</button>
                                            <span style={{ fontSize: '0.9rem' }}>Page {currentPage} of {totalPages}</span>
                                            <button className="btn btn-ghost btn-sm" disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)}>Next</button>
                                        </div>
                                    )}
                                </>
                            );
                        })()}
                    </div>
                )}
            </div>

            <div style={{ padding: '1rem' }}>
                <div className="panel">
                    <h3>Saved Strategies</h3>
                    <p style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: '1.5rem' }}>Your saved strategies, grouped by ticker.</p>

                    {Object.entries(strategies.reduce((acc, s) => {
                        const t = s.ticker || 'General';
                        if (!acc[t]) acc[t] = [];
                        acc[t].push(s);
                        return acc;
                    }, {})).map(([ticker, strats]) => (
                        <div key={ticker} className="performance-card" style={{ marginBottom: '0.75rem', borderLeft: '3px solid var(--brand-blue)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ fontWeight: '700' }}>{ticker}</div>
                                <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>{strats.length} Strategies</div>
                            </div>
                            <div style={{ fontSize: '0.7rem', marginTop: '4px', opacity: 0.8 }}>
                                {strats.map(s => s.name).slice(0, 3).join(', ')} {strats.length > 3 ? '...' : ''}
                            </div>
                        </div>
                    ))}

                    {strategies.length === 0 && (
                        <p style={{ textAlign: 'center', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>No strategies saved yet.</p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default AIForge;
