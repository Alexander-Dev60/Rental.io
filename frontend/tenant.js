// ═══════════════════════════════════════════════════════
//  tenant.js — Tenant Dashboard (API + UI)
//
//  Principle: this file does NO rent, date or fee arithmetic.
//  Every figure comes from the server (GET /tenant/me/overview,
//  GET /tenant/:id, GET /payments/tenant/:id) which uses the same
//  helpers as the landlord dashboard. This file only renders.
// ═══════════════════════════════════════════════════════

const API = window.API;

// ─── State ───
let _tenant   = null;
let _overview = null;   // GET /tenant/me/overview
let _ledger   = [];     // paid/partial payments of every category, newest first
let _tenantId = null;
let _phone    = null;


// ═══════════════════════════════════════════════════════
// TYPING / DELETING ENGINE
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
function authHeaders() {
    const token = getToken();
    if (!token) {
        window.location.href = 'auth.html';
        throw new Error('No auth token — redirecting to login');
    }
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
}

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

(function guard() {
    const p = getPayload();
    if (!p) { window.location.href = 'auth.html'; return; }

    if (p.exp && Date.now() >= p.exp * 1000) {
        localStorage.removeItem('token');
        window.location.href = 'auth.html';
        return;
    }

    if (p.role === 'landlord' || p.role === 'caretaker') { window.location.href = 'dashboard.html'; return; }

    if (p.mustChangePassword) { window.location.href = 'change-password.html'; return; }

    _tenantId = p.tenantId || p.id || p._id || p.sub || null;

    if (!_tenantId) {
        console.error('JWT has no tenant ID field. Keys present:', Object.keys(p));
        localStorage.removeItem('token');
        window.location.href = 'auth.html';
        return;
    }

    if (p.exp) {
        const originalToken = getToken();
        const msUntilExpiry = (p.exp * 1000) - Date.now();
        setTimeout(() => {
            const currentToken = getToken();
            if (currentToken === originalToken) {
                localStorage.removeItem('token');
                window.location.href = 'auth.html';
            }
        }, msUntilExpiry + 1000);
    }
})();


// ═══════════════════════════════════════════════════════
// MAINTENANCE CHECK  (landlord-level + platform-wide)
// ═══════════════════════════════════════════════════════

async function _fetchMaintenanceState() {
    try {
        const r = await fetch(`${API}/platform-status`);
        const d = await r.json();
        if (d && d.maintenanceMode) {
            return { on: true, platform: true, message: d.message };
        }
    } catch { /* fall through to landlord check */ }

    try {
        const res = await fetch(`${API}/maintenance`, { headers: authHeaders() });
        const d   = await res.json();
        if (d && d.maintenanceMode) {
            return { on: true, platform: false, message: d.maintenanceMessage };
        }
    } catch { /* network error → treat as not under maintenance */ }

    return { on: false };
}

async function checkMaintenance() {
    const s = await _fetchMaintenanceState();
    if (s.on) showMaintenanceScreen(s.message, { platform: s.platform });
    return s.on;
}

function showMaintenanceScreen(message, { platform = false } = {}) {
    const overlay = document.getElementById('platformMaintenanceOverlay');
    if (!overlay) return;

    const title = platform ? 'Platform Maintenance' : 'Under Maintenance';
    const fallback = platform
        ? 'Affordable Rentals is temporarily down for maintenance. Please check back shortly.'
        : 'The system is currently under maintenance. Please check back later.';

    const titleEl = overlay.querySelector('[data-maint-title]');
    const descEl  = document.getElementById('platformMaintenanceDesc');
    if (titleEl) titleEl.textContent = title;
    if (descEl)  descEl.textContent  = message || fallback;

    overlay.classList.add('show');
}

(function installPlatformMaintenanceInterceptor() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== 'function' || nativeFetch.__arMaintWrapped) return;

    const wrapped = async function (...args) {
        const res = await nativeFetch.apply(this, args);
        if (res.status === 503) {
            try {
                const body = await res.clone().json();
                if (body && body.code === 'PLATFORM_MAINTENANCE') {
                    showMaintenanceScreen(body.message, { platform: true });
                }
            } catch { /* not JSON, or already consumed — ignore */ }
        }
        return res;
    };
    wrapped.__arMaintWrapped = true;
    window.fetch = wrapped;
})();


// ═══════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════

// Exactly two themes: Black ("dark") and White ("light"). The retired blue/orange
// values fall back to Black.
const THEME_LABELS = { dark: 'Black', light: 'White' };

function _applyTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    document.querySelectorAll('.theme-dot').forEach(d =>
        d.classList.toggle('active', d.dataset.theme === name)
    );
    const label = document.getElementById('currentThemeLabel');
    if (label) label.textContent = THEME_LABELS[name];
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', name === 'light' ? '#ffffff' : '#08090b');
}

function setTheme(name) {
    if (name !== 'dark' && name !== 'light') name = 'dark';
    localStorage.setItem('tenant-theme', name);
    _applyTheme(name);
    showToast('Theme: ' + THEME_LABELS[name], 'success');
}

function loadTheme() {
    let saved = localStorage.getItem('tenant-theme') || 'dark';
    if (saved !== 'dark' && saved !== 'light') { saved = 'dark'; localStorage.setItem('tenant-theme', 'dark'); }
    _applyTheme(saved);
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
    if (document.getElementById('platformMaintenanceOverlay')?.classList.contains('show')) return;
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className   = `show ${type}`;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}


// ═══════════════════════════════════════════════════════
// PROPERTY BADGE — shows property name in header
// ═══════════════════════════════════════════════════════

function showPropertyBadge(propName) {
    const existing = document.getElementById('headerPropertyBadge');
    if (existing) existing.remove();
    if (!propName) return;

    const badge = document.createElement('span');
    badge.id = 'headerPropertyBadge';
    Object.assign(badge.style, {
        fontFamily:    "'DM Mono', monospace",
        fontSize:      '0.58rem',
        letterSpacing: '0.06em',
        background:    'var(--accent-dim)',
        color:         'var(--accent)',
        border:        '1px solid rgba(224,187,100,0.2)',
        padding:       '2px 8px',
        borderRadius:  '99px',
        whiteSpace:    'nowrap',
        maxWidth:      '140px',
        overflow:      'hidden',
        textOverflow:  'ellipsis',
        flexShrink:    '0',
        display:       'inline-flex',
        alignItems:    'center',
        gap:           '4px'
    });
    badge.title     = propName;
    badge.innerHTML = `${ICON('properties',11)} ${_esc(propName)}`;

    const headerRight = document.querySelector('.header-right');
    const statusPill  = document.getElementById('headerStatus');
    if (headerRight && statusPill) {
        headerRight.insertBefore(badge, statusPill);
    }
}


// ═══════════════════════════════════════════════════════
// PASSWORD STRENGTH & MATCH INDICATORS
// ═══════════════════════════════════════════════════════

function getPasswordStrength(password) {
    if (!password) return { score: 0, label: '', color: 'transparent', width: '0%' };

    let score = 0;
    if (password.length >= 6)           score++;
    if (password.length >= 10)          score++;
    if (/[A-Z]/.test(password))         score++;
    if (/[0-9]/.test(password))         score++;
    if (/[^A-Za-z0-9]/.test(password))  score++;

    const levels = [
        { score: 0, label: '',            color: 'transparent',  width: '0%'   },
        { score: 1, label: 'Weak',        color: 'var(--red)',    width: '20%'  },
        { score: 2, label: 'Fair',        color: 'var(--amber)',  width: '40%'  },
        { score: 3, label: 'Good',        color: '#eab308',       width: '60%'  },
        { score: 4, label: 'Strong',      color: 'var(--green)',  width: '80%'  },
        { score: 5, label: 'Very Strong', color: '#10b981',       width: '100%' },
    ];

    return levels[Math.min(score, 5)];
}

function updatePasswordStrength() {
    const password = document.getElementById('newPassword')?.value || '';
    const bar      = document.getElementById('pwStrengthBar');
    const label    = document.getElementById('pwStrengthLabel');
    if (!bar || !label) return;

    const s = getPasswordStrength(password);
    bar.style.width      = s.width;
    bar.style.background = s.color;
    label.textContent    = s.label ? `Strength: ${s.label}` : '';
    label.style.color    = s.color;

    updatePasswordMatch();
}

function updatePasswordMatch() {
    const newPw     = document.getElementById('newPassword')?.value    || '';
    const confirm   = document.getElementById('confirmPassword')?.value || '';
    const indicator = document.getElementById('pwMatchIndicator');
    if (!indicator) return;

    if (!confirm) { indicator.textContent = ''; return; }

    if (newPw === confirm) {
        indicator.textContent = '✓ Passwords match';
        indicator.style.color = 'var(--green)';
    } else {
        indicator.textContent = '✗ Passwords don\'t match';
        indicator.style.color = 'var(--red)';
    }
}

function initPasswordStrength() {
    const newPwInput   = document.getElementById('newPassword');
    const confirmInput = document.getElementById('confirmPassword');
    if (!newPwInput || !confirmInput)             return;
    if (document.getElementById('pwStrengthWrap')) return;

    const newPwWrap    = newPwInput.closest('.pw-field-wrap') || newPwInput;
    const confirmWrap  = confirmInput.closest('.pw-field-wrap') || confirmInput;

    newPwWrap.insertAdjacentHTML('afterend', `
        <div id="pwStrengthWrap" style="margin-top:-0.35rem;margin-bottom:0.62rem">
            <div style="height:4px;background:var(--bg3);border-radius:99px;overflow:hidden;margin-bottom:0.28rem">
                <div id="pwStrengthBar"
                     style="height:100%;border-radius:99px;width:0%;transition:width 0.3s ease,background 0.3s ease">
                </div>
            </div>
            <div id="pwStrengthLabel"
                 style="font-family:'DM Mono',monospace;font-size:0.58rem;min-height:1em;transition:color 0.3s">
            </div>
        </div>
    `);

    confirmWrap.insertAdjacentHTML('afterend', `
        <div id="pwMatchIndicator"
             style="font-family:'DM Mono',monospace;font-size:0.6rem;
                    margin-top:-0.35rem;margin-bottom:0.62rem;
                    min-height:1em;transition:color 0.3s">
        </div>
    `);

    newPwInput.addEventListener('input',  updatePasswordStrength);
    confirmInput.addEventListener('input', updatePasswordMatch);
}


// ═══════════════════════════════════════════════════════
// FORMAT / ESCAPE HELPERS
// ═══════════════════════════════════════════════════════

