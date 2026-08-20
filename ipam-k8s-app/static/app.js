const state = {
  pools: [],
  allocations: [],
  map: null,
  kind: "all",
  search: "",
  view: "dashboard",
  selectedPool: "",
  user: "",
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = Array.isArray(data.detail)
        ? data.detail.map((d) => d.msg || JSON.stringify(d)).join("; ")
        : data.detail || res.statusText;
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
  return data;
}

function lastOctet(ip) {
  return ip.split(".").pop();
}

function poolMode(p) {
  if (p?.mode === "range" || p?.mode === "cidr") return p.mode;
  return p?.cidr ? "cidr" : "range";
}

function poolRangeLabel(p) {
  if (poolMode(p) === "cidr" && p.cidr) return p.cidr;
  if (p.start && p.end) return `${p.start} – ${p.end}`;
  return p.cidr || "";
}

function setPoolMode(mode) {
  $("pool-mode").value = mode;
  $("mode-cidr").classList.toggle("active", mode === "cidr");
  $("mode-range").classList.toggle("active", mode === "range");
  $("pool-cidr-wrap").hidden = mode !== "cidr";
  $("pool-range-wrap").hidden = mode !== "range";
  $("pool-cidr").required = mode === "cidr";
  $("pool-start").required = mode === "range";
  $("pool-end").required = mode === "range";
  $("pool-mode-hint").innerHTML =
    mode === "range"
      ? "Start and end IPs only, for example load balancer <code>10.0.0.100</code>–<code>10.0.0.150</code> or nodes <code>10.0.0.10</code>–<code>10.0.0.20</code>."
      : "Whole subnet, for example pods <code>10.244.0.0/16</code> or nodes <code>10.0.0.0/24</code>.";
}

async function refresh() {
  const poolId = state.selectedPool || $("pool-select").value;
  const poolQuery = poolId ? `?pool=${encodeURIComponent(poolId)}` : "";
  const [pools, allocations, map] = await Promise.all([
    api("/api/pools"),
    api("/api/allocations" + poolQuery),
    api("/api/ip-map" + poolQuery),
  ]);
  state.pools = pools.pools;
  state.allocations = allocations.allocations;
  state.map = map;
  fillPoolSelects();
  renderStats();
  renderGrid();
  renderTable();
  renderPools();
}

function fillPoolSelects() {
  const current = state.selectedPool || $("pool-select").value;
  const options = state.pools
    .map((p) => `<option value="${p.id}">${p.name}</option>`)
    .join("");
  $("pool-select").innerHTML = options;
  $("alloc-pool").innerHTML = options;
  const selected = state.pools.some((p) => p.id === current) ? current : state.pools[0]?.id || "";
  if (selected) {
    $("pool-select").value = selected;
    state.selectedPool = selected;
  }
}

function renderStats() {
  const m = state.map;
  if (!m || !m.pool) {
    $("stats").innerHTML = "";
    return;
  }
  const usedPct = m.total ? Math.round((m.used / m.total) * 100) : 0;
  const range = m.pool.cidr || `${m.pool.start} – ${m.pool.end}`;
  $("stats").innerHTML = `
    <div class="stat"><span>Pool range</span><strong>${m.total}</strong><small>${range}</small></div>
    <div class="stat"><span>Used</span><strong>${m.used}</strong><div class="bar"><i style="width:${usedPct}%"></i></div></div>
    <div class="stat"><span>Free</span><strong>${m.free}</strong></div>
    <div class="stat"><span>Reserved</span><strong>${m.reserved}</strong></div>
  `;
}

function renderGrid() {
  const m = state.map;
  const noPool = !m || !m.pool;
  const noCells = !noPool && (!m.addresses || !m.addresses.length);
  $("ip-grid").innerHTML = "";
  if (noPool) {
    $("empty-map").hidden = false;
    $("empty-map").innerHTML = "No pool yet. Open <strong>Pools</strong> and add a subnet CIDR (for example <code>10.244.0.0/16</code> for pods).";
    return;
  }
  if (m.map_limited || noCells) {
    $("empty-map").hidden = false;
    $("empty-map").innerHTML = "This subnet is large, so the grid is hidden. Add each Pod / Service / Ingress IP under <strong>Allocations</strong>.";
    return;
  }
  $("empty-map").hidden = true;
  $("ip-grid").innerHTML = m.addresses
    .map((a) => {
      const item = a.items[0];
      const label = item ? `${item.kind} ${item.name}` : "available";
      return `<button type="button" class="ip-cell ${a.state}" data-ip="${a.ip}" title="${label}">
        .${lastOctet(a.ip)}
        <small>${a.state}</small>
      </button>`;
    })
    .join("");
}

