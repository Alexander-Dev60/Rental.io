// ═══════════════════════════════════════════════════════
//  index.js — Admin UI / DOM Rendering Layer
//  Handles: navigation, rendering lists/tables/charts,
//           modals, toasts, themes, context menus.
//  No fetch() calls here — those are in script.js.
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════

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

    // Highlight sidebar item
    document.querySelectorAll('.nav-item').forEach(n => {
        if (n.getAttribute('onclick')?.includes(`'${name}'`)) {
            n.classList.add('active');
        }
    });

    document.getElementById('topbarTitle').textContent = SECTION_TITLES[name] || name;

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');

    // Lazy load section data
    if (name === 'assign')  { loadTenants(); loadHouses(); }
    if (name === 'tenants') { loadTenants(); }
    if (name === 'arrears') { loadArrears(); }
    if (name === 'messages'){ loadUnread(); populateChatSelect(); }
    if (name === 'announcements') loadAnnouncements();
    if (name === 'rules')   loadRules();
    if (name === 'houses')  loadHouses();
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

// ═══════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);

    document.querySelectorAll('.theme-dot').forEach(d => {
        d.classList.toggle('active', d.dataset.theme === theme);
    });
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
// MODALS
// ═══════════════════════════════════════════

function openModal(id) {
    document.getElementById(id).classList.add('open');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('open');
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.classList.remove('open');
    });
});

// ═══════════════════════════════════════════
// TENANT LIST RENDERING
// ═══════════════════════════════════════════

function renderTenantList(tenants) {
    const list = document.getElementById('tenantList');

    if (!tenants.length) {
        list.innerHTML = '<div class="empty-state"><span class="icon">👥</span>No tenants found</div>';
        return;
    }

    list.innerHTML = tenants.map(t => {
        const initials = t.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const house    = t.house ? `House ${t.house.name || t.house}` : 'No house';
        return `
            <div class="tenant-row" id="row-${t._id}" onclick="handleTenantClick(event, ${JSON.stringify(t).replace(/"/g, '&quot;')})">
                <div class="tenant-avatar">${initials}</div>
                <div class="tenant-info">
                    <div class="tenant-name">${t.name}</div>
                    <div class="tenant-meta">${t.phone} · ${house}</div>
                </div>
            </div>`;
    }).join('');
}

// ═══════════════════════════════════════════
// TENANT CONTEXT MENU
// ═══════════════════════════════════════════

function handleTenantClick(event, tenant) {
    // Remove existing menus
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    document.querySelectorAll('.tenant-row').forEach(r => r.classList.remove('selected'));

    const row = document.getElementById(`row-${tenant._id}`);
    row.classList.add('selected');

    // Load profile on side
    loadTenantProfile(tenant._id);

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = `
        <div class="ctx-item" onclick="loadTenantProfile('${tenant._id}'); document.querySelectorAll('.ctx-menu').forEach(m=>m.remove())">
            👁️ View Profile
        </div>
        <div class="ctx-item" onclick="openPayModal(${JSON.stringify(tenant).replace(/"/g, '&quot;')})">
            💳 Pay Rent
        </div>
        <div class="ctx-divider"></div>
        <div class="ctx-item" onclick="openResetModal(${JSON.stringify(tenant).replace(/"/g, '&quot;')})">
            🔑 Reset Password
        </div>
        <div class="ctx-divider"></div>
        <div class="ctx-item danger" onclick="openDeleteModal(${JSON.stringify(tenant).replace(/"/g, '&quot;')})">
            🗑️ Delete Tenant
        </div>`;

    row.style.position = 'relative';
    row.appendChild(menu);

    // Click outside to close
    setTimeout(() => {
        document.addEventListener('click', function closeCtx(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeCtx);
            }
        });
    }, 0);
}

// ═══════════════════════════════════════════
// PROFILE RENDERING
// ═══════════════════════════════════════════

