// ═══════════════════════════════════════════════════════
//  tenant.js — Tenant Dashboard (API + UI)
// ═══════════════════════════════════════════════════════

const API = window.API;

// ─── State ───
let _tenant   = null;
let _payments = [];   // paid + partial only (from GET /tenant/:id)
let _tenantId = null;
let _phone    = null;

// ═══════════════════════════════════════════════════════
// TYPING / DELETING ENGINE
// Drives the live rotating text in the dashboard.
// ═══════════════════════════════════════════════════════

const _typers = {};

function startTyper(elementId, messages, {
    typeSpeed   = 38,
    deleteSpeed = 20,
    pauseAfter  = 2800,
    pauseBefore = 400,
    loop        = true
} = {}) {
    stopTyper(elementId);
    const el = document.getElementById(elementId);
    if (!el) return;

    const list  = Array.isArray(messages) ? messages : [messages];
    let msgIdx  = 0;
    let charIdx = 0;
    let deleting = false;
    let timer    = null;

    function tick() {
        const raw = list[msgIdx];
        const tmp = document.createElement('div');
        tmp.innerHTML = raw;
        const plain = tmp.textContent || '';

        if (!deleting) {
            charIdx++;
            el.innerHTML = charIdx < plain.length
                ? plain.substring(0, charIdx) + '<span class="typing-cursor">▍</span>'
                : raw + '<span class="typing-cursor">▍</span>';

            if (charIdx >= plain.length) {
                timer = setTimeout(() => { deleting = true; tick(); }, pauseAfter);
            } else {
                timer = setTimeout(tick, typeSpeed);
            }
        } else {
            charIdx--;
            el.innerHTML = charIdx > 0
                ? plain.substring(0, charIdx) + '<span class="typing-cursor">▍</span>'
                : '<span class="typing-cursor">▍</span>';

            if (charIdx <= 0) {
                deleting = false;
                if (loop) {
                    msgIdx  = (msgIdx + 1) % list.length;
                    charIdx = 0;
                    timer   = setTimeout(tick, pauseBefore);
                }
            } else {
                timer = setTimeout(tick, deleteSpeed);
            }
        }
    }

    timer = setTimeout(tick, pauseBefore);
    _typers[elementId] = () => clearTimeout(timer);
}

function stopTyper(id) {
    if (_typers[id]) { _typers[id](); _typers[id] = null; }
}


// ═══════════════════════════════════════════════════════
// AUTH & GUARD
// ═══════════════════════════════════════════════════════

function getToken()    { return localStorage.getItem('token'); }
function authHeaders() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() }; }

function getPayload() {
    const token = getToken();
    if (!token) return null;
    try { return JSON.parse(atob(token.split('.')[1])); }
    catch { return null; }
}

function logout() {
    localStorage.removeItem('token');
    window.location.href = 'auth.html';
}

// Guard — redirect if not tenant
(function guard() {
    const p = getPayload();
    if (!p) { window.location.href = 'auth.html'; return; }
    if (p.role === 'admin') { window.location.href = 'index.html'; return; }
    _tenantId = p.tenantId;
})();


// ═══════════════════════════════════════════════════════
// MAINTENANCE CHECK
// ═══════════════════════════════════════════════════════

async function checkMaintenance() {
    try {
        const res  = await fetch(`${API}/maintenance`);
        const data = await res.json();
        if (data.maintenanceMode) {
            showMaintenanceScreen(data.maintenanceMessage);
            return true;
        }
        return false;
    } catch { return false; }
}

function showMaintenanceScreen(message) {
    document.querySelector('header').style.display      = 'none';
    document.querySelector('.page-body').style.display  = 'none';
    document.querySelector('.bottom-nav').style.display = 'none';

    const screen = document.createElement('div');
    screen.id = 'maintenanceScreen';
    screen.style.cssText = `
        position:fixed;inset:0;background:var(--bg);
        display:flex;flex-direction:column;align-items:center;
        justify-content:center;text-align:center;padding:2rem;z-index:99999;
    `;
    screen.innerHTML = `
        <div style="max-width:400px;background:var(--panel);border:1px solid var(--border2);border-radius:16px;padding:2.5rem 2rem;box-shadow:0 24px 80px rgba(0,0,0,0.5)">
            <div style="font-size:3rem;margin-bottom:1rem">🔧</div>
            <div style="font-family:'Fraunces',serif;font-style:italic;font-size:1.6rem;color:var(--text);margin-bottom:0.75rem">Under Maintenance</div>
            <p style="font-size:0.85rem;color:var(--text-muted);line-height:1.7;margin-bottom:1.5rem">${message || 'The system is currently under maintenance. Please check back later.'}</p>
            <button onclick="window.location.reload()" style="background:var(--accent);border:none;border-radius:8px;color:#fff;font-size:0.82rem;font-weight:600;padding:0.65rem 1.5rem;cursor:pointer;width:100%;margin-bottom:0.5rem">↻ Check Again</button>
            <button onclick="logout()" style="background:transparent;border:1px solid var(--border2);border-radius:8px;color:var(--text-muted);font-size:0.75rem;padding:0.55rem 1.5rem;cursor:pointer;width:100%">Sign Out</button>
        </div>`;
    document.body.appendChild(screen);
}


