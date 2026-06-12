// ═══════════════════════════════════════════════════════
//  script.js — Landlord API Layer (SaaS multi-property)
//  All fetch() calls live here.
//  dashboard.js handles rendering / DOM only.
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
    localStorage.clear();
    window.location.href = 'auth.html';
}

// ── Guard: redirect if not logged in or not landlord ──
(function guardLandlord() {
    const token = getToken();
    if (!token) { window.location.href = 'auth.html'; return; }
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload.role !== 'landlord') window.location.href = 'tenant.html';
        if (payload.mustChangePassword)  window.location.href = 'change-password.html';
    } catch {
        window.location.href = 'auth.html';
    }
})();


// ═══════════════════════════════════════
// NOTIFICATION BELL
// ═══════════════════════════════════════

let _msgUnreadTotal  = 0;
let _inquiryNewCount = 0;

function _updateNotifBell() {
    const total = _msgUnreadTotal + _inquiryNewCount;
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (total > 0) {
        badge.textContent   = total > 99 ? '99+' : String(total);
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
    // Refresh dropdown content if it is currently open
    const dropdown = document.getElementById('notifDropdown');
    if (dropdown && dropdown.style.display !== 'none') {
        _renderNotifDropdown();
    }
}

function toggleNotifDropdown() {
    const dropdown = document.getElementById('notifDropdown');
    if (!dropdown) return;
    const isOpen = dropdown.style.display !== 'none';
    if (isOpen) {
        dropdown.style.display = 'none';
        document.removeEventListener('click', _closeNotifOutside);
    } else {
        _renderNotifDropdown();
        dropdown.style.display = 'block';
        setTimeout(() => { document.addEventListener('click', _closeNotifOutside); }, 0);
    }
}

function _closeNotifOutside(e) {
    const bell = document.getElementById('notifBell');
    if (bell && !bell.contains(e.target)) {
        const dropdown = document.getElementById('notifDropdown');
        if (dropdown) dropdown.style.display = 'none';
        document.removeEventListener('click', _closeNotifOutside);
    }
}

function closeNotifDropdown() {
    const dropdown = document.getElementById('notifDropdown');
    if (dropdown) dropdown.style.display = 'none';
    document.removeEventListener('click', _closeNotifOutside);
}

function _renderNotifDropdown() {
    const dropdown = document.getElementById('notifDropdown');
    if (!dropdown) return;
    const items = [];

    if (_msgUnreadTotal > 0) {
        items.push(`
            <div class="notif-item" onclick="closeNotifDropdown();showSection('messages')">
                <span class="notif-item-icon">💬</span>
                <div class="notif-item-body">
                    <div class="notif-item-title">Unread Messages</div>
                    <div class="notif-item-sub">${_msgUnreadTotal} unread from tenant${_msgUnreadTotal !== 1 ? 's' : ''}</div>
                </div>
                <span class="notif-item-count" style="background:rgba(248,113,113,0.15);color:var(--danger);border:1px solid rgba(248,113,113,0.25)">${_msgUnreadTotal}</span>
            </div>`);
    }

    if (_inquiryNewCount > 0) {
        items.push(`
            <div class="notif-item" onclick="closeNotifDropdown();showSection('inquiries')">
                <span class="notif-item-icon">📩</span>
                <div class="notif-item-body">
                    <div class="notif-item-title">New Inquiries</div>
                    <div class="notif-item-sub">${_inquiryNewCount} new from prospective tenant${_inquiryNewCount !== 1 ? 's' : ''}</div>
                </div>
                <span class="notif-item-count" style="background:rgba(59,130,246,0.12);color:#60a5fa;border:1px solid rgba(59,130,246,0.25)">${_inquiryNewCount}</span>
            </div>`);
    }

    dropdown.innerHTML = `
        <div class="notif-dropdown-header">
            <span>Notifications</span>
            ${items.length > 0
                ? `<span style="color:var(--accent);font-weight:700">${_msgUnreadTotal + _inquiryNewCount}</span>`
                : ''}
        </div>
        ${items.length > 0
            ? items.join('')
            : '<div class="notif-empty">🎉 All caught up!</div>'}`;
}


// ═══════════════════════════════════════════════════════
//  PROPERTY CONTEXT
// ═══════════════════════════════════════════════════════

let _propertiesCache = [];

function getPropertyId() {
    return localStorage.getItem('activePropertyId');
}

function getPropertyName() {
    return localStorage.getItem('activePropertyName') || 'Property';
}

// ── Also updates the full-width property name strip at the top of the topbar ──
function setActiveProperty(id, name) {
    localStorage.setItem('activePropertyId', id);
    localStorage.setItem('activePropertyName', name || 'Property');

    // Property switcher button label
    const nameEl = document.getElementById('activePropertyName');
    if (nameEl) nameEl.textContent = name || 'Property';

    // Full-width property name strip — update from cache for location too
    const topbarEl = document.getElementById('topbarPropertyDisplay');
    if (topbarEl) {
        const prop = _propertiesCache.find(p => p._id === id);
        topbarEl.textContent = prop
            ? (prop.name + (prop.location ? '  ·  📍 ' + prop.location : ''))
            : (name || '—');
    }
}

async function loadProperties() {
    try {
        const res  = await fetch(`${API}/properties`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) return;

        _propertiesCache = data.properties || [];

        if (!getPropertyId() && _propertiesCache.length > 0) {
            setActiveProperty(_propertiesCache[0]._id, _propertiesCache[0].name);
        }

        if (getPropertyId() && !_propertiesCache.find(p => p._id === getPropertyId())) {
            if (_propertiesCache.length > 0) {
                setActiveProperty(_propertiesCache[0]._id, _propertiesCache[0].name);
            } else {
                localStorage.removeItem('activePropertyId');
                localStorage.removeItem('activePropertyName');
            }
        }

        // ── Ensure topbar property strip reflects the active property ──
        const topbarEl = document.getElementById('topbarPropertyDisplay');
        if (topbarEl && getPropertyId()) {
            const active = _propertiesCache.find(p => p._id === getPropertyId());
            if (active) {
                topbarEl.textContent = active.name + (active.location ? '  ·  📍 ' + active.location : '');
            }
        }

        renderPropertySwitcher(_propertiesCache);
        updatePaymentSetupPropertySelect(_propertiesCache);
        renderPropertiesGrid(_propertiesCache);

        return _propertiesCache;

    } catch (err) {
        console.error('loadProperties error:', err.message);
    }
}

function switchProperty(id, name) {
    if (id === getPropertyId()) { closePropertyMenu(); return; }
    setActiveProperty(id, name);
    closePropertyMenu();
    renderPropertySwitcher(_propertiesCache);

    loadTenants();
    loadMovedOutTenants();
    loadHouses();
    loadAnnouncements();
    loadRules();
    loadUnread();
    loadDashboard();

    showToast(`Switched to ${name} 🏠`, 'success');
}

function togglePropertyMenu() {
    const menu = document.getElementById('propertyMenu');
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    if (isOpen) {
        closePropertyMenu();
    } else {
        menu.style.display = 'block';
        setTimeout(() => {
            document.addEventListener('click', closePropertyMenuOutside);
        }, 0);
    }
}

function closePropertyMenu() {
    const menu = document.getElementById('propertyMenu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', closePropertyMenuOutside);
}

function closePropertyMenuOutside(e) {
    const switcher = document.getElementById('propertySwitcher');
    if (switcher && !switcher.contains(e.target)) closePropertyMenu();
}

async function addProperty() {
    const name     = document.getElementById('newPropName')?.value.trim();
    const location = document.getElementById('newPropLocation')?.value.trim();
    const phone    = document.getElementById('newPropPhone')?.value.trim();

    if (!name) { showToast('Property name is required', 'warn'); return; }

    const btn = document.querySelector('#modal-add-property .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating...'; }

    try {
        const res  = await fetch(`${API}/properties/create`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ name, location: location || undefined, phone: phone || undefined })
        });
        const data = await res.json();

        if (!res.ok) {
            if (data.upgrade) showUpgradePrompt(data.message);
            else              showToast(data.message || 'Failed to create property', 'error');
            return;
        }

        showToast(`${name} created ✅`, 'success');
        closeModal('modal-add-property');
        ['newPropName', 'newPropLocation', 'newPropPhone'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });

        await loadProperties();
        switchProperty(data.property._id, data.property.name);

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Create Property'; }
    }
}

