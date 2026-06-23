# Google Vertex AI Integration Guide

Your trading chatbot now supports **Google Vertex AI** across all 3 agent modes. Here's how to set it up and use it.

## Setup Steps

### 1. Get Your GCP Credentials

**Option A: Using API Key (Easiest for Local Testing)**
- Go to [Google Cloud Console](https://console.cloud.google.com/)
- Create a new project or select existing one
- Enable the **Vertex AI API**
- Go to **APIs & Services → Credentials**
- Click **Create Credentials → API Key**
- Copy the API key

**Option B: Using Service Account (More Secure)**
- Go to **APIs & Services → Service Accounts**
- Create a new service account
- Grant it **Vertex AI User** role
- Create a JSON key and download it
- Set `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the JSON file path

### 2. Configure in Settings

1. Open the **Settings** page in your chatbot
2. In **AI Global Defaults**, select **GCP Vertex AI** from the provider dropdown
3. Fill in:
   - **GCP API Key**: Paste your API key (if using Option A)
   - **GCP Project ID**: Your GCP project ID (e.g., `my-project-123`)
   - **GCP Location**: Region for Vertex AI (default: `us-central1`)
4. In **Default Model Name**, enter a Vertex AI model:
   - `gemini-2.0-flash` (latest, fastest)
   - `gemini-1.5-pro` (most capable)
   - `gemini-1.5-flash` (balanced)
5. Click **Apply System Changes**

### 3. Verify It Works

Send a test message in any of the 3 chat modes:
- **Manual Mode**: I'll suggest actions for you to confirm
- **Agentic Mode**: I'll execute tasks automatically with parallel tools
- **Strands Mode**: I'll reason iteratively, accumulating context

## How It Works Across 3 Modes

### Manual Mode
- Vertex AI analyzes your request
- Suggests specific actions (create strategy, backtest, download data)
- You confirm each action before execution
- Good for learning and control

### Agentic Mode
- Vertex AI executes multiple tools in parallel
- Fetches market data, analyzes technicals, searches news
- Combines results into comprehensive response
- Fastest mode for complex queries

### Strands Mode
- Vertex AI reasons iteratively through your request
- Each "strand" adds context and refines analysis
- Shows thinking process and execution steps
- Best for deep analysis and strategy development

## Supported Models

| Model | Speed | Capability | Best For |
|-------|-------|-----------|----------|
| `gemini-2.0-flash` | ⚡⚡⚡ | High | Real-time analysis, quick responses |
| `gemini-1.5-pro` | ⚡⚡ | Very High | Complex strategy analysis |
| `gemini-1.5-flash` | ⚡⚡⚡ | High | Balanced performance |

## Troubleshooting

**"GCP Vertex AI: GCP_PROJECT is required"**
- Make sure you filled in the GCP Project ID in Settings

**"Vertex AI API error: 401"**
- Check your API key is correct
- Verify Vertex AI API is enabled in your GCP project

**"Vertex AI failed: Permission denied"**
- If using service account, ensure it has **Vertex AI User** role
- If using API key, regenerate it in the console

**Slow responses**
- Try `gemini-2.0-flash` for faster inference
- Check your GCP region (closer regions = lower latency)

## Environment Variables (Optional)

You can also set these in your `.env` file:

```
GCP_API_KEY=your_api_key_here
GCP_PROJECT=your-project-id
GCP_LOCATION=us-central1
```

These will be used as fallbacks if not set in Settings.

## Cost Considerations

Vertex AI pricing varies by model. Check [Google's pricing page](https://cloud.google.com/vertex-ai/pricing) for current rates. Most models are very affordable for development/testing.

## Tips for Best Results

1. **Use Agentic Mode** for market analysis — it's fastest and most comprehensive
2. **Use Strands Mode** for strategy development — you'll see the reasoning
3. **Use Manual Mode** when you want to review each action before execution
4. **Start with `gemini-2.0-flash`** — it's the fastest and most cost-effective
5. **Keep your API key secure** — never commit it to git (it's stored in browser localStorage only)

## What's Supported

✅ Real-time market quotes and technicals  
✅ Strategy generation and backtesting  
✅ Market data downloads  
✅ News and web search  
✅ Multi-turn conversations with history  
✅ Streaming responses  
✅ Tool calling and function execution  

## Need Help?

- Check the Settings page for your current configuration
- Look at the browser console (F12) for detailed error messages
- Verify your GCP project has Vertex AI API enabled
- Make sure your API key hasn't expired
