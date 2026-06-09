// ═══════════════════════════════════════════════════════
//  index.js renamed to dashboard.js — Landlord UI / DOM Rendering Layer
//  No fetch() calls here — those are in script.js.
// ═══════════════════════════════════════════════════════


// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════

const SECTION_TITLES = {
    dashboard:     'Dashboard',
    tenants:       'All Tenants',
    arrears:       'Arrears',
    addTenant:     'Add New Tenant',
    properties:    'My Properties',
    houses:        'Houses',
    assign:        'Assign House',
    payments:      'Record Payment',
    receipts:      'Receipts',
    messages:      'Messages',
    announcements: 'Announcements',
    rules:         'House Rules',
    inquiries:     'Rental Inquiries'   // NEW
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

    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('show');
    document.body.style.overflow = '';

    // Lazy-load section data
    if (name === 'assign')        { loadTenants(); loadHouses(); }
    if (name === 'tenants')       { loadTenants(); loadMovedOutTenants(); }
    if (name === 'arrears')       { loadArrears(); }
    if (name === 'messages')      { initMessagingSection(); }
    if (name === 'announcements') { loadAnnouncements(); }
    if (name === 'rules')         { loadRules(); }
    if (name === 'houses')        { loadHouses(); }
    if (name === 'properties')    { loadProperties(); }
    if (name === 'inquiries')     { loadInquiries(); }   // NEW
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}


// ═══════════════════════════════════════
// THEME
// ═══════════════════════════════════════

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('admin-theme', theme);
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
// PROPERTY SWITCHER RENDERING
// ═══════════════════════════════════════

function renderPropertySwitcher(properties) {
    const menu     = document.getElementById('propertyMenu');
    const nameEl   = document.getElementById('activePropertyName');
    const arrowEl  = document.getElementById('switcherArrow');
    const activeId = localStorage.getItem('activePropertyId');

    const active = properties.find(p => p._id === activeId) || properties[0];
    if (nameEl && active) nameEl.textContent = active.name;

    if (arrowEl) arrowEl.style.display = properties.length > 1 ? 'inline' : 'none';

    if (!menu) return;

    if (properties.length <= 1) {
        menu.innerHTML = '';
        return;
    }

    menu.innerHTML = properties.map(p => `
        <div class="property-menu-item ${p._id === activeId ? 'active' : ''}"
             onclick="switchProperty('${p._id}', '${p.name.replace(/'/g, "\\'")}')">
            <span class="property-menu-dot ${p._id === activeId ? 'active' : ''}"></span>
            <div style="flex:1;min-width:0">
                <div class="property-menu-name">${p.name}</div>
                ${p.location ? `<div class="property-menu-loc">📍 ${p.location}</div>` : ''}
            </div>
            ${p.paymentConfigured
                ? '<span style="font-size:0.6rem;color:var(--accent);flex-shrink:0">M-Pesa ✓</span>'
                : '<span style="font-size:0.6rem;color:var(--text-dim);flex-shrink:0">No M-Pesa</span>'}
            ${p._id === activeId ? '<span style="color:var(--accent);margin-left:0.5rem;flex-shrink:0">✓</span>' : ''}
        </div>`
    ).join('') + `
        <div class="property-menu-item" style="border-top:1px solid var(--border);margin-top:3px;padding-top:0.6rem"
             onclick="closePropertyMenu(); openModal('modal-add-property')">
            <span style="color:var(--accent);font-size:0.85rem">＋</span>
            <div class="property-menu-name" style="color:var(--accent)">Add Property</div>
        </div>`;
}

function updatePaymentSetupPropertySelect(properties) {
    const sel = document.getElementById('setupPropertyId');
    if (!sel) return;
    const activeId = localStorage.getItem('activePropertyId');
    sel.innerHTML = properties.map(p =>
        `<option value="${p._id}" ${p._id === activeId ? 'selected' : ''}>
            ${p.name}${p.paymentConfigured ? ' ✓ Configured' : ' (not configured)'}
         </option>`
    ).join('');
}

// ── UPDATED: renderPropertiesGrid now includes listing controls ──
function renderPropertiesGrid(properties) {
    const grid = document.getElementById('propertiesGrid');
    if (!grid) return;

    const activeId = localStorage.getItem('activePropertyId');

    if (!properties.length) {
        grid.innerHTML = '<div class="empty-state"><span class="icon">🏢</span>No properties yet. Add your first property.</div>';
        return;
    }

    grid.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem">` +
    properties.map(p => `
        <div style="background:var(--panel);border:1px solid ${p._id === activeId ? 'var(--accent)' : 'var(--border)'};border-radius:10px;overflow:hidden;transition:border-color 0.2s">

          <!-- Property header — click to switch active property -->
          <div style="padding:1rem 1.25rem;cursor:pointer;border-bottom:1px solid var(--border)"
               onclick="switchProperty('${p._id}', '${p.name.replace(/'/g, "\\'")}')">
            <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.2rem;color:var(--text);margin-bottom:0.25rem">${p.name}</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim)">
              ${p.location ? `📍 ${p.location}` : '—'}
            </div>
            <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.5rem">
              ${p._id === activeId
                ? '<span class="pill pill-green">● Active</span>'
                : '<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)">Switch →</span>'}
              ${p.paymentConfigured
                ? '<span class="pill pill-green">M-Pesa ✓</span>'
                : '<span class="pill pill-yellow">No M-Pesa</span>'}
            </div>
          </div>

          <!-- Public listing controls -->
          <div style="padding:0.85rem 1.25rem">
            <div style="font-size:0.6rem;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-dim);margin-bottom:0.65rem">Public Listing</div>

            <!-- isListed toggle -->
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.65rem">
              <span style="font-size:0.78rem;color:var(--text-muted)">Visible on listings page</span>
              <div style="position:relative;width:36px;height:20px;flex-shrink:0;display:inline-block;cursor:pointer"
                   onclick="handleListingToggle('${p._id}', ${!p.isListed})"
                   title="${p.isListed ? 'Click to hide from public listings' : 'Click to show on public listings'}">
                <div style="position:absolute;inset:0;background:${p.isListed ? 'var(--accent)' : 'var(--border2)'};border-radius:99px;transition:background 0.2s">
                  <div style="position:absolute;width:14px;height:14px;top:3px;left:${p.isListed ? '19px' : '3px'};background:white;border-radius:50%;transition:left 0.2s"></div>
                </div>
              </div>
            </div>

            <!-- Approval status notice -->
            ${p.isListed && !p.isApproved ? `
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--warn);background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:6px;padding:0.4rem 0.65rem;margin-bottom:0.65rem">
              ⏳ Pending admin approval before going live
            </div>` : ''}

            ${p.isListed && p.isApproved ? `
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--accent);background:var(--accent-dim);border:1px solid rgba(110,231,183,0.2);border-radius:6px;padding:0.4rem 0.65rem;margin-bottom:0.65rem">
              ✅ Live on public listings page
            </div>` : ''}

            <!-- Edit description button -->
            <button class="btn btn-secondary btn-sm btn-full"
              style="margin-bottom:0.5rem"
              onclick="openListingEditor('${p._id}')">
              ✏️ Edit Description &amp; Details
            </button>
            <!-- Preview link — only when live -->
            ${p.isListed && p.isApproved ? `
            <a href="listings.html${p.location ? '?location=' + encodeURIComponent(p.location.split(',')[0].trim()) : ''}"
               target="_blank"
               class="btn btn-secondary btn-sm btn-full"
               style="text-decoration:none;display:flex;align-items:center;justify-content:center">
              👁 Preview on Listings Page
            </a>` : ''}
          </div>
        </div>`
    ).join('') +
    `<div style="background:var(--panel);border:1px dashed var(--border2);border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;min-height:160px"
          onclick="openModal('modal-add-property')">
        <div style="text-align:center;color:var(--text-dim)">
          <div style="font-size:1.5rem;margin-bottom:0.3rem">＋</div>
          <div style="font-size:0.75rem">Add Property</div>
        </div>
     </div>
    </div>`;
}


