// ═══════════════════════════════════════════════════════
//  stacklord.js — Stacklord Console Logic (commission model)
// ═══════════════════════════════════════════════════════

const API = window.API || (typeof CONFIG !== 'undefined' ? CONFIG.API_URL : '');

let STACKLORD_KEY     = '';
let commissionChartInstance = null;
let _allLandlords     = [];
let _activeLandlordId = null;
let _listingsTab      = 'pending';
let _inquiriesPage    = 1;
let _paymentsPage     = 1;
let _pendingInterval  = null;
let _selectedPendingIds = new Set();
let _pendingListingsCache  = [];
let _approvedListingsCache = [];

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
    if (status === 'suspended') return `<span class="status-badge badge-suspended"><span class="status-badge-dot"></span>Suspended</span>`;
    return `<span class="status-badge badge-active"><span class="status-badge-dot"></span>Active</span>`;
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

function currentMonthLabel() {
    return new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
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

function _paymentStatusPill(status) {
    if (status === 'paid')    return '<span class="pill pill-green">Paid</span>';
    if (status === 'pending') return '<span class="pill pill-yellow">Pending</span>';
    return '<span class="pill pill-red">Failed</span>';
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
// PLATFORM MAINTENANCE — pre-login check
// ═══════════════════════════════════════

async function checkPlatformStatusForLockScreen() {
    try {
        const res  = await fetch(`${API}/platform-status`);
        const data = await res.json();
        const lock = document.getElementById('maintenanceLock');
        if (data.maintenanceMode) {
            document.getElementById('maintenanceLockDesc').textContent =
                data.message || 'Affordable Rentals is temporarily down for maintenance.';
            lock.classList.add('show');
        } else {
            lock.classList.remove('show');
        }
    } catch (err) {
        console.error('platform-status check failed:', err.message);
    }
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
            showLoginError('Invalid master key');
            return;
        }

        document.getElementById('maintenanceLock').classList.remove('show');
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('mainApp').style.display     = 'block';

        loadOverview();
        loadAllLandlords();
        loadSystemStatus();

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
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById('sec-overview')?.classList.add('active');
    checkPlatformStatusForLockScreen();
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
        overview:            'Platform Overview',
        landlords:           'All Landlords',
        'landlord-detail':   'Landlord Detail',
        listings:            'Property Listings',
        inquiries:           'Public Inquiries',
        commission:          'Commission',
        'commission-payments': 'Commission Payment Log',
        system:              'Platform Controls'
    };
    document.getElementById('topbarTitle').textContent = titles[name] || name;

    if (name === 'overview')             loadOverview();
    if (name === 'landlords')            loadAllLandlords();
    if (name === 'listings')             loadListings();
    if (name === 'inquiries')            loadInquiries(1);
    if (name === 'commission')           loadCommissionSection();
    if (name === 'commission-payments')  loadSubPayments(1);
    if (name === 'system')               loadSystemSection();

    closeSidebar();
}


// ═══════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════

async function loadOverview() {
    try {
        const [statsRes, pendingRes, approvedRes, inquiryRes, statusRes] = await Promise.all([
            stacklordFetch('/stacklord/stats'),
            stacklordFetch('/stacklord/listings-pending'),
            stacklordFetch('/stacklord/listings-approved'),
            stacklordFetch('/stacklord/inquiries?page=1&limit=1'),
            fetch(`${API}/platform-status`)
        ]);

        if (statsRes.ok) {
            const { stats } = await statsRes.json();
            document.getElementById('statRevenue').textContent     = formatKsh(stats.totalRevenue);
            document.getElementById('statLandlords').textContent   = stats.totalLandlords;
            document.getElementById('statTenants').textContent     = stats.totalTenants;
            document.getElementById('statHouses').textContent      = stats.totalHouses;
            document.getElementById('statSubPayments').textContent = stats.totalCommissionPayments;
            document.getElementById('statRate').textContent        = `${stats.commissionPercentage}%`;

            const landlordBadge = document.getElementById('landlordsBadge');
            if (landlordBadge) {
                landlordBadge.textContent   = stats.totalLandlords;
                landlordBadge.style.display = stats.totalLandlords > 0 ? 'inline-block' : 'none';
            }

            const breakdownEl = document.getElementById('statusBreakdown');
            if (breakdownEl && stats.byStatus?.length) {
                const colors = { active: 'var(--green)', suspended: 'var(--red)' };
                breakdownEl.innerHTML = stats.byStatus.map(s => `
                    <div class="status-breakdown-item">
                        <div class="status-breakdown-count" style="color:${colors[s._id] || 'var(--text)'}">${s.count}</div>
                        <div class="status-breakdown-label">${s._id}</div>
                    </div>`).join('');
            } else if (breakdownEl) {
                breakdownEl.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem">No landlords yet</div>';
            }
        }

        const pendingData  = pendingRes.ok  ? await pendingRes.json()  : { count: 0 };
        const approvedData = approvedRes.ok ? await approvedRes.json() : { count: 0 };

        _updatePendingBadge(pendingData.count || 0);

        const el1 = document.getElementById('overviewPendingBadge');
        const el2 = document.getElementById('overviewApprovedBadge');
        if (el1) el1.textContent = pendingData.count  || 0;
        if (el2) el2.textContent = approvedData.count || 0;

        document.getElementById('pendingListingsAlert')?.classList.toggle('visible', (pendingData.count || 0) > 0);

        if (inquiryRes.ok) {
            const { total } = await inquiryRes.json();
            const el3 = document.getElementById('overviewInquiriesBadge');
            if (el3) el3.textContent = total || 0;
        }

        if (statusRes.ok) {
            const status = await statusRes.json();
            document.getElementById('maintAlert')?.classList.toggle('visible', !!status.maintenanceMode);
            _updateMaintenanceChrome(!!status.maintenanceMode);
        }

        // Auto-approve badge + attention list both need /stacklord/commission-rate
        const rateRes = await stacklordFetch('/stacklord/commission-rate');
        if (rateRes.ok) {
            const settings = await rateRes.json();
            const el4 = document.getElementById('overviewAutoApproveBadge');
            if (el4) {
                el4.textContent = settings.autoApproveListings ? 'ON' : 'OFF';
                el4.className   = 'pill ' + (settings.autoApproveListings ? 'pill-green' : 'pill-red');
            }
        }

        _renderAttentionList();

    } catch (err) {
        showToast('Network error loading overview', 'error');
        console.error('loadOverview error:', err.message);
    }
}

