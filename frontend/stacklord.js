// ═══════════════════════════════════════════════════════
//  stacklord.js — Stacklord Console Logic
//  Works with stacklord.html
// ═══════════════════════════════════════════════════════

const API = window.API;

// ── Master key stored in sessionStorage (cleared on tab close) ──
let STACKLORD_KEY = '';

// ── Chart instance ──
let subChartInstance = null;

// ═══════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════

function login() {
    const key = document.getElementById('masterKey').value.trim();
    if (!key) {
        showLoginError('Enter your master key');
        return;
    }

    // Store key and verify by hitting a protected endpoint
    STACKLORD_KEY = key;
    sessionStorage.setItem('stacklord_key', key);

    verifyKey(key);
}

async function verifyKey(key) {
    try {
        const res  = await fetch(`${API}/stacklord/stats`, {
            headers: { 'x-stacklord-key': key }
        });

        if (res.status === 401) {
            STACKLORD_KEY = '';
            sessionStorage.removeItem('stacklord_key');
            showLoginError('Invalid master key ❌');
            return;
        }

        // Key valid — show console
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('mainApp').style.display     = 'flex';
        document.getElementById('mainApp').style.flexDirection = 'column';

        loadOverview();
        loadPlans();

    } catch (err) {
        showLoginError('Cannot reach server. Check your connection.');
    }
}

function showLoginError(msg) {
    document.getElementById('loginError').textContent = msg;
    setTimeout(() => {
        document.getElementById('loginError').textContent = '';
    }, 3500);
}

function logout() {
    STACKLORD_KEY = '';
    sessionStorage.removeItem('stacklord_key');
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('mainApp').style.display     = 'none';
    document.getElementById('masterKey').value           = '';
}

// Auto-login if key is in sessionStorage
window.addEventListener('DOMContentLoaded', () => {
    const saved = sessionStorage.getItem('stacklord_key');
    if (saved) {
        STACKLORD_KEY = saved;
        verifyKey(saved);
    }
});

// ═══════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════

function showSection(name) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    document.getElementById('sec-' + name).classList.add('active');

    document.querySelectorAll('.nav-item').forEach(n => {
        if (n.getAttribute('onclick')?.includes(`'${name}'`)) {
            n.classList.add('active');
        }
    });

    const titles = {
        overview: 'Platform Overview',
        landlord: 'Landlord Details',
        payments: 'Subscription Payments',
        plans:    'Subscription Plans',
        controls: 'Subscription Controls',
        danger:   'Danger Zone'
    };

    document.getElementById('topbarTitle').textContent = titles[name] || name;

    // Load data for section
    if (name === 'overview') loadOverview();
    if (name === 'landlord') loadLandlord();
    if (name === 'payments') loadSubPayments();
    if (name === 'plans')    loadPlans();
    if (name === 'controls') loadControlsInfo();
}

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════

function stacklordFetch(url, options = {}) {
    return fetch(`${API}${url}`, {
        ...options,
        headers: {
            'Content-Type':     'application/json',
            'x-stacklord-key':  STACKLORD_KEY,
            ...(options.headers || {})
        }
    });
}

function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className   = 'show ' + type;
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.className = ''; }, 3500);
}

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function statusBadge(status) {
    const map = {
        trial:     `<span class="status-badge badge-trial">    <span class="status-badge-dot"></span> Trial     </span>`,
        active:    `<span class="status-badge badge-active">   <span class="status-badge-dot"></span> Active    </span>`,
        grace:     `<span class="status-badge badge-grace">    <span class="status-badge-dot"></span> Grace     </span>`,
        expired:   `<span class="status-badge badge-expired">  <span class="status-badge-dot"></span> Expired   </span>`,
        suspended: `<span class="status-badge badge-suspended"><span class="status-badge-dot"></span> Suspended </span>`
    };
    return map[status] || `<span class="status-badge">${status}</span>`;
}

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatKsh(n) {
    return 'Ksh ' + Number(n || 0).toLocaleString();
}