// ═══════════════════════════════════════
// TENANT LIST RENDERING
// ═══════════════════════════════════════

function renderTenantList(tenants) {
    const list = document.getElementById('tenantList');

    if (!tenants.length) {
        list.innerHTML = '<div class="empty-state"><span class="icon">👥</span>No tenants found</div>';
        return;
    }

    list.innerHTML = tenants.map(t => {
        const initials = t.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const house    = t.house ? (t.house.name || t.house) : 'No house';

        let badge = '';
        if (t.paymentStatus === 'paid') {
            badge = `<span class="paid-badge">Paid</span>`;
        } else if (t.paymentStatus === 'partial') {
            badge = `<span class="partial-badge">Partial</span>`;
        } else if (t.paymentStatus === 'unpaid' && t.house) {
            badge = `<span class="arrears-badge">Unpaid</span>`;
        }

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

function renderMovedOutList(tenants) {
    const list = document.getElementById('movedOutList');
    if (!list) return;

    if (!tenants.length) {
        list.innerHTML = '<div class="empty-state"><span class="icon">🚪</span>No moved-out tenants</div>';
        return;
    }

    list.innerHTML = tenants.map(t => {
        const initials     = t.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const prevProperty = t.lastProperty?.name || '—';
        const prevHouse    = t.lastHouse?.name    || '—';
        const movedOutDate = t.movedOutAt
            ? new Date(t.movedOutAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
            : '—';

        const tenantData = encodeURIComponent(JSON.stringify(t));

        return `
            <div class="tenant-row" id="row-mo-${t._id}" style="opacity:0.8"
                 onclick="handleMovedOutTenantClick(event, JSON.parse(decodeURIComponent('${tenantData}')))">
                <div class="tenant-avatar" style="opacity:0.6">${initials}</div>
                <div class="tenant-info">
                    <div class="tenant-name">${t.name}</div>
                    <div class="tenant-meta">${t.phone || '—'} · ${prevProperty} · ${prevHouse}</div>
                    <div class="tenant-meta" style="margin-top:2px;color:var(--warn)">Moved out: ${movedOutDate}</div>
                </div>
                <span class="pill pill-yellow" style="flex-shrink:0;font-size:0.58rem">Moved Out</span>
            </div>`;
    }).join('');
}


// ═══════════════════════════════════════
// TENANT CONTEXT MENUS
// ═══════════════════════════════════════

function handleTenantClick(event, tenant) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    document.querySelectorAll('.tenant-row').forEach(r => r.classList.remove('selected'));

    const row = document.getElementById(`row-${tenant._id}`);
    if (row) row.classList.add('selected');

    loadTenantProfile(tenant._id);

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.dataset.tenantId = tenant._id;

    menu.innerHTML = `
        <div class="ctx-item" onclick="_ctxViewProfile('${tenant._id}')">👁️ View Profile</div>
        <div class="ctx-item" onclick="_ctxPayRent('${tenant._id}')">💳 Pay Rent</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item" onclick="_ctxResetPassword('${tenant._id}')">🔑 Reset Password</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item danger" onclick="_ctxDelete('${tenant._id}')">🗑️ Delete Permanently</div>`;

    if (row) {
        row.style.position = 'relative';
        row.appendChild(menu);
    }

    setTimeout(() => {
        document.addEventListener('click', function closeCtx(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeCtx);
            }
        });
    }, 0);
}

function handleMovedOutTenantClick(event, tenant) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    document.querySelectorAll('.tenant-row').forEach(r => r.classList.remove('selected'));

    const row = document.getElementById(`row-mo-${tenant._id}`);
    if (row) row.classList.add('selected');

    loadTenantProfile(tenant._id);

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.dataset.tenantId = tenant._id;

    menu.innerHTML = `
        <div class="ctx-item" onclick="_ctxViewProfile('${tenant._id}')">👁️ View Profile & History</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item" style="color:var(--accent)" onclick="_ctxReactivate('${tenant._id}')">🔄 Reactivate Tenant</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item danger" onclick="_ctxDelete('${tenant._id}')">🗑️ Delete Permanently</div>`;

    if (row) {
        row.style.position = 'relative';
        row.appendChild(menu);
    }

    setTimeout(() => {
        document.addEventListener('click', function closeCtx(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeCtx);
            }
        });
    }, 0);
}

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
    const tenant = _allTenants.find(t => t._id === id)
                || _movedOutTenants.find(t => t._id === id);
    if (tenant) openDeleteModal(tenant);
}

function _ctxReactivate(id) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const tenant = _movedOutTenants.find(t => t._id === id);
    if (tenant) openReactivateModal(tenant);
}


// ═══════════════════════════════════════
// REACTIVATE MODAL
// ═══════════════════════════════════════

