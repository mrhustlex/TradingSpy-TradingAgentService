import React, { useState, useMemo, useRef, useEffect } from 'react';
import axios from 'axios';
import { Search, Loader2, X } from 'lucide-react';
import { INTELLIGENCE_SERVICE } from '../../config';

const MobileSymbolSearch = ({
  onSelect,
  onSelectLocal,
  placeholder = 'Search ticker or company...',
  compact = false,
  localOptions = [],
  style = {},
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);
  const wrapRef = useRef(null);

  const localMatches = useMemo(() => {
    if (!query || !localOptions?.length) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return localOptions
      .filter(o =>
        String(o.ticker || '').toLowerCase().includes(q) ||
        String(o.name || '').toLowerCase().includes(q)
      )
      .slice(0, 5);
  }, [query, localOptions]);

  useEffect(() => {
    const onDocClick = (ev) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const fetchResults = async (q) => {
    if (!q || q.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const res = await axios.get(`${INTELLIGENCE_SERVICE}/search`, { params: { q }, timeout: 8000 });
      setResults((res.data && res.data.results) || []);
    } catch (e) {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    const value = e.target.value;
    setQuery(value);
    setOpen(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchResults(value), 300);
  };

  const clear = () => {
    setQuery('');
    setResults([]);
    setOpen(false);
    clearTimeout(debounceRef.current);
  };

  const pick = (symbol, name, type) => {
    const ticker = String(symbol || '').toUpperCase();
    clear();
    onSelect && onSelect({ ticker, name, type });
  };

  const pickLocal = (o) => {
    clear();
    onSelectLocal && onSelectLocal(o);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, ...style }}>
      <div className="mobile-input-group" style={{ marginBottom: 0 }}>
        <Search size={compact ? 16 : 18} className="mobile-input-icon" />
        {loading && (
          <Loader2
            size={14}
            className="mobile-spinner"
            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}
          />
        )}
        <input
          className="mobile-input"
          style={{ paddingLeft: compact ? 40 : 44, height: compact ? 36 : undefined, fontSize: compact ? 'var(--mobile-text-xs)' : undefined }}
          placeholder={placeholder}
          value={query}
          onChange={handleChange}
          onFocus={() => setOpen(true)}
        />
        {query && (
          <button
            className="mobile-autocomplete-clear"
            onClick={clear}
            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {open && (localMatches.length > 0 || results.length > 0 || (query.trim().length >= 2 && !loading)) && (
        <div className="mobile-autocomplete">
          {localMatches.length > 0 && (
            <>
              <div className="mobile-autocomplete-label">In this list</div>
              {localMatches.map((o, i) => (
                <button key={`l-${i}`} className="mobile-autocomplete-item" onClick={() => pickLocal(o)}>
                  <span className="mobile-autocomplete-symbol">{o.ticker}</span>
                  <span className="mobile-autocomplete-name">{o.name}</span>
                </button>
              ))}
            </>
          )}
          {query.trim().length >= 2 && (
            <>
              <div className="mobile-autocomplete-label">Yahoo Finance</div>
              {results.length === 0 && !loading && (
                <div className="mobile-autocomplete-empty">No matches for &quot;{query}&quot;</div>
              )}
              {results.map((r, i) => (
                <button key={`y-${i}`} className="mobile-autocomplete-item" onClick={() => pick(r.symbol, r.name, r.type)}>
                  <span className="mobile-autocomplete-symbol">{r.symbol}</span>
                  <span className="mobile-autocomplete-name">{r.name}</span>
                  {r.type && <span className="mobile-autocomplete-type">{r.type}</span>}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default MobileSymbolSearch;