function renderProfile(data) {
    const t        = data.tenant;
    const house    = t.house ? t.house.name : 'Not assigned';
    const payments = data.payments || [];

    const payRows = payments.length
        ? payments.map(p => `
            <tr>
                <td>${p.month}</td>
                <td class="td-mono">Ksh ${p.amount.toLocaleString()}</td>
                <td><span class="pill pill-green">${p.status || 'paid'}</span></td>
            </tr>`).join('')
        : `<tr><td colspan="3" style="text-align:center;color:var(--text-dim)">No payments yet</td></tr>`;

    document.getElementById('profileOutput').innerHTML = `
        <div style="margin-bottom:1rem">
            <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.4rem;color:var(--text);margin-bottom:0.25rem">${t.name}</div>
            <div style="font-size:0.75rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace">${t.email} · ${t.phone}</div>
            <div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap">
                <span class="pill pill-green">🏠 ${house}</span>
                <span class="pill ${data.arrears > 0 ? 'pill-red' : 'pill-green'}">
                    ${data.arrears > 0 ? `⚠️ Arrears: Ksh ${data.arrears.toLocaleString()}` : '✅ All paid'}
                </span>
            </div>
        </div>
        <div style="font-size:0.62rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim);margin-bottom:0.5rem">Payment History</div>
        <div class="table-wrap">
            <table>
                <thead><tr><th>Month</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>${payRows}</tbody>
            </table>
        </div>
        <div style="margin-top:0.75rem;font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--text-dim)">
            Total paid: <strong style="color:var(--accent)">Ksh ${(data.totalPaid || 0).toLocaleString()}</strong>
        </div>`;
}

// ═══════════════════════════════════════════
// ARREARS TABLE
// ═══════════════════════════════════════════

