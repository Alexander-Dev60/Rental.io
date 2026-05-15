// ═══════════════════════════════════════════════════════
//  index.js — Admin UI / DOM Rendering Layer
//  No fetch() calls here — those are in script.js.
//  script.js loads before this file.
// ═══════════════════════════════════════════════════════


// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════

const SECTION_TITLES = {
    dashboard:     'Dashboard',
    tenants:       'All Tenants',
    arrears:       'Arrears',
    addTenant:     'Add New Tenant',
    houses:        'Houses',
    assign:        'Assign House',
    payments:      'Record Payment',
    receipts:      'Receipts',
    messages:      'Messages',
    announcements: 'Announcements',
    rules:         'House Rules'
};

function showSection(name) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const sec = document.getElementById(`sec-${name}`);
    if (sec) sec.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(n => {
        if (n.getAttribute('onclick')?.includes(`'${name}'`)) {
            n.classList.add('active');
        }
    });

    document.getElementById('topbarTitle').textContent = SECTION_TITLES[name] || name;

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');

    // Lazy-load section data
    if (name === 'assign')       { loadTenants(); loadHouses(); }
    if (name === 'tenants')      { loadTenants(); }
    if (name === 'arrears')      { loadArrears(); }
    if (name === 'messages')     { loadUnread(); populateChatSelect(); }
    if (name === 'announcements'){ loadAnnouncements(); }
    if (name === 'rules')        { loadRules(); }
    if (name === 'houses')       { loadHouses(); }
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}


// ═══════════════════════════════════════
// THEME
// ═══════════════════════════════════════

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);

    document.querySelectorAll('.theme-dot').forEach(d => {
        d.classList.toggle('active', d.dataset.theme === theme);
    });
}


// ═══════════════════════════════════════
// TOAST
// ═══════════════════════════════════════

let _toastTimer;

function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className   = `show ${type}`;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}


// ═══════════════════════════════════════
// MODALS
// FIX 2 (root cause): openModal routes 'modal-subscribe'
// to openSubscribeModal() which is defined in script.js
// (loads before this file) — this prevents the inline
// script override from being clobbered.
// ═══════════════════════════════════════


// Close modal when clicking the overlay backdrop
document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
        if (e.target === overlay) {
            const id = overlay.id;
            closeModal(id);
        }
    });
});


// ═══════════════════════════════════════
// TENANT LIST RENDERING (FIX 3)
// Added payment status badge per tenant row
// ═══════════════════════════════════════

function renderTenantList(tenants) {
    const list = document.getElementById('tenantList');

    if (!tenants.length) {
        list.innerHTML = '<div class="empty-state"><span class="icon">👥</span>No tenants found</div>';
        return;
    }

    const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

    list.innerHTML = tenants.map(t => {
        const initials = t.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const house    = t.house
            ? (t.house.name || t.house)
            : 'No house';

        // FIX 3: build a badge from payment status if available on the tenant object
        // GET /tenants now populates house so rent is accessible
        let badge = '';
        if (t.paymentStatus === 'paid') {
            badge = `<span class="paid-badge">Paid</span>`;
        } else if (t.paymentStatus === 'partial') {
            badge = `<span class="partial-badge">Partial</span>`;
        } else if (t.paymentStatus === 'unpaid' && t.house) {
            badge = `<span class="arrears-badge">Unpaid</span>`;
        }

        // Safely encode tenant data for inline onclick — FIX 14
        const tenantData = encodeURIComponent(JSON.stringify(t));

        return `
            <div class="tenant-row" id="row-${t._id}"
                 onclick="handleTenantClick(event, JSON.parse(decodeURIComponent('${tenantData}')))">
                <div class="tenant-avatar">${initials}</div>
                <div class="tenant-info">
                    <div class="tenant-name">${t.name}</div>
                    <div class="tenant-meta">${t.phone || '—'} · ${house}</div>
                </div>
                ${badge}
            </div>`;
    }).join('');
}


// ═══════════════════════════════════════
// TENANT CONTEXT MENU
// ═══════════════════════════════════════

