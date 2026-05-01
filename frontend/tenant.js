// ═══════════════════════════════════════════════════════
//  tenant.js — Tenant Dashboard (API + UI combined)
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
//  PART 2 — ADD TO TOP OF tenant.js (inside DOMContentLoaded,
//  BEFORE loadProfile() is called)
// ═══════════════════════════════════════════════════════


async function checkMaintenance() {
    try {
        const res  = await fetch(`${API}/maintenance`);
        const data = await res.json();

        if (data.maintenanceMode) {
            showMaintenanceScreen(data.maintenanceMessage);
            return true; // is under maintenance
        }

        return false; // all clear

    } catch (err) {
        // If we can't reach the server at all, show a connection error
        // but don't assume maintenance mode
        console.error('Maintenance check failed:', err);
        return false;
    }
}


function showMaintenanceScreen(message) {
    // Hide everything
    document.querySelector('header').style.display     = 'none';
    document.querySelector('.page-body').style.display = 'none';
    document.querySelector('.bottom-nav').style.display = 'none';

    // Show fullscreen maintenance UI
    const screen = document.createElement('div');
    screen.id    = 'maintenanceScreen';
    screen.style.cssText = `
        position: fixed;
        inset: 0;
        background: var(--bg);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 2rem;
        z-index: 99999;
        font-family: var(--font-b);
    `;

    screen.innerHTML = `
        <div style="
            max-width: 400px;
            background: var(--panel);
            border: 1px solid var(--border2);
            border-radius: 16px;
            padding: 2.5rem 2rem;
            box-shadow: 0 24px 80px rgba(0,0,0,0.5)
        ">
            <div style="font-size: 3.5rem; margin-bottom: 1rem">🔧</div>

            <div style="
                font-family: var(--font-d);
                font-style: italic;
                font-size: 1.6rem;
                color: var(--text);
                margin-bottom: 0.75rem
            ">Under Maintenance</div>

            <p style="
                font-size: 0.85rem;
                color: var(--text-muted);
                line-height: 1.7;
                margin-bottom: 1.5rem
            ">${message || 'The system is currently under maintenance. Please check back later.'}</p>

            <div style="
                font-family: var(--font-m);
                font-size: 0.65rem;
                letter-spacing: 0.15em;
                text-transform: uppercase;
                color: var(--text-dim);
                margin-bottom: 1.25rem
            ">Please try again later</div>

            <button onclick="window.location.reload()" style="
                background: var(--accent);
                border: none;
                border-radius: 8px;
                color: #fff;
                font-family: var(--font-b);
                font-size: 0.8rem;
                font-weight: 600;
                padding: 0.65rem 1.5rem;
                cursor: pointer;
                width: 100%;
                transition: opacity 0.15s
            ">↻ Check Again</button>

            <button onclick="logout()" style="
                background: transparent;
                border: 1px solid var(--border2);
                border-radius: 8px;
                color: var(--text-muted);
                font-family: var(--font-b);
                font-size: 0.75rem;
                padding: 0.55rem 1.5rem;
                cursor: pointer;
                width: 100%;
                margin-top: 0.5rem;
                transition: all 0.15s
            ">Sign Out</button>
        </div>
    `;

    document.body.appendChild(screen);
}



const API= 'https://affordable-rental-systems.onrender.com';

// ─── State ───
let _tenant    = null;
let _payments  = [];
let _tenantId  = null;
let _phone     = null;

// ═══════════════════════════════════════════
// AUTH & INIT
// ═══════════════════════════════════════════

function getToken() { return localStorage.getItem('token'); }

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken()
    };
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

// Guard — redirect if not tenant
(function guard() {
    const payload = getPayload();
    if (!payload) { window.location.href = 'auth.html'; return; }
    if (payload.role === 'admin') { window.location.href = 'index.html'; return; }
    _tenantId = payload.tenantId;
})();

// ═══════════════════════════════════════════
// AVATAR GENERATOR
// ═══════════════════════════════════════════

