// ═══════════════════════════════════════════════════════
//  dashboard.js — Landlord UI / DOM Rendering Layer
//  No fetch() calls here — those are in script.js.
// ═══════════════════════════════════════════════════════


// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════

const SECTION_TITLES = {
    applications: 'House Applications',
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
    activity:      'Activity Log',
    inquiries:     'Rental Inquiries',
    maintenance:   'Repair Requests',
    caretakers:    'Caretakers',
    invite: 'Invite Tenants',
};
let _arrearsMode = 'current';

function switchArrearsMode(mode) {
    _arrearsMode = mode;
    ['current', 'month', 'semester'].forEach(m => {
        document.getElementById(`arrTab-${m}`).classList.toggle('active', m === mode);
        document.getElementById(`arrPanel-${m}`).style.display = m === mode ? 'block' : 'none';
    });
    if (mode === 'current')  loadArrears();
    if (mode === 'semester') _populateArrSemesterPropertySelect();
}

function _populateArrSemesterPropertySelect() {
    const sel = document.getElementById('arrSemesterProperty');
    if (!sel) return;
    const activeId = getPropertyId();
    sel.innerHTML = _propertiesCache.map(p =>
        `<option value="${p._id}" ${p._id === activeId ? 'selected' : ''}>${p.name}</option>`
    ).join('');
    loadSemesterPeriodOptions();
}

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

    // Keep the grouped sidebar in step (aria-current, group highlight, open the right group)
    // and swap the top-bar typewriter to describe the page that is now showing.
    if (window.NavAccordion) window.NavAccordion.syncToSection(name);
    if (typeof window.setSectionTyper === 'function') window.setSectionTyper(name);

    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('show');
    document.body.style.overflow = '';

    // Lazy-load section data
    if (name === 'dashboard')     { loadDashboard(); loadRecentActivity(); }
    if (name === 'payments')      { setPaymentType('rent'); }
    if (name === 'assign')        { loadTenants(); loadHouses(); }
    if (name === 'tenants')       { loadTenants(); loadMovedOutTenants(); loadHouses(); }
    if (name === 'arrears')       { switchArrearsMode(_arrearsMode || 'current'); }
    if (name === 'messages')      { initMessagingSection(); }
    if (name === 'announcements') { loadAnnouncements(); }
    if (name === 'rules')         { loadRules(); }
    if (name === 'houses')        { loadHouses(); }
    if (name === 'properties')    { loadProperties(); }
    if (name === 'inquiries')     { loadInquiries(); }
    if (name === 'activity')      { loadActivity(); }
    if (name === 'expenses')      { loadExpenses(); }
    if (name === 'maintenance')   { loadMaintenanceRequests(); }
    if (name === 'caretakers')    { loadCaretakers(); }
    if (name === 'invite') { initInvitePage(); }
    if (window.BuildingBrowser)   { window.BuildingBrowser.onSectionShown(name); }
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}


// ═══════════════════════════════════════
// THEME
// ═══════════════════════════════════════

function setTheme(theme) {
    // Only two themes exist now: Black ("dark") and White ("light"). Old saved values
    // (blue / orange) fall back to Black.
    if (theme !== 'dark' && theme !== 'light') theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    const _mt = document.querySelector('meta[name="theme-color"]');
    if (_mt) _mt.setAttribute('content', theme === 'light' ? '#ffffff' : '#08090b');
    localStorage.setItem('admin-theme', theme);
    document.querySelectorAll('.theme-dot').forEach(d => {
        d.classList.toggle('active', d.dataset.theme === theme);
    });
}

// ═══════════════════════════════════════
// MONTH SELECT HELPERS
// ═══════════════════════════════════════
//
// Both expense recording and the dashboard filter pull from this same
// generator, so the `month` string saved on an expense always exactly
// matches what the dashboard can query for — no more silent misses from
// free-typed strings that don't quite match ("May 2026" vs "may 2026").

function _generateRecentMonths(count = 12, aheadCount = 0) {
    const months = [];
    const now = new Date();
    for (let i = aheadCount; i > 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        months.push(d.toLocaleString('default', { month: 'long', year: 'numeric' }));
    }
    for (let i = 0; i < count; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(d.toLocaleString('default', { month: 'long', year: 'numeric' }));
    }
    return months;
}

function _populateMonthSelect(selectId, { count = 12, ahead = 0, selected } = {}) {
    const el = document.getElementById(selectId);
    if (!el) return;
    const months  = _generateRecentMonths(count, ahead);
    const current = months[ahead]; // ahead months are listed first, so this index is "this month"
    const value   = selected && months.includes(selected) ? selected : current;

    el.innerHTML = months.map(m =>
        `<option value="${m}" ${m === value ? 'selected' : ''}>${m}</option>`
    ).join('');
}


// ═══════════════════════════════════════
// TOAST
// ═══════════════════════════════════════

let _toastTimer;

// AFTER:
function showToast(msg, type = '') {
    // Overlay already covers this — a flood of "Failed to load X" toasts
    // underneath it during platform maintenance adds nothing.
    if (window.__PLATFORM_MAINTENANCE_ACTIVE__) return;
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
    const locEl    = document.getElementById('activePropertyLoc');
    const arrowEl  = document.getElementById('switcherArrow');
    const activeId = localStorage.getItem('activePropertyId');

    const active = properties.find(p => p._id === activeId) || properties[0];
    if (nameEl && active) nameEl.textContent = active.name;
    if (locEl) locEl.innerHTML = active && active.location ? `${ICON('pin',12)} ${active.location}` : '';

    if (arrowEl) arrowEl.style.display = properties.length > 1 ? 'inline' : 'none';

    if (!menu) return;

    menu.innerHTML = properties.map(p => `
        <div class="property-menu-item ${p._id === activeId ? 'active' : ''}"
             onclick="switchProperty('${p._id}', '${p.name.replace(/'/g, "\\'")}')">
            <span class="property-menu-dot ${p._id === activeId ? 'active' : ''}"></span>
            <div style="flex:1;min-width:0">
                <div class="property-menu-name">${p.name}</div>
                ${p.location ? `<div class="property-menu-loc">${ICON('pin',11)} ${p.location}</div>` : ''}
            </div>
            ${p.paymentConfigured
                ? `<span style="font-size:0.6rem;color:var(--accent);flex-shrink:0;display:flex;align-items:center;gap:2px">M-Pesa ${ICON('check',10)}</span>`
                : '<span style="font-size:0.6rem;color:var(--text-dim);flex-shrink:0">No M-Pesa</span>'}
            ${p._id === activeId ? `<span style="color:var(--accent);margin-left:0.5rem;flex-shrink:0;display:flex">${ICON('check',12)}</span>` : ''}
        </div>`
    ).join('') + (IS_CARETAKER ? '' : `
        <div class="property-menu-item" style="border-top:1px solid var(--border);margin-top:3px;padding-top:0.6rem"
             onclick="closePropertyMenu(); openModal('modal-add-property')">
            <span style="color:var(--accent);display:flex">${ICON('plus',14)}</span>
            <div class="property-menu-name" style="color:var(--accent)">Add Property</div>
        </div>`);
}

function setMpesaAcctType(type) {
    document.getElementById('setupAcctType').value = type;
    document.getElementById('acctTypePaybillBtn').className =
        `btn btn-sm ${type === 'paybill' ? 'btn-primary' : 'btn-secondary'}`;
    document.getElementById('acctTypeTillBtn').className =
        `btn btn-sm ${type === 'till' ? 'btn-primary' : 'btn-secondary'}`;

    const label = document.getElementById('setupPaybillLabel');
    const hint  = document.getElementById('setupPaybillHint');
    const input = document.getElementById('setupPaybill');
    if (type === 'till') {
        label.textContent = 'Till Number';
        input.placeholder = 'e.g. 5123456';
        hint.textContent  = 'Your Safaricom Till Number (Buy Goods).';
    } else {
        label.textContent = 'Paybill Number';
        input.placeholder = 'e.g. 174379';
        hint.textContent  = 'Your Safaricom Business Shortcode / Paybill number.';
    }

    // A type has now been chosen — unlock the credential fields
    ['setupPaybill', 'setupConsumerKey', 'setupConsumerSecret', 'setupPasskey'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
    });
}

function resetMpesaAcctTypeSelection() {
    document.getElementById('setupAcctType').value = '';
    document.getElementById('acctTypePaybillBtn').className = 'btn btn-secondary btn-sm';
    document.getElementById('acctTypeTillBtn').className    = 'btn btn-secondary btn-sm';
    document.getElementById('setupPaybillLabel').textContent = 'Paybill Number';
    document.getElementById('setupPaybill').placeholder      = 'e.g. 174379';
    document.getElementById('setupPaybillHint').textContent  = 'Your Safaricom Business Shortcode / Paybill number.';

    ['setupPaybill', 'setupConsumerKey', 'setupConsumerSecret', 'setupPasskey'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.disabled = true; el.value = ''; }
    });
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

function renderPropertiesGrid(properties) {
    const grid = document.getElementById('propertiesGrid');
    if (!grid) return;

    const activeId = localStorage.getItem('activePropertyId');

    if (!properties.length) {
        grid.innerHTML = `<div class="empty-state"><span class="icon">${ICON('properties',26)}</span>No properties yet. Add your first property.</div>`;
        return;
    }

    grid.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem">` +
    properties.map(p => `
                <div style="background:var(--panel);border:1px solid ${p.isSuspended ? 'var(--danger)' : (p._id === activeId ? 'var(--accent)' : 'var(--border)')};border-radius:10px;overflow:hidden;transition:border-color 0.2s">

          <div style="padding:1rem 1.25rem;cursor:pointer;border-bottom:1px solid var(--border)"
               onclick="switchProperty('${p._id}', '${p.name.replace(/'/g, "\\'")}')">
            <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.2rem;color:var(--text);margin-bottom:0.25rem">${p.name}</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim);display:flex;align-items:center;gap:4px">
              ${p.location ? `${ICON('pin',12)} ${p.location}` : '—'}
            </div>
            <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.5rem">
              ${p._id === activeId
                ? '<span class="pill pill-green">● Active</span>'
                : '<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)">Switch →</span>'}
              ${p.paymentConfigured
                ? `<span class="pill pill-green" style="display:inline-flex;align-items:center;gap:3px">M-Pesa ${ICON('check',10)}</span>`
                : '<span class="pill pill-yellow">No M-Pesa</span>'}
              ${p.hasLocation
                ? `<span class="pill pill-green" style="display:inline-flex;align-items:center;gap:3px">${ICON('pin',10)} Pinned</span>`
                : `<span class="pill pill-yellow" style="display:inline-flex;align-items:center;gap:3px">${ICON('pin',10)} Not Pinned</span>`}
              ${p.isSuspended
                ? `<span class="pill pill-red" style="display:inline-flex;align-items:center;gap:3px">${ICON('ban',10)} Suspended</span>`
                : ''}
            </div>
          </div>

          <div style="padding:0.85rem 1.25rem">
            <div style="font-size:0.6rem;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-dim);margin-bottom:0.65rem">Public Listing</div>

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

            ${p.isListed && !p.isApproved ? `
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--warn);background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:6px;padding:0.4rem 0.65rem;margin-bottom:0.65rem;display:flex;align-items:center;gap:5px">
              ${ICON('hourglass',12)} Pending admin approval before going live
            </div>` : ''}

            ${p.isListed && p.isApproved ? `
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--accent);background:var(--accent-dim);border:1px solid rgba(110,231,183,0.2);border-radius:6px;padding:0.4rem 0.65rem;margin-bottom:0.65rem;display:flex;align-items:center;gap:5px">
              ${ICON('check',12)} Live on public listings page
            </div>` : ''}

            <button class="btn btn-secondary btn-sm btn-full"
              style="margin-bottom:0.5rem"
              onclick="openListingEditor('${p._id}')">
              ${ICON('edit',14)} Edit Description &amp; Details
            </button>
            <button class="btn btn-secondary btn-sm btn-full"
              style="margin-bottom:0.5rem"
              onclick="openLocationPicker('${p._id}')">
              ${ICON('pin',14)} ${p.hasLocation ? 'Update Map Location' : 'Set Map Location'}
            </button>
            <button class="btn btn-secondary btn-sm btn-full"
              style="margin-bottom:0.5rem"
              onclick="openPropertySettingsModal('${p._id}')">
              ${ICON('lock',14)} Semester &amp; Deposit Rules
            </button>
            ${p.isListed && p.isApproved ? `
            <a href="listings.html${p.location ? '?location=' + encodeURIComponent(p.location.split(',')[0].trim()) : ''}"
               target="_blank"
               class="btn btn-secondary btn-sm btn-full"
               style="text-decoration:none;display:flex;align-items:center;justify-content:center;gap:5px">
              ${ICON('eye',14)} Preview on Listings Page
            </a>` : ''}
          </div>
        </div>`
    ).join('') +
    `<div style="background:var(--panel);border:1px dashed var(--border2);border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;min-height:160px"
          onclick="openModal('modal-add-property')">
        <div style="text-align:center;color:var(--text-dim)">
          <div style="display:flex;justify-content:center;margin-bottom:0.3rem">${ICON('plus',22)}</div>
          <div style="font-size:0.75rem">Add Property</div>
        </div>
     </div>
    </div>`;
}

// SECTION_TITLES: add
//   invite: 'Invite Tenants',

// showSection(): add with the lazy-loaders
//   if (name === 'invite') { initInvitePage(); }

function renderInvitation(propertyName, inv) {
    const body = document.getElementById('inviteBody');
    if (!body) return;

    if (!inv) {
        body.innerHTML = `
            <div class="empty-state" style="padding:1.25rem 0"><span class="icon">${ICON('addTenant',26)}</span>No active link for ${_escHtmlRef(propertyName)} yet</div>
            <button class="btn btn-primary btn-full" onclick="generateInvitation()">${ICON('plus',14)} Generate Invitation Link</button>`;
        return;
    }

    const url = _inviteUrl(inv.code);
    const created = new Date(inv.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const expiry  = inv.expiresAt ? `Expires ${new Date(inv.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'No expiry';

    body.innerHTML = `
        <div style="display:flex;gap:0.5rem;margin:0.75rem 0 0.5rem">
            <input type="text" id="inviteLinkInput" readonly value="${_escHtmlRef(url)}" style="margin:0;font-family:'JetBrains Mono',monospace;font-size:0.7rem">
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim);margin-bottom:0.85rem">
            Created ${created} · ${expiry} · ${inv.usedCount} tenant${inv.usedCount === 1 ? '' : 's'} registered
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.5rem;margin-bottom:0.5rem">
            <button class="btn btn-secondary btn-sm" onclick="copyInviteLink()">${ICON('lock',14)} Copy Link</button>
            <button class="btn btn-primary btn-sm" onclick="shareInviteWhatsApp()">${ICON('messages',14)} Share on WhatsApp</button>
            <button class="btn btn-secondary btn-sm" onclick="showInviteQr()">${ICON('eye',14)} Show QR Code</button>
            <button class="btn btn-secondary btn-sm" onclick="confirmRegenerateInvitation()">${ICON('loop',14)} New Link</button>
        </div>
        <button class="btn btn-danger btn-sm btn-full" onclick="confirmRevokeInvitation()">${ICON('trash',14)} Revoke Link</button>
        <div id="inviteQrWrap" style="display:none;text-align:center;margin-top:1rem">
            <div id="inviteQr" style="display:inline-block;background:#fff;padding:12px;border-radius:10px"></div>
            <div style="margin-top:0.6rem"><button class="btn btn-secondary btn-sm" onclick="downloadInviteQr()">${ICON('file',14)} Download QR</button></div>
        </div>`;
}

// ═══════════════════════════════════════
// TENANT LIST RENDERING
// ═══════════════════════════════════════

function renderTenantList(tenants) {
    const list = document.getElementById('tenantList');

        if (!tenants.length) {
        list.innerHTML = `<div class="empty-state"><span class="icon">${ICON('tenants',26)}</span>No tenants found</div>`;
        return;
    }

    list.innerHTML = tenants.map(t => {
        const initials = t.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        const house    = t.house ? (t.house.name || t.house) : 'No house';
        const checked  = _selectedTenantIds.has(t._id) ? 'checked' : '';

        let badge = '';
        if (!t.house) {
            badge = `<span class="partial-badge">Not assigned</span>`;
        } else if (t.paymentStatus === 'paid') {
            badge = `<span class="paid-badge">Paid</span>`;
        } else if (t.paymentStatus === 'partial') {
            badge = `<span class="partial-badge">Partial</span>`;
        } else if (t.paymentStatus === 'unpaid' && t.house) {
            badge = `<span class="arrears-badge">Unpaid</span>`;
        }

        let depositPill = '';
            if (t.depositStatus === 'paid') {
                depositPill = `<span class="pill pill-green">${ICON('cash',12)} Deposit paid: Ksh ${Number(t.depositAmount).toLocaleString()}</span>`;
            } else if (t.depositStatus === 'partial') {
                depositPill = `<span class="pill pill-yellow">${ICON('cash',12)} Deposit partial: Ksh ${Number(t.depositAmount).toLocaleString()}</span>`;
            } else if (t.depositStatus === 'refunded') {
                depositPill = `<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)">${ICON('cash',12)} Deposit refunded</span>`;
            }

        const tenantData = encodeURIComponent(JSON.stringify(t));

        return `
            <div class="tenant-row" id="row-${t._id}"
                 onclick="handleTenantClick(event, JSON.parse(decodeURIComponent('${tenantData}')))">
                <input type="checkbox" class="tenant-select-box" ${checked}
                       onclick="event.stopPropagation()"
                       onchange="toggleTenantSelect('${t._id}', this.checked)"
                       style="width:auto;margin:0;flex-shrink:0">
                <div class="tenant-avatar">${initials}</div>
                <div class="tenant-info">
                    <div class="tenant-name">${t.name}</div>
                    <div class="tenant-meta">${t.phone || '—'} · ${house}</div>
                </div>
                              ${badge}${depositPill}
            </div>`;
    }).join('');

    _updateBulkRemindUI();
}

function renderMovedOutList(tenants) {
    const list = document.getElementById('movedOutList');
    if (!list) return;

       if (!tenants.length) {
        list.innerHTML = `<div class="empty-state"><span class="icon">${ICON('door',26)}</span>No moved-out tenants</div>`;
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

// Same behaviour as the house-card menu: appended to <body> with position:fixed so it can never be
// clipped by the list, flips above the row when there is no room below, has a name header, and closes
// on outside click, scroll, resize or Escape.
function _openTenantPortalMenu(event, row, tenant, itemsHtml) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'ctx-menu house-ctx-menu tenant-ctx-menu';
    menu.dataset.tenantId = tenant._id;
    menu.setAttribute('role', 'menu');

    const safeName = String(tenant.name || 'Tenant').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    menu.innerHTML =
        `<div class="ctx-item" style="font-size:0.7rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace;cursor:default">${safeName}</div><div class="ctx-divider"></div>` +
        itemsHtml;

    menu.style.cssText = 'position: fixed; top: 0; left: 0; visibility: hidden; z-index: 9999; width: max-content; min-width: 180px; max-width: 260px;';
    document.body.appendChild(menu);

    const rect = row ? row.getBoundingClientRect() : { top: 80, bottom: 100, left: 40 };
    const mw = menu.offsetWidth || 210, mh = menu.offsetHeight || 220;
    let left = (event && typeof event.clientX === 'number' && event.clientX > 0) ? event.clientX - 24 : rect.left;
    let top  = rect.bottom + 4;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (left < 8) left = 8;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 4;
    if (top < 8) top = Math.max(8, window.innerHeight - mh - 8);
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    menu.style.visibility = 'visible';

    const bornAt = Date.now();
    function cleanup() {
        menu.remove();
        document.removeEventListener('click', dismiss, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', cleanup);
    }
    function dismiss(e) { if (!menu.contains(e.target)) cleanup(); }
    function onKey(e) { if (e.key === 'Escape') cleanup(); }
    // the profile panel loads right after the click and may nudge layout — ignore scrolls for a moment
    function onScroll() { if (Date.now() - bornAt > 300) cleanup(); }
    setTimeout(() => {
        document.addEventListener('click', dismiss, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', cleanup);
    }, 0);
}

function handleTenantClick(event, tenant) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    document.querySelectorAll('.tenant-row').forEach(r => r.classList.remove('selected'));

    const row = document.getElementById(`row-${tenant._id}`);
    if (row) row.classList.add('selected');

    loadTenantProfile(tenant._id);

    const canDelete = !isCaretaker();
    const itemsHtml = `
        <div class="ctx-item" onclick="_ctxPayRent('${tenant._id}')">${ICON('payments',14)} Pay Rent</div>
        <div class="ctx-item" onclick="_ctxDeposit('${tenant._id}')">${ICON('cash',14)} Record Deposit</div>
        <div class="ctx-divider"></div>
        ${!tenant.house
            ? `<div class="ctx-item" onclick="_ctxAssignFromTenant('${tenant._id}')">${ICON('key',14)} Assign House</div>`
            : `<div class="ctx-item" onclick="_ctxTransferFromTenant('${tenant._id}')">${ICON('loop',14)} Transfer House</div>
        <div class="ctx-item" style="color:var(--warn)" onclick="_ctxMoveOutFromTenant('${tenant._id}')">${ICON('door',14)} Move Out</div>`}
        <div class="ctx-divider"></div>
        <div class="ctx-item" onclick="_ctxResetPassword('${tenant._id}')">${ICON('key',14)} Reset Password</div>
        ${canDelete ? `<div class="ctx-divider"></div><div class="ctx-item danger" onclick="_ctxDelete('${tenant._id}')">${ICON('trash',14)} Delete Permanently</div>` : ''}`;

    _openTenantPortalMenu(event, row, tenant, itemsHtml);
}

function handleMovedOutTenantClick(event, tenant) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    document.querySelectorAll('.tenant-row').forEach(r => r.classList.remove('selected'));

    const row = document.getElementById(`row-mo-${tenant._id}`);
    if (row) row.classList.add('selected');

    loadTenantProfile(tenant._id);

    const canDelete = !isCaretaker();
    const itemsHtml = `
        <div class="ctx-item" style="color:var(--accent)" onclick="_ctxReactivate('${tenant._id}')">${ICON('loop',14)} Reactivate Tenant</div>
        ${canDelete ? `
        <div class="ctx-divider"></div>
        <div class="ctx-item danger" onclick="_ctxDelete('${tenant._id}')">${ICON('trash',14)} Delete Permanently</div>` : ''}`;

    _openTenantPortalMenu(event, row, tenant, itemsHtml);
}

// Nav shortcut: opens Semester & Deposit Rules for the property currently selected in the top bar.
async function openActivePropertySettings() {
    if (typeof isCaretaker === 'function' && isCaretaker()) return;
    const id = getPropertyId();
    if (!id) { showToast('Select a property first', 'warn'); return; }
    if (!_propertiesCache.some(p => p._id === id)) {
        try { await loadProperties(); } catch (e) { /* handled below */ }
    }
    openPropertySettingsModal(id);
}


function _ctxPayRent(id) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    if (!_checkCaretakerPermission('canRecordPayments', 'record payments')) return;
    const tenant = _allTenants.find(t => t._id === id);
    if (tenant) openPayModal(tenant);
}

function _ctxDeposit(id) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    if (!_checkCaretakerPermission('canRecordPayments', 'record deposits')) return;
    const tenant = _allTenants.find(t => t._id === id);
    if (tenant) openDepositModal(tenant);
}