function handleTenantClick(event, tenant) {
    // Close any open menus and deselect rows
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    document.querySelectorAll('.tenant-row').forEach(r => r.classList.remove('selected'));

    const row = document.getElementById(`row-${tenant._id}`);
    if (row) row.classList.add('selected');

    // Load profile on side panel
    loadTenantProfile(tenant._id);

    // FIX 14: use data attributes instead of inline JSON to avoid quote escaping issues
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.dataset.tenantId = tenant._id;

    menu.innerHTML = `
        <div class="ctx-item" onclick="_ctxViewProfile('${tenant._id}')">
            👁️ View Profile
        </div>
        <div class="ctx-item" onclick="_ctxPayRent('${tenant._id}')">
            💳 Pay Rent
        </div>
        <div class="ctx-divider"></div>
        <div class="ctx-item" onclick="_ctxResetPassword('${tenant._id}')">
            🔑 Reset Password
        </div>
        <div class="ctx-divider"></div>
        <div class="ctx-item danger" onclick="_ctxDelete('${tenant._id}')">
            🗑️ Delete Tenant
        </div>`;

    if (row) {
        row.style.position = 'relative';
        row.appendChild(menu);
    }

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closeCtx(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeCtx);
            }
        });
    }, 0);
}

// Context menu action helpers — look up tenant from _allTenants by id
function _ctxViewProfile(id) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    loadTenantProfile(id);
}

function _ctxPayRent(id) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const tenant = _allTenants.find(t => t._id === id);
    if (tenant) openPayModal(tenant);
}

function _ctxResetPassword(id) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const tenant = _allTenants.find(t => t._id === id);
    if (tenant) openResetModal(tenant);
}

function _ctxDelete(id) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const tenant = _allTenants.find(t => t._id === id);
    if (tenant) openDeleteModal(tenant);
}


// ═══════════════════════════════════════
// PROFILE RENDERING (FIX 4)
// Table now matches index.html 6-column header:
// Month | Amount | Total Paid | Balance | Status | Date
// ═══════════════════════════════════════

function renderProfile(data) {
    const t        = data.tenant;
    const house    = t.house ? t.house.name : 'Not assigned';
    const payments = data.payments || [];

    // FIX 4: render all 6 columns to match the HTML table header
    const payRows = payments.length
        ? payments
            .slice()
            .sort((a, b) => new Date(b.datePaid) - new Date(a.datePaid))
            .map(p => `
                <tr>
                    <td>${p.month}</td>
                    <td class="td-mono">Ksh ${Number(p.amount).toLocaleString()}</td>
                    <td class="td-mono">Ksh ${Number(p.totalPaid || p.amount).toLocaleString()}</td>
                    <td class="td-mono">Ksh ${Number(p.balance || 0).toLocaleString()}</td>
                    <td><span class="pill ${p.status === 'paid' ? 'pill-green' : p.status === 'partial' ? 'pill-yellow' : 'pill-red'}">${p.status || 'paid'}</span></td>
                    <td class="td-mono">${p.datePaid ? new Date(p.datePaid).toLocaleDateString() : '—'}</td>
                </tr>`).join('')
        : `<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No payments yet</td></tr>`;

    document.getElementById('profileOutput').innerHTML = `
        <div style="margin-bottom:1rem">
            <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.4rem;color:var(--text);margin-bottom:0.25rem">${t.name}</div>
            <div style="font-size:0.75rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace">${t.email} · ${t.phone || '—'}</div>
            <div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap">
                <span class="pill pill-green">🏠 ${house}</span>
                <span class="pill ${data.arrears > 0 ? 'pill-red' : 'pill-green'}">
                    ${data.arrears > 0 ? `⚠️ Arrears: Ksh ${Number(data.arrears).toLocaleString()}` : '✅ All paid'}
                </span>
            </div>
        </div>
        <div style="font-size:0.62rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim);margin-bottom:0.5rem">Payment History</div>
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Month</th>
                        <th>Amount</th>
                        <th>Total Paid</th>
                        <th>Balance</th>
                        <th>Status</th>
                        <th>Date</th>
                    </tr>
                </thead>
                <tbody>${payRows}</tbody>
            </table>
        </div>
        <div style="margin-top:0.75rem;font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--text-dim)">
            Lifetime total: <strong style="color:var(--accent)">Ksh ${Number(data.totalPaid || 0).toLocaleString()}</strong>
        </div>`;
}


