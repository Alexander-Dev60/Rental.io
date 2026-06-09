// ═══════════════════════════════════════════════════════
//  auth.js — Authentication + Discovery Slideshow
//  Handles: login, landlord registration,
//           forced password change (tenant first login),
//           public property discovery panel
// ═══════════════════════════════════════════════════════

const API = window.API;

// ── Decode JWT payload safely ──
function getUserFromToken(token) {
    try {
        if (!token) return null;
        return JSON.parse(atob(token.split('.')[1]));
    } catch {
        return null;
    }
}

// ── Redirect destination by role ──
function dashboardFor(role) {
    return role === 'landlord' ? 'dashboard.html' : 'tenant.html';
}

// ── Auto-redirect if already logged in ──
function checkAuthOnLoad() {
    const token = localStorage.getItem('token');
    const user  = getUserFromToken(token);
    if (user && !user.mustChangePassword) {
        window.location.href = dashboardFor(user.role);
    }
}

// ── Toast ──
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className   = 'show ' + type;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.className = ''; }, 3500);
}

// ── Loading state ──
function setLoading(btnId, on, defaultText) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled    = on;
    btn.textContent = on ? 'Please wait…' : defaultText;
}

// ── Store active property in localStorage ──
function storeActiveProperty(properties) {
    if (!Array.isArray(properties) || !properties.length) return;
    const first = properties[0];
    localStorage.setItem('activePropertyId',   first._id  || first.id);
    localStorage.setItem('activePropertyName', first.name || 'Property');
}


// ═══════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════

async function submitLogin() {
    const email    = (document.getElementById('loginEmail')?.value    || '').trim();
    const password = (document.getElementById('loginPassword')?.value || '');

    if (!email) { showToast('Email is required.', 'error'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showToast('Please enter a valid email address.', 'error'); return;
    }
    if (!password) { showToast('Password is required.', 'error'); return; }

    setLoading('loginBtn', true, 'Sign In');

    try {
        const res  = await fetch(`${API}/login`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email, password }),
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.message || 'Login failed. Please try again.', 'error');
            setLoading('loginBtn', false, 'Sign In');
            return;
        }

        const token = data.token;
        if (!token) {
            showToast('No token received from server.', 'error');
            setLoading('loginBtn', false, 'Sign In');
            return;
        }

        const user = getUserFromToken(token);
        if (!user) {
            showToast('Invalid token received.', 'error');
            setLoading('loginBtn', false, 'Sign In');
            return;
        }

        // ── Tenant: forced password change on first login ──
        if (user.mustChangePassword) {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
            showToast('Please set a new password to continue.', '');
            setTimeout(() => { window.location.href = 'change-password.html'; }, 900);
            return;
        }

        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));

        if (user.role === 'landlord') {
            localStorage.setItem('onboardingComplete', data.onboardingComplete ? 'true' : 'false');
            localStorage.setItem('paymentConfigured',  data.paymentConfigured  ? 'true' : 'false');
            if (Array.isArray(data.properties) && data.properties.length) {
                storeActiveProperty(data.properties);
            }
        }

        showToast('Welcome back! Redirecting…', 'success');
        setTimeout(() => { window.location.href = dashboardFor(user.role); }, 900);

    } catch (err) {
        console.error('Login error:', err);
        showToast('Cannot reach server. Are you connected to the internet?', 'error');
        setLoading('loginBtn', false, 'Sign In');
    }
}


// ═══════════════════════════════════════
// LANDLORD REGISTRATION
// ═══════════════════════════════════════