// ═══════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════

function setTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem('tenant-theme', name);
    document.querySelectorAll('.theme-dot').forEach(d =>
        d.classList.toggle('active', d.dataset.theme === name)
    );
    const label = document.getElementById('currentThemeLabel');
    if (label) label.textContent = name;
    showToast('Theme: ' + name, 'success');
}

function loadTheme() {
    const saved = localStorage.getItem('tenant-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    document.querySelectorAll('.theme-dot').forEach(d =>
        d.classList.toggle('active', d.dataset.theme === saved)
    );
    const label = document.getElementById('currentThemeLabel');
    if (label) label.textContent = saved;
}

loadTheme();


// ═══════════════════════════════════════════════════════
// AVATAR
// ═══════════════════════════════════════════════════════

function nameToColor(name) {
    const palette = ['#7c3aed','#2563eb','#059669','#dc2626','#d97706','#db2777','#0891b2','#65a30d','#9333ea','#0284c7','#16a34a','#ea580c'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return palette[Math.abs(hash) % palette.length];
}

function getInitials(name) {
    return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function applyAvatar(name) {
    const color    = nameToColor(name);
    const initials = getInitials(name);
    const ha = document.getElementById('headerAvatar');
    const pa = document.getElementById('profileAvatar');
    if (ha) { ha.textContent = initials; ha.style.background = color; }
    if (pa) { pa.textContent = initials; pa.style.background = color; }
}


// ═══════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════

let _toastTimer;
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className   = `show ${type}`;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}


// ═══════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════

const SECTION_LOADERS = {
    receipts: loadReceipts,
    messages: loadMessages,
    notices:  loadNotices,
    rules:    loadRules,
};

function showSection(name) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    const sec = document.getElementById(`sec-${name}`);
    if (sec) sec.classList.add('active');

    document.querySelectorAll('.bnav-item').forEach(b => b.classList.remove('active'));
    const bnav = document.getElementById(`bnav-${name}`);
    if (bnav) bnav.classList.add('active');

    document.querySelectorAll('.dsk-nav-item').forEach(d => d.classList.remove('active'));
    document.querySelectorAll('.dsk-nav-item').forEach(d => {
        if (d.getAttribute('onclick')?.includes(`'${name}'`)) d.classList.add('active');
    });

    if (SECTION_LOADERS[name]) SECTION_LOADERS[name]();
}


// ═══════════════════════════════════════════════════════
// PAYMENT STATUS HELPERS
// ═══════════════════════════════════════════════════════

