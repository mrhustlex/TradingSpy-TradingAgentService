/**
 * Helper to get API key and provider settings from localStorage
 * This ensures consistent API key retrieval across all components
 */

const DEFAULT_PROVIDER = 'google_ai_studio';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const supportedProviders = new Set(['google_ai_studio', 'mistral', 'openrouter', 'litellm']);

const normalizeProvider = (provider) => {
    const p = (provider || DEFAULT_PROVIDER).trim().toLowerCase().replace(/[-\s]/g, '_');
    if (p === 'googleaistudio' || p === 'google_ai' || p === 'gemini') return 'google_ai_studio';
    if (p === 'lite_llm' || p === 'lite') return 'litellm';
    return supportedProviders.has(p) ? p : DEFAULT_PROVIDER;
};
const isSupportedProviderInput = (provider) => {
    const p = (provider || '').trim().toLowerCase().replace(/[-\s]/g, '_');
    let normalized = p === 'googleaistudio' || p === 'google_ai' || p === 'gemini' ? 'google_ai_studio' : p;
    if (normalized === 'lite_llm' || normalized === 'lite') normalized = 'litellm';
    return supportedProviders.has(normalized);
};

const keyMap = {
    openrouter: 'settings_openrouter_api_key',
    google_ai_studio: 'settings_google_ai_studio_api_key',
    googleaistudio: 'settings_google_ai_studio_api_key',
    gemini: 'settings_google_ai_studio_api_key',
    mistral: 'settings_mistral_api_key',
    litellm: 'settings_litellm_api_key',
};

export const getApiSettings = () => {
    // Get provider and model from localStorage (set by Settings component)
    const rawProvider = localStorage.getItem('settings_default_provider') || DEFAULT_PROVIDER;
    const provider = normalizeProvider(rawProvider);
    const model = isSupportedProviderInput(rawProvider) ? (localStorage.getItem('settings_default_model') || DEFAULT_MODEL) : DEFAULT_MODEL;
    
    const storedKey = localStorage.getItem(keyMap[provider] || keyMap[DEFAULT_PROVIDER]) || '';
    const api_key = storedKey;
    
    console.log('🔑 [apiKeyHelper] getApiSettings called:', {
        provider,
        model,
        hasApiKey: !!api_key,
        localStorageKey: keyMap[provider]
    });
    
    return { provider, model, api_key };
};

export const getApiKey = (provider) => {
    provider = normalizeProvider(provider);
    
    const storedKey = localStorage.getItem(keyMap[provider] || keyMap[DEFAULT_PROVIDER]) || '';
    return storedKey;
};