async function loadArrears() {
    const monthInput = document.getElementById('arrearsMonth');
    const month = monthInput ? monthInput.value.trim() : '';

    const url = month
        ? `${API}/arrears/${encodeURIComponent(month)}`
        : `${API}/arrears`;

    try {
        const res = await fetch(url, { headers: authHeaders() });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.message || `Failed to load arrears (${res.status})`, 'error');
            return;
        }

        const data = await res.json();

        if (!Array.isArray(data)) {
            showToast('Unexpected response from server', 'error');
            return;
        }

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
            <td class="td-mono">Ksh ${r.rent.toLocaleString()}</td>
            <td class="td-mono">Ksh ${r.totalPaid.toLocaleString()}</td>
            <td><span class="pill pill-red">Ksh ${r.balance.toLocaleString()}</span></td>
            <td><span class="pill pill-yellow">${r.status.toUpperCase()}</span></td>
            <td>
                <button class="btn btn-primary btn-sm" onclick="quickPay('${r.tenantId}')">Pay Now</button>
            </td>
        </tr>`).join('');
}

function quickPay(tenantId) {
    const tenant = _allTenants.find(t => t._id === tenantId);
    if (tenant) openPayModal(tenant);
}
// ═══════════════════════════════════════════
// HOUSE GRID
// ═══════════════════════════════════════════

function renderHouseGrid(houses) {
    const grid = document.getElementById('houseGrid');

    if (!houses.length) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><span class="icon">🏡</span>No houses added yet</div>';
        return;
    }

    grid.innerHTML = houses.map(h => `
        <div class="house-card ${h.status}" onclick="houseOptions(event, '${h._id}', '${h.name}', '${h.status}')">
            <div class="house-name">${h.name}</div>
            <div class="house-rent">Ksh ${h.rent.toLocaleString()} / mo</div>
            <div style="margin-top:0.5rem;font-size:0.68rem">
                <span class="status-dot ${h.status}"></span>
                ${h.status}
            </div>
        </div>`).join('');
}

function houseOptions(event, id, name, status) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());

    const card = event.currentTarget;
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.style.top  = 'auto';
    menu.style.bottom = '100%';
    menu.innerHTML = `
        <div class="ctx-item" style="font-size:0.7rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace;cursor:default">${name}</div>
        <div class="ctx-divider"></div>
        ${status === 'available'
            ? `<div class="ctx-item" onclick="showSection('assign')">🔑 Assign Tenant</div>`
            : `<div class="ctx-item" onclick="showSection('houses')" style="color:var(--warn)">🚪 Move Out Tenant</div>`
        }
        <div class="ctx-item danger" onclick="deleteHouse('${id}')">🗑️ Delete House</div>`;

    card.style.position = 'relative';
    card.appendChild(menu);

    setTimeout(() => {
        document.addEventListener('click', function close(e) {
            if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
        });
    }, 0);
}

// ═══════════════════════════════════════════
// SELECT POPULATION
// ═══════════════════════════════════════════

function populateTenantSelects(tenants) {
    const selects = ['tenantSelect', 'payTenantSelect', 'moveOutSelect', 'chatTenant'];
    selects.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = `<option value="">-- Select tenant --</option>` +
            tenants.map(t => `<option value="${t._id}">${t.name}</option>`).join('');
    });
}

function populateHouseSelects(houses) {
    const el = document.getElementById('houseSelect');
    if (!el) return;
    el.innerHTML = `<option value="">-- Select house --</option>` +
        houses
            .filter(h => h.status === 'available')
            .map(h => `<option value="${h._id}">${h.name} (Ksh ${h.rent.toLocaleString()})</option>`)
            .join('');
}

function populateChatSelect() {
    // chatTenant already populated by populateTenantSelects
}

// ═══════════════════════════════════════════
// RECEIPT RENDERING
// ═══════════════════════════════════════════

function renderReceipt(data, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = `
        <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:1.25rem;margin-top:0.5rem">
            <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.2rem;color:var(--accent);margin-bottom:0.75rem">🏠 Rent Receipt</div>
            <div style="display:flex;flex-direction:column;gap:0.4rem;font-size:0.78rem;font-family:'JetBrains Mono',monospace">
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Tenant</span><span>${data.tenant?.name}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">House</span><span>${data.house?.name}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Amount</span><span style="color:var(--accent)">Ksh ${data.amount?.toLocaleString()}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Month</span><span>${data.month}</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Date</span><span>${new Date(data.datePaid).toLocaleDateString()}</span></div>
            </div>
            <div style="margin-top:1rem;display:flex;gap:0.5rem">
                <button class="btn btn-secondary btn-sm" onclick="window.print()">🖨️ Print</button>
                <button class="btn btn-primary btn-sm"   onclick="downloadPDF('${data._id}')">📄 PDF</button>
            </div>
        </div>`;
}

// ═══════════════════════════════════════════════════════
//  REPLACE THESE RENDER FUNCTIONS IN admin index.js
// ═══════════════════════════════════════════════════════


// ════════════════════════════════
// RULES — replace renderRules()
// ════════════════════════════════

function renderRules(rules) {
    const el = document.getElementById('rulesList');

    if (!rules.length) {
        el.innerHTML = '<div class="empty-state"><span class="icon">📜</span>No rules yet</div>';
        return;
    }

    el.innerHTML = rules.map((r, i) => `
        <div style="padding:0.85rem 0;border-bottom:1px solid var(--border);display:flex;gap:0.75rem;align-items:flex-start">
            <span style="
                font-family:'JetBrains Mono',monospace;
                font-size:0.6rem;
                color:var(--accent);
                background:var(--accent-dim);
                padding:2px 7px;
                border-radius:99px;
                flex-shrink:0;
                margin-top:2px
            ">${i + 1}</span>
            <div style="flex:1;min-width:0">
                <div style="font-size:0.83rem;font-weight:600;color:var(--text);margin-bottom:0.2rem">${r.title}</div>
                <div style="font-size:0.78rem;color:var(--text-dim);line-height:1.5">${r.content}</div>
                <div style="font-size:0.6rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace;margin-top:0.3rem">
                    ${new Date(r.createdAt).toLocaleDateString()}
                </div>
            </div>
            <button
                class="btn btn-danger btn-sm"
                onclick="deleteRule('${r._id}')"
                title="Delete rule"
                style="flex-shrink:0"
            >🗑️</button>
        </div>`).join('');
}


// ════════════════════════════════
// ANNOUNCEMENTS — replace renderAnnouncements()
// ════════════════════════════════

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
                    ${new Date(a.createdAt).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'})}
                </div>
            </div>
            <button
                class="btn btn-danger btn-sm"
                onclick="deleteAnnouncement('${a._id}')"
                title="Delete announcement"
                style="flex-shrink:0"
            >🗑️</button>
        </div>`).join('');
}