// Deterministic color from name — same name always same color
function nameToColor(name) {
    const palette = [
        '#7c3aed', '#2563eb', '#059669', '#dc2626',
        '#d97706', '#db2777', '#0891b2', '#65a30d',
        '#9333ea', '#0284c7', '#16a34a', '#ea580c'
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return palette[Math.abs(hash) % palette.length];
}

function getInitials(name) {
    return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function applyAvatar(name) {
    const color    = nameToColor(name);
    const initials = getInitials(name);

    // Header avatar (small)
    const ha = document.getElementById('headerAvatar');
    if (ha) { ha.textContent = initials; ha.style.background = color; }

    // Profile avatar (large)
    const pa = document.getElementById('profileAvatar');
    if (pa) { pa.textContent = initials; pa.style.background = color; }
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════

const SECTION_LOADERS = {
    receipts: loadReceipts,
    messages: loadMessages,
    notices:  loadNotices,
    rules:    loadRules,
};

function showSection(name) {
    // Sections
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    const sec = document.getElementById(`sec-${name}`);
    if (sec) sec.classList.add('active');

    // Bottom nav
    document.querySelectorAll('.bnav-item').forEach(b => b.classList.remove('active'));
    const bnav = document.getElementById(`bnav-${name}`);
    if (bnav) bnav.classList.add('active');

    // Desktop sidebar
    document.querySelectorAll('.dsk-nav-item').forEach(d => d.classList.remove('active'));
    document.querySelectorAll('.dsk-nav-item').forEach(d => {
        if (d.getAttribute('onclick')?.includes(`'${name}'`)) d.classList.add('active');
    });

    // Lazy load
    if (SECTION_LOADERS[name]) SECTION_LOADERS[name]();
}

// ═══════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════

let _toastTimer;
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className   = `show ${type}`;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}

// ═══════════════════════════════════════════
// LOAD PROFILE & HOME DATA
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
// RENDER — HEADER
// ═══════════════════════════════════════════

function renderHeader(data) {
    const t = data.tenant;

    document.getElementById('headerName').textContent = t.name.split(' ')[0]; // first name only
    applyAvatar(t.name);

    // Month status pill
    const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const paidThisMonth = _payments.some(p => p.month === currentMonth);
    const pill = document.getElementById('headerStatus');
    pill.textContent = paidThisMonth ? '✅ Paid' : '⚠️ Unpaid';
    pill.className   = `status-pill ${paidThisMonth ? 'paid' : 'unpaid'}`;
}

// ═══════════════════════════════════════════
// RENDER — HOME
// ═══════════════════════════════════════════

function renderHome(data) {
    document.getElementById('statPaid').textContent    = `${(data.totalPaid || 0).toLocaleString()}`;
    document.getElementById('statArrears').textContent = `${(data.arrears   || 0).toLocaleString()}`;
    document.getElementById('statHouse').textContent   = data.tenant.house ? data.tenant.house.name : 'Not assigned';

    const currentMonth  = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const paidThisMonth = _payments.find(p => p.month === currentMonth);
    const house         = data.tenant.house;
    const rent          = house ? house.rent : 0;

    const statusEl = document.getElementById('monthStatus');

    if (!house) {
        statusEl.innerHTML = `<span style="color:var(--text-dim)">No house assigned yet. Contact your landlord.</span>`;
        return;
    }

    if (paidThisMonth) {
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:0.75rem">
                <span style="font-size:1.4rem">✅</span>
                <div>
                    <div style="font-weight:600;color:var(--green)">${currentMonth} — Paid</div>
                    <div style="font-size:0.72rem;color:var(--text-dim);font-family:var(--font-m)">Ksh ${paidThisMonth.amount.toLocaleString()} received</div>
                </div>
            </div>`;
    } else {
        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:0.75rem">
                <span style="font-size:1.4rem">⚠️</span>
                <div>
                    <div style="font-weight:600;color:var(--red)">${currentMonth} — Not Paid</div>
                    <div style="font-size:0.72rem;color:var(--text-dim);font-family:var(--font-m)">Ksh ${rent.toLocaleString()} due</div>
                </div>
            </div>`;
    }
}

// ═══════════════════════════════════════════
// RENDER — PROFILE
// ═══════════════════════════════════════════

function renderProfile(data) {
    const t = data.tenant;

    document.getElementById('profileName').textContent  = t.name;
    document.getElementById('profileEmail').textContent = t.email;
    document.getElementById('profilePhone').textContent = t.phone;
    document.getElementById('profileHouse').textContent = t.house ? t.house.name : 'Not assigned';
    document.getElementById('profileDue').textContent   = t.dueDate ? `${t.dueDate}th of each month` : '5th of each month';
    document.getElementById('profileSince').textContent = new Date(t.createdAt).toLocaleDateString('en-GB', { year:'numeric', month:'long', day:'numeric' });
    document.getElementById('profileTotalPaid').textContent = `Ksh ${(data.totalPaid || 0).toLocaleString()}`;

    // Payment history table
    const tbody = document.getElementById('payHistoryTable');
    if (!_payments.length) {
        tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">No payments recorded yet</div></td></tr>`;
        return;
    }

    tbody.innerHTML = _payments
        .slice()
        .sort((a, b) => new Date(b.datePaid) - new Date(a.datePaid))
        .map(p => `
            <tr>
                <td>${p.month}</td>
                <td class="td-mono">Ksh ${p.amount.toLocaleString()}</td>
                <td class="td-mono">${new Date(p.datePaid).toLocaleDateString()}</td>
                <td><span class="pill pill-green">${p.status || 'paid'}</span></td>
            </tr>`)
        .join('');
}

// ═══════════════════════════════════════════
// RENDER — PAY SECTION
// ═══════════════════════════════════════════

function renderPaySection(data) {
    const t    = data.tenant;
    const house = t.house;

    const currentMonth  = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const paidThisMonth = _payments.find(p => p.month === currentMonth);

    const summaryEl = document.getElementById('rentSummary');

    if (!house) {
        summaryEl.innerHTML = `<span style="color:var(--text-dim)">No house assigned. Contact landlord.</span>`;
        return;
    }

    // Pre-fill month field
    document.getElementById('payMonth').value  = currentMonth;
    document.getElementById('payAmount').value = house.rent;

    summaryEl.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:0.5rem">
            <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:var(--text-dim)">House</span>
                <span style="font-family:var(--font-m)">${house.name}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:var(--text-dim)">Monthly Rent</span>
                <span style="font-family:var(--font-m);color:var(--accent)">Ksh ${house.rent.toLocaleString()}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.8rem">
                <span style="color:var(--text-dim)">${currentMonth}</span>
                <span class="pill ${paidThisMonth ? 'pill-green' : 'pill-red'}">${paidThisMonth ? 'Paid ✅' : 'Unpaid ⚠️'}</span>
            </div>
            ${data.arrears > 0
                ? `<div style="display:flex;justify-content:space-between;font-size:0.8rem">
                       <span style="color:var(--text-dim)">Arrears</span>
                       <span style="color:var(--red);font-family:var(--font-m)">Ksh ${data.arrears.toLocaleString()}</span>
                   </div>`
                : ''}
        </div>`;
}

// ═══════════════════════════════════════════
// RENDER — SETTINGS
// ═══════════════════════════════════════════

function renderSettings(data) {
    const t = data.tenant;
    document.getElementById('settingsName').textContent  = t.name;
    document.getElementById('settingsEmail').textContent = t.email;
    document.getElementById('settingsPhone').textContent = t.phone;
}

// ═══════════════════════════════════════════
// M-PESA PAYMENT
// ═══════════════════════════════════════════



   // ═══════════════════════════════════════════════════════
//  REPLACE payWithMpesa() in tenant.js WITH THIS
//  Also add pollPaymentStatus() below it
// ═══════════════════════════════════════════════════════


async function payWithMpesa() {
    const amount = document.getElementById('payAmount').value;
    const month  = document.getElementById('payMonth').value.trim();

    if (!amount || !month) { showToast('Enter amount and month', 'warn'); return; }
    if (!_phone)            { showToast('Phone number not found on your account', 'error'); return; }

    // Block if already paid
    const alreadyPaid = _payments.find(p => p.month === month);
    if (alreadyPaid) {
        showToast(`Already paid for ${month} ✅`, 'warn');
        return;
    }

    // Show loading state
    const btn = document.querySelector('.mpesa-btn');
    btn.disabled    = true;
    btn.textContent = '⏳ Sending prompt...';

    try {
        const res  = await fetch(`${API}/stkpush`, {
            method:  'POST',
            headers: authHeaders(),
            body: JSON.stringify({ phone: _phone, amount: Number(amount), month })
        });
        const data = await res.json();

        btn.disabled    = false;
        btn.textContent = '📱 Pay with M-Pesa';

        if (!res.ok) {
            showToast(data.message || data.error || 'M-Pesa request failed', 'error');
            renderPayStatus('failed', { reason: data.message });
            return;
        }

        // Show waiting UI and start polling
        renderPayStatus('waiting', { phone: _phone, amount, month });
        pollPaymentStatus(data.checkoutRequestId, month);

    } catch (err) {
        btn.disabled    = false;
        btn.textContent = '📱 Pay with M-Pesa';
        showToast('Network error — check your connection', 'error');
        console.error(err);
    }
}


// ── Poll backend every 3s until confirmed/failed/timeout ──
async function pollPaymentStatus(checkoutRequestId, month) {
    const maxAttempts = 40;   // 40 × 3s = 2 minutes
    let   attempts    = 0;

    const interval = setInterval(async () => {
        attempts++;

        try {
            const res  = await fetch(`${API}/payment-status/${checkoutRequestId}`, {
                headers: authHeaders()
            });
            const data = await res.json();

            // ── CONFIRMED ──
            if (data.status === 'confirmed') {
                clearInterval(interval);
                renderPayStatus('confirmed', {
                    paymentId: data.paymentId,
                    mpesaCode: data.mpesaCode,
                    month
                });
                showToast('Payment confirmed ✅', 'success');

                // Reload profile data to update stats
                await loadProfile();
                return;
            }

            // ── FAILED ──
            if (data.status === 'failed') {
                clearInterval(interval);
                renderPayStatus('failed', { reason: data.reason || 'Payment was not completed' });
                showToast('Payment failed or cancelled', 'error');
                return;
            }

            // ── DUPLICATE ──
            if (data.status === 'duplicate') {
                clearInterval(interval);
                renderPayStatus('confirmed', { mpesaCode: 'Already recorded', month });
                showToast(`${month} is already paid ✅`, 'warn');
                return;
            }

            // ── TIMEOUT (from server) ──
            if (data.status === 'timeout') {
                clearInterval(interval);
                renderPayStatus('timeout', {});
                showToast('Payment timed out. Try again.', 'warn');
                return;
            }

            // Still pending — update countdown
            const remaining = maxAttempts - attempts;
            renderPayStatus('waiting', {
                phone: _phone,
                secondsLeft: remaining * 3
            });

        } catch (err) {
            console.error('Polling error:', err);
        }

        // ── CLIENT-SIDE TIMEOUT ──
        if (attempts >= maxAttempts) {
            clearInterval(interval);
            renderPayStatus('timeout', {});
            showToast('No response from M-Pesa. Check receipts later.', 'warn');
        }

    }, 3000); // poll every 3 seconds
}


// ── Render pay status UI ──
function renderPayStatus(status, data) {
    const el = document.getElementById('payReceipt');

    const states = {
        waiting: `
            <div class="card" style="border-color:rgba(251,191,36,0.3);margin-top:1rem">
                <div style="text-align:center;padding:1rem 0">
                    <div style="font-size:2rem;margin-bottom:0.5rem;animation:spin 1.5s linear infinite;display:inline-block">⏳</div>
                    <div style="font-weight:600;color:var(--amber);margin-bottom:0.25rem">Waiting for payment...</div>
                    <div style="font-size:0.75rem;color:var(--text-dim);font-family:var(--font-m)">
                        Check <strong style="color:var(--text)">${data.phone || ''}</strong> for the M-Pesa prompt
                    </div>
                    ${data.secondsLeft ? `<div style="font-size:0.68rem;color:var(--text-dim);margin-top:0.5rem">Timing out in ~${data.secondsLeft}s</div>` : ''}
                </div>
            </div>`,

        confirmed: `
            <div class="card" style="border-color:rgba(52,211,153,0.3);margin-top:1rem">
                <div style="text-align:center;padding:1rem 0">
                    <div style="font-size:2.5rem;margin-bottom:0.5rem">✅</div>
                    <div style="font-weight:600;color:var(--green);margin-bottom:0.5rem">Payment Confirmed!</div>
                    ${data.mpesaCode ? `<div style="font-family:var(--font-m);font-size:0.72rem;color:var(--text-dim)">M-Pesa Code: <strong style="color:var(--text)">${data.mpesaCode}</strong></div>` : ''}
                    ${data.month     ? `<div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.25rem">${data.month} — Paid</div>` : ''}
                    <div style="margin-top:1rem;display:flex;gap:0.5rem;justify-content:center">
                        ${data.paymentId ? `<button class="btn btn-secondary btn-sm" onclick="downloadPDF('${data.paymentId}')">📄 Download Receipt</button>` : ''}
                        <button class="btn btn-primary btn-sm" onclick="showSection('receipts')">View All Receipts</button>
                    </div>
                </div>
            </div>`,

        failed: `
            <div class="card" style="border-color:rgba(248,113,113,0.3);margin-top:1rem">
                <div style="text-align:center;padding:1rem 0">
                    <div style="font-size:2rem;margin-bottom:0.5rem">❌</div>
                    <div style="font-weight:600;color:var(--red);margin-bottom:0.25rem">Payment Failed</div>
                    <div style="font-size:0.75rem;color:var(--text-dim)">${data.reason || 'The payment was not completed. Please try again.'}</div>
                </div>
            </div>`,

        timeout: `
            <div class="card" style="border-color:rgba(251,191,36,0.2);margin-top:1rem">
                <div style="text-align:center;padding:1rem 0">
                    <div style="font-size:2rem;margin-bottom:0.5rem">⏱️</div>
                    <div style="font-weight:600;color:var(--amber);margin-bottom:0.25rem">Request Timed Out</div>
                    <div style="font-size:0.75rem;color:var(--text-dim)">
                        If you entered your PIN, check your receipts in a few minutes. Otherwise try again.
                    </div>
                    <button class="btn btn-secondary btn-sm" onclick="showSection('receipts')" style="margin-top:0.75rem;width:auto">Check Receipts</button>
                </div>
            </div>`
    };

    el.innerHTML = states[status] || '';
}


// ── Add this CSS to tenant.html <style> for the spinner ──
// @keyframes spin { to { transform: rotate(360deg); } }

// ═══════════════════════════════════════════
// RECEIPTS
// ═══════════════════════════════════════════

async function loadReceipts() {
    if (!_tenantId) return;

    try {
        const res  = await fetch(`${API}/payments/tenant/${_tenantId}`, { headers: authHeaders() });
        const data = await res.json();

        const el = document.getElementById('receiptsList');

        if (!data.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">🧾</span>No receipts yet</div>`;
            return;
        }

        el.innerHTML = data
            .slice()
            .sort((a, b) => new Date(b.datePaid) - new Date(a.datePaid))
            .map(p => `
                <div class="info-item" style="display:flex;align-items:center;justify-content:space-between;gap:1rem">
                    <div>
                        <div class="info-title">${p.month}</div>
                        <div class="info-date">Ksh ${p.amount.toLocaleString()} · ${new Date(p.datePaid).toLocaleDateString()}</div>
                    </div>
                    <div style="display:flex;gap:0.4rem;flex-shrink:0">
                        <span class="pill pill-green">${p.status || 'paid'}</span>
                        <button class="btn btn-secondary btn-sm" onclick="downloadPDF('${p._id}')">PDF</button>
                    </div>
                </div>`)
            .join('');

    } catch (err) {
        showToast('Failed to load receipts', 'error');
        console.error(err);
    }
}

