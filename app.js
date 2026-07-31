// ── STATE ───────────────────────────────────────────
var S = {
  adminPin: "1234",
  players: [],
  products: [],
  transactions: [],
};
var cart = [];
var selId = null;
var isAdmin = false;
var pendingAction = null;

function save() {
  if (!canWrite()) return;
  try {
    localStorage.setItem("vk5", JSON.stringify(S));
  } catch (e) {}
}
function load() {
  if (!canWrite()) return;
  try {
    var d = localStorage.getItem("vk5");
    if (d) {
      var p = JSON.parse(d);
      S = Object.assign({}, S, p);
    }
  } catch (e) {}
}

// ── SYNC & GISTS ───────────────────────────────────
var CFG_KEY = "vk5cfg";
var PENDING_KEY = "vk5pending";
var DEFAULT_STATE_URL =
  "https://gist.githubusercontent.com/webepg/882c146cd9ad2fd82b00d1fd0e319fab/raw/";
var GIST_LOG_FILE = "log";
var GIST_STATE_FILE = "state";
var CFG = {
  token: "",
  gistLog: "",
  gistState: "",
  stateUrl: DEFAULT_STATE_URL,
};
var syncBusy = false;

function loadCfg() {
  try {
    var d = localStorage.getItem(CFG_KEY);
    if (d) CFG = Object.assign({}, CFG, JSON.parse(d));
  } catch (e) {}
}
function saveCfg() {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(CFG));
  } catch (e) {}
}
function canWrite() {
  return !!(CFG.token && CFG.token.trim() && CFG.gistLog && CFG.gistState);
}
function gistId(v) {
  v = (v || "").trim();
  if (!v) return "";
  var m = v.match(/gist\.github\.com\/[^/]+\/([0-9a-f]+)/i);
  if (m) return m[1];
  var m2 = v.match(/([0-9a-f]{20,})/i);
  if (m2) return m2[1];
  return v;
}
function loadPending() {
  try {
    var d = localStorage.getItem(PENDING_KEY);
    var a = JSON.parse(d);
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}
function savePending(a) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(a));
  } catch (e) {}
}
function queueTransaction(t) {
  var pending = loadPending();
  pending.push(t);
  savePending(pending);
}

