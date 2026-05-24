// ═══════════════════════════════════════════════════════
//  script.js — Admin API Layer
//  All fetch() calls live here.
//  index.js handles rendering / DOM only.
// ═══════════════════════════════════════════════════════

const API = CONFIG.API_URL;

function getToken() {
    return localStorage.getItem('token');
}

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken()
    };
}

function logout() {
    localStorage.removeItem('token');
    window.location.href = 'auth.html';
}

// ── Guard: redirect if not logged in or not admin ──
(function guardAdmin() {
    const token = getToken();
    if (!token) { window.location.href = 'landing.html'; return; }
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload.role !== 'admin') window.location.href = 'tenant.html';
    } catch {
        window.location.href = 'auth.html';
    }
})();


// ═══════════════════════════════════════════════════════
//  DANGER CONFIRM MODAL
//  Single reusable modal for ALL destructive actions.
//  Usage:
//    openDangerModal({
//      icon:    '🗑️',
//      title:   'Delete House',
//      message: 'Are you sure you want to delete <strong>A-12</strong>?<br>This cannot be undone.',
//      label:   'Delete House',        // button text
//      type:    'danger' | 'warn',     // button colour
//      onConfirm: async () => { ... }  // called when user clicks confirm
//    });
// ═══════════════════════════════════════════════════════

let _dangerCallback = null;

function openDangerModal({ icon = '⚠️', title, message, label = 'Confirm', type = 'danger', onConfirm }) {
    document.getElementById('dangerIcon').textContent    = icon;
    document.getElementById('dangerTitle').textContent   = title;
    document.getElementById('dangerMessage').innerHTML   = message;

    const btn = document.getElementById('dangerConfirmBtn');
    btn.textContent = label;
    btn.className   = `btn btn-full ${type === 'warn' ? 'btn-warn' : 'btn-danger'}`;

    _dangerCallback = onConfirm;

    document.getElementById('modal-danger').classList.add('open');
}

async function confirmDangerAction() {
    if (typeof _dangerCallback !== 'function') return;

    const btn = document.getElementById('dangerConfirmBtn');
    btn.disabled    = true;
    btn.textContent = '⏳ Processing...';

    try {
        await _dangerCallback();
    } finally {
        btn.disabled    = false;
        closeDangerModal();
    }
}

function closeDangerModal() {
    document.getElementById('modal-danger').classList.remove('open');
    _dangerCallback = null;
}


// ═══════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════

