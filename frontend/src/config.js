const API_BASE = `${window.location.protocol}//${window.location.host}/api`;

// Clean up any incorrect localStorage values from previous versions
const cleanupLocalStorage = () => {
    const dataUrl = localStorage.getItem('setting_data_url');
    const backtestUrl = localStorage.getItem('setting_backtest_url');
    const optimizerUrl = localStorage.getItem('setting_optimizer_url');
    const intelligenceUrl = localStorage.getItem('setting_intelligence_url');

    // Remove any URLs that don't match the expected format (should contain /api/)
    if (dataUrl && !dataUrl.includes('/api/')) {
        console.log('Cleaning up incorrect DATA_SERVICE URL from localStorage:', dataUrl);
        localStorage.removeItem('setting_data_url');
    }
    if (backtestUrl && !backtestUrl.includes('/api/')) {
        console.log('Cleaning up incorrect BACKTEST_SERVICE URL from localStorage:', backtestUrl);
        localStorage.removeItem('setting_backtest_url');
    }
    if (optimizerUrl && !optimizerUrl.includes('/api/')) {
        console.log('Cleaning up incorrect OPTIMIZER_SERVICE URL from localStorage:', optimizerUrl);
        localStorage.removeItem('setting_optimizer_url');
    }
    if (intelligenceUrl && !intelligenceUrl.includes('/api/')) {
        console.log('Cleaning up incorrect INTELLIGENCE_SERVICE URL from localStorage:', intelligenceUrl);
        localStorage.removeItem('setting_intelligence_url');
    }
};

cleanupLocalStorage();

export const DATA_SERVICE = localStorage.getItem('setting_data_url') || `${API_BASE}/market-data`;
export const BACKTEST_SERVICE = localStorage.getItem('setting_backtest_url') || `${API_BASE}/backtest`;
export const OPTIMIZER_SERVICE = localStorage.getItem('setting_optimizer_url') || `${API_BASE}/optimizer`;
export const INTELLIGENCE_SERVICE = localStorage.getItem('setting_intelligence_url') || `${API_BASE}/intelligence`;
export const SETTINGS_URL = `${API_BASE}/settings`;