function downloadPDF(paymentId) {
    window.open(`${API}/receipt/pdf/${paymentId}`, '_blank');
}

// ═══════════════════════════════════════════════════════
//  REPLACE THESE FUNCTIONS IN tenant.js
// ═══════════════════════════════════════════════════════


// ════════════════════════════════
// MESSAGES — replace all 3 functions
// ════════════════════════════════

async function loadMessages() {
    try {
        // FIX: /messages/my now correctly queries by tenant field
        const res  = await fetch(`${API}/messages/my`, { headers: authHeaders() });
        const msgs = await res.json();

        if (!res.ok) {
            console.error('Failed to load messages:', msgs);
            return;
        }

        renderChat(msgs);

        // Mark admin replies as read by fetching with a read marker
        // (backend marks tenant-side reads via a separate lightweight call)
        await markMyMessagesRead();

        // Clear badge
        const badge    = document.getElementById('msgBadge');
        const dskBadge = document.getElementById('dskMsgBadge');
        if (badge)    badge.style.display    = 'none';
        if (dskBadge) dskBadge.style.display = 'none';

    } catch (err) {
        console.error('loadMessages error:', err);
    }
}


async function markMyMessagesRead() {
    // Mark admin messages in MY thread as read
    // We reuse the existing read endpoint — admin side marks tenant msgs
    // For tenant side we just track via badge only (no separate read flag needed
    // since tenant sees all messages when they open the chat)
    try {
        await fetch(`${API}/messages/read/${_tenantId}`, {
            method:  'PUT',
            headers: authHeaders()
        });
    } catch { /* silent */ }
}