async function loadDashboard() {
    const month = document.getElementById('dashMonth').value.trim();
    if (!month) { showToast('Enter a month first', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/dashboard/${encodeURIComponent(month)}`, {
            headers: authHeaders()
        });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Failed to load dashboard', 'error'); return; }

        document.getElementById('income').textContent       = data.totalIncome.toLocaleString();
        document.getElementById('arrears').textContent      = data.totalArrears.toLocaleString();
        document.getElementById('occupied').textContent     = data.occupiedHouses;
        document.getElementById('vacant').textContent       = data.vacantHouses;
        document.getElementById('totalTenants').textContent = data.totalTenants;

        renderCharts(data);

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}


// ═══════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════

let _allTenants = [];

async function loadTenants() {
    try {
        const res     = await fetch(`${API}/tenants`, { headers: authHeaders() });
        const tenants = await res.json();

        if (!res.ok) { showToast('Failed to load tenants', 'error'); return; }

        _allTenants = tenants;
        renderTenantList(tenants);
        populateTenantSelects(tenants);

    } catch (err) {
        showToast('Failed to load tenants', 'error');
        console.error(err);
    }
}

function filterTenants() {
    const q        = document.getElementById('tenantSearch').value.toLowerCase();
    const filtered = _allTenants.filter(t =>
        t.name.toLowerCase().includes(q) || (t.phone || '').includes(q)
    );
    renderTenantList(filtered);
}

async function loadTenantProfile(id) {
    try {
        const res  = await fetch(`${API}/tenant/${id}`, { headers: authHeaders() });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Failed to load profile', 'error'); return; }

        renderProfile(data);

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

async function addTenant() {
    const name     = document.getElementById('newName').value.trim();
    const phone    = document.getElementById('newPhone').value.trim();
    const email    = document.getElementById('newEmail').value.trim();
    const password = document.getElementById('newPassword').value;
    const dueDate  = document.getElementById('newDueDate').value || 5;

    if (!name || !phone || !email || !password) {
        showToast('All fields required', 'warn'); return;
    }

    try {
        const res  = await fetch(`${API}/register`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name, phone, email, password, dueDate: Number(dueDate) })
        });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Failed to create tenant', 'error'); return; }

        showToast(`${name} created successfully ✅`, 'success');
        ['newName', 'newPhone', 'newEmail', 'newPassword', 'newDueDate']
            .forEach(id => { document.getElementById(id).value = ''; });

        await loadTenants();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

async function deleteTenant(id) {
    try {
        const res  = await fetch(`${API}/tenant/${id}`, {
            method: 'DELETE', headers: authHeaders()
        });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Delete failed', 'error'); return; }

        showToast('Tenant deleted ✅', 'success');
        closeModal('modal-delete');

        document.getElementById('profileOutput').innerHTML =
            '<div class="empty-state"><span class="icon">👤</span>Select a tenant to view profile</div>';

        await loadTenants();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

async function resetTenantPassword(tenantId, newPassword) {
    try {
        const res  = await fetch(`${API}/reset-password`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ tenantId, newPassword })
        });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Reset failed', 'error'); return; }

        showToast('Password reset successfully ✅', 'success');
        closeModal('modal-reset');

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}


// ═══════════════════════════════════════
// HOUSES
// ═══════════════════════════════════════

async function loadHouses() {
    try {
        const res    = await fetch(`${API}/houses`, { headers: authHeaders() });
        const houses = await res.json();

        if (!res.ok) { showToast('Failed to load houses', 'error'); return; }

        renderHouseGrid(houses);
        populateHouseSelects(houses);

    } catch (err) {
        showToast('Failed to load houses', 'error');
        console.error(err);
    }
}

async function addHouse() {
    const name = document.getElementById('houseName').value.trim();
    const rent = document.getElementById('houseRent').value;

    if (!name || !rent) { showToast('Name and rent required', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/houses`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ name, rent: Number(rent) })
        });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Failed to add house', 'error'); return; }

        showToast(`House ${name} added ✅`, 'success');
        document.getElementById('houseName').value = '';
        document.getElementById('houseRent').value = '';
        await loadHouses();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

// ── deleteHouse — routes through danger modal ──
function deleteHouse(id) {
    // Find house name for the message
    const cards = document.querySelectorAll('.house-card');
    let houseName = 'this house';
    cards.forEach(c => {
        if (c.getAttribute('onclick')?.includes(id)) {
            houseName = c.querySelector('.house-name')?.textContent || houseName;
        }
    });

    openDangerModal({
        icon:    '🏡',
        title:   'Delete House',
        message: `Are you sure you want to permanently delete <strong>${houseName}</strong>?<br><br>
                  This action cannot be undone. Make sure no tenant is currently assigned to this house.`,
        label:   'Delete House',
        type:    'danger',
        onConfirm: async () => {
            const res  = await fetch(`${API}/house/${id}`, {
                method: 'DELETE', headers: authHeaders()
            });
            const data = await res.json();

            if (!res.ok) { showToast(data.message || 'Delete failed', 'error'); return; }

            showToast('House deleted ✅', 'success');
            await loadHouses();
        }
    });
}