function showUpgradePrompt(message) {
    openDangerModal({
        icon:      '⬆️',
        title:     'Upgrade Required',
        message:   `${message}<br><br>Click below to view plans and upgrade.`,
        label:     'View Plans',
        type:      'warn',
        onConfirm: async () => { openModal('modal-subscribe'); }
    });
}


// ═══════════════════════════════════════════════════════
//  DANGER CONFIRM MODAL
// ═══════════════════════════════════════════════════════

let _dangerCallback = null;

function openDangerModal({ icon = '⚠️', title, message, label = 'Confirm', type = 'danger', onConfirm }) {
    document.getElementById('dangerIcon').textContent  = icon;
    document.getElementById('dangerTitle').textContent = title;
    document.getElementById('dangerMessage').innerHTML = message;

    const btn = document.getElementById('dangerConfirmBtn');
    btn.textContent = label;
    btn.className   = `btn btn-full ${type === 'warn' ? 'btn-warn' : 'btn-danger'}`;

    _dangerCallback = onConfirm;
    document.getElementById('modal-danger').classList.add('open');
}

async function confirmDangerAction() {
    if (typeof _dangerCallback !== 'function') return;
    const btn = document.getElementById('dangerConfirmBtn');
    btn.disabled = true; btn.textContent = '⏳ Processing...';
    try { await _dangerCallback(); }
    finally { btn.disabled = false; closeDangerModal(); }
}

function closeDangerModal() {
    document.getElementById('modal-danger').classList.remove('open');
    _dangerCallback = null;
}


// ═══════════════════════════════════════
// LANDLORD PROFILE & ONBOARDING
// ═══════════════════════════════════════

async function loadLandlordProfile() {
    try {
        const res  = await fetch(`${API}/landlord/profile`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) return;

        const nameEl   = document.getElementById('propertyNameDisplay');
        const locEl    = document.getElementById('propertyLocationDisplay');
        const mgrEl    = document.getElementById('landlordNameDisplay');
        const badgeEl  = document.getElementById('payStatusBadge');
        const dotEl    = document.getElementById('payStatusDot');
        const textEl   = document.getElementById('payStatusText');
        const setupBtn = document.getElementById('setupPayBtn');
        const chipEl   = document.getElementById('landlordChip');

        const activeProp = (data.properties || []).find(p => p._id === getPropertyId())
                        || (data.properties || [])[0];

        if (nameEl) nameEl.textContent = activeProp ? activeProp.name : (data.propertyName || 'Your Property');
        if (locEl)  locEl.innerHTML    = `<span>📍</span> ${activeProp ? (activeProp.location || '—') : (data.propertyLocation || '—')}`;
        if (mgrEl)  mgrEl.innerHTML    = `<span>👤</span> Managed by ${data.name || '—'}`;
        if (chipEl) chipEl.textContent = data.name || 'Landlord';

        // ── Update full-width topbar property strip ──
        const topbarEl = document.getElementById('topbarPropertyDisplay');
        if (topbarEl) {
            const displayName = activeProp
                ? (activeProp.name + (activeProp.location ? '  ·  📍 ' + activeProp.location : ''))
                : (data.propertyName || '—');
            topbarEl.textContent = displayName;
        }

        const anyConfigured    = (data.properties || []).some(p => p.paymentConfigured);
        const activeConfigured = activeProp ? activeProp.paymentConfigured : false;

        if (activeConfigured) {
            if (badgeEl) { badgeEl.className = 'pay-status-badge active'; }
            if (dotEl)   { dotEl.className   = 'pay-status-dot active'; }
            if (textEl)  { textEl.textContent = '🟢 Payments Active'; }
            if (setupBtn){ setupBtn.style.display = 'none'; }
            const payBanner = document.getElementById('payConfigBanner');
            if (payBanner) payBanner.classList.add('hidden');
        } else {
            if (badgeEl) { badgeEl.className = 'pay-status-badge inactive'; }
            if (dotEl)   { dotEl.className   = 'pay-status-dot inactive'; }
            if (textEl)  { textEl.textContent = '🔴 Payments Not Configured'; }
            if (setupBtn){ setupBtn.style.display = 'inline-flex'; }
            const payBanner = document.getElementById('payConfigBanner');
            if (payBanner) payBanner.classList.remove('hidden');
        }

        localStorage.setItem('paymentConfigured',  anyConfigured   ? 'true' : 'false');
        localStorage.setItem('onboardingComplete', data.onboardingComplete ? 'true' : 'false');

        return data;
    } catch (err) {
        console.error('loadLandlordProfile error:', err.message);
    }
}

function checkOnboarding() {
    const onboardingComplete = localStorage.getItem('onboardingComplete');
    if (onboardingComplete === 'false') {
        setTimeout(() => { openModal('modal-onboarding'); }, 800);
    }
}

async function skipOnboarding() {
    closeModal('modal-onboarding');
    try {
        await fetch(`${API}/landlord/complete-onboarding`, { method: 'POST', headers: authHeaders() });
        localStorage.setItem('onboardingComplete', 'true');
    } catch (err) {
        console.error('skipOnboarding error:', err.message);
    }
}