// Get the most recent payment record for a given month
function _getMonthPayment(month) {
    // Sort by createdAt desc, find last entry for month
    return _payments
        .filter(p => p.month === month)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

// Get effective status for a month considering all payments
// 'paid' = totalPaid >= rentAmount, 'partial' = some paid, 'unpaid' = none
function _getMonthStatus(month, rent) {
    const monthPayments = _payments.filter(p => p.month === month);
    if (!monthPayments.length) return { status: 'unpaid', totalPaid: 0, balance: rent };

    // Use the most recent record's totalPaid/balance (most accurate)
    const latest = monthPayments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    return {
        status:    latest.status,           // 'paid' | 'partial'
        totalPaid: latest.totalPaid || 0,
        balance:   latest.balance   || 0
    };
}

// Pill HTML by status
function _statusPill(status) {
    switch (status) {
        case 'paid':    return '<span class="pill pill-green">Paid ✅</span>';
        case 'partial': return '<span class="pill pill-amber">Partial ⚠️</span>';
        case 'failed':  return '<span class="pill pill-red">Failed ❌</span>';
        case 'pending': return '<span class="pill pill-amber">Pending ⏳</span>';
        default:        return '<span class="pill pill-red">Unpaid ❌</span>';
    }
}

// Format date safely — null datePaid shows '—'
function _fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function _fmtKsh(n) {
    return `Ksh ${Number(n || 0).toLocaleString()}`;
}


// ═══════════════════════════════════════════════════════
// LOAD PROFILE & HOME DATA
// ═══════════════════════════════════════════════════════

async function loadProfile() {
    if (!_tenantId) { showToast('Session error — please log in again', 'error'); return; }

    try {
        const res  = await fetch(`${API}/tenant/${_tenantId}`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to load profile', 'error'); return; }

        _tenant   = data.tenant;
        _payments = data.payments || [];
        _phone    = _tenant.phone;

        renderHeader(data);
        renderHome(data);
        renderProfile(data);
        renderPaySection(data);
        renderSettings(data);

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}


// ═══════════════════════════════════════════════════════
// RENDER — HEADER (FIX 7)
// ═══════════════════════════════════════════════════════

function renderHeader(data) {
    const t = data.tenant;
    document.getElementById('headerName').textContent = t.name.split(' ')[0];
    applyAvatar(t.name);

    // FIX 7: correct status — check actual payment status not just existence
    const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const rent         = t.house ? t.house.rent : 0;
    const ms           = _getMonthStatus(currentMonth, rent);
    const pill         = document.getElementById('headerStatus');

    if (ms.status === 'paid') {
        pill.textContent = '✅ Paid';
        pill.className   = 'status-pill paid';
    } else if (ms.status === 'partial') {
        pill.textContent = '⚠️ Partial';
        pill.className   = 'status-pill partial';
    } else {
        pill.textContent = '❌ Unpaid';
        pill.className   = 'status-pill unpaid';
    }
}


// ═══════════════════════════════════════════════════════
// RENDER — HOME (FIX 5, 6)
// ═══════════════════════════════════════════════════════

function renderHome(data) {
    document.getElementById('statPaid').textContent    = Number(data.totalPaid || 0).toLocaleString();
    document.getElementById('statArrears').textContent = Number(data.arrears   || 0).toLocaleString();
    document.getElementById('statHouse').textContent   = data.tenant.house ? data.tenant.house.name : 'Not assigned';

    const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const house        = data.tenant.house;
    const rent         = house ? house.rent : 0;
    const ms           = _getMonthStatus(currentMonth, rent);
    const statusEl     = document.getElementById('monthStatus');

    if (!house) {
        statusEl.innerHTML = `<span style="color:var(--text-dim)">No house assigned yet. Contact your landlord.</span>`;
        document.getElementById('homeProgressWrap').style.display = 'none';
        return;
    }

    // FIX 6: distinguish paid / partial / unpaid
    const progressWrap = document.getElementById('homeProgressWrap');
    progressWrap.style.display = 'block';

    const pct = rent > 0 ? Math.min(100, Math.round((ms.totalPaid / rent) * 100)) : 0;
    document.getElementById('homePaidLabel').textContent    = `Paid: ${_fmtKsh(ms.totalPaid)}`;
    document.getElementById('homeRentLabel').textContent    = `Rent: ${_fmtKsh(rent)}`;
    document.getElementById('homeBalanceLabel').textContent = _fmtKsh(ms.balance);

    const bar = document.getElementById('homeProgressBar');
    bar.style.width = `${pct}%`;
    bar.className   = `pay-progress-fill ${ms.status === 'paid' ? 'status-paid' : ms.status === 'partial' ? 'status-partial' : 'status-unpaid'}`;

    if (ms.status === 'paid') {
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:0.75rem">
                <span style="font-size:1.5rem">✅</span>
                <div>
                    <div style="font-weight:600;color:var(--green)">${currentMonth} — Fully Paid</div>
                    <div style="font-size:0.72rem;color:var(--text-dim);font-family:'DM Mono',monospace">${_fmtKsh(ms.totalPaid)} received · balance Ksh 0</div>
                </div>
            </div>`;
    } else if (ms.status === 'partial') {
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:0.75rem">
                <span style="font-size:1.5rem">⚠️</span>
                <div>
                    <div style="font-weight:600;color:var(--amber)">${currentMonth} — Partially Paid</div>
                    <div style="font-size:0.72rem;color:var(--text-dim);font-family:'DM Mono',monospace">${_fmtKsh(ms.totalPaid)} paid · ${_fmtKsh(ms.balance)} remaining</div>
                </div>
            </div>`;
    } else {
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:0.75rem">
                <span style="font-size:1.5rem">❌</span>
                <div>
                    <div style="font-weight:600;color:var(--red)">${currentMonth} — Not Paid</div>
                    <div style="font-size:0.72rem;color:var(--text-dim);font-family:'DM Mono',monospace">${_fmtKsh(rent)} due</div>
                </div>
            </div>`;
    }
}


// ═══════════════════════════════════════════════════════
// RENDER — PROFILE (FIX 1, 2, 3)
// ═══════════════════════════════════════════════════════

function renderProfile(data) {
    const t = data.tenant;

    document.getElementById('profileName').textContent  = t.name;
    document.getElementById('profileEmail').textContent = t.email;
    document.getElementById('profilePhone').textContent = t.phone || '—';
    document.getElementById('profileHouse').textContent = t.house ? t.house.name : 'Not assigned';
    document.getElementById('profileRent').textContent  = t.house ? _fmtKsh(t.house.rent) + ' / month' : '—';
    document.getElementById('profileDue').textContent   = `${t.dueDate || 5}th of each month`;
    document.getElementById('profileSince').textContent = _fmtDate(t.createdAt);
    document.getElementById('profileTotalPaid').textContent = _fmtKsh(data.totalPaid);

    const tbody = document.getElementById('payHistoryTable');

    if (!_payments.length) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No payments recorded yet</div></td></tr>`;
        return;
    }

    // FIX 1: all 6 columns in correct order — Month | Amount | Total Paid | Balance | Status | Date
    // FIX 2: guard datePaid null
    // FIX 3: status pill by actual status
    tbody.innerHTML = _payments
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(p => `
            <tr>
                <td>${p.month}</td>
                <td class="td-mono">${_fmtKsh(p.amount)}</td>
                <td class="td-mono">${_fmtKsh(p.totalPaid)}</td>
                <td class="td-mono" style="color:${p.balance > 0 ? 'var(--amber)' : 'var(--green)'}">
                    ${_fmtKsh(p.balance)}
                </td>
                <td>${_statusPill(p.status)}</td>
                <td class="td-mono">${_fmtDate(p.datePaid)}</td>
            </tr>`)
        .join('');
}


// ═══════════════════════════════════════════════════════
// RENDER — PAY SECTION (FIX 8, 11, 21)
// ═══════════════════════════════════════════════════════

function renderPaySection(data) {
    const t     = data.tenant;
    const house = t.house;

    const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const ms           = house ? _getMonthStatus(currentMonth, house.rent) : { status: 'unpaid', totalPaid: 0, balance: house ? house.rent : 0 };
    const summaryEl    = document.getElementById('rentSummary');

    if (!house) {
        summaryEl.innerHTML = `<span style="color:var(--text-dim)">No house assigned. Contact landlord.</span>`;
        return;
    }

    // Pre-fill month
    document.getElementById('payMonth').value = currentMonth;

    // FIX 11 & 21: pre-fill amount with REMAINING BALANCE, not full rent
    document.getElementById('payAmount').value = ms.balance > 0 ? ms.balance : '';

    // FIX 8: show paid/partial/unpaid correctly
    let statusBadge;
    if (ms.status === 'paid')         statusBadge = `<span class="pill pill-green">Paid ✅</span>`;
    else if (ms.status === 'partial') statusBadge = `<span class="pill pill-amber">Partial ⚠️</span>`;
    else                              statusBadge = `<span class="pill pill-red">Unpaid ❌</span>`;

    summaryEl.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:0.5rem">
            <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:var(--text-dim)">House</span>
                <span style="font-family:'DM Mono',monospace">${house.name}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:var(--text-dim)">Monthly Rent</span>
                <span style="font-family:'DM Mono',monospace;color:var(--accent)">${_fmtKsh(house.rent)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:var(--text-dim)">Paid This Month</span>
                <span style="font-family:'DM Mono',monospace">${_fmtKsh(ms.totalPaid)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:var(--text-dim)">Balance Remaining</span>
                <span style="font-family:'DM Mono',monospace;color:${ms.balance > 0 ? 'var(--amber)' : 'var(--green)'}">
                    ${_fmtKsh(ms.balance)}
                </span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:var(--text-dim)">${currentMonth}</span>
                ${statusBadge}
            </div>
            ${data.arrears > 0 ? `
            <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:var(--text-dim)">Total Outstanding</span>
                <span style="color:var(--red);font-family:'DM Mono',monospace">${_fmtKsh(data.arrears)}</span>
            </div>` : ''}
        </div>`;

    // Show progress bar in pay section
    const payProgressWrap = document.getElementById('payProgressWrap');
    if (payProgressWrap) {
        payProgressWrap.style.display = 'block';
        const pct = house.rent > 0 ? Math.min(100, Math.round((ms.totalPaid / house.rent) * 100)) : 0;
        document.getElementById('payPaidLabel').textContent    = `Paid: ${_fmtKsh(ms.totalPaid)}`;
        document.getElementById('payRentLabel').textContent    = `Rent: ${_fmtKsh(house.rent)}`;
        document.getElementById('payBalanceLabel').textContent = _fmtKsh(ms.balance);
        const bar = document.getElementById('payProgressBar');
        bar.style.width = `${pct}%`;
        bar.className   = `pay-progress-fill ${ms.status === 'paid' ? 'status-paid' : ms.status === 'partial' ? 'status-partial' : 'status-unpaid'}`;
    }
}


// ═══════════════════════════════════════════════════════
// RENDER — SETTINGS
// ═══════════════════════════════════════════════════════

function renderSettings(data) {
    const t = data.tenant;
    document.getElementById('settingsName').textContent  = t.name;
    document.getElementById('settingsEmail').textContent = t.email;
    document.getElementById('settingsPhone').textContent = t.phone || '—';
}


// ═══════════════════════════════════════════════════════
// CHECK MONTH BALANCE — FIX 12
// Called by #payMonth oninput in tenant.html
// Fetches live summary from backend and updates pay section UI
// ═══════════════════════════════════════════════════════

async function checkMonthBalance() {
    const month = document.getElementById('payMonth').value.trim();
    if (!month || !_tenantId) return;

    const payProgressWrap = document.getElementById('payProgressWrap');

    try {
        const res  = await fetch(
            `${API}/payments/summary/${_tenantId}/${encodeURIComponent(month)}`,
            { headers: authHeaders() }
        );

        if (!res.ok) {
            if (payProgressWrap) payProgressWrap.style.display = 'none';
            return;
        }

        const data = await res.json();
        const rent = data.rentAmount || (_tenant?.house?.rent) || 0;

        // Update amount field with remaining balance
        document.getElementById('payAmount').value = data.balance > 0 ? data.balance : '';

        // Update progress bar
        if (payProgressWrap) {
            payProgressWrap.style.display = 'block';
            const pct = rent > 0 ? Math.min(100, Math.round((data.totalPaid / rent) * 100)) : 0;
            document.getElementById('payPaidLabel').textContent    = `Paid: ${_fmtKsh(data.totalPaid)}`;
            document.getElementById('payRentLabel').textContent    = `Rent: ${_fmtKsh(rent)}`;
            document.getElementById('payBalanceLabel').textContent = _fmtKsh(data.balance);
            const bar = document.getElementById('payProgressBar');
            bar.style.width = `${pct}%`;
            bar.className   = `pay-progress-fill ${data.status === 'paid' ? 'status-paid' : data.status === 'partial' ? 'status-partial' : 'status-unpaid'}`;
        }

        // Update rent summary text
        const summaryEl = document.getElementById('rentSummary');
        if (summaryEl) {
            let badge;
            if (data.status === 'paid')         badge = `<span class="pill pill-green">Paid ✅</span>`;
            else if (data.status === 'partial') badge = `<span class="pill pill-amber">Partial ⚠️</span>`;
            else                                badge = `<span class="pill pill-red">Unpaid ❌</span>`;

            summaryEl.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:0.45rem">
                    <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                        <span style="color:var(--text-dim)">Month</span>
                        <span style="font-family:'DM Mono',monospace">${month}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                        <span style="color:var(--text-dim)">Rent</span>
                        <span style="font-family:'DM Mono',monospace;color:var(--accent)">${_fmtKsh(rent)}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                        <span style="color:var(--text-dim)">Paid</span>
                        <span style="font-family:'DM Mono',monospace">${_fmtKsh(data.totalPaid)}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                        <span style="color:var(--text-dim)">Balance</span>
                        <span style="font-family:'DM Mono',monospace;color:${data.balance > 0 ? 'var(--amber)' : 'var(--green)'}">
                            ${_fmtKsh(data.balance)}
                        </span>
                    </div>
                    <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                        <span style="color:var(--text-dim)">Status</span>
                        ${badge}
                    </div>
                </div>`;
        }

    } catch (err) {
        console.error('checkMonthBalance error:', err);
    }
}


// ═══════════════════════════════════════════════════════
// M-PESA PAYMENT (FIX 13)
// ═══════════════════════════════════════════════════════

async function payWithMpesa() {
    const amount = document.getElementById('payAmount').value;
    const month  = document.getElementById('payMonth').value.trim();

    if (!amount || !month) { showToast('Enter amount and month', 'warn'); return; }
    if (!_phone)            { showToast('No phone number on your account', 'error'); return; }

    // FIX 13: only block if FULLY paid — allow partial top-ups
    const ms = _getMonthStatus(month, _tenant?.house?.rent || 0);
    if (ms.status === 'paid') {
        showToast(`${month} is already fully paid ✅`, 'warn');
        return;
    }

    const btn = document.querySelector('.mpesa-btn');
    btn.disabled    = true;
    btn.textContent = '⏳ Sending prompt...';

    try {
        const res  = await fetch(`${API}/stkpush`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ amount: Number(amount), month })
        });
        const data = await res.json();

        btn.disabled    = false;
        btn.textContent = '📱 Pay with M-Pesa';

        if (!res.ok) {
            showToast(data.message || data.error || 'M-Pesa request failed', 'error');
            renderPayStatus('failed', { reason: data.message });
            return;
        }

        renderPayStatus('waiting', { phone: _phone, amount, month });
        pollPaymentStatus(data.checkoutRequestId, month);

    } catch (err) {
        btn.disabled    = false;
        btn.textContent = '📱 Pay with M-Pesa';
        showToast('Network error — check your connection', 'error');
        console.error(err);
    }
}