function gistRead(id) {
  return fetch(
    "https://api.github.com/gists/" + encodeURIComponent(gistId(id)),
    {
      headers: {
        Authorization: "token " + CFG.token,
        Accept: "application/vnd.github+json",
      },
    },
  ).then(function (r) {
    if (!r.ok) throw new Error("gist " + r.status);
    return r.json();
  });
}
function gistWrite(id, file, content) {
  var body = { files: {} };
  body.files[file] = { content: content };
  return fetch(
    "https://api.github.com/gists/" + encodeURIComponent(gistId(id)),
    {
      method: "PATCH",
      headers: {
        Authorization: "token " + CFG.token,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  ).then(function (r) {
    if (!r.ok) throw new Error("gist " + r.status);
    return r.json();
  });
}

function buildSnapshot() {
  return {
    version: 1,
    updated: new Date().toISOString(),
    players: S.players.map(function (p) {
      return {
        id: p.id,
        name: p.name,
        debt: p.debt,
        lastPaid: p.lastPaid || null,
        active: p.active !== false,
      };
    }),
    products: S.products,
    transactions: S.transactions,
  };
}

function fetchState() {
  if (!CFG.stateUrl) return;
  fetch(CFG.stateUrl, { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("state " + r.status);
      return r.text();
    })
    .then(function (t) {
      if (!canWrite()) {
        console.log("Vereinskasse: State im Lesemodus geladen", t);
      }
      var d = JSON.parse(t);
      if (!d || !Array.isArray(d.players)) throw new Error("format");
      S = Object.assign({}, S, { players: d.players });
      if (Array.isArray(d.products)) S.products = d.products;
      if (!canWrite() && Array.isArray(d.transactions))
        S.transactions = d.transactions;
      save();
      renderPlayers();
      renderProdGrid();
      updateSelBar();
      updateDebtBox();
    })
    .catch(function () {});
}

function applyReadOnly() {
  var ro = !canWrite();
  document.body.classList.toggle("readonly", ro);
  if (ro) switchTab("players");
}

function renderSyncStatus() {
  var el = document.getElementById("syncInfo");
  if (!el) return;
  var p = loadPending();
  el.innerHTML =
    "Token: " +
    (canWrite() ? "✓" : "–") +
    " · Log-Gist: " +
    (CFG.gistLog || "–") +
    " · State-Gist: " +
    (CFG.gistState || "–") +
    "<br>Ausstehende Buchungen: " +
    p.length;
}

function populateConfig() {
  var t = document.getElementById("cfgToken");
  if (t) t.value = CFG.token;
  var l = document.getElementById("cfgGistLog");
  if (l) l.value = CFG.gistLog;
  var s = document.getElementById("cfgGistState");
  if (s) s.value = CFG.gistState;
  renderSyncStatus();
}

function saveConfig() {
  CFG.token = document.getElementById("cfgToken").value.trim();
  CFG.gistLog = gistId(document.getElementById("cfgGistLog").value);
  CFG.gistState = gistId(document.getElementById("cfgGistState").value);
  saveCfg();
  applyReadOnly();
  renderSyncStatus();
  if (!loadPending().length) fetchState();
  toast("Einstellungen gespeichert ✓", "ok");
}

function syncNow(silent) {
  if (syncBusy) return;
  if (!canWrite()) {
    if (!silent)
      toast("Sync nicht eingerichtet – Token/Gist-IDs im Admin", "err");
    return;
  }
  var pending = loadPending();
  if (!pending.length) {
    if (!silent) toast("Alles synchron ✓", "ok");
    renderSyncStatus();
    return;
  }
  syncBusy = true;
  gistRead(CFG.gistLog)
    .then(function (g) {
      var log = [];
      var f = g.files[GIST_LOG_FILE];
      if (f && f.content) {
        try {
          log = JSON.parse(f.content);
        } catch (e) {
          log = [];
        }
      }
      if (!Array.isArray(log)) log = [];
      var have = {};
      for (var i = 0; i < log.length; i++) {
        if (log[i] && log[i].id != null) have[log[i].id] = 1;
      }
      var add = [];
      for (var i = 0; i < pending.length; i++) {
        if (!(pending[i].id in have)) add.push(pending[i]);
      }
      return Promise.all([
        gistWrite(CFG.gistLog, GIST_LOG_FILE, JSON.stringify(log.concat(add))),
        gistWrite(
          CFG.gistState,
          GIST_STATE_FILE,
          JSON.stringify(buildSnapshot()),
        ),
      ]);
    })
    .then(function () {
      syncBusy = false;
      savePending([]);
      renderSyncStatus();
      toast("Sync erfolgreich ✓", "ok");
    })
    .catch(function () {
      syncBusy = false;
      renderSyncStatus();
      if (!silent) toast("Sync fehlgeschlagen", "err");
    });
}

// ── CLOCK ───────────────────────────────────────────
function tick() {
  var n = new Date();
  document.getElementById("clock").textContent =
    ("0" + n.getHours()).slice(-2) + ":" + ("0" + n.getMinutes()).slice(-2);
}
setInterval(tick, 1000);
tick();

// ── OVERDUE ─────────────────────────────────────────
function isOverdue(p) {
  if (p.debt <= 0) return false;
  var ref = p.lastPaid;
  if (!ref) {
    var first = null;
    for (var i = 0; i < S.transactions.length; i++) {
      var t = S.transactions[i];
      if (t.playerId === p.id && t.type === "getraenke" && t.amount > 0) {
        first = t;
        break;
      }
    }
    if (!first) return false;
    ref = first.date;
  }
  return (Date.now() - new Date(ref).getTime()) / 86400000 > 30;
}

// ── PLAYERS ─────────────────────────────────────────
function renderPlayers() {
  var q = document.getElementById("plSearch").value.toLowerCase();
  var list = S.players
    .filter(function (p) {
      return p.active !== false && p.name.toLowerCase().indexOf(q) >= 0;
    })
    .sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
  document.getElementById("plCount").textContent = list.length + " Spieler";
  var html = "";
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    var od = isOverdue(p);
    html +=
      '<div class="pl-row' +
      (selId === p.id ? " active" : "") +
      (od ? " overdue" : "") +
      '" onclick="selPlayer(' +
      p.id +
      ')">';
    html += '<div style="flex:1;min-width:0;">';
    html += '<div class="pl-name">' + esc(p.name) + "</div>";
    if (od) html += '<span class="overdue-tag">ÜBERFÄLLIG</span>';
    html += "</div>";
    if (p.debt > 0)
      html += '<span class="pl-debt-val">' + fmt(p.debt) + "</span>";
    else if (p.debt < 0)
      html +=
        '<span style="font-family:Oswald,sans-serif;font-weight:600;font-size:14px;color:var(--success);">' +
        fmt(Math.abs(p.debt)) +
        " G</span>";
    else html += '<span class="pl-debt-none">–</span>';
    html += "</div>";
  }
  document.getElementById("plList").innerHTML = html;
}

function selPlayer(id) {
  selId = id;
  renderPlayers();
  updateSelBar();
  updateDebtBox();
  if (window.innerWidth <= 1023 && getTab() === "players")
    switchTab("products");
}

function switchTab(tab) {
  var map = { players: ".col-left", products: ".col-mid", cart: ".col-right" };
  var cols = document.querySelectorAll(".col");
  for (var i = 0; i < cols.length; i++)
    cols[i].classList.toggle("show", cols[i].matches(map[tab]));
  var tabs = document.querySelectorAll(".mob-tab");
  for (var i = 0; i < tabs.length; i++)
    tabs[i].classList.toggle(
      "active",
      tabs[i].getAttribute("data-tab") === tab,
    );
}
function getTab() {
  var active = document.querySelector(".mob-tab.active");
  return active ? active.getAttribute("data-tab") : "players";
}

function updateSelBar() {
  var bar = document.getElementById("selBar");
  if (!selId) {
    bar.innerHTML = '<span class="sel-bar-empty">← Spieler wählen</span>';
    return;
  }
  var p = getPlayer(selId);
  bar.innerHTML =
    '<span class="sel-bar-name">' +
    esc(p.name) +
    "</span>" +
    '<span class="sel-bar-debt">' +
    (p.debt > 0 ? "Schulden: " + fmt(p.debt) : "Keine Schulden") +
    "</span>";
}

function updateDebtBox() {
  renderDebtDetail();
  var box = document.getElementById("debtBox");
  if (!selId) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  var p = getPlayer(selId);
  var dv = document.getElementById("debtVal");
  if (p.debt > 0) {
    dv.textContent = fmt(p.debt) + " Schulden";
    dv.className = "debt-val-red";
  } else if (p.debt < 0) {
    dv.textContent = fmt(Math.abs(p.debt)) + " Guthaben";
    dv.className = "debt-val-green";
  } else {
    dv.textContent = "0,00 €";
    dv.className = "debt-val-ok";
  }
  var ow = document.getElementById("overdueWarn");
  ow.style.display = isOverdue(p) ? "block" : "none";
  var bs = document.getElementById("btnSettle");
  if (p.debt > 0) {
    bs.style.display = "block";
    bs.textContent = "✓ Bar bezahlt – " + fmt(p.debt);
  } else {
    bs.style.display = "none";
  }
}

function renderDebtDetail() {
  var el = document.getElementById("debtDetail");
  if (!el) return;
  var show = false;
  if (selId) {
    var p = getPlayer(selId);
    show = !!p && p.debt > 0;
  }
  if (!show) {
    el.style.display = "none";
    return;
  }
  var rows = [];
  for (var i = 0; i < S.transactions.length; i++) {
    var t = S.transactions[i];
    if (t.playerId === p.id && t.type === "getraenke" && !t.paid) rows.push(t);
  }
  rows.sort(function (a, b) {
    return new Date(b.date) - new Date(a.date);
  });
  var html = "";
  if (rows.length === 0) {
    html += '<div class="dd-empty">Keine Einzelbuchungen verfügbar</div>';
  }
  var total = 0;
  for (var i = 0; i < rows.length; i++) {
    var t = rows[i];
    total += t.amount;
    html +=
      '<div class="dd-row">' +
      '<div class="dd-info">' +
      '<div class="dd-items">' +
      esc(t.items || t.playerName) +
      "</div>" +
      '<div class="dd-date">' +
      fmtDate(t.date) +
      "</div>" +
      "</div>" +
      '<span class="dd-amt">' +
      fmt(t.amount) +
      "</span>" +
      "</div>";
  }
  el.style.display = "block";
  document.getElementById("debtDetailList").innerHTML = html;
  document.getElementById("debtDetailTotal").textContent = fmt(total);
}

function settlePlayer() {
  if (!isAdmin) {
    openAdminForAction("zahlung");
    return;
  }
  if (!canWrite()) {
    toast("Keine Schreibrechte – Sync im Admin einrichten", "err");
    return;
  }
  if (!selId) return;
  var p = getPlayer(selId);
  var t = {
    id: Date.now(),
    type: "getraenke",
    playerId: p.id,
    playerName: p.name,
    items: "Barzahlung",
    amount: p.debt,
    method: "bar",
    paid: true,
    settled: true,
    date: new Date().toISOString(),
  };
  S.transactions.push(t);
  queueTransaction(t);
  for (var i = 0; i < S.transactions.length; i++) {
    var t2 = S.transactions[i];
    if (t2.playerId === p.id && t2.type === "getraenke" && !t2.paid)
      t2.paid = true;
  }
  p.lastPaid = new Date().toISOString();
  toast("" + fmt(p.debt) + " von " + p.name + " erhalten ✓", "ok");
  p.debt = 0;
  renderPlayers();
  updateSelBar();
  updateDebtBox();
  save();
  syncNow(true);
}

// ── PRODUCTS ────────────────────────────────────────
function renderProdGrid() {
  var html = "";
  for (var i = 0; i < S.products.length; i++) {
    var p = S.products[i];
    html +=
      '<div class="prod-btn" onclick="addToCart(' +
      p.id +
      ')">' +
      '<span class="prod-nm">' +
      esc(p.name) +
      "</span>" +
      '<span class="prod-pr">' +
      fmt(p.price) +
      "</span>" +
      "</div>";
  }
  document.getElementById("prodGrid").innerHTML = html;
}

function addToCart(pid) {
  if (!selId) {
    toast("Bitte zuerst Spieler wählen", "err");
    return;
  }
  var pr = null;
  for (var i = 0; i < S.products.length; i++) {
    if (S.products[i].id === pid) {
      pr = S.products[i];
      break;
    }
  }
  if (!pr) return;
  var ex = null;
  for (var i = 0; i < cart.length; i++) {
    if (cart[i].id === pid && !cart[i].custom) {
      ex = cart[i];
      break;
    }
  }
  if (ex) ex.qty++;
  else
    cart.push({
      id: pid,
      name: pr.name,
      price: pr.price,
      qty: 1,
      custom: false,
    });
  renderCart();
}

function addVarItem() {
  if (!selId) {
    toast("Bitte zuerst Spieler wählen", "err");
    return;
  }
  var nm = document.getElementById("varNm").value.trim();
  var pr = parseFloat(document.getElementById("varPr").value);
  if (!nm || isNaN(pr) || pr === 0) {
    toast("Bezeichnung und Betrag eingeben", "err");
    return;
  }
  cart.push({
    id: Date.now(),
    name: nm,
    price: pr,
    qty: 1,
    custom: true,
  });
  document.getElementById("varNm").value = "";
  document.getElementById("varPr").value = "";
  renderCart();
}

function removeFromCart(id, custom) {
  for (var i = 0; i < cart.length; i++) {
    if (cart[i].id === id && cart[i].custom === custom) {
      if (!custom && cart[i].qty > 1) cart[i].qty--;
      else cart.splice(i, 1);
      break;
    }
  }
  renderCart();
}

function clearCart() {
  cart = [];
  renderCart();
}

function cartTotal() {
  var s = 0;
  for (var i = 0; i < cart.length; i++) s += cart[i].price * cart[i].qty;
  return Math.round(s * 100) / 100;
}

function renderCart() {
  var el = document.getElementById("cartList");
  if (cart.length === 0) {
    el.innerHTML = '<div class="cart-empty-msg">Noch nichts gewählt</div>';
  } else {
    var html = "";
    for (var i = 0; i < cart.length; i++) {
      var c = cart[i];
      html +=
        '<div class="cart-row">' +
        '<span class="cart-qty">' +
        c.qty +
        "</span>" +
        '<span class="cart-nm">' +
        esc(c.name) +
        "</span>" +
        '<span class="cart-pr" style="color:' +
        (c.price < 0 ? "var(--success)" : "var(--red-light)") +
        ';">' +
        fmt(c.price * c.qty) +
        "</span>" +
        '<button class="cart-del" onclick="removeFromCart(' +
        c.id +
        "," +
        c.custom +
        ')">✕</button>' +
        "</div>";
    }
    el.innerHTML = html;
  }
  document.getElementById("cartTotal").textContent = fmt(cartTotal());
  var badge = document.getElementById("mobCartBadge");
  if (badge) {
    var n = 0;
    for (var i = 0; i < cart.length; i++) n += cart[i].qty;
    badge.style.display = n ? "inline-block" : "none";
    badge.textContent = n;
  }
}

function doPay() {
  if (!canWrite()) {
    toast("Keine Schreibrechte – Sync im Admin einrichten", "err");
    return;
  }
  if (!selId) {
    toast("Bitte Spieler wählen", "err");
    return;
  }
  if (cart.length === 0) {
    toast("Warenkorb ist leer", "err");
    return;
  }
  var p = getPlayer(selId);
  var total = cartTotal();
  var items = cart
    .map(function (c) {
      return c.name + (c.qty > 1 ? " ×" + c.qty : "");
    })
    .join(", ");
  var isGuthaben = total < 0;
  var t = {
    id: Date.now(),
    type: "getraenke",
    playerId: p.id,
    playerName: p.name,
    items: items,
    amount: total,
    method: "aufschreiben",
    paid: isGuthaben,
    date: new Date().toISOString(),
  };
  S.transactions.push(t);
  queueTransaction(t);
  p.debt = Math.round((p.debt + total) * 100) / 100;
  if (isGuthaben)
    toast(
      "Guthaben " + fmt(Math.abs(total)) + " für " + p.name + " gutgeschrieben",
      "ok",
    );
  else toast(fmt(total) + " aufgeschrieben für " + p.name, "ok");
  cart = [];
  renderCart();
  updateSelBar();
  updateDebtBox();
  renderPlayers();
  save();
  syncNow(true);
}

// ── ADMIN ────────────────────────────────────────────
function openAdminForAction(action) {
  pendingAction = action;
  document.getElementById("pinSection").classList.remove("hidden");
  document.getElementById("adminContent").classList.add("hidden");
  document.getElementById("pinInput").value = "";
  document.getElementById("pinErr").textContent = "";
  document.getElementById("adminBadge").style.display = "none";
  openModal("adminModal");
}

function openAdmin() {
  document.getElementById("pinSection").classList.remove("hidden");
  document.getElementById("adminContent").classList.add("hidden");
  document.getElementById("pinInput").value = "";
  document.getElementById("pinErr").textContent = "";
  document.getElementById("adminBadge").style.display = "none";
  openModal("adminModal");
}

function checkPin() {
  if (document.getElementById("pinInput").value === S.adminPin) {
    isAdmin = true;
    document.getElementById("pinSection").classList.add("hidden");
    document.getElementById("adminContent").classList.remove("hidden");
    document.getElementById("adminBadge").style.display = "inline-block";
    if (pendingAction) {
      closeModal("adminModal");
      var action = pendingAction;
      pendingAction = null;
      isAdmin = true;
      if (action === "zahlung") settlePlayer();
    } else {
      renderAdminContent();
      // Auto-close after short delay when opened via admin button
    }
  } else {
    document.getElementById("pinErr").textContent = "❌ Falscher PIN";
    document.getElementById("pinInput").value = "";
  }
}

function renderAdminContent() {
  // Players
  var sorted = S.players.slice().sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  var ph = "";
  var hasInactive = false;
  for (var i = 0; i < sorted.length; i++) {
    var p = sorted[i];
    if (p.active === false) {
      hasInactive = true;
      continue;
    }
    var debtStr =
      p.debt > 0
        ? '<span style="color:#ff6b6b;">' + fmt(p.debt) + "</span>"
        : "OK";
    ph +=
      '<div class="m-list-row" id="plrow-' +
      p.id +
      '">' +
      "<span>" +
      esc(p.name) +
      "</span>" +
      '<span style="display:flex;align-items:center;gap:6px;">' +
      debtStr +
      '<button class="btn btn-ghost btn-sm" onclick="confirmAustreten(' +
      p.id +
      ')">Austreten</button>' +
      "</span></div>" +
      '<div id="confirm-' +
      p.id +
      '" style="display:none;background:#2a0505;border:1px solid var(--red);border-radius:7px;padding:8px 12px;margin-bottom:6px;display:none;font-size:13px;">' +
      '<span style="color:#ff9999;">' +
      esc(p.name) +
      " wirklich deaktivieren?</span>" +
      '<span style="display:flex;gap:6px;margin-top:6px;">' +
      '<button class="btn btn-red btn-sm" onclick="removePlayer(' +
      p.id +
      ')">✓ Ja, austreten</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="cancelAustreten(' +
      p.id +
      ')">Abbrechen</button>' +
      "</span></div>";
  }
  if (hasInactive) {
    ph +=
      '<div style="font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:0.8px;font-weight:600;padding:10px 0 6px;margin-top:4px;border-top:1px solid var(--border);">Ausgetreten</div>';
    for (var i = 0; i < sorted.length; i++) {
      var p = sorted[i];
      if (p.active !== false) continue;
      ph +=
        '<div class="m-list-row" style="opacity:0.5;">' +
        "<span>" +
        esc(p.name) +
        ' <span style="font-size:11px;color:var(--gray);">(inaktiv)</span></span>' +
        '<button class="btn btn-ghost btn-sm" onclick="reactivatePlayer(' +
        p.id +
        ')" style="font-size:11px;">Reaktivieren</button>' +
        "</div>";
    }
  }
  document.getElementById("adminPlList").innerHTML = ph;

  // Products
  var prh = "";
  for (var i = 0; i < S.products.length; i++) {
    var p = S.products[i];
    prh +=
      '<div class="m-list-row">' +
      "<span>" +
      esc(p.name) +
      "</span>" +
      '<span style="display:flex;align-items:center;gap:10px;">' +
      '<span style="font-family:Oswald,sans-serif;color:var(--red-light);">' +
      fmt(p.price) +
      "</span>" +
      '<button class="btn btn-ghost btn-sm" onclick="removeProduct(' +
      p.id +
      ')">✕</button>' +
      "</span></div>";
  }
  document.getElementById("adminPrList").innerHTML = prh;

  // Stats
  var total = 0,
    offen = 0;
  for (var i = 0; i < S.transactions.length; i++) {
    var t = S.transactions[i];
    if (t.type === "getraenke" && t.amount > 0) total += t.amount;
  }
  for (var i = 0; i < S.players.length; i++) offen += S.players[i].debt;
  document.getElementById("adminStats").innerHTML =
    '<div class="stats-2">' +
    '<div class="stat-box"><div class="stat-val" style="color:var(--red-light);">' +
    fmt(total) +
    '</div><div class="stat-lbl">Gesamtumsatz</div></div>' +
    '<div class="stat-box"><div class="stat-val" style="color:#ff6b6b;">' +
    fmt(offen) +
    '</div><div class="stat-lbl">Noch offen</div></div>' +
    "</div>";

  // Date range default: current month
  var now = new Date();
  var von = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  var bis = now.toISOString().slice(0, 10);
  if (!document.getElementById("filterVon").value)
    document.getElementById("filterVon").value = von;
  if (!document.getElementById("filterBis").value)
    document.getElementById("filterBis").value = bis;
  renderZahlungen();
  populateConfig();
}

function addPlayer() {
  if (!canWrite()) {
    toast("Keine Schreibrechte – Sync im Admin einrichten", "err");
    return;
  }
  var nm = document.getElementById("newPlName").value.trim();
  if (!nm) return;
  for (var i = 0; i < S.players.length; i++) {
    if (S.players[i].name.toLowerCase() === nm.toLowerCase()) {
      toast("Spieler existiert bereits", "err");
      return;
    }
  }
  S.players.push({
    id: Date.now(),
    name: nm,
    debt: 0,
    lastPaid: null,
    active: true,
  });
  document.getElementById("newPlName").value = "";
  renderAdminContent();
  renderPlayers();
  save();
  toast(nm + " hinzugefügt", "ok");
}

function removePlayer(id) {
  if (!canWrite()) {
    toast("Keine Schreibrechte – Sync im Admin einrichten", "err");
    return;
  }
  var p = getPlayer(id);
  if (!p) {
    toast("Spieler nicht gefunden", "err");
    return;
  }
  if (p.debt !== 0) {
    toast("Spieler hat offene Schulden", "err");
    return;
  }
  p.active = false;
  if (selId === id) {
    selId = null;
    updateSelBar();
    updateDebtBox();
  }
  renderAdminContent();
  renderPlayers();
  save();
  toast(p.name + " deaktiviert", "ok");
}

function confirmAustreten(id) {
  // Hide all other confirm boxes first
  var boxes = document.querySelectorAll('[id^="confirm-"]');
  boxes.forEach(function (b) {
    b.style.display = "none";
  });
  var box = document.getElementById("confirm-" + id);
  if (box) box.style.display = "block";
}
function cancelAustreten(id) {
  var box = document.getElementById("confirm-" + id);
  if (box) box.style.display = "none";
}

function reactivatePlayer(id) {
  if (!canWrite()) {
    toast("Keine Schreibrechte – Sync im Admin einrichten", "err");
    return;
  }
  var p = getPlayer(id);
  p.active = true;
  renderAdminContent();
  renderPlayers();
  save();
  toast(p.name + " reaktiviert", "ok");
}

function addProduct() {
  if (!canWrite()) {
    toast("Keine Schreibrechte – Sync im Admin einrichten", "err");
    return;
  }
  var nm = document.getElementById("newPrNm").value.trim();
  var pr = parseFloat(document.getElementById("newPrPr").value);
  if (!nm || isNaN(pr) || pr <= 0) return;
  S.products.push({ id: Date.now(), name: nm, price: pr });
  document.getElementById("newPrNm").value = "";
  document.getElementById("newPrPr").value = "";
  renderAdminContent();
  renderProdGrid();
  save();
}

function removeProduct(id) {
  if (!canWrite()) {
    toast("Keine Schreibrechte – Sync im Admin einrichten", "err");
    return;
  }
  S.products = S.products.filter(function (x) {
    return x.id !== id;
  });
  renderAdminContent();
  renderProdGrid();
  save();
}

// ── ZAHLUNGEN ────────────────────────────────────────
function setRange(type) {
  var now = new Date(),
    von,
    bis = now.toISOString().slice(0, 10);
  if (type === "month")
    von = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString()
      .slice(0, 10);
  else if (type === "quarter")
    von = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)
      .toISOString()
      .slice(0, 10);
  else von = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  document.getElementById("filterVon").value = von;
  document.getElementById("filterBis").value = bis;
  renderZahlungen();
}