// ═══════════════════════════════════════════════════════
//  PAYMENT SETUP — OTP & 30-day limit panel system
//
//  Three panels inside #modal-pay-setup:
//    Panel A (paySetupPanelStatus)  — already configured; shows last-updated + OTP button
//    Panel B (paySetupPanelOtp)     — OTP entry after email is sent
//    Panel C (paySetupPanelForm)    — credential fields (first setup OR after OTP verified)
//
//  Backend endpoints needed:
//    POST /landlord/payment-otp       → { success, message, attemptsRemaining }
//    POST /landlord/setup-payments    → accepts optional `otp` field when editing
//    Property model needs:  paymentLastUpdated: { type: Date }
// ═══════════════════════════════════════════════════════

let _paySetupOtp     = null;   // OTP code entered by landlord
let _paySetupEditing = false;  // true when modifying existing credentials

function _resetPaySetupState() {
    _paySetupOtp     = null;
    _paySetupEditing = false;
}

function openPaySetupModal() {
    _resetPaySetupState();
    document.getElementById('modal-pay-setup').classList.add('open');
    // Small delay so the modal is visible before we evaluate which panel to show
    setTimeout(onSetupPropertyChange, 60);
}

function showPaySetupPanel(panel) {
    ['paySetupPanelStatus', 'paySetupPanelOtp', 'paySetupPanelForm'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const panelMap = { status: 'paySetupPanelStatus', otp: 'paySetupPanelOtp', form: 'paySetupPanelForm' };
    const el = document.getElementById(panelMap[panel]);
    if (el) el.style.display = 'block';
}

function onSetupPropertyChange() {
    const sel        = document.getElementById('setupPropertyId');
    const propertyId = sel ? sel.value : '';
    const titleEl    = document.getElementById('paySetupModalTitle');

    if (!propertyId) {
        // No property loaded yet — show form for first-time setup
        if (titleEl) titleEl.textContent = '⚙️ M-Pesa Payment Setup';
        showPaySetupPanel('form');
        return;
    }

    const prop = _propertiesCache.find(p => p._id === propertyId);
    if (!prop) return;

    // Reset OTP state whenever property selection changes
    _resetPaySetupState();

    if (prop.paymentConfigured) {
        // ── Panel A: already configured ──
        if (titleEl) titleEl.textContent = '⚙️ M-Pesa Credentials';

        // Compute 30-day eligibility
        const lastUpdated = prop.paymentLastUpdated;
        let   lastUpdStr  = 'Unknown';
        let   canUpdate   = true;
        let   nextUpdate  = null;

        if (lastUpdated) {
            const updDate   = new Date(lastUpdated);
            lastUpdStr      = updDate.toLocaleString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
            const daysSince = (Date.now() - updDate.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince < 30) {
                canUpdate  = false;
                nextUpdate = new Date(updDate.getTime() + 30 * 24 * 60 * 60 * 1000);
            }
        }

        const statusEl = document.getElementById('paySetupStatusInfo');
        if (statusEl) {
            statusEl.innerHTML = `
                <div style="background:var(--accent-dim);border:1px solid rgba(110,231,183,0.2);border-radius:8px;padding:0.75rem 1rem;margin-bottom:0.85rem">
                    <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem">
                        <span style="color:var(--accent);font-size:1.1rem">✅</span>
                        <span style="font-size:0.85rem;font-weight:600;color:var(--text)">M-Pesa Configured</span>
                    </div>
                    <div style="font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--text-dim)">
                        Last updated: ${lastUpdStr}
                    </div>
                </div>`;
        }

        const limitEl = document.getElementById('paySetupLimitMsg');
        const otpBtn  = document.getElementById('paySetupRequestOtpBtn');
        const rateEl  = document.getElementById('paySetupOtpRateMsg');

        if (rateEl) { rateEl.style.display = 'none'; rateEl.textContent = ''; }

        if (!canUpdate && nextUpdate) {
            if (limitEl) {
                limitEl.innerHTML = `
                    <div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);border-radius:8px;padding:0.65rem 0.9rem;margin-bottom:0.85rem;font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:var(--danger);line-height:1.65">
                        🔒 Credentials were recently updated.<br>
                        Next update allowed: <strong>${nextUpdate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>
                    </div>`;
            }
            if (otpBtn) { otpBtn.disabled = true; otpBtn.style.opacity = '0.45'; otpBtn.title = 'Update not allowed yet'; }
        } else {
            if (limitEl) limitEl.innerHTML = '';
            if (otpBtn)  { otpBtn.disabled = false; otpBtn.style.opacity = '1'; otpBtn.title = ''; }
        }

        showPaySetupPanel('status');

    } else {
        // ── Panel C: not yet configured — show form directly ──
        if (titleEl) titleEl.textContent = '⚙️ M-Pesa Payment Setup';
        showPaySetupPanel('form');
    }
}

async function requestPaymentOtp() {
    const btn    = document.getElementById('paySetupRequestOtpBtn');
    const rateEl = document.getElementById('paySetupOtpRateMsg');

    if (btn)    { btn.disabled = true; btn.textContent = '⏳ Sending OTP…'; }
    if (rateEl) { rateEl.style.display = 'none'; rateEl.textContent = ''; }

    try {
        // Backend: POST /landlord/payment-otp
        // Returns: { success: true, message }
        // Rate limit (3/day): { success: false, message }  →  HTTP 429
        const res  = await fetch(`${API}/landlord/payment-otp`, {
            method: 'POST', headers: authHeaders()
        });
        const data = await res.json();

        if (!res.ok) {
            const msg = data.message || 'Failed to send OTP. Please try again.';
            if (rateEl) { rateEl.textContent = msg; rateEl.style.display = 'block'; }
            showToast(msg, 'error');
            return;
        }

        showToast('OTP sent to your email 📧', 'success');
        const otpInput = document.getElementById('setupOtpCode');
        if (otpInput) otpInput.value = '';
        showPaySetupPanel('otp');

    } catch (err) {
        const msg = 'Network error — could not send OTP';
        if (rateEl) { rateEl.textContent = msg; rateEl.style.display = 'block'; }
        showToast(msg, 'error');
        console.error('requestPaymentOtp error:', err);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send OTP to Edit Credentials'; }
    }
}

function verifyPaymentOtp() {
    const code = (document.getElementById('setupOtpCode')?.value || '').trim();
    if (!code || code.length < 4) {
        showToast('Enter the OTP code from your email', 'warn');
        return;
    }

    // OTP is verified server-side during save — store locally to include in request
    _paySetupOtp     = code;
    _paySetupEditing = true;

    const titleEl = document.getElementById('paySetupModalTitle');
    if (titleEl) titleEl.textContent = '✏️ Edit M-Pesa Credentials';

    showPaySetupPanel('form');
    showToast('OTP accepted — enter your new credentials below', 'success');
}

async function savePaymentSetup() {
    const propertyId     = document.getElementById('setupPropertyId')?.value;
    const paybillNumber  = document.getElementById('setupPaybill')?.value.trim();
    const consumerKey    = document.getElementById('setupConsumerKey')?.value.trim();
    const consumerSecret = document.getElementById('setupConsumerSecret')?.value.trim();
    const passkey        = document.getElementById('setupPasskey')?.value.trim();

    if (!propertyId) { showToast('Select a property first', 'warn'); return; }
    if (!paybillNumber || !consumerKey || !consumerSecret || !passkey) {
        showToast('All payment fields are required', 'warn'); return;
    }

    // When editing existing credentials, OTP is required
    if (_paySetupEditing && !_paySetupOtp) {
        showToast('OTP verification required to update credentials', 'warn');
        showPaySetupPanel('otp');
        return;
    }

    const btn = document.getElementById('savePaySetupBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }

    try {
        // Backend: POST /landlord/setup-payments
        // First setup: no `otp` field needed
        // Editing:     `otp` field required; backend validates and enforces 30-day limit
        const body = { propertyId, paybillNumber, consumerKey, consumerSecret, passkey };
        if (_paySetupEditing && _paySetupOtp) body.otp = _paySetupOtp;

        const res  = await fetch(`${API}/landlord/setup-payments`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify(body)
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.message || 'Failed to save credentials', 'error');
            // If OTP was wrong (401) go back to OTP panel so landlord can retry
            if (res.status === 401 && _paySetupEditing) {
                _paySetupOtp = null;
                showPaySetupPanel('otp');
            }
            return;
        }

        showToast('Payment credentials saved securely 🔐', 'success');
        localStorage.setItem('paymentConfigured',  'true');
        localStorage.setItem('onboardingComplete', 'true');

        _resetPaySetupState();
        closeModal('modal-pay-setup');
        closeModal('modal-onboarding');

        await loadProperties();
        await loadLandlordProfile();

    } catch (err) {
        showToast('Network error', 'error');
        console.error('savePaymentSetup error:', err.message);
    } finally {
        const btnEl = document.getElementById('savePaySetupBtn');
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = '🔐 Save Credentials Securely'; }
    }
}