async function assignHouse() {
    const tenantId = document.getElementById('tenantSelect').value;
    const houseId  = document.getElementById('houseSelect').value;

    if (!tenantId || !houseId) { showToast('Select both tenant and house', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/assign-house/${tenantId}/${houseId}`, {
            method: 'PUT', headers: authHeaders()
        });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Assign failed', 'error'); return; }

        showToast(data.message, 'success');
        await loadHouses();
        await loadTenants();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

// ── moveOutTenant — routes through danger modal ──
function moveOutTenant() {
    const tenantId  = document.getElementById('moveOutSelect').value;
    if (!tenantId) { showToast('Select a tenant', 'warn'); return; }

    const tenantName = document.getElementById('moveOutSelect')
        .options[document.getElementById('moveOutSelect').selectedIndex]?.text || 'this tenant';

    openDangerModal({
        icon:    '🚪',
        title:   'Move Out Tenant',
        message: `Are you sure you want to move out <strong>${tenantName}</strong>?<br><br>
                  Their house will be marked as <strong>available</strong> and they will receive a move-out notification email.`,
        label:   'Move Out',
        type:    'warn',
        onConfirm: async () => {
            const res  = await fetch(`${API}/move-out/${tenantId}`, {
                method: 'PUT', headers: authHeaders()
            });
            const data = await res.json();

            if (!res.ok) { showToast(data.message || 'Move out failed', 'error'); return; }

            showToast(data.message, 'success');
            await loadHouses();
            await loadTenants();
        }
    });
}


// ═══════════════════════════════════════
// PAYMENT SUMMARY
// ═══════════════════════════════════════

async function loadPaymentSummary() {
    const tenantId = document.getElementById('payTenantSelect').value;
    const month    = document.getElementById('month').value.trim();
    const box      = document.getElementById('paymentSummaryBox');

    if (!tenantId || !month) { box.style.display = 'none'; return; }

    try {
        const res  = await fetch(
            `${API}/payments/summary/${tenantId}/${encodeURIComponent(month)}`,
            { headers: authHeaders() }
        );
        const data = await res.json();

        if (!res.ok) { box.style.display = 'none'; return; }

        document.getElementById('sumRent').textContent    = `Ksh ${Number(data.rentAmount).toLocaleString()}`;
        document.getElementById('sumPaid').textContent    = `Ksh ${Number(data.totalPaid).toLocaleString()}`;
        document.getElementById('sumBalance').textContent = `Ksh ${Number(data.balance).toLocaleString()}`;

        const statusEl = document.getElementById('sumStatus');
        statusEl.innerHTML = data.status === 'paid'
            ? '<span class="pill pill-green">Paid ✅</span>'
            : data.status === 'partial'
            ? '<span class="pill pill-yellow">Partial ⚠️</span>'
            : '<span class="pill pill-red">Unpaid ❌</span>';

        const pct = data.rentAmount > 0
            ? Math.min(100, Math.round((data.totalPaid / data.rentAmount) * 100))
            : 0;
        const bar = document.getElementById('progressBar');
        bar.style.width = `${pct}%`;
        bar.className   = `payment-progress-bar ${data.status === 'paid' ? 'paid' : 'partial'}`;
        document.getElementById('progressLabel').textContent = `${pct}% paid`;

        if (data.status !== 'paid') document.getElementById('amount').value = data.balance;

        box.style.display = 'block';

    } catch (err) {
        console.error('loadPaymentSummary error:', err);
        document.getElementById('paymentSummaryBox').style.display = 'none';
    }
}

async function loadModalSummary() {
    const tenantId = document.getElementById('payModalTenantId').value;
    const month    = document.getElementById('payModalMonth').value.trim();
    const box      = document.getElementById('modalSummaryBox');

    if (!tenantId || !month) { box.style.display = 'none'; return; }

    try {
        const res  = await fetch(
            `${API}/payments/summary/${tenantId}/${encodeURIComponent(month)}`,
            { headers: authHeaders() }
        );
        const data = await res.json();

        if (!res.ok) { box.style.display = 'none'; return; }

        document.getElementById('modalSumRent').textContent    = `Ksh ${Number(data.rentAmount).toLocaleString()}`;
        document.getElementById('modalSumPaid').textContent    = `Ksh ${Number(data.totalPaid).toLocaleString()}`;
        document.getElementById('modalSumBalance').textContent = `Ksh ${Number(data.balance).toLocaleString()}`;

        const statusEl = document.getElementById('modalSumStatus');
        statusEl.innerHTML = data.status === 'paid'
            ? '<span class="pill pill-green">Paid ✅</span>'
            : data.status === 'partial'
            ? '<span class="pill pill-yellow">Partial ⚠️</span>'
            : '<span class="pill pill-red">Unpaid ❌</span>';

        const pct = data.rentAmount > 0
            ? Math.min(100, Math.round((data.totalPaid / data.rentAmount) * 100))
            : 0;
        const bar = document.getElementById('modalProgressBar');
        bar.style.width = `${pct}%`;
        bar.className   = `payment-progress-bar ${data.status === 'paid' ? 'paid' : 'partial'}`;

        //auto-fill amount if not fully paid
        if (data.status !== 'paid') document.getElementById('payModalAmount').value = data.balance;

        box.style.display = 'block';

    } catch (err) {
        console.error('loadModalSummary error:', err);
        document.getElementById('modalSummaryBox').style.display = 'none';
    }
}


// ═══════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════

async function makePayment() {
    const tenantId = document.getElementById('payTenantSelect').value;
    const amount   = document.getElementById('amount').value;
    const month    = document.getElementById('month').value.trim();
    const method   = document.getElementById('payMethod').value;
    const note     = document.getElementById('payNote').value.trim();

    if (!tenantId || !amount || !month) { showToast('All fields required', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/payments`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ tenantId, amount: Number(amount), month, method, note })
        });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Payment failed', 'error'); return; }

        showToast('Payment recorded & receipt emailed ✅', 'success');
        await loadTenants();
        loadArrears();
        if (data.paymentId) loadAutoReceipt(data.paymentId);
        loadPaymentSummary();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

