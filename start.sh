#!/bin/bash
# ClickN Earn Official - Telegram Mini App + Bot launcher

set -e
cd "$(dirname "$0")"

echo "========================================"
echo "  ClickN Earn Official - Starter"
echo "========================================"

# 1. Install dependencies (first run only)
if ! python3 -c "import fastapi, uvicorn, httpx" 2>/dev/null; then
  echo "[1/3] Installing Python dependencies..."
  pip3 install --break-system-packages --quiet -r requirements.txt
else
  echo "[1/3] Dependencies already installed."
fi

# 2. Verify bot token
echo "[2/3] Verifying Telegram bot..."
python3 - <<'PY'
import asyncio
import sys
sys.path.insert(0, "backend")
import bot

async def main():
    ok, me = await bot.get_me()
    if not ok:
        print("ERROR: Bot token is invalid or network unreachable.")
        print("Please check BOT_TOKEN in backend/config.py")
        sys.exit(1)
    print("Bot online:", me.get("username", "?"))

asyncio.run(main())
PY

# 3. Start server
echo "[3/3] Starting server on port 8000..."
echo "  Mini App  : http://localhost:8000"
echo "  Admin     : http://localhost:8000/admin"
echo "  Press Ctrl+C to stop."
cd backend
exec python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