function openReactivateModal(tenant) {
    let modal = document.getElementById('modal-reactivate');
    if (!modal) {
        modal = document.createElement('div');
        modal.id        = 'modal-reactivate';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal" style="max-width:420px">
                <div class="modal-header">
                    <div class="modal-title">🔄 Reactivate Tenant</div>
                    <button class="modal-close" onclick="closeModal('modal-reactivate')">✕</button>
                </div>
                <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:0.85rem 1rem;margin-bottom:1.25rem">
                    <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.1rem;color:var(--text);margin-bottom:0.3rem" id="reactivateModalName"></div>
                    <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim)" id="reactivateModalMeta"></div>
                </div>
                <label style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);display:block;margin-bottom:0.35rem">Assign to House</label>
                <select id="reactivateHouseSelect" style="margin-bottom:1rem"></select>
                <input type="hidden" id="reactivateTenantId">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                    <button class="btn btn-secondary btn-full" onclick="closeModal('modal-reactivate')">Cancel</button>
                    <button class="btn btn-primary btn-full"   onclick="submitReactivate()">🔄 Reactivate</button>
                </div>
            </div>`;
        modal.addEventListener('click', e => { if (e.target === modal) closeModal('modal-reactivate'); });
        document.body.appendChild(modal);
    }

    const prevProp    = tenant.lastProperty?.name || '—';
    const prevHouse   = tenant.lastHouse?.name    || '—';
    const movedOutStr = tenant.movedOutAt
        ? new Date(tenant.movedOutAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';

    document.getElementById('reactivateModalName').textContent = tenant.name;
    document.getElementById('reactivateModalMeta').innerHTML   =
        `${tenant.email} · ${tenant.phone || '—'}<br>` +
        `Previously: ${prevProp} / ${prevHouse} · Moved out: ${movedOutStr}`;
    document.getElementById('reactivateTenantId').value = tenant._id;

    const sel             = document.getElementById('reactivateHouseSelect');
    const availableHouses = (typeof _allHouses !== 'undefined' ? _allHouses : [])
        .filter(h => h.status === 'available');

    if (availableHouses.length) {
        sel.innerHTML = `<option value="">— Select a house —</option>` +
            availableHouses.map(h =>
                `<option value="${h._id}">${h.name} — Ksh ${Number(h.rent).toLocaleString()} / mo</option>`
            ).join('');
    } else {
        const sourceSelect = document.getElementById('houseSelect');
        if (sourceSelect && sourceSelect.options.length > 1) {
            sel.innerHTML = sourceSelect.innerHTML;
        } else {
            sel.innerHTML = `<option value="">No available houses — add one first</option>`;
        }
    }

    modal.classList.add('open');
}

async function submitReactivate() {
    const tenantId = document.getElementById('reactivateTenantId').value;
    const houseId  = document.getElementById('reactivateHouseSelect').value;

    if (!houseId) { showToast('Select a house to assign', 'warn'); return; }

    const btn = document.querySelector('#modal-reactivate .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Reactivating...'; }

    const success = await reactivateTenant(tenantId, houseId);
    if (success) {
        closeModal('modal-reactivate');
        switchTenantTab('active');
    }

    if (btn) { btn.disabled = false; btn.textContent = '🔄 Reactivate'; }
}


// ═══════════════════════════════════════
// TENANT TAB SWITCHER
// ═══════════════════════════════════════

function switchTenantTab(tab) {
    const activeTab   = document.getElementById('tab-active');
    const movedOutTab = document.getElementById('tab-moved-out');
    const activePanel = document.getElementById('panel-active-tenants');
    const movedPanel  = document.getElementById('panel-moved-out-tenants');

    if (!activeTab || !movedOutTab || !activePanel || !movedPanel) return;

    if (tab === 'active') {
        activeTab.classList.add('active');
        movedOutTab.classList.remove('active');
        activePanel.style.display = 'block';
        movedPanel.style.display  = 'none';
    } else {
        movedOutTab.classList.add('active');
        activeTab.classList.remove('active');
        movedPanel.style.display  = 'block';
        activePanel.style.display = 'none';
        loadMovedOutTenants();
    }
}


// ═══════════════════════════════════════
// PROFILE RENDERING
// ═══════════════════════════════════════

function renderProfile(data) {
    const t        = data.tenant;
    const payments = data.payments || [];

    let movedOutBanner = '';
    if (t.status === 'moved_out') {
        const prevProperty = t.lastProperty?.name || '—';
        const prevHouse    = t.lastHouse?.name    || '—';
        const movedOutDate = t.movedOutAt
            ? new Date(t.movedOutAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
            : '—';

        movedOutBanner = `
            <div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.25rem">
                <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem">
                    <span style="font-size:1.1rem">🚪</span>
                    <span style="font-weight:700;color:var(--warn);font-size:0.85rem">This tenant has moved out</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;font-family:'JetBrains Mono',monospace;font-size:0.68rem">
                    <div>
                        <div style="color:var(--text-dim);margin-bottom:0.2rem">Previous Residence</div>
                        <div style="color:var(--text);font-weight:600">${prevProperty}</div>
                        <div style="color:var(--text-muted)">${prevHouse}</div>
                    </div>
                    <div>
                        <div style="color:var(--text-dim);margin-bottom:0.2rem">Move-out Date</div>
                        <div style="color:var(--text);font-weight:600">${movedOutDate}</div>
                    </div>
                </div>
                <div style="margin-top:0.85rem;padding-top:0.75rem;border-top:1px solid rgba(251,191,36,0.15);display:flex;gap:0.5rem;flex-wrap:wrap">
                    <button class="btn btn-sm" style="background:rgba(110,231,183,0.12);color:var(--accent);border:1px solid rgba(110,231,183,0.25);font-size:0.72rem"
                            onclick="_ctxReactivate('${t._id}')">🔄 Reactivate this tenant</button>
                    <button class="btn btn-sm btn-danger" style="font-size:0.72rem"
                            onclick="_ctxDelete('${t._id}')">🗑️ Delete Permanently</button>
                </div>
            </div>`;
    }

    const house = t.house ? (t.house.name || t.house) : null;
    const housePill = house && t.status !== 'moved_out'
        ? `<span class="pill pill-green">🏠 ${house}</span>`
        : '';

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
        ${movedOutBanner}
        <div style="margin-bottom:1rem">
            <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.4rem;color:var(--text);margin-bottom:0.25rem">${t.name}</div>
            <div style="font-size:0.75rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace">${t.email} · ${t.phone || '—'}</div>
            <div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap">
                ${housePill}
                ${t.status !== 'moved_out' ? `
                <span class="pill ${data.arrears > 0 ? 'pill-red' : 'pill-green'}">
                    ${data.arrears > 0 ? `⚠️ Arrears: Ksh ${Number(data.arrears).toLocaleString()}` : '✅ All paid'}
                </span>` : ''}
            </div>
        </div>
        <div style="font-size:0.62rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim);margin-bottom:0.5rem">Payment History</div>
        <div class="table-wrap">
            <table>
                <thead><tr><th>Month</th><th>Amount</th><th>Total Paid</th><th>Balance</th><th>Status</th><th>Date</th></tr></thead>
                <tbody>${payRows}</tbody>
            </table>
        </div>
        <div style="margin-top:0.75rem;font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--text-dim)">
            Lifetime total: <strong style="color:var(--accent)">Ksh ${Number(data.totalPaid || 0).toLocaleString()}</strong>
        </div>`;
}