function openDepositModal(tenant) {
    document.getElementById('payModalTenantId').value         = tenant._id;
    document.getElementById('payModalTenantName').textContent = `Paying for: ${tenant.name}`;
    document.getElementById('payModalNote').value              = '';
    document.getElementById('modalSummaryBox').style.display   = 'none';
    setModalPaymentType('deposit');

    const propertyId = getPropertyId();
    const prop       = _propertiesCache.find(p => p._id === propertyId);
    const required   = Number(prop?.depositPolicy?.depositAmount || 0);
    const amountInput = document.getElementById('payModalAmount');

    if (tenant.depositStatus === 'paid') {
        showToast('Deposit already paid in full for this tenant', 'warn');
    }

    if (required > 0) {
        // Deposit is all-or-nothing — lock the field so it can only ever
        // be recorded at exactly the required amount.
        amountInput.value    = required;
        amountInput.readOnly = true;
        amountInput.title    = `Deposit must be paid in full: Ksh ${required.toLocaleString()}`;
    } else {
        amountInput.value    = '';
        amountInput.readOnly = false;
        showToast('No deposit amount set for this property yet — set it in Semester & Deposit Rules', 'warn');
    }

    openModal('modal-pay');
}

function _ctxResetPassword(id) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const tenant = _allTenants.find(t => t._id === id);
    if (tenant) openResetModal(tenant);
}

function _ctxDelete(id) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    if (isCaretaker()) {
        showToast('Caretakers cannot permanently delete tenants', 'warn');
        return;
    }
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
                    <div class="modal-title">${ICON('loop',18)} Reactivate Tenant</div>
                    <button class="modal-close" onclick="closeModal('modal-reactivate')">${ICON('close',16)}</button>
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
                    <button class="btn btn-primary btn-full"   onclick="submitReactivate()">${ICON('loop',14)} Reactivate</button>
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

    // ── houseSelect no longer exists — the Assign section is now
    //    house-card based (see sec-assign), so there's no dropdown to
    //    fall back to. If nothing's available, just say so plainly. ──
    sel.innerHTML = availableHouses.length
        ? `<option value="">— Select a house —</option>` +
            availableHouses.map(h =>
                `<option value="${h._id}">${h.name} — Ksh ${Number(h.rent).toLocaleString()} / mo</option>`
            ).join('')
        : `<option value="">No available houses — add one first</option>`;

    modal.classList.add('open');
}


function _confirmPlainMoveOut(tenantId, tenantName, houseName) {
    openDangerModal({
        icon:    ICON('door', 44),
        title:   'Move Out Tenant',
        message: `Move out <strong>${tenantName}</strong> from <strong>${houseName}</strong>?<br><br>
                  The house will be marked as <strong>available</strong>. The tenant's login and payment history are preserved — they can be reactivated later.`,
        label:   `Move Out ${tenantName}`,
        type:    'warn',
        onConfirm: async () => { await _submitMoveOut(tenantId, tenantName); }
    });
}

function _openMoveOutRefundModal(tenantId, tenantName, houseName, preview) {
    let modal = document.getElementById('modal-moveout-refund');
    if (!modal) {
        modal = document.createElement('div');
        modal.id        = 'modal-moveout-refund';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal" style="max-width:440px">
                <div class="modal-header">
                    <div class="modal-title">${ICON('door',18)} Mid-Semester Move-Out</div>
                    <button class="modal-close" onclick="closeModal('modal-moveout-refund')">${ICON('close',16)}</button>
                </div>
                <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:0.85rem 1rem;margin-bottom:1.1rem;font-size:0.8rem;color:var(--text-muted);line-height:1.7" id="moveOutRefundSummary"></div>
                <input type="hidden" id="moveOutRefundTenantId">
                <input type="hidden" id="moveOutRefundTenantName">
                <input type="hidden" id="moveOutRefundHouseName">
                <div id="moveOutRefundChoiceWrap" style="display:flex;flex-direction:column;gap:0.6rem;margin-bottom:0.5rem"></div>
                <div id="moveOutRefundAmountWrap" style="display:none;margin-top:0.75rem">
                    <label class="pay-setup-label" style="display:block;margin-bottom:0.35rem">Refund Amount (Ksh)</label>
                    <input type="number" id="moveOutRefundAmount" min="1" style="margin-bottom:0.75rem">
                    <button class="btn btn-primary btn-full" onclick="_confirmMoveOutWithRefund()">${ICON('cash',14)} Issue Refund &amp; Move Out</button>
                </div>
            </div>`;
        modal.addEventListener('click', e => { if (e.target === modal) closeModal('modal-moveout-refund'); });
        document.body.appendChild(modal);
    }

    document.getElementById('moveOutRefundTenantId').value   = tenantId;
    document.getElementById('moveOutRefundTenantName').value = tenantName;
    document.getElementById('moveOutRefundHouseName').value  = houseName;

    const endDateStr = new Date(preview.semesterEndDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    document.getElementById('moveOutRefundSummary').innerHTML = `
        <strong style="color:var(--text)">${tenantName}</strong> is on semester billing for <strong>${preview.periodLabel}</strong>.<br>
        Paid so far: <strong style="color:var(--accent)">Ksh ${Number(preview.totalPaid).toLocaleString()}</strong> of Ksh ${Number(preview.totalDue).toLocaleString()}<br>
        ${preview.daysRemaining} day(s) remain until ${endDateStr}.`;

    const choiceWrap = document.getElementById('moveOutRefundChoiceWrap');
    const amountWrap = document.getElementById('moveOutRefundAmountWrap');
    amountWrap.style.display = 'none';

    const canRefund = !isCaretaker(); // refund route is landlord-only
    choiceWrap.innerHTML = `
        <button class="btn btn-secondary btn-full" onclick="_confirmMoveOutNoRefund()">${ICON('door',14)} Move Out — No Refund</button>
        ${canRefund ? `
        <button class="btn btn-warn btn-full" onclick="_showMoveOutRefundAmountField(${preview.suggestedRefund})">${ICON('cash',14)} Move Out — Issue Prorated Refund</button>`
        : `<div class="field-hint" style="margin:0">Only a landlord can issue a refund — a caretaker can still move this tenant out without one.</div>`}
    `;

    openModal('modal-moveout-refund');
}

function _showMoveOutRefundAmountField(suggestedRefund) {
    const wrap  = document.getElementById('moveOutRefundAmountWrap');
    const input = document.getElementById('moveOutRefundAmount');
    if (input) input.value = suggestedRefund;
    if (wrap)  wrap.style.display = 'block';
}

function _confirmMoveOutNoRefund() {
    const tenantId   = document.getElementById('moveOutRefundTenantId').value;
    const tenantName = document.getElementById('moveOutRefundTenantName').value;
    const houseName  = document.getElementById('moveOutRefundHouseName').value;
    closeModal('modal-moveout-refund');
    _confirmPlainMoveOut(tenantId, tenantName, houseName);
}


async function submitReactivate() {
    if (!_checkCaretakerPermission('canManageTenants', 'reactivate tenants')) return;

    const tenantId = document.getElementById('reactivateTenantId').value;
    const houseId  = document.getElementById('reactivateHouseSelect').value;

    if (!houseId) { showToast('Select a house to assign', 'warn'); return; }

    const btn = document.querySelector('#modal-reactivate .btn-primary');
        if (btn) { btn.disabled = true; btn.innerHTML = `${ICON('hourglass',14)} Reactivating...`; }
    
    

    const success = await reactivateTenant(tenantId, houseId);
    if (success) {
        closeModal('modal-reactivate');
        switchTenantTab('active');
    }

   if (btn) { btn.disabled = false; btn.innerHTML = `${ICON('loop',14)} Reactivate`; }
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
                    <span style="font-size:1.1rem">${ICON('door',18)}</span>
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
                            onclick="_ctxReactivate('${t._id}')">${ICON('loop',14)} Reactivate this tenant</button>
                                        <button class="btn btn-sm btn-danger" style="font-size:0.72rem"
                            onclick="_ctxDelete('${t._id}')">${ICON('trash',14)} Delete Permanently</button>
                </div>
            </div>`;
    }
  
            

    const house = t.house ? (t.house.name || t.house) : null;
        const housePill = house && t.status !== 'moved_out'
        ? `<span class="pill pill-green">${ICON('houses',12)} ${house}</span>`
        : '';

    const houseObj = (t.status !== 'moved_out' && typeof t.house === 'object') ? t.house : null;

    let depositPill = '';
        if (t.depositStatus === 'paid') {
            depositPill = `<span class="pill pill-green">${ICON('cash',12)} Deposit paid: Ksh ${Number(t.depositAmount).toLocaleString()}</span>`;
        } else if (t.depositStatus === 'partial') {
            depositPill = `<span class="pill pill-yellow">${ICON('cash',12)} Deposit partial: Ksh ${Number(t.depositAmount).toLocaleString()}</span>`;
        } else if (t.depositStatus === 'refunded') {
            depositPill = `<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)">${ICON('cash',12)} Deposit refunded</span>`;
        }

    const billingPill = houseObj && houseObj.billingCycle === 'semester'
        ? `<span class="pill pill-yellow">${ICON('clock',12)} Semester billing</span>`
        : '';

    // ── Status. The server decides: a tenant with no house is "Not assigned", never "All paid" ──
    _profileStayCache[t._id] = data.stay || null;
    let statusPill = '';
    if (t.status !== 'moved_out') {
        const pay = data.status && data.status.payment;
        if (pay === 'not_assigned') {
            statusPill = `<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)">${ICON('door',12)} Not assigned</span>`;
        } else if (pay === 'paused') {
            statusPill = `<span class="pill pill-yellow">${ICON('clock',12)} Rent paused</span>`;
        } else if (pay === 'unknown') {
            statusPill = `<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)">${ICON('info',12)} Billing not set up</span>`;
        } else if (pay === 'unpaid') {
            statusPill = `<span class="pill pill-red">${ICON('warning',12)} Rent unpaid</span>`;
        } else if (pay === 'all_paid' || (!data.status && !(data.arrears > 0))) {
            statusPill = `<span class="pill pill-green">${ICON('check',12)} All paid</span>`;
        } else {
            statusPill = `<span class="pill pill-red">${ICON('warning',12)} Arrears: Ksh ${Number(data.arrears).toLocaleString()}</span>`;
        }
    }

    const isAssigned = t.status !== 'moved_out' && !!t.house;

    // Payment history: what was paid, for which period, and what was still owed right after that payment.
    const payRows = payments.length
        ? payments
            .slice()
            .sort((a, b) => new Date(b.datePaid) - new Date(a.datePaid))
            .map(p => `
                <tr>
                    <td class="td-mono">${p.datePaid ? new Date(p.datePaid).toLocaleDateString() : '—'}</td>
                    <td>${_escHtmlRef(p.periodLabel || p.month)}</td>
                    <td class="td-mono">Ksh ${Number(p.amount).toLocaleString()}</td>
                    <td class="td-mono">Ksh ${Number(p.balance || 0).toLocaleString()}</td>
                </tr>`).join('')
        : `<tr><td colspan="4" style="text-align:center;color:var(--text-dim)">No payments yet</td></tr>`;

    document.getElementById('profileOutput').innerHTML = `
        ${movedOutBanner}
        <div style="margin-bottom:1rem">
            <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.4rem;color:var(--text);margin-bottom:0.25rem">${t.name}</div>
            <div style="font-size:0.75rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace">${t.email} · ${t.phone || '—'}</div>
            <div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap">
                ${housePill}${billingPill}${depositPill}
                ${statusPill}
            </div>
        </div>
        ${_periodCardHtml(t, data)}
        <div id="tenantBillingPanel"></div>
        <div id="tenantStayPanel"></div>
        <div style="font-size:0.62rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim);margin-bottom:0.5rem">Payment History</div>
        <div class="table-wrap">
            <table>
                <thead><tr><th>Date</th><th>Period</th><th>Amount</th><th>Balance after</th></tr></thead>
                <tbody>${payRows}</tbody>
            </table>
        </div>
        <div style="margin-top:0.75rem;font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--text-dim)">
            Lifetime total: <strong style="color:var(--accent)">Ksh ${Number(data.totalPaid || 0).toLocaleString()}</strong>
        </div>`;

    document.getElementById('profileOutput').dataset.tenantId = t._id;
    if (isAssigned) {
        loadTenantStay(t._id, data.arrears);                                        // holiday (all tenants) + extension (semester)
        if (houseObj && houseObj.billingCycle === 'semester') loadTenantBilling(t._id);   // computed Periods table
    }
}

// ═══════════════════════════════════════
// CURRENT PERIOD CARD — one place for rent, dates, progress and the actions that belong to the period
// ═══════════════════════════════════════
let _profilePeriodCache = {};
let _profileGapCache    = {};      // tenantId → gap info (+ names) used by the holding-fee dialog
let _gapDecisions       = { count: 0, items: [] };

function _stayBarHtml(stay) {
    if (!stay) return '';
    const d = stay.daysRemaining;
    const remaining = d > 1 ? `${d} days remaining` : d === 1 ? '1 day remaining' : d === 0 ? 'Due today' : `${-d} day${d === -1 ? '' : 's'} overdue`;
    const tone = stay.level === 'urgent' ? 'var(--danger)' : stay.level === 'warn' ? 'var(--warn)' : 'var(--text-muted)';
    return `
        <div class="payment-progress" style="margin-top:0" role="progressbar" aria-label="Stay progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${stay.percent}">
            <div class="payment-progress-bar stay-${stay.level}" style="width:${stay.percent}%"></div>
        </div>
        <div style="display:flex;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;margin:0.4rem 0 0.85rem;font-family:'JetBrains Mono',monospace;font-size:0.68rem">
            <span style="color:var(--text-dim)">${_fmtISO(stay.startISO)} → ${_fmtISO(stay.endISO)}</span>
            <span style="color:${tone};font-weight:600">${remaining}</span>
        </div>`;
}

function _gapChoiceButtons(tenantId, defaultFee) {
    return `<div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="openGapDecisionModal('${tenantId}','default')">Use default fee (${_ksh(defaultFee)} / month)</button>
        <button class="btn btn-secondary btn-sm" onclick="openGapDecisionModal('${tenantId}','custom')">Custom fee per month</button>
        <button class="btn btn-secondary btn-sm" onclick="openGapDecisionModal('${tenantId}','none')">No fee</button>
        <button class="btn btn-warn btn-sm" onclick="openGapDecisionModal('${tenantId}','moveout')">${ICON('door', 14)} Tenant is moving out</button>
    </div>`;
}

function _gapPromptHtml(tenantId, gap, canManage) {
    if (!gap) return '';
    const when = `${_escHtmlRef(gap.prevLabel)} ended · ${_escHtmlRef(gap.nextLabel)} starts ${_fmtISO(gap.nextStartISO)} (${gap.days}-day break)`;
    if (!gap.decisionNeeded) {
        return `<div class="field-hint" style="background:var(--accent-dim);border:1px solid rgba(110,231,183,0.2);border-radius:7px;padding:0.55rem 0.8rem;margin-top:0.85rem;line-height:1.6">
            ${ICON('check', 12)} Break handled — ${when}. Rent resumes on ${_fmtISO(gap.nextStartISO)}.</div>`;
    }
    if (!canManage) {
        return `<div class="field-hint" style="background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.25);border-radius:7px;padding:0.55rem 0.8rem;margin-top:0.85rem;line-height:1.6;color:var(--warn)">
            ${ICON('door', 12)} Between semesters — waiting for a holding-fee decision. ${when}.</div>`;
    }
    return `
        <div style="background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.25);border-radius:8px;padding:0.85rem 1rem;margin-top:0.85rem">
            <strong style="color:var(--warn);font-size:0.82rem">${ICON('door', 14)} Between semesters — rent is paused</strong>
            <div style="font-size:0.74rem;color:var(--text-muted);margin:0.4rem 0 0.65rem;line-height:1.6">${when}. Choose how to charge for the break:</div>
            ${_gapChoiceButtons(tenantId, gap.defaultFee)}
        </div>`;
}

function _periodCardHtml(t, data) {
    if (t.status === 'moved_out') return '';
    const note = txt => `<div class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin-bottom:1.25rem;line-height:1.6">${txt}</div>`;
    if (!t.house) return note(`${ICON('door', 12)} No rent cycle yet — it starts the day this tenant is assigned a house.`);
    const p = data.period;
    if (!p) return note(`${ICON('info', 12)} Rent is not set up for this house yet. For semester houses, set the semester dates under Properties → Semester &amp; Deposit Rules.`);

    const caretaker = isCaretaker();
    const perms     = (typeof getCaretakerPermissions === 'function' && getCaretakerPermissions()) || {};
    const canManage = !caretaker || !!perms.canManageTenants;
    const houseName = typeof t.house === 'object' ? t.house.name : '';
    _profilePeriodCache[t._id] = p;
    if (p.gap) _profileGapCache[t._id] = { ...p.gap, tenantName: t.name, houseName };
    else delete _profileGapCache[t._id];

    const neutral = 'background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)';
    let chip = '';
    if (p.rentPaused)               chip = `<span class="pill pill-yellow">${ICON('clock', 10)} Rent paused</span>`;
    else if (p.mode === 'between')  chip = `<span class="pill pill-yellow">${ICON('door', 10)} Between semesters</span>`;
    else if (p.mode === 'extended') chip = `<span class="pill pill-yellow">${ICON('clock', 10)} Extended stay</span>`;
    else if (p.mode === 'upcoming') chip = `<span class="pill" style="${neutral}">Upcoming</span>`;
    else if (p.isOverride)          chip = `<span class="pill pill-yellow">${ICON('clock', 10)} Date adjusted</span>`;

    const started = p.started !== false;
    const row = (label, value) => `<div class="pay-summary-row"><span class="pay-summary-label">${label}</span><span class="pay-summary-value">${value}</span></div>`;
    const balanceHtml = p.rentPaused ? `<span style="color:var(--warn)">Paused</span>`
        : !started ? `<span style="color:var(--text-dim)">Not due yet</span>`
        : p.balance > 0 ? `<span style="color:var(--danger)">${_ksh(p.balance)}</span>`
        : `<span style="color:var(--accent)">Cleared</span>`;

    const actions = [];
    if (!caretaker && p.cycle === 'semester') actions.push(`<button class="btn btn-secondary btn-sm" onclick="openSetBillingModal('${t._id}')">${ICON('edit', 14)} Adjust amount</button>`);
    if (!caretaker && p.cycle === 'monthly')  actions.push(`<button class="btn btn-secondary btn-sm" ${p.rentPaused ? 'disabled title="The tenant is on holiday — record their return first"' : ''} onclick="openCycleEndModal('${t._id}')">${ICON('clock', 14)} Edit due date</button>`);
    if (canManage) actions.push(`<button class="btn btn-secondary btn-sm" onclick="openTransferModal('${t._id}')">${ICON('loop', 14)} Transfer House</button>`);

    return `
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:1rem 1.1rem;margin-bottom:1.25rem">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem">
                <div style="font-size:0.62rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim)">Current ${p.cycle === 'semester' ? 'Semester' : 'Rent Cycle'}</div>
                ${chip}
            </div>
            <div style="font-weight:600;color:var(--text);font-size:0.95rem;margin-bottom:0.65rem">${p.semesterLabel ? _escHtmlRef(p.semesterLabel) + ' <span style="color:var(--text-dim);font-weight:400;font-size:0.78rem">· ' + _escHtmlRef(p.label) + '</span>' : _escHtmlRef(p.label)}</div>
            ${data.stay ? _stayBarHtml(data.stay) : `<div style="font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:var(--text-dim);margin-bottom:0.85rem">${_fmtISO(p.startISO)} → ${_fmtISO(p.effectiveEndISO)}</div>`}
            <div class="pay-summary" style="margin-bottom:0.75rem">
                ${row('Rent for this period', _ksh(p.rentBase))}
                ${p.extensionCharge > 0 ? row(`Extension${p.extensionDays ? ` (+${p.extensionDays} days)` : ''}`, _ksh(p.extensionCharge)) : ''}
                ${row('Total due', `<strong>${_ksh(p.totalDue)}</strong>`)}
                ${row('Paid', _ksh(p.paid))}
                ${row('Balance', balanceHtml)}
                ${row('Due date', _fmtISO(p.dueISO))}
            </div>
            ${actions.length ? `<div style="display:flex;gap:0.5rem;flex-wrap:wrap">${actions.join('')}</div>` : ''}
            ${_gapPromptHtml(t._id, p.gap, canManage)}
        </div>`;
}

// ── "Between semesters" holding-fee decision (profile card + dashboard list) ──
function _gapInfoFor(tenantId) {
    if (_profileGapCache[tenantId]) return _profileGapCache[tenantId];
    const it = (_gapDecisions.items || []).find(i => i.tenantId === tenantId);
    return it ? { ...it } : null;
}

function openGapDecisionModal(tenantId, choice) {
    if (!_checkCaretakerPermission('canManageTenants', 'set holding fees')) return;
    const g = _gapInfoFor(tenantId);
    if (!g) { showToast('Reload and try again', 'warn'); return; }
    if (choice === 'moveout') { _performTenantMoveOut(tenantId, g.tenantName || 'Tenant', g.houseName || ''); return; }

    const title = choice === 'custom' ? 'Custom Holding Fee' : choice === 'none' ? 'No Holding Fee' : 'Default Holding Fee';
    const lbl   = 'class="pay-setup-label" style="display:block;margin-bottom:0.35rem"';
    const fee   = choice === 'default' ? Number(g.defaultFee || 0) : 0;

    _openDynamicModal('modal-gap-decision', `
        ${_modalHeader('modal-gap-decision', title, 'door')}
        <div class="pay-summary">
            <div class="pay-summary-row"><span class="pay-summary-label">Tenant</span><span class="pay-summary-value">${_escHtmlRef(g.tenantName || '—')}${g.houseName ? ' · ' + _escHtmlRef(g.houseName) : ''}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">The break</span><span class="pay-summary-value">${_fmtISO(g.gapStartISO)} → ${_fmtISO(g.nextStartISO)}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Length</span><span class="pay-summary-value">${g.days} day${g.days === 1 ? '' : 's'}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Holding fee</span><span class="pay-summary-value">${choice === 'none' ? 'No fee' : choice === 'default' ? _ksh(fee) + ' / month' : 'You choose'}</span></div>
        </div>
        ${choice === 'custom' ? `<label ${lbl}>Holding fee per month (Ksh)</label>
            <input type="number" id="gapCustomFee" min="1" placeholder="e.g. 2000" oninput="_updateGapEstimate('${tenantId}','custom')">` : ''}
        ${choice === 'default' && fee <= 0 ? `<div class="field-hint" style="color:var(--warn);margin-bottom:0.65rem">${ICON('warning', 12)} The default holding fee is Ksh 0. Set it under Properties → Semester &amp; Deposit Rules, or choose a custom fee.</div>` : ''}
        <div id="gapEstimate" class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin:0 0 0.85rem;line-height:1.6"></div>
        <button class="btn btn-primary btn-full" id="gapConfirmBtn" onclick="submitGapDecision('${tenantId}','${choice}')">Confirm</button>
    `);
    _updateGapEstimate(tenantId, choice);
}

function _updateGapEstimate(tenantId, choice) {
    const box = document.getElementById('gapEstimate');
    const g   = _gapInfoFor(tenantId);
    if (!box || !g) return;
    const fee = choice === 'custom' ? (Number(document.getElementById('gapCustomFee')?.value) || 0)
              : choice === 'default' ? Number(g.defaultFee || 0) : 0;
    const est = Math.ceil((fee / 30) * g.days);
    box.innerHTML = (fee > 0
        ? `${g.days} day(s) × ${_ksh(fee)} ÷ 30 ≈ <strong style="color:var(--accent)">${_ksh(est)}</strong> for the whole break (charged per day).`
        : `Nothing is charged for the break.`)
        + `<br>Rent stays paused until ${_fmtISO(g.nextStartISO)}, then resumes by itself. ${_escHtmlRef(g.tenantName || 'The tenant')} is told by notification and email.`;
}