async function submitModalPayment() {
    const tenantId = document.getElementById('payModalTenantId').value;
    const amount   = document.getElementById('payModalAmount').value;
    const month    = document.getElementById('payModalMonth').value.trim();
    const method   = document.getElementById('payModalMethod').value;
    const note     = document.getElementById('payModalNote').value.trim();

    if (!amount || !month) { showToast('Fill all fields', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/payments`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ tenantId, amount: Number(amount), month, method, note })
        });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Payment failed', 'error'); return; }

        showToast('Payment recorded ✅', 'success');
        closeModal('modal-pay');
        await loadTenants();
        loadArrears();
        if (data.paymentId) { showSection('payments'); loadAutoReceipt(data.paymentId); }

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

async function loadAutoReceipt(paymentId) {
    try {
        const res  = await fetch(`${API}/receipt/${paymentId}`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) return;
        renderReceipt(data, 'autoReceipt');
    } catch (err) {
        console.error('loadAutoReceipt error:', err);
    }
}

async function loadReceipt() {
    const id = document.getElementById('paymentId').value.trim();
    if (!id) { showToast('Enter a payment ID', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/receipt/${id}`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) { showToast('Receipt not found', 'error'); return; }
        renderReceipt(data, 'receiptOutput');
    } catch (err) {
        showToast('Network error', 'error');
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
        a.href = url; a.download = `receipt-${paymentId}.pdf`;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (err) {
        showToast('Failed to download PDF', 'error');
        console.error(err);
    }
}


// ═══════════════════════════════════════
// ARREARS
// ═══════════════════════════════════════

async function loadArrears() {
    const monthInput = document.getElementById('arrearsMonth');
    const month      = monthInput ? monthInput.value.trim() : '';
    const url        = month
        ? `${API}/arrears/${encodeURIComponent(month)}`
        : `${API}/arrears`;

    try {
        const res  = await fetch(url, { headers: authHeaders() });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.message || `Failed to load arrears (${res.status})`, 'error');
            return;
        }
        const data = await res.json();
        if (!Array.isArray(data)) { showToast('Unexpected server response', 'error'); return; }

        renderArrearsTable(data);

        const badge = document.getElementById('arrearsBadge');
        if (badge) {
            badge.textContent   = data.length;
            badge.style.display = data.length > 0 ? 'inline-block' : 'none';
        }
    } catch (err) {
        showToast('Failed to load arrears', 'error');
        console.error('loadArrears error:', err);
    }
}


// ═══════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════

