import React, { useState } from 'react';
import { Copy, Check, RefreshCw, Code, ExternalLink } from 'lucide-react';

const APITab = () => {
    const [copiedId, setCopiedId] = useState(null);
    const baseUrl = `${window.location.protocol}//${window.location.hostname}:8000`;

    const copyToClipboard = async (text, id) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedId(id);
            setTimeout(() => setCopiedId(null), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const curlExample = `curl -X POST \\
  ${baseUrl}/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{
    "model": "trading-ai",
    "messages": [
      {"role": "user", "content": "Analyze AAPL stock"}
    ],
    "stream": false
  }'`;

    const pythonExample = `import openai

# Configure client to use your trading AI
client = openai.OpenAI(
    base_url="${baseUrl}/v1",
    api_key="not-needed"  # Your agent doesn't require auth
)

# Chat with your trading agent
response = client.chat.completions.create(
    model="trading-ai",
    messages=[
        {"role": "user", "content": "What stocks should I buy for 10x returns?"}
    ]
)

print(response.choices[0].message.content)`;

    const jsExample = `// Using OpenAI SDK
import OpenAI from 'openai';

const client = new OpenAI({
    baseURL: '${baseUrl}/v1',
    apiKey: 'not-needed'
});

const response = await client.chat.completions.create({
    model: 'trading-ai',
    messages: [
        { role: 'user', content: 'Analyze NVDA technicals' }
    ]
});

console.log(response.choices[0].message.content);`;

    return (
        <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
            <div style={{ marginBottom: '2rem' }}>
                <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 0.5rem 0' }}>
                    <RefreshCw size={24} />
                    OpenAI-Compatible API
                </h1>
                <p style={{ margin: 0, opacity: 0.7 }}>
                    Use your trading agent with any OpenAI-compatible client or service
                </p>
            </div>

            {/* Endpoints */}
            <div style={{ background: 'var(--bg-secondary)', borderRadius: '8px', padding: '1.5rem', marginBottom: '2rem' }}>
                <h3 style={{ margin: '0 0 1rem 0' }}>🔌 API Endpoints</h3>
                
                <div style={{ display: 'grid', gap: '1rem' }}>
                    <div>
                        <label style={{ display: 'block', fontSize: '0.9rem', opacity: 0.7, marginBottom: '0.5rem' }}>
                            Base URL:
                        </label>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <code style={{ flex: 1, padding: '0.5rem', background: 'var(--bg-primary)', borderRadius: '4px' }}>
                                {baseUrl}/v1
                            </code>
                            <button 
                                onClick={() => copyToClipboard(`${baseUrl}/v1`, 'base-url')}
                                style={{ padding: '0.5rem', background: 'transparent', border: '1px solid var(--border-subtle)', borderRadius: '4px', cursor: 'pointer' }}
                            >
                                {copiedId === 'base-url' ? <Check size={16} /> : <Copy size={16} />}
                            </button>
                        </div>
                    </div>

                    <div>
                        <label style={{ display: 'block', fontSize: '0.9rem', opacity: 0.7, marginBottom: '0.5rem' }}>
                            Chat Completions:
                        </label>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <code style={{ flex: 1, padding: '0.5rem', background: 'var(--bg-primary)', borderRadius: '4px' }}>
                                POST {baseUrl}/v1/chat/completions
                            </code>
                            <button 
                                onClick={() => copyToClipboard(`${baseUrl}/v1/chat/completions`, 'chat-url')}
                                style={{ padding: '0.5rem', background: 'transparent', border: '1px solid var(--border-subtle)', borderRadius: '4px', cursor: 'pointer' }}
                            >
                                {copiedId === 'chat-url' ? <Check size={16} /> : <Copy size={16} />}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Examples */}
            <div style={{ display: 'grid', gap: '2rem' }}>
                {/* cURL */}
                <div style={{ background: 'var(--bg-secondary)', borderRadius: '8px', padding: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                        <h3 style={{ margin: 0 }}>🔧 cURL Example</h3>
                        <button 
                            onClick={() => copyToClipboard(curlExample, 'curl')}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', background: 'var(--brand-blue)', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer' }}
                        >
                            {copiedId === 'curl' ? <Check size={16} /> : <Copy size={16} />}
                            Copy
                        </button>
                    </div>
                    <pre style={{ 
                        background: 'var(--bg-primary)', 
                        padding: '1rem', 
                        borderRadius: '4px', 
                        overflow: 'auto',
                        fontSize: '0.85rem',
                        margin: 0
                    }}>
                        {curlExample}
                    </pre>
                </div>

                {/* Python */}
                <div style={{ background: 'var(--bg-secondary)', borderRadius: '8px', padding: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                        <h3 style={{ margin: 0 }}>🐍 Python Example</h3>
                        <button 
                            onClick={() => copyToClipboard(pythonExample, 'python')}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', background: 'var(--brand-blue)', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer' }}
                        >
                            {copiedId === 'python' ? <Check size={16} /> : <Copy size={16} />}
                            Copy
                        </button>
                    </div>
                    <pre style={{ 
                        background: 'var(--bg-primary)', 
                        padding: '1rem', 
                        borderRadius: '4px', 
                        overflow: 'auto',
                        fontSize: '0.85rem',
                        margin: 0
                    }}>
                        {pythonExample}
                    </pre>
                </div>

                {/* JavaScript */}
                <div style={{ background: 'var(--bg-secondary)', borderRadius: '8px', padding: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                        <h3 style={{ margin: 0 }}>⚡ JavaScript Example</h3>
                        <button 
                            onClick={() => copyToClipboard(jsExample, 'js')}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', background: 'var(--brand-blue)', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer' }}
                        >
                            {copiedId === 'js' ? <Check size={16} /> : <Copy size={16} />}
                            Copy
                        </button>
                    </div>
                    <pre style={{ 
                        background: 'var(--bg-primary)', 
                        padding: '1rem', 
                        borderRadius: '4px', 
                        overflow: 'auto',
                        fontSize: '0.85rem',
                        margin: 0
                    }}>
                        {jsExample}
                    </pre>
                </div>
            </div>

            {/* Integration Ideas */}
            <div style={{ background: 'var(--bg-secondary)', borderRadius: '8px', padding: '1.5rem', marginTop: '2rem' }}>
                <h3 style={{ margin: '0 0 1rem 0' }}>🚀 Integration Ideas</h3>
                <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}>
                    <div style={{ padding: '1rem', background: 'var(--bg-primary)', borderRadius: '6px' }}>
                        <h4 style={{ margin: '0 0 0.5rem 0' }}>💬 Chat Apps</h4>
                        <p style={{ margin: 0, fontSize: '0.9rem', opacity: 0.8 }}>
                            Connect to WhatsApp, Telegram, Discord using webhook bridges
                        </p>
                    </div>
                    <div style={{ padding: '1rem', background: 'var(--bg-primary)', borderRadius: '6px' }}>
                        <h4 style={{ margin: '0 0 0.5rem 0' }}>🔗 No-Code Tools</h4>
                        <p style={{ margin: 0, fontSize: '0.9rem', opacity: 0.8 }}>
                            Use with Zapier, Make.com, n8n for automated workflows
                        </p>
                    </div>
                    <div style={{ padding: '1rem', background: 'var(--bg-primary)', borderRadius: '6px' }}>
                        <h4 style={{ margin: '0 0 0.5rem 0' }}>🤖 AI Frameworks</h4>
                        <p style={{ margin: 0, fontSize: '0.9rem', opacity: 0.8 }}>
                            Integrate with LangChain, AutoGen, or custom AI applications
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default APITab;