// ═══════════════════════════════════════
// ARREARS TABLE
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
            <td><button class="btn btn-primary btn-sm" onclick="quickPay('${r.tenantId}')">Pay Now</button></td>
        </tr>`).join('');
}

function quickPay(tenantId) {
    const tenant = _allTenants.find(t => t._id === tenantId);
    if (tenant) openPayModal(tenant);
    else showToast('Tenant not found — click Refresh', 'warn');
}


// ═══════════════════════════════════════
// HOUSE GRID
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
             onclick="houseOptions(event, ${JSON.stringify(h).replace(/"/g, '&quot;')})">
            <div class="house-name">${h.name}</div>
            <div class="house-rent">Ksh ${Number(h.rent).toLocaleString()} / mo</div>
            <div style="margin-top:0.5rem;font-size:0.68rem">
                <span class="status-dot ${h.status}"></span>${h.status}
                ${h.tenantName ? `<span style="color:var(--text-muted);margin-left:0.4rem">· ${h.tenantName}</span>` : ''}
            </div>
        </div>`).join('');
}

function houseOptions(event, house) {
    event.stopPropagation();
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());

    const card = event.currentTarget;
    const menu = document.createElement('div');
    menu.className    = 'ctx-menu';
    menu.style.top    = '100%';
    menu.style.bottom = 'auto';
    menu.style.right  = '0';
    menu.style.left   = 'auto';
    menu.style.zIndex = '999';

    if (house.status === 'available') {
        menu.innerHTML = `
            <div class="ctx-item" style="font-size:0.7rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace;cursor:default">${house.name}</div>
            <div class="ctx-divider"></div>
            <div class="ctx-item" onclick="openAssignModal('${house._id}', '${house.name.replace(/'/g, "\\'")}')">🔑 Assign Tenant</div>
            <div class="ctx-item danger" onclick="deleteHouse('${house._id}')">🗑️ Delete House</div>`;
    } else {
        const tenantLabel = house.tenantName ? `Move Out ${house.tenantName}` : 'Move Out Tenant';
        menu.innerHTML = `
            <div class="ctx-item" style="font-size:0.7rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace;cursor:default">${house.name}</div>
            <div class="ctx-divider"></div>
            <div class="ctx-item" style="color:var(--warn)"
                 onclick="confirmMoveOutByHouse('${house._id}', '${house.name.replace(/'/g, "\\'")}', '${(house.tenantId || '').replace(/'/g, "\\'")}', '${(house.tenantName || 'Tenant').replace(/'/g, "\\'")}')">
                🚪 ${tenantLabel}
            </div>
            <div class="ctx-item danger" onclick="deleteHouse('${house._id}')">🗑️ Delete House</div>`;
    }

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

function openAssignModal(houseId, houseName) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());

    let modal = document.getElementById('modal-assign-house');
    if (!modal) {
        modal = document.createElement('div');
        modal.id        = 'modal-assign-house';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal" style="max-width:380px">
                <div class="modal-header">
                    <div class="modal-title">🔑 Assign Tenant</div>
                    <button class="modal-close" onclick="closeModal('modal-assign-house')">✕</button>
                </div>
                <div style="margin-bottom:1rem;padding:0.65rem 0.85rem;background:var(--bg3);border:1px solid var(--border);border-radius:7px;font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--accent)" id="assignModalHouseLabel"></div>
                <input type="hidden" id="assignModalHouseId">
                <label style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);display:block;margin-bottom:0.35rem">Select Tenant</label>
                <select id="assignModalTenantSelect" style="margin-bottom:0.75rem"></select>
                <button class="btn btn-primary btn-full" onclick="submitAssignFromModal()">Assign to House</button>
            </div>`;
        modal.addEventListener('click', e => { if (e.target === modal) closeModal('modal-assign-house'); });
        document.body.appendChild(modal);
    }

    document.getElementById('assignModalHouseLabel').textContent = `🏡 House: ${houseName}`;
    document.getElementById('assignModalHouseId').value          = houseId;

    const sel        = document.getElementById('assignModalTenantSelect');
    const unassigned = (_allTenants || []).filter(t => !t.house || t.house === null || t.house === '');
    if (!unassigned.length) {
        sel.innerHTML = `<option value="">— Select tenant —</option>` +
            (_allTenants || []).map(t => `<option value="${t._id}">${t.name}${t.house ? ' (has house)' : ''}</option>`).join('');
    } else {
        sel.innerHTML = `<option value="">— Select tenant —</option>` +
            unassigned.map(t => `<option value="${t._id}">${t.name}</option>`).join('');
    }

    modal.classList.add('open');
}

async function submitAssignFromModal() {
    const houseId  = document.getElementById('assignModalHouseId').value;
    const tenantId = document.getElementById('assignModalTenantSelect').value;
    if (!tenantId) { showToast('Select a tenant first', 'warn'); return; }

    const btn = document.querySelector('#modal-assign-house .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Assigning...'; }

    try {
        const res  = await fetch(`${API}/assign-house/${tenantId}/${houseId}`, {
            method: 'PUT', headers: authHeaders()
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || data.error || 'Assign failed', 'error'); return; }
        showToast(data.message || 'House assigned ✅', 'success');
        closeModal('modal-assign-house');
        await loadHouses();
        await loadTenants();
    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Assign to House'; }
    }
}

function confirmMoveOutByHouse(houseId, houseName, tenantId, tenantName) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());

    if (!tenantId) {
        showToast('Could not identify the tenant. Use Move Out from the Houses section.', 'warn');
        return;
    }

    openDangerModal({
        icon:    '🚪',
        title:   'Move Out Tenant',
        message: `Move out <strong>${tenantName}</strong> from <strong>${houseName}</strong>?<br><br>
                  The house will be marked as <strong>available</strong>. The tenant's login and payment history are preserved — they can be reactivated later.`,
        label:   `Move Out ${tenantName}`,
        type:    'warn',
        onConfirm: async () => {
            const res  = await fetch(`${API}/move-out/${tenantId}`, { method: 'PUT', headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) { showToast(data.message || data.error || 'Move out failed', 'error'); return; }
            showToast(data.message || `${tenantName} moved out ✅`, 'success');
            await loadHouses();
            await loadTenants();
            await loadMovedOutTenants();
        }
    });
}