async function submitRegister() {
    const name             = (document.getElementById('regName')?.value         || '').trim();
    const email            = (document.getElementById('regEmail')?.value        || '').trim();
    const phone            = (document.getElementById('regPhone')?.value        || '').trim();
    const propertyName     = (document.getElementById('regPropertyName')?.value || '').trim();
    const propertyLocation = (document.getElementById('regLocation')?.value     || '').trim();
    const password         = (document.getElementById('regPassword')?.value     || '');
    const confirm          = (document.getElementById('regConfirm')?.value      || '');

    if (!name)             { showToast('Full name is required.',          'error'); return; }
    if (!email)            { showToast('Email is required.',              'error'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                             showToast('Please enter a valid email address.', 'error'); return; }
    if (!phone)            { showToast('Phone number is required.',       'error'); return; }
    if (!propertyName)     { showToast('Property name is required.',      'error'); return; }
    if (!propertyLocation) { showToast('Property location is required.',  'error'); return; }
    if (!password)         { showToast('Password is required.',           'error'); return; }
    if (password.length < 6) {
                             showToast('Password must be at least 6 characters.', 'error'); return; }
    if (password !== confirm) { showToast('Passwords do not match.',      'error'); return; }

    setLoading('registerBtn', true, 'Create Landlord Account');

    try {
        const res  = await fetch(`${API}/landlord/register`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name, email, phone, propertyName, propertyLocation, password }),
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.message || 'Registration failed. Please try again.', 'error');
            setLoading('registerBtn', false, 'Create Landlord Account');
            return;
        }

        const token = data.token;
        if (!token) {
            showToast('No token received from server.', 'error');
            setLoading('registerBtn', false, 'Create Landlord Account');
            return;
        }

        const user = getUserFromToken(token);

        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('onboardingComplete', 'false');
        localStorage.setItem('paymentConfigured',  'false');

        if (data.property) {
            localStorage.setItem('activePropertyId',   data.property.id   || data.property._id);
            localStorage.setItem('activePropertyName', data.property.name || propertyName);
        }

        showToast('Account created! Setting up your dashboard…', 'success');
        setTimeout(() => { window.location.href = 'index.html'; }, 1000);

    } catch (err) {
        console.error('Register error:', err);
        showToast('Cannot reach server. Is your backend running?', 'error');
        setLoading('registerBtn', false, 'Create Landlord Account');
    }
}


// ═══════════════════════════════════════════════════════
// DISCOVERY PANEL — live property slideshow
// ═══════════════════════════════════════════════════════

let _discListings   = [];
let _discCurrent    = 0;
let _discTimer      = null;
let _discPaused     = false;
const DISC_INTERVAL = 5500; // ms per slide

async function initDiscovery() {
    // Only run if the panel exists and the API is reachable
    const panel = document.getElementById('discoveryPanel');
    if (!panel || !window.API) {
        _showDiscLoader(false);
        return;
    }

    try {
        const res = await fetch(`${window.API}/public/listings`);
        if (!res.ok) throw new Error(`${res.status}`);
        _discListings = await res.json();
    } catch (err) {
        console.warn('Discovery fetch failed:', err.message);
        _discListings = [];
    }

    if (!_discListings.length) {
        _showDiscEmpty();
        return;
    }

    // Update listing count badge in header
    const countEl = document.getElementById('discCount');
    if (countEl) {
        countEl.textContent   = _discListings.length;
        countEl.style.display = 'inline-flex';
    }

    // Render first slide and start rotation
    _discRenderSlide(0);
    _discRenderDots();
    _discStart();

    // Pause / resume on hover
    panel.addEventListener('mouseenter', () => { _discPaused = true; });
    panel.addEventListener('mouseleave', () => { _discPaused = false; });

    // Poll every 30 s to refresh vacancy counts without restarting slideshow
    setInterval(async () => {
        try {
            const res = await fetch(`${window.API}/public/listings`);
            if (!res.ok) return;
            const fresh = await res.json();
            _discListings = fresh;
            // Silently re-render current slide so counts update in place
            _discRenderSlide(_discCurrent, /* silent */ true);
        } catch {}
    }, 30000);
}