async function _renderAttentionList() {
    const el = document.getElementById('attentionList');
    if (!el) return;

    if (!_allLandlords.length) {
        try {
            const res  = await stacklordFetch('/stacklord/landlords');
            if (res.ok) _allLandlords = await res.json();
        } catch { /* ignore */ }
    }

    const suspended = _allLandlords.filter(l => l.accountStatus === 'suspended');

    let outstanding = [];
    try {
        const res = await stacklordFetch(`/stacklord/commission/outstanding?month=${encodeURIComponent(currentMonthLabel())}`);
        if (res.ok) outstanding = (await res.json()).outstanding || [];
    } catch { /* ignore */ }

    if (!suspended.length && !outstanding.length) {
        el.innerHTML = `<div class="empty-state"><span class="icon">${ICON('checkCircle',24)}</span>All landlords in good standing</div>`;
        return;
    }

    let html = '';

    suspended.forEach(l => {
        html += `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0.65rem 0;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:0.5rem">
                <div>
                    <div style="font-size:0.85rem;font-weight:600;color:var(--text)">${escHtml(l.name)}</div>
                    <div style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim)">${escHtml(l.email)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
                    ${statusBadge('suspended')}
                    <button class="btn btn-secondary btn-sm" onclick="openLandlordDetail('${l._id}')">View →</button>
                </div>
            </div>`;
    });

    outstanding.forEach(o => {
        html += `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0.65rem 0;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:0.5rem">
                <div>
                    <div style="font-size:0.85rem;font-weight:600;color:var(--text)">${escHtml(o.landlordName)}</div>
                    <div style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim)">${escHtml(o.landlordEmail)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
                    <span class="pill pill-yellow" style="display:inline-flex;align-items:center;gap:3px">${ICON('cash',10)} Owes ${formatKsh(o.totalOwed)}</span>
                    <button class="btn btn-secondary btn-sm" onclick="openLandlordDetail('${o.landlordId}')">View →</button>
                </div>
            </div>`;
    });

    el.innerHTML = html;
}

function _updateMaintenanceChrome(isOn) {
    document.getElementById('topbarMaintBadge')?.classList.toggle('visible', isOn);
    const navBadge = document.getElementById('maintenanceBadge');
    if (navBadge) navBadge.style.display = isOn ? 'inline-block' : 'none';
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

        const statusRes = await fetch(`${API}/platform-status`);
        if (statusRes.ok) {
            const status = await statusRes.json();
            _updateMaintenanceChrome(!!status.maintenanceMode);
        }
    } catch { /* fail silently */ }
}

function _updatePendingBadge(count) {
    const navBadge = document.getElementById('listingsBadge');
    if (navBadge) {
        navBadge.textContent   = count;
        navBadge.style.display = count > 0 ? 'inline-block' : 'none';
    }

    const topbarAlert = document.getElementById('topbarPendingAlert');
    const topbarCount = document.getElementById('topbarPendingCount');
    if (topbarAlert) topbarAlert.classList.toggle('visible', count > 0);
    if (topbarCount) topbarCount.textContent = count;

    const overviewAlert = document.getElementById('pendingListingsAlert');
    if (overviewAlert) overviewAlert.classList.toggle('visible', count > 0);
    const overviewCount = document.getElementById('overviewPendingCount');
    if (overviewCount) overviewCount.textContent = count;

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
        const matchesStatus = !status || l.accountStatus === status;
        return matchesQ && matchesStatus;
    });

    _renderLandlordsGrid(filtered);
}

function _renderLandlordsGrid(landlords) {
    const grid = document.getElementById('landlordsGrid');

    if (!landlords.length) {
        grid.innerHTML = `<div class="empty-state"><span class="icon">${ICON('home',24)}</span>No landlords found</div>`;
        return;
    }

    grid.innerHTML = landlords.map(l => `
        <div class="landlord-row-card ${escHtml(l.accountStatus)}" onclick="openLandlordDetail('${l._id}')">
            <div class="landlord-row-left">
                <div class="landlord-row-name">${escHtml(l.name)}</div>
                <div class="landlord-row-meta">${escHtml(l.email)} · ${escHtml(l.phone || '—')}</div>
                <div class="landlord-row-property" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
                    <span style="display:inline-flex;align-items:center;gap:3px">${ICON('properties',11)} ${escHtml(l.propertyName || '—')}</span>
                    <span style="display:inline-flex;align-items:center;gap:3px">${ICON('pin',11)} ${escHtml(l.propertyLocation || '—')}</span>
                </div>
                <div style="display:flex;gap:0.5rem;margin-top:0.35rem;flex-wrap:wrap">
                    <span class="pill pill-cyan" style="display:inline-flex;align-items:center;gap:3px">${ICON('tenants',10)} ${l.tenantCount   || 0} tenants</span>
                    <span class="pill pill-cyan" style="display:inline-flex;align-items:center;gap:3px">${ICON('houses',10)} ${l.houseCount    || 0} houses</span>
                    <span class="pill pill-cyan" style="display:inline-flex;align-items:center;gap:3px">${ICON('properties',10)} ${l.propertyCount || 0} properties</span>
                    <span class="pill ${l.paymentConfigured ? 'pill-green' : 'pill-yellow'}" style="display:inline-flex;align-items:center;gap:3px">
                        ${l.paymentConfigured ? `${ICON('payments',10)} Payments Active` : `${ICON('warning',10)} Payments Not Set`}
                    </span>
                </div>
            </div>
            <div class="landlord-row-right">
                ${statusBadge(l.accountStatus)}
                <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();openLandlordDetail('${l._id}')">Manage →</button>
            </div>
        </div>`).join('');
}