// ═══════════════════════════════════════
// SELECT POPULATION
// ═══════════════════════════════════════

function populateTenantSelects(tenants) {
    // ── Exclude chatTenant — messaging now uses its own panel ──
    const ids = ['tenantSelect', 'payTenantSelect', 'moveOutSelect'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = `<option value="">— Select tenant —</option>` +
            tenants.map(t => `<option value="${t._id}">${t.name}</option>`).join('');
    });

    // Also refresh the messaging tenant panel whenever tenants reload
    renderMsgTenantList(tenants);
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
// MESSAGING — Two-panel persistent system
// ═══════════════════════════════════════

let _msgUnreadMap  = {};
let _msgPreviewMap = {};
let _activeChatTenantId = null;

function initMessagingSection() {
    const savedId = localStorage.getItem('activeChatTenantId');
    renderMsgTenantList(_allTenants);
    loadUnread().then(() => {
        if (savedId) {
            const tenant = _allTenants.find(t => t._id === savedId);
            if (tenant) { openChatThread(savedId, tenant.name); return; }
        }
        const topUnread = Object.entries(_msgUnreadMap).sort((a, b) => b[1] - a[1])[0];
        if (topUnread) {
            const tenant = _allTenants.find(t => t._id === topUnread[0]);
            if (tenant) openChatThread(topUnread[0], tenant.name);
        }
    });
}

function renderMsgTenantList(tenants) {
    const list = document.getElementById('msgTenantList');
    if (!list) return;

    if (!tenants || !tenants.length) {
        list.innerHTML = '<div style="padding:1.25rem;text-align:center;color:var(--text-dim);font-size:0.78rem">No active tenants</div>';
        return;
    }

    const sorted = [...tenants].sort((a, b) => {
        const ua = _msgUnreadMap[a._id] || 0;
        const ub = _msgUnreadMap[b._id] || 0;
        if (ub !== ua) return ub - ua;
        return a.name.localeCompare(b.name);
    });

    list.innerHTML = sorted.map(t => {
        const initials  = t.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const unread    = _msgUnreadMap[t._id] || 0;
        const preview   = _msgPreviewMap[t._id] || (t.house?.name ? `🏠 ${t.house.name}` : '');
        const isActive  = t._id === _activeChatTenantId;

        return `
            <div class="msg-tenant-item ${isActive ? 'active' : ''}"
                 id="msg-item-${t._id}"
                 onclick="openChatThread('${t._id}', '${t.name.replace(/'/g, "\\'")}')">
                <div class="msg-tenant-avatar">${initials}</div>
                <div class="msg-tenant-info">
                    <div class="msg-tenant-item-name">${t.name}</div>
                    <div class="msg-tenant-item-preview">${preview || 'No messages yet'}</div>
                </div>
                ${unread > 0
                    ? `<div class="msg-unread-dot">${unread > 9 ? '9+' : unread}</div>`
                    : ''}
            </div>`;
    }).join('');
}

function filterMsgTenants() {
    const q       = (document.getElementById('msgSearch')?.value || '').toLowerCase();
    const filtered = _allTenants.filter(t =>
        t.name.toLowerCase().includes(q) || (t.phone || '').includes(q)
    );
    renderMsgTenantList(filtered);
}

async function openChatThread(tenantId, tenantName) {
    _activeChatTenantId = tenantId;
    localStorage.setItem('activeChatTenantId', tenantId);

    document.querySelectorAll('.msg-tenant-item').forEach(el => el.classList.remove('active'));
    const item = document.getElementById(`msg-item-${tenantId}`);
    if (item) item.classList.add('active');

    const header = document.getElementById('msgChatHeader');
    const avatar = document.getElementById('msgChatAvatar');
    const name   = document.getElementById('msgChatName');
    const status = document.getElementById('msgChatStatus');
    if (header) header.style.display = 'flex';
    if (avatar) avatar.textContent = tenantName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    if (name)   name.textContent   = tenantName;
    if (status) status.textContent = 'Loading messages…';

    document.getElementById('msgNoSelection').style.display  = 'none';
    document.getElementById('msgChatBody').style.display     = 'flex';
    document.getElementById('msgChatFooter').style.display   = 'flex';

    await loadAdminChat(tenantId);

    if (status) status.textContent = 'Active tenant';
}

function renderChatMessages(messages) {
    const body = document.getElementById('msgChatBody');
    if (!body) return;

    if (!messages.length) {
        body.innerHTML = '<div style="text-align:center;color:var(--text-dim);font-size:0.8rem;padding:2rem">No messages yet in this thread</div>';
        return;
    }

    body.innerHTML = messages.map(m => {
        const isLandlord = m.sender === 'landlord';
        return `
            <div class="msg-bubble ${isLandlord ? 'msg-landlord' : 'msg-tenant'}">
                ${m.text}
                <div class="msg-meta">
                    ${isLandlord ? '🔑 You' : '👤 Tenant'} ·
                    ${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    ${(!isLandlord && !m.isRead) ? '<span style="color:var(--danger);margin-left:4px">●</span>' : ''}
                </div>
            </div>`;
    }).join('');

    body.scrollTop = body.scrollHeight;

    if (messages.length && _activeChatTenantId) {
        const last = messages[messages.length - 1];
        _msgPreviewMap[_activeChatTenantId] = last.text.slice(0, 40) + (last.text.length > 40 ? '…' : '');
    }
}

