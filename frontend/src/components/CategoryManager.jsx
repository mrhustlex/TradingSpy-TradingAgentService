import React, { useState } from 'react';
import { X, Plus, Save, FolderKanban, Hash } from 'lucide-react';

const CategoryManager = ({ categories, tickers, onSave, onClose }) => {
    const [items, setItems] = useState(categories.map(c => ({ ...c, tickers: [...c.tickers] })));

    const addCategory = () => {
        setItems([...items, { name: '', tickers: [] }]);
    };

    const removeCategory = (idx) => {
        setItems(items.filter((_, i) => i !== idx));
    };

    const updateName = (idx, name) => {
        const next = [...items];
        next[idx] = { ...next[idx], name };
        setItems(next);
    };

    const toggleTicker = (idx, ticker) => {
        const next = [...items];
        const cat = { ...next[idx] };
        if (cat.tickers.includes(ticker)) {
            cat.tickers = cat.tickers.filter(t => t !== ticker);
        } else {
            cat.tickers = [...cat.tickers, ticker];
        }
        next[idx] = cat;
        setItems(next);
    };

    const handleSave = () => {
        const valid = items.filter(c => c.name.trim());
        onSave(valid);
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)'
        }} onClick={onClose}>
            <div className="panel" style={{ width: '520px', maxHeight: '80vh', display: 'flex', flexDirection: 'column', padding: '1.5rem' }}
                onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                    <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <FolderKanban size={20} /> Manage Categories
                    </h3>
                    <button className="btn btn-ghost btn-xs" onClick={onClose}><X size={18} /></button>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', marginBottom: '1rem' }}>
                    {items.length === 0 && (
                        <div style={{ textAlign: 'center', padding: '2rem', opacity: 0.5 }}>
                            <FolderKanban size={40} style={{ margin: '0 auto 0.5rem', display: 'block' }} />
                            No categories yet. Create one to group tickers.
                        </div>
                    )}
                    {items.map((cat, idx) => (
                        <div key={idx} style={{ marginBottom: '1rem', padding: '1rem', background: 'var(--bg-accent)', borderRadius: '8px' }}>
                            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'center' }}>
                                <Hash size={14} opacity={0.5} />
                                <input
                                    className="input"
                                    style={{ flex: 1, height: '36px', fontSize: '0.9rem' }}
                                    placeholder="Category name (e.g. Chips)"
                                    value={cat.name}
                                    onChange={e => updateName(idx, e.target.value)}
                                />
                                <button className="btn btn-ghost btn-xs" onClick={() => removeCategory(idx)}
                                    style={{ color: 'var(--brand-red)' }}><X size={16} /></button>
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                                {tickers.map(t => (
                                    <span key={t}
                                        className={`badge ${cat.tickers.includes(t) ? 'badge-blue' : ''}`}
                                        style={{
                                            cursor: 'pointer', padding: '0.3rem 0.6rem',
                                            opacity: cat.tickers.includes(t) ? 1 : 0.4,
                                            transition: 'all 0.15s'
                                        }}
                                        onClick={() => toggleTicker(idx, t)}>
                                        {t}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ))}
                    <button className="btn" style={{ width: '100%' }} onClick={addCategory}>
                        <Plus size={16} /> Add Category
                    </button>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', borderTop: '1px solid var(--border-subtle)', paddingTop: '1rem' }}>
                    <button className="btn" onClick={onClose}>Cancel</button>
                    <button className="btn btn-primary" onClick={handleSave}><Save size={16} /> Save</button>
                </div>
            </div>
        </div>
    );
};

export default CategoryManager;