async function pollPaymentStatus(checkoutRequestId, month) {
    const maxAttempts = 40;
    let   attempts    = 0;

    const interval = setInterval(async () => {
        attempts++;

        try {
            const res  = await fetch(`${API}/payment-status/${checkoutRequestId}`, {
                headers: authHeaders()
            });
            const data = await res.json();

            if (data.status === 'confirmed') {
                clearInterval(interval);
                renderPayStatus('confirmed', {
                    paymentId: data.paymentId,
                    mpesaCode: data.mpesaCode,
                    month
                });
                showToast('Payment confirmed ✅', 'success');
                await loadProfile(); // refresh stats
                return;
            }

            if (data.status === 'failed') {
                clearInterval(interval);
                renderPayStatus('failed', { reason: data.reason || 'Payment was not completed' });
                showToast('Payment failed or cancelled', 'error');
                return;
            }

            if (data.status === 'duplicate') {
                clearInterval(interval);
                renderPayStatus('confirmed', { mpesaCode: 'Already recorded', month });
                showToast(`${month} is already paid ✅`, 'warn');
                return;
            }

            if (data.status === 'timeout') {
                clearInterval(interval);
                renderPayStatus('timeout', {});
                showToast('Payment timed out. Try again.', 'warn');
                return;
            }

            // Still pending — update countdown
            const secondsLeft = (maxAttempts - attempts) * 3;
            renderPayStatus('waiting', { phone: _phone, secondsLeft });

        } catch (err) {
            console.error('Polling error:', err);
        }

        if (attempts >= maxAttempts) {
            clearInterval(interval);
            renderPayStatus('timeout', {});
            showToast('No response from M-Pesa. Check receipts later.', 'warn');
        }
    }, 3000);
}