// ═══════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════

async function loadDashboard() {
    const month = document.getElementById('dashMonth')?.value.trim();
    if (!month) { showToast('Enter a month first', 'warn'); return; }

    const propertyId = getPropertyId();
    const url        = propertyId
        ? `${API}/dashboard/${encodeURIComponent(month)}?propertyId=${propertyId}`
        : `${API}/dashboard/${encodeURIComponent(month)}`;

    try {
        const res  = await fetch(url, { headers: authHeaders() });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Failed to load dashboard', 'error'); return; }

        document.getElementById('income').textContent       = data.totalIncome.toLocaleString();
        document.getElementById('arrears').textContent      = data.totalArrears.toLocaleString();
        document.getElementById('occupied').textContent     = data.occupiedHouses;
        document.getElementById('vacant').textContent       = data.vacantHouses;
        document.getElementById('totalTenants').textContent = data.totalTenants;

        if (data.landlordProfile) {
            const nameEl = document.getElementById('propertyNameDisplay');
            const locEl  = document.getElementById('propertyLocationDisplay');
            const mgrEl  = document.getElementById('landlordNameDisplay');
            if (nameEl) nameEl.textContent = data.property?.name || data.landlordProfile.propertyName || 'Your Property';
            if (locEl)  locEl.innerHTML    = `<span>📍</span> ${data.property?.location || data.landlordProfile.propertyLocation || '—'}`;
            if (mgrEl)  mgrEl.innerHTML    = `<span>👤</span> Managed by ${data.landlordProfile.name || '—'}`;
        }

        renderCharts(data);

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}


// ═══════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════

let _allTenants      = [];
let _movedOutTenants = [];

async function loadTenants() {
    try {
        const propertyId = getPropertyId();
        const url        = propertyId
            ? `${API}/tenants?propertyId=${propertyId}&status=active`
            : `${API}/tenants?status=active`;

        const res     = await fetch(url, { headers: authHeaders() });
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

async function loadMovedOutTenants() {
    try {
        const propertyId = getPropertyId();
        const url        = propertyId
            ? `${API}/tenants?propertyId=${propertyId}&status=moved_out`
            : `${API}/tenants?status=moved_out`;

        const res     = await fetch(url, { headers: authHeaders() });
        const tenants = await res.json();

        if (!res.ok) { showToast('Failed to load moved-out tenants', 'error'); return; }

        _movedOutTenants = tenants;
        renderMovedOutList(tenants);

    } catch (err) {
        showToast('Failed to load moved-out tenants', 'error');
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
    const name       = document.getElementById('newName').value.trim();
    const phone      = document.getElementById('newPhone').value.trim();
    const email      = document.getElementById('newEmail').value.trim();
    const dueDate    = document.getElementById('newDueDate').value || 5;
    const propertyId = getPropertyId();

    if (!name || !phone || !email) {
        showToast('Name, phone and email are required', 'warn'); return;
    }
    if (!propertyId) {
        showToast('No active property selected. Please select a property first.', 'warn'); return;
    }

    const btn = document.querySelector('#sec-addTenant .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating...'; }

    try {
        const res  = await fetch(`${API}/tenants/create`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ name, phone, email, dueDate: Number(dueDate), propertyId })
        });
        const data = await res.json();

        if (!res.ok) {
            if (data.upgrade) showUpgradePrompt(data.message);
            else              showToast(data.message || 'Failed to create tenant', 'error');
            return;
        }

        if (data.isReturning) {
            showToast(`${name} has been added to your property 🏠`, 'success');
        } else {
            showToast(`${name} created — welcome email sent 📧`, 'success');
        }

        ['newName', 'newPhone', 'newEmail', 'newDueDate'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });

        await loadTenants();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Create Tenant & Send Welcome Email'; }
    }
}