// ═══════════════════════════════════════
// ARREARS TABLE (FIX 11)
// loadArrears() fetch is now in script.js.
// This file only renders.
// ═══════════════════════════════════════

function renderArrearsTable(data) {
    const tbody = document.getElementById('arrearsTable');

    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">🎉 No arrears found</div></td></tr>';
        return;
    }

    tbody.innerHTML = data.map(r => `
        <tr>
            <td><strong style="color:var(--text)">${r.tenant}</strong></td>
            <td class="td-mono">${r.house}</td>
            <td class="td-mono">Ksh ${Number(r.rent).toLocaleString()}</td>
            <td class="td-mono">Ksh ${Number(r.totalPaid).toLocaleString()}</td>
            <td><span class="pill pill-red">Ksh ${Number(r.balance).toLocaleString()}</span></td>
            <td><span class="pill pill-yellow">${r.status.toUpperCase()}</span></td>
            <td>
                <button class="btn btn-primary btn-sm" onclick="quickPay('${r.tenantId}')">Pay Now</button>
            </td>
        </tr>`).join('');
}

function quickPay(tenantId) {
    const tenant = _allTenants.find(t => t._id === tenantId);
    if (tenant) openPayModal(tenant);
    else showToast('Tenant not found — click Refresh', 'warn');
}


// ═══════════════════════════════════════
// HOUSE GRID (FIX 8)
// card gets position:relative explicitly so ctx-menu positions correctly
// ═══════════════════════════════════════

function renderHouseGrid(houses) {
    const grid = document.getElementById('houseGrid');

    if (!houses.length) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><span class="icon">🏡</span>No houses added yet</div>';
        return;
    }

    grid.innerHTML = houses.map(h => `
        <div class="house-card ${h.status}"
             style="position:relative"
             onclick="houseOptions(event, '${h._id}', '${h.name}', '${h.status}')">
            <div class="house-name">${h.name}</div>
            <div class="house-rent">Ksh ${Number(h.rent).toLocaleString()} / mo</div>
            <div style="margin-top:0.5rem;font-size:0.68rem">
                <span class="status-dot ${h.status}"></span>
                ${h.status}
            </div>
        </div>`).join('');
}

function houseOptions(event, id, name, status) {
    event.stopPropagation();
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());

    const card = event.currentTarget;
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';

    // FIX 8: position below the card, not using bottom:'100%'
    // card already has position:relative from renderHouseGrid
    menu.style.top  = '100%';
    menu.style.bottom = 'auto';
    menu.style.right  = '0';
    menu.style.left   = 'auto';
    menu.style.zIndex = '999';

    menu.innerHTML = `
        <div class="ctx-item" style="font-size:0.7rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace;cursor:default">${name}</div>
        <div class="ctx-divider"></div>
        ${status === 'available'
            ? `<div class="ctx-item" onclick="showSection('assign')">🔑 Assign Tenant</div>`
            : `<div class="ctx-item" onclick="showSection('houses')" style="color:var(--warn)">🚪 Move Out Tenant</div>`
        }
        <div class="ctx-item danger" onclick="deleteHouse('${id}')">🗑️ Delete House</div>`;

    card.appendChild(menu);

    setTimeout(() => {
        document.addEventListener('click', function close(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', close);
            }
        });
    }, 0);
}


// ═══════════════════════════════════════
// SELECT POPULATION
// ═══════════════════════════════════════

function populateTenantSelects(tenants) {
    const ids = ['tenantSelect', 'payTenantSelect', 'moveOutSelect', 'chatTenant'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = `<option value="">— Select tenant —</option>` +
            tenants.map(t => `<option value="${t._id}">${t.name}</option>`).join('');
    });
}