// ═══════════════════════════════════════
// LANDLORD DETAIL
// ═══════════════════════════════════════

async function openLandlordDetail(landlordId) {
    _activeLandlordId = landlordId;
    showSection('landlord-detail');

    document.getElementById('detailLandlordId').value  = landlordId;
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

        document.getElementById('detailLandlordName').textContent = landlord.name;
        document.getElementById('topbarTitle').textContent        = landlord.name;

        document.getElementById('detailSubCard').innerHTML = `
            <div style="margin-bottom:1.25rem">
                <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.4rem;color:var(--text);margin-bottom:0.2rem">${escHtml(landlord.name)}</div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:var(--text-dim)">${escHtml(landlord.email)}</div>
                <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.25rem;display:flex;align-items:center;gap:4px;flex-wrap:wrap">
                    <span style="display:inline-flex;align-items:center;gap:3px">${ICON('properties',11)} ${escHtml(landlord.propertyName || '—')}</span>
                    <span style="display:inline-flex;align-items:center;gap:3px">${ICON('pin',11)} ${escHtml(landlord.propertyLocation || '—')}</span>
                </div>
            </div>
            <div class="sub-card-row" style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border);font-size:0.82rem"><span style="color:var(--text-dim)">Status</span><span>${statusBadge(landlord.accountStatus)}</span></div>
            <div class="sub-card-row" style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border);font-size:0.82rem"><span style="color:var(--text-dim)">Tenants</span><span class="td-mono">${landlord.tenantCount   || 0}</span></div>
            <div class="sub-card-row" style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border);font-size:0.82rem"><span style="color:var(--text-dim)">Houses</span><span class="td-mono">${landlord.houseCount    || 0}</span></div>
            <div class="sub-card-row" style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border);font-size:0.82rem"><span style="color:var(--text-dim)">Properties</span><span class="td-mono">${landlord.propertyCount || 0}</span></div>
            <div class="sub-card-row" style="display:flex;justify-content:space-between;padding:0.5rem 0;font-size:0.82rem"><span style="color:var(--text-dim)">M-Pesa Config</span><span style="display:inline-flex;align-items:center;gap:3px">${landlord.paymentConfigured ? `${ICON('checkCircle',11)} Configured` : `${ICON('warning',11)} Not configured`}</span></div>
            ${landlord.suspendedReason ? `<div class="sub-card-row" style="display:flex;justify-content:space-between;padding:0.5rem 0;border-top:1px solid var(--border);font-size:0.82rem"><span style="color:var(--text-dim)">Suspension Reason</span><span style="color:var(--red)">${escHtml(landlord.suspendedReason)}</span></div>` : ''}
        `;

        _renderPropertyDrilldown(landlord.properties || []);
        await loadDetailOutstanding(landlordId);
        await loadDetailPayments(landlordId);
        await loadCommissionChart(landlordId);

    } catch (err) {
        showToast('Failed to load landlord details', 'error');
        console.error('loadLandlordDetail error:', err.message);
    }
}

function _renderPropertyDrilldown(properties) {
    const el = document.getElementById('detailPropertiesList');
    if (!el) return;

    if (!properties.length) {
        el.innerHTML = `<div class="empty-state"><span class="icon">${ICON('properties',24)}</span>No properties yet</div>`;
        return;
    }

    el.innerHTML = properties.map(p => `
        <div class="prop-drill-item">
            <div class="prop-drill-name">${escHtml(p.name)}${p.location ? ` — <span style="display:inline-flex;align-items:center;gap:3px">${ICON('pin',11)} ${escHtml(p.location)}</span>` : ''}</div>
            <div class="prop-drill-pills">
                <span class="pill ${p.paymentConfigured ? 'pill-green' : 'pill-yellow'}" style="display:inline-flex;align-items:center;gap:3px">${p.paymentConfigured ? `${ICON('payments',10)} M-Pesa set` : `${ICON('warning',10)} No M-Pesa`}</span>
                <span class="pill ${p.isListed ? 'pill-cyan' : ''}" ${!p.isListed ? 'style="background:rgba(74,85,104,0.15);color:var(--text-dim);border:1px solid var(--border);display:inline-flex;align-items:center;gap:3px"' : 'style="display:inline-flex;align-items:center;gap:3px"'}>${p.isListed ? `${ICON('houses',10)} Listed` : 'Not listed'}</span>
                ${p.isListed ? `<span class="pill ${p.isApproved ? 'pill-green' : 'pill-yellow'}" style="display:inline-flex;align-items:center;gap:3px">${p.isApproved ? `${ICON('checkCircle',10)} Approved` : `${ICON('hourglass',10)} Pending`}</span>` : ''}
                <span class="pill ${p.hasLocation ? 'pill-green' : 'pill-yellow'}" style="display:inline-flex;align-items:center;gap:3px">${ICON('pin',10)} ${p.hasLocation ? 'Pinned' : 'Not pinned'}</span>
            </div>
        </div>`).join('');
}

