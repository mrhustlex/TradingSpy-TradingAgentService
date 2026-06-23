import { useEffect, useRef, useState } from 'react';
import { BACKTEST_SERVICE } from '../config';

const initialState = {
  status: 'idle',
  progress: 0,
  current: '',
  label: '',
  detail: '',
  streamPreview: '',
  marketAnalysis: '',
  savedNames: [],
  results: null,
  error: null,
};

export default function useGenerationStream(taskId) {
  const [state, setState] = useState(initialState);
  const lastTaskRef = useRef(null);

  useEffect(() => {
    if (!taskId) {
      setState(initialState);
      lastTaskRef.current = null;
      return;
    }

    if (lastTaskRef.current !== taskId) {
      lastTaskRef.current = taskId;
      setState({
        ...initialState,
        status: 'running',
        progress: 10,
        current: 'Consulting AI Experts...',
        label: 'Preparing generation',
      });
    }

    const controller = new AbortController();
    let stopped = false;

    const applySnapshot = (data) => {
      if (!data) return;
      setState(prev => ({
        ...prev,
        status: data.status || prev.status,
        progress: data.progress ?? prev.progress,
        current: data.current || prev.current,
        streamPreview: prev.streamPreview || data.stream_preview || '',
        marketAnalysis: data.market_analysis || prev.marketAnalysis,
        savedNames: data.saved_names || prev.savedNames,
        results: data.results || prev.results,
        error: data.error || prev.error,
      }));
    };

    const run = async () => {
      try {
        const response = await fetch(`${BACKTEST_SERVICE}/ai/generate/stream/${taskId}`, {
          method: 'GET',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;

            try {
              const event = JSON.parse(line.slice(6));

              if (event.type === 'progress' || event.type === 'heartbeat') {
                setState(prev => ({
                  ...prev,
                  status: event.status || prev.status || 'running',
                  progress: event.progress ?? prev.progress,
                  current: event.current || prev.current,
                  label: event.label || prev.label,
                  detail: event.detail || prev.detail,
                }));
              } else if (event.type === 'analysis') {
                setState(prev => ({
                  ...prev,
                  status: 'running',
                  progress: event.progress ?? prev.progress,
                  current: event.current || prev.current,
                  marketAnalysis: event.market_analysis || prev.marketAnalysis,
                }));
              } else if (event.type === 'token') {
                setState(prev => ({
                  ...prev,
                  status: 'running',
                  progress: event.progress ?? prev.progress,
                  current: event.current || prev.current,
                  streamPreview: event.delta
                    ? `${prev.streamPreview}${event.delta}`.slice(-8000)
                    : (event.stream_preview || prev.streamPreview),
                }));
              } else if (event.type === 'strategy_saved') {
                setState(prev => ({
                  ...prev,
                  savedNames: event.name && !prev.savedNames.includes(event.name)
                    ? [...prev.savedNames, event.name]
                    : prev.savedNames,
                  progress: event.progress ?? prev.progress,
                  current: event.current || prev.current,
                }));
              } else if (event.type === 'validation_error') {
                setState(prev => ({
                  ...prev,
                  progress: event.progress ?? prev.progress,
                  current: event.current || prev.current,
                  detail: event.detail || prev.detail,
                }));
              } else if (event.type === 'complete') {
                setState(prev => ({
                  ...prev,
                  status: 'completed',
                  progress: event.progress ?? 100,
                  current: event.current || 'Generation complete',
                  results: event.results || prev.results,
                  savedNames: event.saved_names || prev.savedNames,
                }));
                return;
              } else if (event.type === 'error') {
                setState(prev => ({
                  ...prev,
                  status: 'failed',
                  error: event.error || 'Unknown error',
                  current: event.current || 'Generation failed',
                }));
                return;
              }
            } catch (error) {
              console.error('Failed to parse generation stream event:', error, line);
            }
          }
        }
      } catch (error) {
        if (error.name === 'AbortError') return;
        setState(prev => ({
          ...prev,
          status: prev.status === 'completed' ? prev.status : 'running',
          error: error.message,
        }));
      }
    };

    const poll = async () => {
      while (!stopped) {
        try {
          const response = await fetch(`${BACKTEST_SERVICE}/results/${taskId}`, {
            method: 'GET',
            signal: controller.signal,
          });
          if (response.ok) {
            const data = await response.json();
            applySnapshot(data);
            if (data.status === 'completed' || data.status === 'failed' || data.status?.startsWith?.('failed')) {
              return;
            }
          }
        } catch (error) {
          if (error.name === 'AbortError') return;
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    };

    run();
    poll();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [taskId]);

  return state;
}
