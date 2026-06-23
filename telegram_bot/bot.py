"""
Telegram bot — connects to the local TradingSpy API via OpenAI-compatible API.
History is stored per chat_id so context carries across messages.
Commands:
  /new    — clear conversation history
  /mode   — show current mode
  /strands, /agentic, /manual — switch mode
"""

import os
import logging
import httpx
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, filters, ContextTypes
from telegram.constants import ChatAction

logging.basicConfig(level=logging.INFO)

TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
BASE_URL       = os.getenv("OPENAI_BASE_URL", "http://localhost:8000/v1")
MODEL          = os.getenv("MODEL", "trading-ai-strands")
MAX_HISTORY    = int(os.getenv("MAX_HISTORY", "20"))   # messages to keep per chat

# In-memory store: { chat_id: [{"role": ..., "content": ...}, ...] }
histories: dict[int, list] = {}
# Per-chat model override
models: dict[int, str] = {}

def get_model(chat_id: int) -> str:
    return models.get(chat_id, MODEL)

def get_history(chat_id: int) -> list:
    return histories.setdefault(chat_id, [])

async def call_api(chat_id: int, user_text: str) -> str:
    history = get_history(chat_id)
    history.append({"role": "user", "content": user_text})

    messages = history[-MAX_HISTORY:]  # trim to limit

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{BASE_URL}/chat/completions",
            json={"model": get_model(chat_id), "messages": messages, "stream": False},
        )
        resp.raise_for_status()
        data = resp.json()

    reply = data["choices"][0]["message"]["content"]
    history.append({"role": "assistant", "content": reply})
    # Keep history bounded
    if len(history) > MAX_HISTORY * 2:
        histories[chat_id] = history[-(MAX_HISTORY * 2):]

    return reply


# ── Command handlers ──────────────────────────────────────────────────────────

async def cmd_new(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    histories[update.effective_chat.id] = []
    await update.message.reply_text("🆕 Conversation cleared. Fresh start!")

async def cmd_mode(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    m = get_model(update.effective_chat.id)
    await update.message.reply_text(f"Current mode: `{m}`\n\nSwitch with /strands, /agentic, or /manual", parse_mode="Markdown")

async def cmd_strands(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    models[update.effective_chat.id] = "trading-ai-strands"
    await update.message.reply_text("🚀 Switched to **Strands** mode — iterative agent with tools.", parse_mode="Markdown")

async def cmd_agentic(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    models[update.effective_chat.id] = "trading-ai-agentic"
    await update.message.reply_text("🔧 Switched to **Agentic** mode — parallel tool execution.", parse_mode="Markdown")

async def cmd_manual(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    models[update.effective_chat.id] = "trading-ai-manual"
    await update.message.reply_text("👤 Switched to **Manual** mode — suggestions only, no tool execution.", parse_mode="Markdown")

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 TradingSpy Bot\n\n"
        "Ask me anything about stocks, run backtests, search news, or build strategies.\n\n"
        "Commands:\n"
        "/new — clear history\n"
        "/strands — agentic loop mode (default)\n"
        "/agentic — parallel tool mode\n"
        "/manual — suggestions only\n"
        "/mode — show current mode"
    )

# ── Message handler ───────────────────────────────────────────────────────────

async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    text = update.message.text

    await ctx.bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)

    try:
        reply = await call_api(chat_id, text)
    except Exception as e:
        logging.error(f"API error: {e}")
        reply = f"⚠️ Error contacting TradingSpy: {e}"

    # Telegram max message length is 4096
    for i in range(0, len(reply), 4096):
        await update.message.reply_text(reply[i:i+4096])


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not TELEGRAM_TOKEN:
        raise ValueError("TELEGRAM_BOT_TOKEN is not set")

    app = ApplicationBuilder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start",   cmd_start))
    app.add_handler(CommandHandler("new",     cmd_new))
    app.add_handler(CommandHandler("mode",    cmd_mode))
    app.add_handler(CommandHandler("strands", cmd_strands))
    app.add_handler(CommandHandler("agentic", cmd_agentic))
    app.add_handler(CommandHandler("manual",  cmd_manual))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logging.info(f"Bot starting — model: {MODEL}, base_url: {BASE_URL}")
    app.run_polling()