async function loadDetailOutstanding(landlordId) {
    const el = document.getElementById('detailOutstanding');
    if (!el) return;
    el.innerHTML = '<div class="empty-state">Loading…</div>';

    try {
        const res  = await stacklordFetch(`/stacklord/commission/outstanding?month=${encodeURIComponent(currentMonthLabel())}`);
        const data = await res.json();
        if (!res.ok) { el.innerHTML = '<div class="empty-state">Could not load</div>'; return; }

        const entry = (data.outstanding || []).find(o => o.landlordId === landlordId);

        if (!entry) {
            el.innerHTML = `<div class="empty-state"><span class="icon">${ICON('checkCircle',24)}</span>Nothing owed this month</div>`;
            return;
        }

        el.innerHTML = `
            <div class="outstanding-item">
                <div class="outstanding-head">
                    <span class="outstanding-landlord">${escHtml(data.month)}</span>
                    <span class="outstanding-total">${formatKsh(entry.totalOwed)}</span>
                </div>
                ${entry.properties.map(p => `
                    <div class="outstanding-prop-row">
                        <span>${escHtml(p.name)}</span>
                        <span style="display:flex;align-items:center;gap:0.5rem">
                            <span class="td-mono" style="color:var(--amber)">${formatKsh(p.amountDue)}</span>
                            <button class="btn btn-success btn-sm" onclick="markCommissionPaid('${p.propertyId}', '${escHtml(p.month)}')">Mark Paid</button>
                        </span>
                    </div>`).join('')}
            </div>`;

    } catch (err) {
        el.innerHTML = '<div class="empty-state">Network error</div>';
        console.error('loadDetailOutstanding error:', err.message);
    }
}

