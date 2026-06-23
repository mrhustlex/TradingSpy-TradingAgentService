import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Shield, Server, Globe, Save, RefreshCw, AlertCircle, CheckCircle, Cpu, Key, HelpCircle, X, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import axios from 'axios';
import { API_BASE, SETTINGS_URL, DATA_SERVICE, BACKTEST_SERVICE, OPTIMIZER_SERVICE } from '../config';
import ExpandableSection from './ExpandableSection';

const DEFAULT_PROVIDER = 'google_ai_studio';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const SUPPORTED_PROVIDERS = [
    { value: 'google_ai_studio', label: 'Google AI Studio' },
    { value: 'mistral', label: 'Mistral AI' },
    { value: 'openrouter', label: 'OpenRouter' },
];
const SUPPORTED_PROVIDER_VALUES = new Set(SUPPORTED_PROVIDERS.map(provider => provider.value));
const normalizeProvider = (provider) => {
    const p = (provider || DEFAULT_PROVIDER).trim().toLowerCase().replace(/[-\s]/g, '_');
    if (p === 'googleaistudio' || p === 'google_ai' || p === 'gemini') return 'google_ai_studio';
    return SUPPORTED_PROVIDER_VALUES.has(p) ? p : DEFAULT_PROVIDER;
};
const isSupportedProviderInput = (provider) => {
    const p = (provider || '').trim().toLowerCase().replace(/[-\s]/g, '_');
    const normalized = p === 'googleaistudio' || p === 'google_ai' || p === 'gemini' ? 'google_ai_studio' : p;
    return SUPPORTED_PROVIDER_VALUES.has(normalized);
};

// Keys that live in localStorage only — never sent to the server
const LS_KEY = (k) => `settings_${k}`;
const KEY_FIELDS = ['openrouter_api_key','google_ai_studio_api_key','mistral_api_key','tavily_api_key'];

function loadLocalKeys() {
    const out = {};
    KEY_FIELDS.forEach(k => { out[k] = localStorage.getItem(LS_KEY(k)) || ''; });
    return out;
}

function saveLocalKeys(settings) {
    KEY_FIELDS.forEach(k => { localStorage.setItem(LS_KEY(k), settings[k] || ''); });
}

function loadLocalProviderConfig() {
    return {};
}

const INITIAL_SETTINGS = {
    // keys — browser only
    openrouter_api_key: '',
    google_ai_studio_api_key: '',
    mistral_api_key: '',
    tavily_api_key: '',
    // non-sensitive — server
    default_provider: DEFAULT_PROVIDER,
    default_model: DEFAULT_MODEL,
    enable_openai_compatible_output: true,
    enable_acp_agent_output: false,
    enable_a2a_remote_agent_output: false,
    remote_agent_auth_token: '',
    remote_agent_auth_token_configured: false,
};

const KEY_CONFIGURED_FIELDS = KEY_FIELDS.map(k => `${k}_configured`);

const HelpTooltip = ({ title, lines = [] }) => (
    <span
        tabIndex={0}
        title={`${title}\n${lines.join('\n')}`}
        style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: 'var(--brand-blue)',
            cursor: 'help',
            marginLeft: '0.35rem',
            verticalAlign: 'middle',
        }}
    >
        <HelpCircle size={14} />
    </span>
);

const ProviderKeyNote = ({ configured, fieldLabel = 'API key' }) => {
    if (!configured) {
        return (
            <div style={{ fontSize: '0.72rem', opacity: 0.55, marginTop: '0.35rem' }}>
                Stored in this browser as soon as you type. Press Save to persist provider/model settings.
            </div>
        );
    }
    return (
        <div style={{ fontSize: '0.72rem', color: 'var(--brand-green)', marginTop: '0.35rem' }}>
            {fieldLabel} is configured on the server or environment. The secret is hidden here; type a new value to override it in this browser.
        </div>
    );
};