function renderTable() {
  const q = state.search.toLowerCase();
  const poolId = state.selectedPool || $("pool-select").value;
  const rows = state.allocations.filter((a) => {
    if (poolId && a.pool !== poolId) return false;
    if (state.kind !== "all" && a.kind !== state.kind) return false;
    const hay = `${a.ip} ${a.kind} ${a.namespace} ${a.name} ${a.notes}`.toLowerCase();
    return hay.includes(q);
  });
  const empty = $("empty-alloc");
  empty.hidden = rows.length > 0;
  empty.innerHTML = poolId
    ? "No IPs in this pool yet. Click <strong>Add IP</strong> to save one here."
    : "No IPs saved yet. Click <strong>Add IP</strong> to create the first one.";
  $("alloc-body").innerHTML = rows
    .map(
      (a) => `<tr>
        <td class="ip">${a.ip}</td>
        <td><span class="badge ${a.kind}">${a.kind}</span></td>
        <td>${a.namespace}</td>
        <td>${a.name}</td>
        <td><span class="badge ${a.status}">${a.status}</span></td>
        <td>${a.notes || ""}</td>
        <td class="row-actions">
          <button class="ghost" data-edit="${a.id}">Edit</button>
          <button class="ghost" data-del="${a.id}">Delete</button>
        </td>
      </tr>`
    )
    .join("");
}

function renderPools() {
  const poolId = state.selectedPool || $("pool-select").value;
  const rows = poolId ? state.pools.filter((p) => p.id === poolId) : state.pools;
  $("empty-pools").hidden = rows.length > 0;
  $("empty-pools").innerHTML = "Nothing here yet. Click <strong>Add pool</strong> for a CIDR, or <strong>Add range</strong> for start and end IPs.";
  $("pool-list").innerHTML = rows
    .map((p) => {
      const mode = poolMode(p);
      return `<div class="pool-card">
        <div>
          <strong>${p.name}</strong>
          <span class="badge ${mode}">${mode === "range" ? "range" : "pool"}</span>
          <div><code>${poolRangeLabel(p)}</code></div>
          <small>${p.purpose || ""}</small>
        </div>
        <div class="row-actions">
          <button class="ghost" data-edit-pool="${p.id}">Edit</button>
          <button class="ghost" data-del-pool="${p.id}">Delete</button>
        </div>
      </div>`;
    })
    .join("");
}