function renderZahlungen() {
  var von = document.getElementById("filterVon").value;
  var bis = document.getElementById("filterBis").value;
  var vonD = von ? new Date(von) : null;
  var bisD = bis ? new Date(bis + "T23:59:59") : null;

  // Collect settled payments (bar bezahlt = settled:true transactions)
  var zahlungen = [];
  for (var i = 0; i < S.transactions.length; i++) {
    var t = S.transactions[i];
    if (t.type !== "getraenke") continue;
    if (!t.settled && !(t.paid && t.method !== "aufschreiben")) continue;
    var d = new Date(t.date);
    if (vonD && d < vonD) continue;
    if (bisD && d > bisD) continue;
    zahlungen.push(t);
  }

  var total = 0;
  for (var i = 0; i < zahlungen.length; i++) total += zahlungen[i].amount;

  // Per player
  var byPlayer = {};
  for (var i = 0; i < zahlungen.length; i++) {
    var t = zahlungen[i];
    if (!byPlayer[t.playerName]) byPlayer[t.playerName] = 0;
    byPlayer[t.playerName] += t.amount;
  }
  var playerArr = Object.keys(byPlayer).map(function (n) {
    return { name: n, amt: byPlayer[n] };
  });
  playerArr.sort(function (a, b) {
    return b.amt - a.amt;
  });

  document.getElementById("zStats").innerHTML =
    '<div class="stats-2">' +
    '<div class="stat-box"><div class="stat-val" style="color:var(--success);">' +
    fmt(total) +
    '</div><div class="stat-lbl">Eingenommen</div></div>' +
    '<div class="stat-box"><div class="stat-val">' +
    zahlungen.length +
    '</div><div class="stat-lbl">Zahlungen</div></div>' +
    "</div>";

  if (zahlungen.length === 0) {
    document.getElementById("zList").innerHTML =
      '<div style="text-align:center;padding:16px;color:var(--gray);font-size:13px;">Keine Zahlungen im Zeitraum</div>';
    return;
  }

  var html =
    '<div style="font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:0.8px;font-weight:600;padding:8px 0 6px;">Pro Spieler</div>';
  for (var i = 0; i < playerArr.length; i++) {
    html +=
      '<div class="z-row"><span class="z-name">' +
      esc(playerArr[i].name) +
      '</span><span class="z-amt">' +
      fmt(playerArr[i].amt) +
      "</span></div>";
  }
  html +=
    '<div style="font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:0.8px;font-weight:600;padding:10px 0 6px;">Einzelne Zahlungen</div>';
  var sorted = zahlungen.slice().sort(function (a, b) {
    return new Date(b.date) - new Date(a.date);
  });
  for (var i = 0; i < sorted.length; i++) {
    var t = sorted[i];
    html +=
      '<div class="z-row">' +
      '<div><div class="z-name">' +
      esc(t.playerName) +
      "</div>" +
      '<div class="z-meta">' +
      fmtDate(t.date) +
      " · " +
      t.method +
      "</div></div>" +
      '<span class="z-amt">' +
      fmt(t.amount) +
      "</span>" +
      "</div>";
  }
  document.getElementById("zList").innerHTML = html;
}