function renderChat(messages) {
    const box = document.getElementById('chatBox');

    if (!messages || !messages.length) {
        box.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">💬</span>
                No messages yet. Send a message to your landlord!
            </div>`;
        return;
    }

    box.innerHTML = messages
        .slice()
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .map(m => {
            const isMine = m.sender === 'tenant';
            const time   = new Date(m.createdAt).toLocaleTimeString([], {
                hour:   '2-digit',
                minute: '2-digit'
            });
            const date = new Date(m.createdAt).toLocaleDateString([], {
                day:   'numeric',
                month: 'short'
            });

            return `
                <div class="msg-bubble ${isMine ? 'msg-mine' : 'msg-admin'}">
                    ${m.text}
                    <div class="msg-meta">
                        ${isMine ? 'You' : '🏠 Landlord'} · ${date} ${time}
                    </div>
                </div>`;
        })
        .join('');

    // Always scroll to latest message
    box.scrollTop = box.scrollHeight;
}


async function sendMessage() {
    const input = document.getElementById('msgInput');
    const text  = input.value.trim();
    if (!text) return;

    // Disable input while sending
    input.disabled = true;

    try {
        const res = await fetch(`${API}/messages`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ text })  // FIX: just send text, backend gets tenantId from token
        });

        const data = await res.json();

        if (!res.ok) {
            showToast(data.message || 'Failed to send', 'error');
            return;
        }

        input.value = '';
        await loadMessages(); // reload full thread

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    } finally {
        input.disabled = false;
        input.focus();
    }
}


// ════════════════════════════════
// UNREAD BADGE — replace checkUnreadBadge()
// ════════════════════════════════

async function checkUnreadBadge() {
    try {
        // FIX: use dedicated lightweight endpoint instead of loading full thread
        const res  = await fetch(`${API}/messages/unread-mine`, { headers: authHeaders() });
        const data = await res.json();

        if (!res.ok) return;

        const count    = data.count || 0;
        const badge    = document.getElementById('msgBadge');
        const dskBadge = document.getElementById('dskMsgBadge');

        if (count > 0) {
            if (badge) {
                badge.textContent    = count > 9 ? '9+' : count;
                badge.style.display  = 'flex';
            }
            if (dskBadge) {
                dskBadge.textContent   = count > 9 ? '9+' : count;
                dskBadge.style.display = 'inline-block';
            }
        } else {
            if (badge)    badge.style.display    = 'none';
            if (dskBadge) dskBadge.style.display = 'none';
        }

    } catch { /* silent — don't spam errors on poll */ }
}


// Enter key sends message
document.getElementById('msgInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ═══════════════════════════════════════════
// NOTICES (ANNOUNCEMENTS)
// ═══════════════════════════════════════════

async function loadNotices() {
    try {
        const res  = await fetch(`${API}/announcements`);
        const data = await res.json();

        const el = document.getElementById('noticesList');

        if (!data.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">📢</span>No announcements yet</div>`;
            return;
        }

        el.innerHTML = data.map(a => `
            <div class="info-item">
                <div class="info-body">${a.message}</div>
                <div class="info-date">${new Date(a.createdAt).toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'})}</div>
            </div>`).join('');

    } catch (err) {
        console.error(err);
    }
}