async function loadAdminChat() {
    const tenantId = document.getElementById('chatTenant').value;
    if (!tenantId) return;

    try {
        const res  = await fetch(`${API}/messages/thread/${tenantId}`, { headers: authHeaders() });
        const msgs = await res.json();
        if (!res.ok) { showToast('Failed to load messages', 'error'); return; }

        renderChat(msgs, tenantId);
        await fetch(`${API}/messages/read/${tenantId}`, { method: 'PUT', headers: authHeaders() });
        loadUnread();
    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

async function sendAdminMessage() {
    const tenantId = document.getElementById('chatTenant').value;
    const text     = document.getElementById('adminMsg').value.trim();
    if (!tenantId) { showToast('Select a tenant first', 'warn'); return; }
    if (!text) return;

    try {
        const res  = await fetch(`${API}/messages/reply`, {
            method: 'POST', headers: authHeaders(),
            body:   JSON.stringify({ tenantId, text })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Send failed', 'error'); return; }
        document.getElementById('adminMsg').value = '';
        await loadAdminChat();
    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

document.getElementById('adminMsg').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAdminMessage(); }
});

async function loadUnread() {
    try {
        const res  = await fetch(`${API}/messages/unread`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) return;

        renderUnreadSummary(data);

        const total    = data.reduce((s, d) => s + d.count, 0);
        const badge    = document.getElementById('msgBadge');
        const navBadge = document.querySelector('.nav-item[onclick*="messages"] .nav-badge');
        if (total > 0) {
            if (badge)    { badge.textContent = total; badge.style.display = 'inline-block'; }
            if (navBadge) { navBadge.textContent = total; navBadge.style.display = 'inline-block'; }
        } else {
            if (badge)    badge.style.display = 'none';
            if (navBadge) navBadge.style.display = 'none';
        }
    } catch (err) {
        console.error('loadUnread error:', err);
    }
}


// ═══════════════════════════════════════
// RULES
// ═══════════════════════════════════════

async function addRule() {
    const title   = document.getElementById('ruleTitle').value.trim();
    const content = document.getElementById('ruleContent').value.trim();
    if (!title || !content) { showToast('Title and content required', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/rules`, {
            method: 'POST', headers: authHeaders(),
            body:   JSON.stringify({ title, content })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to add rule', 'error'); return; }

        showToast('Rule added ✅', 'success');
        document.getElementById('ruleTitle').value   = '';
        document.getElementById('ruleContent').value = '';
        await loadRules();
    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

// ── deleteRule — routes through danger modal ──
function deleteRule(id) {
    // Find rule title from rendered list
    const ruleEls  = document.querySelectorAll('#rulesList [data-rule-id]');
    let   ruleTitle = 'this rule';

    // Fallback: find by searching rendered rule buttons
    document.querySelectorAll('#rulesList button').forEach(btn => {
        if (btn.getAttribute('onclick')?.includes(id)) {
            const titleEl = btn.closest('div[style]')?.querySelector('[style*="font-weight:600"]');
            if (titleEl) ruleTitle = titleEl.textContent;
        }
    });

    openDangerModal({
        icon:    '📜',
        title:   'Delete Rule',
        message: `Are you sure you want to delete <strong>${ruleTitle}</strong>?<br><br>
                  This rule will be permanently removed and tenants will no longer see it.`,
        label:   'Delete Rule',
        type:    'danger',
        onConfirm: async () => {
            const res  = await fetch(`${API}/rules/${id}`, {
                method: 'DELETE', headers: authHeaders()
            });
            const data = await res.json();
            if (!res.ok) { showToast(data.message || 'Delete failed', 'error'); return; }
            showToast('Rule deleted ✅', 'success');
            await loadRules();
        }
    });
}

async function loadRules() {
    try {
        const res   = await fetch(`${API}/rules`, { headers: authHeaders() });
        const rules = await res.json();
        if (!res.ok) { showToast('Failed to load rules', 'error'); return; }
        renderRules(rules);
    } catch (err) {
        showToast('Failed to load rules', 'error');
        console.error(err);
    }
}


// ═══════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════

async function addAnnouncement() {
    const message = document.getElementById('announcementText').value.trim();
    if (!message) { showToast('Write something first', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/announcements`, {
            method: 'POST', headers: authHeaders(),
            body:   JSON.stringify({ message })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Post failed', 'error'); return; }

        showToast('Announcement posted ✅', 'success');
        document.getElementById('announcementText').value = '';
        await loadAnnouncements();
    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

// ── deleteAnnouncement — routes through danger modal ──
function deleteAnnouncement(id) {
    openDangerModal({
        icon:    '📢',
        title:   'Delete Announcement',
        message: `Are you sure you want to delete this announcement?<br><br>
                  It will be permanently removed and tenants will no longer see it.`,
        label:   'Delete Announcement',
        type:    'danger',
        onConfirm: async () => {
            const res  = await fetch(`${API}/announcements/${id}`, {
                method: 'DELETE', headers: authHeaders()
            });
            const data = await res.json();
            if (!res.ok) { showToast(data.message || 'Delete failed', 'error'); return; }
            showToast('Announcement deleted ✅', 'success');
            await loadAnnouncements();
        }
    });
}

async function loadAnnouncements() {
    try {
        const res  = await fetch(`${API}/announcements`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) return;
        renderAnnouncements(data);
    } catch (err) {
        console.error('loadAnnouncements error:', err);
    }
}


// ═══════════════════════════════════════
// MAINTENANCE MODE
// ═══════════════════════════════════════

async function syncMaintenanceToggle() {
    try {
        const res  = await fetch(`${API}/maintenance`, { headers: authHeaders() });
        const data = await res.json();
        const toggle = document.getElementById('maintenanceToggle');
        const chip   = document.getElementById('maintenanceChip');
        if (toggle) toggle.checked     = data.maintenanceMode;
        if (chip)   chip.style.display = data.maintenanceMode ? 'inline-block' : 'none';
    } catch (err) {
        console.error('Could not sync maintenance state:', err.message);
    }
}

async function toggleMaintenance() {
    const on  = document.getElementById('maintenanceToggle').checked;
    const msg = on
        ? (prompt('Optional: maintenance message for tenants (press OK for default)') || '')
        : '';

    try {
        const res  = await fetch(`${API}/maintenance`, {
            method: 'PUT', headers: authHeaders(),
            body:   JSON.stringify({
                maintenanceMode:    on,
                maintenanceMessage: msg || 'The system is currently under maintenance. Please check back later.'
            })
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.message || 'Failed to update maintenance mode', 'error');
            document.getElementById('maintenanceToggle').checked = !on;
            return;
        }
        const chip = document.getElementById('maintenanceChip');
        chip.style.display = on ? 'inline-block' : 'none';
        showToast(
            on ? '🔧 Maintenance mode ON — tenants are locked out' : '✅ Maintenance mode OFF',
            on ? 'warn' : 'success'
        );
    } catch (err) {
        showToast('Network error', 'error');
        document.getElementById('maintenanceToggle').checked = !on;
        console.error(err);
    }
}


// ═══════════════════════════════════════
// MODAL TRIGGERS (from tenant context menu)
// ═══════════════════════════════════════

function openPayModal(tenant) {
    document.getElementById('payModalTenantId').value         = tenant._id;
    document.getElementById('payModalTenantName').textContent = `Paying for: ${tenant.name}`;
    document.getElementById('payModalMonth').value            = '';
    document.getElementById('payModalAmount').value           = '';
    document.getElementById('payModalNote').value             = '';
    document.getElementById('modalSummaryBox').style.display  = 'none';
    openModal('modal-pay');
}

function openResetModal(tenant) {
    document.getElementById('resetModalTenantId').value         = tenant._id;
    document.getElementById('resetModalTenantName').textContent = `Reset password for: ${tenant.name}`;
    document.getElementById('newResetPassword').value           = '';
    openModal('modal-reset');
}

function openDeleteModal(tenant) {
    document.getElementById('deleteModalTenantId').value         = tenant._id;
    document.getElementById('deleteModalTenantName').textContent = tenant.name;
    openModal('modal-delete');
}

async function submitResetPassword() {
    const tenantId    = document.getElementById('resetModalTenantId').value;
    const newPassword = document.getElementById('newResetPassword').value;
    if (!newPassword) { showToast('Enter a new password', 'warn'); return; }
    await resetTenantPassword(tenantId, newPassword);
}

async function submitDeleteTenant() {
    const id = document.getElementById('deleteModalTenantId').value;
    await deleteTenant(id);
}


// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('theme') || 'dark';
    setTheme(saved);

    syncMaintenanceToggle();

    const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const dashMonthEl  = document.getElementById('dashMonth');
    if (dashMonthEl) dashMonthEl.value = currentMonth;

    loadTenants();
    loadHouses();
    loadAnnouncements();
    loadRules();
    loadUnread();
    loadDashboard();
});


// ═══════════════════════════════════════
// POLLING INTERVALS
// ═══════════════════════════════════════

setInterval(loadUnread,   15000);
setInterval(loadHouses,   30000);
setInterval(loadArrears,  60000);
setInterval(loadTenants,  30000);
setInterval(() => {
    const tenantId = document.getElementById('chatTenant')?.value;
    if (tenantId) loadAdminChat();
}, 15000);