async function submitGapDecision(tenantId, choice) {
    const feeAmount = choice === 'custom' ? Number(document.getElementById('gapCustomFee')?.value) : undefined;
    if (choice === 'custom' && !(feeAmount > 0)) { showToast('Enter the holding fee per month, or choose "No fee"', 'warn'); return; }

    const btn = document.getElementById('gapConfirmBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = `${ICON('hourglass', 14)} Saving...`; }
    try {
        const res  = await fetch(`${API}/tenants/${tenantId}/gap-decision`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ choice, ...(feeAmount !== undefined && { feeAmount }) })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Could not save the decision', 'error'); return; }
        showToast(data.message, 'success');
        closeModal('modal-gap-decision');
        await loadHolidayHolds();                                          // also refreshes the "between semesters" list
        if (document.getElementById('profileOutput')?.dataset.tenantId === tenantId) loadTenantProfile(tenantId);
    } catch (err) { showToast('Network error', 'error'); console.error(err); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = 'Confirm'; } }
}

function renderGapDecisions(data) {
    _gapDecisions = data && Array.isArray(data.items) ? data : { count: 0, items: [] };
    const card   = document.getElementById('gapDecisionsCard');
    const banner = document.getElementById('dashGapBanner');
    const items  = _gapDecisions.items;
    if (!items.length) {
        if (card)   { card.style.display = 'none';   card.innerHTML = ''; }
        if (banner) { banner.style.display = 'none'; banner.innerHTML = ''; }
        return;
    }

    const rows = items.map(i => `
        <div style="padding:0.75rem 0;border-bottom:1px solid var(--border)">
            <div style="margin-bottom:0.3rem"><strong style="color:var(--text);font-size:0.83rem">${_escHtmlRef(i.tenantName)} <span style="color:var(--text-dim);font-weight:400">· ${_escHtmlRef(i.houseName)}</span></strong></div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim);margin-bottom:0.5rem;line-height:1.7">
                ${_escHtmlRef(i.prevLabel)} ended · ${_escHtmlRef(i.nextLabel)} starts ${_fmtISO(i.nextStartISO)} · ${i.days}-day break
            </div>
            ${_gapChoiceButtons(i.tenantId, i.defaultFee)}
        </div>`).join('');

    if (card) {
        card.style.display = 'block';
        card.innerHTML = `<div class="card-title">${ICON('door', 14)} Between Semesters — holding fee needed <span class="pill pill-yellow">${items.length}</span></div>
            <div class="field-hint" style="margin-bottom:0.25rem">Rent is paused for these tenants until their next semester starts. Choose how to charge for the break.</div>${rows}`;
    }
    if (banner) {
        banner.style.display = 'block';
        banner.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.25);border-radius:10px;padding:0.75rem 1rem;margin-bottom:1.25rem">
            <span style="font-size:0.8rem;color:var(--warn)">${ICON('door', 14)} <strong>${items.length}</strong> tenant${items.length === 1 ? '' : 's'} between semesters need a holding-fee decision</span>
            <button class="btn btn-primary btn-sm" onclick="showSection('tenants')">Review</button></div>`;
    }
}

// Every row is worked out by the server from the real payments (never from fields stored on the billing record).
function renderTenantBillingPanel(tenantId, periods) {
    const el = document.getElementById('tenantBillingPanel');
    if (!el) return;

    const neutral = 'background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)';
    const statusPill = p => {
        if (p.started === false) return `<span class="pill" style="${neutral}">Upcoming</span>`;
        if (p.status === 'paid')    return `<span class="pill pill-green">Paid</span>`;
        if (p.status === 'partial') return `<span class="pill pill-yellow">Partial</span>`;
        return `<span class="pill pill-red">Unpaid</span>`;
    };
    const rows = (periods || []).map(p => `
        <tr>
            <td>${_escHtmlRef(p.periodLabel)}${p.extensionCharge > 0 ? `<div style="font-size:0.62rem;color:var(--text-dim)">incl. ${_ksh(p.extensionCharge)} extension</div>` : ''}</td>
            <td class="td-mono">${_fmtISO(p.dueISO)}</td>
            <td class="td-mono">${_ksh(p.paid)}</td>
            <td class="td-mono">${p.started === false ? '—' : _ksh(p.balance)}</td>
            <td>${statusPill(p)}</td>
        </tr>`).join('') || `<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">No semester periods yet</td></tr>`;

    el.innerHTML = `
        <div style="margin-top:1.25rem;border-top:1px solid var(--border);padding-top:1rem">
            <div style="font-size:0.62rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim);margin-bottom:0.65rem">Semester Periods</div>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Period</th><th>Due</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

// "Adjust amount" — edits the BASE rent of the period the tenant is under. Any extension charge stays on top
// of it, and what the change does to the balance is shown BEFORE it is saved.
let _adjustCtx = null;

function openSetBillingModal(tenantId) {
    if (isCaretaker()) { showToast('Only landlords can adjust a period amount', 'warn'); return; }
    _adjustCtx = null;
    const lbl = 'class="pay-setup-label" style="display:block;margin-bottom:0.35rem"';
    _openDynamicModal('modal-set-billing', `
        ${_modalHeader('modal-set-billing', 'Adjust Amount', 'edit')}
        <input type="hidden" id="setBillingTenantId" value="${tenantId}">
        <div class="pay-summary" id="setBillingSummary"><div class="pay-summary-row"><span class="pay-summary-label">Loading…</span><span class="pay-summary-value">—</span></div></div>
        <label ${lbl}>Rent for this period (Ksh)</label>
        <input type="number" id="setBillingBase" min="0" oninput="_updateAdjustPreview()" style="margin-bottom:0.35rem">
        <div class="pay-setup-hint" id="setBillingProrateHint" style="margin-bottom:0.65rem"></div>
        <div id="setBillingPreview" class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin:0 0 0.85rem;line-height:1.6">Loading…</div>
        <button class="btn btn-primary btn-full" id="setBillingSaveBtn" onclick="submitSetBilling()" disabled>${ICON('lock',14)} Save Amount</button>
    `);
    _loadBillingSuggestion(tenantId);
}

async function _loadBillingSuggestion(tenantId) {
    try {
        const res  = await fetch(`${API}/landlord/billing/${tenantId}/current-period`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.message || 'Could not load this period', 'error');
            closeModal('modal-set-billing');
            return;
        }
        _adjustCtx = data;
        const note = data.periodMode === 'between' ? 'The break between semesters has started, so this is the semester the tenant just finished.'
                   : data.periodMode === 'extended' ? 'This is the semester the tenant is staying on in, after its end date.'
                   : data.periodMode === 'upcoming' ? 'This semester has not started yet.' : '';
        document.getElementById('setBillingSummary').innerHTML = `
            <div class="pay-summary-row"><span class="pay-summary-label">Period</span><span class="pay-summary-value">${_escHtmlRef(data.semesterLabel ? data.semesterLabel + ' · ' : '')}${_escHtmlRef(data.periodLabel)}</span></div>
            ${data.extensionCharge > 0 ? `<div class="pay-summary-row"><span class="pay-summary-label">Extension charge (kept)</span><span class="pay-summary-value">${_ksh(data.extensionCharge)}</span></div>` : ''}
            <div class="pay-summary-row"><span class="pay-summary-label">Paid so far</span><span class="pay-summary-value">${_ksh(data.paid)}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Balance now</span><span class="pay-summary-value" style="color:${data.balance > 0 ? 'var(--warn)' : 'var(--accent)'}">${_ksh(data.balance)}</span></div>
            ${note ? `<div class="pay-setup-hint" style="margin-top:0.35rem">${_escHtmlRef(note)}</div>` : ''}`;
        document.getElementById('setBillingBase').value = data.baseAmount;
        document.getElementById('setBillingProrateHint').innerHTML = Number(data.suggestedBaseAmount) !== Number(data.baseAmount)
            ? `Tenants who join more than 10 days into a semester are normally charged a prorated amount: <a href="#" onclick="document.getElementById('setBillingBase').value=${Number(data.suggestedBaseAmount)};_updateAdjustPreview();return false" style="color:var(--accent)">use ${_ksh(data.suggestedBaseAmount)}</a>.`
            : '';
        document.getElementById('setBillingSaveBtn').disabled = false;
        _updateAdjustPreview();
    } catch (err) {
        console.error('_loadBillingSuggestion error:', err);
        showToast('Network error loading this period', 'error');
    }
}

function _updateAdjustPreview() {
    const box = document.getElementById('setBillingPreview');
    const btn = document.getElementById('setBillingSaveBtn');
    const c   = _adjustCtx;
    if (!box || !c) return;
    const raw = document.getElementById('setBillingBase')?.value;
    const base = Number(raw);
    if (raw === '' || !Number.isFinite(base) || base < 0) { box.textContent = 'Enter the rent for this period.'; if (btn) btn.disabled = true; return; }
    if (btn) btn.disabled = false;

    const total   = base + Number(c.extensionCharge || 0);
    const balance = Math.max(0, total - c.paid);
    const over    = Math.max(0, c.paid - total);
    const creates = balance > Number(c.balance || 0);

    let msg = `New total <strong style="color:var(--text)">${_ksh(total)}</strong>${c.extensionCharge > 0 ? ` (${_ksh(base)} + ${_ksh(c.extensionCharge)} extension)` : ''} · paid ${_ksh(c.paid)} → `;
    if (balance > 0) msg += `balance <strong style="color:var(--warn)">${_ksh(balance)}</strong>.`;
    else msg += `<strong style="color:var(--accent)">fully paid</strong>.`;
    if (creates)   msg += `<br><span style="color:var(--warn)">${ICON('warning', 12)} This will create an arrear of ${_ksh(balance - Number(c.balance || 0))} for this period.</span>`;
    else if (over) msg += `<br>The tenant will have paid ${_ksh(over)} more than is due — nothing is refunded automatically.`;
    box.innerHTML = msg;
    if (btn) btn.innerHTML = creates ? `${ICON('warning', 14)} Save &amp; add ${_ksh(balance - Number(c.balance || 0))} arrear` : `${ICON('lock', 14)} Save Amount`;
}

async function submitSetBilling() {
    const tenantId   = document.getElementById('setBillingTenantId').value;
    const baseAmount = document.getElementById('setBillingBase').value;
    if (baseAmount === '') { showToast('Amount is required', 'warn'); return; }

    const btn = document.getElementById('setBillingSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = `${ICON('hourglass',14)} Saving...`; }

    try {
        const res  = await fetch(`${API}/landlord/billing`, {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ tenantId, billingCycle: 'semester', baseAmount: Number(baseAmount) })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to save the amount', 'error'); if (btn) { btn.disabled = false; } return; }

        showToast('Amount saved ', 'success');
        closeModal('modal-set-billing');
        await _refreshAfterStayChange(tenantId);

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
        if (btn) btn.disabled = false;
    }
}

// For a semester tenant, locks a payment-form "month" input to the
// canonical period label fetched from the server. Monthly tenants are
// left untouched — the input stays free-typed as before.
async function _syncPeriodFieldForTenant(tenantId, inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const tenant = _allTenants.find(t => t._id === tenantId);
    const isSemester = tenant?.house && typeof tenant.house === 'object' && tenant.house.billingCycle === 'semester';

    if (!isSemester) {
        input.readOnly = false;
        delete input.dataset.cycleLabel;
        // A monthly tenant's rent cycle starts the day they were assigned a house, so the default month
        // is their current cycle (still editable) rather than the calendar month.
        if (tenant && tenant.house) {
            try {
                const res  = await fetch(`${API}/landlord/billing/${tenantId}/current-period?monthly=1`, { headers: authHeaders() });
                const data = await res.json();
                if (res.ok && data.periodLabel) input.dataset.cycleLabel = data.periodLabel;
            } catch (err) { console.error('_syncPeriodFieldForTenant (monthly) error:', err); }
        }
        return;
    }

    try {
        const res  = await fetch(`${API}/landlord/billing/${tenantId}/current-period`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Could not load billing period', 'error'); return; }

        input.value    = data.periodLabel;
        input.readOnly = true;
        input.title    = `Semester billing — set automatically (due ${new Date(data.dueDateActual).toLocaleDateString()})`;
    } catch (err) {
        console.error('_syncPeriodFieldForTenant error:', err);
    }
}


let _paymentType = 'rent';
let _modalPaymentType = 'rent';

function setPaymentType(type) {
    if (type === 'refund' && isCaretaker()) { showToast('Only landlords can record refunds', 'warn'); return; }
    _paymentType = type;

    ['Rent','Deposit','Refund'].forEach(t => {
        const btn = document.getElementById(`payType${t}Btn`);
        if (btn) btn.className = `btn btn-sm ${t.toLowerCase() === type ? 'btn-primary' : 'btn-secondary'}`;
    });

    const rentFields = document.getElementById('rentOnlyFields');
    if (rentFields) rentFields.style.display = type === 'rent' ? 'block' : 'none';

    const amountInput = document.getElementById('amount');
    if (amountInput && type !== 'deposit') {
        amountInput.readOnly = false;
        amountInput.title    = '';
    }
    if (type === 'deposit') _applyInlineDepositLock();

    const recordBtn = document.getElementById('recordPaymentBtn');
    if (recordBtn) {
        recordBtn.innerHTML = type === 'rent'
            ? `${ICON('payments',14)} Record &amp; Email Receipt`
            : type === 'deposit'
            ? `${ICON('cash',14)} Record Deposit`
            : `${ICON('cash',14)} Record Refund`;
    }
}

// Mirrors openDepositModal's locking logic for the inline Payments form,
// where the tenant is chosen from a <select> rather than a clicked row.
function _applyInlineDepositLock() {
    const amountInput = document.getElementById('amount');
    if (!amountInput) return;

    const tenantId = document.getElementById('payTenantSelect')?.value;
    if (!tenantId) {
        amountInput.value    = '';
        amountInput.readOnly = false;
        return;
    }

    const propertyId = getPropertyId();
    const prop        = _propertiesCache.find(p => p._id === propertyId);
    const required    = Number(prop?.depositPolicy?.depositAmount || 0);
    const tenant      = _allTenants.find(t => t._id === tenantId);

    if (tenant?.depositStatus === 'paid') {
        showToast('Deposit already paid in full for this tenant', 'warn');
    }

    if (required > 0) {
        amountInput.value    = required;
        amountInput.readOnly = true;
        amountInput.title    = `Deposit must be paid in full: Ksh ${required.toLocaleString()}`;
    } else {
        amountInput.value    = '';
        amountInput.readOnly = false;
        showToast('No deposit amount set for this property yet', 'warn');
    }
}

function setModalPaymentType(type) {
    if (type === 'refund' && isCaretaker()) { showToast('Only landlords can record refunds', 'warn'); return; }
    _modalPaymentType = type;

    ['Rent','Deposit','Refund'].forEach(t => {
        const btn = document.getElementById(`payModalType${t}Btn`);
        if (btn) btn.className = `btn btn-sm ${t.toLowerCase() === type ? 'btn-primary' : 'btn-secondary'}`;
    });

    const rentFields = document.getElementById('modalRentOnlyFields');
    if (rentFields) rentFields.style.display = type === 'rent' ? 'block' : 'none';

    const amountInput = document.getElementById('payModalAmount');
    if (amountInput && type !== 'deposit') {
        amountInput.readOnly = false;
        amountInput.title    = '';
    }
    if (type === 'deposit') _applyModalDepositLock();

    const submitBtn = document.getElementById('payModalSubmitBtn');
    if (submitBtn) {
        submitBtn.innerHTML = type === 'rent'
            ? `${ICON('payments',14)} Record &amp; Send Receipt`
            : type === 'deposit'
            ? `${ICON('cash',14)} Record Deposit`
            : `${ICON('cash',14)} Record Refund`;
    }
}

// Mirrors _applyInlineDepositLock() but for the tenant-context "Record
// Payment" modal, where the tenant is fixed via payModalTenantId rather
// than a <select>.
function _applyModalDepositLock() {
    const amountInput = document.getElementById('payModalAmount');
    if (!amountInput) return;

    const tenantId = document.getElementById('payModalTenantId')?.value;
    if (!tenantId) {
        amountInput.value    = '';
        amountInput.readOnly = false;
        return;
    }

    const propertyId = getPropertyId();
    const prop        = _propertiesCache.find(p => p._id === propertyId);
    const required     = Number(prop?.depositPolicy?.depositAmount || 0);
    const tenant        = _allTenants.find(t => t._id === tenantId);

    if (tenant?.depositStatus === 'paid') {
        showToast('Deposit already paid in full for this tenant', 'warn');
    }

    if (required > 0) {
        amountInput.value    = required;
        amountInput.readOnly = true;
        amountInput.title    = `Deposit must be paid in full: Ksh ${required.toLocaleString()}`;
    } else {
        amountInput.value    = '';
        amountInput.readOnly = false;
        showToast('No deposit amount set for this property yet — set it in Semester & Deposit Rules', 'warn');
    }
}


// ═══════════════════════════════════════
// ARREARS TABLE
// ═══════════════════════════════════════



function renderArrearsTable(data, options = {}) {
    const tbody = document.getElementById('arrearsTable');
    const mode = options.mode || 'current';

    if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">${ICON('celebrate',20)} No arrears found</div></td></tr>`;
        return;
    }

    tbody.innerHTML = data.map(r => {
        const cyclePill = r.billingCycle === 'semester'
            ? `<span class="pill pill-yellow" style="font-size:0.55rem">Semester</span>`
            : (mode !== 'semester' ? `<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border);font-size:0.55rem">Monthly</span>` : '');
        const estimatedPill = r.estimated
            ? `<span class="pill pill-yellow" style="font-size:0.55rem;margin-left:4px" title="No saved billing record for this period — showing the house's current rate">Estimated</span>`
            : '';

        return `
        <tr>
            <td><strong style="color:var(--text)">${r.tenant}</strong></td>
            <td class="td-mono">${r.house}</td>
            <td class="td-mono" style="font-size:0.7rem">${r.month || '—'}${cyclePill ? '<br>' + cyclePill : ''}${estimatedPill}</td>
            <td class="td-mono">Ksh ${Number(r.rent).toLocaleString()}</td>
            <td class="td-mono">Ksh ${Number(r.totalPaid).toLocaleString()}</td>
            <td><span class="pill pill-red">Ksh ${Number(r.balance).toLocaleString()}</span></td>
            <td><span class="pill pill-yellow">${r.status.toUpperCase()}</span></td>
            <td><button class="btn btn-primary btn-sm" onclick="quickPay('${r.tenantId}')">Pay Now</button></td>
        </tr>`;
    }).join('');
}

function quickPay(tenantId) {
    if (!_checkCaretakerPermission('canRecordPayments', 'record payments')) return;

    const tenant = _allTenants.find(t => t._id === tenantId);
    if (tenant) openPayModal(tenant);
    else showToast('Tenant not found — click Refresh', 'warn');
}


const EXPENSE_CATEGORY_ICONS = {
    water: ICON('water',14), electricity: ICON('bolt',14), repairs: ICON('maintenance',14),
    security: ICON('shield',14), cleaning: ICON('broom',14), staff: ICON('hardhat',14), other: ICON('box',14)
};

function renderExpensesTable(expenses) {
    const tbody = document.getElementById('expensesTable');
    if (!tbody) return;

    if (!expenses.length) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">No expenses recorded yet</div></td></tr>';
        return;
    }

    tbody.innerHTML = expenses.map(e => `
        <tr>
            <td style="display:flex;align-items:center;gap:6px">${EXPENSE_CATEGORY_ICONS[e.category] || ICON('box',14)} ${e.category}</td>
            <td class="td-mono">Ksh ${Number(e.amount).toLocaleString()}</td>
            <td class="td-mono">${e.month}</td>
            <td style="font-size:0.75rem;color:var(--text-muted)">${e.property?.name || '—'}</td>
            <td><button class="btn btn-danger btn-sm" onclick="deleteExpense('${e._id}')">${ICON('trash',14)}</button></td>
        </tr>`).join('');
}


// ═══════════════════════════════════════
// HOUSE GRID
// ═══════════════════════════════════════

function renderHouseGrid(houses, gridElId = 'houseGrid', legendElId = 'houseGroupLegend') {
    const grid = document.getElementById(gridElId);
    if (!grid) return;

    // Building view: the Houses / Assign pages show building cards first and only the houses of the
    // building that was opened (see buildings.js). Everything below is the unchanged house grid.
    let _bb = null;
    if (window.BuildingBrowser) {
        _bb = window.BuildingBrowser.intercept(gridElId, legendElId, houses);
        if (_bb.skip) return;
        houses = _bb.houses;
    }

    _renderHouseGroupLegend(houses, legendElId);

    if (!houses.length) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><span class="icon">${ICON('houses',26)}</span>${(_bb && _bb.emptyText) || 'No houses added yet'}</div>`;
        return;
    }

    grid.innerHTML = houses.map(h => {
    const groupPill = h.group
                ? `<span style="display:inline-block;font-family:'JetBrains Mono',monospace;font-size:0.55rem;font-weight:700;
                        padding:1px 7px;border-radius:99px;margin-bottom:0.4rem;margin-right:4px;
                        background:${_groupColor(h.group.colorIndex)}22;color:${_groupColor(h.group.colorIndex)};
                        border:1px solid ${_groupColor(h.group.colorIndex)}55">
                    ${h.group.label || h.group.prefix || 'Group'}
                </span>`
                : '';
            const cyclePill = h.billingCycle === 'semester'
                ? `<span class="pill pill-yellow" style="font-size:0.55rem;margin-bottom:0.4rem;display:inline-block">Semester</span>`
                : '';

        return `
        <div class="house-card ${h.status}"
             onclick="houseOptions(event, ${JSON.stringify(h).replace(/"/g, '&quot;')})">
            ${groupPill}${cyclePill}${h.onHoliday ? `<span class="pill pill-yellow" style="font-size:0.55rem;margin-bottom:0.4rem;display:inline-block">On Holiday</span>` : ''}
            <div class="house-name">${h.name}</div>
            <div class="house-rent">Ksh ${Number(h.rent).toLocaleString()} ${h.billingCycle === 'semester' ? '/ semester' : '/ mo'}</div>
            <div style="margin-top:0.5rem;font-size:0.68rem">
                <span class="status-dot ${h.status}"></span>${h.status}
                ${h.tenantName ? `<span style="color:var(--text-muted);margin-left:0.4rem">· ${h.tenantName}</span>` : ''}
            </div>
        </div>`;
    }).join('');

    if (_bb && typeof _bb.afterRender === 'function') _bb.afterRender(grid);
}

function _renderHouseGroupLegend(houses, legendElId = 'houseGroupLegend') {
    const legendEl = document.getElementById(legendElId);
    if (!legendEl) return;

    const seen = new Map();
    houses.forEach(h => {
        if (h.group && !seen.has(h.group._id || h.group)) {
            seen.set(h.group._id || h.group, h.group);
        }
    });

    if (!seen.size) { legendEl.innerHTML = ''; return; }

    legendEl.innerHTML = [...seen.values()].map(g => `
        <span style="display:inline-flex;align-items:center;gap:0.35rem;font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim)">
            <span style="width:8px;height:8px;border-radius:50%;background:${_groupColor(g.colorIndex)};display:inline-block"></span>
            ${g.label || g.prefix || 'Group'}
        </span>`).join('');
}

// ── FIXED: Menu is appended to document.body with position:fixed so it always
//    floats above all cards regardless of stacking context, multi-line cards,
//    or grid layout. Also dismisses on any scroll event. ──
function houseOptions(event, house) {
    event.stopPropagation();
    document.querySelectorAll('.house-ctx-menu').forEach(m => m.remove());

    const card = event.currentTarget;
    const rect = card.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu house-ctx-menu';

    const headerHtml = `<div class="ctx-item" style="font-size:0.7rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace;cursor:default">${house.name}</div><div class="ctx-divider"></div>`;

    const editItemHtml = IS_CARETAKER ? '' :
        `<div class="ctx-item" onclick="openEditHouseModal(${JSON.stringify(house).replace(/"/g,'&quot;')})">${ICON('edit',14)} Edit House</div>`;

    if (house.status === 'available') {
        menu.innerHTML = headerHtml + editItemHtml +
            `<div class="ctx-item" onclick="openAssignModal('${house._id}', '${house.name.replace(/'/g, "\\'")}')">${ICON('key',14)} Assign Tenant</div>` +
            (IS_CARETAKER ? '' : `<div class="ctx-item danger" onclick="deleteHouse('${house._id}')">${ICON('trash',14)} Delete House</div>`);
    } else {
        const tenantLabel = house.tenantName ? `Move Out ${house.tenantName}` : 'Move Out Tenant';
        // ── Caretakers can now move tenants out from here too — only
        //    Delete House stays landlord-only. Permission is enforced
        //    inside confirmMoveOutByHouse() before the action runs. ──
        menu.innerHTML = headerHtml + editItemHtml +
            `<div class="ctx-item" style="color:var(--warn)" onclick="confirmMoveOutByHouse('${house._id}', '${house.name.replace(/'/g, "\\'")}', '${(house.tenantId || '').replace(/'/g, "\\'")}', '${(house.tenantName || 'Tenant').replace(/'/g, "\\'")}')">${ICON('door',14)} ${tenantLabel}</div>` +
            (IS_CARETAKER ? '' : `<div class="ctx-item danger" onclick="deleteHouse('${house._id}')">${ICON('trash',14)} Delete House</div>`);
    }
    // Landlord only: reorganise the house into another building (grouping only — nothing else changes)
    if (!IS_CARETAKER && window.BuildingBrowser) {
        const gid = house.group ? (house.group._id || house.group) : '';
        const moveItem = document.createElement('div');
        moveItem.className = 'ctx-item';
        moveItem.innerHTML = `${ICON('properties',14)} Move to building…`;
        moveItem.addEventListener('click', () => window.BuildingBrowser.openMoveModal(house._id, house.name, gid));
        const del = menu.querySelector('.ctx-item.danger');
        if (del) menu.insertBefore(moveItem, del); else menu.appendChild(moveItem);
    }
    const menuW = 210, menuH = 170;
    let top = rect.bottom + 4, left = rect.left;
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
    if (left < 8) left = 8;
    if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 4;
    if (top < 8) top = 8;

    menu.style.cssText = `position: fixed; top: ${top}px; left: ${left}px; z-index: 9999; width: max-content; min-width: 180px; max-width: 260px;`;
    document.body.appendChild(menu);

    function dismiss(e) {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', dismiss);
            window.removeEventListener('scroll', onScroll, true);
        }
    }
    function onScroll() {
        menu.remove();
        document.removeEventListener('click', dismiss);
        window.removeEventListener('scroll', onScroll, true);
    }
    setTimeout(() => {
        document.addEventListener('click', dismiss);
        window.addEventListener('scroll', onScroll, true);
    }, 0);
}


