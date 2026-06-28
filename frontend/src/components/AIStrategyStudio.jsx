import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { 
  Wand2, 
  Cpu, 
  Search, 
  Code, 
  CheckCircle2, 
  Save, 
  Play, 
  RefreshCw, 
  ChevronRight, 
  Layout, 
  Layers, 
  Zap, 
  AlertCircle,
  ShieldCheck,
  FlaskConical,
  LineChart,
  BrainCircuit,
  Terminal,
  FileCode,
  History,
  Upload,
  Link,
  FileText,
  Square,
  ArrowLeft,
  Plus
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BACKTEST_SERVICE, DATA_SERVICE } from '../config';
import { getApiSettings } from '../utils/apiKeyHelper';
import { formatDatasetName } from '../utils/formatters';
import useGenerationStream from '../hooks/useGenerationStream';
import { renderReadableMarkdown } from '../utils/readableMarkdown';

const AIStrategyStudio = ({ onTrigger, onRefreshStrats, tasks, notify, files, strategies = [] }) => {
    // UI State
    const [step, setStep] = useState(1); // 1: Setup, 2: Forge, 3: Results
    const [activeTaskId, setActiveTaskId] = useState(null);
    const [generatedStrats, setGeneratedStrats] = useState([]);
    const [testingStates, setTestingStates] = useState({});
    
    // Form State
    const [prompt, setPrompt] = useState('');
    const [mode, setMode] = useState('pattern_fit');
    const [selectedFile, setSelectedFile] = useState('');
    const [count, setCount] = useState('3');
    const [lookback, setLookback] = useState(100);
    const [targetCategory, setTargetCategory] = useState('General');
    const [datasetMeta, setDatasetMeta] = useState(null);
    const [uploadMode, setUploadMode] = useState('file');
    const [uploadedCode, setUploadedCode] = useState('');
    const [uploadFileName, setUploadFileName] = useState('');
    const [fetchUrl, setFetchUrl] = useState('');
    const [fetchingUrl, setFetchingUrl] = useState(false);
    const [researchTypes, setResearchTypes] = useState({ web: true, papers: true });
    const [researchMaxSources, setResearchMaxSources] = useState(8);
    const [researchReadPages, setResearchReadPages] = useState(4);
    const [researchIncludeDomains, setResearchIncludeDomains] = useState('');
    const [researchExcludeDomains, setResearchExcludeDomains] = useState('');
    
    // Forge State
    const [marketAnalysis, setMarketAnalysis] = useState('');
    const [streamPreview, setStreamPreview] = useState('');
    const [currentStatus, setCurrentStatus] = useState('Idle');
    const [progress, setProgress] = useState(0);
    const [generationError, setGenerationError] = useState('');
    const [invalidCandidates, setInvalidCandidates] = useState([]);
    const [isCancelling, setIsCancelling] = useState(false);
    const [backtestingStates, setBacktestingStates] = useState({});
    const [researchSources, setResearchSources] = useState([]);
    const [comparisonState, setComparisonState] = useState({ status: 'idle', taskId: null, results: [] });
    const [improvingStates, setImprovingStates] = useState({});

    const resultsRef = useRef(null);
    const handledTaskRef = useRef(null);
    const generationStream = useGenerationStream(activeTaskId);

    const parseClassName = (code) => code.match(/class\s+(\w+)\s*\(/)?.[1] || 'MyStrategy';

    const parseStrategyName = (code) => {
        const className = parseClassName(code);
        return className.replace(/([A-Z])/g, ' $1').trim().split(' ').slice(0, 4).join(' ') || 'Uploaded Strategy';
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
        reader.onload = (ev) => setUploadedCode(ev.target?.result || '');
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
        reader.onload = (ev) => setUploadedCode(ev.target?.result || '');
        reader.readAsText(file);
    };

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

    const loadUploadedStrategy = () => {
        if (!uploadedCode) return;
        const className = parseClassName(uploadedCode);
        setGeneratedStrats([{
            name: parseStrategyName(uploadedCode),
            code: uploadedCode,
            class_name: className,
            ticker: datasetMeta?.ticker || targetCategory,
            description: `Uploaded strategy from ${uploadFileName || fetchUrl || 'source'}`
        }]);
        setStep(3);
        notify('Strategy loaded from upload', 'green');
    };

    const renderMarkdown = renderReadableMarkdown;

    // Auto-fetch metadata for selected file
    useEffect(() => {
        if (!selectedFile) return;
        const fetchMeta = async () => {
            try {
                const res = await axios.get(`${DATA_SERVICE}/data/${selectedFile}/meta`);
                const totalBars = Number(res.data.total_bars ?? res.data.rows ?? 0);
                const metadata = { ...res.data, total_bars: totalBars };
                setDatasetMeta(metadata);
                if (totalBars >= 20) {
                    setLookback(current => Math.min(Number(current) || 100, Math.min(500, totalBars)));
                }
                if (metadata.ticker) setTargetCategory(metadata.ticker);
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

    const applyGenerationResults = (taskLike) => {
        const results = taskLike.results || {};
        setProgress(100);
        setCurrentStatus('Generation complete');
        setResearchSources(results.research_sources || taskLike.research_sources || []);
        const strategiesList = (results.strategies
            || (results.response?.strategies)
            || (Array.isArray(results.actions) && results.actions.find(a => a?.strategies)?.strategies)
            || []);
        
        if (strategiesList.length > 0) {
            setGeneratedStrats(strategiesList);
            setStep(3);
            notify(`Studio: Successfully forged ${strategiesList.length} strategies!`, 'green');
        } else if (results.code) {
            setGeneratedStrats([{
                name: 'AI Studio Strategy',
                code: results.code,
                class_name: results.code.match(/class\s+(\w+)\s*\(/)?.[1] || 'MyStrategy',
                ticker: results.ticker || datasetMeta?.ticker
            }]);
            setStep(3);
            notify("Studio: Strategy forged successfully!", 'green');
        }
        setActiveTaskId(null);
        onRefreshStrats?.();
    };

    // Watch for task completion and progress
    useEffect(() => {
        if (!activeTaskId) return;
        const task = tasks.find(t => t.id === activeTaskId);
        if (!task) return;

        const progressData = task.progressData || {};
        setProgress(progressData.progress || 0);
        setCurrentStatus(progressData.current || 'Processing...');
        
        if (progressData.market_analysis && !marketAnalysis) {
            setMarketAnalysis(progressData.market_analysis);
        }
        if (progressData.research_sources?.length) {
            setResearchSources(progressData.research_sources);
        }
        
        if (progressData.stream_preview) {
            setStreamPreview(progressData.stream_preview);
        }

        if (task.status === 'completed' && handledTaskRef.current !== `${task.id}:completed`) {
            handledTaskRef.current = `${task.id}:completed`;
            applyGenerationResults(task);
        } else if (task.status?.startsWith('failed') && handledTaskRef.current !== `${task.id}:failed`) {
            handledTaskRef.current = `${task.id}:failed`;
            const error = task.error || task.status;
            setInvalidCandidates(progressData.invalid_candidates || []);
            setGenerationError(error);
            setCurrentStatus('Generation failed');
            notify("Forge failed: " + error, 'red');
            setActiveTaskId(null);
        }
    }, [tasks, activeTaskId]);

    useEffect(() => {
        if (!activeTaskId) return;

        if (generationStream.progress) setProgress(generationStream.progress);
        if (generationStream.current) setCurrentStatus(generationStream.current);
        if (generationStream.marketAnalysis) setMarketAnalysis(generationStream.marketAnalysis);
        if (generationStream.researchSources?.length) setResearchSources(generationStream.researchSources);
        if (generationStream.streamPreview) setStreamPreview(generationStream.streamPreview);

        if (generationStream.status === 'completed' && handledTaskRef.current !== `${activeTaskId}:stream-complete`) {
            handledTaskRef.current = `${activeTaskId}:stream-complete`;
            applyGenerationResults({
                id: activeTaskId,
                results: generationStream.results,
                saved_names: generationStream.savedNames,
            });
        } else if (generationStream.status === 'failed' && handledTaskRef.current !== `${activeTaskId}:failed`) {
            handledTaskRef.current = `${activeTaskId}:failed`;
            const error = generationStream.error || 'Unknown error';
            setInvalidCandidates(generationStream.invalidCandidates || []);
            setGenerationError(error);
            setCurrentStatus('Generation failed');
            notify("Forge failed: " + error, 'red');
            setActiveTaskId(null);
        }
    }, [activeTaskId, generationStream]);

    const startForge = async () => {
        const strategyCount = parseInt(count, 10);
        if (!Number.isFinite(strategyCount) || strategyCount < 1) {
            notify('Enter the number of strategies to generate.', 'blue');
            return;
        }

        const { provider, model, api_key, provider_config } = getApiSettings();
        if (!api_key) {
            notify('⚠️ No API key configured. Go to Setup to add it.', 'red');
            return;
        }

        const basePrompt = prompt.trim() || (
            mode === 'random_agnostic'
                ? 'Create original Backtrader strategies with distinct logic, risk controls, and clear explanations.'
                : mode === 'web_research'
                    ? 'Find documented public trading strategy ideas with explicit entry, exit, and risk-management rules.'
                : 'Create a robust Backtrader strategy for the selected market context.'
        );

        const datasetContext = datasetMeta ? `
Target Dataset Characteristics:
- Ticker/Symbol: ${datasetMeta.ticker || 'Unknown'}
- Interval: ${datasetMeta.interval || 'Unknown'}
- Data Range: ${datasetMeta.start} to ${datasetMeta.end}
- Bar Count: ${datasetMeta.total_bars}
Please optimize the strategy logic specifically for this dataset's characteristics.
` : '';

        setGenerationError('');
        setInvalidCandidates([]);
        try {
            const res = await axios.post(`${BACKTEST_SERVICE}/ai/generate`, {
                prompt: basePrompt + (mode === 'web_research' ? '' : datasetContext),
                count: strategyCount,
                ticker: datasetMeta?.ticker,
                dataset_filename: mode === 'pattern_fit' ? selectedFile : null,
                mode: mode,
                learn_lookback: parseInt(lookback),
                target_category: targetCategory,
                provider,
                model,
                api_key,
                provider_config,
                research_source_types: Object.entries(researchTypes).filter(([, enabled]) => enabled).map(([type]) => type),
                research_max_sources: Number(researchMaxSources),
                research_read_pages: Math.min(Number(researchReadPages), Number(researchMaxSources)),
                research_include_domains: researchIncludeDomains.split(',').map(value => value.trim()).filter(Boolean),
                research_exclude_domains: researchExcludeDomains.split(',').map(value => value.trim()).filter(Boolean),
            });

            setActiveTaskId(res.data.task_id);
            handledTaskRef.current = null;
            setMarketAnalysis('');
            setStreamPreview('');
            setProgress(0);
            setCurrentStatus('Preparing generation...');
            setStep(2);
            onTrigger(res.data.task_id, 'forge', `AI Studio: ${strategyCount} strategies for ${datasetMeta?.ticker || 'General'}`);
        } catch (e) {
            const error = e.response?.data?.detail || "Studio request failed before generation started.";
            setGenerationError(error);
            setCurrentStatus('Generation failed');
            setStep(2);
            notify(error, 'red');
        }
    };

    const canStartForge = mode === 'upload'
        ? Boolean(uploadedCode)
        : mode === 'web_research'
            ? Object.values(researchTypes).some(Boolean)
            : (mode === 'random_agnostic' || Boolean(prompt.trim()));
    const availableBars = Number(datasetMeta?.total_bars ?? datasetMeta?.rows ?? 0);
    const maxLookback = availableBars >= 20 ? Math.min(500, availableBars) : 20;
    const forgeComplete = mode !== 'upload' && progress === 100 && generatedStrats.length > 0 && !activeTaskId && !generationError;

    const cancelForge = async () => {
        if (!activeTaskId || isCancelling) return;
        const taskId = activeTaskId;
        setIsCancelling(true);
        try {
            await axios.post(`${BACKTEST_SERVICE}/ai/generate/${taskId}/cancel`);
            handledTaskRef.current = `${taskId}:cancelled`;
            setActiveTaskId(null);
            setCurrentStatus('Generation cancelled');
            setProgress(0);
            setStep(1);
            notify('Strategy generation cancelled. Your objective was preserved.', 'blue');
        } catch (e) {
            notify(e.response?.data?.detail || 'Could not cancel generation.', 'red');
        } finally {
            setIsCancelling(false);
        }
    };

    const goBack = async () => {
        if (step === 2 && activeTaskId) {
            await cancelForge();
            return;
        }
        setStep(1);
    };

    const navigateToStep = async (targetStep) => {
        if (targetStep === step) return;
        if (targetStep === 1) {
            await goBack();
        } else if (targetStep === 2 && forgeComplete) {
            setStep(2);
        } else if (targetStep === 3 && generatedStrats.length > 0 && !activeTaskId) {
            setStep(3);
        }
    };

    const startNewJob = async () => {
        if (activeTaskId) {
            try {
                await axios.post(`${BACKTEST_SERVICE}/ai/generate/${activeTaskId}/cancel`);
            } catch (e) {
                notify(e.response?.data?.detail || 'Could not stop the current generation.', 'red');
                return;
            }
        }
        setActiveTaskId(null);
        handledTaskRef.current = null;
        setPrompt('');
        setMode(files?.length > 0 ? 'pattern_fit' : 'user_defined');
        setCount('3');
        setLookback(Math.min(100, maxLookback));
        setTargetCategory(datasetMeta?.ticker || 'General');
        setGeneratedStrats([]);
        setTestingStates({});
        setBacktestingStates({});
        setResearchSources([]);
        setComparisonState({ status: 'idle', taskId: null, results: [] });
        setImprovingStates({});
        setGenerationError('');
        setInvalidCandidates([]);
        setMarketAnalysis('');
        setStreamPreview('');
        setProgress(0);
        setCurrentStatus('Idle');
        setUploadedCode('');
        setUploadFileName('');
        setFetchUrl('');
        setStep(1);
    };

    const reviewInvalidCandidates = () => {
        setGeneratedStrats(invalidCandidates);
        setTestingStates(Object.fromEntries(invalidCandidates.map((candidate, idx) => [
            idx,
            { status: 'error', message: candidate.validation_error || 'Generated code needs correction.' },
        ])));
        setGenerationError('');
        setStep(3);
    };

    const saveStrategy = async (strat, idx, quiet = false) => {
        try {
            const validation = await axios.post(`${BACKTEST_SERVICE}/strategies/validate`, {
                code: strat.code,
                class_name: strat.class_name
            });
            if (!validation.data.valid) {
                const message = validation.data.details || validation.data.error || 'Code is not valid yet.';
                setTestingStates(prev => ({ ...prev, [idx]: { status: 'error', message } }));
                notify(`Fix validation errors before saving "${strat.name}"`, 'red');
                return false;
            }
            await axios.post(`${BACKTEST_SERVICE}/strategies/custom`, {
                ...strat,
                ticker: strat.ticker || datasetMeta?.ticker || targetCategory,
                category: targetCategory,
                description: strat.description
            });
            onRefreshStrats();
            if (!quiet) notify(`Secured "${strat.name}" to Arsenal`, 'green');
            return true;
        } catch (e) {
            notify(`Failed to save "${strat.name}"`, 'red');
            return false;
        }
    };

    const runQuickBacktest = async (strat, idx) => {
        if (!selectedFile) {
            notify('Choose a reference dataset before running a backtest.', 'blue');
            setStep(1);
            return;
        }

        setBacktestingStates(prev => ({ ...prev, [idx]: { status: 'starting' } }));
        try {
            if (!await saveStrategy(strat, idx, true)) {
                setBacktestingStates(prev => ({ ...prev, [idx]: { status: 'error' } }));
                return;
            }
            const res = await axios.post(`${BACKTEST_SERVICE}/backtest`, {
                dataset_filename: selectedFile,
                strategies: [strat.name],
                stake_range: [95],
                trail_range: [0.0, 0.05, 0.10],
                start_date: datasetMeta?.start || null,
                end_date: datasetMeta?.end || null,
                sequential: true,
                initial_cash: 100000,
                commission: 0.001,
                max_workers: 1,
            });
            setBacktestingStates(prev => ({ ...prev, [idx]: { status: 'started', taskId: res.data.task_id } }));
            onTrigger(res.data.task_id, 'backtest', `Quick Backtest: ${strat.name} on ${selectedFile}`);
            notify(`Backtest started for "${strat.name}" on ${formatDatasetName(selectedFile)}.`, 'green');
        } catch (e) {
            setBacktestingStates(prev => ({ ...prev, [idx]: { status: 'error' } }));
            notify(e.response?.data?.detail || `Could not backtest "${strat.name}".`, 'red');
        }
    };

    const runComparisonBacktest = async () => {
        if (!selectedFile || generatedStrats.length < 2) {
            notify('Choose a dataset and forge at least two strategies for comparison.', 'blue');
            return;
        }
        setComparisonState({ status: 'validating', taskId: null, results: [] });
        for (let idx = 0; idx < generatedStrats.length; idx += 1) {
            if (!await saveStrategy(generatedStrats[idx], idx, true)) {
                setComparisonState({ status: 'error', taskId: null, results: [] });
                notify('Comparison stopped because one strategy needs code fixes.', 'red');
                return;
            }
        }
        try {
            const names = generatedStrats.map(strategy => strategy.name);
            const res = await axios.post(`${BACKTEST_SERVICE}/backtest`, {
                dataset_filename: selectedFile,
                strategies: names,
                stake_range: [95],
                trail_range: [0.0, 0.05, 0.10],
                start_date: datasetMeta?.start || null,
                end_date: datasetMeta?.end || null,
                sequential: false,
                initial_cash: 100000,
                commission: 0.001,
                max_workers: Math.min(8, names.length),
            });
            setComparisonState({ status: 'running', taskId: res.data.task_id, results: [] });
            onTrigger(res.data.task_id, 'backtest', `Studio Comparison: ${names.length} strategies on ${selectedFile}`);
            notify(`Comparison started for ${names.length} strategies.`, 'green');
        } catch (e) {
            setComparisonState({ status: 'error', taskId: null, results: [] });
            notify(e.response?.data?.detail || 'Could not start strategy comparison.', 'red');
        }
    };

    const improveZeroTradeStrategy = async (strat, idx) => {
        const { provider, model, api_key, provider_config } = getApiSettings();
        if (!api_key) {
            notify('Configure an AI provider key in Setup before requesting an improvement.', 'red');
            return;
        }
        setImprovingStates(prev => ({ ...prev, [idx]: true }));
        try {
            const res = await axios.post(`${BACKTEST_SERVICE}/strategies/improve-code`, {
                name: strat.class_name,
                code: strat.code,
                instruction: `The strategy produced zero trades on ${selectedFile}. Relax or add an adaptive entry path so it can trade on this dataset while preserving the strategy thesis and risk controls. Do not force a trade on every bar.`,
                provider,
                model,
                api_key,
                provider_config,
            });
            setGeneratedStrats(current => current.map((item, itemIndex) => itemIndex === idx ? {
                ...item,
                code: res.data.code,
                class_name: res.data.class_name || item.class_name,
                analysis: [item.analysis, `AI trial-run revision: ${res.data.reasoning || 'Adjusted inactive entry logic.'}`].filter(Boolean).join('\n\n'),
            } : item));
            setTestingStates(prev => ({
                ...prev,
                [idx]: res.data.valid
                    ? { status: 'success', message: 'Revised code is valid; run another trial.' }
                    : { status: 'error', message: res.data.validation_error || 'Revision still needs editing.' },
            }));
            setBacktestingStates(prev => ({ ...prev, [idx]: { status: 'edited', tradeCount: 0 } }));
            notify(res.data.valid ? 'Strategy improved. Run another trial.' : 'Revision returned for manual editing.', res.data.valid ? 'green' : 'blue');
        } catch (e) {
            notify(e.response?.data?.detail || 'Could not improve this strategy.', 'red');
        } finally {
            setImprovingStates(prev => ({ ...prev, [idx]: false }));
        }
    };

    useEffect(() => {
        setBacktestingStates(previous => {
            let changed = false;
            const next = { ...previous };
            Object.entries(previous).forEach(([index, state]) => {
                if (!state?.taskId || !['started', 'running'].includes(state.status)) return;
                const task = tasks.find(item => item.id === state.taskId);
                if (!task) return;
                if (task.status === 'completed') {
                    const result = (task.results || []).find(item => item.strategy === generatedStrats[Number(index)]?.name) || (task.results || [])[0];
                    next[index] = {
                        ...state,
                        status: 'completed',
                        tradeCount: Number(result?.trade_count || 0),
                        roi: result?.roi,
                        error: result?.error || null,
                    };
                    changed = true;
                } else if (String(task.status || '').startsWith('failed')) {
                    next[index] = { ...state, status: 'error', error: task.error || 'Trial run failed.' };
                    changed = true;
                }
            });
            return changed ? next : previous;
        });

        if (comparisonState.taskId) {
            const task = tasks.find(item => item.id === comparisonState.taskId);
            if (task?.status === 'completed' && comparisonState.status !== 'completed') {
                setComparisonState(current => ({ ...current, status: 'completed', results: task.results || [] }));
            } else if (String(task?.status || '').startsWith('failed') && comparisonState.status !== 'error') {
                setComparisonState(current => ({ ...current, status: 'error', error: task.error || 'Comparison failed.' }));
            }
        }
    }, [tasks, comparisonState.taskId, comparisonState.status, generatedStrats]);

    const validateCode = async (strat, idx) => {
        setTestingStates(prev => ({ ...prev, [idx]: { status: 'testing', message: 'Validating...' } }));
        try {
            const res = await axios.post(`${BACKTEST_SERVICE}/strategies/validate`, {
                code: strat.code,
                class_name: strat.class_name
            });
            if (res.data.valid) {
                setTestingStates(prev => ({ ...prev, [idx]: { status: 'success', message: 'Code Valid' } }));
                notify(`✓ ${strat.name} passed validation`, 'green');
            } else {
                setTestingStates(prev => ({ ...prev, [idx]: { status: 'error', message: res.data.error || 'Issues' } }));
                notify(`✗ ${strat.name} has code issues`, 'red');
            }
        } catch (e) {
            setTestingStates(prev => ({ ...prev, [idx]: { status: 'error', message: 'Check Failed' } }));
        }
    };

    return (
        <div className="studio-container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', height: '100%', paddingBottom: '2rem' }}>
            {/* Header / Wizard Progress */}
            <div className="panel" style={{ padding: '1rem 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ padding: '0.5rem', background: 'var(--brand-blue)', borderRadius: '12px' }}>
                        <BrainCircuit size={24} color="white" />
                    </div>
                    <div>
                        <h2 style={{ margin: 0, fontSize: '1.2rem' }}>AI Strategy Studio</h2>
                        <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>Professional Grade Strategy Synthesis</span>
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {[
                        { n: 1, label: 'Objective', icon: FlaskConical },
                        { n: 2, label: 'The Forge', icon: RefreshCw },
                        { n: 3, label: 'Results', icon: History }
                    ].map(s => {
                        const stepAvailable = (
                            (s.n === 1 && step !== 1)
                            || (s.n === 2 && forgeComplete && step !== 2)
                            || (s.n === 3 && generatedStrats.length > 0 && !activeTaskId && step !== 3)
                        );
                        return (
                        <div
                            key={s.n}
                            onClick={() => stepAvailable && navigateToStep(s.n)}
                            role={stepAvailable ? 'button' : undefined}
                            tabIndex={stepAvailable ? 0 : undefined}
                            onKeyDown={(event) => {
                                if (stepAvailable && (event.key === 'Enter' || event.key === ' ')) navigateToStep(s.n);
                            }}
                            style={{
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '0.5rem', 
                            opacity: step >= s.n ? 1 : 0.4,
                            color: step === s.n ? 'var(--brand-blue)' : 'inherit',
                            transition: 'all 0.3s ease',
                            cursor: stepAvailable ? 'pointer' : 'default',
                        }}>
                            <div style={{ 
                                width: '24px', 
                                height: '24px', 
                                borderRadius: '50%', 
                                border: `2px solid ${step >= s.n ? 'var(--brand-blue)' : 'var(--border-subtle)'}`,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '0.7rem',
                                fontWeight: 800
                            }}>
                                {step > s.n ? <CheckCircle2 size={14} /> : s.n}
                            </div>
                            <span style={{ fontSize: '0.85rem', fontWeight: step === s.n ? 700 : 500 }}>{s.label}</span>
                            {s.n < 3 && <ChevronRight size={14} opacity={0.3} />}
                        </div>
                    )})}
                    {step > 1 && (
                        <button className="btn btn-ghost btn-sm" onClick={goBack}>
                            <ArrowLeft size={14} /> Back to Objective
                        </button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={startNewJob}>
                        <Plus size={14} /> New Job
                    </button>
                </div>
            </div>

            {/* Main Workspace */}
            <div style={{ flex: 1 }}>
                <AnimatePresence mode="wait">
                    {step === 1 && (
                        <motion.div 
                            key="step1" 
                            initial={{ opacity: 0, x: -20 }} 
                            animate={{ opacity: 1, x: 0 }} 
                            exit={{ opacity: 0, x: 20 }}
                            style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '1.5rem' }}
                        >
                            <div className="panel">
                                <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
                                    <Zap size={18} color="var(--brand-yellow)" />
                                    Define Your Strategy Objective
                                </h3>
                                
                                <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                                    <label>Generation Mode</label>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.5rem', marginBottom: '1rem' }}>
                                        <button className={`btn ${mode === 'pattern_fit' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('pattern_fit')}>Fit to Dataset</button>
                                        <button className={`btn ${mode === 'user_defined' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('user_defined')}>Prompt Only</button>
                                        <button className={`btn ${mode === 'random_agnostic' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('random_agnostic')}>Explore Ideas</button>
                                        <button className={`btn ${mode === 'web_research' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('web_research')}>Research Web</button>
                                        <button className={`btn ${mode === 'upload' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('upload')}>Import Code</button>
                                    </div>
                                    <div style={{ fontSize: '0.75rem', opacity: 0.6, marginBottom: '1rem' }}>
                                        {mode === 'pattern_fit' && 'Analyze a selected dataset first, then generate strategies fitted to those patterns.'}
                                        {mode === 'user_defined' && 'Generate from your exact written rules. Dataset context is optional and not used for pattern fitting.'}
                                        {mode === 'random_agnostic' && 'Let the model invent diverse strategy concepts. The prompt is optional inspiration only.'}
                                        {mode === 'web_research' && 'Search public sources for documented strategy ideas, then create an original validated implementation with source links.'}
                                        {mode === 'upload' && 'Bring existing Python code into the editable result screen for validation and saving.'}
                                    </div>
                                </div>

                                {mode !== 'upload' ? (
                                <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                                    <label>{mode === 'pattern_fit' ? 'Pattern-Fit Intent' : mode === 'random_agnostic' ? 'Optional Theme' : mode === 'web_research' ? 'Research Theme' : 'Strategy Rules'}</label>
                                    <textarea 
                                        className="input" 
                                        style={{ height: '180px', fontSize: '1rem', lineHeight: '1.6' }}
                                        placeholder={
                                            mode === 'pattern_fit'
                                                ? "E.g. Fit a strategy to recent pullbacks, RSI recovery, and SMA resistance in the selected bars."
                                                : mode === 'random_agnostic'
                                                    ? "Optional theme, e.g. aggressive volatility scalping."
                                                    : mode === 'web_research'
                                                        ? "E.g. Find well-documented pullback strategies with explicit entry, exit, and risk-management rules."
                                                    : "E.g. Buy when EMA 20 crosses above EMA 50 and RSI is above 55; close when trend weakens or stop is hit."
                                        }
                                        value={prompt}
                                        onChange={e => setPrompt(e.target.value)}
                                    />
                                    <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', opacity: 0.5, display: 'flex', gap: '1rem' }}>
                                        <span>Suggest: Trend Following</span>
                                        <span>Suggest: Mean Reversion</span>
                                        <span>Suggest: Breakout</span>
                                    </div>
                                </div>
                                ) : (
                                <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                                    <label>Upload Strategy Code</label>
                                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                        <button className={`btn btn-sm ${uploadMode === 'file' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setUploadMode('file')}><Upload size={14} /> File</button>
                                        <button className={`btn btn-sm ${uploadMode === 'url' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setUploadMode('url')}><Link size={14} /> URL</button>
                                    </div>
                                    {uploadMode === 'file' ? (
                                        <div
                                            onDrop={handleDrop}
                                            onDragOver={(e) => e.preventDefault()}
                                            onClick={() => document.getElementById('studio-file-input')?.click()}
                                            style={{ border: '2px dashed var(--border-subtle)', borderRadius: 'var(--radius)', padding: '2rem', textAlign: 'center', cursor: 'pointer' }}
                                        >
                                            <Upload size={32} style={{ opacity: 0.45, marginBottom: '0.5rem' }} />
                                            <div style={{ fontSize: '0.85rem', opacity: 0.75 }}>Drop a <strong>.py</strong> file here or click to browse</div>
                                            <input id="studio-file-input" type="file" accept=".py" onChange={handleFileUpload} style={{ display: 'none' }} />
                                        </div>
                                    ) : (
                                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                                            <input className="input" placeholder="https://raw.githubusercontent.com/.../strategy.py" value={fetchUrl} onChange={e => setFetchUrl(e.target.value)} />
                                            <button className="btn btn-primary" onClick={fetchFromUrl} disabled={fetchingUrl || !fetchUrl}>
                                                {fetchingUrl ? <RefreshCw className="animate-spin" size={14} /> : <Link size={14} />} Fetch
                                            </button>
                                        </div>
                                    )}
                                    {uploadedCode && (
                                        <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'var(--bg-accent)', borderRadius: 'var(--radius)' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                                                <FileText size={14} />
                                                <strong>{uploadFileName || 'strategy.py'}</strong>
                                                <span style={{ opacity: 0.55 }}>({uploadedCode.length} chars)</span>
                                            </div>
                                            <pre style={{ maxHeight: '120px', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '0.7rem' }}>{uploadedCode.slice(0, 800)}{uploadedCode.length > 800 ? '\n...' : ''}</pre>
                                        </div>
                                    )}
                                </div>
                                )}

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                                    <div className="form-group">
                                        <label>Target Category</label>
                                        <input 
                                            className="input" 
                                            value={targetCategory} 
                                            onChange={e => setTargetCategory(e.target.value)} 
                                            placeholder="e.g. BTC-USD, Scalping"
                                        />
                                    </div>
                                    <div className="form-group">
                                        <label>Variants to Forge</label>
                                        <input
                                            className="input"
                                            type="number"
                                            min="1"
                                            step="1"
                                            value={count}
                                            onChange={e => setCount(e.target.value)}
                                            placeholder="e.g. 5"
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
                                <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
                                    <LineChart size={18} color="var(--brand-blue)" />
                                    {mode === 'pattern_fit' ? 'Market Intelligence Context' : mode === 'upload' ? 'Import Workflow' : 'Generation Scope'}
                                </h3>

                                {mode !== 'pattern_fit' && (
                                    <div style={{ marginBottom: '1rem', padding: '1rem', background: 'var(--bg-accent)', borderRadius: 'var(--radius)', border: '1px solid var(--border-subtle)' }}>
                                        <div style={{ fontWeight: 800, marginBottom: '0.4rem' }}>
                                            {mode === 'upload' ? 'No AI generation required' : mode === 'random_agnostic' ? 'Dataset not required' : mode === 'web_research' ? 'Public research drives the strategy' : 'Prompt drives the strategy'}
                                        </div>
                                        <div style={{ fontSize: '0.8rem', lineHeight: 1.5, opacity: 0.7 }}>
                                            {mode === 'upload'
                                                ? 'Upload mode loads code directly into Results so you can edit, validate, and save it.'
                                                : mode === 'random_agnostic'
                                                    ? 'Random mode asks for diverse concepts instead of fitting a specific chart.'
                                                    : mode === 'web_research'
                                                        ? 'Web Research searches public sources, reads a bounded set of results, and asks the model for an original implementation. Web text is treated as untrusted evidence.'
                                                    : 'Prompt Only mode follows your rules without asking the market-analysis step to shape the logic.'}
                                        </div>
                                    </div>
                                )}

                                {mode === 'web_research' && (
                                    <div style={{ display: 'grid', gap: '0.85rem', marginBottom: '1rem' }}>
                                        <div className="form-group">
                                            <label>Source Types</label>
                                            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={researchTypes.web}
                                                        onChange={event => setResearchTypes(current => ({ ...current, web: event.target.checked }))}
                                                    /> Public web
                                                </label>
                                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={researchTypes.papers}
                                                        onChange={event => setResearchTypes(current => ({ ...current, papers: event.target.checked }))}
                                                    /> Research papers
                                                </label>
                                            </div>
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                                            <div className="form-group">
                                                <label>Sources kept</label>
                                                <input className="input" type="number" min="2" max="12" value={researchMaxSources} onChange={event => setResearchMaxSources(event.target.value)} />
                                            </div>
                                            <div className="form-group">
                                                <label>Pages to read</label>
                                                <input className="input" type="number" min="1" max={researchMaxSources} value={researchReadPages} onChange={event => setResearchReadPages(event.target.value)} />
                                            </div>
                                        </div>
                                        <div className="form-group">
                                            <label>Only these sites <span style={{ opacity: 0.5 }}>(optional, comma-separated)</span></label>
                                            <input className="input" value={researchIncludeDomains} onChange={event => setResearchIncludeDomains(event.target.value)} placeholder="arxiv.org, quantifiedstrategies.com" />
                                        </div>
                                        <div className="form-group">
                                            <label>Exclude these sites <span style={{ opacity: 0.5 }}>(optional)</span></label>
                                            <input className="input" value={researchExcludeDomains} onChange={event => setResearchExcludeDomains(event.target.value)} placeholder="youtube.com, reddit.com" />
                                        </div>
                                    </div>
                                )}
                                
                                {mode === 'pattern_fit' && <div className="form-group">
                                    <label>Reference Dataset</label>
                                    <select 
                                        className="input" 
                                        value={selectedFile} 
                                        onChange={e => setSelectedFile(e.target.value)}
                                    >
                                        {files.map(f => <option key={f} value={f}>{formatDatasetName(f)}</option>)}
                                    </select>
                                </div>}

                                {mode === 'pattern_fit' && datasetMeta && (
                                    <div style={{ margin: '1rem 0', padding: '1rem', background: 'var(--bg-accent)', borderRadius: 'var(--radius)', border: '1px solid var(--border-subtle)' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                                            <span style={{ fontWeight: 800 }}>{datasetMeta.ticker}</span>
                                            <span className="badge badge-blue">{datasetMeta.interval}</span>
                                        </div>
                                        <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                                            {availableBars} bars detected ({datasetMeta.start} to {datasetMeta.end})
                                        </div>
                                    </div>
                                )}

                                {mode === 'pattern_fit' && <div className="form-group" style={{ marginTop: '1rem' }}>
                                    <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <span>Pattern Learning Depth</span>
                                        <span style={{ color: 'var(--brand-blue)', fontWeight: 700 }}>
                                            {lookback} of {availableBars || '?'} Bars
                                        </span>
                                    </label>
                                    <input 
                                        type="range" 
                                        min="20" max={maxLookback} step="10"
                                        value={lookback} 
                                        onChange={e => setLookback(e.target.value)} 
                                        style={{ width: '100%', accentColor: 'var(--brand-blue)' }}
                                    />
                                    {availableBars > 0 && availableBars < 20 && (
                                        <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--brand-red)' }}>
                                            At least 20 valid bars are required for pattern analysis.
                                        </div>
                                    )}
                                </div>}

                                <div style={{ marginTop: 'auto' }}>
                                    <button 
                                        className="btn btn-primary" 
                                        style={{ width: '100%', height: '50px', fontSize: '1.1rem' }}
                                        onClick={mode === 'upload' ? loadUploadedStrategy : startForge}
                                        disabled={!canStartForge}
                                    >
                                        {mode === 'upload' ? <Upload size={20} /> : <Wand2 size={20} />}
                                        {mode === 'upload' ? 'Load Uploaded Strategy' : 'Initialize Forge Process'}
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    )}

                    {step === 2 && (
                        <motion.div 
                            key="step2" 
                            initial={{ opacity: 0, scale: 0.98 }} 
                            animate={{ opacity: 1, scale: 1 }} 
                            exit={{ opacity: 0, scale: 1.02 }}
                            className="panel"
                            style={{ minHeight: '500px', display: 'flex', flexDirection: 'column', gap: '2rem' }}
                        >
                            <div style={{ textAlign: 'center', maxWidth: '600px', margin: '0 auto' }}>
                                <div style={{ position: 'relative', width: '80px', height: '80px', margin: '0 auto 1.5rem' }}>
                                    {!generationError && !forgeComplete && <motion.div
                                        animate={{ rotate: 360 }}
                                        transition={{ repeat: Infinity, duration: 4, ease: "linear" }}
                                        style={{ position: 'absolute', inset: 0, border: '4px solid var(--brand-blue)', borderTopColor: 'transparent', borderRadius: '50%' }}
                                    />}
                                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        {generationError
                                            ? <AlertCircle size={42} color="var(--brand-red)" />
                                            : forgeComplete
                                                ? <CheckCircle2 size={42} color="var(--brand-green)" />
                                                : <RefreshCw size={32} color="var(--brand-blue)" className="animate-spin" />}
                                    </div>
                                </div>
                                <h2 style={{ marginBottom: '0.5rem' }}>
                                    {generationError
                                        ? 'Strategy Synthesis Needs Another Pass'
                                        : forgeComplete ? 'Forge Run Complete' : 'Strategy Synthesis in Progress'}
                                </h2>
                                <p style={{ opacity: 0.7, lineHeight: 1.6 }}>
                                    {generationError || currentStatus}
                                </p>

                                {generationError ? (
                                    <div style={{ marginTop: '1.5rem' }}>
                                        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem' }}>
                                            {invalidCandidates.length > 0 && (
                                                <button className="btn btn-primary" onClick={reviewInvalidCandidates}>
                                                    <Code size={16} /> Review &amp; Edit Candidate
                                                </button>
                                            )}
                                            <button className="btn btn-primary" onClick={startForge}>
                                                <RefreshCw size={16} /> Generate Again
                                            </button>
                                            <button className="btn btn-ghost" onClick={() => { setGenerationError(''); setStep(1); }}>
                                                Edit Objective
                                            </button>
                                        </div>
                                        <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', opacity: 0.55 }}>
                                            Edit minor mistakes without another model call, generate again with the same settings, or choose a stronger coding model in Setup. New model requests may use additional tokens.
                                        </div>
                                    </div>
                                ) : forgeComplete ? (
                                    <div style={{ marginTop: '1.5rem' }}>
                                        <button className="btn btn-primary" onClick={() => setStep(3)}>
                                            <History size={16} /> View Results
                                        </button>
                                        <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', opacity: 0.55 }}>
                                            This is the completed Forge record. You can review its research and generated-code stream without starting another job.
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div style={{ marginTop: '1.5rem', height: '8px', background: 'var(--bg-accent)', borderRadius: '4px', overflow: 'hidden' }}>
                                            <motion.div
                                                animate={{ width: `${progress}%` }}
                                                style={{ height: '100%', background: 'linear-gradient(90deg, var(--brand-blue), #60a5fa)', borderRadius: '4px' }}
                                            />
                                        </div>
                                        <div style={{ textAlign: 'right', fontSize: '0.7rem', marginTop: '0.5rem', opacity: 0.5 }}>{progress}% Complete</div>
                                        <button
                                            className="btn btn-ghost"
                                            onClick={cancelForge}
                                            disabled={!activeTaskId || isCancelling}
                                            style={{ marginTop: '1rem', color: 'var(--brand-red)' }}
                                        >
                                            {isCancelling ? <RefreshCw size={14} className="animate-spin" /> : <Square size={14} />}
                                            {isCancelling ? 'Stopping…' : 'Stop Generation'}
                                        </button>
                                        <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', opacity: 0.5 }}>
                                            Stops later stages and discards late output. A provider request already in flight may still incur token usage.
                                        </div>
                                    </>
                                )}
                            </div>

                            {!generationError && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: '1.5rem', flex: 1 }}>
                                {/* Market Analysis Box */}
                                <div style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.1)', borderRadius: '12px', padding: '1.25rem', display: 'flex', flexDirection: 'column' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', color: 'var(--brand-blue)' }}>
                                        <Search size={16} />
                                        <span style={{ fontWeight: 700, fontSize: '0.8rem', textTransform: 'uppercase' }}>
                                            {mode === 'web_research' ? 'Public Strategy Research' : 'AI Market Insight'}
                                        </span>
                                    </div>
                                    <div style={{ flex: 1, overflow: 'auto', fontSize: '0.85rem', lineHeight: '1.5', opacity: 0.85 }}>
                                        {renderMarkdown(marketAnalysis, "Analyzing price action data... Waiting for pattern report...")}
                                    </div>
                                </div>

                                {/* Live Code Stream */}
                                <div style={{ background: '#0f172a', borderRadius: '12px', padding: '1.25rem', border: '1px solid #1e293b', display: 'flex', flexDirection: 'column' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', color: '#38bdf8' }}>
                                        <Code size={16} />
                                        <span style={{ fontWeight: 700, fontSize: '0.8rem', textTransform: 'uppercase' }}>Neural Synthesis Stream</span>
                                    </div>
                                    <div style={{ flex: 1, overflow: 'auto', fontSize: '0.78rem', color: '#94a3b8', lineHeight: '1.6' }}>
                                        {renderMarkdown(streamPreview, "Awaiting LLM response stream...")}
                                        <motion.span 
                                            animate={{ opacity: [0, 1, 0] }} 
                                            transition={{ repeat: Infinity, duration: 1 }}
                                            style={{ display: 'inline-block', width: '8px', height: '14px', background: '#38bdf8', marginLeft: '4px', verticalAlign: 'middle' }}
                                        />
                                    </div>
                                </div>
                            </div>}
                        </motion.div>
                    )}

                    {step === 3 && (
                        <motion.div 
                            key="step3" 
                            initial={{ opacity: 0, y: 20 }} 
                            animate={{ opacity: 1, y: 0 }} 
                            className="results-view"
                            style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '1.5rem' }}
                        >
                            {/* Strategy List Sidebar */}
                            <div className="panel" style={{ padding: '1rem' }}>
                                <h3 style={{ fontSize: '1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <History size={18} />
                                    Forged Variants
                                </h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                    {generatedStrats.map((strat, idx) => (
                                        <div 
                                            key={idx} 
                                            onClick={() => {
                                                const el = document.getElementById(`strat-${idx}`);
                                                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                            }}
                                            style={{ 
                                                padding: '0.75rem', 
                                                background: 'var(--bg-accent)', 
                                                borderRadius: '8px', 
                                                cursor: 'pointer',
                                                border: '1px solid var(--border-subtle)',
                                                transition: 'all 0.2s ease'
                                            }}
                                            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--brand-blue)'}
                                            onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
                                        >
                                            <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.25rem' }}>{strat.name}</div>
                                            <div style={{ display: 'flex', gap: '0.4rem' }}>
                                                <span className="badge badge-blue" style={{ fontSize: '0.6rem' }}>{strat.class_name}</span>
                                                {testingStates[idx]?.status === 'success' && <CheckCircle2 size={12} color="var(--brand-green)" />}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                {generatedStrats.length > 1 && (
                                    <button
                                        className="btn btn-primary"
                                        style={{ width: '100%', marginTop: '1.25rem' }}
                                        onClick={runComparisonBacktest}
                                        disabled={['validating', 'running'].includes(comparisonState.status)}
                                    >
                                        {['validating', 'running'].includes(comparisonState.status)
                                            ? <RefreshCw size={14} className="animate-spin" />
                                            : <Layers size={14} />}
                                        {comparisonState.status === 'validating'
                                            ? 'Validating All…'
                                            : comparisonState.status === 'running' ? 'Comparison Running…' : 'Backtest All'}
                                    </button>
                                )}
                                <button 
                                    className="btn btn-ghost" 
                                    style={{ width: '100%', marginTop: '2rem' }}
                                    onClick={() => setStep(1)}
                                >
                                    <RefreshCw size={14} /> Forge More
                                </button>
                            </div>

                            {/* Detailed Results */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', overflow: 'auto', maxHeight: 'calc(100vh - 250px)', paddingRight: '0.5rem' }} ref={resultsRef}>
                                {comparisonState.status === 'completed' && (
                                    <div className="panel" style={{ borderLeft: '4px solid var(--brand-green)' }}>
                                        <h3 style={{ marginTop: 0 }}>Strategy Comparison</h3>
                                        <div style={{ overflowX: 'auto' }}>
                                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                                                <thead>
                                                    <tr>
                                                        <th style={{ textAlign: 'left', padding: '0.5rem' }}>Strategy</th>
                                                        <th style={{ textAlign: 'right', padding: '0.5rem' }}>Trades</th>
                                                        <th style={{ textAlign: 'right', padding: '0.5rem' }}>ROI</th>
                                                        <th style={{ textAlign: 'left', padding: '0.5rem' }}>Status</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {[...comparisonState.results].sort((a, b) => Number(b.roi ?? -Infinity) - Number(a.roi ?? -Infinity)).map(result => (
                                                        <tr key={result.strategy} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                                                            <td style={{ padding: '0.5rem' }}>{result.strategy}</td>
                                                            <td style={{ textAlign: 'right', padding: '0.5rem' }}>{result.trade_count || 0}</td>
                                                            <td style={{ textAlign: 'right', padding: '0.5rem' }}>{Number(result.roi || 0).toFixed(2)}%</td>
                                                            <td style={{ padding: '0.5rem', color: result.trade_count > 0 ? 'var(--brand-green)' : 'var(--brand-yellow)' }}>
                                                                {result.error ? 'Error' : result.trade_count > 0 ? 'Active' : 'Needs improvement'}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                )}
                                {researchSources.length > 0 && (
                                    <div className="panel" style={{ borderLeft: '4px solid var(--brand-yellow)' }}>
                                        <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <Search size={17} /> Public Research Sources
                                        </h3>
                                        <p style={{ fontSize: '0.8rem', opacity: 0.65 }}>
                                            These sources inspired an original implementation; their code and performance claims were not copied or trusted automatically.
                                        </p>
                                        <div style={{ display: 'grid', gap: '0.6rem' }}>
                                            {researchSources.map((source, sourceIndex) => (
                                                <div
                                                    key={`${source.url}-${sourceIndex}`}
                                                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}
                                                >
                                                    <span className={`badge ${source.read_status === 'page_read' ? 'badge-green' : 'badge-ghost'}`} style={{ fontSize: '0.6rem' }}>
                                                        {source.read_status === 'page_read' ? 'Page read' : 'Snippet only'}
                                                    </span>
                                                    <span className="badge badge-blue" style={{ fontSize: '0.6rem' }}>
                                                        {source.source_type === 'paper' ? 'Research paper' : 'Public web'}
                                                    </span>
                                                    <a
                                                        href={source.url}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        style={{ color: 'var(--brand-blue)', fontSize: '0.82rem' }}
                                                    >
                                                        {source.title || source.url}
                                                    </a>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {generatedStrats.map((strat, idx) => (
                                    <motion.div 
                                        key={idx} 
                                        id={`strat-${idx}`}
                                        initial={{ opacity: 0, x: 20 }} 
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ delay: idx * 0.1 }}
                                        className="panel"
                                        style={{ borderLeft: '4px solid var(--brand-blue)' }}
                                    >
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
                                            <div>
                                                <h3 style={{ margin: 0 }}>{strat.name}</h3>
                                                <p style={{ opacity: 0.6, fontSize: '0.85rem', marginTop: '0.25rem' }}>{strat.description}</p>
                                            </div>
                                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                <button 
                                                    className={`btn btn-sm ${testingStates[idx]?.status === 'success' ? 'btn-ghost' : 'btn-primary'}`}
                                                    onClick={() => validateCode(strat, idx)}
                                                    disabled={testingStates[idx]?.status === 'testing'}
                                                    style={testingStates[idx]?.status === 'success' ? { color: 'var(--brand-green)', borderColor: 'var(--brand-green)' } : {}}
                                                >
                                                    {testingStates[idx]?.status === 'testing' ? <RefreshCw className="animate-spin" size={14} /> : 
                                                     testingStates[idx]?.status === 'success' ? <ShieldCheck size={14} /> : <Play size={14} />}
                                                    {testingStates[idx]?.status === 'success' ? 'Validated' : 'Test Code'}
                                                </button>
                                                <button
                                                    className="btn btn-sm btn-primary"
                                                    onClick={() => runQuickBacktest(strat, idx)}
                                                    disabled={['starting', 'started'].includes(backtestingStates[idx]?.status)}
                                                >
                                                    {['starting', 'started'].includes(backtestingStates[idx]?.status)
                                                        ? <RefreshCw className="animate-spin" size={14} />
                                                        : <LineChart size={14} />}
                                                    {backtestingStates[idx]?.status === 'starting'
                                                        ? 'Starting…'
                                                        : backtestingStates[idx]?.status === 'started' ? 'Trial Running…'
                                                            : backtestingStates[idx]?.status === 'completed' ? 'Trial Again' : 'Trial Run'}
                                                </button>
                                                <button className="btn btn-sm btn-primary" onClick={() => saveStrategy(strat, idx)}>
                                                    <Save size={14} /> Save to Arsenal
                                                </button>
                                            </div>
                                        </div>

                                        {backtestingStates[idx]?.status === 'completed' && (
                                            <div style={{
                                                marginBottom: '1rem',
                                                padding: '0.85rem',
                                                borderRadius: '8px',
                                                background: backtestingStates[idx].tradeCount > 0 ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.1)',
                                                border: `1px solid ${backtestingStates[idx].tradeCount > 0 ? 'rgba(34,197,94,0.25)' : 'rgba(245,158,11,0.3)'}`,
                                            }}>
                                                <div style={{ fontWeight: 800, marginBottom: '0.35rem' }}>
                                                    {backtestingStates[idx].tradeCount > 0
                                                        ? `Trial passed: ${backtestingStates[idx].tradeCount} trades, ${Number(backtestingStates[idx].roi || 0).toFixed(2)}% ROI`
                                                        : 'Trial found 0 trades'}
                                                </div>
                                                {backtestingStates[idx].tradeCount === 0 && (
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                                                        <span style={{ fontSize: '0.8rem', opacity: 0.75 }}>Edit the code manually, or let AI relax inactive entry conditions.</span>
                                                        <button
                                                            className="btn btn-sm btn-ghost"
                                                            onClick={() => improveZeroTradeStrategy(strat, idx)}
                                                            disabled={improvingStates[idx]}
                                                        >
                                                            {improvingStates[idx] ? <RefreshCw size={13} className="animate-spin" /> : <Wand2 size={13} />}
                                                            {improvingStates[idx] ? 'Improving…' : 'Improve with AI'}
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {strat.analysis && (
                                            <div style={{ background: 'rgba(59,130,246,0.05)', padding: '1rem', borderRadius: '8px', marginBottom: '1rem', borderLeft: '2px solid var(--brand-blue)' }}>
                                                <div style={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--brand-blue)', marginBottom: '0.5rem' }}>Logical Foundation</div>
                                                <div style={{ fontSize: '0.85rem', margin: 0, lineHeight: '1.5', opacity: 0.9 }}>
                                                    {renderMarkdown(strat.analysis)}
                                                </div>
                                            </div>
                                        )}

                                        {testingStates[idx]?.status === 'error' && (
                                            <div style={{ background: 'rgba(239,68,68,0.08)', color: 'var(--brand-red)', padding: '0.85rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>
                                                {testingStates[idx].message}
                                            </div>
                                        )}

                                        <div style={{ position: 'relative' }}>
                                            <div style={{ position: 'absolute', top: '10px', right: '10px', display: 'flex', gap: '0.5rem' }}>
                                                <span className="badge badge-ghost" style={{ fontSize: '0.65rem' }}>Editable</span>
                                                <span className="badge badge-ghost" style={{ fontSize: '0.65rem' }}>Python</span>
                                                <span className="badge badge-ghost" style={{ fontSize: '0.65rem' }}>Backtrader</span>
                                            </div>
                                            <textarea 
                                                className="code-editor" 
                                                style={{ height: '250px', fontSize: '0.8rem', background: '#0f172a', border: '1px solid #1e293b' }}
                                                value={strat.code}
                                                onChange={(e) => {
                                                    const newStrats = [...generatedStrats];
                                                    newStrats[idx] = { ...newStrats[idx], code: e.target.value };
                                                    setGeneratedStrats(newStrats);
                                                    setTestingStates(prev => {
                                                        const next = { ...prev };
                                                        delete next[idx];
                                                        return next;
                                                    });
                                                    setBacktestingStates(prev => ({ ...prev, [idx]: { status: 'edited' } }));
                                                }}
                                            />
                                        </div>
                                    </motion.div>
                                ))}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
};

export default AIStrategyStudio;