// ═══════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════

async function loadRules() {
    try {
        const res   = await fetch(`${API}/rules`);
        const rules = await res.json();

        const el = document.getElementById('rulesList');

        if (!rules.length) {
            el.innerHTML = `<div class="empty-state"><span class="empty-icon">📜</span>No rules posted yet</div>`;
            return;
        }

        el.innerHTML = rules.map((r, i) => `
            <div class="info-item">
                <div class="info-title" style="display:flex;align-items:center;gap:0.5rem">
                    <span style="font-family:var(--font-m);font-size:0.65rem;color:var(--accent);background:var(--accent-dim);padding:2px 7px;border-radius:99px">${i + 1}</span>
                    ${r.title}
                </div>
                <div class="info-body" style="margin-top:0.35rem">${r.content}</div>
            </div>`).join('');

    } catch (err) {
        console.error(err);
    }
}

// ═══════════════════════════════════════════
// CHANGE PASSWORD
// ═══════════════════════════════════════════

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
            body: JSON.stringify({ currentPassword: current, newPassword: newPw })
        });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Failed to change password', 'error'); return; }

        showToast('Password updated successfully ✅', 'success');

        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value     = '';
        document.getElementById('confirmPassword').value = '';

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

// ═══════════════════════════════════════════
// UNREAD BADGE CHECK
// ═══════════════════════════════════════════

