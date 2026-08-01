import React, { useState, useEffect, Suspense, lazy } from 'react';
import axios from 'axios';
import {
  Search,
  Database,
  ShieldCheck,
  Zap,
  Check,
  Settings,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { DATA_SERVICE, BACKTEST_SERVICE } from '../config';
import { formatDatasetName } from '../utils/formatters';

const ChartViewer = lazy(() => import('../components/ChartViewer'));

const MobileBattleStation = ({
  files,
  strategies,
  tasks,
  onTrigger,
  onRefreshFiles,
  onRefreshStrats,
  notify,
}) => {
  const [step, setStep] = useState(1); // 1: Select Asset, 2: Select Strategy, 3: Configure, 4: Results
  const [selectedFile, setSelectedFile] = useState('');
  const [selectedStrats, setSelectedStrats] = useState([]);
  const [searchFile, setSearchFile] = useState('');
  const [searchStrat, setSearchStrat] = useState('');
  const [intervalFilter, setIntervalFilter] = useState('all');
  
  // Configuration
  const [stakeRange, setStakeRange] = useState('10, 50, 95');
  const [trailRange, setTrailRange] = useState('0.0, 0.05, 0.15');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  
  // Results
  const [activeTask, setActiveTask] = useState(null);
  const [chartData, setChartData] = useState(null);
  const [chartMarkers, setChartMarkers] = useState([]);
  const [chartFileName, setChartFileName] = useState('');

  // Filter files
  const filteredFiles = files.filter(f => {
    if (searchFile && !f.toLowerCase().includes(searchFile.toLowerCase())) return false;
    if (intervalFilter !== 'all' && !f.includes(`-${intervalFilter}-`)) return false;
    return true;
  }).sort();

  // Filter strategies
  const filteredStrats = strategies.filter(s => {
    if (searchStrat && !s.name.toLowerCase().includes(searchStrat.toLowerCase())) return false;
    return true;
  });

  // Load chart when file selected
  useEffect(() => {
    if (!selectedFile) {
      setChartData(null);
      return;
    }
    
    const loadChart = async () => {
      try {
        const now = new Date().getTime();
        const res = await axios.get(`${DATA_SERVICE}/data/${selectedFile}?t=${now}`);
        const Papa = (await import('papaparse')).default;
        const parsed = Papa.parse(res.data, {
          header: true,
          skipEmptyLines: true,
          transformHeader: h => h.trim()
        });
        setChartData(parsed.data);
        setChartFileName(selectedFile);
      } catch (e) {
        console.error('Error loading chart:', e);
      }
    };
    
    loadChart();
  }, [selectedFile]);

  // Poll for task status
  useEffect(() => {
    if (!activeTask) return;
    
    const interval = setInterval(async () => {
      try {
        const res = await axios.get(`${BACKTEST_SERVICE}/results/${activeTask.id}`);
        if (res.data.status === 'completed') {
          setActiveTask(prev => ({ ...prev, ...res.data, status: 'completed' }));
          clearInterval(interval);
          notify('Backtest completed!', 'green');
        } else if (res.data.status?.startsWith('failed')) {
          setActiveTask(prev => ({ ...prev, ...res.data }));
          clearInterval(interval);
          notify('Backtest failed', 'red');
        } else {
          setActiveTask(prev => ({ ...prev, ...res.data }));
        }
      } catch (e) {
        console.error('Error polling task:', e);
      }
    }, 1500);
    
    return () => clearInterval(interval);
  }, [activeTask?.id]);

  // Run backtest
  const runBacktest = async () => {
    if (!selectedFile || selectedStrats.length === 0) {
      notify('Select an asset and at least one strategy', 'yellow');
      return;
    }
    
    try {
      const res = await axios.post(`${BACKTEST_SERVICE}/backtest`, {
        dataset_filename: selectedFile,
        strategies: selectedStrats,
        stake_range: stakeRange.split(',').map(Number),
        trail_range: trailRange.split(',').map(Number),
        start_date: startDate || undefined,
        end_date: endDate || undefined,
      });
      
      onTrigger(res.data.task_id, 'backtest', `Backtesting ${selectedFile}`);
      setActiveTask({ id: res.data.task_id, status: 'running', progress: 0 });
      setStep(4);
    } catch (e) {
      console.error('Failed to start backtest:', e);
      notify('Failed to start backtest', 'red');
    }
  };

  return (
    <div className="mobile-p-md">
      {/* Step Indicator */}
      <div style={{ 
        display: 'flex', 
        gap: 'var(--mobile-spacing-sm)', 
        marginBottom: 'var(--mobile-spacing-lg)',
        justifyContent: 'center'
      }}>
        {[1, 2, 3, 4].map((s) => (
          <div
            key={s}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: step >= s ? 'var(--brand-blue)' : 'var(--bg-accent)',
              transition: 'background 0.2s ease',
            }}
          />
        ))}
      </div>

      {/* Step 1: Select Asset */}
      {step === 1 && (
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
        >
          <div className="mobile-card">
            <div className="mobile-card-header">
              <span className="mobile-card-title">
                <Database size={16} style={{ marginRight: 8 }} />
                Select Asset
              </span>
              <span className="mobile-badge mobile-badge-blue">{filteredFiles.length}</span>
            </div>

            {/* Search */}
            <div className="mobile-input-group" style={{ marginBottom: 'var(--mobile-spacing-md)' }}>
              <Search size={16} className="mobile-input-icon" />
              <input
                className="mobile-input"
                style={{ paddingLeft: 40, height: 40 }}
                placeholder="Search datasets..."
                value={searchFile}
                onChange={(e) => setSearchFile(e.target.value)}
              />
            </div>

            {/* Interval Filter */}
            <div className="mobile-pills" style={{ padding: 0, marginBottom: 'var(--mobile-spacing-md)' }}>
              {['all', '1d', '1h', '5m'].map((interval) => (
                <button
                  key={interval}
                  className={`mobile-pill ${intervalFilter === interval ? 'active' : ''}`}
                  onClick={() => setIntervalFilter(interval)}
                  style={{ padding: '6px 12px' }}
                >
                  {interval === 'all' ? 'All' : interval.toUpperCase()}
                </button>
              ))}
            </div>

            {/* File List */}
            <div className="mobile-list" style={{ maxHeight: 300, overflowY: 'auto' }}>
              {filteredFiles.slice(0, 50).map((file) => (
                <div
                  key={file}
                  className={`mobile-list-item ${selectedFile === file ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedFile(file);
                    setStep(2);
                  }}
                >
                  <div className="mobile-list-item-content">
                    <div className="mobile-list-item-title">{formatDatasetName(file)}</div>
                    <div className="mobile-list-item-subtitle">{file}</div>
                  </div>
                  {selectedFile === file && (
                    <Check size={16} style={{ color: 'var(--brand-blue)' }} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      {/* Step 2: Select Strategy */}
      {step === 2 && (
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
        >
          <div className="mobile-card">
            <div className="mobile-card-header">
              <span className="mobile-card-title">
                <ShieldCheck size={16} style={{ marginRight: 8 }} />
                Select Strategy
              </span>
              <span className="mobile-badge mobile-badge-blue">{selectedStrats.length}</span>
            </div>

            {/* Search */}
            <div className="mobile-input-group" style={{ marginBottom: 'var(--mobile-spacing-md)' }}>
              <Search size={16} className="mobile-input-icon" />
              <input
                className="mobile-input"
                style={{ paddingLeft: 40, height: 40 }}
                placeholder="Search strategies..."
                value={searchStrat}
                onChange={(e) => setSearchStrat(e.target.value)}
              />
            </div>

            {/* Strategy List */}
            <div className="mobile-list" style={{ maxHeight: 300, overflowY: 'auto' }}>
              {filteredStrats.map((strat) => {
                const isSelected = selectedStrats.includes(strat.name);
                return (
                  <div
                    key={strat.name}
                    className={`mobile-list-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      if (isSelected) {
                        setSelectedStrats(prev => prev.filter(s => s !== strat.name));
                      } else {
                        if (selectedStrats.length >= 5) {
                          notify('Maximum 5 strategies per battle', 'yellow');
                          return;
                        }
                        setSelectedStrats(prev => [...prev, strat.name]);
                      }
                    }}
                  >
                    <div className="mobile-list-item-content">
                      <div className="mobile-list-item-title">{strat.name}</div>
                      <div className="mobile-list-item-subtitle">
                        {strat.ticker || 'General'} · {strat.is_custom ? 'AI' : 'Default'}
                      </div>
                    </div>
                    <div style={{
                      width: 20,
                      height: 20,
                      borderRadius: 4,
                      border: `2px solid ${isSelected ? 'var(--brand-blue)' : 'var(--border-subtle)'}`,
                      background: isSelected ? 'var(--brand-blue)' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      {isSelected && <Check size={12} color="white" />}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Navigation */}
            <div style={{ display: 'flex', gap: 'var(--mobile-spacing-sm)', marginTop: 'var(--mobile-spacing-md)' }}>
              <button className="mobile-btn mobile-btn-secondary" style={{ flex: 1 }} onClick={() => setStep(1)}>
                Back
              </button>
              <button
                className="mobile-btn"
                style={{ flex: 1 }}
                onClick={() => setStep(3)}
                disabled={selectedStrats.length === 0}
              >
                Next
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {/* Step 3: Configure */}
      {step === 3 && (
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
        >
          <div className="mobile-card">
            <div className="mobile-card-header">
              <span className="mobile-card-title">
                <Settings size={16} style={{ marginRight: 8 }} />
                Configure
              </span>
            </div>

            {/* Configuration Fields */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mobile-spacing-md)' }}>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                  Stake Range (%)
                </label>
                <input
                  className="mobile-input"
                  value={stakeRange}
                  onChange={(e) => setStakeRange(e.target.value)}
                  placeholder="10, 50, 95"
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                  Trail Stop (%)
                </label>
                <input
                  className="mobile-input"
                  value={trailRange}
                  onChange={(e) => setTrailRange(e.target.value)}
                  placeholder="0.0, 0.05, 0.15"
                />
              </div>
              <div style={{ display: 'flex', gap: 'var(--mobile-spacing-sm)' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                    Start Date
                  </label>
                  <input
                    className="mobile-input"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                    End Date
                  </label>
                  <input
                    className="mobile-input"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Summary */}
            <div style={{ 
              marginTop: 'var(--mobile-spacing-md)', 
              padding: 'var(--mobile-spacing-md)', 
              background: 'var(--bg-accent)', 
              borderRadius: 'var(--mobile-card-radius)' 
            }}>
              <div style={{ fontSize: 'var(--mobile-text-sm)', color: 'var(--text-secondary)', marginBottom: 4 }}>
                Ready to backtest:
              </div>
              <div style={{ fontSize: 'var(--mobile-text-base)', fontWeight: 600 }}>
                {formatDatasetName(selectedFile)}
              </div>
              <div style={{ fontSize: 'var(--mobile-text-sm)', color: 'var(--brand-blue)', marginTop: 4 }}>
                {selectedStrats.length} strategy(ies) selected
              </div>
            </div>

            {/* Navigation */}
            <div style={{ display: 'flex', gap: 'var(--mobile-spacing-sm)', marginTop: 'var(--mobile-spacing-md)' }}>
              <button className="mobile-btn mobile-btn-secondary" style={{ flex: 1 }} onClick={() => setStep(2)}>
                Back
              </button>
              <button className="mobile-btn" style={{ flex: 1 }} onClick={runBacktest}>
                <Zap size={16} /> Run Battle
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {/* Step 4: Results */}
      {step === 4 && (
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
        >
          {/* Chart */}
          {chartData && (
            <div className="mobile-chart-container" style={{ marginBottom: 'var(--mobile-spacing-md)' }}>
              <div className="mobile-chart-body">
                <Suspense fallback={<div className="mobile-loading"><div className="mobile-spinner" /></div>}>
                  <ChartViewer
                    data={chartData}
                    markers={chartMarkers}
                    fileName={chartFileName}
                    height={300}
                  />
                </Suspense>
              </div>
            </div>
          )}

          {/* Task Status */}
          {activeTask && (
            <div className="mobile-card">
              <div className="mobile-card-header">
                <span className="mobile-card-title">Battle Status</span>
                <span className={`mobile-badge ${activeTask.status === 'completed' ? 'mobile-badge-green' : activeTask.status?.startsWith('failed') ? 'mobile-badge-red' : 'mobile-badge-blue'}`}>
                  {activeTask.status || 'running'}
                </span>
              </div>
              
              {activeTask.status === 'running' && (
                <div style={{ marginBottom: 'var(--mobile-spacing-md)' }}>
                  <div style={{ 
                    height: 6, 
                    background: 'var(--bg-accent)', 
                    borderRadius: 3, 
                    overflow: 'hidden' 
                  }}>
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${activeTask.progress || 0}%` }}
                      style={{ 
                        height: '100%', 
                        background: 'var(--brand-blue)',
                        borderRadius: 3,
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', marginTop: 4 }}>
                    {activeTask.current || 'Initializing...'}
                  </div>
                </div>
              )}

              {/* Results Summary */}
              {activeTask.status === 'completed' && activeTask.results && (
                <div className="mobile-stats-grid">
                  {activeTask.results.slice(0, 4).map((result, i) => (
                    <div key={i} className="mobile-stat">
                      <div className="mobile-stat-label">{result.strategy}</div>
                      <div className={`mobile-stat-value ${(result.roi || 0) >= 0 ? 'positive' : 'negative'}`}>
                        {result.roi?.toFixed(2) ?? '-'}%
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div style={{ display: 'flex', gap: 'var(--mobile-spacing-sm)', marginTop: 'var(--mobile-spacing-md)' }}>
                <button
                  className="mobile-btn mobile-btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setStep(1);
                    setSelectedFile('');
                    setSelectedStrats([]);
                    setActiveTask(null);
                  }}
                >
                  New Battle
                </button>
                {activeTask.status === 'completed' && (
                  <button
                    className="mobile-btn"
                    style={{ flex: 1 }}
                    onClick={() => {
                      // Navigate to history
                      notify('View results in Backtest History', 'blue');
                    }}
                  >
                    View History
                  </button>
                )}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
};

export default MobileBattleStation;