function _ctxAssignFromTenant(tenantId) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const tenant = _allTenants.find(t => t._id === tenantId);
    if (!tenant) return;
    openAssignModalForTenant(tenant);
}

function _ctxTransferFromTenant(tenantId) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    openTransferModal(tenantId);
}

function _ctxMoveOutFromTenant(tenantId) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    if (!_checkCaretakerPermission('canManageTenants', 'move out tenants')) return;
    const tenant = _allTenants.find(t => t._id === tenantId);
    if (!tenant || !tenant.house) return;
    const houseName = typeof tenant.house === 'object' ? tenant.house.name : '';
    _performTenantMoveOut(tenant._id, tenant.name, houseName);
}

// ── Shared modal shell for both directions: house→tenant (from a house
//    card) and tenant→house (from a tenant row). No override option
//    anywhere — the deposit gate is enforced server-side, unconditionally. ──
function _buildAssignModalShell() {
    let modal = document.getElementById('modal-assign-house');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id        = 'modal-assign-house';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal" style="max-width:380px">
            <div class="modal-header">
                <div class="modal-title">${ICON('key',18)} Assign House</div>
                <button class="modal-close" onclick="closeModal('modal-assign-house')">${ICON('close',16)}</button>
            </div>
            <div class="card-title" id="assignModalTenantLabel" style="display:none"></div>
            <input type="hidden" id="assignModalTenantId">
            <div id="assignModalTenantSelectWrap">
              <label style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);display:block;margin-bottom:0.35rem">Tenant</label>
              <select id="assignModalTenantSelect" style="margin-bottom:0.75rem"></select>
            </div>
            <label style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);display:block;margin-bottom:0.35rem">House</label>
            <select id="assignModalHouseSelect" style="margin-bottom:0.75rem"></select>
            <button class="btn btn-primary btn-full" onclick="submitAssignFromModal()">Assign to House</button>
        </div>`;
    modal.addEventListener('click', e => { if (e.target === modal) closeModal('modal-assign-house'); });
    document.body.appendChild(modal);
    return modal;
}

// Houses grouped by building (<optgroup>) when more than one building is involved.
function _houseOptionsGrouped(houses) {
    return window.BuildingBrowser ? window.BuildingBrowser.groupedHouseOptions(houses, _houseSelectOption) : houses.map(_houseSelectOption).join('');
}

function _houseSelectOption(h) {
    return `<option value="${h._id}">${h.name} — Ksh ${Number(h.rent).toLocaleString()}${h.billingCycle === 'semester' ? ' / sem' : ' / mo'}</option>`;
}

// Opened from a house card (house is fixed, pick the tenant)
function openAssignModal(houseId, houseName) {
    if (!_checkCaretakerPermission('canManageTenants', 'assign houses')) return;
    document.querySelectorAll('.house-ctx-menu').forEach(m => m.remove());

    const modal = _buildAssignModalShell();

    document.getElementById('assignModalTenantLabel').style.display = 'none';
    document.getElementById('assignModalTenantSelectWrap').style.display = 'block';
    document.getElementById('assignModalTenantId').value = '';

    const houseSel   = document.getElementById('assignModalHouseSelect');
    const available   = (_allHouses || []).filter(h => h.status === 'available');
    houseSel.innerHTML = available.length
        ? _houseOptionsGrouped(available)
        : `<option value="${houseId}">${houseName}</option>`;
    houseSel.value    = houseId;
    houseSel.disabled = true;

    const tenantSel  = document.getElementById('assignModalTenantSelect');
    const unassigned = (_allTenants || []).filter(t => !t.house);
    tenantSel.innerHTML = `<option value="">— Select tenant —</option>` +
        (unassigned.length ? unassigned : (_allTenants || [])).map(t =>
            `<option value="${t._id}">${t.name}${t.house ? ' (has house)' : ''}</option>`).join('');
    tenantSel.disabled = false;

    modal.classList.add('open');
}

// Opened from a tenant row (tenant is fixed, pick the house)
function openAssignModalForTenant(tenant) {
    if (!_checkCaretakerPermission('canManageTenants', 'assign houses')) return;

    const modal = _buildAssignModalShell();

    document.getElementById('assignModalTenantLabel').textContent = `Assigning house for: ${tenant.name}`;
    document.getElementById('assignModalTenantLabel').style.display = 'block';
    document.getElementById('assignModalTenantSelectWrap').style.display = 'none';
    document.getElementById('assignModalTenantId').value = tenant._id;

    const houseSel  = document.getElementById('assignModalHouseSelect');
    const available = (_allHouses || []).filter(h => h.status === 'available');
    houseSel.innerHTML = available.length
        ? `<option value="">— Select a house —</option>` + _houseOptionsGrouped(available)
        : `<option value="">No available houses — add one first</option>`;
    houseSel.disabled = false;

    modal.classList.add('open');
}

function openEditHouseModal(house) {
    document.querySelectorAll('.house-ctx-menu').forEach(m => m.remove());

    let modal = document.getElementById('modal-edit-house');
    if (!modal) {
        modal = document.createElement('div');
        modal.id        = 'modal-edit-house';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal" style="max-width:400px">
                <div class="modal-header">
                    <div class="modal-title">${ICON('edit',18)} Edit House</div>
                    <button class="modal-close" onclick="closeModal('modal-edit-house')">${ICON('close',16)}</button>
                </div>
                <input type="hidden" id="editHouseId">
                <label class="pay-setup-label" style="display:block;margin-bottom:0.35rem">Name</label>
                <input type="text" id="editHouseName" style="margin-bottom:0.75rem">
                <div id="editHouseBuildingWrap"></div>
                <label class="pay-setup-label" style="display:block;margin-bottom:0.35rem">Billing Cycle</label>
                <select id="editHouseBillingCycle" onchange="_toggleEditHouseAmountDue()" style="margin-bottom:0.75rem">
                    <option value="monthly">Monthly</option>
                    <option value="semester">Semester</option>
                </select>
                <label class="pay-setup-label" style="display:block;margin-bottom:0.35rem" id="editHouseRentLabel">Rent (Ksh)</label>
                <input type="number" id="editHouseRent" style="margin-bottom:0.35rem">
                <div class="pay-setup-hint" id="editHouseRentNote" style="margin-bottom:0.75rem">If a monthly tenant lives here, the new rent applies from their next rent cycle. Months already running or past keep the old rent.</div>
                <div id="editHouseAmountDueWrap" style="display:none">
                    <label class="pay-setup-label" style="display:block;margin-bottom:0.35rem">Current Period Amount Due (Ksh)</label>
                    <input type="number" id="editHouseAmountDue" style="margin-bottom:0.5rem">
                    <div class="pay-setup-hint">Fallback used when no Billing record exists yet for the tenant's current period.</div>
                </div>
                <button class="btn btn-primary btn-full" onclick="submitEditHouse()" style="margin-top:0.5rem">${ICON('lock',14)} Save Changes</button>
            </div>`;
        modal.addEventListener('click', e => { if (e.target === modal) closeModal('modal-edit-house'); });
        document.body.appendChild(modal);
    }

    document.getElementById('editHouseId').value              = house._id;
    if (window.BuildingBrowser) window.BuildingBrowser.fillEditSelect(house);
    document.getElementById('editHouseName').value             = house.name;
    document.getElementById('editHouseRent').value             = house.rent;
    document.getElementById('editHouseBillingCycle').value     = house.billingCycle === 'semester' ? 'semester' : 'monthly';
    document.getElementById('editHouseAmountDue').value        = house.amountDue || '';
    // An occupied house cannot switch between monthly and semester billing (the server refuses it too).
    const _cycleSel = document.getElementById('editHouseBillingCycle');
    _cycleSel.disabled = house.status === 'occupied';
    _cycleSel.title    = house.status === 'occupied' ? 'This house is occupied, so its billing cycle cannot be changed' : '';
    _toggleEditHouseAmountDue();

    openModal('modal-edit-house');
}

function _toggleEditHouseAmountDue() {
    const cycle    = document.getElementById('editHouseBillingCycle')?.value;
    const wrap     = document.getElementById('editHouseAmountDueWrap');
    const rentLbl  = document.getElementById('editHouseRentLabel');
    if (wrap)    wrap.style.display = 'none';   // semester rent now comes from the property's semester setup
    if (rentLbl) rentLbl.textContent = cycle === 'semester' ? 'Base Rent (Ksh, used if no Billing record exists)' : 'Rent (Ksh)';
}

async function submitEditHouse() {
    const id            = document.getElementById('editHouseId').value;
    const name          = document.getElementById('editHouseName').value.trim();
    const rent          = document.getElementById('editHouseRent').value;
    const billingCycle  = document.getElementById('editHouseBillingCycle').value;
    const amountDue     = document.getElementById('editHouseAmountDue').value;

    if (!name || !rent) { showToast('Name and rent are required', 'warn'); return; }

    const btn = document.querySelector('#modal-edit-house .btn-primary');
    if (btn) { btn.disabled = true; btn.innerHTML = `${ICON('hourglass',14)} Saving...`; }

    try {
        const body = { name, rent: Number(rent), billingCycle };
        if (billingCycle === 'semester' && amountDue !== '') body.amountDue = Number(amountDue);

        const res  = await fetch(`${API}/houses/${id}`, {
            method: 'PUT', headers: authHeaders(), body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Update failed', 'error'); return; }

        showToast('House updated ', 'success');

        // Building changed in the same form → one extra, separate call (grouping only)
        const bSel = document.getElementById('editHouseBuilding');
        if (bSel && window.BuildingBrowser && bSel.value !== (bSel.dataset.initial || '')) {
            await window.BuildingBrowser.moveHouses([id], bSel.value || null);
        }
        closeModal('modal-edit-house');
        await loadHouses();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `${ICON('lock',14)} Save Changes`; }
    }
}

async function submitAssignFromModal() {
    const houseId       = document.getElementById('assignModalHouseSelect').value;
    const fixedTenantId = document.getElementById('assignModalTenantId').value;
    const tenantId       = fixedTenantId || document.getElementById('assignModalTenantSelect').value;
    if (!houseId)  { showToast('Select a house first', 'warn'); return; }
    if (!tenantId) { showToast('Select a tenant first', 'warn'); return; }

    const btn = document.querySelector('#modal-assign-house .btn-primary');
    if (btn) { btn.disabled = true; btn.innerHTML = `${ICON('hourglass',14)} Assigning...`; }

    try {
        const res  = await fetch(`${API}/assign-house/${tenantId}/${houseId}`, { method: 'PUT', headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || data.error || 'Assign failed', 'error'); return; }
        showToast(data.message || 'House assigned ', 'success');
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
    document.querySelectorAll('.house-ctx-menu').forEach(m => m.remove());
    if (!_checkCaretakerPermission('canManageTenants', 'move out tenants')) return;

    if (!tenantId) {
        showToast('Could not identify the tenant. Use Move Out from the Houses section.', 'warn');
        return;
    }

    _performTenantMoveOut(tenantId, tenantName, houseName);
}


// ═══════════════════════════════════════
// SELECT POPULATION
// ═══════════════════════════════════════

function populateTenantSelects(tenants) {
    const ids = ['payTenantSelect', 'moveOutSelect'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = `<option value="">— Select tenant —</option>` +
            tenants.map(t => `<option value="${t._id}">${t.name}</option>`).join('');
    });

    renderMsgTenantList(tenants);
}




// ═══════════════════════════════════════
// RECEIPT RENDERING
// ═══════════════════════════════════════

function renderReceipt(data, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = `
        <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:1.25rem;margin-top:0.5rem">
            <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.2rem;color:var(--accent);margin-bottom:0.75rem;display:flex;align-items:center;gap:8px">${ICON('houses',18)} Rent Receipt</div>
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
                <button class="btn btn-secondary btn-sm" onclick="window.print()">${ICON('printer',14)} Print</button>
                <button class="btn btn-primary btn-sm"   onclick="downloadPDF('${data._id}')">${ICON('file',14)} PDF</button>
            </div>
        </div>`;
}

// ═══════════════════════════════════════
// ACTIVITY LOG — rendering
// ═══════════════════════════════════════


const ACTIVITY_ICONS = {
    'tenant.created':        ICON('addTenant',14),
    'tenant.readded':        ICON('loop',14),
    'tenant.assigned':       ICON('key',14),
    'tenant.reactivated':    ICON('loop',14),
    'tenant.moved_out':      ICON('door',14),
    'tenant.deleted':        ICON('trash',14),
    'tenants.bulk_reminded': ICON('bell',14),
    'payment.recorded':      ICON('payments',14),
    'houses.bulk_generated': ICON('flash',14),
    'commission.paid':       ICON('cash',14),
    'expense.recorded':      ICON('expenses',14),
    'expense.deleted':       ICON('trash',14),
    'maintenance.reported':       ICON('maintenance',14),
    'tenant.self_registered': ICON('addTenant',14),
    'invitation.created':     ICON('plus',14),
    'invitation.revoked':     ICON('trash',14),
    'maintenance.status_changed': ICON('check',14)
};

function _activityTimeAgo(date) {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    if (isNaN(seconds) || seconds < 0) return '—';
    if (seconds < 60)     return 'just now';
    if (seconds < 3600)   return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400)  return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function renderActivityLog(logs) {
    const feed = document.getElementById('activityLogFeed');
    if (!feed) return;

    if (!logs.length) {
        feed.innerHTML = `<div class="empty-state"><span class="icon">${ICON('clock',26)}</span>No activity recorded yet</div>`;
        return;
    }

    const actorLabel = {
        caretaker: IS_CARETAKER ? 'You' : 'Caretaker',
        system:    'System',
        stacklord: 'Admin',
        landlord:  IS_CARETAKER ? 'Landlord' : 'You'
    };
    const actorColor = {
        caretaker: '#60a5fa',
        system:    'var(--text-dim)',
        stacklord: 'var(--warn)',
        landlord:  'var(--text-dim)'
    };

    feed.innerHTML = logs.map(l => `
        <div class="activity-item">
            <span class="activity-icon">${ACTIVITY_ICONS[l.action] || '•'}</span>
            <div class="activity-body">
                <div class="activity-desc">${l.message}</div>
                <div class="activity-meta">
                    <span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border);font-size:0.55rem">${l.action}</span>
                    <span class="pill" style="font-size:0.55rem;background:${actorColor[l.actor] || 'var(--bg3)'}22;color:${actorColor[l.actor] || 'var(--text-dim)'};border:1px solid var(--border)">${actorLabel[l.actor] || l.actor}</span>
                </div>
            </div>
            <div class="activity-time">${_activityTimeAgo(l.createdAt)}</div>
        </div>`).join('');
}

function _renderActivityPagination() {
    const wrap    = document.getElementById('activityPagination');
    const infoEl  = document.getElementById('activityPageInfo');
    const prevBtn = document.getElementById('actPrevBtn');
    const nextBtn = document.getElementById('actNextBtn');
    if (!wrap) return;

    if (_activityPages <= 1) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';

    if (infoEl)  infoEl.textContent = `Page ${_activityPage} of ${_activityPages}`;
    if (prevBtn) prevBtn.disabled   = _activityPage <= 1;
    if (nextBtn) nextBtn.disabled   = _activityPage >= _activityPages;
}

function activityPage(dir) {
    const next = _activityPage + dir;
    if (next < 1 || next > _activityPages) return;
    _activityPage = next;
    loadActivity();
}


const MAINT_CATEGORY_ICONS = {
    plumbing: ICON('water',14), electrical: ICON('bolt',14), structural: ICON('wall',14),
    appliance: ICON('plug',14), pest: ICON('bug',14), other: ICON('maintenance',14)
};

function renderMaintenanceTable(requests) {
    const tbody = document.getElementById('maintenanceTable');
    if (!tbody) return;

    if (!requests.length) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><span class="icon">${ICON('maintenance',26)}</span>No maintenance requests</div></td></tr>`;
        return;
    }

    const statusPill = {
        reported:    `<span class="pill pill-red" style="display:inline-flex;align-items:center;gap:3px">${ICON('sparkle',10)} Reported</span>`,
        in_progress: `<span class="pill pill-yellow" style="display:inline-flex;align-items:center;gap:3px">${ICON('hourglass',10)} In Progress</span>`,
        completed:   `<span class="pill pill-green" style="display:inline-flex;align-items:center;gap:3px">${ICON('check',10)} Completed</span>`
    };
    const priorityPill = {
        low:    '<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)">Low</span>',
        medium: '<span class="pill pill-yellow">Medium</span>',
        high:   '<span class="pill pill-red">High</span>'
    };

    const canManage = !isCaretaker() || (getCaretakerPermissions() || {}).canManageMaintenance;

    tbody.innerHTML = requests.map(r => `
        <tr>
            <td><strong style="color:var(--text)">${r.tenant?.name || '—'}</strong></td>
            <td class="td-mono">${r.house?.name || '—'}</td>
            <td style="display:flex;align-items:center;gap:6px">${MAINT_CATEGORY_ICONS[r.category] || ICON('maintenance',14)} ${r.category}</td>
            <td>${priorityPill[r.priority] || r.priority}</td>
            <td style="font-size:0.75rem;color:var(--text-dim);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${r.description.replace(/"/g,'&quot;')}">${r.description}</td>
            <td>${statusPill[r.status] || r.status}</td>
            <td class="td-mono" style="font-size:0.65rem;color:var(--text-dim)">${_timeAgo(r.createdAt)}</td>
            <td>${canManage
                ? `<button class="btn btn-secondary btn-sm" onclick="openMaintenanceUpdateModal('${r._id}', '${(r.tenant?.name || 'Tenant').replace(/'/g,"\\'")}', '${r.status}', ${r.cost ?? 'null'}, '${(r.resolutionNote || '').replace(/'/g,"\\'")}')">Update</button>`
                : `<button class="btn btn-secondary btn-sm" disabled title="You do not have permission to update repair requests" style="opacity:0.5;cursor:not-allowed">${ICON('lock',14)}</button>`}</td>
        </tr>`).join('');
}



function openMaintenanceUpdateModal(id, tenantName, status, cost, note) {
    document.getElementById('maintUpdateId').value = id;
    document.getElementById('maintUpdateTenantName').textContent = `Request from: ${tenantName}`;
    document.getElementById('maintUpdateStatus').value = status;
    document.getElementById('maintUpdateCost').value = cost ?? '';
    document.getElementById('maintUpdateNote').value = note || '';
    openModal('modal-maintenance-update');
}

// ═══════════════════════════════════════
// DASHBOARD — OPEN REPAIR REQUESTS ALERT
// ═══════════════════════════════════════

function _daysAgo(date) {
    const ms = Date.now() - new Date(date).getTime();
    return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function _renderMaintenanceAlertCard() {
    const card  = document.getElementById('maintenanceAlertCard');
    const list  = document.getElementById('maintAlertList');
    const count = document.getElementById('maintAlertCount');
    if (!card || !list || !count) return;

    const open = (typeof _allMaintenanceRequests !== 'undefined' ? _allMaintenanceRequests : [])
        .filter(r => r.status !== 'completed')
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    if (!open.length) {
        card.style.display = 'none';
        return;
    }

    const isUrgent = _daysAgo(open[0].createdAt) >= 3;

    card.style.borderLeftColor = isUrgent ? 'var(--danger)' : 'var(--warn)';
    count.className   = `pill ${isUrgent ? 'pill-red' : 'pill-yellow'}`;
    count.textContent = open.length;

    list.innerHTML = open.slice(0, 3).map(r => {
        const age      = _daysAgo(r.createdAt);
        const ageColor = age >= 3 ? 'var(--danger)' : 'var(--text-dim)';
        return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;padding:0.5rem 0.65rem;background:var(--bg3);border:1px solid var(--border);border-radius:7px;cursor:pointer"
                 onclick="showSection('maintenance')">
                <div style="min-width:0">
                    <div style="font-size:0.8rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:5px">
                        ${MAINT_CATEGORY_ICONS[r.category] || ICON('maintenance',14)} ${r.tenant?.name || 'Tenant'} — ${r.category}
                    </div>
                    <div style="font-size:0.68rem;color:var(--text-dim)">${r.house?.name || '—'} · ${r.status === 'in_progress' ? 'In progress' : 'Reported'}</div>
                </div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:${ageColor};flex-shrink:0">${age === 0 ? 'today' : age + 'd ago'}</div>
            </div>`;
    }).join('') + (open.length > 3 ? `<div style="text-align:center;font-size:0.68rem;color:var(--text-dim);padding-top:0.25rem">+${open.length - 3} more</div>` : '');
    card.style.display = 'block';
}

// ═══════════════════════════════════════
// RULES
// ═══════════════════════════════════════