const Settings = ({ notify }) => {
    const [settings, setSettings] = useState({ ...INITIAL_SETTINGS, ...loadLocalProviderConfig(), ...loadLocalKeys() });

    const [urls, setUrls] = useState({
        data: localStorage.getItem('setting_data_url') || DATA_SERVICE,
        backtest: localStorage.getItem('setting_backtest_url') || BACKTEST_SERVICE,
        optimizer: localStorage.getItem('setting_optimizer_url') || OPTIMIZER_SERVICE
    });

    const [status, setStatus] = useState({ data: 'unknown', backtest: 'unknown', optimizer: 'unknown' });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [showModelHelp, setShowModelHelp] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [resetOptions, setResetOptions] = useState({
        strategies: true,
        files: true,
        watchlist: true,
        results: true,
        stockGroups: true,
        extraEtfs: true,
        chatThreads: true
    });

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const res = await axios.get(SETTINGS_URL);
            if (res.data) {
                KEY_CONFIGURED_FIELDS.forEach(k => {
                    localStorage.setItem(LS_KEY(k), res.data[k] ? 'true' : 'false');
                });
                // Server returns only non-sensitive config; merge with locally stored keys
                const rawProvider = localStorage.getItem('settings_default_provider') || res.data.default_provider || DEFAULT_PROVIDER;
                const provider = normalizeProvider(rawProvider);
                const model = isSupportedProviderInput(rawProvider)
                    ? (localStorage.getItem('settings_default_model') || res.data.default_model || DEFAULT_MODEL)
                    : DEFAULT_MODEL;
                setSettings(prev => ({ 
                    ...prev, 
                    ...res.data, 
                    ...loadLocalProviderConfig(),
                    ...loadLocalKeys(),
                    // Also load default_provider and default_model from localStorage if available
                    default_provider: provider,
                    default_model: model
                }));
            }
        } catch (e) {
            console.error("Error fetching settings", e);
        } finally {
            setLoading(false);
        }
    };

    const handleReset = async () => {
        setResetting(true);
        try {
            const payload = {};
            if (resetOptions.strategies) payload.strategies = true;
            if (resetOptions.files) payload.files = true;
            if (resetOptions.watchlist) payload.watchlist = true;
            if (resetOptions.results) payload.results = true;

            const res = await axios.post(`${API_BASE}/reset`, payload);
            const r = res.data.removed || {};

            // Clear localStorage items
            if (resetOptions.stockGroups) {
                localStorage.removeItem('custom_stock_groups');
            }
            if (resetOptions.extraEtfs) {
                localStorage.removeItem('heatmap_extra_etfs');
            }
            if (resetOptions.chatThreads) {
                localStorage.removeItem('chatThreads');
            }

            notify(
                `Reset done — ${r.strategies || 0} strategies, ${r.files || 0} files, ${r.results || 0} results ` +
                (resetOptions.watchlist ? ', watchlist cleared' : '') +
                (resetOptions.stockGroups ? ', stock groups cleared' : '') +
                (resetOptions.extraEtfs ? ', extra ETFs cleared' : ''),
                'green'
            );
            setShowResetConfirm(false);
        } catch (e) {
            notify('Reset failed: ' + (e.response?.data?.detail || e.message), 'red');
        } finally {
            setResetting(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            // Keys stay in browser only
            saveLocalKeys(settings);

            // Also save default_provider and default_model to localStorage for frontend use
            localStorage.setItem('settings_default_provider', settings.default_provider);
            localStorage.setItem('settings_default_model', settings.default_model);
            // POST only non-sensitive fields to server. The remote agent token is
            // server-side auth config, so it is sent only when the user types one.
            const {
                default_provider,
                default_model,
                enable_openai_compatible_output,
                enable_acp_agent_output,
                enable_a2a_remote_agent_output,
                remote_agent_auth_token,
            } = settings;
            const serverPayload = {
                default_provider: normalizeProvider(default_provider),
                default_model,
                enable_openai_compatible_output,
                enable_acp_agent_output,
                enable_a2a_remote_agent_output,
            };
            if (remote_agent_auth_token !== '') {
                serverPayload.remote_agent_auth_token = remote_agent_auth_token;
            }
            await axios.post(SETTINGS_URL, serverPayload);
            if (remote_agent_auth_token !== '') {
                setSettings(prev => ({
                    ...prev,
                    remote_agent_auth_token: '',
                    remote_agent_auth_token_configured: true,
                }));
            }

            localStorage.setItem('setting_data_url', urls.data);
            localStorage.setItem('setting_backtest_url', urls.backtest);
            localStorage.setItem('setting_optimizer_url', urls.optimizer);
            window.dispatchEvent(new CustomEvent('tradingspy:llm-settings-updated'));

            notify("Settings saved. API keys stay in your browser; remote output settings saved on the server.", 'green');
        } catch (e) {
            notify("Failed to save settings to server.", 'red');
        } finally {
            setSaving(false);
        }
    };

    const updateSetting = (key, value) => {
        setSettings(prev => ({ ...prev, [key]: value }));
        if (KEY_FIELDS.includes(key)) {
            localStorage.setItem(LS_KEY(key), value || '');
        }
        if (key === 'default_provider') {
            localStorage.setItem(LS_KEY(key), normalizeProvider(value));
        }
        if (key === 'default_model') {
            localStorage.setItem(LS_KEY(key), value || '');
        }
    };

    if (loading) return <div className="panel" style={{ padding: '4rem', textAlign: 'center' }}><div className="spinner" /></div>;

    return (
        <div style={{ maxWidth: '1000px', margin: '0 auto', paddingBottom: '4rem' }}>
            <h1 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: 0 }}>
                <SettingsIcon size={32} /> Settings
            </h1>

            <div style={{ display: 'grid', gap: '2rem' }}>

                {/* PROVIDER */}
                <ExpandableSection label="1. Provider" icon={<Cpu size={20} />} color="var(--brand-yellow)" defaultOpen={true}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                        <div className="form-group">
                            <label>Provider</label>
                            <select
                                className="input"
                                value={settings.default_provider}
                                onChange={(e) => updateSetting('default_provider', e.target.value)}
                            >
                                {SUPPORTED_PROVIDERS.map(provider => (
                                    <option key={provider.value} value={provider.value}>{provider.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="form-group">
                            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <span>Model</span>
                                <button className="btn btn-ghost btn-xs" onClick={() => setShowModelHelp(true)} style={{ color: 'var(--brand-blue)', padding: '0 0.5rem', height: '20px' }}>
                                    <HelpCircle size={14} style={{ marginRight: '4px' }} /> Help
                                </button>
                            </label>
                            <input
                                className="input"
                                placeholder="gemini-2.5-flash, mistral-large-latest, openrouter model id..."
                                value={settings.default_model}
                                onChange={(e) => updateSetting('default_model', e.target.value)}
                            />
                        </div>
                    </div>
                </ExpandableSection>

                {/* KEY */}
                <ExpandableSection label="2. Key" icon={<Key size={18} />} color="var(--brand-green)" defaultOpen={true}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
                        {settings.default_provider === 'openrouter' && (
                            <div className="form-group">
                                <label>OpenRouter API Key</label>
                                <input type="password" className="input" value={settings.openrouter_api_key} onChange={(e) => updateSetting('openrouter_api_key', e.target.value)} placeholder={settings.openrouter_api_key_configured ? 'Configured on server/env. Type to override locally.' : 'sk-or-...'} />
                                <ProviderKeyNote configured={settings.openrouter_api_key_configured} />
                            </div>
                        )}

                        {settings.default_provider === 'google_ai_studio' && (
                            <div className="form-group">
                                <label>Google AI Studio API Key</label>
                                <input type="password" className="input" value={settings.google_ai_studio_api_key} onChange={(e) => updateSetting('google_ai_studio_api_key', e.target.value)} placeholder={settings.google_ai_studio_api_key_configured ? 'Configured on server/env. Type to override locally.' : 'Gemini API key'} />
                                <ProviderKeyNote configured={settings.google_ai_studio_api_key_configured} />
                            </div>
                        )}

                        {settings.default_provider === 'mistral' && (
                            <div className="form-group">
                                <label>Mistral AI API Key</label>
                                <input type="password" className="input" value={settings.mistral_api_key} onChange={(e) => updateSetting('mistral_api_key', e.target.value)} placeholder={settings.mistral_api_key_configured ? 'Configured on server/env. Type to override locally.' : 'Mistral API key'} />
                                <ProviderKeyNote configured={settings.mistral_api_key_configured} />
                            </div>
                        )}

                    </div>
                </ExpandableSection>

                {/* OTHER SETTINGS */}
                <ExpandableSection label="3. Other Settings - Assistant Outputs" icon={<Server size={20} />} color="var(--brand-blue)" defaultOpen={true}>
                    <div style={{ display: 'grid', gap: '0.85rem' }}>
                        {[
                            {
                                key: 'enable_openai_compatible_output',
                                title: 'OpenAI-compatible endpoint',
                                desc: 'Enables /v1/chat/completions and /v1/models. Recommended on for local use.',
                                help: [
                                    'Use when another app can call an OpenAI-style API.',
                                    'Models: GET http://localhost:8000/v1/models',
                                    'Chat: POST http://localhost:8000/v1/chat/completions',
                                    'Example body: {"model":"trading-spy-assistant","messages":[{"role":"user","content":"Screen undervalued AI stocks"}]}',
                                    'If a Remote Agent Auth Token is set, send Authorization: Bearer YOUR_TOKEN.',
                                ],
                            },
                            {
                                key: 'enable_acp_agent_output',
                                title: 'ACP Agent',
                                desc: 'Enables /acp/... discovery, run, resume, cancel, and event endpoints. Keep off until tested.',
                                help: [
                                    'Use when an ACP-compatible client wants to discover and run this assistant.',
                                    'Discovery/run endpoints live under http://localhost:8000/acp/...',
                                    'The remote client can start long-running agent jobs, then poll/resume/cancel/events.',
                                    'Keep disabled unless you are testing an ACP client you trust.',
                                ],
                            },
                            {
                                key: 'enable_a2a_remote_agent_output',
                                title: 'A2A Remote Agent',
                                desc: 'Enables /.well-known/agent-card.json and /a2a/... task endpoints. Keep off until auth is configured.',
                                help: [
                                    'Use when another agent supports A2A Remote Agent discovery.',
                                    'Agent card: GET http://localhost:8000/.well-known/agent-card.json',
                                    'Send task: POST http://localhost:8000/a2a/tasks/send',
                                    'Example body: {"message":"Generate until it beats buy and hold for QQQ daily"}',
                                    'Set a Remote Agent Auth Token before exposing beyond localhost.',
                                ],
                            },
                        ].map(item => (
                            <label
                                key={item.key}
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'auto 1fr',
                                    gap: '0.75rem',
                                    alignItems: 'center',
                                    padding: '0.85rem 1rem',
                                    background: 'rgba(255,255,255,0.035)',
                                    border: '1px solid rgba(255,255,255,0.08)',
                                    borderRadius: '8px',
                                    cursor: 'pointer',
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={!!settings[item.key]}
                                    onChange={(e) => updateSetting(item.key, e.target.checked)}
                                    style={{ width: '18px', height: '18px', accentColor: 'var(--brand-blue)' }}
                                />
                                <span>
                                    <span style={{ display: 'flex', alignItems: 'center', fontWeight: 700 }}>
                                        {item.title}
                                        <HelpTooltip title={item.title} lines={item.help} />
                                    </span>
                                    <span style={{ display: 'block', fontSize: '0.78rem', opacity: 0.68, marginTop: '0.15rem' }}>{item.desc}</span>
                                </span>
                            </label>
                        ))}

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.75rem', alignItems: 'end', marginTop: '0.25rem' }}>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                                <label>
                                    Remote Agent Auth Token
                                    <HelpTooltip
                                        title="Remote Agent Auth Token"
                                        lines={[
                                            'Optional bearer token used by OpenAI-compatible, ACP, and A2A outputs.',
                                            'Example header: Authorization: Bearer YOUR_TOKEN',
                                            'Local curl example: curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/.well-known/agent-card.json',
                                            'Leave blank only for trusted local-only testing.',
                                            'Typing a new token replaces the existing server token on Save.',
                                        ]}
                                    />
                                </label>
                                <input
                                    type="password"
                                    className="input"
                                    value={settings.remote_agent_auth_token}
                                    onChange={(e) => updateSetting('remote_agent_auth_token', e.target.value)}
                                    placeholder={settings.remote_agent_auth_token_configured ? 'Token configured. Type a new token to replace it.' : 'Optional bearer token for ACP/A2A'}
                                />
                            </div>
                            <div style={{
                                fontSize: '0.75rem',
                                padding: '0.65rem 0.8rem',
                                borderRadius: '6px',
                                background: settings.remote_agent_auth_token_configured ? 'rgba(76, 175, 80, 0.12)' : 'rgba(255,255,255,0.04)',
                                color: settings.remote_agent_auth_token_configured ? 'var(--brand-green)' : 'var(--text-secondary)',
                                whiteSpace: 'nowrap',
                            }}>
                                {settings.remote_agent_auth_token_configured ? 'Token configured' : 'No token'}
                            </div>
                        </div>

                        <div style={{
                            display: 'flex',
                            gap: '0.65rem',
                            alignItems: 'flex-start',
                            padding: '0.85rem 1rem',
                            background: 'rgba(255, 193, 7, 0.1)',
                            border: '1px solid rgba(255, 193, 7, 0.28)',
                            borderRadius: '8px',
                            color: 'var(--brand-yellow)',
                            fontSize: '0.82rem',
                            lineHeight: 1.45,
                        }}>
                            <Shield size={17} style={{ marginTop: '1px', flexShrink: 0 }} />
                            <span>
                                Remote agent outputs can let other tools start long-running jobs and spend LLM/API credits.
                                Enable only for trusted local or authenticated clients.
                            </span>
                        </div>
                    </div>
                </ExpandableSection>

                <ExpandableSection label="3. Other Settings - Web Search" icon={<Globe size={18} />} color="var(--brand-blue)" defaultOpen={false}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
                        <div className="form-group">
                            <label>SearXNG URL</label>
                            <input
                                className="input"
                                value={localStorage.getItem('searxng_url') || 'http://localhost:8080'}
                                onChange={(e) => localStorage.setItem('searxng_url', e.target.value)}
                                placeholder="http://localhost:8080"
                            />
                            <div style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: '5px' }}>
                                Local SearXNG instance for privacy-respecting web search. No API key needed.
                            </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                            <div style={{ padding: '0.75rem', background: 'rgba(76, 175, 80, 0.1)', borderRadius: '6px', border: '1px solid rgba(76, 175, 80, 0.3)', width: '100%' }}>
                                <div style={{ fontSize: '0.85rem', color: 'var(--brand-green)', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <CheckCircle size={16} /> SearXNG Active
                                </div>
                                <div style={{ fontSize: '0.75rem', opacity: 0.7, marginTop: '4px' }}>
                                    Running on port 8080. Web search uses multiple engines.
                                </div>
                            </div>
                        </div>
                    </div>
                </ExpandableSection>

                {/* NETWORK INFRASTRUCTURE */}
                <ExpandableSection label="3. Other Settings - Services" icon={<Server size={18} />} color="var(--brand-blue)" defaultOpen={false}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
                        <div className="form-group">
                            <label>Data Service URL</label>
                            <input
                                className="input"
                                value={urls.data}
                                onChange={(e) => setUrls(prev => ({ ...prev, data: e.target.value }))}
                                placeholder="http://localhost:8000/api/market-data"
                            />
                            <div style={{ fontSize: '0.65rem', opacity: 0.5, marginTop: '5px' }}>Current: {DATA_SERVICE}</div>
                        </div>
                        <div className="form-group">
                            <label>Runner Service URL</label>
                            <input
                                className="input"
                                value={urls.backtest}
                                onChange={(e) => setUrls(prev => ({ ...prev, backtest: e.target.value }))}
                                placeholder="http://localhost:8000/api/backtest"
                            />
                            <div style={{ fontSize: '0.65rem', opacity: 0.5, marginTop: '5px' }}>Current: {BACKTEST_SERVICE}</div>
                        </div>
                        <div className="form-group">
                            <label>Optimizer Service URL</label>
                            <input
                                className="input"
                                value={urls.optimizer}
                                onChange={(e) => setUrls(prev => ({ ...prev, optimizer: e.target.value }))}
                                placeholder="http://localhost:8000/api/optimizer"
                            />
                            <div style={{ fontSize: '0.65rem', opacity: 0.5, marginTop: '5px' }}>Current: {OPTIMIZER_SERVICE}</div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '1rem' }}>
                        <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                                localStorage.removeItem('setting_data_url');
                                localStorage.removeItem('setting_backtest_url');
                                localStorage.removeItem('setting_optimizer_url');
                                window.location.reload();
                            }}
                        >
                            <RefreshCw size={14} /> Reset Monolith Defaults
                        </button>
                        <div style={{ fontSize: '0.75rem', opacity: 0.6, display: 'flex', alignItems: 'center' }}>
                            Use this if you see "Network Error" after the monolith update.
                        </div>
                    </div>
                </ExpandableSection>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', position: 'sticky', bottom: '2rem', zIndex: 10 }}>
                    <button className="btn btn-primary btn-lg" onClick={handleSave} disabled={saving} style={{ padding: '1rem 3rem', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.4)', border: '2px solid var(--brand-blue)' }}>
                        {saving ? <RefreshCw className="animate-spin" /> : <Save size={20} />}
                        {saving ? 'Synchronizing...' : 'Apply System Changes'}
                    </button>
                </div>

            </div>

            <div style={{ marginTop: '3rem', padding: '2rem', background: 'rgba(0,0,0,0.2)', borderRadius: '12px', border: '1px dashed rgba(255,255,255,0.1)' }}>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1rem', color: 'var(--text-secondary)' }}>
                    <AlertCircle size={18} /> Infrastructure Note
                </h3>
                <p style={{ fontSize: '0.85rem', opacity: 0.6, marginTop: '0.5rem' }}>
                    Since you are running in <b>Local Monolith Mode</b>, non-sensitive settings are saved to <code>backend/data/system_settings.json</code>.
                    <b style={{ color: 'var(--brand-green)' }}> API keys are stored in your browser only</b> and are never sent to or stored on the server.
                    They are passed directly with each request.
                </p>
            </div>

            {/* RESET DATA */}
            <div className="panel" style={{ border: '1px solid rgba(244, 67, 54, 0.3)', marginTop: '2rem' }}>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f44336', marginBottom: '1rem' }}>
                    <Trash2 size={20} /> 4. Reset
                </h2>
                <p style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '1rem' }}>
                    Select what to reset. This action cannot be undone.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', marginBottom: '1.25rem' }}>
                    {[
                        { key: 'strategies', label: 'Custom Strategies' },
                        { key: 'files', label: 'Downloaded Data Files' },
                        { key: 'watchlist', label: 'Watchlist' },
                        { key: 'results', label: 'Backtest Results' },
                        { key: 'stockGroups', label: 'Stock Groups' },
                        { key: 'extraEtfs', label: 'Extra ETFs' },
                        { key: 'chatThreads', label: 'Chat History' },
                    ].map(opt => (
                        <label key={opt.key} style={{
                            display: 'flex', alignItems: 'center', gap: '0.5rem',
                            padding: '0.6rem 0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: '6px',
                            cursor: 'pointer', userSelect: 'none', fontSize: '0.85rem'
                        }}>
                            <input
                                type="checkbox"
                                checked={resetOptions[opt.key]}
                                onChange={(e) => setResetOptions(prev => ({ ...prev, [opt.key]: e.target.checked }))}
                                style={{ accentColor: '#f44336' }}
                            />
                            {opt.label}
                        </label>
                    ))}
                </div>
                <button
                    className="btn"
                    onClick={() => setShowResetConfirm(true)}
                    style={{
                        background: 'rgba(244, 67, 54, 0.15)', color: '#f44336',
                        border: '1px solid rgba(244, 67, 54, 0.4)', padding: '0.75rem 2rem'
                    }}
                >
                    <Trash2 size={16} /> Reset Selected
                </button>
            </div>

            <AnimatePresence>
                {showModelHelp && (
                    <div className="modal-overlay" onClick={() => setShowModelHelp(false)}>
                        <motion.div
                            className="panel"
                            style={{ width: '500px', maxWidth: '90%', padding: '2rem', border: '1px solid var(--brand-blue)' }}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            onClick={e => e.stopPropagation()}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                                <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <HelpCircle size={20} /> Common Model IDs
                                </h2>
                                <button className="btn btn-ghost" onClick={() => setShowModelHelp(false)}><X size={18} /></button>
                            </div>
                            <div style={{ display: 'grid', gap: '1rem', fontSize: '0.9rem' }}>
                                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: '6px' }}><strong style={{ color: '#4285F4' }}>Google AI Studio</strong>: <code style={{ color: 'white' }}>gemini-2.5-flash</code>, <code style={{ color: 'white' }}>gemini-2.0-flash</code></div>
                                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: '6px' }}><strong style={{ color: 'var(--brand-red)' }}>Mistral</strong>: <code style={{ color: 'white' }}>mistral-large-latest</code>, <code style={{ color: 'white' }}>open-mixtral-8x22b</code></div>
                                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: '6px' }}><strong style={{ color: 'var(--brand-blue)' }}>OpenRouter</strong>: use the provider/model ID shown in OpenRouter, for example <code style={{ color: 'white' }}>openai/gpt-4o-mini</code>.</div>
                            </div>
                            <div style={{ marginTop: '2rem', textAlign: 'right' }}>
                                <button className="btn btn-primary" onClick={() => setShowModelHelp(false)}>Got it</button>
                            </div>
                        </motion.div>
                    </div>
                )}

                {showResetConfirm && (
                    <div className="modal-overlay" onClick={() => setShowResetConfirm(false)}>
                        <motion.div
                            className="panel"
                            style={{ width: '480px', maxWidth: '90%', padding: '2rem', border: '1px solid rgba(244, 67, 54, 0.5)' }}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            onClick={e => e.stopPropagation()}
                        >
                            <h2 style={{ margin: '0 0 0.5rem', color: '#f44336', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <Trash2 size={22} /> Confirm Reset
                            </h2>
                            <p style={{ opacity: 0.8, marginBottom: '1.25rem' }}>
                                This will permanently delete the following data:
                            </p>
                            <ul style={{ opacity: 0.7, fontSize: '0.9rem', marginBottom: '1.5rem', paddingLeft: '1.25rem', lineHeight: '1.7' }}>
                                {resetOptions.strategies && <li>All custom strategies</li>}
                                {resetOptions.files && <li>All user-downloaded data files</li>}
                                {resetOptions.watchlist && <li>Watchlist</li>}
                                {resetOptions.results && <li>All backtest results</li>}
                                {resetOptions.stockGroups && <li>Custom stock groups (browser)</li>}
                                {resetOptions.extraEtfs && <li>Extra ETFs (browser)</li>}
                                {resetOptions.chatThreads && <li>Chat history (browser)</li>}
                            </ul>
                            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                                <button className="btn btn-ghost" onClick={() => setShowResetConfirm(false)} disabled={resetting}>
                                    Cancel
                                </button>
                                <button
                                    className="btn"
                                    onClick={handleReset}
                                    disabled={resetting}
                                    style={{ background: 'rgba(244, 67, 54, 0.2)', color: '#f44336', border: '1px solid rgba(244, 67, 54, 0.4)' }}
                                >
                                    {resetting ? <RefreshCw className="animate-spin" size={16} /> : <Trash2 size={16} />}
                                    {resetting ? 'Resetting...' : 'Yes, Reset'}
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div >
    );
};

export default Settings;