// ════════════════════════════════
// CHAT — replace renderChat() and renderUnreadSummary()
// ════════════════════════════════

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
                    ${new Date(m.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                    ${(!isAdmin && !m.isRead) ? '<span style="color:var(--danger);margin-left:4px">●</span>' : ''}
                </div>
            </div>`;
    }).join('');

    // Scroll to bottom
    box.scrollTop = box.scrollHeight;
}


function renderUnreadSummary(data) {
    const el = document.getElementById('unreadSummary');

    if (!data.length) {
        el.innerHTML = '<div class="empty-state"><span class="icon">✅</span>No unread messages</div>';
        return;
    }

    el.innerHTML = data.map(d => {
        // Match tenant name from loaded list
        const tenant = (_allTenants || []).find(t => t._id === String(d._id));
        const name   = tenant ? tenant.name : 'Unknown Tenant';

        return `
            <div style="
                display:flex;
                align-items:center;
                justify-content:space-between;
                padding:0.6rem 0;
                border-bottom:1px solid var(--border);
                cursor:pointer
            " onclick="
                document.getElementById('chatTenant').value = '${d._id}';
                loadAdminChat();
            ">
                <div style="display:flex;align-items:center;gap:0.5rem">
                    <div style="
                        width:28px;height:28px;border-radius:50%;
                        background:var(--accent-dim);
                        display:flex;align-items:center;justify-content:center;
                        font-size:0.7rem;font-weight:700;color:var(--accent)
                    ">${name[0]?.toUpperCase() || '?'}</div>
                    <span style="font-size:0.82rem;color:var(--text)">${name}</span>
                </div>
                <span class="pill pill-red">${d.count} unread</span>
            </div>`;
    }).join('');
}


// ════════════════════════════════
// POPULATE CHAT SELECT
// Add this to populateTenantSelects() or call separately
// ════════════════════════════════

function populateChatSelect() {
    const el = document.getElementById('chatTenant');
    if (!el || !_allTenants) return;

    el.innerHTML = `<option value="">-- Select tenant --</option>` +
        _allTenants.map(t => `<option value="${t._id}">${t.name}</option>`).join('');
}


// ═══════════════════════════════════════════
// CHARTS
// ═══════════════════════════════════════════

let _financeChart, _occupancyChart;

function renderCharts(data) {
    // Finance chart
    const fc = document.getElementById('financeChart');
    if (_financeChart) _financeChart.destroy();

    const accent  = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const danger  = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    const textDim = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim();

    _financeChart = new Chart(fc.getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Income', 'Arrears'],
            datasets: [{
                data: [data.totalIncome, data.totalArrears],
                backgroundColor: [accent + '33', danger + '33'],
                borderColor:     [accent, danger],
                borderWidth: 1.5,
                borderRadius: 5
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

    const warn = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim();

    _occupancyChart = new Chart(oc.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Occupied', 'Vacant'],
            datasets: [{
                data: [data.occupiedHouses, data.vacantHouses],
                backgroundColor: [accent + '55', warn + '55'],
                borderColor:     [accent, warn],
                borderWidth: 1.5
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