async function deleteTenant(id) {
    try {
        const res  = await fetch(`${API}/tenant/${id}`, { method: 'DELETE', headers: authHeaders() });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Delete failed', 'error'); return; }

        showToast('Tenant permanently deleted 🗑️', 'success');
        closeModal('modal-delete');

        document.getElementById('profileOutput').innerHTML =
            '<div class="empty-state"><span class="icon">👤</span>Select a tenant to view profile</div>';

        await loadTenants();
        await loadMovedOutTenants();

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

        showToast('Password reset — tenant will be forced to change on next login ✅', 'success');
        closeModal('modal-reset');

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

async function reactivateTenant(tenantId, houseId) {
    try {
        const res  = await fetch(`${API}/assign-house/${tenantId}/${houseId}`, {
            method: 'PUT', headers: authHeaders()
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.message || data.error || 'Reactivation failed', 'error');
            return false;
        }

        showToast(data.message || 'Tenant reactivated ✅', 'success');
        await loadTenants();
        await loadMovedOutTenants();
        await loadHouses();
        return true;

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
        return false;
    }
}


// ═══════════════════════════════════════
// HOUSES
// ═══════════════════════════════════════

let _allHouses = [];

async function loadHouses() {
    try {
        const propertyId = getPropertyId();
        const url        = propertyId
            ? `${API}/houses?propertyId=${propertyId}`
            : `${API}/houses`;

        const res    = await fetch(url, { headers: authHeaders() });
        const houses = await res.json();

        if (!res.ok) { showToast('Failed to load houses', 'error'); return; }

        const enriched = houses.map(h => {
            if (h.status === 'occupied' && (!h.tenantId || !h.tenantName)) {
                const tenant = (_allTenants || []).find(t =>
                    t.house && (t.house._id === h._id || t.house === h._id)
                );
                if (tenant) {
                    h.tenantId   = h.tenantId   || tenant._id;
                    h.tenantName = h.tenantName || tenant.name;
                }
            }
            return h;
        });

        _allHouses = enriched;
        renderHouseGrid(enriched);
        populateHouseSelects(enriched);

    } catch (err) {
        showToast('Failed to load houses', 'error');
        console.error(err);
    }
}

async function addHouse() {
    const name       = document.getElementById('houseName').value.trim();
    const rent       = document.getElementById('houseRent').value;
    const propertyId = getPropertyId();

    if (!name || !rent) { showToast('Name and rent required', 'warn'); return; }
    if (!propertyId)    { showToast('No active property selected', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/houses`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ name, rent: Number(rent), propertyId })
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

function deleteHouse(id) {
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
        message: `Are you sure you want to permanently delete <strong>${houseName}</strong>?`,
        label:   'Delete House',
        type:    'danger',
        onConfirm: async () => {
            const res  = await fetch(`${API}/house/${id}`, { method: 'DELETE', headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) { showToast(data.message || 'Delete failed', 'error'); return; }
            showToast('House deleted ✅', 'success');
            await loadHouses();
        }
    });
}

// ── UPDATED: shows a confirmation modal with tenant + house details
//    before calling the API. Selection is saved to localStorage for
//    persistence across page refreshes (onchange handlers in HTML). ──
function assignHouse() {
    const tenantId = document.getElementById('tenantSelect').value;
    const houseId  = document.getElementById('houseSelect').value;
    if (!tenantId || !houseId) { showToast('Select both tenant and house', 'warn'); return; }

    const tenant = _allTenants.find(t => t._id === tenantId);
    const house  = _allHouses.find(h => h._id === houseId);

    openDangerModal({
        icon:    '🔑',
        title:   'Confirm House Assignment',
        message: `Assign <strong>${tenant?.name || '—'}</strong> to <strong>${house?.name || '—'}</strong>?<br><br>
                  <span style="font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--text-muted)">
                    Monthly Rent: Ksh ${Number(house?.rent || 0).toLocaleString()}
                  </span>`,
        label:   '🔑 Assign House',
        type:    'warn',
        onConfirm: async () => {
            const res  = await fetch(`${API}/assign-house/${tenantId}/${houseId}`, {
                method: 'PUT', headers: authHeaders()
            });
            const data = await res.json();
            if (!res.ok) { showToast(data.message || data.error || 'Assign failed', 'error'); return; }
            showToast(data.message, 'success');
            // Clear saved selection after successful assignment
            localStorage.removeItem('assignTenantId');
            localStorage.removeItem('assignHouseId');
            await loadHouses();
            await loadTenants();
        }
    });
}

function moveOutTenant() {
    const tenantId   = document.getElementById('moveOutSelect').value;
    if (!tenantId) { showToast('Select a tenant', 'warn'); return; }
    const sel        = document.getElementById('moveOutSelect');
    const tenantName = sel.options[sel.selectedIndex]?.text || 'this tenant';

    openDangerModal({
        icon:    '🚪',
        title:   'Move Out Tenant',
        message: `Are you sure you want to move out <strong>${tenantName}</strong>?<br><br>Their house will be marked as <strong>available</strong> and they will receive a move-out notification email. Their login and payment history are preserved.`,
        label:   'Move Out',
        type:    'warn',
        onConfirm: async () => {
            const res  = await fetch(`${API}/move-out/${tenantId}`, { method: 'PUT', headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) { showToast(data.message || data.error || 'Move out failed', 'error'); return; }
            showToast(data.message, 'success');
            await loadHouses();
            await loadTenants();
            await loadMovedOutTenants();
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
    if (!tenantId || !month) { if (box) box.style.display = 'none'; return; }

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
            ? Math.min(100, Math.round((data.totalPaid / data.rentAmount) * 100)) : 0;
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

async function onPayTenantChange() {
    const tenantId     = document.getElementById('payTenantSelect').value;
    const monthInput   = document.getElementById('month');
    const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

    if (!tenantId) {
        monthInput.value = currentMonth;
        loadPaymentSummary();
        return;
    }

    try {
        const propertyId = getPropertyId();
        let url = `${API}/arrears`;
        if (propertyId) url += `?propertyId=${propertyId}`;

        const res  = await fetch(url, { headers: authHeaders() });
        const data = await res.json();

        if (res.ok && Array.isArray(data)) {
            const tenantArrear = data.find(a => String(a.tenantId) === String(tenantId));
            if (tenantArrear && tenantArrear.balance > 0) {
                monthInput.value = tenantArrear.month;
                loadPaymentSummary();
                return;
            }
        }
    } catch (err) {
        console.error('onPayTenantChange arrears lookup error:', err);
    }

    monthInput.value = currentMonth;
    loadPaymentSummary();
}

async function loadModalSummary() {
    const tenantId = document.getElementById('payModalTenantId').value;
    const month    = document.getElementById('payModalMonth').value.trim();
    const box      = document.getElementById('modalSummaryBox');
    if (!tenantId || !month) { if (box) box.style.display = 'none'; return; }

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
            ? Math.min(100, Math.round((data.totalPaid / data.rentAmount) * 100)) : 0;
        const bar = document.getElementById('modalProgressBar');
        bar.style.width = `${pct}%`;
        bar.className   = `payment-progress-bar ${data.status === 'paid' ? 'paid' : 'partial'}`;

        if (data.status !== 'paid') document.getElementById('payModalAmount').value = data.balance;
        box.style.display = 'block';

    } catch (err) {
        console.error('loadModalSummary error:', err);
        if (document.getElementById('modalSummaryBox'))
            document.getElementById('modalSummaryBox').style.display = 'none';
    }
}


// ═══════════════════════════════════════
// RECEIPTS
// ═══════════════════════════════════════

async function loadAutoReceipt(paymentId) {
    try {
        const res  = await fetch(`${API}/receipt/${paymentId}`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) return;
        renderReceipt(data, 'autoReceipt');
    } catch (err) { console.error('loadAutoReceipt error:', err); }
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
    const propertyId = getPropertyId();

    let url = month
        ? `${API}/arrears/${encodeURIComponent(month)}`
        : `${API}/arrears`;

    if (propertyId) {
        url += `${url.includes('?') ? '&' : '?'}propertyId=${propertyId}`;
    }

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
// MESSAGES — API calls
// ═══════════════════════════════════════

async function loadAdminChat(tenantId) {
    const id = tenantId || _activeChatTenantId;
    if (!id) return;

    try {
        const res  = await fetch(`${API}/messages/thread/${id}`, { headers: authHeaders() });
        const msgs = await res.json();
        if (!res.ok) { showToast('Failed to load messages', 'error'); return; }

        renderChatMessages(msgs);

        await fetch(`${API}/messages/read/${id}`, { method: 'PUT', headers: authHeaders() });

        _msgUnreadMap[id] = 0;
        const item = document.getElementById(`msg-item-${id}`);
        if (item) item.querySelector('.msg-unread-dot')?.remove();

        _refreshSidebarMsgBadge();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    }
}

async function sendAdminMessage() {
    const tenantId = _activeChatTenantId;
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
        await loadAdminChat(tenantId);
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
        const propertyId = getPropertyId();
        const url = propertyId
            ? `${API}/messages/unread?propertyId=${propertyId}`
            : `${API}/messages/unread`;

        const res  = await fetch(url, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) return;

        updateUnreadBadges(data);
        _refreshSidebarMsgBadge();

    } catch (err) { console.error('loadUnread error:', err); }
}

function _refreshSidebarMsgBadge() {
    const total    = Object.values(_msgUnreadMap).reduce((s, c) => s + c, 0);
    _msgUnreadTotal = total;   // ← keep in sync for bell

    const badge    = document.getElementById('msgBadge');
    const navBadge = document.querySelector('.nav-item[onclick*="messages"] .nav-badge');
    if (total > 0) {
        if (badge)    { badge.textContent = total; badge.style.display = 'inline-block'; }
        if (navBadge) { navBadge.textContent = total; navBadge.style.display = 'inline-block'; }
    } else {
        if (badge)    badge.style.display = 'none';
        if (navBadge) navBadge.style.display = 'none';
    }
    _updateNotifBell();
}


// ═══════════════════════════════════════
// RULES
// ═══════════════════════════════════════

async function addRule() {
    const title      = document.getElementById('ruleTitle').value.trim();
    const content    = document.getElementById('ruleContent').value.trim();
    const propertyId = getPropertyId();

    if (!title || !content) { showToast('Title and content required', 'warn'); return; }
    if (!propertyId)        { showToast('No active property selected', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/rules`, {
            method: 'POST', headers: authHeaders(),
            body:   JSON.stringify({ title, content, propertyId })
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

function deleteRule(id) {
    let ruleTitle = 'this rule';
    document.querySelectorAll('#rulesList button').forEach(btn => {
        if (btn.getAttribute('onclick')?.includes(id)) {
            const titleEl = btn.closest('div[style]')?.querySelector('[style*="font-weight:600"]');
            if (titleEl) ruleTitle = titleEl.textContent;
        }
    });

    openDangerModal({
        icon:    '📜',
        title:   'Delete Rule',
        message: `Are you sure you want to delete <strong>${ruleTitle}</strong>?<br><br>Tenants will no longer see this rule.`,
        label:   'Delete Rule',
        type:    'danger',
        onConfirm: async () => {
            const res  = await fetch(`${API}/rules/${id}`, { method: 'DELETE', headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) { showToast(data.message || 'Delete failed', 'error'); return; }
            showToast('Rule deleted ✅', 'success');
            await loadRules();
        }
    });
}

async function loadRules() {
    try {
        const propertyId = getPropertyId();
        if (!propertyId) { renderRules([]); return; }

        const res   = await fetch(`${API}/rules?propertyId=${propertyId}`, { headers: authHeaders() });
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
    const message    = document.getElementById('announcementText').value.trim();
    const propertyId = getPropertyId();

    if (!message)    { showToast('Write something first', 'warn'); return; }
    if (!propertyId) { showToast('No active property selected', 'warn'); return; }

    try {
        const res  = await fetch(`${API}/announcements`, {
            method: 'POST', headers: authHeaders(),
            body:   JSON.stringify({ message, propertyId })
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

function deleteAnnouncement(id) {
    openDangerModal({
        icon:    '📢',
        title:   'Delete Announcement',
        message: `Are you sure you want to delete this announcement?<br><br>It will be permanently removed and tenants will no longer see it.`,
        label:   'Delete Announcement',
        type:    'danger',
        onConfirm: async () => {
            const res  = await fetch(`${API}/announcements/${id}`, { method: 'DELETE', headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) { showToast(data.message || 'Delete failed', 'error'); return; }
            showToast('Announcement deleted ✅', 'success');
            await loadAnnouncements();
        }
    });
}

async function loadAnnouncements() {
    try {
        const propertyId = getPropertyId();
        if (!propertyId) { renderAnnouncements([]); return; }

        const res  = await fetch(`${API}/announcements?propertyId=${propertyId}`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) return;
        renderAnnouncements(data);
    } catch (err) { console.error('loadAnnouncements error:', err); }
}


// ═══════════════════════════════════════
// MAINTENANCE MODE
// ═══════════════════════════════════════

async function syncMaintenanceToggle() {
    try {
        const res    = await fetch(`${API}/maintenance`, { headers: authHeaders() });
        const data   = await res.json();
        const toggle = document.getElementById('maintenanceToggle');
        const chip   = document.getElementById('maintenanceChip');
        if (toggle) toggle.checked     = data.maintenanceMode;
        if (chip)   chip.style.display = data.maintenanceMode ? 'inline-block' : 'none';
    } catch (err) { console.error('Could not sync maintenance state:', err.message); }
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
        showToast(on ? '🔧 Maintenance mode ON' : '✅ Maintenance mode OFF', on ? 'warn' : 'success');
    } catch (err) {
        showToast('Network error', 'error');
        document.getElementById('maintenanceToggle').checked = !on;
        console.error(err);
    }
}


// ═══════════════════════════════════════
// MODAL TRIGGERS (tenant context menu)
// ═══════════════════════════════════════

async function openPayModal(tenant) {
    document.getElementById('payModalTenantId').value         = tenant._id;
    document.getElementById('payModalTenantName').textContent = `Paying for: ${tenant.name}`;
    document.getElementById('payModalAmount').value           = '';
    document.getElementById('payModalNote').value             = '';
    document.getElementById('modalSummaryBox').style.display  = 'none';

    const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

    let prefillMonth = currentMonth;
    try {
        const propertyId = getPropertyId();
        let url = `${API}/arrears`;
        if (propertyId) url += `?propertyId=${propertyId}`;

        const res  = await fetch(url, { headers: authHeaders() });
        const data = await res.json();

        if (res.ok && Array.isArray(data)) {
            const tenantArrear = data.find(a => String(a.tenantId) === String(tenant._id));
            if (tenantArrear && tenantArrear.balance > 0) {
                prefillMonth = tenantArrear.month;
            }
        }
    } catch (err) {
        console.error('openPayModal arrears lookup error:', err);
    }

    document.getElementById('payModalMonth').value = prefillMonth;

    openModal('modal-pay');
    loadModalSummary();
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
// INQUIRIES — API calls
// ═══════════════════════════════════════

let _inquiryPage  = 1;
const INQ_LIMIT   = 20;
let _inquiryTotal = 0;
let _inquiryPages = 1;

async function loadInquiries() {
    const status     = document.getElementById('inquiryStatusFilter')?.value || '';
    const propertyId = getPropertyId();
    const tbody      = document.getElementById('inquiriesTable');

    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><span class="icon" style="font-size:1.4rem">⏳</span>Loading…</div></td></tr>`;
    }

    try {
        const params = new URLSearchParams({ page: _inquiryPage, limit: INQ_LIMIT });
        if (status)     params.set('status',     status);
        if (propertyId) params.set('propertyId', propertyId);

        const res  = await fetch(`${API}/inquiries?${params.toString()}`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed to load inquiries', 'error'); return; }

        _inquiryTotal = data.total  || 0;
        _inquiryPages = data.pages  || 1;

        const newEl  = document.getElementById('inqStatNew');
        const totEl  = document.getElementById('inqStatTotal');
        if (newEl) newEl.textContent = data.unreadCount ?? '—';
        if (totEl) totEl.textContent = _inquiryTotal;

        _loadInquiryContactedCount(propertyId);

        renderInquiriesTable(data.inquiries || []);
        _renderInquiryPagination();
        _updateInquiryBadge(data.unreadCount || 0);

    } catch (err) {
        console.error('loadInquiries error:', err);
        showToast('Network error loading inquiries', 'error');
    }
}

async function _loadInquiryContactedCount(propertyId) {
    try {
        const params = new URLSearchParams({ status: 'contacted', limit: 1, page: 1 });
        if (propertyId) params.set('propertyId', propertyId);
        const res  = await fetch(`${API}/inquiries?${params.toString()}`, { headers: authHeaders() });
        const data = await res.json();
        const el   = document.getElementById('inqStatContacted');
        if (el && res.ok) el.textContent = data.total ?? '—';
    } catch {}
}

function _renderInquiryPagination() {
    const wrap    = document.getElementById('inquiryPagination');
    const infoEl  = document.getElementById('inquiryPageInfo');
    const prevBtn = document.getElementById('inqPrevBtn');
    const nextBtn = document.getElementById('inqNextBtn');
    if (!wrap) return;

    if (_inquiryPages <= 1) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';

    const start = (_inquiryPage - 1) * INQ_LIMIT + 1;
    const end   = Math.min(_inquiryPage * INQ_LIMIT, _inquiryTotal);
    if (infoEl) infoEl.textContent = `Showing ${start}–${end} of ${_inquiryTotal}`;
    if (prevBtn) prevBtn.disabled  = _inquiryPage <= 1;
    if (nextBtn) nextBtn.disabled  = _inquiryPage >= _inquiryPages;
}

function inquiryPage(dir) {
    const next = _inquiryPage + dir;
    if (next < 1 || next > _inquiryPages) return;
    _inquiryPage = next;
    loadInquiries();
}

function _updateInquiryBadge(count) {
    _inquiryNewCount = count || 0;   // ← keep in sync for bell

    const badge = document.getElementById('inquiryBadge');
    if (!badge) return;
    badge.textContent   = count;
    badge.style.display = count > 0 ? 'inline-block' : 'none';

    _updateNotifBell();
}

async function loadInquiryBadge() {
    try {
        const res  = await fetch(`${API}/inquiries/unread-count`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) return;
        _updateInquiryBadge(data.count || 0);
    } catch {}
}

// silent = true suppresses toast (used for auto-mark-read)
async function updateInquiryStatus(id, status, silent = false) {
    const notes = document.getElementById('inqDetailNotes')?.value?.trim() || undefined;
    try {
        const body = { status };
        if (notes !== undefined) body.notes = notes;

        const res  = await fetch(`${API}/inquiries/${id}/status`, {
            method:  'PUT',
            headers: authHeaders(),
            body:    JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
            if (!silent) showToast(data.message || 'Update failed', 'error');
            return;
        }
        if (!silent) showToast(`Marked as ${status} ✅`, 'success');
        closeModal('modal-inquiry-detail');
        loadInquiries();
        loadInquiryBadge();
    } catch (err) {
        if (!silent) showToast('Network error', 'error');
        console.error(err);
    }
}

function deleteInquiry(id) {
    // Close inquiry detail modal first so danger modal is not obscured.
    // #modal-danger.open { z-index: 9998 } in CSS also guarantees it floats on top,
    // but closing the detail modal first is the cleanest UX.
    closeModal('modal-inquiry-detail');

    openDangerModal({
        icon:    '📩',
        title:   'Delete Inquiry',
        message: 'Permanently delete this inquiry? This cannot be undone.',
        label:   'Delete',
        type:    'danger',
        onConfirm: async () => {
            const res  = await fetch(`${API}/inquiries/${id}`, { method: 'DELETE', headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) { showToast(data.message || 'Delete failed', 'error'); return; }
            showToast('Inquiry deleted ✅', 'success');
            loadInquiries();
            loadInquiryBadge();
        }
    });
}


// ═══════════════════════════════════════
// LISTING CONTROLS — API calls
// ═══════════════════════════════════════

async function togglePropertyListing(propertyId, isListed) {
    try {
        const res  = await fetch(`${API}/properties/${propertyId}/listing`, {
            method:  'PUT',
            headers: authHeaders(),
            body:    JSON.stringify({ isListed })
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.message || 'Update failed', 'error');
            await loadProperties();
            return;
        }
        showToast(data.message, 'success');
        await loadProperties();
    } catch (err) {
        showToast('Network error', 'error');
        await loadProperties();
        console.error(err);
    }
}

async function saveListingDescription() {
    const propertyId    = document.getElementById('listingEditorPropertyId')?.value;
    const description   = (document.getElementById('listingEditorDesc')?.value || '').trim();
    const pendingListed = document.getElementById('listingEditorPendingListed')?.value === 'true';

    if (!propertyId) { showToast('No property selected', 'warn'); return; }

    if (pendingListed && !description) {
        showToast('Please add a description before making this property visible', 'warn');
        document.getElementById('listingEditorDesc')?.focus();
        return;
    }

    const btn = document.getElementById('listingEditorSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }

    try {
        const body = { description };
        if (pendingListed) body.isListed = true;

        const res  = await fetch(`${API}/properties/${propertyId}/listing`, {
            method:  'PUT',
            headers: authHeaders(),
            body:    JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Save failed', 'error'); return; }

        showToast(data.message, 'success');
        closeModal('modal-listing-editor');
        await loadProperties();

    } catch (err) {
        showToast('Network error', 'error');
        console.error(err);
    } finally {
        const btnEl = document.getElementById('listingEditorSaveBtn');
        if (btnEl) {
            btnEl.disabled    = false;
            btnEl.textContent = pendingListed ? '💾 Save & Make Visible' : '💾 Save Description';
        }
    }
}

// ═══════════════════════════════════════════════════════
//  PATCH FILE — script.js  (one targeted replacement)
// ═══════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────
// REPLACEMENT — handlePhotoUpload()
// Replaces the entire function so it:
//  • iterates over ALL selected files (FileList)
//  • validates each file individually (type + size)
//  • stops uploading once the property hits 5 photos
//  • gives clear per-file feedback
//
// FIND the entire existing handlePhotoUpload function:
//
//   async function handlePhotoUpload(event) { ... }
//
// REPLACE WITH the function below:
// ─────────────────────────────────────────────────────

async function handlePhotoUpload(event) {
    const files      = Array.from(event.target.files || []);
    const propertyId = document.getElementById('listingEditorPropertyId')?.value;

    // Reset the input immediately so the same file(s) can be re-selected if needed
    event.target.value = '';

    if (!files.length || !propertyId) return;

    const prop         = _propertiesCache.find(p => p._id === propertyId);
    const currentCount = (prop?.photos || []).length;
    const slotsLeft    = 5 - currentCount;

    if (slotsLeft <= 0) {
        showToast('Maximum 5 photos per property', 'warn');
        return;
    }

    // Warn if selection exceeds remaining slots; upload what we can
    const toUpload = files.slice(0, slotsLeft);
    if (files.length > slotsLeft) {
        showToast(
            `Only ${slotsLeft} slot${slotsLeft !== 1 ? 's' : ''} remaining — uploading first ${toUpload.length} photo${toUpload.length !== 1 ? 's' : ''}`,
            'warn'
        );
    }

    // Validate all files before starting any upload
    for (const file of toUpload) {
        if (!file.type.startsWith('image/')) {
            showToast(`"${file.name}" is not an image — skipped`, 'error');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            showToast(`"${file.name}" exceeds 5 MB — skipped`, 'error');
            return;
        }
    }

    const progress  = document.getElementById('listingEditorUploadProgress');
    const uploadBtn = document.getElementById('listingEditorUploadLabel');
    if (progress)  progress.style.display  = 'block';
    if (uploadBtn) uploadBtn.style.opacity = '0.4';

    let lastPhotos = prop?.photos || [];
    let uploaded   = 0;
    let failed     = 0;

    for (let i = 0; i < toUpload.length; i++) {
        const file = toUpload[i];

        // Update progress text for multi-file uploads
        if (toUpload.length > 1 && progress) {
            progress.textContent = `⏳ Uploading ${i + 1} of ${toUpload.length}…`;
        } else if (progress) {
            progress.textContent = '⏳ Uploading…';
        }

        try {
            const formData = new FormData();
            formData.append('photo', file);

            const res  = await fetch(`${API}/properties/${propertyId}/photos`, {
                method:  'POST',
                headers: { 'Authorization': 'Bearer ' + getToken() },
                body:    formData
            });
            const data = await res.json();

            if (!res.ok) {
                showToast(data.message || `Failed to upload "${file.name}"`, 'error');
                failed++;
                continue;
            }

            lastPhotos = data.photos || lastPhotos;
            if (prop) prop.photos = lastPhotos;
            uploaded++;

        } catch (err) {
            showToast(`Network error uploading "${file.name}"`, 'error');
            console.error('handlePhotoUpload error:', err);
            failed++;
        }
    }

    // Final status toast
    if (uploaded > 0 && failed === 0) {
        showToast(
            uploaded === 1
                ? 'Photo uploaded ✅'
                : `${uploaded} photos uploaded ✅`,
            'success'
        );
    } else if (uploaded > 0 && failed > 0) {
        showToast(`${uploaded} uploaded, ${failed} failed`, 'warn');
    }

    // Re-render photo grid with final state
    _renderListingEditorPhotos(lastPhotos, propertyId);
    loadProperties().catch(() => {});

    if (progress)  progress.style.display  = 'none';
    if (uploadBtn) uploadBtn.style.opacity  = '1';
}


async function handlePhotoDelete(propertyId, photoUrl) {
    const prop = _propertiesCache.find(p => p._id === propertyId);

    if (!confirm('Remove this photo? This cannot be undone.')) return;

    try {
        const res  = await fetch(`${API}/properties/${propertyId}/photos`, {
            method:  'DELETE',
            headers: authHeaders(),
            body:    JSON.stringify({ photoUrl })
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.message || 'Delete failed', 'error');
            return;
        }

        showToast('Photo removed ✅', 'success');

        if (prop) prop.photos = data.photos || [];
        _renderListingEditorPhotos(prop ? prop.photos : [], propertyId);
        loadProperties().catch(() => {});

    } catch (err) {
        showToast('Network error', 'error');
        console.error('handlePhotoDelete error:', err);
    }
}


// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

window.addEventListener('DOMContentLoaded', async () => {
    const saved = localStorage.getItem('admin-theme') || 'dark';
    setTheme(saved);

    syncMaintenanceToggle();

    const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    const dashMonthEl  = document.getElementById('dashMonth');
    if (dashMonthEl) dashMonthEl.value = currentMonth;

    const monthEl = document.getElementById('month');
    if (monthEl && !monthEl.value) monthEl.value = currentMonth;

    await loadLandlordProfile();
    await loadProperties();
    checkOnboarding();

    loadTenants();
    loadMovedOutTenants();
    loadHouses();
    loadAnnouncements();
    loadRules();
    loadUnread();
    loadDashboard();
    loadInquiryBadge();
});


// ═══════════════════════════════════════
// POLLING
// ═══════════════════════════════════════

setInterval(loadUnread,           15000);
setInterval(loadHouses,           30000);
setInterval(loadArrears,          60000);
setInterval(loadTenants,          30000);
setInterval(loadMovedOutTenants,  30000);
setInterval(loadLandlordProfile,  60000);
setInterval(loadProperties,      120000);
setInterval(loadInquiryBadge,     30000);

// Poll active chat thread every 15 seconds
setInterval(() => {
    if (_activeChatTenantId && document.getElementById('sec-messages')?.classList.contains('active')) {
        loadAdminChat(_activeChatTenantId);
    }
}, 15000);