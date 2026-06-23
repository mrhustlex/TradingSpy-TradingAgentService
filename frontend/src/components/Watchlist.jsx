import React, { useState } from 'react';
import axios from 'axios';
import { PlusCircle, RefreshCw, X, Loader2 } from 'lucide-react';
import { DATA_SERVICE } from '../config';

const Watchlist = ({ tickers, onRefresh, onTrigger, notify }) => {
    const [validating, setValidating] = useState(false);
    const [ticker, setTicker] = useState('');

    const handleAdd = async () => {
        if (!ticker) return;
        setValidating(true);
        try {
            const res = await axios.post(`${DATA_SERVICE}/watch`, [ticker.toUpperCase()]);
            const { added, failed } = res.data;

            if (added.length > 0) {
                notify(`Added ${added.join(', ')}`, 'green');
                onRefresh();
            }
            if (failed.length > 0) {
                notify(`Invalid ticker: ${failed.join(', ')}`, 'red');
            }
            setTicker('');
        } catch (e) {
            notify("Error adding to watchlist", 'red');
        }
        setValidating(false);
    };

    const handleDelete = async (t) => {
        try {
            await axios.delete(`${DATA_SERVICE}/watch/${t}`);
            notify(`Removed ${t}`, 'blue');
            onRefresh();
        } catch (e) {
            notify("Error removing from watchlist", 'red');
        }
    };

    const triggerSync = async () => {
        try {
            const res = await axios.post(`${DATA_SERVICE}/sync-now`);
            if (res.data.task_id) {
                onTrigger(res.data.task_id, "Syncing all watched tickers");
                notify("System Sync initiated...", 'blue');
            } else {
                notify(res.data.message || "No tickers to sync (Watchlist empty after restart?)", 'yellow');
            }
        } catch (e) {
            notify("Error triggering sync", 'red');
        }
    };

    return (
        <div>
            <h1 style={{ marginBottom: '2rem' }}>System Watchlist</h1>
            <div className="panel">
                <h3>Monitor & Auto-Sync</h3>
                <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                    <div style={{ position: 'relative' }}>
                        <input
                            className="input"
                            placeholder="Add ticker..."
                            value={ticker}
                            onChange={(e) => setTicker(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                            disabled={validating}
                        />
                    </div>
                    <button className="btn btn-primary" onClick={handleAdd} disabled={validating}>
                        {validating ? <Loader2 className="animate-spin" size={18} /> : <PlusCircle size={18} />}
                        Add
                    </button>
                    <button className="btn" onClick={triggerSync}><RefreshCw size={18} /> Sync All</button>
                </div>
            </div>
            <div className="panel">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
                    {tickers.map(t => (
                        <div key={t} className="badge badge-green" style={{ fontSize: '1rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            {t}
                            <div
                                style={{ cursor: 'pointer', opacity: 0.7, display: 'flex', alignItems: 'center' }}
                                onClick={() => handleDelete(t)}
                                className="hover:opacity-100"
                            >
                                <X size={14} />
                            </div>
                        </div>
                    ))}
                    {tickers.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No tickers being watched yet.</p>}
                </div>
            </div>
        </div>
    );
};

export default Watchlist;