function updateUnreadBadges(unreadData) {
    _msgUnreadMap = {};
    unreadData.forEach(d => { _msgUnreadMap[String(d._id)] = d.count; });

    _allTenants.forEach(t => {
        const item   = document.getElementById(`msg-item-${t._id}`);
        if (!item) return;
        const unread = _msgUnreadMap[t._id] || 0;
        item.querySelector('.msg-unread-dot')?.remove();
        if (unread > 0) {
            const dot = document.createElement('div');
            dot.className   = 'msg-unread-dot';
            dot.textContent = unread > 9 ? '9+' : unread;
            item.appendChild(dot);
        }
    });

    if (document.getElementById('sec-messages')?.classList.contains('active')) {
        renderMsgTenantList(_allTenants);
        if (_activeChatTenantId) {
            const item = document.getElementById(`msg-item-${_activeChatTenantId}`);
            if (item) item.classList.add('active');
        }
    }
}

function openChatWithTenant(tenantId, tenantName) {
    showSection('messages');
    setTimeout(() => openChatThread(tenantId, tenantName), 50);
}


// ═══════════════════════════════════════
// PAYMENT CONFIRM MODAL
// ═══════════════════════════════════════

function makePayment() {
    const tenantId   = document.getElementById('payTenantSelect').value;
    const amount     = document.getElementById('amount').value;
    const month      = document.getElementById('month').value.trim();
    const method     = document.getElementById('payMethod').value;
    const note       = document.getElementById('payNote').value.trim();

    if (!tenantId || !amount || !month) { showToast('All fields required', 'warn'); return; }

    const tenant = _allTenants.find(t => t._id === tenantId);
    const name   = tenant ? tenant.name : 'Tenant';

    _showPayConfirm({
        tenantId, tenantName: name, amount: Number(amount),
        month, method, note, source: 'inline'
    });
}

function openPayConfirmModal() {
    const tenantId = document.getElementById('payModalTenantId').value;
    const amount   = document.getElementById('payModalAmount').value;
    const month    = document.getElementById('payModalMonth').value.trim();
    const method   = document.getElementById('payModalMethod').value;
    const note     = document.getElementById('payModalNote').value.trim();

    if (!amount || !month) { showToast('Fill all fields', 'warn'); return; }

    const tenantNameEl = document.getElementById('payModalTenantName');
    const tenantName   = tenantNameEl
        ? tenantNameEl.textContent.replace('Paying for: ', '')
        : 'Tenant';

    _showPayConfirm({
        tenantId, tenantName, amount: Number(amount),
        month, method, note, source: 'modal'
    });
}

let _pendingPayment = null;

function _showPayConfirm({ tenantId, tenantName, amount, month, method, note, source }) {
    _pendingPayment = { tenantId, amount, month, method, note, source };

    const methodLabel = { cash: 'Cash', mpesa: 'M-Pesa (manual)', bank: 'Bank Transfer', other: 'Other' };

    document.getElementById('payConfirmDetails').innerHTML = `
        <div class="pay-confirm-row">
            <span>Tenant</span>
            <span>${tenantName}</span>
        </div>
        <div class="pay-confirm-row">
            <span>Month</span>
            <span>${month}</span>
        </div>
        <div class="pay-confirm-row">
            <span>Amount</span>
            <span style="color:var(--accent);font-size:0.9rem">Ksh ${Number(amount).toLocaleString()}</span>
        </div>
        <div class="pay-confirm-row">
            <span>Method</span>
            <span>${methodLabel[method] || method}</span>
        </div>
        ${note ? `<div class="pay-confirm-row"><span>Note</span><span>${note}</span></div>` : ''}
    `;

    openModal('modal-pay-confirm');
}

async function submitConfirmedPayment() {
    if (!_pendingPayment) return;

    const btn = document.getElementById('payConfirmBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Recording...'; }

    const { tenantId, amount, month, method, note, source } = _pendingPayment;

    try {
        const res  = await fetch(`${API}/payments`, {
            method: 'POST', headers: authHeaders(),
            body:   JSON.stringify({ tenantId, amount, month, method, note })
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.message || 'Payment failed', 'error');
            return;
        }

        showToast('Payment recorded & receipt emailed ✅', 'success');

        closeModal('modal-pay-confirm');
        if (source === 'modal') closeModal('modal-pay');

        await loadTenants();
        loadArrears();
        loadRecentActivity();
        loadDashboard();

        if (data.paymentId) {
            if (source === 'modal') { showSection('payments'); }
            loadAutoReceipt(data.paymentId);
        }

        if (source === 'inline') loadPaymentSummary();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    } finally {
        _pendingPayment = null;
        if (btn) { btn.disabled = false; btn.textContent = '✅ Confirm & Record'; }
    }
}


// ═══════════════════════════════════════
// CHARTS
// ═══════════════════════════════════════

let _financeChart, _occupancyChart;
let _lastChartData = null;

function renderCharts(data) {
    _lastChartData = data;

    const accent  = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const danger  = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    const warn    = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim();
    const textDim = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim();

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
            plugins: { legend: { labels: { color: textDim, font: { family: 'JetBrains Mono', size: 10 } } } }
        }
    });
}

const _origSetTheme = window.setTheme;
window.setTheme = function(theme) {
    if (typeof _origSetTheme === 'function') _origSetTheme(theme);
    if (_lastChartData) setTimeout(() => renderCharts(_lastChartData), 50);
};


// ═══════════════════════════════════════
// INQUIRIES — Rendering (NEW)
// ═══════════════════════════════════════

// Status pill HTML helper
function _inqStatusPill(status) {
    const map = {
        new:       `<span class="pill" style="background:rgba(59,130,246,0.12);color:#60a5fa;border:1px solid rgba(59,130,246,0.25)">🆕 New</span>`,
        read:      `<span class="pill" style="background:var(--bg3);color:var(--text-muted);border:1px solid var(--border2)">👁 Read</span>`,
        contacted: `<span class="pill pill-green">📞 Contacted</span>`,
        archived:  `<span class="pill" style="background:rgba(100,116,139,0.12);color:var(--text-dim);border:1px solid var(--border)">🗃 Archived</span>`
    };
    return map[status] || `<span class="pill">${status}</span>`;
}