function renderRules(rules) {
    const el = document.getElementById('rulesList');

    if (!rules.length) {
        el.innerHTML = `<div class="empty-state"><span class="icon">${ICON('rules',26)}</span>No rules yet</div>`;
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
            <button class="btn btn-danger btn-sm" onclick="deleteRule('${r._id}')" style="flex-shrink:0">${ICON('trash',14)}</button>
        </div>`).join('');
}

// ═══════════════════════════════════════
// CARETAKERS — rendering
// ═══════════════════════════════════════

function renderCaretakersList(caretakers) {
    const el = document.getElementById('caretakersList');
    if (!el) return;

    if (!caretakers.length) {
        el.innerHTML = `<div class="empty-state"><span class="icon">${ICON('hardhat',26)}</span>No caretakers yet</div>`;
        return;
    }

    el.innerHTML = caretakers.map(c => {
        const propNames = (c.properties || []).map(p => p.name || 'Property').join(', ') || 'None assigned';
        const perms      = c.caretakerPermissions || {};
              const permLabels = [
            perms.canManageTenants     ? 'Tenants'       : null,
            perms.canRecordPayments    ? 'Payments'      : null,
            perms.canManageMaintenance ? 'Maintenance'   : null,
            perms.canMessageTenants    ? 'Messages'      : null,
            perms.canPostAnnouncements ? 'Announcements' : null
        ].filter(Boolean);

        return `
            <div style="padding:0.85rem 0;border-bottom:1px solid var(--border)">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;margin-bottom:0.35rem">
                    <div style="font-size:0.85rem;font-weight:600;color:var(--text)">${c.name}</div>
                    <div style="display:flex;gap:0.4rem;flex-shrink:0">
                        <button class="btn btn-secondary btn-sm" onclick="openEditCaretakerModal('${c._id}')">${ICON('edit',14)}</button>
                        <button class="btn btn-danger btn-sm" onclick="revokeCaretaker('${c._id}', '${c.name.replace(/'/g, "\\'")}')">${ICON('trash',14)}</button>
                    </div>
                </div>
                <div style="font-size:0.68rem;color:var(--text-dim);font-family:'JetBrains Mono',monospace;margin-bottom:0.4rem">${c.email} &middot; ${c.phone || '&mdash;'}</div>
                <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:0.4rem">${ICON('properties',12)} ${propNames}</div>
                <div style="display:flex;gap:0.35rem;flex-wrap:wrap">
                    ${permLabels.length
                        ? permLabels.map(l => `<span class="pill pill-green">${l}</span>`).join('')
                        : '<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)">No permissions granted</span>'}
                </div>
            </div>`;
    }).join('');
}

// ═══════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════

function renderAnnouncements(data) {
    const el = document.getElementById('announcementList');

    if (!data.length) {
        el.innerHTML = `<div class="empty-state"><span class="icon">${ICON('announcements',26)}</span>No announcements yet</div>`;
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
            <button class="btn btn-danger btn-sm" onclick="deleteAnnouncement('${a._id}')" style="flex-shrink:0">${ICON('trash',14)}</button>
        </div>`).join('');
}

 
const GROUP_COLOR_PALETTE = [
    '#60a5fa', // blue
    '#c084fc', // purple
    '#fb923c', // orange
    '#22d3ee', // cyan
    '#f472b6', // pink
    '#facc15', // yellow
    '#818cf8', // indigo
    '#94a3b8'  // slate
];
 
// Darker tones on the White theme so building colours keep their contrast.
const GROUP_COLOR_PALETTE_LIGHT = ['#1d5fd6', '#7c3aed', '#c2570c', '#0e7490', '#be185d', '#a16207', '#4338ca', '#475569'];
function _groupColor(colorIndex) {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    const pal = light ? GROUP_COLOR_PALETTE_LIGHT : GROUP_COLOR_PALETTE;
    return pal[(colorIndex || 0) % pal.length];
}

// ═══════════════════════════════════════
// BULK HOUSE GENERATOR
// ═══════════════════════════════════════

let _genMode   = 'simple';
let _genGroups = [];
// Set ONLY when the generator is opened from a building (Building → Add Houses). The building is then
// attached for the whole session: no building dropdown, every request carries its id. null = the
// original generator (properties without buildings, or a brand-new building per naming group).
let _genBuilding = null;

function _newGenGroup() {
    return { label: '', prefix: '', start: 1, count: 1, padWidth: 0 };
}

 
let _genExtendGroups = [];   // cached list from GET /houses/groups

// ── Building-linked generator ──
function _seedGenGroupFromBuilding() {
    const b = _genBuilding;
    return { label: b.label || '', prefix: b.prefix || '', start: b.nextSeq || 1, count: 1, padWidth: b.padWidth || 0 };
}

// Clears the building context (and anything pre-filled from it) — used by the global opener.
function _resetGenBuildingContext() {
    if (!_genBuilding) return;
    _genBuilding = null;
    const cyc  = document.getElementById('genHouseBillingCycle'); if (cyc)  cyc.value  = 'monthly';
    const rent = document.getElementById('genHouseRent');         if (rent) rent.value = '';
    const nm   = document.getElementById('genSingleName');        if (nm)   nm.value   = '';
}

// Shows/hides everything that depends on whether a building is attached.
function _applyGenBuildingContext() {
    const b = _genBuilding;
    const banner = document.getElementById('genBuildingBanner');
    if (banner) {
        if (b) {
            const prop = (_propertiesCache || []).find(p => p._id === getPropertyId());
            banner.style.display = 'block';
            banner.innerHTML = `${ICON('houses', 13)} Adding to <strong style="color:var(--text)">${_escHtmlRef(b.label || b.prefix || 'Building')}</strong>${prop ? ` · ${_escHtmlRef(prop.name)}` : ''}<br>
                ${b.count} house${b.count === 1 ? '' : 's'} so far · next free number: <strong style="color:var(--text)">${_escHtmlRef(b.nextName)}</strong>`;
        } else {
            banner.style.display = 'none';
            banner.innerHTML = '';
        }
    }
    const singleBtn = document.getElementById('genModeSingleBtn');
    const simpleBtn = document.getElementById('genModeSimpleBtn');
    const advBtn    = document.getElementById('genModeAdvBtn');
    const extendBtn = document.getElementById('genModeExtendBtn');
    if (singleBtn) singleBtn.style.display = b ? '' : 'none';
    if (advBtn)    advBtn.style.display    = b ? 'none' : '';        // Per-Floor creates NEW buildings
    if (simpleBtn) simpleBtn.textContent   = b ? 'Multiple Houses' : 'Simple';
    if (extendBtn) extendBtn.textContent   = b ? 'Extend Rooms'    : 'Extend Group';

    const title = document.getElementById('genHousesModalTitle');
    if (title) title.innerHTML = b ? `${ICON('houses', 16)} Add Houses` : `${ICON('flash', 16)} Generate Multiple Units`;

    // The building that was clicked replaces the "Which group?" dropdown
    const grpLabel = document.getElementById('genExtendGroupLabel');
    const grpSel   = document.getElementById('genExtendGroupSelect');
    if (grpLabel) grpLabel.style.display = b ? 'none' : '';
    if (grpSel)   grpSel.style.display   = b ? 'none' : '';

    const hint = document.getElementById('genSingleHint');
    if (hint) hint.textContent = b ? `Next free number in this building: ${b.nextName}` : '';
}

// Entry point: Property → Building → Add Houses. The building is already known, so the landlord is never
// asked to pick it again.
async function openGenerateHousesForBuilding(buildingId) {
    if (isCaretaker()) { showToast('Only landlords can add houses', 'warn'); return; }
    if (!getPropertyId()) { showToast('No active property selected', 'warn'); return; }

    await loadGenExtendGroups({ silent: true });          // fresh counts / next number for this building
    const b = (_genExtendGroups || []).find(g => String(g._id) === String(buildingId));
    if (!b) { showToast('Could not load this building — refresh and try again', 'error'); return; }

    openModal('modal-generate-houses');                   // (the opener clears any previous context)
    const modal = document.getElementById('modal-generate-houses');
    if (!modal || !modal.classList.contains('open')) return;   // e.g. the product tour is running

    _genBuilding = {
        id: b._id, label: b.label || '', prefix: b.prefix || '', padWidth: b.padWidth || 0,
        count: b.count || 0, nextSeq: b.nextSeq || 1, nextName: b.nextName || '',
        billingCycle: b.billingCycle || 'monthly', rent: b.rent
    };

    // A building that already has houses keeps its billing cycle and rent as the starting point
    const cyc  = document.getElementById('genHouseBillingCycle');
    const rent = document.getElementById('genHouseRent');
    if (cyc)  cyc.value  = _genBuilding.count > 0 ? _genBuilding.billingCycle : 'monthly';
    if (rent) rent.value = (_genBuilding.count > 0 && _genBuilding.rent) ? _genBuilding.rent : '';
    const nm = document.getElementById('genSingleName'); if (nm) nm.value = '';

    setGenMode('single');
}
 
function setGenMode(mode) {
    _genMode = mode;

    const _singleBtn = document.getElementById('genModeSingleBtn');
    if (_singleBtn) _singleBtn.className = `btn btn-sm ${mode === 'single' ? 'btn-primary' : 'btn-secondary'}`;
    document.getElementById('genModeSimpleBtn').className =
        `btn btn-sm ${mode === 'simple' ? 'btn-primary' : 'btn-secondary'}`;
    document.getElementById('genModeAdvBtn').className =
        `btn btn-sm ${mode === 'advanced' ? 'btn-primary' : 'btn-secondary'}`;
    document.getElementById('genModeExtendBtn').className =
        `btn btn-sm ${mode === 'extend' ? 'btn-primary' : 'btn-secondary'}`;

    document.getElementById('genAddGroupBtn').style.display = mode === 'advanced' ? 'block' : 'none';
    document.getElementById('genGroupsWrap').style.display  = (mode === 'extend' || mode === 'single') ? 'none' : 'block';
    document.getElementById('genExtendWrap').style.display  = mode === 'extend' ? 'block' : 'none';
    const _singleWrap = document.getElementById('genSingleWrap');
    if (_singleWrap) _singleWrap.style.display = mode === 'single' ? 'block' : 'none';
    document.getElementById('genBuildingNameWrap').style.display = mode === 'advanced' ? 'block' : 'none';

    // Extend mode inherits the target group's existing billing cycle
    // server-side unless explicitly overridden — hide the field so a
    // forgotten default of "Monthly" can't silently flip a semester group.
    const cycleWrap = document.getElementById('genBillingCycleWrap');
    const cycleHint = document.getElementById('genBillingCycleHint');
    if (cycleWrap) cycleWrap.style.display = mode === 'extend' ? 'none' : 'block';
    if (cycleHint) cycleHint.style.display = mode === 'extend' ? 'block' : 'none';

    const rentField = document.getElementById('genHouseRent');
    if (rentField) {
        rentField.placeholder = mode === 'extend'
            ? 'Leave blank to match this building\'s existing rent'
            : 'e.g. 8000';
    }

    _applyGenBuildingContext();

    loadGenExtendGroups({ silent: mode !== 'extend' });

    if (mode !== 'extend') {
        _genGroups = [(_genBuilding && mode === 'simple') ? _seedGenGroupFromBuilding() : _newGenGroup()];
        renderGenGroups();
        onGenBillingCycleChange();
    } else {
        document.getElementById('genMonthlyRentWrap').style.display = 'block';
        document.getElementById('genSemesterRentBox').style.display = 'none';
    }
}
function addGenGroup() {
    _genGroups.push(_newGenGroup());
    renderGenGroups();
}

function removeGenGroup(idx) {
    _genGroups.splice(idx, 1);
    if (!_genGroups.length) _genGroups.push(_newGenGroup());
    renderGenGroups();
}

function updateGenGroup(idx, field, value) {
    _genGroups[idx][field] = field === 'prefix' || field === 'label' ? value : Number(value);
    _renderGenPreview();
    if (field === 'prefix') _checkGenPrefixReuse();
}

function _checkGenPrefixReuse() {
    if (_genMode === 'extend' || _genBuilding) return; // Extend / a building-linked generator already target one specific building

    _genGroups.forEach((g, i) => {
        const el = document.getElementById(`genReuseWarning-${i}`);
        if (!el) return;

        const prefixTrim = (g.prefix || '').trim().toLowerCase();
        if (!prefixTrim) { el.style.display = 'none'; el.innerHTML = ''; return; }

        const match = (_genExtendGroups || []).find(eg => (eg.prefix || '').trim().toLowerCase() === prefixTrim);
        if (!match) { el.style.display = 'none'; el.innerHTML = ''; return; }

        el.style.display = 'block';
        el.style.cssText = 'display:block;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:6px;padding:0.55rem 0.75rem;font-size:0.68rem;color:var(--warn);line-height:1.65';
        el.innerHTML = `
            ${ICON('warning',12)} Prefix "<strong>${g.prefix}</strong>" is already used by
            <strong>${match.label || match.prefix}</strong> (${match.count} unit(s), next: ${match.nextName}).
            Generating here won't overwrite anything, but the numbering will belong to two separate buildings.
            <button type="button" class="btn btn-secondary btn-sm" style="margin-top:0.4rem;display:block"
                    onclick="_switchToExtendGroup('${match._id}')">Extend "${match.label || match.prefix}" instead</button>`;
    });
}

function _switchToExtendGroup(groupId) {
    setGenMode('extend');
    setTimeout(() => {
        const sel = document.getElementById('genExtendGroupSelect');
        if (sel) { sel.value = groupId; onGenExtendGroupChange(); }
    }, 60); // wait for loadGenExtendGroups (triggered by setGenMode) to finish populating the dropdown
}

function renderGenGroups() {
    const wrap = document.getElementById('genGroupsWrap');
    if (!wrap) return;

    // Attached building: its name is fixed, and if it already has houses its prefix/padding are too,
    // so the numbering (and a later "Extend") stays consistent.
    const lockNames = !!_genBuilding && Number(_genBuilding.count) > 0;
    const lockAttr  = lockNames ? 'readonly title="This building already has houses, so its numbering style is kept"' : '';

    wrap.innerHTML = _genGroups.map((g, i) => `
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:0.85rem;margin-bottom:0.65rem">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
                ${_genBuilding
                    ? `<div style="font-weight:600;font-size:0.85rem;color:var(--text);flex:1">${_escHtmlRef(g.label)}</div>`
                    : `<input type="text"
                       placeholder="${_genMode === 'advanced' ? 'Floor label (e.g. Floor 1, Ground Floor, Podium) *' : 'Building / block name (e.g. Sunrise Tower, Annex Block) *'}"
                       value="${g.label}"
                       oninput="updateGenGroup(${i}, 'label', this.value)" style="margin:0;flex:1">`}
                 ${_genMode === 'advanced' && _genGroups.length > 1 ? `<button class="btn btn-danger btn-sm" style="margin-left:0.5rem" onclick="removeGenGroup(${i})">${ICON('close',12)}</button>` : ''}
            </div>
            <div id="genReuseWarning-${i}" style="display:none;margin-bottom:0.6rem"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
                <div>
                    <label class="pay-setup-label">Prefix</label>
                    <input type="text" placeholder="e.g. A or 1" value="${g.prefix}" ${lockAttr}
                           oninput="updateGenGroup(${i}, 'prefix', this.value)" style="margin-bottom:0.5rem">
                </div>
                <div>
                    <label class="pay-setup-label">Start Number</label>
                    <input type="number" value="${g.start}" min="0"
                           oninput="updateGenGroup(${i}, 'start', this.value)" style="margin-bottom:0.5rem">
                </div>
                <div>
                    <label class="pay-setup-label">Number of Units</label>
                    <input type="number" value="${g.count}" min="1" max="500"
                           oninput="updateGenGroup(${i}, 'count', this.value)" style="margin-bottom:0">
                </div>
                <div>
                    <label class="pay-setup-label">Zero-Pad Width (0 = none)</label>
                    <input type="number" value="${g.padWidth}" min="0" max="4" ${lockAttr}
                           oninput="updateGenGroup(${i}, 'padWidth', this.value)" style="margin-bottom:0">
                </div>
            </div>
        </div>`).join('');

    _renderGenPreview();
    _checkGenPrefixReuse();
}
 
async function loadGenExtendGroups(opts = {}) {
    const { silent = false } = opts;
    const sel = document.getElementById('genExtendGroupSelect');
    if (sel && !silent) sel.innerHTML = `<option value="">Loading groups…</option>`;

    try {
        const propertyId = getPropertyId();
        const res  = await fetch(`${API}/houses/groups?propertyId=${propertyId}`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) { if (!silent) showToast(data.message || 'Failed to load groups', 'error'); return; }

        _genExtendGroups = data.groups || [];

        if (!_genExtendGroups.length) {
            if (sel && !silent) sel.innerHTML = `<option value="">No existing groups — use Simple or Per-Floor instead</option>`;
            if (!silent) _renderGenPreview();
            _checkGenPrefixReuse();
            return;
        }

        if (sel && !silent) {
            sel.innerHTML = _genExtendGroups.map(g =>
                `<option value="${g._id}">${g.label || g.prefix || 'Group'} — ${g.count} unit(s), next: ${g.nextName}</option>`
            ).join('');
            if (_genBuilding) sel.value = _genBuilding.id;   // the building that was clicked, not a choice
        }
        if (!silent) onGenExtendGroupChange();
        _checkGenPrefixReuse();

    } catch (err) {
        if (sel && !silent) sel.innerHTML = `<option value="">Failed to load — try again</option>`;
        console.error('loadGenExtendGroups error:', err);
    }
}
 
function onGenExtendGroupChange() {
    const group = _selectedExtendGroup();
    const monthlyWrap = document.getElementById('genMonthlyRentWrap');
    const semesterBox = document.getElementById('genSemesterRentBox');

    if (group && group.billingCycle === 'semester') {
        if (monthlyWrap) monthlyWrap.style.display = 'none';
        if (semesterBox) {
            semesterBox.style.display = 'block';
            semesterBox.innerHTML = _semesterRentBoxHtml(_currentGenPropertySemesterRent(), '');
        }
    } else {
        if (monthlyWrap) monthlyWrap.style.display = 'block';
        if (semesterBox) semesterBox.style.display = 'none';
    }
    _renderGenPreview();
}
 
function _selectedExtendGroup() {
    const sel = document.getElementById('genExtendGroupSelect');
    const id  = sel ? sel.value : '';
    return _genExtendGroups.find(g => g._id === id) || null;
}
 
// Mirrors server.js's generateHouseNames() exactly — preview must never
// show something the backend would reject or generate differently.
function _computeGenNames() {
    const names = [];
    for (const g of _genGroups) {
        const count = Number(g.count) || 0;
        if (count <= 0) continue;
        for (let i = 0; i < count; i++) {
            const num    = (Number(g.start) || 0) + i;
            const numStr = g.padWidth > 0 ? String(num).padStart(g.padWidth, '0') : String(num);
            names.push(`${g.prefix || ''}${numStr}`);
        }
    }
    return names;
}
function _buildingNamePrefix() {
    if (_genMode !== 'advanced') return '';
    return (document.getElementById('genBuildingName')?.value || '').trim();
}

// Single source of truth for the label each group actually gets saved
// with — combines the shared Building Name (Advanced mode only) with
// each row's own Floor label, so "Sunrise Tower" + "Floor 1" / "Floor 2"
// become two distinct, self-identifying groups instead of one blob.
function _finalGenFloors() {
    const buildingName = _buildingNamePrefix();
    return _genGroups
        .filter(g => Number(g.count) > 0)
        .map(g => ({
            label:    buildingName ? `${buildingName} — ${g.label}`.trim() : g.label,
            prefix:   g.prefix,
            start:    g.start,
            count:    g.count,
            padWidth: g.padWidth
        }));
}


 
function _renderGenPreview() {
    const box     = document.getElementById('genPreviewBox');
    const countEl = document.getElementById('genPreviewCount');
    if (!box) return;

    if (_genMode === 'single') {
        const name = (document.getElementById('genSingleName')?.value || '').trim();
        box.textContent = name ? `${name}   (in ${_genBuilding ? (_genBuilding.label || 'this building') : 'this building'})` : 'Enter a house name to see a preview';
        if (countEl) countEl.textContent = name ? '1 unit' : '';
        _clearGenConflictWarning();
        return;
    }
 
    if (_genMode === 'extend') {
        const group = _selectedExtendGroup();
        const hintEl = document.getElementById('genExtendHint');
 
        if (!group) {
            box.textContent = 'Select a group above to see a preview';
            if (countEl) countEl.textContent = '';
            if (hintEl) hintEl.textContent = '';
            return;
        }
 
        const count = Number(document.getElementById('genExtendCount')?.value) || 0;
        if (count <= 0) {
            box.textContent = 'Enter how many units to add';
            if (countEl) countEl.textContent = '';
            if (hintEl) hintEl.textContent = `This group currently has ${group.count} unit(s), next available: ${group.nextName}`;
            return;
        }
 
        const names = [];
        for (let i = 0; i < count; i++) {
            const num    = group.nextSeq + i;
            const numStr = group.padWidth > 0 ? String(num).padStart(group.padWidth, '0') : String(num);
            names.push(`${group.prefix}${numStr}`);
        }
 
        if (countEl) countEl.textContent = `${names.length} new unit${names.length !== 1 ? 's' : ''}`;
        if (hintEl)  hintEl.textContent   = `Continuing from ${group.nextName} — this group will have ${group.count + names.length} unit(s) total`;
        box.textContent = names.join('   ');
        return;
    }
 
        // ── simple / advanced ──
    const names  = _computeGenNames();
    const unique = new Set(names);

    if (!names.length) {
        box.textContent = 'Fill in the fields above to see a preview';
        if (countEl) countEl.textContent = '';
        _clearGenConflictWarning();
        return;
    }

    if (countEl) countEl.textContent = `${names.length} unit${names.length !== 1 ? 's' : ''}`;

    if (unique.size !== names.length) {
        box.innerHTML = `<span style="color:var(--danger);display:inline-flex;align-items:center;gap:5px">${ICON('warning',14)} Duplicate names in this configuration — adjust prefixes or start numbers</span>`;
        _clearGenConflictWarning();
        return;
    }

    const shown = names.slice(0, 60);
    box.textContent = shown.join('   ') + (names.length > 60 ? `   … +${names.length - 60} more` : '');

    _debouncedGenConflictCheck();
}

let _genConflictCheckTimer = null;
function _debouncedGenConflictCheck() {
    clearTimeout(_genConflictCheckTimer);
    _genConflictCheckTimer = setTimeout(_runGenConflictCheck, 450);
}

