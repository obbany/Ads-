const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const IN_TELEGRAM = !!(tg && tg.initData && tg.initDataUnsafe && tg.initDataUnsafe.user);

const state = {
  token: localStorage.getItem("cne_token") || "",
  user: null,
  balanceHidden: false,
  adTimer: null,
  currentTask: null,
  payFilter: "all",
};

const $ = (id) => document.getElementById(id);

function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  return fetch(path, { ...opts, headers }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.detail || "Request failed");
      err.status = r.status;
      throw err;
    }
    return data;
  });
}

function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove("show"), ms);
}

function fmtMoney(n) {
  return Number(n || 0).toFixed(2);
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s.replace(" ", "T") + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDateFull(s) {
  if (!s) return "";
  const d = new Date(s.replace(" ", "T") + "Z");
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/* ------------------------------------------------ tab navigation */
function switchTab(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $("screen-" + name).classList.add("active");
  document.querySelectorAll(".nav-item").forEach((n) => {
    n.classList.toggle("active", n.dataset.tab === name);
  });
  if (tg) tg.HapticFeedback.impactOccurred("light");
  if (name === "dashboard") loadDashboard();
  if (name === "tasks") loadTasks();
  if (name === "withdraw") loadWithdraw();
  if (name === "profile") renderProfile();
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------ auth */
async function init() {
  if (tg) {
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor("#0a0d18");
      tg.setBackgroundColor("#0a0d18");
    } catch (e) {}
  }

  if (!IN_TELEGRAM) {
    $("previewBanner").classList.remove("hidden");
    $("previewBanner").textContent =
      "Preview Mode - not connected to Telegram. Test user account is active.";
  }

  try {
    let payload;
    if (IN_TELEGRAM) {
      const u = tg.initDataUnsafe.user;
      payload = { init_data: tg.initData };
    } else {
      const uid = new URLSearchParams(location.search).get("uid") || "900000001";
      payload = { dev_uid: parseInt(uid, 10), username: "testuser", first_name: "Test User", photo_url: "" };
    }
    const res = await api("/api/auth", { method: "POST", body: JSON.stringify(payload) });
    state.token = res.token;
    state.user = res.user;
    localStorage.setItem("cne_token", res.token);
    loadDashboard();
    renderProfile();
  } catch (e) {
    toast("Auth failed: " + e.message);
  }
}

/* ------------------------------------------------ dashboard */
async function loadDashboard() {
  try {
    const d = await api("/api/dashboard");
    state.user = d.user;
    const u = d.user;
    $("siteName").textContent = "ClickN Earn Official";
    renderBalance(u.balance);
    $("taskDone").textContent = u.total_tasks_done;
    $("totalRefer").textContent = u.total_referrals;
    $("availBal").textContent = "$" + fmtMoney(u.balance);
    $("dashBalance").textContent = fmtMoney(u.balance);
    $("inviteReward").textContent = "Earn " + fmtMoney(d.referral_reward) + " USDT for each active referral.";
    state.referralReward = d.referral_reward;
    state.inviteLink = d.invite_link;
    if (d.unread_notifications > 0) {
      $("notifBadge").classList.remove("hidden");
      $("notifBadge").textContent = d.unread_notifications > 99 ? "99+" : d.unread_notifications;
    } else {
      $("notifBadge").classList.add("hidden");
    }
  } catch (e) {
    toast(e.message);
  }
}

function renderBalance(balance) {
  const el = $("dashBalance");
  if (state.balanceHidden) {
    el.textContent = "â€¢â€¢â€¢â€¢â€¢";
  } else {
    el.textContent = fmtMoney(balance);
  }
  $("availBal").textContent = state.balanceHidden ? "â€¢â€¢â€¢â€¢â€¢" : "$" + fmtMoney(balance);
}

function toggleBalance() {
  state.balanceHidden = !state.balanceHidden;
  $("eyeOn").classList.toggle("hidden", state.balanceHidden);
  $("eyeOff").classList.toggle("hidden", !state.balanceHidden);
  renderBalance(state.user.balance);
  if (tg) tg.HapticFeedback.impactOccurred("light");
}

/* ------------------------------------------------ tasks */
const TASK_META = {
  telegram_channel: { ico: "ico-tg", label: "Join", openNew: true },
  telegram_group: { ico: "ico-tg", label: "Join", openNew: true },
  youtube: { ico: "ico-yt", label: "Subscribe", openNew: true },
  website: { ico: "ico-web", label: "Visit", openNew: true },
  ad: { ico: "ico-ad", label: "Watch", openNew: false },
};

const ICONS = {
  tg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.04 15.51l-.37 5.01c.54 0 .77-.23 1.06-.5l2.54-2.43 5.28 3.86c.97.53 1.65.26 1.91-.89L22.9 3.02c.3-1.35-.5-1.87-1.43-1.55L1.11 9.9c-1.37.53-1.35 1.31-.24 1.65l5.28 1.65L18.34 5.05c.5-.3.96-.14.58.18L9.04 15.51z"/></svg>',
  yt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z"/></svg>',
  web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
  ad: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
};

function taskIcon(type) {
  const meta = TASK_META[type] || {};
  const key =
    type === "telegram_channel" || type === "telegram_group" ? "tg" : type === "youtube" ? "yt" : type === "website" ? "web" : type === "ad" ? "ad" : "star";
  return `<span class="task-ico ${meta.ico || "ico-tg"}">${ICONS[key]}</span>`;
}

async function loadTasks() {
  try {
    const d = await api("/api/tasks");
    state.adCode = d.ad_code || "";
    const list = $("taskList");
    if (!d.tasks.length) {
      list.innerHTML = '<div class="empty-state"><div class="big">ðŸ“‹</div>No tasks available right now.<br/>Check back soon!</div>';
      return;
    }
    list.innerHTML = d.tasks
      .map((t) => {
        const meta = TASK_META[t.type] || { ico: "ico-tg", label: "Start" };
        const action = t.done
          ? `<button class="task-action done"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>Done</button>`
          : `<button class="task-action go" data-id="${t.id}" onclick="startTask(${t.id})">${meta.label}</button>`;
        return `<div class="card-row">
          ${taskIcon(t.type)}
          <div class="task-info">
            <div class="task-title">${escapeHtml(t.title)}</div>
            <div class="task-reward">ðŸ’µ +${fmtMoney(t.reward)} USDT</div>
          </div>
          ${action}
        </div>`;
      })
      .join("");
  } catch (e) {
    toast(e.message);
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openLink(url) {
  if (!url) return;
  if (tg) {
    try {
      if (url.startsWith("https://t.me/")) tg.openTelegramLink(url);
      else tg.openLink(url, { try_instant_view: false });
      return;
    } catch (e) {}
  }
  window.open(url, "_blank");
}

async function startTask(taskId) {
  const task = await fetchTask(taskId);
  if (!task) return;
  const meta = TASK_META[task.type] || {};
  if (task.type === "ad") {
    openAdModal(task);
    return;
  }
  if (task.link) openLink(task.link);
  setTimeout(async () => {
    try {
      await completeTask(task);
    } catch (e) {
      toast(e.message, 3200);
    }
  }, 1500);
}

async function fetchTask(taskId) {
  try {
    const d = await api("/api/tasks");
    return d.tasks.find((t) => t.id === taskId);
  } catch (e) {
    return null;
  }
}

async function completeTask(task) {
  try {
    const r = await api(`/api/tasks/${task.id}/complete`, { method: "POST" });
    toast(r.message || "Task completed!");
    if (tg) tg.HapticFeedback.notificationOccurred("success");
    loadTasks();
    loadDashboard();
  } catch (e) {
    toast(e.message, 3200);
  }
}

/* ---- ad modal ---- */
function openAdModal(task) {
  state.currentTask = task;
  $("adModal").classList.add("open");
  $("adTaskTitle").textContent = task.title;
  $("adCount").textContent = "15";
  $("adProgress").style.width = "0%";
  $("adClaimBtn").classList.add("hidden");
  $("adClaimBtn").textContent = "Claim +" + fmtMoney(task.reward) + " USDT";
  $("adCloseBtn").classList.remove("hidden");

  if (task.link) openLink(task.link);

  let remaining = 15;
  state.adTimer = setInterval(() => {
    remaining--;
    $("adCount").textContent = Math.max(remaining, 0);
    $("adProgress").style.width = ((15 - remaining) / 15) * 100 + "%";
    if (remaining <= 0) {
      clearInterval(state.adTimer);
      $("adCount").textContent = "âœ“";
      $("adClaimBtn").classList.remove("hidden");
      $("adCloseBtn").classList.add("hidden");
    }
  }, 1000);
}

function claimAd() {
  clearInterval(state.adTimer);
  const task = state.currentTask;
  closeAd();
  completeTask(task);
}

function closeAd() {
  clearInterval(state.adTimer);
  $("adModal").classList.remove("open");
}

/* ------------------------------------------------ withdraw */
async function loadWithdraw() {
  try {
    const d = await api("/api/withdraw");
    state.user.balance = d.balance;
    $("wdBalance").textContent = "$" + fmtMoney(d.balance);
    $("wdMin").textContent = "$" + fmtMoney(d.min);
    $("wdMax").textContent = "$" + fmtMoney(d.max);
    $("wdUid").value = d.wallet_address || "";

    const chips = d.options
      .map((o) => `<button class="chip" data-a="${o}" onclick="pickAmount(${o})"><small>$</small>${o}</button>`)
      .join("");
    $("amountChips").innerHTML = chips;

    const hist = $("wdHistory");
    if (!d.history.length) {
      hist.innerHTML = '<div class="empty-state"><div class="big">ðŸ¦</div>No withdrawals yet.</div>';
    } else {
      hist.innerHTML = d.history
        .map((w) => {
          const stClass = w.status === "confirmed" ? "st-confirmed" : w.status === "rejected" ? "st-rejected" : "st-pending";
          return `<div class="history-item">
            <div class="hi-left">
              <span class="hi-ico ${w.status === "confirmed" ? "ico-green" : w.status === "rejected" ? "ico-red" : "ico-gold"}">${w.status === "confirmed" ? "âœ“" : w.status === "rejected" ? "âœ•" : "â³"}</span>
              <div>
                <div class="hi-title">Withdrawal</div>
                <div class="hi-sub">${fmtDateFull(w.created_at)} â€¢ UID ${w.binance_uid}</div>
              </div>
            </div>
            <div style="text-align:right">
              <div class="hi-amount minus mono">-$${fmtMoney(w.amount)}</div>
              <div class="hi-status ${stClass}">${w.status}</div>
            </div>
          </div>`;
        })
        .join("");
    }
  } catch (e) {
    toast(e.message);
  }
}

function pickAmount(a) {
  $("wdAmount").value = a;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", Number(c.dataset.a) === Number(a)));
  if (tg) tg.HapticFeedback.selectionChanged();
}

async function pasteUid() {
  const v = await readClipboard();
  if (v) $("wdUid").value = v.replace(/\D/g, "").slice(0, 20);
  else toast("Clipboard unavailable - please type your UID");
}

async function pasteWallet() {
  const v = await readClipboard();
  if (v) $("walletInput").value = v.replace(/\D/g, "").slice(0, 20);
  else toast("Clipboard unavailable - please type your UID");
}

async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch (e) {
    return "";
  }
}

async function submitWithdraw() {
  const uid = $("wdUid").value.trim();
  const amount = parseFloat($("wdAmount").value);
  if (!/^\d{6,20}$/.test(uid)) return toast("Please enter a valid Binance UID (numbers only).");
  if (!amount || isNaN(amount)) return toast("Please enter a valid amount.");

  const d = await api("/api/withdraw").catch(() => null);
  const min = d ? d.min : 1;
  const max = d ? d.max : 10;
  if (amount < min) return toast(`Minimum withdrawal is $${fmtMoney(min)}.`);
  if (amount > max) return toast(`Maximum withdrawal is $${fmtMoney(max)}.`);
  if (amount > state.user.balance) return toast("Insufficient balance.");

  try {
    const r = await api("/api/withdraw", {
      method: "POST",
      body: JSON.stringify({ binance_uid: uid, amount }),
    });
    toast("Withdrawal request submitted! Awaiting admin confirmation.");
    if (tg) tg.HapticFeedback.notificationOccurred("success");
    $("wdAmount").value = "";
    loadWithdraw();
    loadDashboard();
  } catch (e) {
    toast(e.message, 3200);
  }
}

/* ------------------------------------------------ profile */
function renderProfile() {
  const u = state.user;
  if (!u) return;
  const name = u.first_name || u.username || "User";
  const avatar = $("profileAvatar");
  if (u.photo_url) {
    avatar.style.backgroundImage = `url(${u.photo_url})`;
    avatar.textContent = "";
  } else {
    avatar.style.backgroundImage = "none";
    avatar.textContent = (name[0] || "?").toUpperCase();
  }
  $("profileName").textContent = name;
  $("profileUser").textContent = u.username ? "@" + u.username : "@user";
  $("profileTgId").textContent = "ID: " + u.telegram_id;
}

function openWalletSheet() {
  $("walletSheet").classList.add("open");
  $("walletInput").value = state.user.wallet_address || "";
}

async function saveWallet() {
  const addr = $("walletInput").value.trim();
  if (!/^\d{6,20}$/.test(addr)) return toast("Please enter a valid Binance UID (numbers only).");
  try {
    const r = await api("/api/wallet", { method: "POST", body: JSON.stringify({ address: addr }) });
    state.user.wallet_address = r.wallet_address;
    toast("Wallet address saved!");
    closeSheet("walletSheet");
    if (tg) tg.HapticFeedback.notificationOccurred("success");
  } catch (e) {
    toast(e.message, 3200);
  }
}

async function openPaymentsSheet() {
  state.payFilter = "all";
  document.querySelectorAll(".seg-tab").forEach((t) => t.classList.toggle("active", t.dataset.f === "all"));
  $("paymentsSheet").classList.add("open");
  await loadPayments();
}

async function payFilter(f) {
  state.payFilter = f;
  document.querySelectorAll(".seg-tab").forEach((t) => t.classList.toggle("active", t.dataset.f === f));
  await loadPayments();
}

async function loadPayments() {
  try {
    const d = await api("/api/payments?filter=" + state.payFilter);
    const list = $("payList");
    if (!d.transactions.length) {
      list.innerHTML = '<div class="empty-state"><div class="big">ðŸ§¾</div>No transactions yet.</div>';
      return;
    }
    list.innerHTML = d.transactions
      .map((t) => {
        const isPlus = t.amount >= 0;
        const title = { task: "Task Reward", referral: "Referral Bonus", withdraw: "Withdrawal", withdrawal_refund: "Withdrawal Refund", admin: "Admin Adjustment" }[t.type] || t.type;
        return `<div class="history-item">
          <div class="hi-left">
            <span class="hi-ico ${isPlus ? "ico-green" : "ico-gold"}">${isPlus ? "â–²" : "â–¼"}</span>
            <div>
              <div class="hi-title">${title}</div>
              <div class="hi-sub">${fmtDate(t.created_at)}${t.description ? " â€¢ " + escapeHtml(t.description) : ""}</div>
            </div>
          </div>
          <div class="hi-amount ${isPlus ? "plus" : "minus"} mono">${isPlus ? "+" : "-"}$${fmtMoney(Math.abs(t.amount))}</div>
        </div>`;
      })
      .join("");
  } catch (e) {
    toast(e.message);
  }
}

function openComingSoon(name) {
  showInfoSheet(name, "ðŸš§ This feature is coming soon. Please stay tuned - we are working hard to bring it to you!");
}

function openAbout() {
  const reward = state.referralReward || 0.2;
  showInfoSheet(
    "About ClickN Earn",
    "ðŸŽ¯ <b>ClickN Earn Official</b> is a Telegram Mini App that lets you earn USDT by completing simple tasks, watching ads and inviting friends.<br/><br/>âœ… Complete tasks to earn rewards<br/>âœ… Invite friends - earn " +
      fmtMoney(reward) +
      " USDT per active referral<br/>âœ… Withdraw directly to your Binance UID<br/><br/>ðŸ’¬ Questions? Contact the admin for support.<br/><br/><i>Earn smart. Earn together.</i>"
  );
}

function showInfoSheet(title, bodyHtml) {
  $("infoSheetTitle").textContent = title;
  $("infoSheetBody").innerHTML = bodyHtml;
  $("infoSheet").classList.add("open");
}

function signOut() {
  if (tg) {
    tg.HapticFeedback.notificationOccurred("error");
    localStorage.removeItem("cne_token");
    setTimeout(() => {
      try {
        tg.close();
      } catch (e) {}
    }, 250);
  } else {
    localStorage.removeItem("cne_token");
    toast("Signed out. Reloading...");
    setTimeout(() => location.reload(), 800);
  }
}

/* ------------------------------------------------ notifications */
async function openNotifications() {
  $("notifSheet").classList.add("open");
  try {
    const d = await api("/api/notifications");
    const list = $("notifList");
    if (!d.notifications.length) {
      list.innerHTML = '<div class="empty-state"><div class="big">ðŸ””</div>No notifications yet.</div>';
    } else {
      list.innerHTML = d.notifications
        .map(
          (n) => `<div class="notif-item">
            <div class="n-title">${escapeHtml(n.title)}</div>
            <div class="n-msg">${escapeHtml(n.message)}</div>
            <div class="n-time">${fmtDate(n.created_at)}</div>
          </div>`
        )
        .join("");
    }
    $("notifBadge").classList.add("hidden");
  } catch (e) {}
}

/* ------------------------------------------------ invite */
async function shareInvite() {
  if (!state.inviteLink) return toast("Invite link not ready.");
  try {
    await navigator.clipboard.writeText(state.inviteLink);
  } catch (e) {}
  const text = "ðŸŽ Join me on ClickN Earn and start earning USDT today! Complete tasks, watch ads & withdraw to Binance. " + state.inviteLink;
  if (tg) {
    try {
      tg.openTelegramLink("https://t.me/share/url?url=" + encodeURIComponent(state.inviteLink) + "&text=" + encodeURIComponent(text));
      return;
    } catch (e) {}
  }
  toast("Invite link copied to clipboard!");
}

/* ------------------------------------------------ sheets */
function closeSheet(id) {
  $(id).classList.remove("open");
}

window.addEventListener("load", init);