// ── Render one slide ──
// silent = true skips the entrance animation (used for poll updates)
function _discRenderSlide(idx, silent) {
    const listing = _discListings[idx];
    if (!listing) return;

    _discCurrent = idx;

    const photoEl   = document.getElementById('discPhoto');
    const initialEl = document.getElementById('discInitial');
    const counterEl = document.getElementById('discCounter');
    const overlayEl = document.getElementById('discOverlay');
    const locEl     = document.getElementById('discLocationText');
    const nameEl    = document.getElementById('discName');
    const vacantEl  = document.getElementById('discVacant');
    const rentEl    = document.getElementById('discRent');
    const descEl    = document.getElementById('discDesc');

    // ── Photo ──
    if (listing.photos?.length) {
        photoEl.style.backgroundImage = `url('${listing.photos[0]}')`;
        photoEl.classList.remove('disc-no-photo');
        if (initialEl) initialEl.textContent = '';
    } else {
        photoEl.style.backgroundImage = '';
        photoEl.classList.add('disc-no-photo');
        if (initialEl) initialEl.textContent = (listing.name || '?')[0].toUpperCase();
    }

    // ── Location + name ──
    if (locEl)  locEl.textContent  = listing.location || '—';
    if (nameEl) nameEl.textContent = listing.name     || '—';

    // ── Vacancy chip ──
    if (vacantEl) {
        vacantEl.classList.remove('disc-chip-full');
        if (listing.vacantCount > 0) {
            vacantEl.textContent   = listing.vacantCount === 1
                ? '1 unit available'
                : `${listing.vacantCount} units available`;
            vacantEl.style.display = 'inline-flex';
        } else {
            vacantEl.textContent   = 'Fully occupied';
            vacantEl.style.display = 'inline-flex';
            vacantEl.classList.add('disc-chip-full');
        }
    }

    // ── Rent range chip ──
    if (rentEl) {
        if (listing.rentRange) {
            const mn = Number(listing.rentRange.min).toLocaleString();
            const mx = Number(listing.rentRange.max).toLocaleString();
            rentEl.textContent   = mn === mx ? `Ksh ${mn}` : `Ksh ${mn} – ${mx}`;
            rentEl.style.display = 'inline-flex';
        } else {
            rentEl.style.display = 'none';
        }
    }

    // ── Description ──
    if (descEl) {
        descEl.textContent = listing.description && listing.description.trim()
            ? listing.description
            : 'Contact the landlord for more details about this property.';
    }

    // ── Counter "2 / 5" ──
    if (counterEl) {
        counterEl.textContent   = `${idx + 1} / ${_discListings.length}`;
        counterEl.style.display = _discListings.length > 1 ? 'block' : 'none';
    }

    // ── Show overlay (hidden until first slide renders) ──
    if (overlayEl) overlayEl.style.display = 'block';

    // ── Animate slide content in ──
    if (!silent) {
        const slideEl = document.getElementById('discSlide');
        if (slideEl) {
            slideEl.classList.remove('disc-slide-in');
            void slideEl.offsetWidth; // force reflow so animation retriggers
            slideEl.classList.add('disc-slide-in');
        }
    }

    // ── Update dot indicators ──
    document.querySelectorAll('.disc-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === idx);
    });

    // ── Restart progress bar (skip on silent poll updates) ──
    if (!silent) _discProgress();
}


// ── Render dot nav ──
function _discRenderDots() {
    const container = document.getElementById('discDots');
    if (!container || _discListings.length <= 1) {
        if (container) container.style.display = 'none';
        return;
    }
    container.innerHTML = _discListings
        .map((_, i) => `<span class="disc-dot${i === 0 ? ' active' : ''}" onclick="discGoTo(${i})"></span>`)
        .join('');
}


// ── Public: go to specific slide (called from dot onclick) ──
function discGoTo(idx) {
    _discStop();
    _discRenderSlide(idx);
    _discStart();
}


// ── Slideshow timer ──
function _discStart() {
    _discStop();
    if (_discListings.length <= 1) return; // no rotation needed for single listing
    _discTimer = setInterval(() => {
        if (!_discPaused) {
            const next = (_discCurrent + 1) % _discListings.length;
            _discRenderSlide(next);
        }
    }, DISC_INTERVAL);
}

function _discStop() {
    if (_discTimer) { clearInterval(_discTimer); _discTimer = null; }
}


// ── Gold progress bar ──
function _discProgress() {
    const fill = document.getElementById('discProgressFill');
    if (!fill) return;
    // Reset instantly, then animate to 100% over the interval duration
    fill.style.transition = 'none';
    fill.style.width      = '0%';
    fill.getBoundingClientRect(); // force reflow
    fill.style.transition = `width ${DISC_INTERVAL}ms linear`;
    fill.style.width      = '100%';
}


// ── Show loader / hide it ──
function _showDiscLoader(visible) {
    const el = document.getElementById('discLoader');
    if (el) el.style.display = visible ? 'flex' : 'none';
}


// ── Empty state ──
function _showDiscEmpty() {
    _showDiscLoader(false);
    const emptyEl = document.getElementById('discEmpty');
    if (emptyEl) emptyEl.style.display = 'flex';
    const descEl = document.getElementById('discDesc');
    if (descEl) descEl.textContent = 'No properties are listed yet. Check back soon.';
}


// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

window.addEventListener('load', () => {
    checkAuthOnLoad();
    initDiscovery();
});