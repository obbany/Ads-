import asyncio
import hashlib
import hmac
import json
import logging
import re
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import bot
import config
from database import db, get_conn, get_setting, init_db, rows_to_dicts, set_setting

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("app")

init_db()
STATIC = Path(config.STATIC_DIR)

# ---------------------------------------------------------------- utilities

_TOKEN_SECRET = hashlib.sha256(config.BOT_TOKEN.encode()).hexdigest()
ADMIN_TOKEN_SECRET = hashlib.sha256(f"admin::{config.ADMIN_PASSWORD}".encode()).hexdigest()
bot_loop: asyncio.AbstractEventLoop | None = None

TRUST_CHANNELS = {}
MEMBERSHIP_CACHE = {}


def _sign(payload: str, secret: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_token(tid: int) -> str:
    return f"{tid}.{_sign(str(tid), _TOKEN_SECRET)}"


def parse_token(token: str) -> int | None:
    try:
        tid, sig = token.split(".", 1)
        if hmac.compare_digest(sig, _sign(tid, _TOKEN_SECRET)):
            return int(tid)
    except Exception:  # noqa: BLE001
        pass
    return None


def make_admin_token() -> str:
    return _sign("admin", ADMIN_TOKEN_SECRET)


def verify_admin_token(token: str) -> bool:
    return bool(token) and hmac.compare_digest(token, make_admin_token())


def verify_init_data(init_data: str) -> dict | None:
    """Verify Telegram WebApp initData and return parsed fields."""
    try:
        raw = {}
        for p in init_data.split("&"):
            k, _, v = p.partition("=")
            raw[k] = v
        received_hash = raw.pop("hash", "")
        if not received_hash:
            return None
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(raw.items()))
        secret_key = hmac.new(b"WebAppData", config.BOT_TOKEN.encode(), hashlib.sha256).digest()
        calc = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calc, received_hash):
            return None
        return {k: unquote(v) for k, v in raw.items()}
    except Exception:  # noqa: BLE001
        return None


def get_or_create_user(tid, username="", first_name="", photo_url=""):
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE telegram_id=?", (tid,)).fetchone()
    if row:
        updates, params = [], []
        if username and row["username"] != username:
            updates.append("username=?"); params.append(username)
        if first_name and row["first_name"] != first_name:
            updates.append("first_name=?"); params.append(first_name)
        if photo_url and row["photo_url"] != photo_url:
            updates.append("photo_url=?"); params.append(photo_url)
        if updates:
            params.append(tid)
            conn.execute(f"UPDATE users SET {', '.join(updates)} WHERE telegram_id=?", params)
            conn.commit()
        return dict(row)
    with db() as c:
        cur = c.execute(
            "INSERT INTO users (telegram_id, username, first_name, photo_url) VALUES (?,?,?,?)",
            (tid, username, first_name, photo_url),
        )
    row = conn.execute("SELECT * FROM users WHERE telegram_id=?", (tid,)).fetchone()
    return dict(row)


def process_referral(user: dict, start_param: str):
    m = re.match(r"ref_(\d+)", start_param or "")
    if not m or user["referred_by"]:
        return False
    ref_id = int(m.group(1))
    if ref_id == user["telegram_id"]:
        return False
    conn = get_conn()
    referrer = conn.execute("SELECT * FROM users WHERE telegram_id=?", (ref_id,)).fetchone()
    if not referrer:
        return False
    reward = float(get_setting("referral_reward", "0.2"))
    conn.execute("UPDATE users SET referred_by=? WHERE id=?", (ref_id, user["id"]))
    conn.execute(
        "INSERT OR IGNORE INTO referred_users (referrer_id, ref_telegram_id) VALUES (?,?)",
        (referrer["id"], user["telegram_id"]),
    )
    conn.execute(
        "UPDATE users SET balance=balance+?, total_earnings=total_earnings+?, "
        "total_referrals=total_referrals+1 WHERE id=?",
        (reward, reward, referrer["id"]),
    )
    conn.execute(
        "INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)",
        (referrer["id"], "referral", reward, f"New referral bonus for {user['first_name'] or user['username'] or user['telegram_id']}"),
    )
    conn.commit()
    try:
        schedule_coro(
            bot.notify_user(
                ref_id,
                f"ðŸŽ‰ New referral! *{user['first_name'] or user['username']}* joined using your link.\n"
                f"ðŸ’° You earned *{reward:.2f} USDT*.",
            )
        )
    except Exception:  # noqa: BLE001
        pass
    return True