function _clearGenConflictWarning() {
    const el = document.getElementById('genConflictWarning');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

async function _runGenConflictCheck() {
    if (_genMode === 'extend' || _genMode === 'single') return;
    const propertyId = getPropertyId();
    if (!propertyId) return;

    const config = { floors: _finalGenFloors() };
    if (!config.floors.length) return;

    try {
        const res  = await fetch(`${API}/houses/generate-preview`, {
            method: 'POST', headers: authHeaders(),
            body:   JSON.stringify({ config, propertyId })
        });
        const data = await res.json();
        if (!res.ok) return;

        const el = document.getElementById('genConflictWarning');
        if (!el) return;

        if (data.conflicts && data.conflicts.length) {
            const byGroup = {};
            data.conflicts.forEach(c => {
                byGroup[c.groupLabel] = byGroup[c.groupLabel] || [];
                byGroup[c.groupLabel].push(c.name);
            });
            const lines = Object.entries(byGroup).map(([label, ns]) =>
                `<strong>${label}</strong>: ${ns.slice(0, 8).join(', ')}${ns.length > 8 ? ` +${ns.length - 8} more` : ''}`
            ).join('<br>');

            el.style.cssText = 'display:block;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);border-radius:6px;padding:0.6rem 0.8rem;font-size:0.68rem;color:var(--danger);line-height:1.7;margin-top:0.6rem';
            el.innerHTML = `${ICON('warning',12)} ${data.conflicts.length} name(s) already exist in this property:<br>${lines}`;
        } else {
            el.style.display = 'none';
            el.innerHTML = '';
        }
    } catch (err) {
        console.error('_runGenConflictCheck error:', err);
    }
}


async function submitGenerateHouses() {
    const propertyId = getPropertyId();
    if (!propertyId) { showToast('No active property selected', 'warn'); return; }

    // ── Single house in the attached building (same endpoint and body as the Add New House form) ──
    if (_genMode === 'single') {
        if (!_genBuilding) { showToast('Open this from a building to add a single house', 'warn'); return; }

        const name = (document.getElementById('genSingleName')?.value || '').trim();
        if (!name) { showToast('House name required', 'warn'); return; }

        const billingCycle = document.getElementById('genHouseBillingCycle')?.value === 'semester' ? 'semester' : 'monthly';
        const body = { name, propertyId, billingCycle, groupId: _genBuilding.id };

        if (billingCycle === 'semester') {
            if (!_currentGenPropertySemesterRent()) {
                showToast('Set the semester rent amount for this property first (Properties → Semester & Deposit Rules)', 'warn');
                return;
            }
        } else {
            const rent = Number(document.getElementById('genHouseRent')?.value);
            if (!rent || rent <= 0) { showToast('Rent required', 'warn'); return; }
            body.rent = rent;
        }

        const btn = document.getElementById('genSubmitBtn');
        if (btn) btn.disabled = true;
        try {
            const res  = await fetch(`${API}/houses`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
            const data = await res.json();
            if (!res.ok) { showToast(data.message || 'Failed to add house', 'error'); return; }

            showToast(`House ${name} added `, 'success');
            closeModal('modal-generate-houses');
            await loadHouses();
        } catch (err) {
            showToast('Network error', 'error');
            console.error(err);
        } finally {
            if (btn) btn.disabled = false;
        }
        return;
    }
 
    if (_genMode === 'extend') {
        const group = _selectedExtendGroup();
        const count = Number(document.getElementById('genExtendCount')?.value);
        const rent  = Number(document.getElementById('genHouseRent')?.value) || undefined;
 
        if (!group)             { showToast('Select a group first', 'warn'); return; }
        if (!count || count <= 0) { showToast('Enter how many units to add', 'warn'); return; }
 
        openDangerModal({
            icon:    '⚡',
            title:   'Confirm Extend Group',
            message: `Add <strong>${count} unit(s)</strong> to <strong>${group.label || group.prefix}</strong>, continuing from <strong>${group.nextName}</strong>?`,
            label:   `Add ${count} Unit(s)`,
            type:    'warn',           
        
            onConfirm: async () => {
                try {
                    const res  = await fetch(`${API}/houses/extend-group`, {
                        method: 'POST', headers: authHeaders(),
                        body:   JSON.stringify({ propertyId, groupId: group._id, count, rent })
                    });
                    const data = await res.json();
                    if (!res.ok) {
                        if (data.conflicts && data.conflicts.length) {
                            const byGroup = {};
                            data.conflicts.forEach(c => { byGroup[c.groupLabel] = byGroup[c.groupLabel] || []; byGroup[c.groupLabel].push(c.name); });
                            const lines = Object.entries(byGroup).map(([label, ns]) => `${label}: ${ns.join(', ')}`).join(' | ');
                            showToast(`Names already exist — ${lines}`, 'error');
                        } else {
                            showToast(data.message || 'Failed to extend group', 'error');
                        }
                        return;
                    }

                    showToast(data.message, 'success');
                    closeModal('modal-generate-houses');
                    await loadHouses();
                } catch (err) {
                    showToast('Network error', 'error');
                    console.error(err);
                }
            }
        });
        return;
    }
 

      // ── simple / advanced ──
    const missingLabel = _genGroups.some(g => Number(g.count) > 0 && !(g.label || '').trim());
    if (missingLabel) { showToast('Give this building/block a name before generating', 'warn'); return; }

    const billingCycle = document.getElementById('genHouseBillingCycle')?.value === 'semester' ? 'semester' : 'monthly';

    let rent;
    if (billingCycle === 'semester') {
        rent = _currentGenPropertySemesterRent();
        if (!rent || rent <= 0) {
            showToast('Set the semester rent amount for this property first (Properties → Semester & Deposit Rules)', 'warn');
            return;
        }
    } else {
        rent = Number(document.getElementById('genHouseRent')?.value);
        if (!rent || rent <= 0) { showToast('Enter a valid rent amount', 'warn'); return; }
    }

    const names = _computeGenNames();
    if (!names.length) { showToast('No units to generate — check your configuration', 'warn'); return; }
    if (new Set(names).size !== names.length) { showToast('Fix duplicate names before generating', 'warn'); return; }

    const config = { floors: _finalGenFloors() };

    openDangerModal({
        icon:    ICON('flash', 44),
        title:   'Confirm Generate Units',
        message: `Generate <strong>${names.length} unit(s)</strong>${_genBuilding ? ` in <strong>${_escHtmlRef(_genBuilding.label || 'this building')}</strong>` : ''} at <strong>Ksh ${Number(rent).toLocaleString()}</strong> ${billingCycle === 'semester' ? '/ Sem' : '/ mo'} each?`,
        label:   `Generate ${names.length} Unit(s)`,
        type:    'warn',

        onConfirm: async () => {
            try {
                const res  = await fetch(`${API}/houses/generate`, {
                    method: 'POST', headers: authHeaders(),
                    body:   JSON.stringify({ propertyId, rent, billingCycle, config, ...(_genBuilding && { groupId: _genBuilding.id }) })
                });
                const data = await res.json();
                if (!res.ok) {
                    if (data.conflicts && data.conflicts.length) {
                        const byGroup = {};
                        data.conflicts.forEach(c => { byGroup[c.groupLabel] = byGroup[c.groupLabel] || []; byGroup[c.groupLabel].push(c.name); });
                        const lines = Object.entries(byGroup).map(([label, ns]) => `${label}: ${ns.join(', ')}`).join(' | ');
                        showToast(`Names already exist — ${lines}`, 'error');
                    } else {
                        showToast(data.message || 'Generation failed', 'error');
                    }
                    return;
                }
                showToast(data.message, 'success');
                closeModal('modal-generate-houses');
                await loadHouses();
            } catch (err) {
                showToast('Network error', 'error');
                console.error(err);
            }
        }
    });
}

function _currentGenPropertySemesterRent() {
    const prop = _propertiesCache.find(p => p._id === getPropertyId());
    return Number(prop?.semesterRule?.rentAmount || 0);
}

const _MONTH_LABELS = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function _monthLabel(n) { return _MONTH_LABELS[Number(n)] || ''; }

function _semesterRentBoxHtml(rent, window) {
    return rent > 0
        ? `${ICON('cash',14)} Semester rent: <strong style="color:var(--accent)">Ksh ${rent.toLocaleString()}</strong>${window} — set at the property level.`
        : `${ICON('warning',14)} No semester rent amount set for this property yet.
           <button type="button" class="btn btn-secondary btn-sm" style="margin-top:0.5rem;display:block"
                   onclick="closeModal('modal-generate-houses');openPropertySettingsModal('${getPropertyId()}')">
             Set Semester Rent
           </button>`;
}

function onGenBillingCycleChange() {
    const cycle = document.getElementById('genHouseBillingCycle')?.value || 'monthly';
    const monthlyWrap = document.getElementById('genMonthlyRentWrap');
    const semesterBox = document.getElementById('genSemesterRentBox');
    if (!monthlyWrap || !semesterBox) return;

    if (cycle === 'semester') {
        monthlyWrap.style.display = 'none';
        semesterBox.style.display = 'block';
        const prop = _propertiesCache.find(p => p._id === getPropertyId());
        const window = prop?.semesterRule?.enabled
            ? ` (${_monthLabel(prop.semesterRule.startMonth)}–${_monthLabel(prop.semesterRule.endMonth)})`
            : '';
        semesterBox.innerHTML = _semesterRentBoxHtml(_currentGenPropertySemesterRent(), window);
    } else {
        monthlyWrap.style.display = 'block';
        semesterBox.style.display = 'none';
    }
    _renderGenPreview();
}

function onHouseBillingCycleChange() {
    const cycle    = document.getElementById('houseBillingCycle')?.value || 'monthly';
    const rentWrap = document.getElementById('houseRentWrap');
    const semBox   = document.getElementById('houseSemesterRentBox');
    if (!rentWrap || !semBox) return;

    if (cycle === 'semester') {
        rentWrap.style.display = 'none';
        semBox.style.display = 'block';
        const semRent = _currentGenPropertySemesterRent();
        semBox.innerHTML = semRent > 0
            ? `${ICON('cash',14)} Uses this property's semester rent: <strong style="color:var(--accent)">Ksh ${semRent.toLocaleString()}</strong>`
            : `${ICON('warning',14)} No semester rent set — <a href="#" onclick="openPropertySettingsModal('${getPropertyId()}');return false" style="color:var(--accent)">set it here</a> first.`;
    } else {
        rentWrap.style.display = 'block';
        semBox.style.display = 'none';
    }
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
        const preview   = _msgPreviewMap[t._id] || (t.house?.name ? `${ICON('houses',11)} ${t.house.name}` : '');
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

    const canMessage = !isCaretaker() || (getCaretakerPermissions() || {}).canMessageTenants;
    document.getElementById('msgChatFooter').style.display   = canMessage ? 'flex' : 'none';

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
                    ${isLandlord ? `${ICON('key',10)} You` : `${ICON('user',10)} Tenant`} ·
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
    const perm = _paymentType === 'refund' ? null : 'canRecordPayments';
    if (perm && !_checkCaretakerPermission(perm, 'record payments')) return;
    if (_paymentType === 'refund' && isCaretaker()) { showToast('Only landlords can record refunds', 'warn'); return; }

    const tenantId = document.getElementById('payTenantSelect').value;
    const amount   = document.getElementById('amount').value;
    const month    = document.getElementById('month').value.trim();
    const method   = document.getElementById('payMethod').value;
    const note     = document.getElementById('payNote').value.trim();

    if (!tenantId || !amount) { showToast('Tenant and amount are required', 'warn'); return; }
    if (_paymentType === 'rent' && !month) { showToast('Month is required for rent', 'warn'); return; }

    const tenant = _allTenants.find(t => t._id === tenantId);
    const name   = tenant ? tenant.name : 'Tenant';

    _showPayConfirm({
        tenantId, tenantName: name, amount: Number(amount),
        month, method, note, source: 'inline', category: _paymentType
    });
}

function openPayConfirmModal() {
    const perm = _modalPaymentType === 'refund' ? null : 'canRecordPayments';
    if (perm && !_checkCaretakerPermission(perm, 'record payments')) return;
    if (_modalPaymentType === 'refund' && isCaretaker()) { showToast('Only landlords can record refunds', 'warn'); return; }

    const tenantId = document.getElementById('payModalTenantId').value;
    const amount   = document.getElementById('payModalAmount').value;
    const month    = document.getElementById('payModalMonth').value.trim();
    const method   = document.getElementById('payModalMethod').value;
    const note     = document.getElementById('payModalNote').value.trim();

    if (!amount) { showToast('Enter an amount', 'warn'); return; }
    if (_modalPaymentType === 'rent' && !month) { showToast('Month is required for rent', 'warn'); return; }

    const tenantNameEl = document.getElementById('payModalTenantName');
    const tenantName   = tenantNameEl
        ? tenantNameEl.textContent.replace('Paying for: ', '')
        : 'Tenant';

    _showPayConfirm({
        tenantId, tenantName, amount: Number(amount),
        month, method, note, source: 'modal', category: _modalPaymentType
    });
}

let _pendingPayment = null;

function _showPayConfirm({ tenantId, tenantName, amount, month, method, note, source, category = 'rent' }) {
    _pendingPayment = { tenantId, amount, month, method, note, source, category };

    const methodLabel   = { cash: 'Cash', mpesa: 'M-Pesa (manual)', bank: 'Bank Transfer', other: 'Other' };
    const categoryLabel = { rent: 'Rent Payment', deposit: 'Deposit', refund: 'Refund' };

    document.getElementById('payConfirmDetails').innerHTML = `
        <div class="pay-confirm-row">
            <span>Type</span>
            <span>${categoryLabel[category]}</span>
        </div>
        <div class="pay-confirm-row">
            <span>Tenant</span>
            <span>${tenantName}</span>
        </div>
        ${category === 'rent' ? `<div class="pay-confirm-row"><span>Month</span><span>${month}</span></div>` : ''}
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
    if (btn) { btn.disabled = true; btn.innerHTML = `${ICON('hourglass',14)} Recording...`; }

    const { tenantId, amount, month, method, note, source, category } = _pendingPayment;

    const endpointMap = { rent: '/payments', deposit: '/payments/deposit', refund: '/payments/refund' };
    const bodyMap = {
        rent:    { tenantId, amount, month, method, note },
        deposit: { tenantId, amount, method, note },
        refund:  { tenantId, amount, method, note }
    };
    const successMsg = {
        rent: 'Payment recorded & receipt emailed ',
        deposit: 'Deposit recorded ',
        refund: 'Refund recorded '
    };

    try {
        const res  = await fetch(`${API}${endpointMap[category] || '/payments'}`, {
            method: 'POST', headers: authHeaders(),
            body:   JSON.stringify(bodyMap[category] || bodyMap.rent)
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.message || 'Request failed', 'error');
            return;
        }

        showToast(successMsg[category] || 'Recorded ', 'success');

        closeModal('modal-pay-confirm');
        if (source === 'modal') closeModal('modal-pay');

        await loadTenants();
        if (category === 'rent') loadArrears();
        loadRecentActivity();
        loadDashboard();

        if (category === 'rent' && data.paymentId) {
            if (source === 'modal') { showSection('payments'); }
            loadAutoReceipt(data.paymentId);
        }

        if (source === 'inline' && category === 'rent') loadPaymentSummary();

        // Refresh the tenant profile panel so deposit pills update immediately
        if (document.getElementById('sec-tenants')?.classList.contains('active') && tenantId) {
            loadTenantProfile(tenantId);
        }

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    } finally {
        _pendingPayment = null;
        if (btn) { btn.disabled = false; btn.innerHTML = `${ICON('check',14)} Confirm &amp; Record`; }
    }
}


// ═══════════════════════════════════════
// CHARTS
// ═══════════════════════════════════════

let _financeChart, _occupancyChart;
let _lastChartData = null;

function renderCharts(data) {
    if (typeof Chart === 'undefined') {
        console.warn('Chart.js unavailable — skipping charts this load');
        return;
    }
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
            labels: ['Income', 'Arrears', 'Expenses'],
            datasets: [{
                data:            [data.totalIncome, data.totalArrears, data.totalExpenses || 0],
                backgroundColor: [accent + '33', danger + '33', warn + '33'],
                borderColor:     [accent, danger, warn],
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

    // occupancy chart unchanged below...
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
// INQUIRIES — Rendering
// ═══════════════════════════════════════

function _inqStatusPill(status) {
    const map = {
        new:       `<span class="pill" style="background:rgba(59,130,246,0.12);color:#60a5fa;border:1px solid rgba(59,130,246,0.25);display:inline-flex;align-items:center;gap:3px">${ICON('sparkle',10)} New</span>`,
        read:      `<span class="pill" style="background:var(--bg3);color:var(--text-muted);border:1px solid var(--border2);display:inline-flex;align-items:center;gap:3px">${ICON('eye',10)} Read</span>`,
        contacted: `<span class="pill pill-green" style="display:inline-flex;align-items:center;gap:3px">${ICON('phone',10)} Contacted</span>`,
        archived:  `<span class="pill" style="background:rgba(100,116,139,0.12);color:var(--text-dim);border:1px solid var(--border);display:inline-flex;align-items:center;gap:3px">${ICON('box',10)} Archived</span>`
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
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><span class="icon">${ICON('inquiries',26)}</span>${filterVal ? 'No inquiries match this filter' : 'No inquiries yet — they will appear here when prospective tenants contact you'}</div></td></tr>`;
        return;
    }

    tbody.innerHTML = inquiries.map(inq => {
        const msgPreview = (inq.message || '').slice(0, 55) + (inq.message?.length > 55 ? '…' : '');
        const propName   = inq.property?.name || '—';
        const ago        = _inqTimeAgo(inq.createdAt);

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
                onclick="openInquiryDetailById('${inq._id}')">
                View
              </button>
            </td>
        </tr>`;
    }).join('');
}

// ═══════════════════════════════════════
// REFER & EARN — progress bar + reward panel
// (data fetched by loadReferralData() in script.js; this only renders it)
// ═══════════════════════════════════════

function _escHtmlRef(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _fmtRefDate(d) {
    return d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : '';
}

function renderReferralProgress(data) {
    const required  = data.requiredCount   ?? 5;
    const qualified = data.qualifiedCount  ?? 0;
    const percent   = data.progressPercent ?? 0;
    const remaining = Math.max(0, required - qualified);
    const reward    = data.reward || null;

    const introEl = document.getElementById('referralRequiredInline');
    if (introEl) introEl.textContent = required;

    const labelEl = document.getElementById('referralProgressLabel');
    if (labelEl) labelEl.textContent = `You've referred ${qualified} / ${required} landlords.`;

    const pctEl = document.getElementById('referralProgressPercent');
    if (pctEl) pctEl.textContent = `${percent}%`;

    const barEl = document.getElementById('referralProgressBar');
    if (barEl) barEl.style.width = `${percent}%`;

    const remainingEl = document.getElementById('referralProgressRemaining');
    if (remainingEl) {
        remainingEl.textContent = reward
            ? '' // reward already earned — nothing left to count down
            : (remaining === 1
                ? '1 more qualified referral to unlock your reward.'
                : `${remaining} more qualified referrals to unlock your reward.`);
    }

    const panel = document.getElementById('referralRewardPanel');
    if (!panel) return;

    if (!reward) {
        panel.innerHTML = `A qualified referral is a new landlord who joins, finishes setting up a property, and processes their first payment. Reach ${required} and your next month becomes commission-free.`;
        return;
    }

    if (reward.status === 'scheduled') {
        panel.innerHTML = `
            <div style="color:var(--accent);font-weight:600;margin-bottom:0.35rem">🎉 Reward unlocked!</div>
            Your commission-free month starts <strong style="color:var(--text)">${_escHtmlRef(_fmtRefDate(reward.periodStart))}</strong>
            and runs through <strong style="color:var(--text)">${_escHtmlRef(_fmtRefDate(reward.periodEnd))}</strong>.
            No platform commission will be deducted from your qualifying rent transactions during that period.`;
    } else if (reward.status === 'active') {
        panel.innerHTML = `
            <div style="color:var(--accent);font-weight:600;margin-bottom:0.35rem">✅ Reward active — ${_escHtmlRef(reward.month)}</div>
            No platform commission is being deducted from your rent transactions this month. It resumes normally from
            ${_escHtmlRef(_fmtRefDate(new Date(new Date(reward.periodEnd).getTime() + 86400000)))}.`;
    } else {
        panel.innerHTML = `
            <div style="color:var(--text);font-weight:600;margin-bottom:0.35rem">Reward used — ${_escHtmlRef(reward.month)}</div>
            You've already redeemed your one-time referral reward. Thanks for growing Affordable Rentals!`;
    }
}

function openInquiryDetail(inq) {
    document.getElementById('inqDetailId').value         = inq._id;
    document.getElementById('inqDetailName').textContent = inq.name;
    document.getElementById('inqDetailMsg').textContent  = inq.message || '(no message)';
    document.getElementById('inqDetailNotes').value      = inq.notes  || '';

    const metaEl = document.getElementById('inqDetailMeta');
    const metaLines = [
        `${ICON('phone',12)} ${_escHtmlInq(inq.phone)}`,
        inq.email  ? `${ICON('mail',12)} ${_escHtmlInq(inq.email)}` : null,
        `${ICON('properties',12)} ${_escHtmlInq(inq.property?.name || '—')}${inq.property?.location ? ' · ' + inq.property.location : ''}`,
        `${ICON('clock',12)} ${new Date(inq.createdAt).toLocaleString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}`
    ].filter(Boolean);
    metaEl.innerHTML = metaLines.map(s => `<span style="display:inline-flex;align-items:center;gap:4px">${s}</span>`).join('');

    const actionsEl = document.getElementById('inqDetailActions');
    const transitions = [
        { val: 'read',      label: `${ICON('eye',14)} Mark as Read`,   cls: 'btn-secondary' },
        { val: 'contacted', label: `${ICON('phone',14)} Mark Contacted`, cls: 'btn-primary'   },
        { val: 'archived',  label: `${ICON('box',14)} Archive`,          cls: 'btn-secondary' },
        { val: 'new',       label: `${ICON('loop',14)} Reset to New`,    cls: 'btn-secondary' }
    ];
    actionsEl.innerHTML = transitions
        .filter(s => s.val !== inq.status)
        .map(s => `<button class="btn ${s.cls} btn-sm btn-full"
                     onclick="updateInquiryStatus('${inq._id}','${s.val}')">${s.label}</button>`)
        .join('');

    const waText = encodeURIComponent(`Hi ${inq.name}, thanks for your inquiry about ${inq.property?.name || 'our property'}!`);
    const waHref = `https://wa.me/${_formatPhoneInq(inq.phone)}?text=${waText}`;
    document.getElementById('inqDetailContact').innerHTML = `
        <a href="tel:${_escHtmlInq(inq.phone)}" class="btn btn-secondary btn-sm">${ICON('phone',14)} Call</a>
        <a href="${waHref}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">${ICON('messages',14)} WhatsApp</a>
        ${inq.email ? `<a href="mailto:${_escHtmlInq(inq.email)}" class="btn btn-secondary btn-sm">${ICON('mail',14)} Email</a>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteInquiry('${inq._id}')">${ICON('trash',14)} Delete</button>`;

    closeNotifDropdown();
    const detailModal = document.getElementById('modal-inquiry-detail');
    if (detailModal) detailModal.classList.add('open');

    if (inq.status === 'new') {
        updateInquiryStatus(inq._id, 'read', true);
    }
}

function openPropertySettingsModal(propertyId) {
    const prop = _propertiesCache.find(p => p._id === propertyId);
    if (!prop) { showToast('Property not found — try refreshing', 'error'); return; }

    document.getElementById('propSettingsModalTitle').innerHTML = `${ICON('edit',16)} Semester &amp; Deposit Rules — ${prop.name}`;
    document.getElementById('propSettingsCloseBtn').innerHTML = ICON('close', 16);
    document.getElementById('propSettingsSaveBtn').innerHTML = `${ICON('lock',14)} Save Rules`;
    document.getElementById('propSettingsPropertyId').value = propertyId;

    const rule   = prop.semesterRule  || {};
    const policy = prop.depositPolicy || {};

    document.getElementById('propSettingsSemesterEnabled').value    = rule.enabled ? 'true' : 'false';
    initSemesterEditor('propSettingsSemestersEditor', _semestersFromRule(rule));
    document.getElementById('propSettingsHoldingFee').value = rule.holdingFee || '';
    document.getElementById('propSettingsGapPolicy').value  = ['ask', 'auto', 'none'].includes(rule.gapPolicy) ? rule.gapPolicy : 'ask';
    document.getElementById('propSettingsMonthlyHoldingFee').value = prop.monthlyHoldingFee || '';
    document.getElementById('propSettingsSemesterRentAmount').value = rule.rentAmount || '';
    document.getElementById('propSettingsDueDay').value = rule.dueDay || 5;
    document.getElementById('propSettingsRequireDeposit').value     = policy.requireDepositBeforeAssignment === false ? 'false' : 'true';
    document.getElementById('propSettingsDepositAmount').value      = policy.depositAmount || '';

    _togglePropSettingsSemesterFields();
    openModal('modal-property-settings');
}

function _togglePropSettingsSemesterFields() {
    const enabled = document.getElementById('propSettingsSemesterEnabled')?.value === 'true';
    const wrap = document.getElementById('propSettingsSemesterFieldsWrap');
    if (wrap) wrap.style.display = enabled ? 'block' : 'none';
}



async function submitPropertySettings() {
    const propertyId = document.getElementById('propSettingsPropertyId').value;
    if (!propertyId) return;

        const semesterRule = {
            enabled:    document.getElementById('propSettingsSemesterEnabled').value === 'true',
            rentAmount: Number(document.getElementById('propSettingsSemesterRentAmount').value || 0),
            dueDay:     Math.min(28, Math.max(1, Number(document.getElementById('propSettingsDueDay').value) || 5)),
            holdingFee: Math.max(0, Number(document.getElementById('propSettingsHoldingFee').value) || 0),
            gapPolicy:  document.getElementById('propSettingsGapPolicy').value || 'ask',
            semesters:  collectSemesterEditor('propSettingsSemestersEditor')
        };

        if (semesterRule.enabled && (!semesterRule.rentAmount || semesterRule.rentAmount <= 0)) {
            showToast('Enter a semester rent amount before enabling semester billing', 'warn');
            return;
        }

    const depositPolicy = {
        requireDepositBeforeAssignment: document.getElementById('propSettingsRequireDeposit').value !== 'false',
        depositAmount: Math.max(0, Number(document.getElementById('propSettingsDepositAmount').value) || 0)
    };

    const btn = document.getElementById('propSettingsSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = `${ICON('hourglass',14)} Saving...`; }

    try {
        const res  = await fetch(`${API}/properties/${propertyId}`, {
            method: 'PUT', headers: authHeaders(),
            body: JSON.stringify({ semesterRule, depositPolicy, monthlyHoldingFee: Math.max(0, Number(document.getElementById('propSettingsMonthlyHoldingFee').value) || 0) })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to save rules', 'error'); return; }

        showToast('Rules saved ', 'success');
        closeModal('modal-property-settings');
        await loadProperties();
    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `${ICON('lock',14)} Save Rules`; }
    }
}

// ═══════════════════════════════════════
// LISTING CONTROLS — Property Editor
// ═══════════════════════════════════════

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
              <div class="modal-title">${ICON('edit',18)} Edit Public Listing</div>
              <button class="modal-close" onclick="closeModal('modal-listing-editor')">${ICON('close',16)}</button>
            </div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--accent);background:var(--accent-dim);border:1px solid rgba(110,231,183,0.2);border-radius:7px;padding:0.5rem 0.85rem;margin-bottom:0.75rem;display:flex;align-items:center;gap:6px"
                 id="listingEditorPropName"></div>
            <div id="listingEditorGuide" style="display:none;font-size:0.78rem;color:var(--text-muted);background:rgba(59,130,246,0.07);border:1px solid rgba(59,130,246,0.2);border-radius:7px;padding:0.65rem 0.85rem;margin-bottom:0.85rem;line-height:1.6">
              ${ICON('edit',14)} Before your property goes live, add a description and up to 5 photos so prospective tenants know what to expect.
            </div>
            <label style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);display:block;margin-bottom:0.4rem">
              Public Description <span style="color:var(--danger)">*</span>
            </label>
            <textarea id="listingEditorDesc" style="min-height:110px;resize:vertical;margin-bottom:0.4rem"
              placeholder="Describe this property — location highlights, amenities, nearby facilities, security, water availability…"></textarea>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--text-dim);margin-bottom:1.25rem;line-height:1.5">
              Appears on your public listing card. Keep it welcoming and informative.
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">
              <label style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim)">
                Photos <span id="listingEditorPhotoCount" style="color:var(--accent)"></span>
              </label>
              <span style="font-family:'JetBrains Mono',monospace;font-size:0.58rem;color:var(--text-dim)">Max 5 · JPG / PNG · 5 MB each</span>
            </div>
            <div id="listingEditorPhotos"
                 style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:0.5rem;margin-bottom:0.75rem;min-height:0">
            </div>
            <div id="listingEditorUploadWrap" style="margin-bottom:1.25rem">
              <label id="listingEditorUploadLabel"
                     style="display:flex;align-items:center;justify-content:center;gap:0.5rem;
                            border:1px dashed var(--border2);border-radius:8px;padding:0.75rem;
                            cursor:pointer;font-size:0.78rem;color:var(--text-muted);
                            transition:border-color 0.15s,color 0.15s;user-select:none"
                     onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
                     onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text-muted)'">
                <span style="display:flex">${ICON('camera',18)}</span>
                <span id="listingEditorUploadText">Add Photo</span>

                <input type="file" id="listingEditorFileInput" accept="image/*" multiple
                       style="display:none" onchange="handlePhotoUpload(event)">
              </label>
              <div id="listingEditorUploadProgress"
                   style="display:none;font-family:'JetBrains Mono',monospace;font-size:0.65rem;
                          color:var(--text-dim);text-align:center;margin-top:0.4rem;align-items:center;justify-content:center;gap:5px">
              </div>
            </div>
            <input type="hidden" id="listingEditorPropertyId">
            <input type="hidden" id="listingEditorPendingListed">
            <button class="btn btn-primary btn-full" id="listingEditorSaveBtn"
                    onclick="saveListingDescription()">${ICON('lock',14)} Save Description</button>
          </div>`;
        modal.addEventListener('click', e => { if (e.target === modal) closeModal('modal-listing-editor'); });
        document.body.appendChild(modal);
    }

    document.getElementById('listingEditorPropName').innerHTML   = `${ICON('properties',14)} ${prop.name}${prop.location ? `  ·  ${ICON('pin',12)} ${prop.location}` : ''}`;
    document.getElementById('listingEditorDesc').value             = prop.description || '';
    document.getElementById('listingEditorPropertyId').value       = propertyId;
    document.getElementById('listingEditorPendingListed').value    = pendingIsListed === true ? 'true' : '';

    const guide   = document.getElementById('listingEditorGuide');
    const saveBtn = document.getElementById('listingEditorSaveBtn');
    if (pendingIsListed === true) {
        guide.style.display = 'block';
        saveBtn.innerHTML = `${ICON('lock',14)} Save &amp; Make Visible`;
    } else {
        guide.style.display = 'none';
        saveBtn.innerHTML = `${ICON('lock',14)} Save Description`;
    }

    _renderListingEditorPhotos(prop.photos || [], propertyId);
    modal.classList.add('open');
}

function _renderListingEditorPhotos(photos, propertyId) {
    const grid      = document.getElementById('listingEditorPhotos');
    const countEl   = document.getElementById('listingEditorPhotoCount');
    const uploadWrap= document.getElementById('listingEditorUploadWrap');
    const uploadText= document.getElementById('listingEditorUploadText');
    if (!grid) return;

    const count   = photos.length;
    const atLimit = count >= 5;

    if (countEl) countEl.textContent = `(${count} / 5)`;
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
            <button onclick="handlePhotoDelete('${propertyId}', '${url}')"
                    title="Remove photo"
                    style="position:absolute;top:4px;right:4px;
                           background:rgba(0,0,0,0.65);border:none;border-radius:50%;
                           width:22px;height:22px;cursor:pointer;
                           display:flex;align-items:center;justify-content:center;
                           color:#fff;line-height:1;
                           transition:background 0.15s"
                    onmouseover="this.style.background='rgba(248,113,113,0.85)'"
                    onmouseout="this.style.background='rgba(0,0,0,0.65)'">${ICON('close',12)}</button>
            <span style="position:absolute;bottom:4px;left:4px;
                         font-family:'JetBrains Mono',monospace;font-size:0.5rem;
                         background:rgba(0,0,0,0.55);color:#fff;
                         padding:1px 5px;border-radius:3px">
              ${i === 0 ? 'Cover' : `#${i + 1}`}
            </span>
        </div>`).join('');
}

function handleListingToggle(propertyId, turningOn) {
    if (!turningOn) {
        togglePropertyListing(propertyId, false);
        return;
    }

    const prop = _propertiesCache.find(p => p._id === propertyId);
    if (!prop) { togglePropertyListing(propertyId, true); return; }

    if (!prop.description || !prop.description.trim()) {
        openListingEditor(propertyId, true);
    } else {
        togglePropertyListing(propertyId, true);
    }
}

// ═══════════════════════════════════════
// SEMESTER CALENDAR EDITOR (property settings + add-property)
// ═══════════════════════════════════════

const _SEM_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const _semEditors = {};

function _defaultSemester(prev, index) {
    if (!prev) return { label: 'Semester 1', startMonth: 1, startDay: 1, endMonth: 5, endDay: null, rentAmount: null };
    if (index === 1 && prev.endMonth === 5) return { label: 'Semester 2', startMonth: 8, startDay: 1, endMonth: 12, endDay: null, rentAmount: null };
    const start = (prev.endMonth % 12) + 1;
    const end   = ((start + 2) % 12) + 1;           // a 4-month span, start..start+3
    return { label: `Semester ${index + 1}`, startMonth: start, startDay: 1, endMonth: end, endDay: null, rentAmount: null };
}

function _semestersFromRule(rule) {
    rule = rule || {};
    if (Array.isArray(rule.semesters) && rule.semesters.length) {
        return rule.semesters.map(s => ({
            label: s.label || '', startMonth: s.startMonth, startDay: s.startDay || 1,
            endMonth: s.endMonth, endDay: s.endDay || null, rentAmount: s.rentAmount || null
        }));
    }
    // Legacy property: its single semester becomes Semester 1; the landlord adds Semester 2
    const first = { label: 'Semester 1', startMonth: rule.startMonth || 1, startDay: 1, endMonth: rule.endMonth || 5, endDay: null, rentAmount: null };
    return [first, _defaultSemester(first, 1)];
}

function initSemesterEditor(editorId, semesters) {
    const list = (semesters && semesters.length ? semesters : [_defaultSemester(null, 0)]).map(s => ({ ...s }));
    if (list.length < 2) list.push(_defaultSemester(list[0], 1));
    _semEditors[editorId] = list;
    renderSemesterEditor(editorId);
}

function renderSemesterEditor(editorId) {
    const el = document.getElementById(editorId);
    if (!el) return;
    const list = _semEditors[editorId] || [];

    const monthOpts = sel => _SEM_MONTH_NAMES.map((m, i) => `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>${m}</option>`).join('');
    const dayOpts = (sel, allowLast) =>
        (allowLast ? `<option value="" ${!sel ? 'selected' : ''}>Last day</option>` : '') +
        Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('');

    const lbl = 'font-family:\'JetBrains Mono\',monospace;font-size:0.55rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-dim);display:block;margin-bottom:0.25rem';

    el.innerHTML = list.map((s, i) => `
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:0.75rem;margin-bottom:0.65rem">
            <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem">
                <input type="text" value="${_escHtmlRef(s.label)}" placeholder="Semester ${i + 1}" style="margin:0;flex:1"
                       oninput="updateSemesterEditor('${editorId}', ${i}, 'label', this.value)">
                ${i >= 2 ? `<button type="button" class="btn btn-danger btn-sm" onclick="removeSemesterFromEditor('${editorId}', ${i})">${ICON('close',12)}</button>` : ''}
            </div>
            <div style="display:grid;grid-template-columns:1.6fr 0.9fr;gap:0.5rem;margin-bottom:0.5rem">
                <div><label style="${lbl}">Start month</label>
                    <select style="margin:0" onchange="updateSemesterEditor('${editorId}', ${i}, 'startMonth', this.value)">${monthOpts(s.startMonth)}</select></div>
                <div><label style="${lbl}">Start day</label>
                    <select style="margin:0" onchange="updateSemesterEditor('${editorId}', ${i}, 'startDay', this.value)">${dayOpts(s.startDay || 1, false)}</select></div>
                <div><label style="${lbl}">End month</label>
                    <select style="margin:0" onchange="updateSemesterEditor('${editorId}', ${i}, 'endMonth', this.value)">${monthOpts(s.endMonth)}</select></div>
                <div><label style="${lbl}">End day</label>
                    <select style="margin:0" onchange="updateSemesterEditor('${editorId}', ${i}, 'endDay', this.value)">${dayOpts(s.endDay, true)}</select></div>
            </div>
            <label style="${lbl}">Rent for this semester (optional — blank uses the default)</label>
            <input type="number" min="0" value="${s.rentAmount || ''}" placeholder="Default rent" style="margin:0"
                   oninput="updateSemesterEditor('${editorId}', ${i}, 'rentAmount', this.value)">
        </div>`).join('') +
        (list.length < 3
            ? `<button type="button" class="btn btn-secondary btn-sm btn-full" onclick="addSemesterToEditor('${editorId}')">${ICON('plus',14)} Add Another Semester Period</button>`
            : '') +
        `<div class="pay-setup-hint" style="margin-top:0.5rem">2 to 3 semesters per academic year, in calendar order. The daily rate used for extensions is each semester's rent ÷ the number of days in it.</div>`;
}

