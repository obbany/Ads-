import os

BOT_TOKEN = os.getenv("BOT_TOKEN", "8752455603:AAGjoAVwX5kl84I7IscGcy4eLzbKjepvxNI")
ADMIN_ID = int(os.getenv("ADMIN_ID", "5858681713"))
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "ClickN2026!Admin")

# Public URL where this web app is reachable. Used for Telegram WebApp button
# and for building deep links (invite links).
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://8000-2154e6841eb5a6d4.monkeycode-ai.live")

# Bot username WITHOUT the @ (set this after creating the bot)
BOT_USERNAME = os.getenv("BOT_USERNAME", "Click_Earn2_Bot")

# Mini app short name as configured in @BotFather (used for deep links)
APP_SHORT_NAME = os.getenv("APP_SHORT_NAME", "clicknearn")

# Withdrawal defaults
DEFAULT_MIN_WITHDRAW = 1.0
DEFAULT_MAX_WITHDRAW = 10.0
WITHDRAW_OPTIONS = [1.0, 3.0, 5.0, 8.0, 10.0]

# Referral reward
REFERRAL_REWARD = 0.20

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data.db")
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