def credit_user(user_id, amount, txn_type, description):
    with db() as c:
        c.execute(
            "UPDATE users SET balance=balance+?, total_earnings=total_earnings+? WHERE id=?",
            (amount, amount, user_id),
        )
        c.execute(
            "INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)",
            (user_id, txn_type, amount, description),
        )
        if txn_type == "task":
            c.execute("UPDATE users SET total_tasks_done=total_tasks_done+1 WHERE id=?", (user_id,))


def schedule_coro(coro):
    global bot_loop
    if bot_loop and not bot_loop.is_closed():
        asyncio.run_coroutine_threadsafe(coro, bot_loop)
    return True


def require_user(request: Request) -> dict:
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    tid = parse_token(token)
    if not tid:
        raise HTTPException(401, "Unauthorized")
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE telegram_id=?", (tid,)).fetchone()
    if not row:
        raise HTTPException(401, "Unauthorized")
    return dict(row)


def require_admin(request: Request) -> bool:
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not verify_admin_token(token):
        raise HTTPException(401, "Invalid admin token")
    return True


def public_user(u):
    return {
        "id": u["id"],
        "telegram_id": u["telegram_id"],
        "username": u["username"],
        "first_name": u["first_name"],
        "photo_url": u["photo_url"],
        "balance": u["balance"],
        "total_earnings": u["total_earnings"],
        "total_tasks_done": u["total_tasks_done"],
        "total_referrals": u["total_referrals"],
        "wallet_address": u["wallet_address"],
        "created_at": u["created_at"],
    }


# ---------------------------------------------------------------- lifespan

@asynccontextmanager
async def lifespan(app: FastAPI):
    global bot_loop
    bot_loop = asyncio.get_event_loop()
    task = asyncio.create_task(bot.bot_runner())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


# ---------------------------------------------------------------- user API

@app.post("/api/auth")
async def auth(request: Request):
    body = await request.json()
    init_data = body.get("init_data", "")
    tid = body.get("dev_uid")
    start_param = ""

    if init_data:
        parts = verify_init_data(init_data)
        if not parts:
            raise HTTPException(401, "Invalid Telegram data")
        try:
            user_info = json.loads(parts.get("user", "{}"))
            tid = int(user_info["id"])
        except Exception:  # noqa: BLE001
            raise HTTPException(401, "Invalid user payload")
        start_param = parts.get("start_param", "")
        username = user_info.get("username", "")
        first_name = user_info.get("first_name", "")
        photo_url = user_info.get("photo_url", "")
    else:
        if not tid:
            raise HTTPException(400, "No auth data")
        tid = int(tid)
        username = body.get("username", "")
        first_name = body.get("first_name", body.get("username", ""))
        photo_url = body.get("photo_url", "")

    user = get_or_create_user(tid, username, first_name, photo_url)
    process_referral(user, start_param)
    user = get_or_create_user(tid)
    return {"token": make_token(tid), "user": public_user(user)}


@app.get("/api/me")
def me(request: Request):
    u = require_user(request)
    return {
        "user": public_user(u),
        "site_name": get_setting("site_name", "ClickN Earn Official"),
        "min_withdraw": float(get_setting("min_withdraw", "1")),
        "max_withdraw": float(get_setting("max_withdraw", "10")),
    }


@app.get("/api/dashboard")
def dashboard(request: Request):
    u = require_user(request)
    unread = get_conn().execute(
        "SELECT COUNT(*) c FROM notifications WHERE is_read=0 AND (user_id=? OR user_id=0)",
        (u["id"],),
    ).fetchone()["c"]
    return {
        "user": public_user(u),
        "unread_notifications": unread,
        "referral_reward": float(get_setting("referral_reward", "0.2")),
        "invite_link": bot.invite_deep_link(u["telegram_id"]),
    }