function _inqTimeAgo(date) {
    const s = Math.floor((new Date() - new Date(date)) / 1000);
    if (isNaN(s) || s < 0) return '—';
    if (s < 60)     return 'just now';
    if (s < 3600)   return Math.floor(s / 60)   + 'm ago';
    if (s < 86400)  return Math.floor(s / 3600)  + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function _escHtmlInq(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _formatPhoneInq(phone) {
    if (!phone) return '';
    const c = phone.replace(/\s+/g, '');
    if (c.startsWith('0') && c.length === 10) return '254' + c.slice(1);
    if (c.startsWith('+')) return c.slice(1);
    return c;
}

function renderInquiriesTable(inquiries) {
    const tbody = document.getElementById('inquiriesTable');
    if (!tbody) return;

    if (!inquiries.length) {
        const filterVal = document.getElementById('inquiryStatusFilter')?.value;
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><span class="icon">📩</span>${filterVal ? 'No inquiries match this filter' : 'No inquiries yet — they will appear here when prospective tenants contact you'}</div></td></tr>`;
        return;
    }

    tbody.innerHTML = inquiries.map(inq => {
        const msgPreview = (inq.message || '').slice(0, 55) + (inq.message?.length > 55 ? '…' : '');
        const propName   = inq.property?.name || '—';
        const ago        = _inqTimeAgo(inq.createdAt);
        // Encode inquiry as safe JSON for the onclick
        const inqSafe    = encodeURIComponent(JSON.stringify(inq));

        return `<tr style="${inq.status === 'new' ? 'background:rgba(59,130,246,0.035)' : ''}">
            <td><strong style="color:var(--text)">${_escHtmlInq(inq.name)}</strong></td>
            <td class="td-mono">
                <a href="tel:${_escHtmlInq(inq.phone)}" style="color:var(--accent);text-decoration:none">${_escHtmlInq(inq.phone)}</a>
            </td>
            <td style="font-size:0.75rem;color:var(--text-muted)">${_escHtmlInq(propName)}</td>
            <td style="font-size:0.75rem;color:var(--text-dim);max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escHtmlInq(msgPreview)}</td>
            <td>${_inqStatusPill(inq.status)}</td>
            <td class="td-mono" style="font-size:0.65rem;color:var(--text-dim)">${ago}</td>
            <td>
              <button class="btn btn-secondary btn-sm"
                onclick='openInquiryDetail(JSON.parse(decodeURIComponent("${inqSafe}")))'>
                View
              </button>
            </td>
        </tr>`;
    }).join('');
}

function openInquiryDetail(inq) {
    document.getElementById('inqDetailId').value         = inq._id;
    document.getElementById('inqDetailName').textContent = inq.name;
    document.getElementById('inqDetailMsg').textContent  = inq.message || '(no message)';
    document.getElementById('inqDetailNotes').value      = inq.notes  || '';

    // Meta info
    const metaEl = document.getElementById('inqDetailMeta');
    const metaLines = [
        `📞 ${_escHtmlInq(inq.phone)}`,
        inq.email  ? `✉️ ${_escHtmlInq(inq.email)}`                                                              : null,
        `🏢 ${_escHtmlInq(inq.property?.name || '—')}${inq.property?.location ? ' · ' + inq.property.location : ''}`,
        `🕐 ${new Date(inq.createdAt).toLocaleString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}`
    ].filter(Boolean);
    metaEl.innerHTML = metaLines.map(s => `<span>${s}</span>`).join('');

    // Status action buttons — show transitions from current status
    const actionsEl = document.getElementById('inqDetailActions');
    const transitions = [
        { val: 'read',      label: '👁 Mark as Read',    cls: 'btn-secondary' },
        { val: 'contacted', label: '📞 Mark Contacted',   cls: 'btn-primary'   },
        { val: 'archived',  label: '🗃 Archive',           cls: 'btn-secondary' },
        { val: 'new',       label: '🔄 Reset to New',      cls: 'btn-secondary' }
    ];
    actionsEl.innerHTML = transitions
        .filter(s => s.val !== inq.status)
        .map(s => `<button class="btn ${s.cls} btn-sm btn-full"
                     onclick="updateInquiryStatus('${inq._id}','${s.val}')">${s.label}</button>`)
        .join('');

    // Contact quick-action buttons
    const waText = encodeURIComponent(`Hi ${inq.name}, thanks for your inquiry about ${inq.property?.name || 'our property'}!`);
    const waHref = `https://wa.me/${_formatPhoneInq(inq.phone)}?text=${waText}`;
    document.getElementById('inqDetailContact').innerHTML = `
        <a href="tel:${_escHtmlInq(inq.phone)}" class="btn btn-secondary btn-sm">📞 Call</a>
        <a href="${waHref}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">💬 WhatsApp</a>
        ${inq.email ? `<a href="mailto:${_escHtmlInq(inq.email)}" class="btn btn-secondary btn-sm">✉️ Email</a>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteInquiry('${inq._id}')">🗑️ Delete</button>`;

    openModal('modal-inquiry-detail');

    // Auto-mark as read if new — silent (no toast)
    if (inq.status === 'new') {
        updateInquiryStatus(inq._id, 'read', true);
    }
}


// ═══════════════════════════════════════
// LISTING CONTROLS — Property Editor (NEW)
// ═══════════════════════════════════════

// pendingIsListed: true  = this was triggered by the toggle turning ON,
//                          so saving should also set isListed:true.
// pendingIsListed: false = triggered by the "Edit Description" button,
//                          isListed state is not changed on save.
function openListingEditor(propertyId, pendingIsListed) {
    const prop = _propertiesCache.find(p => p._id === propertyId);
    if (!prop) { showToast('Property not found — try refreshing', 'error'); return; }

    let modal = document.getElementById('modal-listing-editor');
    if (!modal) {
        modal = document.createElement('div');
        modal.id        = 'modal-listing-editor';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
          <div class="modal" style="max-width:520px">
            <div class="modal-header">
              <div class="modal-title">✏️ Edit Public Listing</div>
              <button class="modal-close" onclick="closeModal('modal-listing-editor')">✕</button>
            </div>

            <!-- Which property -->
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--accent);background:var(--accent-dim);border:1px solid rgba(110,231,183,0.2);border-radius:7px;padding:0.5rem 0.85rem;margin-bottom:0.75rem"
                 id="listingEditorPropName"></div>

            <!-- Guidance note shown when triggered by toggle -->
            <div id="listingEditorGuide" style="display:none;font-size:0.78rem;color:var(--text-muted);background:rgba(59,130,246,0.07);border:1px solid rgba(59,130,246,0.2);border-radius:7px;padding:0.65rem 0.85rem;margin-bottom:0.85rem;line-height:1.6">
              📝 Before your property goes live, add a description and up to 5 photos so prospective tenants know what to expect.
            </div>

            <!-- Description -->
            <label style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);display:block;margin-bottom:0.4rem">
              Public Description <span style="color:var(--danger)">*</span>
            </label>
            <textarea id="listingEditorDesc" style="min-height:110px;resize:vertical;margin-bottom:0.4rem"
              placeholder="Describe this property — location highlights, amenities, nearby facilities, security, water availability…"></textarea>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--text-dim);margin-bottom:1.25rem;line-height:1.5">
              Appears on your public listing card. Keep it welcoming and informative.
            </div>

            <!-- Photos -->
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">
              <label style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
                Photos <span id="listingEditorPhotoCount" style="color:var(--accent)"></span>
              </label>
              <span style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;color:var(--text-dim)">Max 5 · JPG / PNG · 5 MB each</span>
            </div>

            <!-- Existing photos grid -->
            <div id="listingEditorPhotos"
                 style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:0.5rem;margin-bottom:0.75rem;min-height:0">
            </div>

            <!-- Upload button — hidden when at limit -->
            <div id="listingEditorUploadWrap" style="margin-bottom:1.25rem">
              <label id="listingEditorUploadLabel"
                     style="display:flex;align-items:center;justify-content:center;gap:0.5rem;
                            border:1px dashed var(--border2);border-radius:8px;padding:0.75rem;
                            cursor:pointer;font-size:0.78rem;color:var(--text-muted);
                            transition:border-color 0.15s,color 0.15s;user-select:none"
                     onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
                     onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text-muted)'">
                <span style="font-size:1.1rem">📷</span>
                <span id="listingEditorUploadText">Add Photo</span>
                <input type="file" id="listingEditorFileInput" accept="image/*"
                       style="display:none" onchange="handlePhotoUpload(event)">
              </label>
              <div id="listingEditorUploadProgress"
                   style="display:none;font-family:'JetBrains Mono',monospace;font-size:0.65rem;
                          color:var(--text-dim);text-align:center;margin-top:0.4rem">
                ⏳ Uploading…
              </div>
            </div>

            <input type="hidden" id="listingEditorPropertyId">
            <input type="hidden" id="listingEditorPendingListed">

            <button class="btn btn-primary btn-full" id="listingEditorSaveBtn"
                    onclick="saveListingDescription()">💾 Save Description</button>
          </div>`;
        modal.addEventListener('click', e => { if (e.target === modal) closeModal('modal-listing-editor'); });
        document.body.appendChild(modal);
    }

    // Populate from cache — no HTML escaping issues
    document.getElementById('listingEditorPropName').textContent   = `🏢 ${prop.name}${prop.location ? '  ·  📍 ' + prop.location : ''}`;
    document.getElementById('listingEditorDesc').value             = prop.description || '';
    document.getElementById('listingEditorPropertyId').value       = propertyId;
    document.getElementById('listingEditorPendingListed').value    = pendingIsListed === true ? 'true' : '';

    // Guide note + save button label
    const guide   = document.getElementById('listingEditorGuide');
    const saveBtn = document.getElementById('listingEditorSaveBtn');
    if (pendingIsListed === true) {
        guide.style.display = 'block';
        saveBtn.textContent = '💾 Save & Make Visible';
    } else {
        guide.style.display = 'none';
        saveBtn.textContent = '💾 Save Description';
    }

    // Render existing photos
    _renderListingEditorPhotos(prop.photos || [], propertyId);

    modal.classList.add('open');
}





// Renders the photo grid inside the listing editor modal.
// Called on open and after every upload / delete so the UI stays in sync.
function _renderListingEditorPhotos(photos, propertyId) {
    const grid      = document.getElementById('listingEditorPhotos');
    const countEl   = document.getElementById('listingEditorPhotoCount');
    const uploadWrap= document.getElementById('listingEditorUploadWrap');
    const uploadText= document.getElementById('listingEditorUploadText');
    if (!grid) return;

    const count   = photos.length;
    const atLimit = count >= 5;

    // Update count label
    if (countEl) countEl.textContent = `(${count} / 5)`;

    // Hide upload button when at limit
    if (uploadWrap) uploadWrap.style.display = atLimit ? 'none' : 'block';
    if (uploadText) uploadText.textContent   = count === 0 ? 'Add First Photo' : 'Add Another Photo';

    if (!count) {
        grid.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:1rem 0;
                        font-size:0.75rem;color:var(--text-dim);
                        font-family:'JetBrains Mono',monospace">
              No photos yet — add up to 5 to attract more inquiries
            </div>`;
        return;
    }

    grid.innerHTML = photos.map((url, i) => `
        <div style="position:relative;aspect-ratio:4/3;border-radius:7px;overflow:hidden;
                    border:1px solid var(--border2);background:var(--bg3)">
            <img src="${url}" alt="Photo ${i + 1}"
                 style="width:100%;height:100%;object-fit:cover;display:block"
                 loading="lazy">
            <!-- Delete button -->
            <button onclick="handlePhotoDelete('${propertyId}', '${url}')"
                    title="Remove photo"
                    style="position:absolute;top:4px;right:4px;
                           background:rgba(0,0,0,0.65);border:none;border-radius:50%;
                           width:22px;height:22px;cursor:pointer;
                           display:flex;align-items:center;justify-content:center;
                           font-size:0.65rem;color:#fff;line-height:1;
                           transition:background 0.15s"
                    onmouseover="this.style.background='rgba(248,113,113,0.85)'"
                    onmouseout="this.style.background='rgba(0,0,0,0.65)'">✕</button>
            <!-- Position badge -->
            <span style="position:absolute;bottom:4px;left:4px;
                         font-family:'JetBrains Mono',monospace;font-size:0.5rem;
                         background:rgba(0,0,0,0.55);color:#fff;
                         padding:1px 5px;border-radius:3px">
              ${i === 0 ? 'Cover' : `#${i + 1}`}
            </span>
        </div>`).join('');
}



// Called when landlord clicks the listing toggle on a property card.
// If turning ON and no description exists → open editor first (description required).
// If turning OFF, or already has a description → act immediately.
function handleListingToggle(propertyId, turningOn) {
    if (!turningOn) {
        // Turning off — no editor needed, just toggle
        togglePropertyListing(propertyId, false);
        return;
    }

    const prop = _propertiesCache.find(p => p._id === propertyId);
    if (!prop) { togglePropertyListing(propertyId, true); return; }

    if (!prop.description || !prop.description.trim()) {
        // No description yet — open editor; saving will also set isListed:true
        openListingEditor(propertyId, true);
    } else {
        // Already has description — toggle straight away
        togglePropertyListing(propertyId, true);
    }
}