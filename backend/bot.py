import asyncio
import logging

import httpx

from config import BOT_TOKEN, WEBAPP_URL, BOT_USERNAME, APP_SHORT_NAME

log = logging.getLogger("bot")
API = f"https://api.telegram.org/bot{BOT_TOKEN}"

_last_update_id = 0
_lock = asyncio.Lock()

WELCOME_TEXT = (
    "ðŸŽ‰ *Welcome to ClickN Earn Official!*\n\n"
    "ðŸ‘‹ Hello there! You have joined the smartest way to earn rewards.\n\n"
    "ðŸ’¸ Complete simple tasks, watch ads and invite friends to earn real "
    "*USDT* balance right here on Telegram.\n\n"
    "ðŸ‘‡ Tap the button below to open the Mini App and start earning!"
)


async def api_call(method, **kwargs):
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(f"{API}/{method}", json=kwargs)
            data = r.json()
            return data.get("ok", False), data.get("result")
    except Exception as e:  # noqa: BLE001
        log.error("telegram api %s failed: %s", method, e)
        return False, None


async def send_message(chat_id, text, keyboard=None, parse_mode="Markdown"):
    payload = {"chat_id": chat_id, "text": text, "parse_mode": parse_mode}
    if keyboard:
        payload["reply_markup"] = keyboard
    return await api_call("sendMessage", **payload)


async def send_plain_message(chat_id, text, keyboard=None):
    payload = {"chat_id": chat_id, "text": text}
    if keyboard:
        payload["reply_markup"] = keyboard
    return await api_call("sendMessage", **payload)


def welcome_keyboard():
    return {
        "inline_keyboard": [
            [{"text": "ðŸš€ Open ClickN Earn", "web_app": {"url": WEBAPP_URL}}],
            [{"text": "ðŸ‘¥ Join Our Community", "url": f"https://t.me/{BOT_USERNAME}"}],
        ]
    }


def invite_deep_link(ref_id: int) -> str:
    return f"https://t.me/{BOT_USERNAME}/{APP_SHORT_NAME}?startapp=ref_{ref_id}"


async def get_me():
    return await api_call("getMe")


async def handle_update(upd):
    global _last_update_id
    _last_update_id = upd.get("update_id", _last_update_id)

    if "message" in upd:
        msg = upd["message"]
        text = msg.get("text", "")
        chat_id = msg["chat"]["id"]
        if text.startswith("/start"):
            await send_message(chat_id, WELCOME_TEXT, welcome_keyboard())


async def poll_loop():
    global _last_update_id
    while True:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.post(
                    f"{API}/getUpdates",
                    json={
                        "timeout": 25,
                        "offset": _last_update_id + 1,
                        "allowed_updates": ["message", "callback_query"],
                    },
                )
                data = r.json()
            if data.get("ok"):
                for upd in data.get("result", []):
                    try:
                        await handle_update(upd)
                    except Exception as e:  # noqa: BLE001
                        log.error("update handling error: %s", e)
        except asyncio.CancelledError:
            break
        except Exception as e:  # noqa: BLE001
            log.error("poll error: %s", e)
            await asyncio.sleep(3)
        await asyncio.sleep(0.3)


async def notify_user(chat_id, text):
    return await send_plain_message(chat_id, text)


async def broadcast(text, chat_ids):
    ok = 0
    for cid in chat_ids:
        res, _ = await notify_user(cid, text)
        if res:
            ok += 1
        await asyncio.sleep(0.05)
    return ok


async def bot_runner():
    await asyncio.sleep(1)
    await poll_loop()
