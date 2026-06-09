// ═══════════════════════════════════════════════════════
//  stacklord.js — Stacklord Console Logic (SaaS version)
//  Routes covered:
//    GET  /stacklord/stats
//    GET  /stacklord/landlords
//    POST /stacklord/suspend/:id
//    POST /stacklord/unsuspend/:id
//    POST /stacklord/extend/:id
//    GET  /stacklord/subscription-payments
//    GET  /stacklord/plans
//    POST /stacklord/plans
//    PUT  /stacklord/plans/:id
//    DELETE /stacklord/plans/:id
//    POST /stacklord/plans/:id/toggle
//    GET  /stacklord/listings-pending
//    GET  /stacklord/listings-approved
//    POST /stacklord/properties/:id/approve
//    GET  /stacklord/inquiries
// ═══════════════════════════════════════════════════════

const API = window.API || (typeof CONFIG !== 'undefined' ? CONFIG.API_URL : '');

let STACKLORD_KEY     = '';
let subChartInstance  = null;
let _allLandlords     = [];
let _activeLandlordId = null;
let _listingsTab      = 'pending';
let _inquiriesPage    = 1;
let _pendingInterval  = null;

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}

function stacklordFetch(url, options = {}) {
    return fetch(`${API}${url}`, {
        ...options,
        headers: {
            'Content-Type':    'application/json',
            'x-stacklord-key': STACKLORD_KEY,
            ...(options.headers || {})
        }
    });
}

function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className   = 'show ' + type;
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.className = ''; }, 3500);
}

function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

function statusBadge(status) {
    const map = {
        trial:     `<span class="status-badge badge-trial">    <span class="status-badge-dot"></span>Trial     </span>`,
        active:    `<span class="status-badge badge-active">   <span class="status-badge-dot"></span>Active    </span>`,
        grace:     `<span class="status-badge badge-grace">    <span class="status-badge-dot"></span>Grace     </span>`,
        expired:   `<span class="status-badge badge-expired">  <span class="status-badge-dot"></span>Expired   </span>`,
        suspended: `<span class="status-badge badge-suspended"><span class="status-badge-dot"></span>Suspended </span>`
    };
    return map[status] || `<span class="status-badge">${escHtml(status || '—')}</span>`;
}

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateShort(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatKsh(n) { return 'Ksh ' + Number(n || 0).toLocaleString(); }

function daysColor(days) {
    if (days > 14) return 'var(--green)';
    if (days > 7)  return 'var(--amber)';
    return 'var(--red)';
}

function daysRemaining(landlord) {
    const now = new Date();
    let expiry = null;
    if (landlord.subscriptionStatus === 'trial')  expiry = landlord.trialEndsAt;
    if (landlord.subscriptionStatus === 'active') expiry = landlord.subscriptionExpiry;
    if (landlord.subscriptionStatus === 'grace')  expiry = landlord.gracePeriodUntil;
    if (!expiry) return 0;
    return Math.max(0, Math.ceil((new Date(expiry) - now) / (1000 * 60 * 60 * 24)));
}

function _inquiryStatusBadge(status) {
    const map = {
        new:       `<span class="pill pill-yellow">New</span>`,
        read:      `<span class="pill pill-cyan">Read</span>`,
        contacted: `<span class="pill pill-green">Contacted</span>`,
        archived:  `<span class="pill" style="background:rgba(74,85,104,0.2);color:var(--text-dim);border:1px solid var(--border)">Archived</span>`
    };
    return map[status] || `<span class="pill">${escHtml(status || '—')}</span>`;
}


// ═══════════════════════════════════════
// MOBILE SIDEBAR
// ═══════════════════════════════════════

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const isOpen  = sidebar.classList.contains('open');
    sidebar.classList.toggle('open', !isOpen);
    overlay.classList.toggle('open', !isOpen);
}

function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('open');
}


// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════

function login() {
    const key = document.getElementById('masterKey').value.trim();
    if (!key) { showLoginError('Enter your master key'); return; }
    STACKLORD_KEY = key;
    sessionStorage.setItem('stacklord_key', key);
    verifyKey(key);
}

async function verifyKey(key) {
    try {
        const res = await fetch(`${API}/stacklord/stats`, {
            headers: { 'x-stacklord-key': key }
        });

        if (res.status === 401) {
            STACKLORD_KEY = '';
            sessionStorage.removeItem('stacklord_key');
            showLoginError('Invalid master key ❌');
            return;
        }

        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('mainApp').style.display     = 'block';

        // Initial data loads
        loadOverview();
        loadAllLandlords();
        loadPlans();

        // Start polling for pending listings badge every 30 s
        pollPendingCount();
        if (_pendingInterval) clearInterval(_pendingInterval);
        _pendingInterval = setInterval(pollPendingCount, 30000);

    } catch (err) {
        showLoginError('Cannot reach server. Check your connection.');
    }
}

function showLoginError(msg) {
    const el = document.getElementById('loginError');
    if (el) el.textContent = msg;
    setTimeout(() => { if (el) el.textContent = ''; }, 3500);
}

function logout() {
    STACKLORD_KEY = '';
    sessionStorage.removeItem('stacklord_key');
    if (_pendingInterval) { clearInterval(_pendingInterval); _pendingInterval = null; }
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('mainApp').style.display     = 'none';
    document.getElementById('masterKey').value           = '';
    // reset sections
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById('sec-overview')?.classList.add('active');
}


// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════

function showSection(name) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    document.getElementById('sec-' + name)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => {
        if (n.getAttribute('onclick')?.includes(`'${name}'`)) n.classList.add('active');
    });

    const titles = {
        overview:          'Platform Overview',
        landlords:         'All Landlords',
        'landlord-detail': 'Landlord Detail',
        payments:          'Subscription Payments',
        plans:             'Subscription Plans',
        listings:          'Property Listings',
        inquiries:         'Public Inquiries'
    };
    document.getElementById('topbarTitle').textContent = titles[name] || name;

    // Lazy-load section data
    if (name === 'overview')  loadOverview();
    if (name === 'landlords') loadAllLandlords();
    if (name === 'payments')  loadSubPayments();
    if (name === 'plans')     loadPlans();
    if (name === 'listings')  loadListings();
    if (name === 'inquiries') loadInquiries(1);

    // Close mobile sidebar after nav
    closeSidebar();
}


// ═══════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════

async function loadOverview() {
    try {
        const [statsRes, pendingRes, approvedRes, inquiryRes] = await Promise.all([
            stacklordFetch('/stacklord/stats'),
            stacklordFetch('/stacklord/listings-pending'),
            stacklordFetch('/stacklord/listings-approved'),
            stacklordFetch('/stacklord/inquiries?page=1&limit=1')
        ]);

        // --- Stats ---
        if (statsRes.ok) {
            const { stats } = await statsRes.json();
            document.getElementById('statRevenue').textContent     = formatKsh(stats.totalRevenue);
            document.getElementById('statLandlords').textContent   = stats.totalLandlords;
            document.getElementById('statTenants').textContent     = stats.totalTenants;
            document.getElementById('statHouses').textContent      = stats.totalHouses;
            document.getElementById('statSubPayments').textContent = stats.totalPayments;

            const landlordBadge = document.getElementById('landlordsBadge');
            if (landlordBadge) {
                landlordBadge.textContent   = stats.totalLandlords;
                landlordBadge.style.display = stats.totalLandlords > 0 ? 'inline-block' : 'none';
            }

            // Status breakdown
            const breakdownEl = document.getElementById('statusBreakdown');
            if (breakdownEl && stats.byStatus?.length) {
                const colors = { trial:'var(--cyan)', active:'var(--green)', grace:'var(--amber)', expired:'var(--red)', suspended:'var(--red)' };
                breakdownEl.innerHTML = stats.byStatus.map(s => `
                    <div class="status-breakdown-item">
                        <div class="status-breakdown-count" style="color:${colors[s._id] || 'var(--text)'}">${s.count}</div>
                        <div class="status-breakdown-label">${s._id}</div>
                    </div>`).join('');
            } else if (breakdownEl) {
                breakdownEl.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem">No landlords yet</div>';
            }

            _renderAttentionList();
        }

        // --- Listings counts ---
        const pendingCount  = pendingRes.ok  ? (await pendingRes.json()).count  || 0 : 0;
        const approvedCount = approvedRes.ok ? (await approvedRes.json()).count || 0 : 0;

        _updatePendingBadge(pendingCount);

        const el1 = document.getElementById('overviewPendingBadge');
        const el2 = document.getElementById('overviewApprovedBadge');
        if (el1) el1.textContent = pendingCount;
        if (el2) el2.textContent = approvedCount;

        // --- Inquiry count ---
        if (inquiryRes.ok) {
            const { total } = await inquiryRes.json();
            const el3 = document.getElementById('overviewInquiriesBadge');
            if (el3) el3.textContent = total || 0;
        }

    } catch (err) {
        showToast('Network error loading overview', 'error');
        console.error('loadOverview error:', err.message);
    }
}

