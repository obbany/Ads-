# ClickN Earn Official

A Telegram Mini App where users earn USDT by completing tasks (joining channels, subscribing to YouTube, visiting websites, watching 15s ads) and inviting friends, then withdraw to their Binance UID. Includes a full admin panel.

## Architecture

- **Backend**: Python (FastAPI + Uvicorn), SQLite database (single `data.db` file, WAL mode - handles many concurrent users without locks)
- **Telegram bot**: lightweight polling bot (welcome message + "Open ClickN Earn" button + admin notifications to users)
- **Frontend**: Mobile-first Mini App (`/`) and Admin panel (`/admin`), served by the backend on a single port (no CORS issues)

```
clickn-earn/
├── backend/
│   ├── config.py        # tokens, admin id, withdraw defaults
│   ├── database.py      # SQLite schema + helpers
│   ├── bot.py           # Telegram bot (welcome + notify)
│   └── main.py          # FastAPI app (user + admin APIs, static files)
├── frontend/
│   ├── index.html       # Mini App (Dashboard / Task / Withdraw / Profile)
│   ├── admin.html       # Admin panel
│   ├── css/             # styles
│   └── js/              # app.js + admin.js
├── requirements.txt
└── start.sh
```

## How to run (A to Z)

### 1. Install

```bash
cd clickn-earn
bash start.sh
```

Or manually:

```bash
pip3 install --break-system-packages -r requirements.txt
cd backend
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

The server runs everything on **one port (8000)**:
- Mini App: `http://localhost:8000`
- Admin: `http://localhost:8000/admin`

### 2. Configure (backend/config.py)

| Setting | Value |
|---|---|
| `BOT_TOKEN` | your Telegram bot token (already set) |
| `ADMIN_ID` | your Telegram user ID (already set: `5858681713`) |
| `ADMIN_PASSWORD` | admin panel password (change this!) |
| `WEBAPP_URL` | public HTTPS URL of the mini app (see below) |
| `BOT_USERNAME` | your bot username without `@` |
| `APP_SHORT_NAME` | mini app short name from @BotFather (used for invite links) |

### 3. Create the Mini App in Telegram

1. Open **@BotFather**.
2. `/newapp` -> choose your bot -> name the app -> upload a photo -> set a **short name** (e.g. `clicknearn`) -> set the **Web App URL** to your public HTTPS URL.
3. If the bot does not exist yet, create it first with `/newbot`.
4. Make the bot an **admin** (not needed for the app itself, but needed so the bot can verify channel/group membership tasks).

### 4. Make it public

Telegram Mini Apps require **HTTPS**. For local development you can use a tunnel (ngrok/cloudflared), but the recommended path is to use the platform's preview feature which gives you a public `*.monkeycode-ai.live` URL - put that URL in `WEBAPP_URL` and in @BotFather.

### 5. Admin panel

- Open `http://localhost:8000/admin`
- Login with `ADMIN_PASSWORD` (default `ClickN2026!Admin`)
- Overview: totals, pending withdrawals
- Users: search, view any user, adjust balance (user gets a Telegram notification)
- Withdrawals: confirm (pay) or reject (auto-refund + notify user via bot)
- Tasks: create/edit/delete tasks (Telegram channel, Telegram group, YouTube, website visit, 15s video ad)
- Send Message: broadcast to all users or a single user, in-app + via Telegram bot
- Settings: min/max withdraw, referral reward, site name, Monetag 15s ad HTML code

### 6. Testing without Telegram

Open the app in a browser - it runs in **Preview Mode** with a test user (id `900000001`). Use `?uid=123` to switch test users.

## Features

**User Mini App**
- Welcome message from bot with "Open ClickN Earn" button
- Bottom navigation: Dashboard | Task | Withdraw | Profile
- Dashboard: notification bell (admin messages), Total Balance card (hide/show with eye), Overview (Total Earning / Task Done / Total Refer / Available), Invite Friends card with gift box
- Tasks: join channel/group (membership verified), subscribe YouTube, visit website, watch 15s video ad (with Monetag code support)
- Withdraw: Binance UID input, quick amounts ($1/$3/$5/$8/$10), min/max limits from admin, history
- Profile: ID card, Wallet Address (save Binance UID, auto-fills in withdraw), Payment History (All/Earnings/Withdraw/Task), Security (coming soon), About, Sign Out (returns to Telegram chat)
- Referrals: 0.20 USDT per active referral via invite link `t.me/<bot>/<app>?startapp=ref_<id>`

## Database tables

`users`, `tasks`, `task_completions`, `withdrawals`, `transactions`, `notifications`, `referred_users`, `settings` - all in `data.db` (auto-created on first start).

## Security notes

- Change `ADMIN_PASSWORD` before going live.
- Telegram initData is cryptographically verified on every login (HMAC).
- Never share your bot token.
