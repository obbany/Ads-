const state = {
  token: sessionStorage.getItem("cne_admin_token") || "",
  currentWdFilter: "pending",
  editingTaskId: null,
  editingUserId: null,
};

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove("show"), 2600);
}

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

function esc(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtMoney(n) {
  return Number(n || 0).toFixed(2);
}

function fmtDate(s) {
  if (!s) return "";
  return new Date(s.replace(" ", "T") + "Z").toLocaleString();
}

/* ------------------------------------------------ auth */
function doLogin() {
  const pw = $("adminPass").value;
  api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: pw }) })
    .then((r) => {
      state.token = r.token;
      sessionStorage.setItem("cne_admin_token", r.token);
      $("loginView").classList.add("hidden");
      $("panelView").classList.remove("hidden");
      loadAll();
    })
    .catch((e) => {
      $("loginErr").textContent = e.message;
    });
}

function logout() {
  sessionStorage.removeItem("cne_admin_token");
  state.token = "";
  $("panelView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  $("adminPass").value = "";
  $("loginErr").textContent = "";
}

function requireLogin() {
  if (!state.token) {
    $("loginView").classList.remove("hidden");
    $("panelView").classList.add("hidden");
    return false;
  }
  $("loginView").classList.add("hidden");
  $("panelView").classList.remove("hidden");
  return true;
}

function switchSec(sec) {
  document.querySelectorAll(".nav-btn[data-sec]").forEach((b) => b.classList.toggle("active", b.dataset.sec === sec));
  document.querySelectorAll(".admin-sec").forEach((s) => s.classList.remove("active"));
  $("sec-" + sec).classList.add("active");
  if (sec === "stats") loadStats();
  if (sec === "users") loadUsers();
  if (sec === "withdrawals") loadWithdrawals(state.currentWdFilter);
  if (sec === "tasks") loadTasks();
  if (sec === "notify") loadNotify();
  if (sec === "settings") loadSettings();
}

function loadAll() {
  loadStats();
  loadUsers();
  loadWithdrawals("pending");
  loadTasks();
  loadNotifyUsers();
  loadSettings();
}

/* ------------------------------------------------ stats */
async function loadStats() {
  try {
    const s = await api("/api/admin/stats");
    $("statCards").innerHTML = [
      { v: s.users, l: "Total Users", cls: "" },
      { v: s.pending, l: "Pending Withdrawals", cls: "tag-gold" },
      { v: s.confirmed, l: "Confirmed", cls: "tag-green" },
      { v: s.tasks, l: "Active Tasks", cls: "tag-violet" },
      { v: "$" + fmtMoney(s.total_earned), l: "Total Earned (USDT)", cls: "tag-green" },
      { v: "$" + fmtMoney(s.total_balance), l: "Total User Balance", cls: "tag-violet" },
      { v: "$" + fmtMoney(s.total_paid), l: "Total Paid Out", cls: "tag-gold" },
    ]
      .map(
        (c) => `<div class="stat-card"><div class="v ${c.cls}">${c.v}</div><div class="l">${c.l}</div></div>`
      )
      .join("");

    const rw = s.recent_withdrawals;
    $("recentWd").innerHTML = rw.length
      ? `<table><thead><tr><th>ID</th><th>User</th><th>UID</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>` +
        rw
          .map(
            (w) => `<tr>
            <td>#${w.id}</td>
            <td>${esc(w.username || w.first_name)}</td>
            <td class="mono">${esc(w.binance_uid)}</td>
            <td class="mono">$${fmtMoney(w.amount)}</td>
            <td><span class="tag ${w.status}">${w.status}</span></td>
            <td>${fmtDate(w.created_at)}</td>
          </tr>`
          )
          .join("") +
        `</tbody></table>`
      : '<div class="empty">No withdrawals yet</div>';
  } catch (e) {
    if (e.status === 401) return logout();
  }
}

/* ------------------------------------------------ users */
async function loadUsers() {
  try {
    const q = encodeURIComponent($("userSearch") ? $("userSearch").value : "");
    const d = await api("/api/admin/users?search=" + q);
    const list = $("usersList");
    if (!d.users.length) {
      list.innerHTML = '<div class="empty">No users found</div>';
      return;
    }
    list.innerHTML = `<table>
      <thead><tr><th>ID</th><th>User</th><th>Telegram ID</th><th>Balance</th><th>Earned</th><th>Refs</th><th>Tasks</th><th>Joined</th><th></th></tr></thead><tbody>` +
      d.users
        .map(
          (u) => `<tr>
            <td>#${u.id}</td>
            <td><strong>${esc(u.first_name || "-")}</strong><br/><span style="color:var(--muted);font-size:11.5px">${u.username ? "@" + esc(u.username) : ""}</span></td>
            <td class="mono">${u.telegram_id}</td>
            <td class="mono"><strong>$${fmtMoney(u.balance)}</strong></td>
            <td class="mono" style="color:var(--green)">$${fmtMoney(u.total_earnings)}</td>
            <td>${u.total_referrals}</td>
            <td>${u.total_tasks_done}</td>
            <td>${fmtDate(u.created_at)}</td>
            <td><button class="btn-ok" onclick="openUser(${u.id})">View</button></td>
          </tr>`
        )
        .join("") +
      `</tbody></table>`;
  } catch (e) {
    if (e.status === 401) return logout();
  }
}

async function openUser(id) {
  try {
    const d = await api("/api/admin/users/" + id);
    const u = d.user;
    $("umName").textContent = u.first_name || u.username || "User " + u.id;
    const wdRows = d.withdrawals.length
      ? d.withdrawals
          .slice(0, 10)
          .map(
            (w) => `<tr><td>#${w.id}</td><td class="mono">${esc(w.binance_uid)}</td><td class="mono">$${fmtMoney(w.amount)}</td><td><span class="tag ${w.status}">${w.status}</span></td><td>${fmtDate(w.created_at)}</td></tr>`
          )
          .join("")
      : '<tr><td colspan="5" class="empty">No withdrawals</td></tr>';
    const txnRows = d.transactions.length
      ? d.transactions
          .slice(0, 15)
          .map(
            (t) => `<tr><td class="tag violet">${t.type}</td><td>${esc(t.description)}</td><td class="mono" style="color:${t.amount >= 0 ? "var(--green)" : "var(--red)"}">${t.amount >= 0 ? "+" : ""}$${fmtMoney(t.amount)}</td><td>${fmtDate(t.created_at)}</td></tr>`
          )
          .join("")
      : '<tr><td colspan="4" class="empty">No transactions</td></tr>';

    $("umBody").innerHTML = `
      <div class="stat-cards" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
        <div class="stat-card"><div class="v">$${fmtMoney(u.balance)}</div><div class="l">Balance</div></div>
        <div class="stat-card"><div class="v" style="color:var(--green)">$${fmtMoney(u.total_earnings)}</div><div class="l">Total Earned</div></div>
        <div class="stat-card"><div class="v">${u.total_referrals}</div><div class="l">Referrals</div></div>
        <div class="stat-card"><div class="v">${u.total_tasks_done}</div><div class="l">Tasks Done</div></div>
      </div>
      <div class="f-label">Wallet (Binance UID): <b>${esc(u.wallet_address || "Not set")}</b></div>
      <div class="f-label">Adjust Balance (USDT)</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="adjAmt" class="f-input" type="number" step="0.01" placeholder="e.g. +5 or -2" style="flex:1" />
        <button class="btn-primary" onclick="adjustBalance(${u.id})">Apply</button>
      </div>
      <div class="f-label">Recent Withdrawals</div>
      <table><thead><tr><th>ID</th><th>UID</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>${wdRows}</tbody></table>
      <div class="f-label">Recent Transactions</div>
      <table><thead><tr><th>Type</th><th>Description</th><th>Amount</th><th>Date</th></tr></thead><tbody>${txnRows}</tbody></table>
    `;
    $("userModal").classList.remove("hidden");
  } catch (e) {
    toast(e.message);
  }
}

function closeUserModal() {
  $("userModal").classList.add("hidden");
}

async function adjustBalance(uid) {
  const amount = parseFloat($("adjAmt").value);
  if (!amount) return toast("Enter a valid amount");
  try {
    const r = await api(`/api/admin/users/${uid}/balance`, {
      method: "POST",
      body: JSON.stringify({ amount, reason: "Admin balance adjustment" }),
    });
    toast("Balance updated. New balance: $" + fmtMoney(r.balance));
    loadUsers();
  } catch (e) {
    toast(e.message);
  }
}

/* ------------------------------------------------ withdrawals */
async function loadWithdrawals(status) {
  state.currentWdFilter = status;
  document.querySelectorAll(".seg-btn[data-wf]").forEach((b) => b.classList.toggle("active", b.dataset.wf === status));
  try {
    const d = await api("/api/admin/withdrawals" + (status ? "?status=" + status : ""));
    const list = $("wdList");
    if (!d.withdrawals.length) {
      list.innerHTML = '<div class="empty">No withdrawals in this list</div>';
      return;
    }
    list.innerHTML = `<table>
      <thead><tr><th>ID</th><th>User</th><th>Binance UID</th><th>Amount</th><th>Status</th><th>Requested</th><th>Actions</th></tr></thead><tbody>` +
      d.withdrawals
        .map(
          (w) => `<tr>
            <td>#${w.id}</td>
            <td><strong>${esc(w.username || w.first_name)}</strong></td>
            <td class="mono">${esc(w.binance_uid)}</td>
            <td class="mono"><strong>$${fmtMoney(w.amount)}</strong></td>
            <td><span class="tag ${w.status}">${w.status}</span></td>
            <td>${fmtDate(w.created_at)}</td>
            <td>${
              w.status === "pending"
                ? `<div class="btn-row">
                    <button class="btn-ok" onclick="processWd(${w.id},'confirm')">Confirm</button>
                    <button class="btn-danger" onclick="processWd(${w.id},'reject')">Reject</button>
                  </div>`
                : `<span style="color:var(--muted);font-size:12px">${w.processed_at ? "✓ " + fmtDate(w.processed_at) : ""}</span>`
            }</td>
          </tr>`
        )
        .join("") +
      `</tbody></table>`;
  } catch (e) {
    if (e.status === 401) return logout();
  }
}

async function processWd(id, action) {
  const msg = action === "confirm" ? "Confirm this withdrawal and pay to the user?" : "Reject this withdrawal and refund the user?";
  if (!confirm(msg)) return;
  try {
    await api(`/api/admin/withdrawals/${id}/${action}`, { method: "POST" });
    toast("Withdrawal " + action + "ed");
    loadWithdrawals(state.currentWdFilter);
    loadStats();
  } catch (e) {
    toast(e.message);
  }
}

/* ------------------------------------------------ tasks */
async function loadTasks() {
  try {
    const d = await api("/api/admin/tasks");
    const list = $("taskList");
    if (!d.tasks.length) {
      list.innerHTML = '<div class="empty">No tasks yet. Create your first task!</div>';
      return;
    }
    list.innerHTML = `<table>
      <thead><tr><th>ID</th><th>Title</th><th>Type</th><th>Reward</th><th>Status</th><th>Sort</th><th>Actions</th></tr></thead><tbody>` +
      d.tasks
        .map(
          (t) => `<tr>
            <td>#${t.id}</td>
            <td><strong>${esc(t.title)}</strong><br/><span style="color:var(--muted);font-size:11.5px">${esc(t.link)}</span></td>
            <td><span class="tag violet">${esc(t.type)}</span></td>
            <td class="mono" style="color:var(--green)">$${fmtMoney(t.reward)}</td>
            <td><span class="tag ${t.status ? "confirmed" : "rejected"}">${t.status ? "Active" : "Hidden"}</span></td>
            <td>${t.sort}</td>
            <td><div class="btn-row">
              <button class="btn-secondary" onclick="openTaskModal(${t.id})">Edit</button>
              <button class="btn-danger" onclick="deleteTask(${t.id})">Del</button>
            </div></td>
          </tr>`
        )
        .join("") +
      `</tbody></table>`;
  } catch (e) {
    if (e.status === 401) return logout();
  }
}

async function openTaskModal(id) {
  state.editingTaskId = id || null;
  $("taskModalTitle").textContent = id ? "Edit Task" : "New Task";
  $("taskSaveBtn").textContent = id ? "Save Changes" : "Create Task";
  $("tkTitle").value = "";
  $("tkType").value = "telegram_channel";
  $("tkLink").value = "";
  $("tkReward").value = "0.1";
  $("tkSort").value = "0";
  if (id) {
    try {
      const d = await api("/api/admin/tasks");
      const t = d.tasks.find((x) => x.id === id);
      if (t) {
        $("tkTitle").value = t.title;
        $("tkType").value = t.type;
        $("tkLink").value = t.link;
        $("tkReward").value = t.reward;
        $("tkSort").value = t.sort;
      }
    } catch (e) {}
  }
  $("taskModal").classList.remove("hidden");
}

function closeTaskModal() {
  $("taskModal").classList.add("hidden");
}

async function saveTask() {
  const title = $("tkTitle").value.trim();
  const type = $("tkType").value;
  const link = $("tkLink").value.trim();
  const reward = parseFloat($("tkReward").value);
  const sort = parseInt($("tkSort").value, 10) || 0;
  if (!title) return toast("Title is required");
  if (isNaN(reward) || reward < 0) return toast("Reward must be a positive number");

  const payload = { title, type, link, reward, sort };
  try {
    if (state.editingTaskId) {
      await api("/api/admin/tasks/" + state.editingTaskId, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/api/admin/tasks", { method: "POST", body: JSON.stringify(payload) });
    }
    toast("Task saved!");
    closeTaskModal();
    loadTasks();
  } catch (e) {
    toast(e.message);
  }
}

async function deleteTask(id) {
  if (!confirm("Delete this task?")) return;
  try {
    await api("/api/admin/tasks/" + id, { method: "DELETE" });
    toast("Task deleted");
    loadTasks();
  } catch (e) {
    toast(e.message);
  }
}

/* ------------------------------------------------ notify */
async function loadNotifyUsers() {
  try {
    const d = await api("/api/admin/users?search=");
    $("notifyUserId").innerHTML = d.users
      .map((u) => `<option value="${u.id}">#${u.id} • ${esc(u.first_name || u.username || u.telegram_id)}</option>`)
      .join("");
  } catch (e) {}
}

function toggleUserPick() {
  $("userPickWrap").classList.toggle("hidden", $("notifyTarget").value !== "user");
}

async function loadNotify() {
  try {
    const d = await api("/api/admin/messages");
    const list = $("msgHistory");
    if (!d.messages.length) {
      list.innerHTML = '<div class="empty">No messages sent yet</div>';
      return;
    }
    list.innerHTML = d.messages
      .map(
        (m) => `<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
          <div style="font-size:12px;color:var(--muted)">${m.user_id === 0 ? "To all users" : "To: " + esc(m.username || "#" + m.user_id)} • ${fmtDate(m.created_at)}</div>
          <div style="font-size:13.5px;margin-top:3px"><b>${esc(m.title)}</b> — ${esc(m.message)}</div>
        </div>`
      )
      .join("");
  } catch (e) {}
}

async function sendNotify() {
  const target = $("notifyTarget").value;
  const userId = target === "user" ? parseInt($("notifyUserId").value, 10) : null;
  const title = $("notifyTitle").value.trim() || "New Notification";
  const message = $("notifyMsg").value.trim();
  const viaBot = $("notifyBot").checked;
  if (!message) return toast("Message is required");
  try {
    const r = await api("/api/admin/notify", {
      method: "POST",
      body: JSON.stringify({ target, user_id: userId, title, message, via_bot: viaBot }),
    });
    toast(`Message sent! (${r.sent_to_bot} delivered via bot)`);
    $("notifyMsg").value = "";
    loadNotify();
  } catch (e) {
    toast(e.message);
  }
}

/* ------------------------------------------------ settings */
async function loadSettings() {
  try {
    const s = await api("/api/admin/settings");
    $("setSiteName").value = s.site_name;
    $("setMinWd").value = s.min_withdraw;
    $("setMaxWd").value = s.max_withdraw;
    $("setRefReward").value = s.referral_reward;
    $("setAdCode").value = s.ad_15s_code || "";
  } catch (e) {}
}

async function saveSettings() {
  const body = {
    site_name: $("setSiteName").value.trim(),
    min_withdraw: $("setMinWd").value,
    max_withdraw: $("setMaxWd").value,
    referral_reward: $("setRefReward").value,
    ad_15s_code: $("setAdCode").value,
  };
  try {
    await api("/api/admin/settings", { method: "POST", body: JSON.stringify(body) });
    toast("Settings saved!");
  } catch (e) {
    toast(e.message);
  }
}

/* init */
if (requireLogin()) loadAll();