function _renderAttentionList() {
    const el = document.getElementById('attentionList');
    if (!el) return;

    const needsAttention = _allLandlords.filter(l =>
        ['suspended', 'expired', 'grace'].includes(l.subscriptionStatus)
    );

    if (!needsAttention.length) {
        el.innerHTML = '<div class="empty-state"><span class="icon">✅</span>All landlords in good standing</div>';
        return;
    }

    el.innerHTML = needsAttention.map(l => {
        const days = daysRemaining(l);
        return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0.65rem 0;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:0.5rem">
                <div>
                    <div style="font-size:0.85rem;font-weight:600;color:var(--text)">${escHtml(l.name)}</div>
                    <div style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim)">${escHtml(l.email)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
                    ${statusBadge(l.subscriptionStatus)}
                    ${days > 0 ? `<span style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:${daysColor(days)}">${days}d</span>` : ''}
                    <button class="btn btn-secondary btn-sm" onclick="openLandlordDetail('${l._id}')">View →</button>
                </div>
            </div>`;
    }).join('');
}


// ═══════════════════════════════════════
// PENDING LISTINGS — BADGE POLLING
// ═══════════════════════════════════════

async function pollPendingCount() {
    if (!STACKLORD_KEY) return;
    try {
        const res = await stacklordFetch('/stacklord/listings-pending');
        if (!res.ok) return;
        const data = await res.json();
        _updatePendingBadge(data.count || 0);
    } catch { /* fail silently */ }
}

function _updatePendingBadge(count) {
    // Sidebar nav badge
    const navBadge = document.getElementById('listingsBadge');
    if (navBadge) {
        navBadge.textContent   = count;
        navBadge.style.display = count > 0 ? 'inline-block' : 'none';
    }

    // Topbar alert banner
    const topbarAlert = document.getElementById('topbarPendingAlert');
    const topbarCount = document.getElementById('topbarPendingCount');
    if (topbarAlert) topbarAlert.classList.toggle('visible', count > 0);
    if (topbarCount) topbarCount.textContent = count;

    // Overview alert card
    const overviewAlert = document.getElementById('pendingListingsAlert');
    if (overviewAlert) overviewAlert.classList.toggle('visible', count > 0);
    const overviewCount = document.getElementById('overviewPendingCount');
    if (overviewCount) overviewCount.textContent = count;

    // Tab badge
    const tabBadge = document.getElementById('pendingTabBadge');
    if (tabBadge) {
        tabBadge.textContent   = count;
        tabBadge.style.display = count > 0 ? 'inline-block' : 'none';
    }
}


// ═══════════════════════════════════════
// ALL LANDLORDS
// ═══════════════════════════════════════

async function loadAllLandlords() {
    try {
        const res  = await stacklordFetch('/stacklord/landlords');
        const data = await res.json();
        if (!res.ok) { showToast('Failed to load landlords', 'error'); return; }

        _allLandlords = data;
        _renderLandlordsGrid(data);

        const badge = document.getElementById('landlordsBadge');
        if (badge) { badge.textContent = data.length; badge.style.display = data.length > 0 ? 'inline-block' : 'none'; }

        // Refresh attention list if overview is active
        _renderAttentionList();

    } catch (err) {
        showToast('Network error', 'error');
        console.error('loadAllLandlords error:', err.message);
    }
}

function filterLandlords() {
    const q      = (document.getElementById('landlordSearch')?.value || '').toLowerCase();
    const status = document.getElementById('landlordStatusFilter')?.value || '';

    const filtered = _allLandlords.filter(l => {
        const matchesQ = !q ||
            l.name.toLowerCase().includes(q) ||
            l.email.toLowerCase().includes(q) ||
            (l.propertyName || '').toLowerCase().includes(q);
        const matchesStatus = !status || l.subscriptionStatus === status;
        return matchesQ && matchesStatus;
    });

    _renderLandlordsGrid(filtered);
}

function _renderLandlordsGrid(landlords) {
    const grid = document.getElementById('landlordsGrid');

    if (!landlords.length) {
        grid.innerHTML = '<div class="empty-state"><span class="icon">🏠</span>No landlords found</div>';
        return;
    }

    grid.innerHTML = landlords.map(l => {
        const days = daysRemaining(l);
        return `
            <div class="landlord-row-card ${escHtml(l.subscriptionStatus)}" onclick="openLandlordDetail('${l._id}')">
                <div class="landlord-row-left">
                    <div class="landlord-row-name">${escHtml(l.name)}</div>
                    <div class="landlord-row-meta">${escHtml(l.email)} · ${escHtml(l.phone || '—')}</div>
                    <div class="landlord-row-property">
                        🏢 ${escHtml(l.propertyName || '—')} · 📍 ${escHtml(l.propertyLocation || '—')}
                    </div>
                    <div style="display:flex;gap:0.5rem;margin-top:0.35rem;flex-wrap:wrap">
                        <span class="pill pill-cyan">👥 ${l.tenantCount   || 0} tenants</span>
                        <span class="pill pill-cyan">🏡 ${l.houseCount    || 0} houses</span>
                        <span class="pill pill-cyan">🏢 ${l.propertyCount || 0} properties</span>
                        <span class="pill ${l.paymentConfigured ? 'pill-green' : 'pill-yellow'}">
                            ${l.paymentConfigured ? '💳 Payments Active' : '⚠️ Payments Not Set'}
                        </span>
                    </div>
                </div>
                <div class="landlord-row-right">
                    ${statusBadge(l.subscriptionStatus)}
                    ${days > 0 ? `<span style="font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:${daysColor(days)}">${days}d</span>` : ''}
                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();openLandlordDetail('${l._id}')">Manage →</button>
                </div>
            </div>`;
    }).join('');
}


// ═══════════════════════════════════════
// LANDLORD DETAIL
// ═══════════════════════════════════════

async function openLandlordDetail(landlordId) {
    _activeLandlordId = landlordId;
    showSection('landlord-detail');

    document.getElementById('detailLandlordId').value  = landlordId;
    document.getElementById('extendDays').value        = '';
    document.getElementById('extendNote').value        = '';
    document.getElementById('suspendReason').value     = '';

    await loadLandlordDetail(landlordId);
}

async function loadLandlordDetail(landlordId) {
    try {
        let landlord = _allLandlords.find(l => l._id === landlordId);

        if (!landlord) {
            const res  = await stacklordFetch('/stacklord/landlords');
            const data = await res.json();
            if (res.ok) _allLandlords = data;
            landlord = data.find(l => l._id === landlordId);
        }

        if (!landlord) { showToast('Landlord not found', 'error'); return; }

        const days = daysRemaining(landlord);
        const pct  = Math.min(100, Math.round((days / 30) * 100));
        const barClass = days > 14 ? 'green' : days > 7 ? 'amber' : 'red';

        document.getElementById('detailLandlordName').textContent = landlord.name;
        document.getElementById('topbarTitle').textContent        = landlord.name;

        document.getElementById('detailSubCard').innerHTML = `
            <div style="margin-bottom:1.25rem">
                <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.4rem;color:var(--text);margin-bottom:0.2rem">${escHtml(landlord.name)}</div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:var(--text-dim)">${escHtml(landlord.email)}</div>
                <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.25rem">🏢 ${escHtml(landlord.propertyName || '—')} · 📍 ${escHtml(landlord.propertyLocation || '—')}</div>
            </div>
            <div class="sub-card-row"><span class="sub-card-label">Status</span>        <span>${statusBadge(landlord.subscriptionStatus)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Plan</span>           <span class="sub-card-value">${escHtml(landlord.subscriptionPlan?.name || '—')}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Trial Ends</span>     <span class="sub-card-value">${formatDate(landlord.trialEndsAt)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Sub Expiry</span>     <span class="sub-card-value">${formatDate(landlord.subscriptionExpiry)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Grace Until</span>    <span class="sub-card-value">${formatDate(landlord.gracePeriodUntil)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Last Payment</span>   <span class="sub-card-value">${formatDate(landlord.lastSubscriptionPayment)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Days Remaining</span> <span class="sub-card-value" style="color:${daysColor(days)}">${days} days</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Tenants</span>        <span class="sub-card-value">${landlord.tenantCount   || 0}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Houses</span>         <span class="sub-card-value">${landlord.houseCount    || 0}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Properties</span>     <span class="sub-card-value">${landlord.propertyCount || 0}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">M-Pesa Config</span>  <span class="sub-card-value">${landlord.paymentConfigured ? '✅ Configured' : '⚠️ Not configured'}</span></div>
            ${landlord.suspendedReason ? `<div class="sub-card-row"><span class="sub-card-label">Suspension Reason</span><span class="sub-card-value" style="color:var(--red)">${escHtml(landlord.suspendedReason)}</span></div>` : ''}
            <div style="margin-top:1rem">
                <div style="display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim);margin-bottom:0.35rem">
                    <span>Subscription usage</span><span>${pct}%</span>
                </div>
                <div class="progress-track">
                    <div class="progress-fill ${barClass}" style="width:${pct}%"></div>
                </div>
            </div>`;

        await loadDetailPayments(landlordId);
        await loadSubChart(landlordId);

    } catch (err) {
        showToast('Failed to load landlord details', 'error');
        console.error('loadLandlordDetail error:', err.message);
    }
}

async function loadDetailPayments(landlordId) {
    try {
        const res  = await stacklordFetch('/stacklord/subscription-payments');
        if (!res.ok) return;
        const all  = await res.json();

        const payments = all.filter(p =>
            (p.landlord?._id === landlordId) || (p.landlord === landlordId)
        );

        const tbody = document.getElementById('detailPaymentsTable');
        if (!tbody) return;

        if (!payments.length) {
            tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><span class="icon">💳</span>No payments yet</div></td></tr>';
            return;
        }

        tbody.innerHTML = payments.map(p => `
            <tr>
                <td class="td-mono">${formatDate(p.paidAt || p.createdAt)}</td>
                <td>${escHtml(p.plan?.name || '—')}</td>
                <td class="td-mono" style="color:var(--green)">${formatKsh(p.amount)}</td>
                <td class="td-mono" style="color:var(--cyan)">${escHtml(p.mpesaCode || '—')}</td>
                <td class="td-mono">${formatDate(p.expiresAt)}</td>
                <td>${p.status === 'paid' ? '<span class="pill pill-green">Paid</span>' : p.status === 'pending' ? '<span class="pill pill-yellow">Pending</span>' : '<span class="pill pill-red">Failed</span>'}</td>
                <td>${p.manuallyExtended ? '<span class="pill pill-cyan">Manual</span>' : '<span class="pill pill-purple">M-Pesa</span>'}</td>
            </tr>`).join('');

    } catch (err) {
        console.error('loadDetailPayments error:', err.message);
    }
}

async function loadSubChart(landlordId) {
    try {
        const res  = await stacklordFetch('/stacklord/subscription-payments');
        if (!res.ok) return;
        const all  = await res.json();

        const payments = all
            .filter(p => ((p.landlord?._id === landlordId) || (p.landlord === landlordId)) && p.status === 'paid')
            .slice(-8)
            .reverse();

        const labels  = payments.map(p => formatDateShort(p.paidAt || p.createdAt));
        const amounts = payments.map(p => p.amount);

        const ctx = document.getElementById('subChart')?.getContext('2d');
        if (!ctx) return;

        if (subChartInstance) subChartInstance.destroy();

        subChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Ksh Paid', data: amounts,
                    backgroundColor: 'rgba(139,92,246,0.3)',
                    borderColor:     'rgba(139,92,246,0.8)',
                    borderWidth: 1, borderRadius: 4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: true,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#4a5568', font: { size: 10 } }, grid: { color: 'rgba(139,92,246,0.06)' } },
                    y: { ticks: { color: '#4a5568', font: { size: 10 } }, grid: { color: 'rgba(139,92,246,0.06)' } }
                }
            }
        });

    } catch (err) {
        console.error('loadSubChart error:', err.message);
    }
}


// ═══════════════════════════════════════
// SUBSCRIPTION PAYMENTS (all landlords)
// ═══════════════════════════════════════

async function loadSubPayments() {
    try {
        const res  = await stacklordFetch('/stacklord/subscription-payments');
        const data = await res.json();
        if (!res.ok) { showToast('Failed to load payments', 'error'); return; }

        const tbody = document.getElementById('paymentsTable');
        if (!tbody) return;

        if (!data.length) {
            tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><span class="icon">💳</span>No subscription payments yet</div></td></tr>';
            return;
        }

        tbody.innerHTML = data.map(p => `
            <tr>
                <td class="td-mono">${formatDate(p.paidAt || p.createdAt)}</td>
                <td>
                    <div style="font-size:0.82rem;color:var(--text)">${escHtml(p.landlord?.name || '—')}</div>
                    <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim)">${escHtml(p.landlord?.email || '—')}</div>
                </td>
                <td>${escHtml(p.plan?.name || '—')}</td>
                <td class="td-mono" style="color:var(--green)">${formatKsh(p.amount)}</td>
                <td class="td-mono" style="color:var(--cyan)">${escHtml(p.mpesaCode || '—')}</td>
                <td class="td-mono">${formatDate(p.expiresAt)}</td>
                <td>${p.status === 'paid' ? '<span class="pill pill-green">Paid</span>' : p.status === 'pending' ? '<span class="pill pill-yellow">Pending</span>' : '<span class="pill pill-red">Failed</span>'}</td>
                <td>${p.manuallyExtended ? '<span class="pill pill-cyan">Manual</span>' : '<span class="pill pill-purple">M-Pesa</span>'}</td>
            </tr>`).join('');

    } catch (err) {
        showToast('Network error', 'error');
        console.error('loadSubPayments error:', err.message);
    }
}


// ═══════════════════════════════════════
// LANDLORD CONTROLS — Extend / Suspend / Unsuspend
// ═══════════════════════════════════════

async function extendSubscription() {
    const landlordId = document.getElementById('detailLandlordId').value;
    const days       = parseInt(document.getElementById('extendDays').value);
    const note       = document.getElementById('extendNote').value.trim();

    if (!landlordId) { showToast('No landlord selected', 'error'); return; }
    if (!days || days < 1) { showToast('Enter a valid number of days', 'error'); return; }
    if (!confirm(`Extend subscription by ${days} days?`)) return;

    try {
        const res  = await stacklordFetch(`/stacklord/extend/${landlordId}`, {
            method: 'POST',
            body:   JSON.stringify({ days, note })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to extend', 'error'); return; }

        showToast(`✅ Extended ${days} days — new expiry: ${data.newExpiry}`, 'success');
        document.getElementById('extendDays').value = '';
        document.getElementById('extendNote').value = '';

        await loadAllLandlords();
        await loadLandlordDetail(landlordId);
        loadOverview();

    } catch (err) {
        showToast('Network error', 'error');
        console.error('extendSubscription error:', err.message);
    }
}

async function suspendLandlord() {
    const landlordId = document.getElementById('detailLandlordId').value;
    const reason     = document.getElementById('suspendReason').value.trim();

    if (!landlordId) { showToast('No landlord selected', 'error'); return; }
    if (!reason)     { showToast('Suspension reason is required', 'error'); return; }
    if (!confirm(`Suspend this landlord?\n\nReason: "${reason}"\n\nThis immediately blocks their dashboard access.`)) return;

    try {
        const res  = await stacklordFetch(`/stacklord/suspend/${landlordId}`, {
            method: 'POST',
            body:   JSON.stringify({ reason })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to suspend', 'error'); return; }

        showToast('🔒 Landlord suspended successfully', 'success');
        document.getElementById('suspendReason').value = '';

        await loadAllLandlords();
        await loadLandlordDetail(landlordId);
        loadOverview();

    } catch (err) {
        showToast('Network error', 'error');
        console.error('suspendLandlord error:', err.message);
    }
}

async function unsuspendLandlord() {
    const landlordId = document.getElementById('detailLandlordId').value;
    if (!landlordId) { showToast('No landlord selected', 'error'); return; }
    if (!confirm("Restore this landlord's access? Their subscription status will be recalculated.")) return;

    try {
        const res  = await stacklordFetch(`/stacklord/unsuspend/${landlordId}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to unsuspend', 'error'); return; }

        showToast('🔓 ' + data.message, 'success');

        await loadAllLandlords();
        await loadLandlordDetail(landlordId);
        loadOverview();

    } catch (err) {
        showToast('Network error', 'error');
        console.error('unsuspendLandlord error:', err.message);
    }
}


// ═══════════════════════════════════════
// PLANS
// ═══════════════════════════════════════

async function loadPlans() {
    try {
        const res  = await stacklordFetch('/stacklord/plans');
        const data = await res.json();
        if (!res.ok) return;

        const grid = document.getElementById('plansGrid');
        if (!grid) return;

        if (!data.length) {
            grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><span class="icon">📦</span>No plans yet — create your first plan</div>';
            return;
        }

        grid.innerHTML = data.map(plan => `
            <div class="plan-card ${!plan.isActive ? 'inactive' : ''}">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;gap:0.5rem;flex-wrap:wrap">
                    <div class="plan-card-name">${escHtml(plan.name)}</div>
                    ${plan.isActive ? '<span class="pill pill-green">Active</span>' : '<span class="pill pill-red">Inactive</span>'}
                </div>
                <div class="plan-card-price">${formatKsh(plan.price)}</div>
                <div class="plan-card-duration">${plan.durationDays} days · ${Math.round(plan.durationDays / 30 * 10) / 10} months</div>
                <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.75rem">
                    <span class="pill pill-cyan" style="font-size:0.58rem">Props: ${plan.maxProperties === -1 ? '∞' : plan.maxProperties}</span>
                    <span class="pill pill-cyan" style="font-size:0.58rem">Tenants/prop: ${plan.maxTenantsPerProperty === -1 ? '∞' : plan.maxTenantsPerProperty}</span>
                </div>
                ${plan.description ? `<div class="plan-card-desc">${escHtml(plan.description)}</div>` : ''}
                ${plan.features?.length ? `<ul class="plan-features">${plan.features.map(f => `<li>${escHtml(f)}</li>`).join('')}</ul>` : ''}
                <div class="plan-actions">
                    <button class="btn btn-secondary btn-sm" onclick="editPlan('${plan._id}')">✏️ Edit</button>
                    <button class="btn btn-${plan.isActive ? 'warn' : 'success'} btn-sm" onclick="togglePlan('${plan._id}')">
                        ${plan.isActive ? '⏸ Deactivate' : '▶ Activate'}
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="deletePlan('${plan._id}','${escHtml(plan.name)}')">🗑</button>
                </div>
            </div>`).join('');

    } catch (err) {
        showToast('Failed to load plans', 'error');
        console.error('loadPlans error:', err.message);
    }
}

async function savePlan() {
    const id                  = document.getElementById('planModalId').value.trim();
    const name                = document.getElementById('planName').value.trim();
    const price               = parseFloat(document.getElementById('planPrice').value);
    const durationDays        = parseInt(document.getElementById('planDuration').value);
    const description         = document.getElementById('planDescription').value.trim();
    const featuresRaw         = document.getElementById('planFeatures').value.trim();
    const sortOrder           = parseInt(document.getElementById('planSortOrder').value) || 0;
    const maxProperties       = parseInt(document.getElementById('planMaxProps').value)   ?? 1;
    const maxTenantsPerProperty = parseInt(document.getElementById('planMaxTenants').value) ?? 20;

    if (!name || !price || !durationDays) { showToast('Name, price and duration are required', 'error'); return; }

    const features = featuresRaw ? featuresRaw.split('\n').map(f => f.trim()).filter(Boolean) : [];
    const body     = { name, price, durationDays, description, features, sortOrder, maxProperties, maxTenantsPerProperty };
    const url      = id ? `/stacklord/plans/${id}` : '/stacklord/plans';
    const method   = id ? 'PUT' : 'POST';

    try {
        const res  = await stacklordFetch(url, { method, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to save plan', 'error'); return; }
        showToast(`Plan ${id ? 'updated' : 'created'} ✅`, 'success');
        closeModal('modal-plan');
        clearPlanForm();
        loadPlans();
    } catch (err) {
        showToast('Network error', 'error');
        console.error('savePlan error:', err.message);
    }
}

async function editPlan(id) {
    try {
        const res  = await stacklordFetch('/stacklord/plans');
        const data = await res.json();
        const plan = data.find(p => p._id === id);
        if (!plan) return;

        document.getElementById('planModalId').value      = plan._id;
        document.getElementById('planName').value         = plan.name;
        document.getElementById('planPrice').value        = plan.price;
        document.getElementById('planDuration').value     = plan.durationDays;
        document.getElementById('planDescription').value  = plan.description || '';
        document.getElementById('planFeatures').value     = (plan.features || []).join('\n');
        document.getElementById('planSortOrder').value    = plan.sortOrder || 0;
        document.getElementById('planMaxProps').value     = plan.maxProperties          ?? 1;
        document.getElementById('planMaxTenants').value   = plan.maxTenantsPerProperty  ?? 20;
        document.getElementById('planModalTitle').textContent = 'Edit Plan';

        openModal('modal-plan');
    } catch (err) {
        showToast('Failed to load plan', 'error');
        console.error('editPlan error:', err.message);
    }
}

async function togglePlan(id) {
    try {
        const res  = await stacklordFetch(`/stacklord/plans/${id}/toggle`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed', 'error'); return; }
        showToast(data.message, 'success');
        loadPlans();
    } catch (err) { showToast('Network error', 'error'); }
}

async function deletePlan(id, name) {
    if (!confirm(`Delete plan "${name}"? This cannot be undone.`)) return;
    try {
        const res  = await stacklordFetch(`/stacklord/plans/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed', 'error'); return; }
        showToast('Plan deleted ✅', 'success');
        loadPlans();
    } catch (err) { showToast('Network error', 'error'); }
}

function clearPlanForm() {
    ['planModalId','planName','planPrice','planDuration','planDescription','planFeatures'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('planSortOrder').value  = '0';
    document.getElementById('planMaxProps').value   = '1';
    document.getElementById('planMaxTenants').value = '20';
    document.getElementById('planModalTitle').textContent = 'Create Plan';
}


// ═══════════════════════════════════════
// PROPERTY LISTINGS
// ═══════════════════════════════════════

async function loadListings() {
    const pendingEl  = document.getElementById('listingsPendingContainer');
    const approvedEl = document.getElementById('listingsApprovedContainer');

    if (pendingEl)  pendingEl.innerHTML  = '<div class="empty-state"><span class="icon">⏳</span>Loading…</div>';
    if (approvedEl) approvedEl.innerHTML = '<div class="empty-state"><span class="icon">⏳</span>Loading…</div>';

    try {
        const [pendingRes, approvedRes] = await Promise.all([
            stacklordFetch('/stacklord/listings-pending'),
            stacklordFetch('/stacklord/listings-approved')
        ]);

        const pendingData  = pendingRes.ok  ? await pendingRes.json()  : { count: 0, properties: [] };
        const approvedData = approvedRes.ok ? await approvedRes.json() : { count: 0, properties: [] };

        _updatePendingBadge(pendingData.count || 0);
        _renderPendingListings(pendingData.properties || []);
        _renderApprovedListings(approvedData.properties || []);

        // Update overview quick stats
        const el2 = document.getElementById('overviewApprovedBadge');
        if (el2) el2.textContent = approvedData.count || 0;

    } catch (err) {
        showToast('Failed to load listings', 'error');
        console.error('loadListings error:', err.message);
        if (pendingEl)  pendingEl.innerHTML  = '<div class="empty-state"><span class="icon">⚠️</span>Failed to load</div>';
        if (approvedEl) approvedEl.innerHTML = '<div class="empty-state"><span class="icon">⚠️</span>Failed to load</div>';
    }
}

function switchListingsTab(tab) {
    _listingsTab = tab;
    document.getElementById('tabPending').classList.toggle('active',   tab === 'pending');
    document.getElementById('tabApproved').classList.toggle('active',  tab === 'approved');
    document.getElementById('listingsPendingContainer').style.display  = tab === 'pending'  ? 'block' : 'none';
    document.getElementById('listingsApprovedContainer').style.display = tab === 'approved' ? 'block' : 'none';
}

function _renderPendingListings(listings) {
    const container = document.getElementById('listingsPendingContainer');
    if (!container) return;

    if (!listings.length) {
        container.innerHTML = '<div class="empty-state"><span class="icon">✅</span>No listings pending approval — all clear!</div>';
        return;
    }

    container.innerHTML = listings.map(p => `
        <div class="listing-card pending">
            <div class="listing-thumb">
                ${p.photos?.length
                    ? `<img src="${escHtml(p.photos[0])}" alt="${escHtml(p.name)}" loading="lazy">`
                    : '🏡'}
            </div>
            <div class="listing-info">
                <div class="listing-name">${escHtml(p.name)}</div>
                <div class="listing-meta">📍 ${escHtml(p.location || '—')}</div>
                <div class="listing-landlord">Landlord: ${escHtml(p.landlord?.name || '—')} · ${escHtml(p.landlord?.email || '—')}</div>
                <div style="margin-top:0.35rem;display:flex;gap:0.4rem;flex-wrap:wrap">
                    <span class="pill pill-yellow">⏳ Awaiting Approval</span>
                    ${p.photos?.length ? `<span class="pill pill-cyan">${p.photos.length} photo${p.photos.length > 1 ? 's' : ''}</span>` : '<span class="pill" style="background:rgba(74,85,104,0.15);color:var(--text-dim);border:1px solid var(--border)">No photos</span>'}
                </div>
            </div>
            <div class="listing-actions">
                <button class="btn btn-success" onclick="approveListing('${p._id}', true, '${escHtml(p.name)}')">✅ Approve</button>
                <button class="btn btn-secondary btn-sm" onclick="approveListing('${p._id}', false, '${escHtml(p.name)}')">❌ Reject</button>
            </div>
        </div>`).join('');
}

function _renderApprovedListings(listings) {
    const container = document.getElementById('listingsApprovedContainer');
    if (!container) return;

    if (!listings.length) {
        container.innerHTML = '<div class="empty-state"><span class="icon">🏡</span>No approved listings yet</div>';
        return;
    }

    container.innerHTML = listings.map(p => `
        <div class="listing-card approved">
            <div class="listing-thumb">
                ${p.photos?.length
                    ? `<img src="${escHtml(p.photos[0])}" alt="${escHtml(p.name)}" loading="lazy">`
                    : '🏡'}
            </div>
            <div class="listing-info">
                <div class="listing-name">${escHtml(p.name)}</div>
                <div class="listing-meta">📍 ${escHtml(p.location || '—')}</div>
                <div class="listing-landlord">Landlord: ${escHtml(p.landlord?.name || '—')} · ${escHtml(p.landlord?.email || '—')}</div>
                <div style="margin-top:0.35rem;display:flex;gap:0.4rem;flex-wrap:wrap">
                    <span class="pill pill-green">✅ Live &amp; Public</span>
                    ${p.photos?.length ? `<span class="pill pill-cyan">${p.photos.length} photo${p.photos.length > 1 ? 's' : ''}</span>` : ''}
                </div>
            </div>
            <div class="listing-actions">
                <button class="btn btn-warn btn-sm" onclick="approveListing('${p._id}', false, '${escHtml(p.name)}')">⏸ Revoke</button>
            </div>
        </div>`).join('');
}

async function approveListing(id, approve, name) {
    const action = approve ? 'Approve and publish' : 'Revoke public listing for';
    if (!confirm(`${action} "${name}"?`)) return;

    try {
        const res  = await stacklordFetch(`/stacklord/properties/${id}/approve`, {
            method: 'POST',
            body:   JSON.stringify({ approve })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed', 'error'); return; }
        showToast(data.message || (approve ? '✅ Listing approved and live' : '⏸ Listing revoked'), 'success');
        await loadListings();
    } catch (err) {
        showToast('Network error', 'error');
        console.error('approveListing error:', err.message);
    }
}


// ═══════════════════════════════════════
// INQUIRIES
// ═══════════════════════════════════════

async function loadInquiries(page = 1) {
    _inquiriesPage = page;

    const tbody      = document.getElementById('inquiriesTable');
    const pagination = document.getElementById('inquiriesPagination');
    const statusFilter = document.getElementById('inquiryStatusFilter')?.value || '';

    if (tbody) tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><span class="icon">⏳</span>Loading…</div></td></tr>';
    if (pagination) pagination.innerHTML = '';

    try {
        let url = `/stacklord/inquiries?page=${page}&limit=20`;
        if (statusFilter) url += `&status=${encodeURIComponent(statusFilter)}`;

        const res  = await stacklordFetch(url);
        const data = await res.json();
        if (!res.ok) { showToast('Failed to load inquiries', 'error'); return; }

        const { inquiries, total, pages } = data;

        // Update badge (total count)
        const badge = document.getElementById('inquiriesBadge');
        if (badge) {
            badge.textContent   = total || 0;
            badge.style.display = total > 0 ? 'inline-block' : 'none';
        }

        // Update overview badge
        const overviewBadge = document.getElementById('overviewInquiriesBadge');
        if (overviewBadge) overviewBadge.textContent = total || 0;

        if (!inquiries?.length) {
            if (tbody) tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><span class="icon">📩</span>No inquiries yet</div></td></tr>';
            return;
        }

        if (tbody) {
            tbody.innerHTML = inquiries.map(inq => `
                <tr>
                    <td class="td-mono" style="white-space:nowrap">${formatDate(inq.createdAt)}</td>
                    <td>
                        <div style="font-size:0.82rem;color:var(--text);font-weight:500">${escHtml(inq.property?.name || '—')}</div>
                        <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim)">${escHtml(inq.property?.location || '')}</div>
                    </td>
                    <td>
                        <div style="font-size:0.82rem;color:var(--text)">${escHtml(inq.name)}</div>
                        <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--cyan)">${escHtml(inq.phone)}</div>
                        ${inq.email ? `<div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim)">${escHtml(inq.email)}</div>` : ''}
                    </td>
                    <td style="max-width:200px;font-size:0.78rem;color:var(--text-muted);line-height:1.5">
                        ${escHtml((inq.message || '').slice(0, 120))}${inq.message?.length > 120 ? '…' : ''}
                    </td>
                    <td>
                        <div style="font-size:0.78rem;color:var(--text-muted)">${escHtml(inq.landlord?.name || '—')}</div>
                        <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim)">${escHtml(inq.landlord?.email || '')}</div>
                    </td>
                    <td>${_inquiryStatusBadge(inq.status)}</td>
                </tr>`).join('');
        }

        // Pagination
        if (pagination && pages > 1) {
            let html = '';
            html += `<button class="btn btn-secondary btn-sm" onclick="loadInquiries(${page - 1})" ${page <= 1 ? 'disabled' : ''}>← Prev</button>`;

            for (let i = 1; i <= pages; i++) {
                if (pages > 7 && i > 2 && i < pages - 1 && Math.abs(i - page) > 1) {
                    if (i === 3 || i === pages - 2) html += `<span style="color:var(--text-dim);padding:0 0.25rem;font-family:'JetBrains Mono',monospace;font-size:0.7rem">…</span>`;
                    continue;
                }
                html += `<button class="btn btn-sm ${i === page ? 'btn-primary' : 'btn-secondary'}" onclick="loadInquiries(${i})">${i}</button>`;
            }

            html += `<button class="btn btn-secondary btn-sm" onclick="loadInquiries(${page + 1})" ${page >= pages ? 'disabled' : ''}>Next →</button>`;
            html += `<span style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim);margin-left:0.5rem">${total} total</span>`;
            pagination.innerHTML = html;

        } else if (pagination && total > 0) {
            pagination.innerHTML = `<span style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim);margin-top:0.75rem;display:block">${total} inquir${total === 1 ? 'y' : 'ies'} total</span>`;
        }

    } catch (err) {
        showToast('Network error', 'error');
        console.error('loadInquiries error:', err.message);
        if (tbody) tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><span class="icon">⚠️</span>Failed to load inquiries</div></td></tr>';
    }
}


// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
    // Auto-login if session key is saved
    const saved = sessionStorage.getItem('stacklord_key');
    if (saved) { STACKLORD_KEY = saved; verifyKey(saved); }

    // Close modal on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', function(e) {
            if (e.target === this) closeModal(this.id);
        });
    });

    // Close modal on Escape
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.open').forEach(m => closeModal(m.id));
            closeSidebar();
        }
    });

    // Master key enter key
    const keyInput = document.getElementById('masterKey');
    if (keyInput) keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
});