function updateSemesterEditor(editorId, idx, field, value) {
    const s = (_semEditors[editorId] || [])[idx];
    if (!s) return;
    if (field === 'label')                    s.label = value;
    else if (field === 'endDay')              s.endDay = value === '' ? null : Number(value);
    else if (field === 'rentAmount')          s.rentAmount = value === '' ? null : Number(value);
    else                                      s[field] = Number(value);
}

function addSemesterToEditor(editorId) {
    const list = _semEditors[editorId] || [];
    if (list.length >= 3) return;
    list.push(_defaultSemester(list[list.length - 1], list.length));
    renderSemesterEditor(editorId);
}

function removeSemesterFromEditor(editorId, idx) {
    const list = _semEditors[editorId] || [];
    if (list.length <= 2) return;
    list.splice(idx, 1);
    renderSemesterEditor(editorId);
}

function collectSemesterEditor(editorId) {
    return (_semEditors[editorId] || []).map(s => ({
        label: s.label, startMonth: s.startMonth, startDay: s.startDay || 1,
        endMonth: s.endMonth, endDay: s.endDay || null, rentAmount: s.rentAmount || null
    }));
}

function _toggleNewPropSemesterFields() {
    const enabled = document.getElementById('newPropSemesterEnabled')?.value === 'true';
    const wrap = document.getElementById('newPropSemesterFieldsWrap');
    if (wrap) wrap.style.display = enabled ? 'block' : 'none';
}


// ═══════════════════════════════════════
// STAY & HOLIDAY PANEL (tenant profile) + modals
// ═══════════════════════════════════════

let _stayInfoCache = {};
let _profileStayCache = {};      // tenantId → stay-progress block of GET /tenant/:id (feeds the Edit Due Date modal)
let _profileArrearsCache = {};
let _holdRegistry = {};