@app.get("/api/tasks")
def list_tasks(request: Request):
    u = require_user(request)
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM tasks WHERE status=1 ORDER BY sort, id"
    ).fetchall()
    done = {r["task_id"] for r in conn.execute(
        "SELECT task_id FROM task_completions WHERE user_id=? AND status='completed'",
        (u["id"],),
    )}
    tasks = []
    for r in rows:
        d = dict(r)
        d["done"] = r["id"] in done
        tasks.append(d)
    return {"tasks": tasks, "balance": u["balance"], "ad_code": get_setting("ad_15s_code", "")}


async def _check_chat_membership(chat_username: str, tid: int) -> bool | None:
    """Return True if member, False if not, None if cannot verify."""
    if chat_username in MEMBERSHIP_CACHE:
        return MEMBERSHIP_CACHE[chat_username]
    ok, result = await bot.api_call(
        "getChatMember",
        chat_id=f"@{chat_username}",
        user_id=tid,
    )
    if not ok:
        return None
    status = result.get("status", "")
    member = status in ("member", "administrator", "creator")
    MEMBERSHIP_CACHE[chat_username] = member
    return member


def extract_chat_username(link: str) -> str | None:
    m = re.search(r"(?:t\.me/|telegram\.me/)([A-Za-z0-9_]{5,})", link or "")
    if not m:
        m = re.match(r"@([A-Za-z0-9_]{5,})", link or "")
    return m.group(1) if m else None


@app.post("/api/tasks/{task_id}/complete")
async def complete_task(task_id: int, request: Request):
    u = require_user(request)
    conn = get_conn()
    task = conn.execute("SELECT * FROM tasks WHERE id=? AND status=1", (task_id,)).fetchone()
    if not task:
        raise HTTPException(404, "Task not found")
    existing = conn.execute(
        "SELECT * FROM task_completions WHERE user_id=? AND task_id=?",
        (u["id"], task_id),
    ).fetchone()
    if existing:
        raise HTTPException(400, "Task already completed")

    if task["type"] in ("telegram_channel", "telegram_group"):
        uname = extract_chat_username(task["link"])
        if uname:
            status = await _check_chat_membership(uname, u["telegram_id"])
            if status is False:
                raise HTTPException(400, "You have not joined yet. Join the channel/group first.")

    with db() as c:
        c.execute(
            "INSERT INTO task_completions (user_id, task_id, reward, status) VALUES (?,?,?,?)",
            (u["id"], task_id, task["reward"], "completed"),
        )
    credit_user(u["id"], task["reward"], "task", task["title"])
    return {"success": True, "reward": task["reward"], "message": f"+{task['reward']:.2f} USDT earned!"}


@app.get("/api/withdraw")
def withdraw_page(request: Request):
    u = require_user(request)
    conn = get_conn()
    history = rows_to_dicts(conn.execute(
        "SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 50",
        (u["id"],),
    ).fetchall())
    return {
        "balance": u["balance"],
        "wallet_address": u["wallet_address"],
        "min": float(get_setting("min_withdraw", "1")),
        "max": float(get_setting("max_withdraw", "10")),
        "options": config.WITHDRAW_OPTIONS,
        "history": history,
    }


@app.post("/api/withdraw")
async def create_withdraw(request: Request):
    body = await request.json()
    u = require_user(request)
    binance_uid = str(body.get("binance_uid", "")).strip()
    amount = float(body.get("amount", 0))
    if not binance_uid or not binance_uid.isdigit() or len(binance_uid) < 6:
        raise HTTPException(400, "Please enter a valid Binance UID")
    min_w = float(get_setting("min_withdraw", "1"))
    max_w = float(get_setting("max_withdraw", "10"))
    if amount < min_w or amount > max_w:
        raise HTTPException(400, f"Withdrawal amount must be between {min_w:g} and {max_w:g} USDT")
    if amount > u["balance"]:
        raise HTTPException(400, "Insufficient balance")
    with db() as c:
        c.execute(
            "UPDATE users SET balance=balance-? WHERE id=?",
            (amount, u["id"]),
        )
        cur = c.execute(
            "INSERT INTO withdrawals (user_id, binance_uid, amount, status) VALUES (?,?,?,?)",
            (u["id"], binance_uid, amount, "pending"),
        )
        c.execute(
            "INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)",
            (u["id"], "withdraw", -amount, f"Withdrawal request to {binance_uid}"),
        )
    return {"success": True, "withdrawal_id": cur.lastrowid}


