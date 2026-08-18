import React, { useState, useEffect } from 'react';
import {
  Shield,
  Server,
  Save,
  RefreshCw,
  AlertCircle,
  Trash2,
  X,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import axios from 'axios';
import { API_BASE, SETTINGS_URL, DATA_SERVICE, BACKTEST_SERVICE } from '../config';
import useSheetResize from './useSheetResize';

const DEFAULT_PROVIDER = 'google_ai_studio';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const SUPPORTED_PROVIDERS = [
  { value: 'google_ai_studio', label: 'Google AI Studio' },
  { value: 'mistral', label: 'Mistral AI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'nvidia', label: 'NVIDIA' },
  { value: 'litellm', label: 'LiteLLM' },
  { value: 'ollama', label: 'Ollama (Local)' },
];

const KEY_FIELDS = ['openrouter_api_key','google_ai_studio_api_key','mistral_api_key','nvidia_api_key','litellm_api_key'];

const loadLocalKeys = () => {
  const out = {};
  KEY_FIELDS.forEach(k => { out[k] = localStorage.getItem(`settings_${k}`) || ''; });
  return out;
};

const saveLocalKeys = (settings) => {
  KEY_FIELDS.forEach(k => { localStorage.setItem(`settings_${k}`, settings[k] || ''); });
};

const MobileSettings = ({ notify }) => {
  const { sheetHeight: resetSheetHeight, handleProps: resetHandleProps, sheetStyle: resetSheetStyle } = useSheetResize();
  const [settings, setSettings] = useState({
    default_provider: localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER,
    default_model: localStorage.getItem('settings_default_model') || DEFAULT_MODEL,
    ...loadLocalKeys(),
  });
  const [saving, setSaving] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [expandedSection, setExpandedSection] = useState('provider');

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await axios.get(SETTINGS_URL);
      if (res.data) {
        setSettings(prev => ({
          ...prev,
          ...res.data,
          ...loadLocalKeys(),
          default_provider: localStorage.getItem('settings_default_provider') || res.data.default_provider || DEFAULT_PROVIDER,
          default_model: localStorage.getItem('settings_default_model') || res.data.default_model || DEFAULT_MODEL,
        }));
      }
    } catch (e) {
      console.error('Error fetching settings:', e);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Save API keys locally
      saveLocalKeys(settings);
      
      // Save provider settings to localStorage
      localStorage.setItem('settings_default_provider', settings.default_provider);
      localStorage.setItem('settings_default_model', settings.default_model);
      
      // Save to server
      await axios.post(SETTINGS_URL, {
        default_provider: settings.default_provider,
        default_model: settings.default_model,
      });
      
      notify('Settings saved successfully', 'green');
    } catch (e) {
      console.error('Error saving settings:', e);
      notify('Failed to save settings', 'red');
    }
    setSaving(false);
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await axios.post(`${API_BASE}/reset`, {
        strategies: true,
        files: true,
        watchlist: true,
        results: true,
      });
      localStorage.removeItem('custom_stock_groups');
      localStorage.removeItem('heatmap_extra_etfs');
      notify('Reset completed', 'green');
      setShowResetConfirm(false);
    } catch (e) {
      notify('Reset failed', 'red');
    }
    setResetting(false);
  };

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const sections = [
    {
      key: 'provider',
      title: 'AI Provider',
      icon: <Shield size={18} />,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mobile-spacing-md)' }}>
          <div>
            <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
              Default Provider
            </label>
            <select
              className="mobile-input"
              value={settings.default_provider}
              onChange={(e) => updateSetting('default_provider', e.target.value)}
            >
              {SUPPORTED_PROVIDERS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
              Default Model
            </label>
            <input
              className="mobile-input"
              value={settings.default_model}
              onChange={(e) => updateSetting('default_model', e.target.value)}
              placeholder={DEFAULT_MODEL}
            />
          </div>
        </div>
      ),
    },
    {
      key: 'api-keys',
      title: 'API Keys',
      icon: <Shield size={18} />,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mobile-spacing-md)' }}>
          {KEY_FIELDS.map((field) => {
            const providerName = field.replace('_api_key', '').replace('google_ai_studio', 'Google AI Studio');
            return (
              <div key={field}>
                <label style={{ display: 'block', fontSize: 'var(--mobile-text-sm)', fontWeight: 600, marginBottom: 4 }}>
                  {providerName}
                </label>
                <input
                  className="mobile-input"
                  type="password"
                  value={settings[field] || ''}
                  onChange={(e) => updateSetting(field, e.target.value)}
                  placeholder={`Enter ${providerName} API key`}
                />
                <div style={{ fontSize: 'var(--mobile-text-xs)', color: 'var(--text-secondary)', marginTop: 4 }}>
                  Stored locally in your browser only
                </div>
              </div>
            );
          })}
        </div>
      ),
    },
    {
      key: 'services',
      title: 'Service URLs',
      icon: <Server size={18} />,
      content: (
        <div style={{ 
          padding: 'var(--mobile-spacing-md)', 
          background: 'var(--bg-accent)', 
          borderRadius: 'var(--mobile-card-radius)',
          fontSize: 'var(--mobile-text-sm)',
          color: 'var(--text-secondary)',
        }}>
          <div style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--text-main)' }}>Data Service:</strong> {DATA_SERVICE}
          </div>
          <div style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--text-main)' }}>Backtest Service:</strong> {BACKTEST_SERVICE}
          </div>
          <div>
            <strong style={{ color: 'var(--text-main)' }}>Settings Service:</strong> {SETTINGS_URL}
          </div>
        </div>
      ),
    },
    {
      key: 'danger',
      title: 'Danger Zone',
      icon: <AlertCircle size={18} color="var(--brand-red)" />,
      content: (
        <div>
          <p style={{ fontSize: 'var(--mobile-text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--mobile-spacing-md)' }}>
            This will permanently delete all your data including strategies, downloaded files, watchlist, and backtest results.
          </p>
          <button
            className="mobile-btn"
            onClick={() => setShowResetConfirm(true)}
            style={{ 
              background: 'rgba(239, 68, 68, 0.15)', 
              color: 'var(--brand-red)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
            }}
          >
            <Trash2 size={16} /> Reset All Data
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="mobile-p-md">
      {/* Sections */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mobile-spacing-sm)' }}>
        {sections.map((section) => (
          <div key={section.key} className="mobile-card">
            <button
              onClick={() => setExpandedSection(expandedSection === section.key ? null : section.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--mobile-spacing-md)',
                width: '100%',
                padding: 0,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ color: 'var(--text-secondary)' }}>{section.icon}</span>
              <span style={{ flex: 1, fontWeight: 600, fontSize: 'var(--mobile-text-base)' }}>
                {section.title}
              </span>
              <motion.span
                animate={{ rotate: expandedSection === section.key ? 180 : 0 }}
                transition={{ duration: 0.2 }}
              >
                <RefreshCw size={16} style={{ color: 'var(--text-secondary)' }} />
              </motion.span>
            </button>
            
            <AnimatePresence>
              {expandedSection === section.key && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  style={{ overflow: 'hidden' }}
                >
                  <div style={{ paddingTop: 'var(--mobile-spacing-md)' }}>
                    {section.content}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>

      {/* Save Button */}
      <div style={{ marginTop: 'var(--mobile-spacing-lg)' }}>
        <button
          className="mobile-btn"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? <RefreshCw size={16} className="mobile-spinner" /> : <Save size={16} />}
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      {/* Reset Confirmation */}
      <AnimatePresence>
        {showResetConfirm && (
          <div className="mobile-sheet-overlay" onClick={() => setShowResetConfirm(false)}>
            <motion.div
              className="mobile-sheet"
              style={resetSheetStyle}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mobile-sheet-handle" {...resetHandleProps} />
              <div className="mobile-sheet-header">
                <span className="mobile-sheet-title" style={{ color: 'var(--brand-red)' }}>
                  Confirm Reset
                </span>
                <button className="mobile-header-btn" onClick={() => setShowResetConfirm(false)}>
                  <X size={20} />
                </button>
              </div>
              <div className="mobile-sheet-content">
                <p style={{ fontSize: 'var(--mobile-text-base)', color: 'var(--text-secondary)', marginBottom: 'var(--mobile-spacing-lg)' }}>
                  This will permanently delete:
                </p>
                <ul style={{ 
                  fontSize: 'var(--mobile-text-sm)', 
                  color: 'var(--text-secondary)',
                  marginBottom: 'var(--mobile-spacing-lg)',
                  paddingLeft: 'var(--mobile-spacing-lg)',
                  lineHeight: 1.8,
                }}>
                  <li>All custom strategies</li>
                  <li>All downloaded data files</li>
                  <li>Watchlist</li>
                  <li>All backtest results</li>
                </ul>
                <div style={{ display: 'flex', gap: 'var(--mobile-spacing-sm)' }}>
                  <button
                    className="mobile-btn mobile-btn-secondary"
                    style={{ flex: 1 }}
                    onClick={() => setShowResetConfirm(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="mobile-btn"
                    style={{ 
                      flex: 1, 
                      background: 'var(--brand-red)',
                    }}
                    onClick={handleReset}
                    disabled={resetting}
                  >
                    {resetting ? <RefreshCw size={16} className="mobile-spinner" /> : <Trash2 size={16} />}
                    {resetting ? 'Resetting...' : 'Reset'}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default MobileSettings;