// User-supplied text (messages, notices, request descriptions, notes) is
// always escaped before it goes into innerHTML.
function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// The server sends calendar dates as 'YYYY-MM-DD' strings built from its own
// calendar day, so they must not go through `new Date('YYYY-MM-DD')` (UTC shift).
function _fmtISO(iso) {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return '—';
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function _fmtKsh(n) {
    return `Ksh ${Number(n || 0).toLocaleString()}`;
}

// For per-day figures (fee ÷ 30) that can carry decimals
function _fmtKshDec(n) {
    return `Ksh ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function _ordinal(n) {
    n = Number(n);
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function _plural(n, one, many) { return `${n} ${Number(n) === 1 ? one : many}`; }

function _row(label, valueHtml) {
    return `<div class="info-row"><span class="info-row-label">${label}</span><span class="info-row-value">${valueHtml}</span></div>`;
}

function _card(label, inner, borderColor) {
    return `<div class="card"${borderColor ? ` style="border-color:${borderColor}"` : ''}><div class="card-label">${label}</div>${inner}</div>`;
}

function _note(text) {
    return `<div style="font-size:0.72rem;color:var(--text-dim);line-height:1.65;margin-top:0.65rem">${text}</div>`;
}

function _isMovedOut() {
    return !!(_overview && _overview.isMovedOut) || _tenant?.status === 'moved_out';
}


// ═══════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════

const SECTION_LOADERS = {
    receipts:    loadReceipts,
    messages:    loadMessages,
    notices:     loadNotices,
    maintenance: loadMyMaintenanceRequests,
    rules:       loadRules,
    stay:        loadProfile,
    deposit:     loadProfile,
    find:        loadFindHouse,
};

async function submitMaintenanceRequest() {
    if (_isMovedOut()) { showToast('Your tenancy has ended — repair requests are closed', 'warn'); return; }

    const category    = document.getElementById('maintCategory').value;
    const priority    = document.getElementById('maintPriority').value;
    const description = document.getElementById('maintDescription').value.trim();

    if (!description) { showToast('Describe the issue first', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/maintenance-requests`, {
            method: 'POST', headers: authHeaders(),
            body:   JSON.stringify({ category, priority, description })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to submit', 'error'); return; }

        showToast('Request submitted ', 'success');
        document.getElementById('maintDescription').value = '';
        await loadMyMaintenanceRequests();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

async function loadMyMaintenanceRequests() {
    try {
        const res      = await fetch(`${API}/maintenance-requests`, { headers: authHeaders() });
        const requests = await res.json();
        const el       = document.getElementById('maintRequestsList');
        if (!el) return;

        if (!res.ok || !Array.isArray(requests) || !requests.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">${ICON('maintenance',26)}</span>No requests yet</div>`;
            return;
        }

        const statusPill = {
            reported:    '<span class="pill pill-red">Reported</span>',
            in_progress: '<span class="pill pill-amber">In Progress</span>',
            completed:   '<span class="pill pill-green">Completed</span>'
        };

        el.innerHTML = requests.map(r => `
            <div class="info-item">
                <div class="info-title" style="display:flex;justify-content:space-between;align-items:center">
                    <span>${_esc(r.category)}</span>
                    ${statusPill[r.status] || _esc(r.status)}
                </div>
                <div class="info-body">${_esc(r.description)}</div>
                ${r.resolutionNote ? `<div class="info-body" style="color:var(--text-dim);margin-top:0.3rem">Note: ${_esc(r.resolutionNote)}</div>` : ''}
                <div class="info-date">${_fmtDate(r.createdAt)}</div>
            </div>`).join('');

    } catch (err) { console.error('loadMyMaintenanceRequests error:', err); }
}

function showSection(name) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    const sec = document.getElementById(`sec-${name}`);
    if (sec) sec.classList.add('active');

    document.querySelectorAll('.bnav-item').forEach(b => b.classList.remove('active'));
    const bnav = document.getElementById(`bnav-${name}`);
    if (bnav) bnav.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(d => d.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(d => {
        if (d.getAttribute('onclick')?.includes(`'${name}'`)) d.classList.add('active');
    });

    if (SECTION_LOADERS[name]) SECTION_LOADERS[name]();

    // keep the grouped navigation in step (aria-current, open group, Menu tab, phone sheet)
    // and make the header typewriter describe the page that is now showing
    if (window.TenantNav) window.TenantNav.syncToSection(name);
    if (typeof window.setSectionTyper === 'function') window.setSectionTyper(name);
}


// ═══════════════════════════════════════════════════════
// PAYMENT STATUS / TYPE HELPERS
// ═══════════════════════════════════════════════════════

function _statusPill(status) {
    switch (status) {
        case 'paid':    return `<span class="pill pill-green" style="display:inline-flex;align-items:center;gap:3px">${ICON('checkCircle',10)} Paid</span>`;
        case 'partial': return `<span class="pill pill-amber" style="display:inline-flex;align-items:center;gap:3px">${ICON('warning',10)} Partial</span>`;
        case 'failed':  return `<span class="pill pill-red" style="display:inline-flex;align-items:center;gap:3px">${ICON('errorCircle',10)} Failed</span>`;
        case 'pending': return `<span class="pill pill-amber" style="display:inline-flex;align-items:center;gap:3px">${ICON('hourglass',10)} Pending</span>`;
        case 'paused':  return `<span class="pill pill-amber" style="display:inline-flex;align-items:center;gap:3px">${ICON('door',10)} Paused</span>`;
        default:        return `<span class="pill pill-red" style="display:inline-flex;align-items:center;gap:3px">${ICON('errorCircle',10)} Unpaid</span>`;
    }
}

// Payment.category: rent | deposit | refund | holiday_hold
// Payment.refundContext: 'rent' only for mid-semester move-out refunds
function _typeLabel(p) {
    switch (p.category || 'rent') {
        case 'deposit':      return 'Deposit';
        case 'refund':       return p.refundContext === 'rent' ? 'Rent refund' : 'Deposit refund';
        case 'holiday_hold': return 'Holiday holding fee';
        default:             return 'Rent';
    }
}

function _typePill(p) {
    const cat = p.category || 'rent';
    const cls = cat === 'rent' ? 'pill-green' : cat === 'refund' ? 'pill-red' : 'pill-violet';
    return `<span class="pill ${cls}" style="font-size:0.52rem">${_esc(_typeLabel(p))}</span>`;
}

function _payBlockedMessage(ov) {
    switch (ov?.payBlockedReason) {
        case 'MOVED_OUT':                return 'Your tenancy has ended — rent payments are closed.';
        case 'NO_HOUSE':                 return 'No house assigned yet — contact your landlord.';
        case 'RENT_PAUSED':              return 'Your rent is paused while you are on holiday or between semesters.';
        case 'SEMESTER_NOT_CONFIGURED':  return 'Semester billing is not set up for your property yet — contact your landlord.';
        default:                         return 'Payments are unavailable right now.';
    }
}


// ═══════════════════════════════════════════════════════
// LOAD PROFILE, OVERVIEW & LEDGER
// ═══════════════════════════════════════════════════════

async function loadProfile() {
    if (!_tenantId) {
        const p = getPayload();
        console.error('_tenantId is null. JWT payload:', p);
        showToast('Session error — please log in again', 'error');
        setTimeout(() => { window.location.href = 'auth.html'; }, 2000);
        return;
    }

    try {
        const [profileRes, overviewRes, ledgerRes] = await Promise.all([
            fetch(`${API}/tenant/${_tenantId}`,          { headers: authHeaders() }),
            fetch(`${API}/tenant/me/overview`,           { headers: authHeaders() }),
            fetch(`${API}/payments/tenant/${_tenantId}`, { headers: authHeaders() })
        ]);

        const data = await profileRes.json();
        if (!profileRes.ok) { showToast(data.message || 'Failed to load profile', 'error'); return; }

        _tenant = data.tenant;
        _phone  = _tenant.phone;

        if (overviewRes.ok) {
            _overview = await overviewRes.json();
        } else {
            _overview = null;
            showToast('Could not load your stay details', 'warn');
        }

        let ledger = [];
        if (ledgerRes.ok) {
            const arr = await ledgerRes.json();
            if (Array.isArray(arr)) ledger = arr;
        }
        _ledger = ledger
            .filter(p => p.status === 'paid' || p.status === 'partial')
            .sort((a, b) => new Date(b.datePaid || b.createdAt) - new Date(a.datePaid || a.createdAt));

        renderHeader(data);
        renderHome(data);
        renderProfile(data);
        renderPaySection(data);
        renderSettings(data);
        renderStay();
        renderDeposit();
        applyTenancyMode();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

// Moved-out tenants keep a read-only view: no messaging, no repair requests, no rent.
function applyTenancyMode() {
    const ended = _isMovedOut();

    const input = document.getElementById('msgInput');
    const btn   = document.querySelector('.chat-input-row button');
    if (input) {
        input.disabled    = ended;
        input.placeholder = ended ? 'Messaging is closed — your tenancy has ended' : 'Type a message...';
    }
    if (btn) btn.disabled = ended;

    const maintCard = document.getElementById('maintCategory')?.closest('.card');
    if (maintCard) maintCard.style.display = ended ? 'none' : '';

    // "Find a House" is only for an active tenant who has no house yet.
    const canFind = !ended && !!_overview && !_overview.house;
    const navFind = document.getElementById('navFindHouse');
    if (navFind) navFind.classList.toggle('nav-hidden', !canFind);
    if (!canFind && document.getElementById('sec-find')?.classList.contains('active')) showSection('home');
}


// ═══════════════════════════════════════════════════════
// RENDER — HEADER
// ═══════════════════════════════════════════════════════

function renderHeader(data) {
    const t = data.tenant;
    document.getElementById('headerName').textContent = t.name.split(' ')[0];
    applyAvatar(t.name);

    const propName = t.property?.name;
    showPropertyBadge(propName || null);

    const pill = document.getElementById('headerStatus');
    if (!pill) return;

    const ov  = _overview;
    const cur = ov?.current;
    let cls = '', html = '';

    if (!ov) {
        pill.style.display = 'none';
        return;
    }

    if (ov.isMovedOut) {
        cls = 'partial'; html = `${ICON('door',11)} Moved out`;
    } else if (ov.hold) {
        cls = 'partial'; html = `${ICON('door',11)} On holiday`;
    } else if (cur && cur.rentPaused) {
        cls = 'partial'; html = `${ICON('door',11)} Rent paused`;
    } else if (cur && cur.status === 'paid') {
        cls = 'paid';    html = `${ICON('checkCircle',11)} Paid`;
    } else if (cur && cur.status === 'partial') {
        cls = 'partial'; html = `${ICON('warning',11)} Partial`;
    } else if (cur) {
        cls = 'unpaid';  html = `${ICON('errorCircle',11)} Unpaid`;
    }

    if (!html) { pill.style.display = 'none'; return; }
    pill.style.display = '';
    pill.innerHTML     = html;
    pill.className     = `status-pill ${cls}`;
}


// ═══════════════════════════════════════════════════════
// RENDER — HOME
// ═══════════════════════════════════════════════════════

function _banner(icon, color, title, text, section) {
    return `
        <div class="card" style="border-color:${color}">
            <div style="display:flex;align-items:flex-start;gap:0.75rem">
                <span style="display:flex;color:${color};flex-shrink:0;margin-top:2px">${ICON(icon,20)}</span>
                <div style="min-width:0">
                    <div style="font-weight:600;color:${color};margin-bottom:0.2rem">${_esc(title)}</div>
                    <div style="font-size:0.75rem;color:var(--text-dim);line-height:1.65">${_esc(text)}</div>
                </div>
            </div>
            ${section ? `<button class="btn btn-secondary btn-sm" style="margin-top:0.65rem" onclick="showSection('${section}')">View details</button>` : ''}
        </div>`;
}

function renderHomeBanners() {
    const el = document.getElementById('homeBanners');
    if (!el) return;
    const ov = _overview;
    if (!ov) { el.innerHTML = ''; return; }

    const parts = [];

    if (ov.isMovedOut) {
        const m = ov.movedOut || {};
        const where = [m.lastProperty?.name, m.lastHouse?.name].filter(Boolean).join(' · ');
        let text = `You moved out${m.movedOutAt ? ` on ${_fmtDate(m.movedOutAt)}` : ''}${where ? ` (${where})` : ''}. Your history, receipts and refunds stay available here.`;
        if (ov.outstandingHoldingFee > 0) text += ` A holiday holding fee of ${_fmtKsh(ov.outstandingHoldingFee)} is still unpaid.`;
        parts.push(_banner('door', 'var(--amber)', 'Tenancy ended', text, 'stay'));
    } else {
        if (ov.hold) {
            const h     = ov.hold;
            const isGap = h.kind === 'between_semesters';
            let text = isGap
                ? `Break from ${_fmtISO(h.startDateISO)} until your next semester starts on ${_fmtISO(h.expectedReturnISO)}. Rent is paused and resumes by itself on that date.`
                : `Away since ${_fmtISO(h.startDateISO)} · expected back ${_fmtISO(h.expectedReturnISO)}.`;
            if (h.overdue && !isGap) text += ` Your expected return date passed ${_plural(h.overdueDays, 'day', 'days')} ago — the holding fee keeps accruing.`;
            text += h.feeAmount > 0 ? ` Holding fee so far ${_fmtKsh(h.accrued)}, balance ${_fmtKsh(h.balance)}.` : ' No holding fee applies.';
            parts.push(_banner('door', 'var(--amber)', isGap ? 'Between semesters — room reserved' : 'You are on holiday — room reserved', text, 'stay'));
        } else if (ov.between && !ov.between.decided) {
            const b = ov.between;
            let text = `${b.prevLabel} has ended and ${b.nextLabel} starts on ${_fmtISO(b.nextStartISO)}. Your rent is paused for the ${_plural(b.days, 'day', 'days')} in between. Your landlord will confirm whether a holding fee applies.`;
            if (b.previousBalance > 0) text += ` You still owe ${_fmtKsh(b.previousBalance)} for ${b.previousLabel}.`;
            parts.push(_banner('door', 'var(--amber)', 'Between semesters — rent is paused', text, null));
        } else if (ov.outstandingHoldingFee > 0) {
            parts.push(_banner('warning', 'var(--amber)', 'Holiday holding fee unpaid',
                `${_fmtKsh(ov.outstandingHoldingFee)} is still owed from a previous holiday.`, 'stay'));
        }

        if (!ov.house) {
            parts.push(_banner('houses', 'var(--accent)', 'You don\'t have a house yet',
                'Browse the buildings of your property, pick an available house and apply. Your landlord reviews it and assigns the house.', 'find'));
        }

        if (ov.deposit?.blockingAssignment) {
            const req = ov.deposit.required;
            parts.push(_banner('cash', 'var(--amber)', 'Deposit required before a house is assigned',
                req > 0
                    ? `Your landlord must record a deposit of ${_fmtKsh(req)} before a house can be assigned to you.`
                    : 'Your landlord requires a deposit to be recorded before a house can be assigned to you.',
                'deposit'));
        }

        const cur = ov.current;
        if (cur && cur.overdue) {
            parts.push(_banner('errorCircle', 'var(--red)', 'Rent overdue',
                `${_fmtKsh(cur.balance)} for ${cur.periodLabel} was due ${_fmtISO(cur.dueDateISO)} (${_plural(Math.abs(cur.daysToDue), 'day', 'days')} ago).`,
                ov.canPayRent ? 'pay' : null));
        }
    }

    el.innerHTML = parts.join('');
}

// ── Notifications (e.g. your landlord set a holiday holding fee) ──
let _notifications = [];
async function loadNotifications() {
    try {
        const res = await fetch(`${API}/tenant/me/notifications`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        _notifications = data.notifications || [];
        renderNotifications(data.unreadCount || 0);
    } catch (err) { console.error('loadNotifications error:', err.message); }
}

function renderNotifications(unread) {
    const el = document.getElementById('notifCard');
    if (!el) return;
    if (!_notifications.length) { el.innerHTML = ''; return; }
    const rows = _notifications.slice(0, 5).map(n => `
        <div style="padding:0.7rem 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;gap:0.5rem;align-items:flex-start">
                <div style="font-weight:600;font-size:0.82rem;color:var(--text)">${!n.readAt ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-right:0.4rem"></span>' : ''}${_esc(n.title)}</div>
                <div style="font-size:0.62rem;color:var(--text-dim);white-space:nowrap">${_fmtDate(n.createdAt)}</div>
            </div>
            <div style="font-size:0.75rem;color:var(--text-dim);line-height:1.65;margin-top:0.25rem">${_esc(n.body)}</div>
        </div>`).join('');
    el.innerHTML = _card(`Notifications${unread ? ` <span class="pill pill-amber">${unread} new</span>` : ''}`,
        rows + (unread ? `<button class="btn btn-secondary btn-sm" style="margin-top:0.65rem" onclick="markNotificationsRead()">Mark all as read</button>` : ''));
}

async function markNotificationsRead() {
    try {
        await fetch(`${API}/tenant/me/notifications/read`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({}) });
        await loadNotifications();
    } catch (err) { console.error('markNotificationsRead error:', err.message); }
}

function renderHome(data) {
    const t        = data.tenant;
    const ov       = _overview;
    const propName = t.property?.name;

    const firstName  = t.name.split(' ')[0];
    const greetingEl = document.getElementById('homeGreeting');
    if (greetingEl) greetingEl.textContent = `Hey ${firstName} 👋`;

    const propNameEl = document.getElementById('homePropertyName');
    if (propNameEl) {
        if (ov?.isMovedOut) {
            const prev = ov.movedOut?.lastProperty?.name;
            propNameEl.textContent   = prev ? `Your tenancy at ${prev} has ended` : 'Your tenancy has ended';
            propNameEl.style.display = 'block';
        } else if (propName) {
            propNameEl.textContent   = `Welcome back to ${propName}`;
            propNameEl.style.display = 'block';
        } else {
            propNameEl.style.display = 'none';
        }
    }

    renderHomeBanners();
    loadNotifications();

    // ── Stats ──
    const cur = ov?.current;
    document.getElementById('statPaid').textContent = Number(data.totalPaid || 0).toLocaleString();

    const balance = cur ? cur.balance : (data.arrears || 0);
    document.getElementById('statArrears').textContent = Number(balance).toLocaleString();
    const arrearsSub = document.getElementById('statArrearsSub');
    if (arrearsSub) {
        arrearsSub.textContent = cur
            ? (cur.cycle === 'semester' ? 'Ksh this semester' : 'Ksh this month')
            : 'Ksh outstanding';
    }

    const houseName = ov?.house?.name || (t.house ? t.house.name : null);
    document.getElementById('statHouse').textContent = houseName || (ov?.isMovedOut ? '—' : 'Not assigned');
    const houseSub = document.getElementById('statHouseSub');
    if (houseSub) {
        if (ov?.isMovedOut)  houseSub.textContent = ov.movedOut?.lastHouse?.name ? `Previously: ${ov.movedOut.lastHouse.name}` : 'Moved out';
        else if (ov?.hold)   houseSub.textContent = 'Reserved while you are away';
        else                 houseSub.textContent = 'Your unit';
    }

    renderHomePeriodCard();
}

function renderHomePeriodCard() {
    const ov       = _overview;
    const cur      = ov?.current;
    const statusEl = document.getElementById('monthStatus');
    const wrap     = document.getElementById('homeProgressWrap');
    const labelEl  = document.getElementById('monthStatusLabel');
    if (!statusEl || !wrap) return;

    wrap.style.display = 'none';
    if (labelEl) labelEl.textContent = cur?.cycle === 'semester' ? 'This Semester' : 'This Month';

    if (!ov) {
        statusEl.innerHTML = `<span style="color:var(--text-dim)">Unable to load your rent status right now. Please try again shortly.</span>`;
        return;
    }
    if (ov.isMovedOut) {
        statusEl.innerHTML = `<span style="color:var(--text-dim)">Your tenancy has ended. Your payment history and receipts stay available.</span>`;
        return;
    }
    if (!cur) {
        const msg = ov.payBlockedReason === 'SEMESTER_NOT_CONFIGURED'
            ? 'Semester billing is not set up for your property yet. Contact your landlord.'
            : 'No house assigned yet. Contact your landlord.';
        statusEl.innerHTML = `<span style="color:var(--text-dim)">${msg}</span>`;
        return;
    }

    if (cur.rentPaused) {
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:0.75rem">
                <span style="display:flex;color:var(--amber)">${ICON('door',28)}</span>
                <div>
                    <div style="font-weight:600;color:var(--amber)">${_esc(cur.periodLabel)} — Rent paused</div>
                    <div style="font-size:0.72rem;color:var(--text-dim);font-family:'DM Mono',monospace">${cur.cycle === 'monthly' ? 'Your holiday began before this rent cycle, so no rent is charged for it. A holding fee applies instead.' : 'Your holiday began before this semester, so no semester rent is charged. A holding fee applies instead.'}</div>
                </div>
            </div>`;
        return;
    }

    wrap.style.display = 'block';
    const isSem = cur.cycle === 'semester';
    const pct   = cur.amountDue > 0 ? Math.min(100, Math.round((cur.paid / cur.amountDue) * 100)) : 0;

    document.getElementById('homePaidLabel').textContent    = `Paid: ${_fmtKsh(cur.paid)}`;
    document.getElementById('homeRentLabel').textContent    = `${isSem ? 'Due' : 'Rent'}: ${_fmtKsh(cur.amountDue)}`;
    document.getElementById('homeBalanceLabel').textContent = _fmtKsh(cur.balance);

    const bar = document.getElementById('homeProgressBar');
    bar.style.width = `${pct}%`;
    bar.className   = `pay-progress-fill ${cur.status === 'paid' ? 'status-paid' : cur.status === 'partial' ? 'status-partial' : 'status-unpaid'}`;

    const period = _esc(cur.periodLabel);
    const dueLine = cur.status === 'paid' ? '' : ` · due ${_fmtISO(cur.dueDateISO)}`;

    if (cur.status === 'paid') {
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:0.75rem">
                <span style="display:flex;color:var(--green)">${ICON('checkCircle',28)}</span>
                <div>
                    <div style="font-weight:600;color:var(--green)">${period} — Fully Paid</div>
                    <div style="font-size:0.72rem;color:var(--text-dim);font-family:'DM Mono',monospace">${_fmtKsh(cur.paid)} received · balance Ksh 0</div>
                </div>
            </div>`;
    } else if (cur.status === 'partial') {
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:0.75rem">
                <span style="display:flex;color:var(--amber)">${ICON('warning',28)}</span>
                <div>
                    <div style="font-weight:600;color:var(--amber)">${period} — Partially Paid</div>
                    <div style="font-size:0.72rem;color:var(--text-dim);font-family:'DM Mono',monospace">${_fmtKsh(cur.paid)} paid · ${_fmtKsh(cur.balance)} remaining${dueLine}</div>
                </div>
            </div>`;
    } else {
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:0.75rem">
                <span style="display:flex;color:var(--red)">${ICON('errorCircle',28)}</span>
                <div>
                    <div style="font-weight:600;color:var(--red)">${period} — Not Paid</div>
                    <div style="font-size:0.72rem;color:var(--text-dim);font-family:'DM Mono',monospace">${_fmtKsh(cur.amountDue)} due${dueLine}</div>
                </div>
            </div>`;
    }
}


// ═══════════════════════════════════════════════════════
// RENDER — PROFILE
// ═══════════════════════════════════════════════════════

// One ledger row, as shown in the profile "Payment History" table
function _ledgerTableRow(p) {
    const cat      = p.category || 'rent';
    const hasTotals = cat === 'rent' || cat === 'holiday_hold';
    const amount   = cat === 'refund' ? `− ${_fmtKsh(p.amount)}` : _fmtKsh(p.amount);
    return `
        <tr>
            <td>${_esc(p.month)}<br>${_typePill(p)}</td>
            <td class="td-mono">${amount}</td>
            <td class="td-mono">${hasTotals ? _fmtKsh(p.totalPaid) : '—'}</td>
            <td class="td-mono" style="color:${hasTotals ? (p.balance > 0 ? 'var(--amber)' : 'var(--green)') : 'var(--text-dim)'}">
                ${hasTotals ? _fmtKsh(p.balance) : '—'}
            </td>
            <td>${_statusPill(p.status)}</td>
            <td class="td-mono">${_fmtDate(p.datePaid)}</td>
        </tr>`;
}

function _ensureInfoRowAfter(anchorId, rowId, labelHtml) {
    let row = document.getElementById(rowId);
    if (!row) {
        row = document.createElement('div');
        row.id        = rowId;
        row.className = 'info-row';
        const anchorRow = document.getElementById(anchorId)?.closest('.info-row');
        if (anchorRow) anchorRow.insertAdjacentElement('afterend', row);
    }
    return row;
}

// ── Stay progress — how much of the current rental period has passed. The colour follows how close the
//    due/end date is: normal → warning (7 days or less) → urgent (due today or overdue). ──
function renderStayProgress(stay) {
    const el = document.getElementById('stayProgressCard');
    if (!el) return;
    if (!stay) { el.innerHTML = ''; return; }

    const d = stay.daysRemaining;
    const remaining = d > 1 ? `${_plural(d, 'day', 'days')} remaining`
                    : d === 1 ? '1 day remaining'
                    : d === 0 ? 'Due today'
                    : `${_plural(-d, 'day', 'days')} overdue`;
    const tone = stay.level === 'urgent' ? 'var(--red)' : stay.level === 'warn' ? 'var(--amber)' : 'var(--text-muted)';

    el.innerHTML = _card('Stay Progress', `
        <div class="pay-progress-wrap" style="margin-top:0.25rem">
            <div class="pay-progress-labels">
                <span>${_fmtISO(stay.startISO)}</span>
                <span>${_fmtISO(stay.endISO)}</span>
            </div>
            <div class="pay-progress-track" role="progressbar" aria-label="Stay progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${stay.percent}">
                <div class="pay-progress-fill stay-${stay.level}" style="width:${stay.percent}%"></div>
            </div>
        </div>
        <div class="pay-status-row">
            <span class="label">${stay.isOverride ? 'Date adjusted by your landlord' : _esc(stay.label || 'Current period')}</span>
            <span class="value" style="color:${tone};font-weight:600">${remaining}</span>
        </div>`);
}

function renderProfile(data) {
    const t   = data.tenant;
    const ov  = _overview;
    const cur = ov?.current;

    document.getElementById('profileName').textContent  = t.name;
    document.getElementById('profileEmail').textContent = t.email;
    document.getElementById('profilePhone').textContent = t.phone || '—';

    const houseName = ov?.house?.name || (t.house ? t.house.name : null);
    document.getElementById('profileHouse').textContent = houseName || (ov?.isMovedOut ? 'Moved out' : 'Not assigned');

    // Rent + due-date rows follow the billing cycle the server reports
    const rentLabelEl = document.getElementById('profileRent')?.closest('.info-row')?.querySelector('.info-row-label');
    const rentEl      = document.getElementById('profileRent');
    const dueLabelEl  = document.getElementById('profileDue')?.closest('.info-row')?.querySelector('.info-row-label');
    const dueEl       = document.getElementById('profileDue');

    if (cur && cur.cycle === 'semester') {
        if (rentLabelEl) rentLabelEl.textContent = 'Semester Rent';
        if (dueLabelEl)  dueLabelEl.textContent  = 'Due Date';
        rentEl.textContent = cur.rentPaused
            ? 'Paused (on holiday)'
            : `${_fmtKsh(cur.baseAmountDue)} / semester${cur.extensionCharge > 0 ? ` + ${_fmtKsh(cur.extensionCharge)} extension` : ''}`;
        dueEl.textContent  = cur.rentPaused ? '—' : _fmtISO(cur.dueDateISO);
    } else if (cur) {
        if (rentLabelEl) rentLabelEl.textContent = 'Monthly Rent';
        if (dueLabelEl)  dueLabelEl.textContent  = 'Due Date';
        rentEl.textContent = `${_fmtKsh(cur.amountDue)} / month`;
        // Rent cycles start the day a tenant is housed, so the due date is a real date; older tenants keep "Nth of each month"
        dueEl.textContent  = cur.anniversary ? _fmtISO(cur.dueDateISO) : `${_ordinal(cur.dueDay)} of each month`;
    } else {
        rentEl.textContent = '—';
        dueEl.textContent  = '—';
    }

    renderStayProgress(ov?.stay);

    document.getElementById('profileSince').textContent = _fmtDate(t.createdAt);
    document.getElementById('profileTotalPaid').textContent = _fmtKsh(data.totalPaid);

    // ── In-house-since row (server's assignedAt) ──
    const assignedRow = _ensureInfoRowAfter('profileSince', 'profileAssignedRow');
    assignedRow.innerHTML = `
        <span class="info-row-label">In House Since</span>
        <span class="info-row-value">${ov?.assignedAt && !ov.isMovedOut ? _fmtDate(ov.assignedAt) : '—'}</span>`;

    // ── Property row ──
    const propName = t.property?.name;
    const propLoc  = t.property?.location;
    const propRow  = _ensureInfoRowAfter('profileHouse', 'profilePropertyRow');
    propRow.innerHTML = `
        <span class="info-row-label">Property</span>
        <span class="info-row-value" style="color:var(--accent);font-family:'DM Mono',monospace;font-size:0.72rem;display:inline-flex;align-items:center;gap:4px">
            ${ICON('properties',11)} ${_esc(propName || '—')}${propLoc ? ` <span style="color:var(--text-dim)">· ${_esc(propLoc)}</span>` : ''}
        </span>`;

    // ── Payment history — every category, typed ──
    const tbody = document.getElementById('payHistoryTable');
    if (!_ledger.length) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No payments recorded yet</div></td></tr>`;
        return;
    }
    tbody.innerHTML = _ledger.map(_ledgerTableRow).join('');
}


// ═══════════════════════════════════════════════════════
// RENDER — PAY SECTION
// ═══════════════════════════════════════════════════════

function renderPaySection(data) {
    const t         = data.tenant;
    const ov        = _overview;
    const cur       = ov?.current;
    const summaryEl = document.getElementById('rentSummary');
    const formCard  = document.getElementById('payFormCard');
    const wrap      = document.getElementById('payProgressWrap');
    const labelEl   = document.getElementById('rentSummaryLabel');
    const monthInp  = document.getElementById('payMonth');
    const amtInp    = document.getElementById('payAmount');

    if (wrap) wrap.style.display = 'none';

    if (!ov) {
        summaryEl.innerHTML = `<span style="color:var(--text-dim)">Unable to load your rent details right now.</span>`;
        if (formCard) formCard.style.display = 'none';
        return;
    }

    // Blocked: moved out / no house / paused semester / semester not configured
    if (!ov.canPayRent) {
        if (labelEl) labelEl.textContent = 'Rent';
        summaryEl.innerHTML = `<span style="color:var(--text-dim)">${_esc(_payBlockedMessage(ov))}</span>`;
        if (formCard) formCard.style.display = 'none';
        return;
    }

    if (formCard) formCard.style.display = '';
    const isSem = cur.cycle === 'semester';
    if (labelEl) labelEl.textContent = isSem ? 'Current Semester Status' : 'Current Month Status';

    // Semester: the period is locked to the server's period (the server overwrites it anyway).
    // Monthly: free-typed month, as before.
    if (isSem) {
        monthInp.value    = cur.periodLabel;
        monthInp.readOnly = true;
        monthInp.title    = 'Semester billing — the period is set automatically';
    } else {
        monthInp.readOnly = false;
        monthInp.title    = '';
        monthInp.value    = cur.periodLabel;
    }
    amtInp.value = cur.balance > 0 ? cur.balance : '';

    const rows = [];
    rows.push(_row('Property', `<span style="color:var(--accent);display:inline-flex;align-items:center;gap:4px">${ICON('properties',11)} ${_esc(t.property?.name || '—')}</span>`));
    rows.push(_row('House', _esc(ov.house?.name || '—')));

    if (isSem) {
        rows.push(_row('Period', _esc(cur.periodLabel)));
        rows.push(_row('Stay ends', `${_fmtISO(cur.effectiveEndISO)}${cur.extensionDays ? ` (+${_plural(cur.extensionDays, 'day', 'days')})` : ''}`));
        rows.push(_row('Amount due', `<span style="color:var(--accent)">${_fmtKsh(cur.amountDue)}</span>`));
        if (cur.extensionCharge > 0) rows.push(_row('Includes extension', _fmtKsh(cur.extensionCharge)));
        if (cur.baseAmountDue < cur.fullSemesterRent) rows.push(_row('Set below full rent', `${_fmtKsh(cur.baseAmountDue)} of ${_fmtKsh(cur.fullSemesterRent)}`));
    } else {
        rows.push(_row('Monthly Rent', `<span style="color:var(--accent)">${_fmtKsh(cur.amountDue)}</span>`));
    }
    rows.push(_row('Paid', _fmtKsh(cur.paid)));
    rows.push(_row('Balance Remaining', `<span style="color:${cur.balance > 0 ? 'var(--amber)' : 'var(--green)'}">${_fmtKsh(cur.balance)}</span>`));
    rows.push(_row('Due date', _fmtISO(cur.dueDateISO)));
    rows.push(_row(_esc(cur.periodLabel), _statusPill(cur.status)));

    summaryEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:0.1rem">${rows.join('')}</div>`;

    if (wrap) {
        wrap.style.display = 'block';
        const pct = cur.amountDue > 0 ? Math.min(100, Math.round((cur.paid / cur.amountDue) * 100)) : 0;
        document.getElementById('payPaidLabel').textContent    = `Paid: ${_fmtKsh(cur.paid)}`;
        document.getElementById('payRentLabel').textContent    = `${isSem ? 'Due' : 'Rent'}: ${_fmtKsh(cur.amountDue)}`;
        document.getElementById('payBalanceLabel').textContent = _fmtKsh(cur.balance);
        const bar = document.getElementById('payProgressBar');
        bar.style.width = `${pct}%`;
        bar.className   = `pay-progress-fill ${cur.status === 'paid' ? 'status-paid' : cur.status === 'partial' ? 'status-partial' : 'status-unpaid'}`;
    }
}


// ═══════════════════════════════════════════════════════
// RENDER — STAY (period, academic year, holiday)
// ═══════════════════════════════════════════════════════

function _dueText(cur) {
    const date = _fmtISO(cur.dueDateISO);
    if (cur.status === 'paid' || cur.balance <= 0) return date;
    if (cur.daysToDue < 0)  return `${date} · <span style="color:var(--red)">${_plural(Math.abs(cur.daysToDue), 'day', 'days')} overdue</span>`;
    if (cur.daysToDue === 0) return `${date} · due today`;
    return `${date} · in ${_plural(cur.daysToDue, 'day', 'days')}`;
}

function _periodCardHtml(cur) {
    if (cur.cycle === 'semester') {
        const rows = [];
        rows.push(_row('Semester', _esc(cur.semesterLabel)));
        rows.push(_row('Period', _esc(cur.periodLabel)));
        rows.push(_row('Starts', `${_fmtISO(cur.startISO)}${cur.notStarted ? ` · in ${_plural(cur.daysToStart, 'day', 'days')}` : ''}`));

        let endText = _fmtISO(cur.effectiveEndISO);
        if (cur.extensionDays > 0) endText += ` (+${_plural(cur.extensionDays, 'day', 'days')})`;
        if (!cur.notStarted) endText += cur.daysToEnd >= 0 ? ` · ${_plural(cur.daysToEnd, 'day', 'days')} left` : ' · ended';
        rows.push(_row('Stay ends', endText));

        rows.push(_row('Full semester rent', _fmtKsh(cur.fullSemesterRent)));
        rows.push(_row('Your amount due', cur.rentPaused ? 'Paused' : `<span style="color:var(--accent)">${_fmtKsh(cur.amountDue)}</span>`));
        if (cur.extensionDays > 0) {
            rows.push(_row('Extension charge', `${_fmtKsh(cur.extensionCharge)} (${_fmtKsh(Math.ceil(cur.dailyRate))} per extra day)`));
        }
        rows.push(_row('Paid', _fmtKsh(cur.paid)));
        rows.push(_row('Balance', `<span style="color:${cur.balance > 0 ? 'var(--amber)' : 'var(--green)'}">${_fmtKsh(cur.balance)}</span>`));
        if (!cur.rentPaused) rows.push(_row('Due date', _dueText(cur)));
        rows.push(_row('Status', _statusPill(cur.status)));

        let notes = '';
        if (cur.rentPaused) {
            notes += _note('Your holiday began before this semester started, so no semester rent is charged for it. The holiday holding fee applies instead (see below).');
        } else if (cur.baseAmountDue < cur.fullSemesterRent) {
            notes += _note(`Your landlord set your amount for this period at ${_fmtKsh(cur.baseAmountDue)}, lower than the full semester rent of ${_fmtKsh(cur.fullSemesterRent)}.`);
        }
        return _card('Current Semester', rows.join('') + notes);
    }

    const rows = [];
    rows.push(_row('Period', _esc(cur.periodLabel)));
    rows.push(_row('Monthly rent', cur.rentPaused ? 'Paused' : `<span style="color:var(--accent)">${_fmtKsh(cur.amountDue)}</span>`));
    rows.push(_row('Paid', _fmtKsh(cur.paid)));
    rows.push(_row('Balance', `<span style="color:${cur.balance > 0 ? 'var(--amber)' : 'var(--green)'}">${_fmtKsh(cur.balance)}</span>`));
    if (cur.anniversary) rows.push(_row('Rent period', `${_fmtISO(cur.startISO)} – ${_fmtISO(cur.endISO)}`));
    if (!cur.rentPaused) rows.push(_row('Due date', cur.anniversary ? _dueText(cur) : `${_ordinal(cur.dueDay)} of each month · ${_dueText(cur)}`));
    rows.push(_row('Status', cur.rentPaused ? '<span class="pill pill-amber">Rent paused</span>' : _statusPill(cur.status)));
    return _card('Current Month', rows.join('') + (cur.rentPaused ? _note('Your holiday began before this rent cycle, so no rent is charged for it. The holiday holding fee applies instead (see below). Your rent cycle starts again the day you return.') : ''));
}

function _yearCardHtml(ay) {
    const chips = ay.semesters.map(s => `
        <span class="pill ${s.current ? 'pill-violet' : (s.completed ? 'pill-green' : 'pill-amber')}" style="margin:0 0.3rem 0.35rem 0">
            ${_esc(s.label)} · ${_fmtISO(s.startISO)} – ${_fmtISO(s.endISO)}${s.completed ? ' ' + ICON('check',10) : ''}
        </span>`).join('');

    const progress = ay.expectedSemesterCount
        ? `${ay.semestersCompleted} of ${ay.expectedSemesterCount} expected semester${ay.expectedSemesterCount === 1 ? '' : 's'} completed`
        : 'Your landlord has not set how many semesters you will stay this academic year.';

    let extra = '';
    if (ay.complete) extra = _note('You have completed the stay your landlord recorded for this academic year.');

    return _card(`Academic Year ${_esc(ay.label)}`,
        `<div style="margin-bottom:0.5rem">${chips}</div>
         <div style="font-size:0.78rem;color:var(--text-muted)">${_esc(progress)}</div>${extra}`);
}

function _holdCardHtml(ov) {
    const h = ov.hold;

    if (!h) {
        if (ov.billingCycle !== 'semester') return '';       // monthly tenants see this card once a holiday is recorded
        return _card('Holiday',
            `<div style="font-size:0.8rem;color:var(--text-muted)">You are not on holiday.</div>` +
            _note('If you go away but keep your room, your landlord can record a holiday for you. Semester rent is paused for any semester that starts while you are away, and a holding fee applies instead.'));
    }

    const rows = [];
    const isGapHold = h.kind === 'between_semesters';
    rows.push(_row('Status', `<span class="pill pill-amber">${isGapHold ? 'Between semesters — room reserved' : 'On holiday — room reserved'}</span>`));
    rows.push(_row(isGapHold ? 'Break started' : 'Away since', _fmtISO(h.startDateISO)));
    rows.push(_row(isGapHold ? 'Next semester starts' : 'Expected back', _fmtISO(h.expectedReturnISO)));
    if (h.overdue && !isGapHold) rows.push(_row('Return overdue', `<span style="color:var(--red)">${_plural(h.overdueDays, 'day', 'days')}</span>`));
    rows.push(_row('Days away', String(h.daysAway)));
    rows.push(_row('Holding fee', `${_fmtKsh(h.feeAmount)} / month`));
    rows.push(_row('Per day', `${_fmtKshDec(h.feePerDay)} (fee ÷ 30)`));
    rows.push(_row('Accrued so far', _fmtKsh(h.accrued)));
    rows.push(_row('Paid', _fmtKsh(h.paid)));
    rows.push(_row('Balance', `<span style="color:${h.balance > 0 ? 'var(--amber)' : 'var(--green)'}">${_fmtKsh(h.balance)}</span>`));

    let notes = _note('The holding fee is the days you are away × the monthly fee ÷ 30, rounded up. The day you leave counts; the day you return does not. If you return earlier or later than expected, the fee adjusts to the days you were actually away.');
    if (isGapHold) {
        notes += _note('This break ends on its own when your next semester starts — you do not need to do anything. Rent resumes from that day.');
    } else if (ov.current?.rentPaused) {
        notes += _note(ov.current.cycle === 'monthly'
            ? 'Rent is paused because your holiday began before the current rent cycle started. Your rent cycle starts again the day you return.'
            : 'Rent for the current semester is paused because your holiday began before it started. Semester rent resumes when you return.');
    } else if (ov.current?.cycle === 'semester') {
        notes += _note('Your holiday began after the current semester started, so that semester\'s rent stays due as normal.');
    } else if (ov.current?.cycle === 'monthly') {
        notes += _note('Your holiday began after the current rent cycle started, so that cycle\'s rent stays due as normal.');
    }
    notes += _note('Holding fees are recorded by your landlord — pay them directly and they will record the payment here.');

    return _card(isGapHold ? 'Between Semesters' : 'Holiday', rows.join('') + notes, (h.overdue && !isGapHold) ? 'var(--red)' : 'var(--amber)');
}

function _holdHistoryHtml(ov) {
    const past = (ov.holds || []).filter(h => h.status !== 'active');
    if (!past.length) return '';

    const items = past.map(h => {
        const statusText = h.status === 'ended' ? 'Ended — moved out' : 'Returned';
        const range = `${_fmtISO(h.startDateISO)} → ${_fmtISO(h.actualReturnISO || h.endedISO || h.expectedReturnISO)}`;
        return `
            <div class="info-item">
                <div class="info-title" style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem">
                    <span>${range}</span>
                    ${h.balance > 0 ? `<span class="pill pill-amber">${_fmtKsh(h.balance)} unpaid</span>` : '<span class="pill pill-green">Settled</span>'}
                </div>
                <div class="info-body">
                    ${statusText} · ${_plural(h.daysAway, 'day', 'days')} away · fee ${_fmtKsh(h.feeAmount)} / month ·
                    accrued ${_fmtKsh(h.accrued)} · paid ${_fmtKsh(h.paid)}
                </div>
            </div>`;
    }).join('');

    return _card('Holiday History', items);
}

function renderStay() {
    const el = document.getElementById('stayContent');
    if (!el) return;
    const ov = _overview;

    if (!ov) {
        el.innerHTML = _card('Stay', `<div class="empty-state">Unable to load your stay details right now.</div>`);
        return;
    }

    let html = '';

    if (ov.isMovedOut) {
        const m = ov.movedOut || {};
        const rows = [];
        rows.push(_row('Property', _esc([m.lastProperty?.name, m.lastProperty?.location].filter(Boolean).join(' · ') || '—')));
        rows.push(_row('House', _esc(m.lastHouse?.name || '—')));
        rows.push(_row('Moved out', m.movedOutAt ? _fmtDate(m.movedOutAt) : '—'));
        html += _card('Tenancy Ended', rows.join('') + _note('Your login and payment history are kept, so you can still view your receipts and refunds.'), 'var(--amber)');
    } else if (!ov.current) {
        const msg = ov.payBlockedReason === 'SEMESTER_NOT_CONFIGURED'
            ? 'Semester billing is not set up for your property yet. Contact your landlord.'
            : 'No house has been assigned to you yet.';
        html += _card('Current Stay', `<div style="font-size:0.8rem;color:var(--text-muted)">${msg}</div>`);
    } else {
        html += _periodCardHtml(ov.current);
    }

    if (ov.academicYear) html += _yearCardHtml(ov.academicYear);

    html += _holdCardHtml(ov);
    html += _holdHistoryHtml(ov);

    el.innerHTML = html;
}


// ═══════════════════════════════════════════════════════
// RENDER — DEPOSIT
// ═══════════════════════════════════════════════════════

function renderDeposit() {
    const el = document.getElementById('depositContent');
    if (!el) return;
    const ov = _overview;

    if (!ov) {
        el.innerHTML = _card('Deposit', `<div class="empty-state">Unable to load your deposit details right now.</div>`);
        return;
    }

    const d = ov.deposit;
    const rows = [];
    let statusPill, note = '';

    if (d.status === 'paid' && d.paidForThisProperty) {
        statusPill = `<span class="pill pill-green" style="display:inline-flex;align-items:center;gap:3px">${ICON('checkCircle',10)} Paid in full</span>`;
    } else if (d.status === 'paid') {
        statusPill = `<span class="pill pill-amber">Paid for a different property</span>`;
        note = 'This deposit was recorded against another property. Your landlord will record a new deposit here if one is required.';
    } else if (d.status === 'partial') {
        statusPill = `<span class="pill pill-amber" style="display:inline-flex;align-items:center;gap:3px">${ICON('warning',10)} Partial</span>`;
        note = `A deposit must be paid in full${d.required > 0 ? ` (${_fmtKsh(d.required)})` : ''}. Contact your landlord to complete it.`;
    } else if (d.status === 'refunded') {
        statusPill = `<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)">Refunded</span>`;
        note = 'Your deposit was refunded. If you are assigned a house again, a new deposit may be required.';
    } else {
        statusPill = `<span class="pill pill-red">Not recorded</span>`;
        if (d.blockingAssignment) {
            note = d.required > 0
                ? `A deposit of ${_fmtKsh(d.required)} must be recorded by your landlord before a house can be assigned to you.`
                : 'Your landlord requires a deposit to be recorded before a house can be assigned to you.';
        }
    }

    rows.push(_row('Status', statusPill));
    if (d.required > 0) rows.push(_row('Required deposit', _fmtKsh(d.required)));
    rows.push(_row('Required before assignment', d.requiredBeforeAssignment ? 'Yes' : 'No'));
    if (d.status === 'paid' || d.status === 'partial') rows.push(_row('Amount recorded', _fmtKsh(d.amountPaid)));
    if (d.paidAt && d.status === 'paid') rows.push(_row('Paid on', _fmtDate(d.paidAt)));

    let html = _card('Security Deposit',
        rows.join('') +
        (note ? _note(_esc(note)) : '') +
        _note('Deposits and deposit refunds are recorded by your landlord. They cannot be paid through M-Pesa here.'));

    // Deposit + deposit-refund transactions
    const txns = _ledger.filter(p => p.category === 'deposit' || (p.category === 'refund' && p.refundContext !== 'rent'));
    if (txns.length) {
        html += _card('Deposit Transactions', txns.map(p => `
            <div class="info-item" style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem">
                <div style="flex:1;min-width:0">
                    <div class="info-title">${_esc(_typeLabel(p))}</div>
                    <div class="info-date" style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:0.2rem">
                        <span>${p.category === 'refund' ? 'Refunded' : 'Paid'}: ${_fmtKsh(p.amount)}</span>
                        <span>${_fmtDate(p.datePaid)}</span>
                        <span>${_esc(p.method || '')}</span>
                    </div>
                    ${p.note ? `<div class="info-date">${_esc(p.note)}</div>` : ''}
                </div>
                <button class="btn btn-secondary btn-sm" onclick="downloadPDF('${p._id}')">${ICON('file',14)} PDF</button>
            </div>`).join(''));
    }

    el.innerHTML = html;
}


// ═══════════════════════════════════════════════════════
// RENDER — SETTINGS
// ═══════════════════════════════════════════════════════

function renderSettings(data) {
    const t = data.tenant;
    document.getElementById('settingsName').textContent  = t.name;
    document.getElementById('settingsEmail').textContent = t.email;
    document.getElementById('settingsPhone').textContent = t.phone || '—';

    const propName = t.property?.name;
    const propLoc  = t.property?.location;

    const settingsPropRow = _ensureInfoRowAfter('settingsPhone', 'settingsPropertyRow');
    settingsPropRow.innerHTML = `
        <span class="info-row-label">Property</span>
        <span class="info-row-value" style="color:var(--accent);font-family:'DM Mono',monospace;font-size:0.72rem;display:inline-flex;align-items:center;gap:4px">
            ${ICON('properties',11)} ${_esc(propName || '—')}${propLoc ? ` <span style="color:var(--text-dim)">· ${_esc(propLoc)}</span>` : ''}
        </span>`;
}


// ═══════════════════════════════════════════════════════
// CHECK MONTH BALANCE (monthly tenants only)
// ═══════════════════════════════════════════════════════

async function checkMonthBalance() {
    // Semester tenants: the period is locked to the server's period and every
    // figure is already rendered from the overview — nothing to look up.
    if (_overview?.current?.cycle === 'semester') return;

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
        const rent = data.rentAmount || 0;

        document.getElementById('payAmount').value = data.balance > 0 ? data.balance : '';

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

        const summaryEl = document.getElementById('rentSummary');
        if (summaryEl) {
            summaryEl.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:0.1rem">
                    ${_row('Month', _esc(month))}
                    ${_row('Rent', `<span style="color:var(--accent)">${_fmtKsh(rent)}</span>`)}
                    ${_row('Paid', _fmtKsh(data.totalPaid))}
                    ${_row('Balance', `<span style="color:${data.balance > 0 ? 'var(--amber)' : 'var(--green)'}">${_fmtKsh(data.balance)}</span>`)}
                    ${_row('Status', _statusPill(data.status))}
                </div>`;
        }

    } catch (err) {
        console.error('checkMonthBalance error:', err);
    }
}


// ═══════════════════════════════════════════════════════
// M-PESA PAYMENT
// ═══════════════════════════════════════════════════════

async function payWithMpesa() {
    const ov = _overview;
    if (!ov || !ov.canPayRent || !ov.current) {
        showToast(_payBlockedMessage(ov), 'warn');
        return;
    }

    const cur    = ov.current;
    const isSem  = cur.cycle === 'semester';
    const amount = document.getElementById('payAmount').value;
    const month  = isSem ? cur.periodLabel : document.getElementById('payMonth').value.trim();

    if (!amount || !month) { showToast('Enter amount and month', 'warn'); return; }
    if (!_phone)            { showToast('No phone number on your account', 'error'); return; }

    // Pre-check only for the period the server already told us about;
    // the server re-validates everything (paid / overpayment / paused).
    if (month === cur.periodLabel && cur.status === 'paid') {
        showToast(`${month} is already fully paid `, 'warn');
        return;
    }

    const btn = document.querySelector('.mpesa-btn');
    btn.disabled  = true;
    btn.innerHTML = `${ICON('hourglass',14)} Sending prompt...`;

    try {
        const res  = await fetch(`${API}/stkpush`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ amount: Number(amount), month })
        });
        const data = await res.json();

        btn.disabled  = false;
        btn.innerHTML = `${ICON('phone',14)} Pay with M-Pesa`;

        if (!res.ok) {
            showToast(data.message || data.error || 'M-Pesa request failed', 'error');
            renderPayStatus('failed', { reason: data.message });
            if (data.code === 'RENT_PAUSED' || data.code === 'TENANCY_ENDED') loadProfile();
            return;
        }

        renderPayStatus('waiting', { phone: _phone, amount, month });
        pollPaymentStatus(data.checkoutRequestId, month);

    } catch (err) {
        btn.disabled  = false;
        btn.innerHTML = `${ICON('phone',14)} Pay with M-Pesa`;
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
                showToast('Payment confirmed ', 'success');
                await loadProfile();
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
                showToast(`${month} is already paid `, 'warn');
                return;
            }

            if (data.status === 'timeout') {
                clearInterval(interval);
                renderPayStatus('timeout', {});
                showToast('Payment timed out. Try again.', 'warn');
                return;
            }

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
                <div style="display:flex;justify-content:center;margin-bottom:0.5rem;animation:spin 1.5s linear infinite;color:var(--amber)">${ICON('hourglass',32)}</div>
                <div style="font-weight:600;color:var(--amber);margin-bottom:0.3rem">Waiting for payment...</div>
                <div style="font-size:0.75rem;color:var(--text-dim);font-family:'DM Mono',monospace">
                    Check <strong style="color:var(--text)">${_esc(data.phone || '')}</strong> for the M-Pesa prompt
                </div>
                ${data.secondsLeft ? `<div style="font-size:0.68rem;color:var(--text-dim);margin-top:0.4rem">Timing out in ~${data.secondsLeft}s</div>` : ''}
            </div>`,

        confirmed: `
            <div class="card" style="border-color:rgba(52,211,153,0.35);margin-top:1rem;text-align:center;padding:1.5rem 1rem">
                <div style="display:flex;justify-content:center;margin-bottom:0.5rem;color:var(--green)">${ICON('checkCircle',40)}</div>
                <div style="font-weight:600;color:var(--green);margin-bottom:0.5rem">Payment Confirmed!</div>
                ${data.mpesaCode ? `<div style="font-family:'DM Mono',monospace;font-size:0.72rem;color:var(--text-dim)">M-Pesa Code: <strong style="color:var(--text)">${_esc(data.mpesaCode)}</strong></div>` : ''}
                ${data.month     ? `<div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.2rem">${_esc(data.month)} — Payment recorded</div>` : ''}
                <div style="margin-top:1rem;display:flex;gap:0.5rem;justify-content:center">
                    ${data.paymentId ? `<button class="btn btn-secondary btn-sm" onclick="downloadPDF('${data.paymentId}')">${ICON('file',14)} Download Receipt</button>` : ''}
                    <button class="btn btn-primary btn-sm" onclick="showSection('receipts')">View All Receipts</button>
                </div>
            </div>`,

        failed: `
            <div class="card" style="border-color:rgba(248,113,113,0.35);margin-top:1rem;text-align:center;padding:1.5rem 1rem">
                <div style="display:flex;justify-content:center;margin-bottom:0.5rem;color:var(--red)">${ICON('errorCircle',32)}</div>
                <div style="font-weight:600;color:var(--red);margin-bottom:0.3rem">Payment Failed</div>
                <div style="font-size:0.75rem;color:var(--text-dim)">${_esc(data.reason || 'The payment was not completed. Please try again.')}</div>
            </div>`,

        timeout: `
            <div class="card" style="border-color:rgba(251,191,36,0.25);margin-top:1rem;text-align:center;padding:1.5rem 1rem">
                <div style="display:flex;justify-content:center;margin-bottom:0.5rem;color:var(--amber)">${ICON('clock',32)}</div>
                <div style="font-weight:600;color:var(--amber);margin-bottom:0.3rem">Request Timed Out</div>
                <div style="font-size:0.75rem;color:var(--text-dim)">If you entered your PIN, check your receipts in a few minutes. Otherwise try again.</div>
                <button class="btn btn-secondary btn-sm" onclick="showSection('receipts')" style="margin-top:0.75rem;width:auto">Check Receipts</button>
            </div>`
    };

    el.innerHTML = states[status] || '';
}


// ═══════════════════════════════════════════════════════
// RECEIPTS — typed and grouped
// ═══════════════════════════════════════════════════════

function _receiptRow(p) {
    const cat = p.category || 'rent';
    let title, details;

    if (cat === 'deposit') {
        title   = 'Deposit';
        details = `<span>Paid: ${_fmtKsh(p.amount)}</span><span>${_fmtDate(p.datePaid)}</span>`;
    } else if (cat === 'refund') {
        title   = p.refundContext === 'rent' ? `Rent refund — ${_esc(p.month)}` : 'Deposit refund';
        details = `<span>Refunded: ${_fmtKsh(p.amount)}</span><span>${_fmtDate(p.datePaid)}</span>`;
    } else if (cat === 'holiday_hold') {
        title   = 'Holiday holding fee';
        details = `<span>Paid: ${_fmtKsh(p.amount)}</span>
                   <span>Fees paid: ${_fmtKsh(p.totalPaid)}</span>
                   <span style="color:${p.balance > 0 ? 'var(--amber)' : 'var(--green)'}">Bal: ${_fmtKsh(p.balance)}</span>
                   <span>${_fmtDate(p.datePaid)}</span>`;
    } else {
        title   = _esc(p.month);
        details = `<span>Paid: ${_fmtKsh(p.amount)}</span>
                   <span>Total: ${_fmtKsh(p.totalPaid)}</span>
                   <span style="color:${p.balance > 0 ? 'var(--amber)' : 'var(--green)'}">Bal: ${_fmtKsh(p.balance)}</span>
                   <span>${_fmtDate(p.datePaid)}</span>
                   ${p.mpesaCode ? `<span style="font-family:'DM Mono',monospace">${_esc(p.mpesaCode)}</span>` : ''}`;
    }

    return `
        <div class="info-item" style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem">
            <div style="flex:1;min-width:0">
                <div class="info-title">${title}</div>
                <div class="info-date" style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:0.2rem">${details}</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.35rem;flex-shrink:0">
                ${cat === 'refund' ? _typePill(p) : _statusPill(p.status)}
                <button class="btn btn-secondary btn-sm" onclick="downloadPDF('${p._id}')">${ICON('file',14)} PDF</button>
            </div>
        </div>`;
}

async function loadReceipts() {
    if (!_tenantId) return;

    try {
        const res  = await fetch(`${API}/payments/tenant/${_tenantId}`, { headers: authHeaders() });
        const data = await res.json();
        const el   = document.getElementById('receiptsList');

        if (!Array.isArray(data)) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">${ICON('receipts',28)}</span>No receipts yet</div>`;
            return;
        }

        const visible = data
            .filter(p => p.status === 'paid' || p.status === 'partial')
            .sort((a, b) => new Date(b.datePaid || b.createdAt) - new Date(a.datePaid || a.createdAt));

        if (!visible.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">${ICON('receipts',28)}</span>No receipts yet</div>`;
            return;
        }

        const groups = [
            { key: 'rent',         title: 'Rent' },
            { key: 'deposit',      title: 'Deposit' },
            { key: 'holiday_hold', title: 'Holiday holding fees' },
            { key: 'refund',       title: 'Refunds' }
        ];

        el.innerHTML = groups.map(g => {
            const rows = visible.filter(p => (p.category || 'rent') === g.key);
            if (!rows.length) return '';
            return `
                <div style="font-family:'DM Mono',monospace;font-size:0.58rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--text-dim);margin:0.85rem 0 0.15rem">${g.title}</div>
                ${rows.map(_receiptRow).join('')}`;
        }).join('');

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
        box.innerHTML = `<div class="empty-state"><span class="empty-icon">${ICON('messages',26)}</span>No messages yet. Send a message to your landlord!</div>`;
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
                    ${_esc(m.text)}
                    <div class="msg-meta">
                        ${isMine ? 'You' : `${ICON('home',10)} Landlord`} · ${date} ${time}
                    </div>
                </div>`;
        }).join('');

    box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
    if (_isMovedOut()) { showToast('Your tenancy has ended — messaging is closed', 'warn'); return; }

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
        input.disabled = _isMovedOut();
        if (!input.disabled) input.focus();
    }
}

document.getElementById('msgInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});


// ═══════════════════════════════════════════════════════
// UNREAD BADGE
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
// NOTICES
// ═══════════════════════════════════════════════════════

async function loadNotices() {
    try {
        const res  = await fetch(`${API}/announcements`, { headers: authHeaders() });
        const data = await res.json();
        const el   = document.getElementById('noticesList');

        if (!res.ok || !Array.isArray(data) || !data.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">${ICON('announcements',26)}</span>No announcements yet</div>`;
            return;
        }

        el.innerHTML = data.map(a => `
            <div class="info-item">
                <div class="info-body">${_esc(a.message)}</div>
                <div class="info-date">${_fmtDate(a.createdAt)}</div>
            </div>`).join('');
    } catch (err) { console.error(err); }
}


// ═══════════════════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════════════════

async function loadRules() {
    try {
        const res   = await fetch(`${API}/rules`, { headers: authHeaders() });
        const rules = await res.json();
        const el    = document.getElementById('rulesList');

        if (!res.ok || !Array.isArray(rules) || !rules.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">${ICON('rules',26)}</span>No rules posted yet</div>`;
            return;
        }

        el.innerHTML = rules.map((r, i) => `
            <div class="info-item">
                <div class="info-title" style="display:flex;align-items:center;gap:0.5rem">
                    <span style="font-family:'DM Mono',monospace;font-size:0.62rem;color:var(--accent);background:var(--accent-dim);padding:1px 7px;border-radius:99px">${i + 1}</span>
                    ${_esc(r.title)}
                </div>
                <div class="info-body" style="margin-top:0.3rem">${_esc(r.content)}</div>
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
    if (newPw.length < 6)               { showToast('Password must be at least 6 characters', 'warn'); return; }
    if (newPw !== confirm)              { showToast('New passwords do not match', 'error'); return; }

    const strength = getPasswordStrength(newPw);
    if (strength.score < 2) {
        showToast('Password is too weak — add uppercase letters, numbers or symbols', 'warn');
        return;
    }

    try {
        const res  = await fetch(`${API}/change-password`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ currentPassword: current, newPassword: newPw })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to change password', 'error'); return; }

        showToast('Password updated successfully ', 'success');

        ['currentPassword', 'newPassword', 'confirmPassword'].forEach(id => {
            document.getElementById(id).value = '';
        });
        const bar   = document.getElementById('pwStrengthBar');
        const label = document.getElementById('pwStrengthLabel');
        const match = document.getElementById('pwMatchIndicator');
        if (bar)   { bar.style.width = '0%'; bar.style.background = 'transparent'; }
        if (label) { label.textContent = ''; }
        if (match) { match.textContent = ''; }

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

function hidePageLoader() {
    const el = document.getElementById('pageLoader');
    if (!el) return;
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
}


// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', async () => {
    const underMaintenance = await checkMaintenance();
    if (underMaintenance) { hidePageLoader(); return; }

    initPasswordStrength();

    await loadProfile();
    await checkUnreadBadge();
    hidePageLoader();

    (window._arTourReady ? window._arTourReady() : Promise.resolve()).then(() => maybeStartTour());

    setInterval(checkMaintenance, 20 * 1000);
});

// Holiday fees accrue by the day and rent periods roll over at midnight, so
// re-pull everything whenever the tab becomes visible again.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _tenantId) loadProfile();
});

// ── Polling intervals ──
setInterval(checkUnreadBadge, 30000);
setInterval(loadProfile,      300000);
setInterval(loadNotices,      300000);
setInterval(loadRules,        600000);
setInterval(loadMessages,     20000);
setInterval(loadReceipts,     120000);
setInterval(loadMyMaintenanceRequests, 300000);


// ═══════════════════════════════════════════════════════
// FIND A HOUSE — buildings → available houses → apply
// ═══════════════════════════════════════════════════════
const _FH_COLORS_DARK  = ['#60a5fa', '#c084fc', '#fb923c', '#22d3ee', '#f472b6', '#facc15', '#818cf8', '#94a3b8'];
const _FH_COLORS_LIGHT = ['#1d5fd6', '#7c3aed', '#c2570c', '#0e7490', '#be185d', '#a16207', '#4338ca', '#475569'];
function _fhColor(i) {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return (light ? _FH_COLORS_LIGHT : _FH_COLORS_DARK)[(Number(i) || 0) % 8];
}
const _fh = { view: 'buildings', building: null, applyFor: null };
let _fhToken = 0;
let _fhSig = '';          // what the last render knew about the tenant's applications

function _fhReduced() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
function _fhStagger(nodes) {
    if (_fhReduced() || !nodes || !nodes.length || !nodes[0].animate) return;
    Array.from(nodes).slice(0, 16).forEach((n, i) => n.animate(
        [{ opacity: 0, transform: 'translateY(8px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
        { duration: 260, delay: i * 28, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' }));
}
async function _fhJson(path, opts) {
    const res = await fetch(`${API}${path}`, { headers: authHeaders(), ...(opts || {}) });
    let body = null; try { body = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, body };
}

function _fhApplicationCards(apps) {
    const pending = apps.find(a => a.status === 'pending');
    const lastDecided = apps.find(a => a.status === 'approved' || a.status === 'rejected');
    let html = '';
    if (pending) {
        html += `<div class="fh-app">
            <div class="fh-app-main">
                <div class="fh-app-title">Application sent — ${_esc(pending.houseName)}${pending.buildingLabel ? ` · ${_esc(pending.buildingLabel)}` : ''}</div>
                <div class="fh-app-sub">Waiting for your landlord to review it. You can withdraw it to apply for a different house.</div>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-fh-withdraw="${_esc(pending._id)}">Withdraw</button>
        </div>`;
    } else if (lastDecided) {
        const ok = lastDecided.status === 'approved';
        html += `<div class="fh-app ${lastDecided.status}">
            <div class="fh-app-main">
                <div class="fh-app-title">${ok ? 'Approved' : 'Not successful'} — ${_esc(lastDecided.houseName)}</div>
                <div class="fh-app-sub">${ok ? 'The house is assigned to you. Your rent and payment details are on your dashboard.' : _esc(lastDecided.decisionNote || 'You can browse other available houses below and apply again.')}</div>
            </div>
        </div>`;
    }
    return { html, pending, lastDecided };
}

function _fhDepositNote(dep) {
    if (!dep || !dep.requiredBeforeAssignment || dep.recorded) return '';
    return `<div class="fh-note">${ICON('cash', 14)} Your landlord requires a deposit${dep.required > 0 ? ` of <strong>${_fmtKsh(dep.required)}</strong>` : ''} to be recorded before a house can be assigned to you. You can apply now — the landlord will record the deposit, then approve.</div>`;
}

async function loadFindHouse() {
    const body = document.getElementById('findHouseBody');
    if (!body) return;
    const my = ++_fhToken;

    if (_fh.view === 'houses' && _fh.building) { return _fhShowHouses(_fh.building.id, _fh.building.label, _fh.building.colorIndex); }

    body.innerHTML = `<div class="empty-state">Loading…</div>`;
    const [b, a] = await Promise.all([_fhJson('/tenant/me/buildings'), _fhJson('/tenant/me/applications')]);
    if (my !== _fhToken) return;

    if (!b.ok) {
        const code = b.body && b.body.code;
        const msg = code === 'HAS_HOUSE' ? 'You already have a house assigned — there is nothing to apply for.'
                  : code === 'TENANCY_ENDED' ? 'Your tenancy has ended, so house applications are closed.'
                  : (b.body && b.body.message) || 'Could not load houses right now.';
        body.innerHTML = `<div class="empty-state"><span class="icon">${ICON('houses', 26)}</span>${_esc(msg)}</div>`;
        if (code === 'HAS_HOUSE') loadProfile();
        return;
    }

    const d = b.body, apps = a.ok && Array.isArray(a.body) ? a.body : [];
    _fhSig = JSON.stringify(apps.map(x => [x._id, x.status]));
    const appCards = _fhApplicationCards(apps);
    if (appCards.lastDecided && appCards.lastDecided.status === 'approved' && !_overview?.house) loadProfile();   // pick up the new house

    _fhIndexById = {}; d.buildings.forEach(x => { _fhIndexById[x._id] = x.colorIndex || 0; });
    const cards = d.buildings.map(x => _fhCardHtml(x.availableCount, x.label, x.description, x.icon, _fhColor(x.colorIndex), x._id));
    if (d.unassigned) cards.push(_fhCardHtml(d.unassigned.availableCount, 'Other houses', '', 'box', 'var(--text-dim)', 'unassigned'));

    body.innerHTML = `
        ${appCards.html}
        ${_fhDepositNote(d.deposit)}
        ${d.acceptingApplications ? '' : `<div class="fh-note">${_esc(d.property.name)} is not accepting new applications right now.</div>`}
        <div class="sec-title" style="font-size:0.7rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);margin-bottom:0.7rem">Available buildings · ${_esc(d.property.name)}</div>
        ${cards.length ? `<div class="fh-cards">${cards.join('')}</div>` : `<div class="empty-state"><span class="icon">${ICON('houses', 26)}</span>No buildings or houses are listed yet</div>`}`;
    _fhStagger(body.querySelectorAll('.fh-card'));
}

function _fhCardHtml(n, label, desc, icon, color, id) {
    const none = n === 0;
    return `<button type="button" class="fh-card" style="--bb:${color}" data-fh-open="${_esc(id)}" data-fh-label="${_esc(label)}" ${none ? 'disabled' : ''} aria-label="${_esc(label)}: ${n} available">
        <span class="fh-card-top"><span class="fh-card-icon">${ICON(icon || 'properties', 22)}</span><span class="fh-card-title">${_esc(label)}</span></span>
        ${desc ? `<span class="fh-card-desc">${_esc(desc)}</span>` : ''}
        <span class="fh-count"><b>${n}</b> available house${n === 1 ? '' : 's'}</span>
        <span class="fh-cta">${none ? 'Fully occupied' : `Explore ${ICON('chevron', 14)}`}</span>
    </button>`;
}

async function _fhShowHouses(id, label, colorIndex) {
    const body = document.getElementById('findHouseBody'); if (!body) return;
    const my = ++_fhToken;
    _fh.view = 'houses'; _fh.building = { id, label, colorIndex };
    body.innerHTML = `<div class="empty-state">Loading houses…</div>`;
    const [h, a] = await Promise.all([_fhJson(`/tenant/me/buildings/${encodeURIComponent(id)}/houses`), _fhJson('/tenant/me/applications')]);
    if (my !== _fhToken) return;
    if (!h.ok) {
        _fh.view = 'buildings'; _fh.building = null;
        showToast((h.body && h.body.message) || 'Could not load that building', 'error');
        return loadFindHouse();
    }
    const d = h.body, apps = a.ok && Array.isArray(a.body) ? a.body : [];
    _fhSig = JSON.stringify(apps.map(x => [x._id, x.status]));
    const appCards = _fhApplicationCards(apps);
    const hasPending = !!appCards.pending;
    const color = id === 'unassigned' ? 'var(--text-dim)' : _fhColor(colorIndex);

    const houses = d.houses.map(x => {
        const open = _fh.applyFor === x._id;
        let action;
        if (x.applied)            action = `<button type="button" class="btn btn-secondary btn-sm fh-apply" disabled>Applied</button>`;
        else if (!d.acceptingApplications) action = `<button type="button" class="btn btn-secondary btn-sm fh-apply" disabled>Not accepting applications</button>`;
        else if (hasPending)      action = `<button type="button" class="btn btn-secondary btn-sm fh-apply" disabled title="Withdraw your pending application first">Application pending elsewhere</button>`;
        else if (open)            action = `<div class="fh-form">
                <textarea id="fhNote" maxlength="300" placeholder="Optional note to your landlord (e.g. when you plan to move in)"></textarea>
                <div class="fh-form-row"><button type="button" class="btn btn-primary btn-sm" data-fh-send="${_esc(x._id)}">Send application</button>
                <button type="button" class="btn btn-secondary btn-sm" data-fh-cancel="1">Cancel</button></div></div>`;
        else                      action = `<button type="button" class="btn btn-primary btn-sm fh-apply" data-fh-apply="${_esc(x._id)}">Apply</button>`;
        return `<div class="fh-house" style="--bb:${color}">
            <div class="fh-house-name">${_esc(x.name)}</div>
            <div class="fh-rent">${_fmtKsh(x.rent)} <small>${_esc(x.rentLabel)}</small></div>
            <div class="fh-meta">${x.depositRequired > 0 ? `Deposit: ${_fmtKsh(x.depositRequired)}` : 'No deposit required'}</div>
            <div class="fh-status">Available</div>
            ${action}
        </div>`;
    });

    body.innerHTML = `
        ${appCards.html}
        ${_fhDepositNote(d.deposit)}
        <nav class="fh-crumbs" aria-label="Where you are">
            <button type="button" class="fh-back" data-fh-back="1">${ICON('chevron', 14)} All buildings</button>
            <span>/</span><span class="fh-cur" style="--bb:${color}">${_esc(d.building.label)}</span>
        </nav>
        ${houses.length ? `<div class="fh-houses">${houses.join('')}</div>` : `<div class="empty-state"><span class="icon">${ICON('houses', 26)}</span>No houses are available in this building right now</div>`}`;
    _fhStagger(body.querySelectorAll('.fh-house'));
    const ta = document.getElementById('fhNote'); if (ta) ta.focus();
}

async function _fhSend(houseId) {
    const note = (document.getElementById('fhNote')?.value || '').trim();
    const btn = document.querySelector('[data-fh-send]'); if (btn) btn.disabled = true;
    const r = await _fhJson('/tenant/me/applications', { method: 'POST', body: JSON.stringify({ houseId, note }) });
    if (btn) btn.disabled = false;
    if (!r.ok) {
        showToast((r.body && r.body.message) || 'Could not send your application', 'error');
        _fh.applyFor = null;
        return r.status === 400 || r.status === 409 ? _fhShowHouses(_fh.building.id, _fh.building.label, _fh.building.colorIndex) : undefined;
    }
    showToast(r.body.message || 'Application sent', 'success');
    _fh.applyFor = null; _fh.view = 'buildings'; _fh.building = null;
    loadFindHouse();
}

document.addEventListener('click', async e => {
    const root = e.target.closest('#findHouseBody'); if (!root) return;
    const open = e.target.closest('[data-fh-open]');
    if (open) return _fhShowHouses(open.dataset.fhOpen, open.dataset.fhLabel, _fhColorIndexOf(open.dataset.fhOpen));
    if (e.target.closest('[data-fh-back]'))   { _fh.view = 'buildings'; _fh.building = null; _fh.applyFor = null; return loadFindHouse(); }
    const apply = e.target.closest('[data-fh-apply]');
    if (apply)  { _fh.applyFor = apply.dataset.fhApply; return _fhShowHouses(_fh.building.id, _fh.building.label, _fh.building.colorIndex); }
    if (e.target.closest('[data-fh-cancel]')) { _fh.applyFor = null; return _fhShowHouses(_fh.building.id, _fh.building.label, _fh.building.colorIndex); }
    const send = e.target.closest('[data-fh-send]');
    if (send)   return _fhSend(send.dataset.fhSend);
    const wd = e.target.closest('[data-fh-withdraw]');
    if (wd) {
        wd.disabled = true;
        const r = await _fhJson(`/tenant/me/applications/${encodeURIComponent(wd.dataset.fhWithdraw)}/withdraw`, { method: 'PUT' });
        showToast(r.ok ? 'Application withdrawn' : ((r.body && r.body.message) || 'Could not withdraw'), r.ok ? 'success' : 'error');
        return _fh.view === 'houses' && _fh.building ? _fhShowHouses(_fh.building.id, _fh.building.label, _fh.building.colorIndex) : loadFindHouse();
    }
});

// colour index of a building card (kept on the card list so a click can pass it on)
let _fhIndexById = {};
function _fhColorIndexOf(id) { return _fhIndexById[id] || 0; }

// While the tenant is waiting on an application, quietly check for a decision and pick up a new house.
setInterval(async () => {
    if (_overview && !_overview.house && !_isMovedOut() && document.getElementById('navFindHouse') && !document.getElementById('navFindHouse').classList.contains('nav-hidden')) {
        const r = await _fhJson('/tenant/me/applications');
        if (r.ok && Array.isArray(r.body) && r.body.some(a => a.status === 'approved')) loadProfile();
        // only redraw when a decision actually arrived — never replay the entrance animation for nothing
        if (document.getElementById('sec-find')?.classList.contains('active') && r.ok && JSON.stringify(r.body.map(x => [x._id, x.status])) !== _fhSig) loadFindHouse();
    }
}, 60000);