@app.post("/api/wallet")
async def save_wallet(request: Request):
    u = require_user(request)
    body = await request.json()
    address = str(body.get("address", "")).strip()
    if not address:
        raise HTTPException(400, "Wallet address is empty")
    if not address.isdigit() or len(address) < 6:
        raise HTTPException(400, "Please enter a valid Binance UID (numbers only)")
    with db() as c:
        c.execute("UPDATE users SET wallet_address=? WHERE id=?", (address, u["id"]))
    return {"success": True, "wallet_address": address}


@app.get("/api/payments")
def payments(request: Request):
    u = require_user(request)
    f = request.query_params.get("filter", "all")
    q = "SELECT * FROM transactions WHERE user_id=? "
    p = [u["id"]]
    if f == "earnings":
        q += "AND amount>0 "
    elif f == "withdraw":
        q += "AND type='withdraw' "
    elif f == "task":
        q += "AND type='task' "
    q += "ORDER BY id DESC LIMIT 100"
    rows = rows_to_dicts(get_conn().execute(q, p).fetchall())
    return {"transactions": rows, "balance": u["balance"]}


@app.get("/api/notifications")
def notifications(request: Request):
    u = require_user(request)
    rows = rows_to_dicts(get_conn().execute(
        "SELECT * FROM notifications WHERE user_id=? OR user_id=0 ORDER BY id DESC LIMIT 50",
        (u["id"],),
    ).fetchall())
    get_conn().execute(
        "UPDATE notifications SET is_read=1 WHERE is_read=0 AND (user_id=? OR user_id=0)",
        (u["id"],),
    )
    get_conn().commit()
    return {"notifications": rows}


# ---------------------------------------------------------------- admin API

@app.post("/api/admin/login")
async def admin_login(request: Request):
    body = await request.json()
    if body.get("password") != config.ADMIN_PASSWORD:
        raise HTTPException(401, "Wrong password")
    return {"token": make_admin_token()}


@app.get("/api/admin/stats")
def admin_stats(request: Request):
    require_admin(request)
    conn = get_conn()
    users = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
    pending = conn.execute("SELECT COUNT(*) c FROM withdrawals WHERE status='pending'").fetchone()["c"]
    confirmed = conn.execute("SELECT COUNT(*) c FROM withdrawals WHERE status='confirmed'").fetchone()["c"]
    tasks = conn.execute("SELECT COUNT(*) c FROM tasks").fetchone()["c"]
    total_earned = conn.execute("SELECT COALESCE(SUM(total_earnings),0) s FROM users").fetchone()["s"]
    total_balance = conn.execute("SELECT COALESCE(SUM(balance),0) s FROM users").fetchone()["s"]
    total_paid = conn.execute(
        "SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE status='confirmed'"
    ).fetchone()["s"]
    recent = rows_to_dicts(conn.execute("SELECT * FROM withdrawals ORDER BY id DESC LIMIT 10").fetchall())
    return {
        "users": users,
        "pending": pending,
        "confirmed": confirmed,
        "tasks": tasks,
        "total_earned": total_earned,
        "total_balance": total_balance,
        "total_paid": total_paid,
        "recent_withdrawals": recent,
    }


@app.get("/api/admin/users")
def admin_users(request: Request):
    require_admin(request)
    search = request.query_params.get("search", "").strip()
    q = "SELECT * FROM users "
    p = []
    if search:
        q += "WHERE username LIKE ? OR first_name LIKE ? OR CAST(telegram_id AS TEXT) LIKE ? "
        like = f"%{search}%"
        p = [like, like, like]
    q += "ORDER BY id DESC LIMIT 200"
    rows = rows_to_dicts(get_conn().execute(q, p).fetchall())
    return {"users": rows}


@app.get("/api/admin/users/{uid}")
def admin_user_detail(uid: int, request: Request):
    require_admin(request)
    conn = get_conn()
    user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not user:
        raise HTTPException(404, "User not found")
    withdrawals = rows_to_dicts(conn.execute(
        "SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC", (uid,)
    ).fetchall())
    txns = rows_to_dicts(conn.execute(
        "SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 100", (uid,)
    ).fetchall())
    return {"user": dict(user), "withdrawals": withdrawals, "transactions": txns}