function renderPayStatus(status, data) {
    const el = document.getElementById('payReceipt');

    const states = {
        waiting: `
            <div class="card" style="border-color:rgba(251,191,36,0.35);margin-top:1rem;text-align:center;padding:1.5rem 1rem">
                <div style="font-size:2rem;margin-bottom:0.5rem;display:inline-block;animation:spin 1.5s linear infinite">⏳</div>
                <div style="font-weight:600;color:var(--amber);margin-bottom:0.3rem">Waiting for payment...</div>
                <div style="font-size:0.75rem;color:var(--text-dim);font-family:'DM Mono',monospace">
                    Check <strong style="color:var(--text)">${data.phone || ''}</strong> for the M-Pesa prompt
                </div>
                ${data.secondsLeft ? `<div style="font-size:0.68rem;color:var(--text-dim);margin-top:0.4rem">Timing out in ~${data.secondsLeft}s</div>` : ''}
            </div>`,

        confirmed: `
            <div class="card" style="border-color:rgba(52,211,153,0.35);margin-top:1rem;text-align:center;padding:1.5rem 1rem">
                <div style="font-size:2.5rem;margin-bottom:0.5rem">✅</div>
                <div style="font-weight:600;color:var(--green);margin-bottom:0.5rem">Payment Confirmed!</div>
                ${data.mpesaCode ? `<div style="font-family:'DM Mono',monospace;font-size:0.72rem;color:var(--text-dim)">M-Pesa Code: <strong style="color:var(--text)">${data.mpesaCode}</strong></div>` : ''}
                ${data.month     ? `<div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.2rem">${data.month} — Payment recorded</div>` : ''}
                <div style="margin-top:1rem;display:flex;gap:0.5rem;justify-content:center">
                    ${data.paymentId ? `<button class="btn btn-secondary btn-sm" onclick="downloadPDF('${data.paymentId}')">📄 Download Receipt</button>` : ''}
                    <button class="btn btn-primary btn-sm" onclick="showSection('receipts')">View All Receipts</button>
                </div>
            </div>`,

        failed: `
            <div class="card" style="border-color:rgba(248,113,113,0.35);margin-top:1rem;text-align:center;padding:1.5rem 1rem">
                <div style="font-size:2rem;margin-bottom:0.5rem">❌</div>
                <div style="font-weight:600;color:var(--red);margin-bottom:0.3rem">Payment Failed</div>
                <div style="font-size:0.75rem;color:var(--text-dim)">${data.reason || 'The payment was not completed. Please try again.'}</div>
            </div>`,

        timeout: `
            <div class="card" style="border-color:rgba(251,191,36,0.25);margin-top:1rem;text-align:center;padding:1.5rem 1rem">
                <div style="font-size:2rem;margin-bottom:0.5rem">⏱️</div>
                <div style="font-weight:600;color:var(--amber);margin-bottom:0.3rem">Request Timed Out</div>
                <div style="font-size:0.75rem;color:var(--text-dim)">If you entered your PIN, check your receipts in a few minutes. Otherwise try again.</div>
                <button class="btn btn-secondary btn-sm" onclick="showSection('receipts')" style="margin-top:0.75rem;width:auto">Check Receipts</button>
            </div>`
    };

    el.innerHTML = states[status] || '';
}


// ═══════════════════════════════════════════════════════
// RECEIPTS (FIX 9)
// ═══════════════════════════════════════════════════════

async function loadReceipts() {
    if (!_tenantId) return;

    try {
        const res  = await fetch(`${API}/payments/tenant/${_tenantId}`, { headers: authHeaders() });
        const data = await res.json();
        const el   = document.getElementById('receiptsList');

        if (!Array.isArray(data) || !data.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">🧾</span>No receipts yet</div>`;
            return;
        }

        // Show paid and partial payments only — sorted newest first
        const visible = data
            .filter(p => p.status === 'paid' || p.status === 'partial')
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        if (!visible.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">🧾</span>No receipts yet</div>`;
            return;
        }

        el.innerHTML = visible.map(p => `
            <div class="info-item" style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem">
                <div style="flex:1;min-width:0">
                    <div class="info-title">${p.month}</div>
                    <div class="info-date" style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:0.2rem">
                        <span>Paid: ${_fmtKsh(p.amount)}</span>
                        <span>Total: ${_fmtKsh(p.totalPaid)}</span>
                        <span style="color:${p.balance > 0 ? 'var(--amber)' : 'var(--green)'}">
                            Bal: ${_fmtKsh(p.balance)}
                        </span>
                        <span>${_fmtDate(p.datePaid)}</span>
                        ${p.mpesaCode ? `<span style="font-family:'DM Mono',monospace">${p.mpesaCode}</span>` : ''}
                    </div>
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.35rem;flex-shrink:0">
                    ${_statusPill(p.status)}
                    <button class="btn btn-secondary btn-sm" onclick="downloadPDF('${p._id}')">📄 PDF</button>
                </div>
            </div>`).join('');

    } catch (err) {
        showToast('Failed to load receipts', 'error');
        console.error(err);
    }
}