async function checkUnreadBadge() {
    // Poll for unread messages every 30s
    try {
        const res  = await fetch(`${API}/messages/my`, { headers: authHeaders() });
        const msgs = await res.json();
        if (!Array.isArray(msgs)) return;

        const unread = msgs.filter(m => m.sender === 'admin' && !m.isRead).length;

        const badge    = document.getElementById('msgBadge');
        const dskBadge = document.getElementById('dskMsgBadge');

        if (unread > 0) {
            if (badge)    { badge.textContent    = unread; badge.style.display    = 'flex'; }
            if (dskBadge) { dskBadge.textContent = unread; dskBadge.style.display = 'inline-block'; }
        } else {
            if (badge)    badge.style.display    = 'none';
            if (dskBadge) dskBadge.style.display = 'none';
        }
    } catch { /* silent */ }
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

window.addEventListener('DOMContentLoaded', async () => {
    // 1. Check maintenance FIRST — before anything else loads
    const underMaintenance = await checkMaintenance();
    if (underMaintenance) return; // stop here, show lockout screen
 
    // 2. Load all dashboard data
    await loadProfile();
    await checkUnreadBadge();
 
    // 3. Poll for unread messages every 30 seconds
    setInterval(checkUnreadBadge, 30000);
 
    // 4. Re-check maintenance every 2 minutes
    //    (so if admin turns it on, tenant gets locked out automatically)
    setInterval(async () => {
        const stillMaintenance = await checkMaintenance();
        // If maintenance just turned on and screen not already shown
        if (stillMaintenance && !document.getElementById('maintenanceScreen')) {
            showMaintenanceScreen();
        }
    }, 2 * 60 * 1000);
});

// Poll for unread messages every 30 seconds
setInterval(checkUnreadBadge, 30000);
setInterval(loadProfile, 30000); // Refresh profile data every 5 minutes to keep stats updated
setInterval(loadNotices, 300000); // Refresh notices every 5 minutes
setInterval(loadRules, 600000); // Refresh rules every 10 minutes
setInterval(loadMessages, 20000); // Refresh messages every 20 seconds in case of new ones
setInterval(loadReceipts, 120000); // Refresh receipts every 2 minutes in case of new payments