@app.post("/api/admin/users/{uid}/balance")
async def admin_adjust_balance(uid: int, request: Request):
    require_admin(request)
    body = await request.json()
    amount = float(body.get("amount", 0))
    if amount == 0:
        raise HTTPException(400, "Amount must not be zero")
    conn = get_conn()
    user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not user:
        raise HTTPException(404, "User not found")
    credit_user(uid, amount, "admin", body.get("reason", "Balance adjusted by admin"))
    user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    try:
        schedule_coro(bot.notify_user(
            user["telegram_id"],
            f"ðŸ’³ *Balance updated by admin*\nYour balance changed by *{amount:+.2f} USDT*.\n"
            f"New balance: *{user['balance']:.2f} USDT*.",
        ))
    except Exception:  # noqa: BLE001
        pass
    return {"success": True, "balance": user["balance"]}


@app.get("/api/admin/withdrawals")
def admin_withdrawals(request: Request):
    require_admin(request)
    status = request.query_params.get("status", "")
    q = "SELECT w.*, u.username, u.first_name, u.telegram_id FROM withdrawals w JOIN users u ON u.id=w.user_id "
    p = []
    if status:
        q += "WHERE w.status=? "
        p.append(status)
    q += "ORDER BY w.id DESC LIMIT 300"
    rows = rows_to_dicts(get_conn().execute(q, p).fetchall())
    return {"withdrawals": rows}


@app.post("/api/admin/withdrawals/{wid}/confirm")
def admin_confirm_withdraw(wid: int, request: Request):
    require_admin(request)
    return _process_withdraw(wid, "confirmed", "âœ… Your withdrawal was *confirmed* and sent to your Binance UID.")


@app.post("/api/admin/withdrawals/{wid}/reject")
def admin_reject_withdraw(wid: int, request: Request):
    require_admin(request)
    return _process_withdraw(wid, "rejected", "âŒ Your withdrawal request was *rejected*. Amount has been returned to your balance.")


def _process_withdraw(wid: int, new_status: str, bot_text: str):
    conn = get_conn()
    w = conn.execute("SELECT * FROM withdrawals WHERE id=?", (wid,)).fetchone()
    if not w:
        raise HTTPException(404, "Withdrawal not found")
    if w["status"] != "pending":
        raise HTTPException(400, "Already processed")
    if new_status == "rejected":
        conn.execute("UPDATE users SET balance=balance+? WHERE id=?", (w["amount"], w["user_id"]))
        conn.execute(
            "INSERT INTO transactions (user_id, type, amount, description) VALUES (?,?,?,?)",
            (w["user_id"], "withdrawal_refund", w["amount"], "Refund for rejected withdrawal"),
        )
    conn.execute("UPDATE withdrawals SET status=?, processed_at=datetime('now') WHERE id=?", (new_status, wid))
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE id=?", (w["user_id"],)).fetchone()
    try:
        schedule_coro(bot.notify_user(
            user["telegram_id"],
            f"{bot_text}\n\nðŸ’µ Amount: *{w['amount']:.2f} USDT*\nðŸ¦ Binance UID: `{w['binance_uid']}`",
        ))
    except Exception:  # noqa: BLE001
        pass
    return {"success": True, "status": new_status}


@app.get("/api/admin/tasks")
def admin_tasks(request: Request):
    require_admin(request)
    rows = rows_to_dicts(get_conn().execute("SELECT * FROM tasks ORDER BY sort, id").fetchall())
    return {"tasks": rows}


@app.post("/api/admin/tasks")
async def admin_create_task(request: Request):
    require_admin(request)
    body = await request.json()
    title = str(body.get("title", "")).strip()
    ttype = str(body.get("type", "")).strip()
    link = str(body.get("link", "")).strip()
    reward = float(body.get("reward", 0))
    if not title or not ttype:
        raise HTTPException(400, "Title and type are required")
    with db() as c:
        cur = c.execute(
            "INSERT INTO tasks (title, type, link, reward, status, sort) VALUES (?,?,?,?,1,?)",
            (title, ttype, link, reward, int(body.get("sort", 0))),
        )
    return {"success": True, "task_id": cur.lastrowid}