async function downloadPDF(paymentId) {
    try {
        const res = await fetch(`${API}/receipt/pdf/${paymentId}`, {
            headers: { 'Authorization': 'Bearer ' + getToken() }
        });
        if (!res.ok) { showToast('PDF not found', 'error'); return; }
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `receipt-${paymentId}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        showToast('Failed to download PDF', 'error');
        console.error(err);
    }
}


// ═══════════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════════

async function loadMessages() {
    try {
        const res  = await fetch(`${API}/messages/my`, { headers: authHeaders() });
        const msgs = await res.json();
        if (!res.ok) { console.error('Failed to load messages:', msgs); return; }

        renderChat(msgs);
        await markMyMessagesRead();

        const badge    = document.getElementById('msgBadge');
        const dskBadge = document.getElementById('dskMsgBadge');
        if (badge)    badge.style.display    = 'none';
        if (dskBadge) dskBadge.style.display = 'none';

    } catch (err) { console.error('loadMessages error:', err); }
}

async function markMyMessagesRead() {
    try {
        await fetch(`${API}/messages/read/${_tenantId}`, {
            method: 'PUT', headers: authHeaders()
        });
    } catch { /* silent */ }
}

function renderChat(messages) {
    const box = document.getElementById('chatBox');

    if (!messages || !messages.length) {
        box.innerHTML = `<div class="empty-state"><span class="empty-icon">💬</span>No messages yet. Send a message to your landlord!</div>`;
        return;
    }

    box.innerHTML = messages
        .slice()
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .map(m => {
            const isMine = m.sender === 'tenant';
            const time   = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const date   = new Date(m.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' });
            return `
                <div class="msg-bubble ${isMine ? 'msg-mine' : 'msg-admin'}">
                    ${m.text}
                    <div class="msg-meta">
                        ${isMine ? 'You' : '🏠 Landlord'} · ${date} ${time}
                    </div>
                </div>`;
        }).join('');

    box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
    const input = document.getElementById('msgInput');
    const text  = input.value.trim();
    if (!text) return;

    input.disabled = true;
    try {
        const res  = await fetch(`${API}/messages`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ text })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to send', 'error'); return; }
        input.value = '';
        await loadMessages();
    } catch (err) {
        showToast('Network error', 'error');
    } finally {
        input.disabled = false;
        input.focus();
    }
}

// Enter key sends
document.getElementById('msgInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});


// ═══════════════════════════════════════════════════════
// UNREAD BADGE — FIX 17: single definition using /unread-mine
// ═══════════════════════════════════════════════════════

async function checkUnreadBadge() {
    try {
        const res  = await fetch(`${API}/messages/unread-mine`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) return;

        const count    = data.count || 0;
        const badge    = document.getElementById('msgBadge');
        const dskBadge = document.getElementById('dskMsgBadge');

        if (count > 0) {
            const label = count > 9 ? '9+' : count;
            if (badge)    { badge.textContent    = label; badge.style.display    = 'flex'; }
            if (dskBadge) { dskBadge.textContent = label; dskBadge.style.display = 'inline-block'; }
        } else {
            if (badge)    badge.style.display    = 'none';
            if (dskBadge) dskBadge.style.display = 'none';
        }
    } catch { /* silent */ }
}


// ═══════════════════════════════════════════════════════
// NOTICES (ANNOUNCEMENTS)
// ═══════════════════════════════════════════════════════

async function loadNotices() {
    try {
        const res  = await fetch(`${API}/announcements`);
        const data = await res.json();
        const el   = document.getElementById('noticesList');

        if (!data.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">📢</span>No announcements yet</div>`;
            return;
        }

        el.innerHTML = data.map(a => `
            <div class="info-item">
                <div class="info-body">${a.message}</div>
                <div class="info-date">${_fmtDate(a.createdAt)}</div>
            </div>`).join('');
    } catch (err) { console.error(err); }
}