function populateHouseSelects(houses) {
    const el = document.getElementById('houseSelect');
    if (!el) return;
    el.innerHTML = `<option value="">— Select house —</option>` +
        houses
            .filter(h => h.status === 'available')
            .map(h => `<option value="${h._id}">${h.name} (Ksh ${Number(h.rent).toLocaleString()})</option>`)
            .join('');
}

// FIX 5: single definition — removed the empty stub that appeared earlier
function populateChatSelect() {
    const el = document.getElementById('chatTenant');
    if (!el || !_allTenants) return;
    el.innerHTML = `<option value="">— Select tenant —</option>` +
        _allTenants.map(t => `<option value="${t._id}">${t.name}</option>`).join('');
}


// ═══════════════════════════════════════
// RECEIPT RENDERING
// ═══════════════════════════════════════

function renderReceipt(data, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = `
        <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:1.25rem;margin-top:0.5rem">
            <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.2rem;color:var(--accent);margin-bottom:0.75rem">🏠 Rent Receipt</div>
            <div style="display:flex;flex-direction:column;gap:0.4rem;font-size:0.78rem;font-family:'JetBrains Mono',monospace">
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Tenant</span>    <span>${data.tenant?.name || '—'}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">House</span>     <span>${data.house?.name || '—'}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Amount</span>    <span style="color:var(--accent)">Ksh ${Number(data.amount || 0).toLocaleString()}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Total Paid</span><span>Ksh ${Number(data.totalPaid || data.amount || 0).toLocaleString()}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Balance</span>   <span>Ksh ${Number(data.balance || 0).toLocaleString()}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Month</span>     <span>${data.month || '—'}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Status</span>    <span>${(data.status || 'paid').toUpperCase()}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Date</span>      <span>${data.datePaid ? new Date(data.datePaid).toLocaleDateString() : '—'}</span></div>
            </div>
            <div style="margin-top:1rem;display:flex;gap:0.5rem">
                <button class="btn btn-secondary btn-sm" onclick="window.print()">🖨️ Print</button>
                <button class="btn btn-primary btn-sm"   onclick="downloadPDF('${data._id}')">📄 PDF</button>
            </div>
        </div>`;
}


// ═══════════════════════════════════════
// RULES
// ═══════════════════════════════════════

function renderRules(rules) {
    const el = document.getElementById('rulesList');

    if (!rules.length) {
        el.innerHTML = '<div class="empty-state"><span class="icon">📜</span>No rules yet</div>';
        return;
    }

    el.innerHTML = rules.map((r, i) => `
        <div style="padding:0.85rem 0;border-bottom:1px solid var(--border);display:flex;gap:0.75rem;align-items:flex-start">
            <span style="font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--accent);background:var(--accent-dim);padding:2px 7px;border-radius:99px;flex-shrink:0;margin-top:2px">${i + 1}</span>
            <div style="flex:1;min-width:0">
                <div style="font-size:0.83rem;font-weight:600;color:var(--text);margin-bottom:0.2rem">${r.title}</div>
                <div style="font-size:0.78rem;color:var(--text-dim);line-height:1.5">${r.content}</div>
                <div style="font-size:0.6rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace;margin-top:0.3rem">${new Date(r.createdAt).toLocaleDateString()}</div>
            </div>
            <button class="btn btn-danger btn-sm" onclick="deleteRule('${r._id}')" style="flex-shrink:0">🗑️</button>
        </div>`).join('');
}


// ═══════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════

function renderAnnouncements(data) {
    const el = document.getElementById('announcementList');

    if (!data.length) {
        el.innerHTML = '<div class="empty-state"><span class="icon">📢</span>No announcements yet</div>';
        return;
    }

    el.innerHTML = data.map(a => `
        <div style="padding:0.75rem 0;border-bottom:1px solid var(--border);display:flex;gap:0.75rem;align-items:flex-start">
            <div style="flex:1;min-width:0">
                <div style="font-size:0.82rem;color:var(--text);line-height:1.5;margin-bottom:0.2rem">${a.message}</div>
                <div style="font-size:0.6rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace">
                    ${new Date(a.createdAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}
                </div>
            </div>
            <button class="btn btn-danger btn-sm" onclick="deleteAnnouncement('${a._id}')" style="flex-shrink:0">🗑️</button>
        </div>`).join('');
}