function showView(name) {
  state.view = name;
  document.querySelectorAll(".view").forEach((el) => {
    el.hidden = el.id !== `view-${name}`;
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  const titles = {
    dashboard: ["Dashboard", "Pool utilization and IP map"],
    allocations: ["Allocations", "Pods, Services, Ingresses, Nodes — edit these by hand"],
    pools: ["Pools", "CIDR pools and optional IP ranges"],
  };
  $("page-title").textContent = titles[name][0];
  $("page-sub").textContent = titles[name][1];
}

function openAlloc(existing, presetIp) {
  $("alloc-error").hidden = true;
  $("alloc-id").value = existing?.id || "";
  $("alloc-kind").value = existing?.kind || "Service";
  $("alloc-ns").value = existing?.namespace || "default";
  $("alloc-name").value = existing?.name || "";
  $("alloc-pool").value = existing?.pool || state.selectedPool || $("pool-select").value;
  $("alloc-ip").value = existing?.ip || presetIp || "";
  $("alloc-status").value = existing?.status === "reserved" ? "reserved" : "allocated";
  $("alloc-notes").value = existing?.notes || "";
  $("alloc-dialog-title").textContent = existing ? "Edit IP" : "Add IP";
  $("alloc-dialog").showModal();
}

function openPool(existing, mode) {
  $("pool-error").hidden = true;
  $("pool-id").value = existing?.id || "";
  $("pool-name").value = existing?.name || "";
  $("pool-cidr").value = existing?.cidr || "";
  $("pool-start").value = existing?.start || "";
  $("pool-end").value = existing?.end || "";
  $("pool-purpose").value = existing?.purpose || "";
  const chosen = existing ? poolMode(existing) : mode || "cidr";
  setPoolMode(chosen);
  $("pool-dialog-title").textContent = existing
    ? chosen === "range"
      ? "Edit range"
      : "Edit pool"
    : chosen === "range"
      ? "Add range"
      : "Add pool";
  $("pool-dialog").showModal();
}

const AUTO_LOGOUT_TIME = 3 * 60 * 1000;
const WARNING_TIME = 30 * 1000;

const idle = {
  timer: null,
  warningTimer: null,
  successTimer: null,
  lastActivity: Date.now(),
  warningWasOpen: false,
  warningOpen: false,
  running: false,
};

function showToast(message, severity) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${severity}`;
  el.hidden = false;
}

function hideToast() {
  $("toast").hidden = true;
}

function openIdleWarning() {
  idle.warningOpen = true;
  showToast("You will be logged out in 30 seconds due to inactivity.", "warning");
  $("alloc-dialog").close();
  $("pool-dialog").close();
  const dialog = $("idle-dialog");
  if (!dialog.open) dialog.showModal();
}

function closeIdleWarning() {
  const dialog = $("idle-dialog");
  if (dialog.open) dialog.close();
}

function stopIdleWatch() {
  idle.running = false;
  idle.warningOpen = false;
  clearTimeout(idle.timer);
  clearTimeout(idle.warningTimer);
  clearTimeout(idle.successTimer);
  hideToast();
  closeIdleWarning();
  window.removeEventListener("mousemove", onActivity);
  window.removeEventListener("keydown", onActivity);
  window.removeEventListener("mousedown", onActivity);
  window.removeEventListener("touchstart", onActivity);
  window.removeEventListener("scroll", onActivity);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("pageshow", onFocus);
}

async function leaveApp() {
  stopIdleWatch();
  $("alloc-dialog").close();
  $("pool-dialog").close();
  try {
    await api("/api/logout", { method: "POST" });
  } catch (_err) {
    /* already logged out */
  }
  $("username").value = "";
  $("password").value = "";
  $("login-error").hidden = true;
  showUser("");
  $("app-screen").hidden = true;
  $("login-screen").hidden = false;
}

function showUser(name) {
  state.user = name || "";
  $("welcome-user").textContent = state.user ? `Welcome, ${state.user}` : "";
}

async function enterApp(user) {
  if (user) {
    showUser(user);
  } else {
    const me = await api("/api/me");
    showUser(me.user);
  }
  $("login-screen").hidden = true;
  $("app-screen").hidden = false;
  await refresh();
  startIdleWatch();
}

function resetIdleTimer() {
  if (!idle.running) return;
  idle.lastActivity = Date.now();
  clearTimeout(idle.timer);
  clearTimeout(idle.warningTimer);
  if (idle.warningOpen) {
    idle.warningWasOpen = true;
    idle.warningOpen = false;
    closeIdleWarning();
    hideToast();
  }
  if (idle.warningWasOpen) {
    showToast("Activity detected. Logout timer reset.", "success");
    idle.warningWasOpen = false;
    clearTimeout(idle.successTimer);
    idle.successTimer = setTimeout(() => {
      if ($("toast").classList.contains("success")) hideToast();
    }, 2000);
  }
  idle.timer = setTimeout(() => {
    leaveApp();
  }, AUTO_LOGOUT_TIME);
  idle.warningTimer = setTimeout(() => {
    openIdleWarning();
  }, AUTO_LOGOUT_TIME - WARNING_TIME);
}

function onActivity() {
  resetIdleTimer();
}

function idleExpired() {
  return Date.now() - idle.lastActivity >= AUTO_LOGOUT_TIME;
}

function onVisibility() {
  if (document.visibilityState !== "visible") return;
  if (idleExpired()) leaveApp();
  else resetIdleTimer();
}

function onFocus() {
  if (idleExpired()) leaveApp();
  else resetIdleTimer();
}

function startIdleWatch() {
  stopIdleWatch();
  idle.running = true;
  idle.warningWasOpen = false;
  idle.warningOpen = false;
  window.addEventListener("mousemove", onActivity);
  window.addEventListener("keydown", onActivity);
  window.addEventListener("mousedown", onActivity);
  window.addEventListener("touchstart", onActivity);
  window.addEventListener("scroll", onActivity);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("pageshow", onFocus);
  resetIdleTimer();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").hidden = true;
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("username").value,
        password: $("password").value,
      }),
    });
    await enterApp(data.user);
  } catch (err) {
    $("login-error").textContent = err.message;
    $("login-error").hidden = false;
  }
});

$("logout-btn").addEventListener("click", () => leaveApp());
$("idle-stay").addEventListener("click", () => resetIdleTimer());
$("idle-dialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  resetIdleTimer();
});

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

$("pool-select").addEventListener("change", () => {
  state.selectedPool = $("pool-select").value;
  refresh();
});
$("add-btn").addEventListener("click", () => openAlloc());
$("add-pool-btn").addEventListener("click", () => openPool(null, "cidr"));
$("add-range-btn").addEventListener("click", () => openPool(null, "range"));
$("mode-cidr").addEventListener("click", () => setPoolMode("cidr"));
$("mode-range").addEventListener("click", () => setPoolMode("range"));
$("alloc-cancel").addEventListener("click", () => $("alloc-dialog").close());
$("pool-cancel").addEventListener("click", () => $("pool-dialog").close());

$("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderTable();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.kind = chip.dataset.kind;
    renderTable();
  });
});

$("ip-grid").addEventListener("click", (e) => {
  const cell = e.target.closest(".ip-cell");
  if (!cell) return;
  const poolId = state.selectedPool || $("pool-select").value;
  const existing = state.allocations.find(
    (a) => a.ip === cell.dataset.ip && (!poolId || a.pool === poolId)
  );
  openAlloc(existing, cell.dataset.ip);
});

$("alloc-body").addEventListener("click", async (e) => {
  const editId = e.target.dataset.edit;
  const delId = e.target.dataset.del;
  if (editId) {
    openAlloc(state.allocations.find((a) => a.id === editId));
  }
  if (delId && confirm("Delete this IP record?")) {
    await api(`/api/allocations/${delId}`, { method: "DELETE" });
    await refresh();
  }
});

$("pool-list").addEventListener("click", async (e) => {
  const editId = e.target.dataset.editPool;
  const delId = e.target.dataset.delPool;
  if (editId) openPool(state.pools.find((p) => p.id === editId));
  if (delId && confirm("Delete this pool?")) {
    await api(`/api/pools/${delId}`, { method: "DELETE" });
    await refresh();
  }
});

$("alloc-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("alloc-error").hidden = true;
  const id = $("alloc-id").value;
  const payload = {
    kind: $("alloc-kind").value,
    namespace: $("alloc-ns").value.trim(),
    name: $("alloc-name").value.trim(),
    pool: $("alloc-pool").value,
    ip: $("alloc-ip").value.trim(),
    status: $("alloc-status").value,
    notes: $("alloc-notes").value.trim(),
  };
  try {
    await api(id ? `/api/allocations/${id}` : "/api/allocations", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    $("alloc-dialog").close();
    await refresh();
  } catch (err) {
    $("alloc-error").textContent = err.message;
    $("alloc-error").hidden = false;
  }
});

$("pool-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pool-error").hidden = true;
  const id = $("pool-id").value;
  const mode = $("pool-mode").value === "range" ? "range" : "cidr";
  const payload = {
    name: $("pool-name").value.trim(),
    mode,
    cidr: mode === "cidr" ? $("pool-cidr").value.trim() : "",
    start: mode === "range" ? $("pool-start").value.trim() : "",
    end: mode === "range" ? $("pool-end").value.trim() : "",
    purpose: $("pool-purpose").value.trim(),
  };
  try {
    const saved = await api(id ? `/api/pools/${id}` : "/api/pools", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    $("pool-dialog").close();
    if (saved?.id) state.selectedPool = saved.id;
    await refresh();
  } catch (err) {
    $("pool-error").textContent = err.message;
    $("pool-error").hidden = false;
  }
});

api("/api/me")
  .then(async (me) => {
    await enterApp(me.user);
  })
  .catch(() => {
    $("login-screen").hidden = false;
    $("app-screen").hidden = true;
  });