@app.put("/api/admin/tasks/{tid}")
async def admin_update_task(tid: int, request: Request):
    require_admin(request)
    body = await request.json()
    conn = get_conn()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
    if not task:
        raise HTTPException(404, "Task not found")
    conn.execute(
        "UPDATE tasks SET title=?, type=?, link=?, reward=?, sort=? WHERE id=?",
        (
            str(body.get("title", task["title"])),
            str(body.get("type", task["type"])),
            str(body.get("link", task["link"])),
            float(body.get("reward", task["reward"])),
            int(body.get("sort", task["sort"])),
            tid,
        ),
    )
    conn.commit()
    return {"success": True}


@app.delete("/api/admin/tasks/{tid}")
def admin_delete_task(tid: int, request: Request):
    require_admin(request)
    with db() as c:
        c.execute("DELETE FROM task_completions WHERE task_id=?", (tid,))
        c.execute("DELETE FROM tasks WHERE id=?", (tid,))
    return {"success": True}


@app.post("/api/admin/tasks/{tid}/toggle")
def admin_toggle_task(tid: int, request: Request):
    require_admin(request)
    conn = get_conn()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
    if not task:
        raise HTTPException(404, "Task not found")
    new_status = 0 if task["status"] == 1 else 1
    conn.execute("UPDATE tasks SET status=? WHERE id=?", (new_status, tid))
    conn.commit()
    return {"success": True, "status": new_status}


@app.post("/api/admin/notify")
async def admin_notify(request: Request):
    require_admin(request)
    body = await request.json()
    target = body.get("target", "all")
    user_id = body.get("user_id")
    message = str(body.get("message", "")).strip()
    via_bot = bool(body.get("via_bot", True))
    title = str(body.get("title", "New Notification")).strip()
    if not message:
        raise HTTPException(400, "Message is required")
    conn = get_conn()

    def send_inapp(uid, msg):
        conn.execute(
            "INSERT INTO notifications (user_id, title, message) VALUES (?,?,?)",
            (uid, title, msg),
        )

    sent = 0
    if target == "all":
        users = conn.execute("SELECT * FROM users").fetchall()
        for u in users:
            send_inapp(u["id"], message)
            if via_bot:
                schedule_coro(bot.send_plain_message(u["telegram_id"], message))
                sent += 1
        conn.commit()
    else:
        user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(404, "User not found")
        send_inapp(user["id"], message)
        conn.commit()
        if via_bot:
            schedule_coro(bot.send_plain_message(user["telegram_id"], message))
            sent = 1
    return {"success": True, "sent_to_bot": sent}


@app.get("/api/admin/messages")
def admin_messages(request: Request):
    require_admin(request)
    rows = rows_to_dicts(get_conn().execute(
        "SELECT n.*, u.username FROM notifications n LEFT JOIN users u ON u.id=n.user_id ORDER BY n.id DESC LIMIT 200"
    ).fetchall())
    return {"messages": rows}


@app.get("/api/admin/settings")
def admin_get_settings(request: Request):
    require_admin(request)
    return {
        "min_withdraw": get_setting("min_withdraw"),
        "max_withdraw": get_setting("max_withdraw"),
        "referral_reward": get_setting("referral_reward"),
        "ad_15s_code": get_setting("ad_15s_code"),
        "site_name": get_setting("site_name"),
    }


@app.post("/api/admin/settings")
async def admin_set_settings(request: Request):
    require_admin(request)
    body = await request.json()
    for key in ("min_withdraw", "max_withdraw", "referral_reward", "ad_15s_code", "site_name"):
        if key in body:
            set_setting(key, body[key])
    return {"success": True}


@app.get("/api/health")
def health():
    return {"ok": True}


# ---------------------------------------------------------------- static

app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.get("/admin")
def admin_page():
    return FileResponse(str(STATIC / "admin.html"))


@app.get("/{path:path}")
def spa(path: str):
    file = STATIC / path
    if path and file.is_file() and file.resolve().is_relative_to(STATIC.resolve()):
        return FileResponse(str(file))
    return FileResponse(str(STATIC / "index.html"))