// ═══════════════════════════════════════
// CHAT
// ═══════════════════════════════════════

function renderChat(messages, tenantId) {
    const box = document.getElementById('adminChatBox');

    if (!messages.length) {
        box.innerHTML = '<div class="empty-state"><span class="icon">💬</span>No messages yet in this thread</div>';
        return;
    }

    box.innerHTML = messages.map(m => {
        const isAdmin = m.sender === 'admin';
        return `
            <div class="msg-bubble ${isAdmin ? 'msg-admin' : 'msg-tenant'}">
                ${m.text}
                <div class="msg-meta">
                    ${isAdmin ? '🔑 You (Admin)' : '👤 Tenant'} ·
                    ${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    ${(!isAdmin && !m.isRead) ? '<span style="color:var(--danger);margin-left:4px">●</span>' : ''}
                </div>
            </div>`;
    }).join('');

    box.scrollTop = box.scrollHeight;
}

// FIX 6: guard against _allTenants not yet loaded
function renderUnreadSummary(data) {
    const el = document.getElementById('unreadSummary');

    if (!data.length) {
        el.innerHTML = '<div class="empty-state"><span class="icon">✅</span>No unread messages</div>';
        return;
    }

    el.innerHTML = data.map(d => {
        const tenant = Array.isArray(_allTenants)
            ? _allTenants.find(t => String(t._id) === String(d._id))
            : null;
        const name   = tenant ? tenant.name : 'Unknown Tenant';
        const initial = name[0]?.toUpperCase() || '?';

        return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0;border-bottom:1px solid var(--border);cursor:pointer"
                 onclick="document.getElementById('chatTenant').value='${d._id}'; loadAdminChat();">
                <div style="display:flex;align-items:center;gap:0.5rem">
                    <div style="width:28px;height:28px;border-radius:50%;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:700;color:var(--accent)">${initial}</div>
                    <span style="font-size:0.82rem;color:var(--text)">${name}</span>
                </div>
                <span class="pill pill-red">${d.count} unread</span>
            </div>`;
    }).join('');
}


// ═══════════════════════════════════════
// CHARTS (FIX 7)
// Re-render charts when theme changes so colours update
// ═══════════════════════════════════════

let _financeChart, _occupancyChart;
let _lastChartData = null; // cache last data so theme change can re-render

function renderCharts(data) {
    _lastChartData = data; // cache for theme re-renders

    const accent  = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const danger  = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    const warn    = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim();
    const textDim = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim();

    // Finance bar chart
    const fc = document.getElementById('financeChart');
    if (_financeChart) _financeChart.destroy();
    _financeChart = new Chart(fc.getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Income', 'Arrears'],
            datasets: [{
                data:            [data.totalIncome, data.totalArrears],
                backgroundColor: [accent + '33', danger + '33'],
                borderColor:     [accent, danger],
                borderWidth:     1.5,
                borderRadius:    5
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: textDim } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: textDim } }
            }
        }
    });

    // Occupancy doughnut
    const oc = document.getElementById('occupancyChart');
    if (_occupancyChart) _occupancyChart.destroy();
    _occupancyChart = new Chart(oc.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Occupied', 'Vacant'],
            datasets: [{
                data:            [data.occupiedHouses, data.vacantHouses],
                backgroundColor: [accent + '55', warn + '55'],
                borderColor:     [accent, warn],
                borderWidth:     1.5
            }]
        },
        options: {
            responsive: true,
            cutout: '68%',
            plugins: {
                legend: {
                    labels: { color: textDim, font: { family: 'JetBrains Mono', size: 10 } }
                }
            }
        }
    });
}

// FIX 7: Hook into setTheme so charts re-render with new colours
const _origSetTheme = window.setTheme;
window.setTheme = function(theme) {
    if (typeof _origSetTheme === 'function') _origSetTheme(theme);
    // Re-render charts after a tick so CSS vars have updated
    if (_lastChartData) {
        setTimeout(() => renderCharts(_lastChartData), 50);
    }
};