// Dates from the server arrive as 'YYYY-MM-DD' strings (built from the server's own calendar
// day) so they never shift by a day when the browser's timezone differs from the server's.
function _fmtISO(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function _isoOfDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function _addDaysISO(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return _isoOfDate(new Date(y, m - 1, d + n));
}
function _daysBetweenISO(aISO, bISO) {
    const [ay, am, ad] = aISO.split('-').map(Number);
    const [by, bm, bd] = bISO.split('-').map(Number);
    return Math.round((new Date(ay, am - 1, ad) - new Date(by, bm - 1, bd)) / 86400000);
}
const _ksh = n => `Ksh ${Number(n || 0).toLocaleString()}`;

function _openDynamicModal(id, html, maxWidth = '440px') {
    let modal = document.getElementById(id);
    if (!modal) {
        modal = document.createElement('div');
        modal.id = id;
        modal.className = 'modal-overlay';
        modal.addEventListener('click', e => { if (e.target === modal) closeModal(id); });
        document.body.appendChild(modal);
    }
    modal.innerHTML = `<div class="modal" style="max-width:${maxWidth}">${html}</div>`;
    openModal(id);
}
function _modalHeader(id, title, icon) {
    return `<div class="modal-header"><div class="modal-title">${ICON(icon, 18)} ${title}</div>
            <button class="modal-close" onclick="closeModal('${id}')">${ICON('close', 16)}</button></div>`;
}

function _holdBlockHtml(tenantId, info, hold, canManage, canRecord) {
    return hold ? `
        <div style="background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.25);border-radius:8px;padding:0.85rem 1rem;margin-top:0.85rem">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap">
                <strong style="color:var(--warn);font-size:0.82rem">${ICON('door', 14)} On holiday — room reserved</strong>
                ${hold.overdue ? `<span class="pill pill-red">${hold.overdueDays} day(s) overdue</span>` : ''}
            </div>
            <div class="pay-summary" style="margin-bottom:0.65rem">
                <div class="pay-summary-row"><span class="pay-summary-label">Away since</span><span class="pay-summary-value">${_fmtISO(hold.startDateISO)}</span></div>
                <div class="pay-summary-row"><span class="pay-summary-label">Expected back</span><span class="pay-summary-value">${_fmtISO(hold.expectedReturnISO)}</span></div>
                <div class="pay-summary-row"><span class="pay-summary-label">Holding fee</span><span class="pay-summary-value">${_ksh(hold.feeAmount)} / month</span></div>
                <div class="pay-summary-row"><span class="pay-summary-label">Days away</span><span class="pay-summary-value">${hold.daysAway}</span></div>
                <div class="pay-summary-row"><span class="pay-summary-label">Accrued / Paid</span><span class="pay-summary-value">${_ksh(hold.accrued)} / ${_ksh(hold.paid)}</span></div>
                <div class="pay-summary-row"><span class="pay-summary-label">Balance</span><span class="pay-summary-value" style="color:var(--warn)">${_ksh(hold.balance)}</span></div>
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
                ${canManage ? `<button class="btn btn-primary btn-sm" onclick="openReturnHolidayModal('${hold.id}')">${ICON('loop', 14)} Mark Returned</button>` : ''}
                ${canRecord && hold.balance > 0 ? `<button class="btn btn-secondary btn-sm" onclick="openHoldFeeModal('${hold.id}')">${ICON('cash', 14)} Record Fee</button>` : ''}
                ${canManage ? `<button class="btn btn-warn btn-sm" onclick="convertHoldToMoveOut('${hold.id}')">${ICON('door', 14)} Never Returning — Move Out</button>` : ''}
            </div>
        </div>` : `
        ${info.academicYearComplete ? `<div class="field-hint" style="background:var(--accent-dim);border:1px solid rgba(110,231,183,0.2);border-radius:7px;padding:0.55rem 0.8rem;margin:0.85rem 0 0.5rem">
            ${ICON('check', 12)} Academic year complete. If this tenant is going home for the break, record it below so the room stays reserved and full rent isn't charged.</div>` : ''}
        ${canManage ? `<button class="btn btn-secondary btn-sm" style="margin-top:0.75rem" onclick="openStartHolidayModal('${tenantId}')">${ICON('door', 14)} Went on Holiday</button>` : ''}`;
}

function renderTenantStayPanel(tenantId, info) {
    const el = document.getElementById('tenantStayPanel');
    if (!el) return;
    if (!info || !info.eligible) { el.innerHTML = ''; return; }
    _stayInfoCache[tenantId] = info;

    const caretaker = isCaretaker();
    const perms     = getCaretakerPermissions() || {};
    const canManage = !caretaker || !!perms.canManageTenants;
    const canRecord = !caretaker || !!perms.canRecordPayments;
    const cur  = info.current;
    const hold = info.hold;
    if (hold) _holdRegistry[hold.id] = hold;

    // Monthly tenants only have the holiday part (no semesters, no extension here).
    if (info.cycle === 'monthly') {
        el.innerHTML = `
            <div style="margin-top:1.25rem;border-top:1px solid var(--border);padding-top:1rem">
                <div style="font-size:0.62rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim);margin-bottom:0.65rem">Holiday</div>
                <div class="field-hint" style="margin-bottom:0.25rem;line-height:1.6">Going away for a while? Record it so the room stays reserved. Rent for any cycle that starts while they are away is paused and a holding fee applies instead; their rent cycle starts again the day they are back.</div>
                ${_holdBlockHtml(tenantId, info, hold, canManage, canRecord)}
            </div>`;
        return;
    }

    const chips = info.semesters.map(s => `
        <span class="pill ${s.completed ? 'pill-green' : 'pill-yellow'}" title="${_escHtmlRef(s.periodLabel)}">
            ${_escHtmlRef(s.label)} · ${_fmtISO(s.startISO)} – ${_fmtISO(s.endISO)}${s.completed ? ' ' + ICON('check', 10) : ''}
        </span>`).join('');

    const expectedOpts = Array.from({ length: info.semesterCountInYear }, (_, i) => i + 1)
        .map(n => `<option value="${n}" ${info.expectedSemesterCount === n ? 'selected' : ''}>${n} semester${n > 1 ? 's' : ''}</option>`).join('');

    const progress = info.expectedSemesterCount
        ? `${info.semestersCompleted} of ${info.expectedSemesterCount} expected semester(s) completed`
        : 'Expected number of semesters not set';

    const holdBlock = _holdBlockHtml(tenantId, info, hold, canManage, canRecord);

    el.innerHTML = `
        <div style="margin-top:1.25rem;border-top:1px solid var(--border);padding-top:1rem">
            <div style="font-size:0.62rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim);margin-bottom:0.65rem">
                Stay &amp; Holiday — Academic Year ${_escHtmlRef(info.academicYear)}
            </div>
            <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.6rem">${chips}</div>
            <div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:0.6rem">${progress}</div>
            ${canManage ? `<div style="display:flex;gap:0.5rem;margin-bottom:0.85rem">
                <select id="stayExpectedSelect" style="margin:0;flex:1"><option value="">Expected semesters…</option>${expectedOpts}</select>
                <button class="btn btn-secondary btn-sm" onclick="saveExpectedSemesters('${tenantId}')">Save</button>
            </div>` : ''}
            <div class="pay-summary" style="margin-bottom:0.65rem">
                <div class="pay-summary-row"><span class="pay-summary-label">Stay ends</span><span class="pay-summary-value">${_fmtISO(cur.effectiveEndISO)}${cur.extensionDays ? ` (+${cur.extensionDays} d)` : ''}</span></div>
                <div class="pay-summary-row"><span class="pay-summary-label">Daily rate</span><span class="pay-summary-value">${_ksh(Math.ceil(cur.dailyRate))}</span></div>
            </div>
            ${!caretaker ? `<button class="btn btn-secondary btn-sm" ${hold ? 'disabled title="Record the tenant\'s return first"' : ''} onclick="openExtendStayModal('${tenantId}')">${ICON('clock', 14)} Extend Stay</button>` : ''}
            ${holdBlock}
            ${_lateReturnHtml(info, canManage)}
        </div>`;
}

// A between-semesters break ends by itself the day the next semester starts. If the tenant came back later,
// the landlord can still record the real return date.
function _lateReturnHtml(info, canManage) {
    const h = info.recentAutoEnded;
    if (!h || !canManage || info.hold) return '';
    _holdRegistry[h.id] = h;
    return `<div class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin-top:0.85rem;line-height:1.6">
        The break ended on ${_fmtISO(h.expectedReturnISO)}, when the next semester started. Did ${_escHtmlRef(info.tenantName)} come back later?
        <button class="btn btn-secondary btn-sm" style="margin-top:0.4rem" onclick="openReturnHolidayModal('${h.id}')">Record late return</button></div>`;
}

// ── Extend Stay ──
function openExtendStayModal(tenantId) {
    const info = _stayInfoCache[tenantId];
    if (!info || !info.current) { showToast('Reload the tenant profile and try again', 'warn'); return; }
    const cur = info.current;
    const minISO = _addDaysISO(cur.effectiveEndISO, 1);
    const maxISO = cur.nextSemesterStartISO ? _addDaysISO(cur.nextSemesterStartISO, -1) : null;

    _openDynamicModal('modal-extend-stay', `
        ${_modalHeader('modal-extend-stay', 'Extend Stay', 'clock')}
        <div class="pay-summary">
            <div class="pay-summary-row"><span class="pay-summary-label">Period</span><span class="pay-summary-value">${_escHtmlRef(cur.periodLabel)}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Currently ends</span><span class="pay-summary-value">${_fmtISO(cur.effectiveEndISO)}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Daily rate</span><span class="pay-summary-value">${_ksh(Math.ceil(cur.dailyRate))}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Currently owed</span><span class="pay-summary-value">${_ksh(cur.amountDue)}</span></div>
        </div>
        <label class="pay-setup-label" style="display:block;margin-bottom:0.35rem">New end date</label>
        <input type="date" id="extendNewEnd" min="${minISO}" ${maxISO ? `max="${maxISO}"` : ''} oninput="_updateExtendPreview('${tenantId}')">
        <div id="extendPreview" class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin:0 0 0.85rem">Pick a date to see the extra charge.</div>
        <button class="btn btn-primary btn-full" id="extendConfirmBtn" onclick="submitExtendStay('${tenantId}')">Confirm Extension</button>
    `);
}
function _updateExtendPreview(tenantId) {
    const info = _stayInfoCache[tenantId];
    const val  = document.getElementById('extendNewEnd')?.value;
    const box  = document.getElementById('extendPreview');
    if (!info || !box || !val) return;
    const days = _daysBetweenISO(val, info.current.effectiveEndISO);
    if (days <= 0) { box.textContent = 'The new end date must be after the current end date.'; return; }
    const charge = Math.ceil(info.current.dailyRate * days);
    box.innerHTML = `<strong style="color:var(--text)">${days}</strong> extra day(s) × ${_ksh(Math.ceil(info.current.dailyRate))}/day = <strong style="color:var(--accent)">${_ksh(charge)}</strong><br>New total for this period: <strong style="color:var(--text)">${_ksh(info.current.amountDue + charge)}</strong>`;
}


// ── Stay progress bar (landlord profile) — colour follows how close the due/end date is ──
function _stayProgressHtml(stay) {
    if (!stay) return '';
    const d = stay.daysRemaining;
    const remaining = d > 1 ? `${d} days remaining` : d === 1 ? '1 day remaining' : d === 0 ? 'Due today' : `${-d} day${d === -1 ? '' : 's'} overdue`;
    const tone = stay.level === 'urgent' ? 'var(--danger)' : stay.level === 'warn' ? 'var(--warn)' : 'var(--text-muted)';
    return `
        <div style="margin-bottom:1.25rem">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:0.5rem">
                <div style="font-size:0.62rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim)">Stay Progress</div>
                ${stay.isOverride ? `<span class="pill pill-yellow">${ICON('clock', 10)} Date adjusted</span>` : ''}
            </div>
            <div class="payment-progress" style="margin-top:0" role="progressbar" aria-label="Stay progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${stay.percent}">
                <div class="payment-progress-bar stay-${stay.level}" style="width:${stay.percent}%"></div>
            </div>
            <div style="display:flex;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;margin-top:0.4rem;font-family:'JetBrains Mono',monospace;font-size:0.68rem">
                <span style="color:var(--text-dim)">${_fmtISO(stay.startISO)} → ${_fmtISO(stay.endISO)}</span>
                <span style="color:${tone};font-weight:600">${remaining}</span>
            </div>
        </div>`;
}

// ── Transfer House — same tenant, another house of the SAME property (the server enforces it too) ──
function openTransferModal(tenantId) {
    if (!_checkCaretakerPermission('canManageTenants', 'transfer tenants')) return;
    const tenant = (_allTenants || []).find(t => t._id === tenantId);
    if (!tenant || !tenant.house || typeof tenant.house !== 'object') { showToast('Reload the tenant list and try again', 'warn'); return; }

    const cur    = tenant.house;
    const cycle  = cur.billingCycle || 'monthly';
    const propId = String((tenant.property && tenant.property._id) || tenant.property || getPropertyId());
    const options = (_allHouses || []).filter(h =>
        h.status === 'available' &&
        String((h.property && h.property._id) || h.property) === propId &&
        String(h._id) !== String(cur._id) &&
        (h.billingCycle || 'monthly') === cycle);
    const lbl = 'class="pay-setup-label" style="display:block;margin-bottom:0.35rem"';

    _openDynamicModal('modal-transfer-tenant', `
        ${_modalHeader('modal-transfer-tenant', 'Transfer House', 'loop')}
        <div class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin:0 0 0.85rem;line-height:1.6">
            Moving <strong style="color:var(--text)">${_escHtmlRef(tenant.name)}</strong> out of
            <strong style="color:var(--text)">${_escHtmlRef(cur.name)}</strong>. It is the same tenant — payments, receipts and any
            arrears stay exactly as they are. Only available houses in this property are listed.
        </div>
        <label ${lbl}>New house</label>
        <select id="transferHouseSelect" onchange="_updateTransferPreview('${tenantId}')" ${options.length ? '' : 'disabled'}>
            ${options.length
                ? `<option value="">— Select a house —</option>${_houseOptionsGrouped(options)}`
                : `<option value="">No other available ${cycle} houses in this property</option>`}
        </select>
        <div id="transferPreview" class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin:0 0 0.85rem;line-height:1.6">Pick a house to see how rent is affected.</div>
        <button class="btn btn-primary btn-full" id="transferConfirmBtn" onclick="submitTransfer('${tenantId}')" ${options.length ? '' : 'disabled'}>Transfer Tenant</button>
    `);
}

function _updateTransferPreview(tenantId) {
    const box    = document.getElementById('transferPreview');
    const tenant = (_allTenants || []).find(t => t._id === tenantId);
    if (!box || !tenant || !tenant.house) return;
    const id   = document.getElementById('transferHouseSelect')?.value;
    const next = (_allHouses || []).find(h => String(h._id) === String(id));
    if (!next) { box.textContent = 'Pick a house to see how rent is affected.'; return; }

    const cur = tenant.house;
    if ((cur.billingCycle || 'monthly') === 'semester') {
        box.innerHTML = `Semester rent is set for the whole property, so it does not change. Anything already adjusted for this semester moves with the tenant.`;
        return;
    }
    const oldRent = Number(cur.rent || 0), newRent = Number(next.rent || 0);
    box.innerHTML = oldRent === newRent
        ? `Rent stays at <strong style="color:var(--text)">${_ksh(newRent)}</strong> / month.`
        : `Rent changes from <strong style="color:var(--text)">${_ksh(oldRent)}</strong> to <strong style="color:var(--accent)">${_ksh(newRent)}</strong> / month.<br>
           ${_ksh(oldRent)} stays for the current cycle and every earlier month; ${_ksh(newRent)} applies from the next cycle.`;
}

async function submitTransfer(tenantId) {
    const houseId = document.getElementById('transferHouseSelect')?.value;
    if (!houseId) { showToast('Choose the house to move the tenant to', 'warn'); return; }

    const btn = document.getElementById('transferConfirmBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = `${ICON('hourglass',14)} Transferring...`; }
    try {
        const res  = await fetch(`${API}/tenants/${tenantId}/transfer-house`, {
            method: 'PUT', headers: authHeaders(), body: JSON.stringify({ houseId })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Transfer failed', 'error'); return; }
        showToast(data.message, 'success');
        closeModal('modal-transfer-tenant');
        await loadTenants();
        await _refreshAfterStayChange(tenantId);
    } catch (err) { showToast('Network error', 'error'); console.error(err); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = 'Transfer Tenant'; } }
}

// ── Edit Due Date (monthly tenants) — moves only the end/due date; no extra charge; the NEXT cycle
//    starts on the new date. Semester tenants keep "Extend Stay". ──
function openCycleEndModal(tenantId) {
    if (isCaretaker()) { showToast('Only landlords can change a due date', 'warn'); return; }
    const stay = _profileStayCache[tenantId];
    if (!stay || stay.cycle !== 'monthly') { showToast('Reload the tenant profile and try again', 'warn'); return; }

    const minISO = _addDaysISO(stay.originalEndISO || stay.endISO, 1);
    const lbl = 'class="pay-setup-label" style="display:block;margin-bottom:0.35rem"';

    _openDynamicModal('modal-cycle-end', `
        ${_modalHeader('modal-cycle-end', 'Edit Due Date', 'clock')}
        <div class="pay-summary">
            <div class="pay-summary-row"><span class="pay-summary-label">Rent period</span><span class="pay-summary-value">${_escHtmlRef(stay.label)}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Automatic due date</span><span class="pay-summary-value">${_fmtISO(stay.originalEndISO || stay.endISO)}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Currently due</span><span class="pay-summary-value">${_fmtISO(stay.endISO)}</span></div>
        </div>
        <label ${lbl}>New due / end date</label>
        <input type="date" id="cycleNewEnd" min="${minISO}" value="${stay.isOverride ? stay.endISO : ''}" oninput="_updateCycleEndPreview('${tenantId}')">
        <div id="cycleEndPreview" class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin:0 0 0.85rem;line-height:1.6">Pick a date to see what changes.</div>
        <button class="btn btn-primary btn-full" id="cycleEndConfirmBtn" onclick="submitCycleEnd('${tenantId}')">Save Due Date</button>
    `);
    if (stay.isOverride) _updateCycleEndPreview(tenantId);
}

function _updateCycleEndPreview(tenantId) {
    const stay = _profileStayCache[tenantId];
    const val  = document.getElementById('cycleNewEnd')?.value;
    const box  = document.getElementById('cycleEndPreview');
    if (!stay || !box || !val) return;
    const autoISO = stay.originalEndISO || stay.endISO;
    if (_daysBetweenISO(val, autoISO) <= 0) { box.textContent = `The new date must be after the automatic due date (${_fmtISO(autoISO)}).`; return; }
    const extra = _daysBetweenISO(val, autoISO);
    box.innerHTML = `Due date moves to <strong style="color:var(--text)">${_fmtISO(val)}</strong> (+${extra} day${extra === 1 ? '' : 's'}).<br>
        <strong style="color:var(--accent)">No extra charge.</strong> The next rent cycle starts on that date.`;
}

async function submitCycleEnd(tenantId) {
    const newEndDate = document.getElementById('cycleNewEnd')?.value;
    if (!newEndDate) { showToast('Pick the new due date', 'warn'); return; }

    const btn = document.getElementById('cycleEndConfirmBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = `${ICON('hourglass',14)} Saving...`; }
    try {
        const res  = await fetch(`${API}/tenants/${tenantId}/cycle-end`, {
            method: 'PUT', headers: authHeaders(), body: JSON.stringify({ newEndDate })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Could not change the due date', 'error'); return; }
        showToast(data.message, 'success');
        closeModal('modal-cycle-end');
        await _refreshAfterStayChange(tenantId);
    } catch (err) { showToast('Network error', 'error'); console.error(err); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = 'Save Due Date'; } }
}

// ── Went on Holiday ──
// ── Help & Support (landlord dashboard): call or WhatsApp ──
const HELP_PHONE_DISPLAY = '0702 276 609';
const HELP_PHONE_INTL    = '254702276609';
function openHelpModal() {
    const wa = `https://wa.me/${HELP_PHONE_INTL}?text=${encodeURIComponent('Hello, I need help with Affordable Rentals.')}`;
    _openDynamicModal('modal-help', `
        ${_modalHeader('modal-help', 'Help &amp; Support', 'info')}
        <div class="field-hint" style="margin:0 0 1rem;line-height:1.6">Stuck, or not sure how something works? Reach us directly and we will help.</div>
        <a class="btn btn-primary btn-full" href="tel:+${HELP_PHONE_INTL}" style="text-decoration:none;margin-bottom:0.65rem">${ICON('phone', 14)} Call ${HELP_PHONE_DISPLAY}</a>
        <a class="btn btn-secondary btn-full" href="${wa}" target="_blank" rel="noopener" style="text-decoration:none">${ICON('messages', 14)} WhatsApp ${HELP_PHONE_DISPLAY}</a>
    `);
}

let _holidayTenantId = null;   // the tenant the open "Went on Holiday" dialog is for
function openStartHolidayModal(tenantId) {
    const info = _stayInfoCache[tenantId];
    if (!info) { showToast('Reload the tenant profile and try again', 'warn'); return; }
    _holidayTenantId = tenantId;
    const isMonthly = info.cycle === 'monthly';
    const cur       = info.current || null;
    const arrears   = _profileArrearsCache[tenantId] || 0;
    const today     = _isoOfDate(new Date());
    // Default return: monthly → in a month; semester → the start of the next semester (this one, if it hasn't begun yet)
    const defaultReturn = (isMonthly || !cur) ? _addDaysISO(today, 30)
        : (today < cur.startISO ? cur.startISO : (cur.nextSemesterStartISO || _addDaysISO(today, 30)));
    const defFee = Number(info.defaultHoldingFee || 0);
    const lbl    = 'class="pay-setup-label" style="display:block;margin-bottom:0.35rem"';
    const opt = (value, checked, inner) => `
        <label style="display:flex;align-items:center;gap:0.55rem;padding:0.5rem 0.65rem;border:1px solid var(--border);border-radius:7px;margin-bottom:0.4rem;cursor:pointer;font-size:0.8rem;background:var(--bg3);color:var(--text)">
            <input type="radio" name="holFeeMode" value="${value}" ${checked ? 'checked' : ''} onchange="_updateHolidayPreview()" style="width:auto;margin:0">${inner}
        </label>`;

    _openDynamicModal('modal-holiday-start', `
        ${_modalHeader('modal-holiday-start', 'Went on Holiday', 'door')}
        <div class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin:0 0 0.85rem;line-height:1.6">
            <strong style="color:var(--text)">${_escHtmlRef(info.tenantName)}</strong> keeps
            <strong style="color:var(--text)">${_escHtmlRef(info.houseName)}</strong> reserved, so nobody else can be assigned to it.
            ${isMonthly
                ? `Rent for the cycle that is already running stays owed. Cycles that would start while they are away are paused and the holding fee applies instead; their rent cycle starts again on the day they are back.`
                : `Rent for any semester that starts while they are away is paused, and the smaller holding fee applies instead. A semester that has already started stays owed in full.`}
        </div>
        ${arrears > 0 ? `<div class="field-hint" style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:7px;padding:0.6rem 0.8rem;margin:0 0 0.85rem;color:var(--warn);line-height:1.6">
            ${ICON('warning', 12)} ${_ksh(arrears)} is still unpaid. It stays owed — the holding fee is charged separately on top of it.</div>` : ''}
        <label ${lbl}>Holiday start date</label>
        <input type="date" id="holStart" value="${today}" max="${today}" oninput="_updateHolidayPreview()">
        <label ${lbl}>Expected return date</label>
        <input type="date" id="holReturn" value="${defaultReturn}" oninput="_updateHolidayPreview()">
        <label ${lbl}>Holding fee</label>
        ${opt('default', true,  `Use default fee (${_ksh(defFee)} / month)`)}
        ${opt('custom',  false, `Custom fee per month <input type="number" id="holFee" min="1" placeholder="Ksh" style="margin:0 0 0 auto;width:7rem" onfocus="this.closest('label').querySelector('input[type=radio]').checked=true;_updateHolidayPreview()" oninput="_updateHolidayPreview()">`)}
        ${opt('none',    false, `No fee — the tenant stays free`)}
        <div id="holPreview" class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin:0.5rem 0 0.85rem;line-height:1.6"></div>
        <button class="btn btn-primary btn-full" id="holConfirmBtn" onclick="submitStartHoliday('${tenantId}')">Start Holiday</button>
        <button class="btn btn-warn btn-sm btn-full" style="margin-top:0.5rem" onclick="_holidayMoveOut('${tenantId}')">${ICON('door', 14)} Tenant is moving out instead</button>
    `);
    _updateHolidayPreview();
}

function _holidayMoveOut(tenantId) {
    const info = _stayInfoCache[tenantId];
    if (!info) return;
    if (!_checkCaretakerPermission('canManageTenants', 'move out tenants')) return;
    closeModal('modal-holiday-start');
    _performTenantMoveOut(tenantId, info.tenantName || 'Tenant', info.houseName || '');
}

function _updateHolidayPreview() {
    const box = document.getElementById('holPreview');
    if (!box) return;
    const info = _holidayTenantId ? _stayInfoCache[_holidayTenantId] : null;
    const mode  = document.querySelector('input[name="holFeeMode"]:checked')?.value || 'default';
    const fee   = mode === 'none' ? 0 : mode === 'custom' ? (Number(document.getElementById('holFee')?.value) || 0) : Number(info?.defaultHoldingFee || 0);
    const start = document.getElementById('holStart')?.value;
    const ret   = document.getElementById('holReturn')?.value;
    if (!start || !ret) { box.textContent = 'Choose the dates to see the estimated holding fee.'; return; }
    const days = _daysBetweenISO(ret, start);
    if (days <= 0) { box.textContent = 'The expected return date must be after the start date.'; return; }
    const est = Math.ceil((fee / 30) * days);
    box.innerHTML = (fee > 0
        ? `<strong style="color:var(--text)">${days}</strong> day(s) away × ${_ksh(fee)} ÷ 30 ≈ <strong style="color:var(--accent)">${_ksh(est)}</strong>`
        : `<strong style="color:var(--text)">${days}</strong> day(s) away — <strong style="color:var(--accent)">no holding fee</strong>`)
        + `<br>The fee accrues day by day and is only what is actually owed — returning early or late adjusts it. The tenant is told by notification and email.`;
}

// ── Mark Returned ──
function openReturnHolidayModal(holdId) {
    const hold = _holdRegistry[holdId];
    if (!hold) { showToast('Reload and try again', 'warn'); return; }
    const today = _isoOfDate(new Date());

    _openDynamicModal('modal-holiday-return', `
        ${_modalHeader('modal-holiday-return', 'Mark Returned', 'loop')}
        <div class="pay-summary">
            <div class="pay-summary-row"><span class="pay-summary-label">Tenant</span><span class="pay-summary-value">${_escHtmlRef(hold.tenantName || '—')}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Away since</span><span class="pay-summary-value">${_fmtISO(hold.startDateISO)}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Expected back</span><span class="pay-summary-value">${_fmtISO(hold.expectedReturnISO)}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Holding fee</span><span class="pay-summary-value">${_ksh(hold.feeAmount)} / month</span></div>
        </div>
        <label class="pay-setup-label" style="display:block;margin-bottom:0.35rem">Return date</label>
        <input type="date" id="holRetDate" value="${today}" min="${hold.autoEnded ? _addDaysISO(hold.expectedReturnISO, 1) : hold.startDateISO}" max="${today}" oninput="_updateReturnPreview('${holdId}')">
        <div id="holRetPreview" class="field-hint" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:0.6rem 0.8rem;margin:0 0 0.85rem;line-height:1.6"></div>
        <button class="btn btn-primary btn-full" id="holRetConfirmBtn" onclick="submitReturnHoliday('${holdId}')">Confirm Return</button>
    `);
    _updateReturnPreview(holdId);
}

function _updateReturnPreview(holdId) {
    const hold = _holdRegistry[holdId];
    const ret  = document.getElementById('holRetDate')?.value;
    const box  = document.getElementById('holRetPreview');
    if (!hold || !box || !ret) return;
    const days    = Math.max(0, _daysBetweenISO(ret, hold.startDateISO));
    const accrued = Math.ceil((hold.feeAmount / 30) * days);
    const offset  = _daysBetweenISO(ret, hold.expectedReturnISO);
    const timing  = offset < 0 ? `${Math.abs(offset)} day(s) early` : offset > 0 ? `${offset} day(s) late` : 'on the expected date';
    box.innerHTML = `Returning <strong style="color:var(--text)">${timing}</strong> · ${days} day(s) away →
        holding fee <strong style="color:var(--accent)">${_ksh(accrued)}</strong>
        (paid ${_ksh(hold.paid)}, balance ${_ksh(Math.max(0, accrued - hold.paid))}).
        <br>${hold.billingCycle === 'monthly' ? 'Monthly rent restarts from this date.' : 'Semester rent resumes from this date.'}`;
}

// ── Record a holding-fee payment ──
function openHoldFeeModal(holdId) {
    const hold = _holdRegistry[holdId];
    if (!hold) { showToast('Reload and try again', 'warn'); return; }
    if (hold.balance <= 0) { showToast('Nothing is owed on this holiday hold right now', 'warn'); return; }

    _openDynamicModal('modal-holiday-fee', `
        ${_modalHeader('modal-holiday-fee', 'Record Holding Fee', 'cash')}
        <div class="pay-summary">
            <div class="pay-summary-row"><span class="pay-summary-label">Tenant</span><span class="pay-summary-value">${_escHtmlRef(hold.tenantName || '—')}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Accrued</span><span class="pay-summary-value">${_ksh(hold.accrued)}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Paid</span><span class="pay-summary-value">${_ksh(hold.paid)}</span></div>
            <div class="pay-summary-row"><span class="pay-summary-label">Balance</span><span class="pay-summary-value" style="color:var(--warn)">${_ksh(hold.balance)}</span></div>
        </div>
        <input type="number" id="holFeeAmount" min="1" max="${hold.balance}" value="${hold.balance}" placeholder="Amount (Ksh)">
        <select id="holFeeMethod">
            <option value="cash">Cash</option><option value="mpesa">M-Pesa (manual)</option>
            <option value="bank">Bank Transfer</option><option value="other">Other</option>
        </select>
        <input type="text" id="holFeeNote" placeholder="Note (optional)" style="margin-bottom:0.85rem">
        <button class="btn btn-primary btn-full" id="holFeeConfirmBtn" onclick="submitHoldFee('${holdId}')">Record Fee</button>
    `);
}

// ── Tenant is not coming back. Goes through the SAME move-out flow as every other move-out
//    (which also shows the refund step if they had prepaid a semester); the server closes the
//    hold as 'ended' and keeps any unpaid holding fee on record. ──
function convertHoldToMoveOut(holdId) {
    const hold = _holdRegistry[holdId];
    if (!hold) { showToast('Reload and try again', 'warn'); return; }
    if (!_checkCaretakerPermission('canManageTenants', 'move out tenants')) return;
    _performTenantMoveOut(hold.tenantId, hold.tenantName || 'Tenant', hold.houseName || '');
}

// ── Holiday holds card (Tenants section) ──
function renderHolidayHoldsCard(holds) {
    const el = document.getElementById('holidayHoldsCard');
    if (!el) return;
    if (!holds || !holds.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    holds.forEach(h => { _holdRegistry[h.id] = h; });

    const caretaker = isCaretaker();
    const perms     = getCaretakerPermissions() || {};
    const canManage = !caretaker || !!perms.canManageTenants;
    const canRecord = !caretaker || !!perms.canRecordPayments;

    const rows = holds.map(h => {
        const statusPill = h.status === 'active'
            ? (h.overdue ? `<span class="pill pill-red">${h.overdueDays} day(s) overdue</span>` : `<span class="pill pill-yellow">On holiday</span>`)
            : `<span class="pill" style="background:var(--bg3);color:var(--text-dim);border:1px solid var(--border)">${h.status === 'ended' ? 'Moved out' : 'Returned'} · fee unpaid</span>`;
        return `
        <div style="padding:0.75rem 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.3rem">
                <strong style="color:var(--text);font-size:0.83rem">${_escHtmlRef(h.tenantName)} <span style="color:var(--text-dim);font-weight:400">· ${_escHtmlRef(h.houseName)}</span></strong>
                ${statusPill}
            </div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim);margin-bottom:0.5rem;line-height:1.7">
                ${_fmtISO(h.startDateISO)} → ${h.actualReturnISO ? _fmtISO(h.actualReturnISO) : _fmtISO(h.expectedReturnISO) + ' (expected)'}
                · ${h.daysAway} day(s) · accrued ${_ksh(h.accrued)} · paid ${_ksh(h.paid)} ·
                <span style="color:${h.balance > 0 ? 'var(--warn)' : 'var(--accent)'}">balance ${_ksh(h.balance)}</span>
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
                ${h.status === 'active' && canManage ? `<button class="btn btn-primary btn-sm" onclick="openReturnHolidayModal('${h.id}')">${ICON('loop', 14)} Mark Returned</button>` : ''}
                ${canRecord && h.balance > 0 ? `<button class="btn btn-secondary btn-sm" onclick="openHoldFeeModal('${h.id}')">${ICON('cash', 14)} Record Fee</button>` : ''}
                ${h.status === 'active' && canManage ? `<button class="btn btn-warn btn-sm" onclick="convertHoldToMoveOut('${h.id}')">${ICON('door', 14)} Not Returning</button>` : ''}
            </div>
        </div>`;
    }).join('');

    el.style.display = 'block';
    el.innerHTML = `<div class="card-title">${ICON('door', 14)} Holiday Holds <span class="pill pill-yellow">${holds.length}</span></div>${rows}`;
}    