function daysColor(days) {
    if (days > 14) return 'var(--green)';
    if (days > 7)  return 'var(--amber)';
    return 'var(--red)';
}

// ═══════════════════════════════════════════════════════
//  OVERVIEW
// ═══════════════════════════════════════════════════════

async function loadOverview() {
    try {
        const res  = await stacklordFetch('/stacklord/stats');
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Failed to load stats', 'error'); return; }

        const { landlord, stats } = data;

        document.getElementById('statRevenue').textContent    = formatKsh(stats.totalRevenue);
        document.getElementById('statTenants').textContent    = stats.totalTenants;
        document.getElementById('statHouses').textContent     = stats.totalHouses;
        document.getElementById('statSubPayments').textContent = stats.totalPayments;
        document.getElementById('statDays').textContent       = stats.daysRemaining;
        document.getElementById('statDays').style.color       = daysColor(stats.daysRemaining);

        // Overview subscription card
        if (landlord) {
            let expiryDate = landlord.subscriptionExpiry || landlord.trialEndsAt || landlord.gracePeriodUntil;
            document.getElementById('overviewSubStatus').innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem">
                  <div>
                    <div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.25rem">${landlord.name} · ${landlord.email}</div>
                    <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">
                      ${statusBadge(landlord.subscriptionStatus)}
                      ${landlord.subscriptionStatus === 'suspended'
                        ? `<span style="font-size:0.75rem;color:var(--red)">Reason: ${landlord.suspendedReason || '—'}</span>`
                        : ''}
                    </div>
                  </div>
                  <div style="text-align:right">
                    <div style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;color:var(--text-dim)">Expires</div>
                    <div style="font-family:'JetBrains Mono',monospace;font-size:0.85rem;color:var(--text)">${formatDate(expiryDate)}</div>
                    <div style="font-size:0.75rem;color:${daysColor(stats.daysRemaining)};margin-top:0.15rem">${stats.daysRemaining} days remaining</div>
                  </div>
                </div>
                ${stats.daysRemaining <= 7 && landlord.subscriptionStatus !== 'suspended'
                  ? `<div style="margin-top:1rem;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);border-radius:8px;padding:0.75rem 1rem;font-size:0.8rem;color:var(--red)">
                       ⚠️ Subscription expiring soon — consider notifying the landlord.
                     </div>`
                  : ''}
            `;
        }

    } catch (err) {
        showToast('Network error', 'error');
    }
}

// ═══════════════════════════════════════════════════════
//  LANDLORD DETAILS
// ═══════════════════════════════════════════════════════

async function loadLandlord() {
    try {
        const res  = await stacklordFetch('/stacklord/stats');
        const data = await res.json();
        if (!res.ok) return;

        const { landlord, stats } = data;
        if (!landlord) return;

        let expiryDate = null;
        if (landlord.subscriptionStatus === 'trial')  expiryDate = landlord.trialEndsAt;
        if (landlord.subscriptionStatus === 'active') expiryDate = landlord.subscriptionExpiry;
        if (landlord.subscriptionStatus === 'grace')  expiryDate = landlord.gracePeriodUntil;

        const pct = Math.min(100, Math.round((stats.daysRemaining / 30) * 100));
        const barClass = stats.daysRemaining > 14 ? 'green' : stats.daysRemaining > 7 ? 'amber' : 'red';

        document.getElementById('landlordSubCard').innerHTML = `
            <div style="margin-bottom:1.25rem">
              <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.4rem;color:var(--text);margin-bottom:0.25rem">${landlord.name}</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;color:var(--text-dim)">${landlord.email}</div>
            </div>
            <div class="sub-card-row"><span class="sub-card-label">Status</span>       <span>${statusBadge(landlord.subscriptionStatus)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Plan</span>          <span class="sub-card-value">${landlord.subscriptionPlan?.name || '—'}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Trial Ends</span>    <span class="sub-card-value">${formatDate(landlord.trialEndsAt)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Sub Expiry</span>    <span class="sub-card-value">${formatDate(landlord.subscriptionExpiry)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Grace Until</span>   <span class="sub-card-value">${formatDate(landlord.gracePeriodUntil)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Last Payment</span>  <span class="sub-card-value">${formatDate(landlord.lastSubscriptionPayment)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Days Remaining</span><span class="sub-card-value" style="color:${daysColor(stats.daysRemaining)}">${stats.daysRemaining} days</span></div>
            ${landlord.suspendedReason
              ? `<div class="sub-card-row"><span class="sub-card-label">Suspended Reason</span><span class="sub-card-value" style="color:var(--red)">${landlord.suspendedReason}</span></div>`
              : ''}
            <div style="margin-top:1rem">
              <div style="display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-dim);margin-bottom:0.35rem">
                <span>Subscription usage</span><span>${pct}%</span>
              </div>
              <div class="progress-track">
                <div class="progress-fill ${barClass}" style="width:${pct}%"></div>
              </div>
            </div>
        `;

        // Subscription timeline chart
        await loadSubChart();

    } catch (err) {
        showToast('Failed to load landlord details', 'error');
    }
}

async function loadSubChart() {
    try {
        const res  = await stacklordFetch('/stacklord/subscription-payments');
        const data = await res.json();
        if (!res.ok) return;

        const paid = data.filter(p => p.status === 'paid').slice(-8).reverse();

        const labels  = paid.map(p => formatDate(p.paidAt || p.createdAt));
        const amounts = paid.map(p => p.amount);

        const ctx = document.getElementById('subChart').getContext('2d');

        if (subChartInstance) subChartInstance.destroy();

        subChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label:           'Ksh Paid',
                    data:            amounts,
                    backgroundColor: 'rgba(139,92,246,0.3)',
                    borderColor:     'rgba(139,92,246,0.8)',
                    borderWidth:     1,
                    borderRadius:    4
                }]
            },
            options: {
                responsive:          true,
                maintainAspectRatio: true,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#4a5568', font: { size: 10 } }, grid: { color: 'rgba(139,92,246,0.06)' } },
                    y: { ticks: { color: '#4a5568', font: { size: 10 } }, grid: { color: 'rgba(139,92,246,0.06)' } }
                }
            }
        });

    } catch (err) {
        console.error('Chart error:', err.message);
    }
}

// ═══════════════════════════════════════════════════════
//  SUBSCRIPTION PAYMENTS
// ═══════════════════════════════════════════════════════

async function loadSubPayments() {
    try {
        const res  = await stacklordFetch('/stacklord/subscription-payments');
        const data = await res.json();
        if (!res.ok) { showToast('Failed to load payments', 'error'); return; }

        const tbody = document.getElementById('paymentsTable');

        if (!data.length) {
            tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><span class="icon">💳</span>No subscription payments yet</div></td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(p => `
            <tr>
              <td class="td-mono">${formatDate(p.paidAt || p.createdAt)}</td>
              <td>${p.plan?.name || '—'}</td>
              <td class="td-mono" style="color:var(--green)">${formatKsh(p.amount)}</td>
              <td class="td-mono" style="color:var(--cyan)">${p.mpesaCode || '—'}</td>
              <td class="td-mono">${formatDate(p.expiresAt)}</td>
              <td>${p.status === 'paid'
                    ? '<span class="pill pill-green">Paid</span>'
                    : p.status === 'pending'
                    ? '<span class="pill pill-yellow">Pending</span>'
                    : '<span class="pill pill-red">Failed</span>'}</td>
              <td>${p.manuallyExtended
                    ? '<span class="pill pill-cyan">Manual</span>'
                    : '<span class="pill" style="background:var(--accent-dim);color:var(--accent);border:1px solid var(--border2)">M-Pesa</span>'}</td>
            </tr>
        `).join('');

    } catch (err) {
        showToast('Network error', 'error');
    }
}

// ═══════════════════════════════════════════════════════
//  PLANS
// ═══════════════════════════════════════════════════════

async function loadPlans() {
    try {
        const res  = await stacklordFetch('/stacklord/plans');
        const data = await res.json();
        if (!res.ok) return;

        const grid = document.getElementById('plansGrid');

        if (!data.length) {
            grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><span class="icon">📦</span>No plans yet — create your first plan</div>`;
            return;
        }

        grid.innerHTML = data.map(plan => `
            <div class="plan-card ${!plan.isActive ? 'inactive' : ''}">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">
                <div class="plan-card-name">${plan.name}</div>
                ${plan.isActive
                  ? '<span class="pill pill-green">Active</span>'
                  : '<span class="pill pill-red">Inactive</span>'}
              </div>
              <div class="plan-card-price">Ksh ${Number(plan.price).toLocaleString()}</div>
              <div class="plan-card-duration">${plan.durationDays} days · ${Math.round(plan.durationDays / 30 * 10) / 10} months</div>
              ${plan.description ? `<div class="plan-card-desc">${plan.description}</div>` : ''}
              ${plan.features?.length
                ? `<ul class="plan-features">${plan.features.map(f => `<li>${f}</li>`).join('')}</ul>`
                : ''}
              <div class="plan-actions">
                <button class="btn btn-secondary btn-sm" onclick="editPlan('${plan._id}')">✏️ Edit</button>
                <button class="btn btn-${plan.isActive ? 'warn' : 'success'} btn-sm" onclick="togglePlan('${plan._id}')">
                  ${plan.isActive ? '⏸ Deactivate' : '▶ Activate'}
                </button>
                <button class="btn btn-danger btn-sm" onclick="deletePlan('${plan._id}', '${plan.name}')">🗑</button>
              </div>
            </div>
        `).join('');

    } catch (err) {
        showToast('Failed to load plans', 'error');
    }
}

async function savePlan() {
    const id          = document.getElementById('planModalId').value.trim();
    const name        = document.getElementById('planName').value.trim();
    const price       = parseFloat(document.getElementById('planPrice').value);
    const durationDays= parseInt(document.getElementById('planDuration').value);
    const description = document.getElementById('planDescription').value.trim();
    const featuresRaw = document.getElementById('planFeatures').value.trim();
    const sortOrder   = parseInt(document.getElementById('planSortOrder').value) || 0;

    if (!name || !price || !durationDays) {
        showToast('Name, price and duration are required', 'error'); return;
    }

    const features = featuresRaw
        ? featuresRaw.split('\n').map(f => f.trim()).filter(Boolean)
        : [];

    const body    = { name, price, durationDays, description, features, sortOrder };
    const url     = id ? `/stacklord/plans/${id}` : '/stacklord/plans';
    const method  = id ? 'PUT' : 'POST';

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
    }
}

async function editPlan(id) {
    try {
        const res  = await stacklordFetch('/stacklord/plans');
        const data = await res.json();
        const plan = data.find(p => p._id === id);
        if (!plan) return;

        document.getElementById('planModalId').value    = plan._id;
        document.getElementById('planName').value       = plan.name;
        document.getElementById('planPrice').value      = plan.price;
        document.getElementById('planDuration').value   = plan.durationDays;
        document.getElementById('planDescription').value= plan.description || '';
        document.getElementById('planFeatures').value   = (plan.features || []).join('\n');
        document.getElementById('planSortOrder').value  = plan.sortOrder || 0;
        document.getElementById('planModalTitle').textContent = 'Edit Plan';

        openModal('modal-plan');

    } catch (err) {
        showToast('Failed to load plan', 'error');
    }
}

async function togglePlan(id) {
    try {
        const res  = await stacklordFetch(`/stacklord/plans/${id}/toggle`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed', 'error'); return; }
        showToast(data.message, 'success');
        loadPlans();
    } catch (err) {
        showToast('Network error', 'error');
    }
}

async function deletePlan(id, name) {
    if (!confirm(`Delete plan "${name}"? This cannot be undone.`)) return;
    try {
        const res  = await stacklordFetch(`/stacklord/plans/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Failed', 'error'); return; }
        showToast('Plan deleted ✅', 'success');
        loadPlans();
    } catch (err) {
        showToast('Network error', 'error');
    }
}

function clearPlanForm() {
    document.getElementById('planModalId').value     = '';
    document.getElementById('planName').value        = '';
    document.getElementById('planPrice').value       = '';
    document.getElementById('planDuration').value    = '';
    document.getElementById('planDescription').value = '';
    document.getElementById('planFeatures').value    = '';
    document.getElementById('planSortOrder').value   = '0';
    document.getElementById('planModalTitle').textContent = 'Create Plan';
}

// ═══════════════════════════════════════════════════════
//  CONTROLS
// ═══════════════════════════════════════════════════════

async function loadControlsInfo() {
    try {
        const res  = await stacklordFetch('/stacklord/stats');
        const data = await res.json();
        if (!res.ok) return;

        const { landlord, stats } = data;
        if (!landlord) return;

        let expiryDate = landlord.subscriptionExpiry || landlord.trialEndsAt;

        document.getElementById('controlsSubInfo').innerHTML = `
            <div class="sub-card-row"><span class="sub-card-label">Landlord</span>      <span class="sub-card-value">${landlord.name}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Status</span>        <span>${statusBadge(landlord.subscriptionStatus)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Current Expiry</span><span class="sub-card-value">${formatDate(expiryDate)}</span></div>
            <div class="sub-card-row"><span class="sub-card-label">Days Remaining</span><span class="sub-card-value" style="color:${daysColor(stats.daysRemaining)}">${stats.daysRemaining} days</span></div>
        `;

    } catch (err) {
        showToast('Failed to load info', 'error');
    }
}

async function extendSubscription() {
    const days = parseInt(document.getElementById('extendDays').value);
    const note = document.getElementById('extendNote').value.trim();

    if (!days || days < 1) {
        showToast('Enter a valid number of days', 'error'); return;
    }

    if (!confirm(`Extend subscription by ${days} days?`)) return;

    try {
        const res  = await stacklordFetch('/stacklord/extend', {
            method: 'POST',
            body:   JSON.stringify({ days, note })
        });

        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Failed to extend', 'error'); return; }

        showToast(`✅ Extended by ${days} days — new expiry: ${data.newExpiry}`, 'success');
        document.getElementById('extendDays').value = '';
        document.getElementById('extendNote').value = '';
        loadControlsInfo();
        loadOverview();

    } catch (err) {
        showToast('Network error', 'error');
    }
}

// ═══════════════════════════════════════════════════════
//  DANGER ZONE
// ═══════════════════════════════════════════════════════

async function suspendLandlord() {
    const reason = document.getElementById('suspendReason').value.trim();
    if (!reason) { showToast('Suspension reason is required', 'error'); return; }

    if (!confirm(`Suspend the landlord?\nReason: "${reason}"\n\nThis will immediately block their dashboard access.`)) return;

    try {
        const res  = await stacklordFetch('/stacklord/suspend', {
            method: 'POST',
            body:   JSON.stringify({ reason })
        });

        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Failed to suspend', 'error'); return; }

        showToast('🔒 Landlord suspended successfully', 'success');
        document.getElementById('suspendReason').value = '';
        loadOverview();

    } catch (err) {
        showToast('Network error', 'error');
    }
}

async function unsuspendLandlord() {
    if (!confirm('Restore landlord access? Their subscription status will be recalculated based on their expiry date.')) return;

    try {
        const res  = await stacklordFetch('/stacklord/unsuspend', { method: 'POST' });
        const data = await res.json();

        if (!res.ok) { showToast(data.message || 'Failed to unsuspend', 'error'); return; }

        showToast('🔓 ' + data.message, 'success');
        loadOverview();

    } catch (err) {
        showToast('Network error', 'error');
    }
}