async function loadDetailPayments(landlordId) {
    try {
        const res  = await stacklordFetch('/stacklord/commissions?limit=200');
        if (!res.ok) return;
        const { payments } = await res.json();

        const filtered = (payments || []).filter(p =>
            (p.landlord?._id === landlordId) || (p.landlord === landlordId)
        );

        const tbody = document.getElementById('detailPaymentsTable');
        if (!tbody) return;

        if (!filtered.length) {
            tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><span class="icon">${ICON('payments',24)}</span>No payments yet</div></td></tr>`;
            return;
        }

        tbody.innerHTML = filtered.map(p => `
            <tr>
                <td class="td-mono">${formatDate(p.paidAt || p.createdAt)}</td>
                <td>${escHtml(p.property?.name || '—')}</td>
                <td class="td-mono">${escHtml(p.month)}</td>
                <td class="td-mono" style="color:var(--green)">${formatKsh(p.amountDue)}</td>
                <td class="td-mono" style="color:var(--cyan)">${escHtml(p.mpesaCode || '—')}</td>
                <td>${_paymentStatusPill(p.status)}</td>
            </tr>`).join('');

    } catch (err) {
        console.error('loadDetailPayments error:', err.message);
    }
}

async function loadCommissionChart(landlordId) {
    try {
        const res  = await stacklordFetch('/stacklord/commissions?status=paid&limit=200');
        if (!res.ok) return;
        const { payments } = await res.json();

        const filtered = (payments || [])
            .filter(p => (p.landlord?._id === landlordId) || (p.landlord === landlordId))
            .slice(-8)
            .reverse();

        const labels  = filtered.map(p => formatDateShort(p.paidAt || p.createdAt));
        const amounts = filtered.map(p => p.amountDue);

        const ctx = document.getElementById('commissionChart')?.getContext('2d');
        if (!ctx) return;

        if (commissionChartInstance) commissionChartInstance.destroy();

        commissionChartInstance = new Chart(ctx, {
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
        console.error('loadCommissionChart error:', err.message);
    }
}


// ═══════════════════════════════════════
// LANDLORD CONTROLS — Suspend / Unsuspend
// ═══════════════════════════════════════

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

        showToast('Landlord suspended successfully', 'success');
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
    if (!confirm("Restore this landlord's access?")) return;

    try {
        const res  = await stacklordFetch(`/stacklord/unsuspend/${landlordId}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to unsuspend', 'error'); return; }

        showToast(data.message, 'success');

        await loadAllLandlords();
        await loadLandlordDetail(landlordId);
        loadOverview();

    } catch (err) {
        showToast('Network error', 'error');
        console.error('unsuspendLandlord error:', err.message);
    }
}


// ═══════════════════════════════════════
// COMMISSION SECTION
// ═══════════════════════════════════════

async function loadCommissionSection() {
    await loadCurrentRate();
    await loadRateHistory();
    await loadOutstanding();
}

async function loadCurrentRate() {
    try {
        const res  = await stacklordFetch('/stacklord/commission-rate');
        const data = await res.json();
        if (!res.ok) return;
        document.getElementById('currentRateDisplay').textContent = `${data.commissionPercentage}%`;
    } catch (err) {
        console.error('loadCurrentRate error:', err.message);
    }
}

async function setCommissionRate() {
    const percentage = parseFloat(document.getElementById('newCommissionRate').value);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
        showToast('Enter a percentage between 0 and 100', 'error');
        return;
    }
    if (!confirm(`Set the platform commission rate to ${percentage}%? This applies immediately to all properties.`)) return;

    try {
        const res  = await stacklordFetch('/stacklord/commission-rate', {
            method: 'POST',
            body:   JSON.stringify({ percentage })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to update rate', 'error'); return; }

        showToast(data.message, 'success');
        document.getElementById('newCommissionRate').value = '';
        loadCurrentRate();
        loadRateHistory();
        loadOverview();

    } catch (err) {
        showToast('Network error', 'error');
        console.error('setCommissionRate error:', err.message);
    }
}

async function loadRateHistory() {
    const el = document.getElementById('rateHistoryList');
    if (!el) return;
    el.innerHTML = '<div class="empty-state">Loading…</div>';

    try {
        const res  = await stacklordFetch('/stacklord/commission-rate-history');
        const data = await res.json();
        if (!res.ok) { el.innerHTML = '<div class="empty-state">Could not load history</div>'; return; }

        const history = data.history || [];
        if (!history.length) {
            el.innerHTML = '<div class="empty-state">No rate changes recorded yet</div>';
            return;
        }

        el.innerHTML = history.map(h => `
            <div class="rate-history-row">
                <span style="color:var(--text-muted)">${formatDate(h.changedAt)}</span>
                <span class="td-mono" style="color:var(--accent);font-weight:700">${h.percentage}%</span>
            </div>`).join('');

    } catch (err) {
        el.innerHTML = '<div class="empty-state">Network error</div>';
        console.error('loadRateHistory error:', err.message);
    }
}

async function loadOutstanding() {
    const el    = document.getElementById('outstandingList');
    const month = document.getElementById('outstandingMonth')?.value.trim() || currentMonthLabel();
    if (!el) return;

    if (document.getElementById('outstandingMonth') && !document.getElementById('outstandingMonth').value) {
        document.getElementById('outstandingMonth').value = month;
    }

    el.innerHTML = '<div class="empty-state">Loading…</div>';

    try {
        const res  = await stacklordFetch(`/stacklord/commission/outstanding?month=${encodeURIComponent(month)}`);
        const data = await res.json();
        if (!res.ok) { el.innerHTML = '<div class="empty-state">Could not load</div>'; return; }

        const outstanding = data.outstanding || [];
        if (!outstanding.length) {
            el.innerHTML = `<div class="empty-state"><span class="icon">${ICON('checkCircle',24)}</span>Nothing outstanding for ${escHtml(month)}</div>`;
            return;
        }

        el.innerHTML = outstanding.map(o => `
            <div class="outstanding-item">
                <div class="outstanding-head">
                    <span class="outstanding-landlord">${escHtml(o.landlordName)} <span style="color:var(--text-dim);font-weight:400;font-size:0.7rem">(${escHtml(o.landlordEmail)})</span></span>
                    <span class="outstanding-total">${formatKsh(o.totalOwed)}</span>
                </div>
                ${o.properties.map(p => `
                    <div class="outstanding-prop-row">
                        <span>${escHtml(p.name)}</span>
                        <span style="display:flex;align-items:center;gap:0.5rem">
                            <span class="td-mono" style="color:var(--amber)">${formatKsh(p.amountDue)}</span>
                            <button class="btn btn-success btn-sm" onclick="markCommissionPaid('${p.propertyId}', '${escHtml(p.month)}')">Mark Paid</button>
                        </span>
                    </div>`).join('')}
            </div>`).join('');

    } catch (err) {
        el.innerHTML = '<div class="empty-state">Network error</div>';
        console.error('loadOutstanding error:', err.message);
    }
}

async function markCommissionPaid(propertyId, month) {
    const note = prompt(`Mark commission for ${month} as paid?\n\nOptional note (e.g. "paid via bank transfer"):`, '');
    if (note === null) return; // cancelled

    try {
        const res  = await stacklordFetch('/stacklord/commissions/mark-paid', {
            method: 'POST',
            body:   JSON.stringify({ propertyId, month, note })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to mark paid', 'error'); return; }

        showToast('Commission marked as paid', 'success');
        loadOutstanding();
        loadOverview();
        if (_activeLandlordId) loadDetailOutstanding(_activeLandlordId);

    } catch (err) {
        showToast('Network error', 'error');
        console.error('markCommissionPaid error:', err.message);
    }
}


// ═══════════════════════════════════════
// COMMISSION PAYMENT LOG (all landlords)
// ═══════════════════════════════════════

async function loadSubPayments(page = 1) {
    _paymentsPage = page;
    const statusFilter = document.getElementById('paymentsStatusFilter')?.value || '';
    const tbody      = document.getElementById('paymentsTable');
    const pagination = document.getElementById('paymentsPagination');

    if (tbody) tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Loading…</div></td></tr>';

    try {
        let url = `/stacklord/commissions?page=${page}&limit=25`;
        if (statusFilter) url += `&status=${encodeURIComponent(statusFilter)}`;

        const res  = await stacklordFetch(url);
        const data = await res.json();
        if (!res.ok) { showToast('Failed to load payments', 'error'); return; }

        const { payments, total, pages } = data;

        if (!payments?.length) {
            if (tbody) tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><span class="icon">${ICON('payments',24)}</span>No commission payments yet</div></td></tr>`;
            if (pagination) pagination.innerHTML = '';
            return;
        }

        if (tbody) {
            tbody.innerHTML = payments.map(p => `
                <tr>
                    <td class="td-mono">${formatDate(p.paidAt || p.createdAt)}</td>
                    <td>
                        <div style="font-size:0.82rem;color:var(--text)">${escHtml(p.landlord?.name || '—')}</div>
                        <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim)">${escHtml(p.landlord?.email || '—')}</div>
                    </td>
                    <td>${escHtml(p.property?.name || '—')}</td>
                    <td class="td-mono">${escHtml(p.month)}</td>
                    <td class="td-mono">${formatKsh(p.totalCollected)}</td>
                    <td class="td-mono" style="color:var(--green)">${formatKsh(p.amountDue)}</td>
                    <td class="td-mono" style="color:var(--cyan)">${escHtml(p.mpesaCode || '—')}</td>
                    <td>${_paymentStatusPill(p.status)}</td>
                </tr>`).join('');
        }

        if (pagination && pages > 1) {
            let html = `<button class="btn btn-secondary btn-sm" onclick="loadSubPayments(${page - 1})" ${page <= 1 ? 'disabled' : ''}>← Prev</button>`;
            for (let i = 1; i <= pages; i++) {
                if (pages > 7 && i > 2 && i < pages - 1 && Math.abs(i - page) > 1) {
                    if (i === 3 || i === pages - 2) html += `<span style="color:var(--text-dim);padding:0 0.25rem;font-family:'JetBrains Mono',monospace;font-size:0.7rem">…</span>`;
                    continue;
                }
                html += `<button class="btn btn-sm ${i === page ? 'btn-primary' : 'btn-secondary'}" onclick="loadSubPayments(${i})">${i}</button>`;
            }
            html += `<button class="btn btn-secondary btn-sm" onclick="loadSubPayments(${page + 1})" ${page >= pages ? 'disabled' : ''}>Next →</button>`;
            html += `<span style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim);margin-left:0.5rem">${total} total</span>`;
            pagination.innerHTML = html;
        } else if (pagination) {
            pagination.innerHTML = `<span style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim)">${total} payment${total === 1 ? '' : 's'} total</span>`;
        }

    } catch (err) {
        showToast('Network error', 'error');
        console.error('loadSubPayments error:', err.message);
    }
}


// ═══════════════════════════════════════
// PROPERTY LISTINGS
// ═══════════════════════════════════════

async function loadListings() {
    const pendingEl  = document.getElementById('pendingListingsList');
    const approvedEl = document.getElementById('approvedListingsList');

    if (pendingEl)  pendingEl.innerHTML  = `<div class="empty-state"><span class="icon">${ICON('hourglass',24)}</span>Loading…</div>`;
    if (approvedEl) approvedEl.innerHTML = `<div class="empty-state"><span class="icon">${ICON('hourglass',24)}</span>Loading…</div>`;

    _selectedPendingIds.clear();
    _updateBulkBar();

    try {
        const [pendingRes, approvedRes] = await Promise.all([
            stacklordFetch('/stacklord/listings-pending'),
            stacklordFetch('/stacklord/listings-approved')
        ]);

        const pendingData  = pendingRes.ok  ? await pendingRes.json()  : { count: 0, properties: [] };
        const approvedData = approvedRes.ok ? await approvedRes.json() : { count: 0, properties: [] };

        _pendingListingsCache  = pendingData.properties  || [];
        _approvedListingsCache = approvedData.properties || [];

        _updatePendingBadge(pendingData.count || 0);
        _renderPendingListings();
        _renderApprovedListings();

        const el2 = document.getElementById('overviewApprovedBadge');
        if (el2) el2.textContent = approvedData.count || 0;

    } catch (err) {
        showToast('Failed to load listings', 'error');
        console.error('loadListings error:', err.message);
        if (pendingEl)  pendingEl.innerHTML  = `<div class="empty-state"><span class="icon">${ICON('warning',24)}</span>Failed to load</div>`;
        if (approvedEl) approvedEl.innerHTML = `<div class="empty-state"><span class="icon">${ICON('warning',24)}</span>Failed to load</div>`;
    }
}

function switchListingsTab(tab) {
    _listingsTab = tab;
    document.getElementById('tabPending').classList.toggle('active',   tab === 'pending');
    document.getElementById('tabApproved').classList.toggle('active',  tab === 'approved');
    document.getElementById('listingsPendingContainer').style.display  = tab === 'pending'  ? 'block' : 'none';
    document.getElementById('listingsApprovedContainer').style.display = tab === 'approved' ? 'block' : 'none';
}

function toggleSelectAll(scope) {
    if (scope !== 'pending') return;
    const checked = document.getElementById('selectAllPending').checked;
    _selectedPendingIds.clear();
    if (checked) _pendingListingsCache.forEach(p => _selectedPendingIds.add(p._id));
    _renderPendingListings();
    _updateBulkBar();
}

function togglePendingSelect(id) {
    if (_selectedPendingIds.has(id)) _selectedPendingIds.delete(id);
    else _selectedPendingIds.add(id);
    _updateBulkBar();
}

function _updateBulkBar() {
    const bar   = document.getElementById('bulkBarPending');
    const count = document.getElementById('bulkPendingCount');
    if (count) count.textContent = _selectedPendingIds.size;
    if (bar)   bar.classList.toggle('visible', _selectedPendingIds.size > 0);
}

function _renderPendingListings() {
    const container = document.getElementById('pendingListingsList');
    if (!container) return;

    if (!_pendingListingsCache.length) {
        container.innerHTML = `<div class="empty-state"><span class="icon">${ICON('checkCircle',24)}</span>No listings pending approval — all clear!</div>`;
        document.getElementById('selectAllPending').checked = false;
        return;
    }

    container.innerHTML = _pendingListingsCache.map(p => `
        <div class="listing-card pending">
            <input type="checkbox" class="listing-select" ${_selectedPendingIds.has(p._id) ? 'checked' : ''} onchange="togglePendingSelect('${p._id}')">
            <div class="listing-thumb">
                ${p.photos?.length
                    ? `<img src="${escHtml(p.photos[0])}" alt="${escHtml(p.name)}" loading="lazy">`
                    : ICON('houses',24)}
            </div>
            <div class="listing-info">
                <div class="listing-name">${escHtml(p.name)}</div>
                <div class="listing-meta" style="display:inline-flex;align-items:center;gap:3px">${ICON('pin',11)} ${escHtml(p.location || '—')}</div>
                <div class="listing-landlord">Landlord: ${escHtml(p.landlord?.name || '—')} · ${escHtml(p.landlord?.email || '—')}</div>
                <div style="margin-top:0.35rem;display:flex;gap:0.4rem;flex-wrap:wrap">
                    <span class="pill pill-yellow" style="display:inline-flex;align-items:center;gap:3px">${ICON('hourglass',10)} Awaiting Approval</span>
                    ${p.photos?.length ? `<span class="pill pill-cyan">${p.photos.length} photo${p.photos.length > 1 ? 's' : ''}</span>` : '<span class="pill" style="background:rgba(74,85,104,0.15);color:var(--text-dim);border:1px solid var(--border)">No photos</span>'}
                    <span class="pill ${p.geo ? 'pill-green' : 'pill-yellow'}" style="display:inline-flex;align-items:center;gap:3px">${ICON('pin',10)} ${p.geo ? 'Pinned' : 'Not pinned'}</span>
                </div>
            </div>
            <div class="listing-actions">
                <button class="btn btn-success" onclick="approveListing('${p._id}', true, '${escHtml(p.name)}')"><span data-icon-inline>${ICON('checkCircle',13)}</span> Approve</button>
                <button class="btn btn-secondary btn-sm" onclick="approveListing('${p._id}', false, '${escHtml(p.name)}')"><span data-icon-inline>${ICON('close',13)}</span> Reject</button>
                ${p.photos?.length ? `<button class="btn btn-secondary btn-sm" onclick="openPhotoModeration('${p._id}', '${escHtml(p.name)}')"><span data-icon-inline>${ICON('image',13)}</span> Photos</button>` : ''}
            </div>
        </div>`).join('');
}

function _renderApprovedListings() {
    const container = document.getElementById('approvedListingsList');
    if (!container) return;

    if (!_approvedListingsCache.length) {
        container.innerHTML = `<div class="empty-state"><span class="icon">${ICON('houses',24)}</span>No approved listings yet</div>`;
        return;
    }

    container.innerHTML = _approvedListingsCache.map(p => `
        <div class="listing-card approved">
            <div class="listing-thumb">
                ${p.photos?.length
                    ? `<img src="${escHtml(p.photos[0])}" alt="${escHtml(p.name)}" loading="lazy">`
                    : ICON('houses',24)}
            </div>
            <div class="listing-info">
                <div class="listing-name">${escHtml(p.name)}</div>
                <div class="listing-meta" style="display:inline-flex;align-items:center;gap:3px">${ICON('pin',11)} ${escHtml(p.location || '—')}</div>
                <div class="listing-landlord">Landlord: ${escHtml(p.landlord?.name || '—')} · ${escHtml(p.landlord?.email || '—')}</div>
                <div style="margin-top:0.35rem;display:flex;gap:0.4rem;flex-wrap:wrap">
                    <span class="pill pill-green" style="display:inline-flex;align-items:center;gap:3px">${ICON('checkCircle',10)} Live &amp; Public</span>
                    ${p.photos?.length ? `<span class="pill pill-cyan">${p.photos.length} photo${p.photos.length > 1 ? 's' : ''}</span>` : ''}
                    <span class="pill ${p.geo ? 'pill-green' : 'pill-yellow'}" style="display:inline-flex;align-items:center;gap:3px">${ICON('pin',10)} ${p.geo ? 'Pinned' : 'Not pinned'}</span>
                </div>
            </div>
            <div class="listing-actions">
                <button class="btn btn-warn btn-sm" onclick="approveListing('${p._id}', false, '${escHtml(p.name)}')"><span data-icon-inline>${ICON('ban',13)}</span> Revoke</button>
                ${p.photos?.length ? `<button class="btn btn-secondary btn-sm" onclick="openPhotoModeration('${p._id}', '${escHtml(p.name)}')"><span data-icon-inline>${ICON('image',13)}</span> Photos</button>` : ''}
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
        showToast(data.message || (approve ? 'Listing approved and live' : 'Listing revoked'), 'success');
        await loadListings();
    } catch (err) {
        showToast('Network error', 'error');
        console.error('approveListing error:', err.message);
    }
}

async function bulkApprove(approve) {
    const ids = Array.from(_selectedPendingIds);
    if (!ids.length) { showToast('No listings selected', 'warn'); return; }
    if (!confirm(`${approve ? 'Approve' : 'Reject'} ${ids.length} selected listing(s)?`)) return;

    try {
        const res  = await stacklordFetch('/stacklord/properties/bulk-approve', {
            method: 'POST',
            body:   JSON.stringify({ ids, approve })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Bulk action failed', 'error'); return; }

        showToast(data.message, 'success');
        _selectedPendingIds.clear();
        await loadListings();

    } catch (err) {
        showToast('Network error', 'error');
        console.error('bulkApprove error:', err.message);
    }
}


// ═══════════════════════════════════════
// PHOTO MODERATION
// ═══════════════════════════════════════

function openPhotoModeration(propertyId, name) {
    const source = _pendingListingsCache.concat(_approvedListingsCache).find(p => p._id === propertyId);
    if (!source) { showToast('Listing not found — refresh and try again', 'warn'); return; }

    document.getElementById('photoModPropertyId').value = propertyId;
    document.getElementById('photoModPropName').innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px">${ICON('properties',11)} ${escHtml(name)}</span>`;
    _renderPhotoModGrid(source.photos || [], propertyId);
    openModal('modal-photo-mod');
}

function _renderPhotoModGrid(photos, propertyId) {
    const grid = document.getElementById('photoModGrid');
    if (!grid) return;

    if (!photos.length) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No photos on this listing</div>';
        return;
    }

    grid.innerHTML = photos.map(url => `
        <div class="photo-mod-item">
            <img src="${escHtml(url)}" alt="Property photo" loading="lazy">
            <button class="photo-mod-del" onclick="deleteModeratedPhoto('${propertyId}', '${escHtml(url)}')" title="Remove photo">${ICON('close',12)}</button>
        </div>`).join('');
}

async function deleteModeratedPhoto(propertyId, photoUrl) {
    if (!confirm('Remove this photo? This cannot be undone.')) return;

    try {
        const res  = await stacklordFetch(`/stacklord/properties/${propertyId}/photos`, {
            method: 'DELETE',
            body:   JSON.stringify({ photoUrl })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Delete failed', 'error'); return; }

        showToast('Photo removed', 'success');
        _renderPhotoModGrid(data.photos || [], propertyId);

        [_pendingListingsCache, _approvedListingsCache].forEach(cache => {
            const prop = cache.find(p => p._id === propertyId);
            if (prop) prop.photos = data.photos || [];
        });
        _renderPendingListings();
        _renderApprovedListings();

    } catch (err) {
        showToast('Network error', 'error');
        console.error('deleteModeratedPhoto error:', err.message);
    }
}


// ═══════════════════════════════════════
// INQUIRIES
// ═══════════════════════════════════════

async function loadInquiries(page = 1) {
    _inquiriesPage = page;

    const tbody        = document.getElementById('inquiriesTable');
    const pagination    = document.getElementById('inquiriesPagination');
    const statusFilter  = document.getElementById('inquiryStatusFilter')?.value || '';

    if (tbody) tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><span class="icon">${ICON('hourglass',24)}</span>Loading…</div></td></tr>`;
    if (pagination) pagination.innerHTML = '';

    try {
        let url = `/stacklord/inquiries?page=${page}&limit=20`;
        if (statusFilter) url += `&status=${encodeURIComponent(statusFilter)}`;

        const res  = await stacklordFetch(url);
        const data = await res.json();
        if (!res.ok) { showToast('Failed to load inquiries', 'error'); return; }

        const { inquiries, total, pages } = data;

        const badge = document.getElementById('inquiriesBadge');
        if (badge) {
            badge.textContent   = total || 0;
            badge.style.display = total > 0 ? 'inline-block' : 'none';
        }

        const overviewBadge = document.getElementById('overviewInquiriesBadge');
        if (overviewBadge) overviewBadge.textContent = total || 0;

        if (!inquiries?.length) {
            if (tbody) tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><span class="icon">${ICON('inquiries',24)}</span>No inquiries yet</div></td></tr>`;
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

        if (pagination && pages > 1) {
            let html = `<button class="btn btn-secondary btn-sm" onclick="loadInquiries(${page - 1})" ${page <= 1 ? 'disabled' : ''}>← Prev</button>`;
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
        if (tbody) tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><span class="icon">${ICON('warning',24)}</span>Failed to load inquiries</div></td></tr>`;
    }
}


// ═══════════════════════════════════════
// SYSTEM — Platform Controls
// ═══════════════════════════════════════

async function loadSystemSection() { await loadSystemStatus(); }

async function loadSystemStatus() {
    try {
        const [statusRes, rateRes] = await Promise.all([
            fetch(`${API}/platform-status`),
            stacklordFetch('/stacklord/commission-rate')
        ]);

        if (statusRes.ok) {
            const status = await statusRes.json();
            const toggle = document.getElementById('maintenanceToggle');
            const sub    = document.getElementById('maintenanceStatusSub');
            const msgEl  = document.getElementById('maintenanceMessage');
            if (toggle) toggle.checked = !!status.maintenanceMode;
            if (sub)    sub.innerHTML = status.maintenanceMode
                ? `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--red)">${ICON('errorCircle',11)} ON — the entire platform is currently locked out</span>`
                : `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--green)">${ICON('checkCircle',11)} OFF — platform is live and reachable</span>`;
            if (msgEl && status.message) msgEl.value = status.message;
            _updateMaintenanceChrome(!!status.maintenanceMode);
        }

        if (rateRes.ok) {
            const settings = await rateRes.json();
            const toggle = document.getElementById('autoApproveToggle');
            const sub    = document.getElementById('autoApproveStatusSub');
            if (toggle) toggle.checked = !!settings.autoApproveListings;
            if (sub)    sub.innerHTML = settings.autoApproveListings
                ? `<span style="display:inline-flex;align-items:center;gap:4px">${ICON('checkCircle',11)} ON — new listings publish instantly, no review needed</span>`
                : `<span style="display:inline-flex;align-items:center;gap:4px">${ICON('hourglass',11)} OFF — new listings wait in the Pending queue</span>`;
        }

    } catch (err) {
        console.error('loadSystemStatus error:', err.message);
    }
}

async function togglePlatformMaintenance() {
    const enabled = document.getElementById('maintenanceToggle').checked;
    const message = document.getElementById('maintenanceMessage')?.value.trim() || '';

    if (enabled && !confirm('Turn ON platform-wide maintenance? This immediately blocks EVERY landlord and tenant from using the platform.')) {
        document.getElementById('maintenanceToggle').checked = false;
        return;
    }

    try {
        const res  = await stacklordFetch('/stacklord/platform-maintenance', {
            method: 'PUT',
            body:   JSON.stringify({ enabled, message })
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.message || 'Failed to update', 'error');
            document.getElementById('maintenanceToggle').checked = !enabled;
            return;
        }

        showToast(data.message, enabled ? 'warn' : 'success');
        loadSystemStatus();
        loadOverview();

    } catch (err) {
        showToast('Network error', 'error');
        document.getElementById('maintenanceToggle').checked = !enabled;
        console.error('togglePlatformMaintenance error:', err.message);
    }
}

async function saveMaintenanceMessage() {
    const enabled = document.getElementById('maintenanceToggle').checked;
    const message = document.getElementById('maintenanceMessage')?.value.trim() || '';

    try {
        const res  = await stacklordFetch('/stacklord/platform-maintenance', {
            method: 'PUT',
            body:   JSON.stringify({ enabled, message })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to save', 'error'); return; }
        showToast('Maintenance message saved', 'success');
        loadSystemStatus();
    } catch (err) {
        showToast('Network error', 'error');
        console.error('saveMaintenanceMessage error:', err.message);
    }
}

async function toggleAutoApprove() {
    const enabled = document.getElementById('autoApproveToggle').checked;

    try {
        const res  = await stacklordFetch('/stacklord/auto-approve-listings', {
            method: 'PUT',
            body:   JSON.stringify({ enabled })
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.message || 'Failed to update', 'error');
            document.getElementById('autoApproveToggle').checked = !enabled;
            return;
        }

        showToast(data.message, 'success');
        loadSystemStatus();
        loadOverview();

    } catch (err) {
        showToast('Network error', 'error');
        document.getElementById('autoApproveToggle').checked = !enabled;
        console.error('toggleAutoApprove error:', err.message);
    }
}


// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
    checkPlatformStatusForLockScreen();

    const saved = sessionStorage.getItem('stacklord_key');
    if (saved) { STACKLORD_KEY = saved; verifyKey(saved); }

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', function(e) {
            if (e.target === this) closeModal(this.id);
        });
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.open').forEach(m => closeModal(m.id));
            closeSidebar();
        }
    });

    const keyInput = document.getElementById('masterKey');
    if (keyInput) keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
});