// ── UTILS ────────────────────────────────────────────
function getPlayer(id) {
  for (var i = 0; i < S.players.length; i++) {
    if (S.players[i].id === id) return S.players[i];
  }
  return null;
}
function fmt(n) {
  var v = Math.round((n || 0) * 100) / 100;
  return v.toFixed(2).replace(".", ",") + " €";
}
function fmtDate(iso) {
  return new Date(iso).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function esc(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function openModal(id) {
  document.getElementById(id).classList.add("open");
}
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
  if (id === "adminModal") {
    isAdmin = false;
    document.getElementById("adminBadge").style.display = "none";
  }
}
function toast(msg, type) {
  var el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast" + (type ? " " + type : "");
  el.classList.add("show");
  setTimeout(function () {
    el.classList.remove("show");
  }, 2800);
}
document.querySelectorAll(".overlay").forEach(function (o) {
  o.addEventListener("click", function (e) {
    if (e.target === o) {
      o.classList.remove("open");
      if (o.id === "adminModal") {
        isAdmin = false;
        pendingAction = null;
        document.getElementById("adminBadge").style.display = "none";
      }
    }
  });
});

// ── INIT ─────────────────────────────────────────────
loadCfg();
load();
fetchState();
applyReadOnly();
switchTab(getTab());
renderPlayers();
renderProdGrid();
renderCart();