// ═══════════════════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════════════════

async function loadRules() {
    try {
        const res   = await fetch(`${API}/rules`);
        const rules = await res.json();
        const el    = document.getElementById('rulesList');

        if (!rules.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">📜</span>No rules posted yet</div>`;
            return;
        }

        el.innerHTML = rules.map((r, i) => `
            <div class="info-item">
                <div class="info-title" style="display:flex;align-items:center;gap:0.5rem">
                    <span style="font-family:'DM Mono',monospace;font-size:0.62rem;color:var(--accent);background:var(--accent-dim);padding:1px 7px;border-radius:99px">${i + 1}</span>
                    ${r.title}
                </div>
                <div class="info-body" style="margin-top:0.3rem">${r.content}</div>
                <div class="info-date">${_fmtDate(r.createdAt)}</div>
            </div>`).join('');
    } catch (err) { console.error(err); }
}


// ═══════════════════════════════════════════════════════
// CHANGE PASSWORD
// ═══════════════════════════════════════════════════════

async function changePassword() {
    const current = document.getElementById('currentPassword').value;
    const newPw   = document.getElementById('newPassword').value;
    const confirm = document.getElementById('confirmPassword').value;

    if (!current || !newPw || !confirm) { showToast('Fill all password fields', 'warn'); return; }
    if (newPw !== confirm) { showToast('New passwords do not match', 'error'); return; }
    if (newPw.length < 6)  { showToast('Password must be at least 6 characters', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/change-password`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ currentPassword: current, newPassword: newPw })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to change password', 'error'); return; }
        showToast('Password updated successfully ✅', 'success');
        ['currentPassword', 'newPassword', 'confirmPassword'].forEach(id => {
            document.getElementById(id).value = '';
        });
    } catch (err) {
        showToast('Network error', 'error');
    }
}


// ═══════════════════════════════════════════════════════
// TYPING ANIMATION — LIVE DASHBOARD TEXT
// Suggestions shown to landlord/tenant to make system feel alive
// ═══════════════════════════════════════════════════════

const TENANT_GREETINGS = [
    '// your home, managed simply',
    '// M-Pesa payments in seconds',
    '// track every payment, every month',
    '// receipts always at your fingertips',
    '// your landlord is a message away',
    '// Affordable Rentals — built for Kenya',
    '// never miss a due date again',
    '// all your records in one place',
    '// rent on time, stress-free living',
    '// pay partial or full — we track it all',
];

function startGreetingTyper() {
    startTyper('headerGreeting', TENANT_GREETINGS, {
        typeSpeed: 35, deleteSpeed: 18, pauseAfter: 2800, pauseBefore: 500, loop: true
    });
}


// ═══════════════════════════════════════════════════════
// INIT (FIX 16, 18)
// ═══════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', async () => {
    // 1. Maintenance check first
    const underMaintenance = await checkMaintenance();
    if (underMaintenance) return;

    // 2. Load dashboard data
    await loadProfile();
    await checkUnreadBadge();

    // 3. Start typing animation
    startGreetingTyper();

    // 4. Re-check maintenance every 2 minutes
    setInterval(async () => {
        const still = await checkMaintenance();
        if (still && !document.getElementById('maintenanceScreen')) {
            showMaintenanceScreen();
        }
    }, 2 * 60 * 1000);
});

// FIX 16: single interval registration — not duplicated at bottom
setInterval(checkUnreadBadge, 30000);           // unread badge every 30s
setInterval(loadProfile, 300000);               // FIX 18: profile every 5 min (was 30s)
setInterval(loadNotices, 300000);               // notices every 5 min
setInterval(loadRules, 600000);                 // rules every 10 min
setInterval(loadMessages, 20000);               // messages every 20s if open
setInterval(loadReceipts, 120000);              // receipts every 2 min