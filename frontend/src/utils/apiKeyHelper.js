/**
 * Helper to get API key and provider settings from localStorage
 * This ensures consistent API key retrieval across all components
 */

const normalizeProvider = (provider) => {
    const p = (provider || 'openai').trim().toLowerCase().replace(/[-\s]/g, '_');
    if (p === 'googleaistudio' || p === 'google_ai' || p === 'gemini') return 'google_ai_studio';
    return p;
};

const keyMap = {
    openai: 'settings_openai_api_key',
    openrouter: 'settings_openrouter_api_key',
    groq: 'settings_groq_api_key',
    google_ai_studio: 'settings_google_ai_studio_api_key',
    googleaistudio: 'settings_google_ai_studio_api_key',
    gemini: 'settings_google_ai_studio_api_key',
    litellm: 'settings_litellm_api_key',
    mistral: 'settings_mistral_api_key',
    azure: 'settings_azure_openai_api_key',
    aws: 'settings_aws_access_key_id',
    gcp: 'settings_gcp_api_key',
};

export const getApiSettings = () => {
    // Get provider and model from localStorage (set by Settings component)
    const provider = normalizeProvider(localStorage.getItem('settings_default_provider') || 'openai');
    const model = localStorage.getItem('settings_default_model') || 'gpt-4o';
    
    const storedKey = localStorage.getItem(keyMap[provider] || keyMap.openai) || '';
    const api_key = provider === 'litellm' && !storedKey ? 'not-needed' : storedKey;
    
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
    
    const storedKey = localStorage.getItem(keyMap[provider] || keyMap.openai) || '';
    return provider === 'litellm' && !storedKey ? 'not-needed' : storedKey;
};
