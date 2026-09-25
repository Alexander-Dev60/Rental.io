// ═══════════════════════════════════════════════════════
//  auth.js — Authentication + Explore Strip + Page Loader
//
//  This file is the single source of truth for auth.html's
//  behaviour. It replaces the old inline <script> blocks that
//  used to live directly in auth.html, and supersedes the
//  previous standalone auth.js, which still referenced a
//  "discovery panel" (#discoveryPanel, #discPhoto, #discSlide...)
//  that no longer exists in the current markup — that dead code
//  has been dropped. The "Explore Properties" strip at the top
//  of auth.html is the current replacement and is the version
//  kept here.
// ═══════════════════════════════════════════════════════

const API = window.API;

// ── Referral capture ──
// If this page was opened via a referral link (?ref=<code> — see
// getOrCreateReferralCode() in app.js for where the code comes from), stash
// it the moment the page loads. sessionStorage (not localStorage) is
// deliberate: it should survive switching between the Login/Register tabs
// and a page refresh in this same visit, but not linger indefinitely and
// silently attribute some unrelated signup days later on the same device.
(function captureReferralCode() {
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (ref) sessionStorage.setItem('referralCode', ref.trim());
})();


// ── Referral banner ──
// Shows a small "you were referred by X" note on the register panel once
// captureReferralCode() (above) has stashed a code. Best-effort: if the
// lookup fails or the code is invalid, the banner still shows with its
// generic fallback text rather than being hidden or left blank — a landlord
// who came in via a referral link should always see they were credited.
async function showReferralBanner() {
    const ref = sessionStorage.getItem('referralCode');
    if (!ref) return;

    const note = document.getElementById('referralNote');
    if (!note) return;

    note.style.display = 'flex';

    try {
        const res = await fetch(`${API}/public/referral-info/${encodeURIComponent(ref)}`);
        if (!res.ok) return; // keep the generic fallback text
        const data = await res.json();
        const nameEl = document.getElementById('referralByName');
        if (nameEl && data.name) nameEl.textContent = data.name;
    } catch (err) {
        console.warn('Referral lookup failed:', err.message);
        // Banner already shown with fallback text — nothing more to do
    }
}


// ═══════════════════════════════════════
// PAGE LOADER
// ═══════════════════════════════════════
//
// A full-page overlay shown from first paint until the page has
// enough data to be useful: the auth-check redirect has had a
// chance to run, AND the Explore Properties strip has resolved
// (success or failure — we never block forever on a slow/failed
// fetch). Markup for #pageLoader is expected in auth.html.

let _loaderExploreDone = false;
let _loaderMinTimeDone = false;

function _tryHidePageLoader() {
    if (!_loaderExploreDone || !_loaderMinTimeDone) return;
    const el = document.getElementById('pageLoader');
    if (!el) return;
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
}

function initPageLoader() {
    // Small minimum display time so the loader never just flashes
    // and disappears on a fast connection — avoids a jarring blink.
    setTimeout(() => { _loaderMinTimeDone = true; _tryHidePageLoader(); }, 350);
}


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
// Caretakers reuse the landlord dashboard shell (with reduced nav via
// data-caretaker CSS hiding) rather than a separate page.
function dashboardFor(role) {
    if (role === 'landlord' || role === 'caretaker') return 'dashboard.html';
    return 'tenant.html';
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

// ── Loading state (buttons) ──
// Shows a small inline spinner (see .btn-spinner in auth.html) instead of
// just swapping text, so the pending state is visible even at a glance.
function setLoading(btnId, on, defaultText) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled  = on;
    btn.innerHTML = on
        ? '<span class="btn-spinner"></span>Please wait…'
        : defaultText;
}

// ── Store active property in localStorage ──
function storeActiveProperty(properties) {
    if (!Array.isArray(properties) || !properties.length) return;
    const first = properties[0];
    localStorage.setItem('activePropertyId',   first._id  || first.id);
    localStorage.setItem('activePropertyName', first.name || 'Property');
}


// ═══════════════════════════════════════
// BACKGROUND SLIDESHOW
// ═══════════════════════════════════════

function initBgSlideshow() {
    const BG_INTERVAL = 5 * 60 * 1000; // 5 minutes
    const bgImgs = document.querySelectorAll('.bg img');
    if (!bgImgs.length) return;
    let bgIdx = 0;
    setInterval(() => {
        bgImgs[bgIdx].classList.remove('active');
        bgIdx = (bgIdx + 1) % bgImgs.length;
        bgImgs[bgIdx].classList.add('active');
    }, BG_INTERVAL);
}


// ═══════════════════════════════════════
// HERO TYPEWRITER
// ═══════════════════════════════════════

function initHeroTypewriter() {
    const phrases = [
        'Pay your rent securely online.',
        'Track every payment receipt.',
        'Message your landlord directly.',
        'Manage your properties with ease.',
        'View outstanding arrears at a glance.',
        'Receive instant PDF receipts by email.',
        'Stay informed with announcements.',
        'Monitor tenant balances in real-time.',
    ];
    let phraseIdx = 0, charIdx = 0, deleting = false;
    const twEl = document.getElementById('typewriterEl');
    if (!twEl) return;

    function typeStep() {
        const phrase = phrases[phraseIdx];
        if (!deleting) {
            charIdx++;
            twEl.textContent = phrase.slice(0, charIdx);
            if (charIdx === phrase.length) { deleting = true; setTimeout(typeStep, 2000); return; }
            setTimeout(typeStep, 48 + Math.random() * 28);
        } else {
            charIdx--;
            twEl.textContent = phrase.slice(0, charIdx);
            if (charIdx === 0) {
                deleting = false;
                phraseIdx = (phraseIdx + 1) % phrases.length;
                setTimeout(typeStep, 420); return;
            }
            setTimeout(typeStep, 22 + Math.random() * 14);
        }
    }
    setTimeout(typeStep, 900);
}


// ═══════════════════════════════════════
// ROLE PICKER / TABS / PASSWORD EYE TOGGLES
// ═══════════════════════════════════════

// Tenants always sign in (no self-registration); landlords can do either,
// default them to Create Account since that's the only new-user path.
function pickRole(role) {
    document.getElementById('roleTenant').classList.toggle('active', role === 'tenant');
    document.getElementById('roleLandlord').classList.toggle('active', role === 'landlord');
    switchTab(role === 'landlord' ? 'register' : 'login');
}

function switchTab(tab) {
    document.getElementById('tabLogin').classList.toggle('active',    tab === 'login');
    document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
    document.getElementById('panelLogin').classList.toggle('active',    tab === 'login');
    document.getElementById('panelRegister').classList.toggle('active', tab === 'register');
    const hint = document.getElementById('tenantHint');
    if (hint) hint.style.display = tab === 'login' ? 'flex' : 'none';
    // Keep role picker in sync if user clicked the tabs directly instead
    if (tab === 'register') {
        document.getElementById('roleTenant').classList.remove('active');
        document.getElementById('roleLandlord').classList.add('active');
    }
}

function toggleRegisterBtn() {
    const btn     = document.getElementById('registerBtn');
    const checked = document.getElementById('regTerms')?.checked;
    if (btn) btn.disabled = !checked;
}

function toggleEye(inputId, iconId) {
    const inp     = document.getElementById(inputId);
    const showing = inp.type === 'text';
    inp.type = showing ? 'password' : 'text';
    document.getElementById(iconId).innerHTML = showing
        ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
        : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
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
            setLoading('loginBtn', false, 'Sign In'); return;
        }

        const token = data.token;
        if (!token) {
            showToast('No token received from server.', 'error');
            setLoading('loginBtn', false, 'Sign In'); return;
        }

        const user = getUserFromToken(token);
        if (!user) {
            showToast('Invalid token received.', 'error');
            setLoading('loginBtn', false, 'Sign In'); return;
        }

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

        if (user.role === 'caretaker') {
            localStorage.setItem('caretakerLandlordName', data.landlord?.name || '');
            localStorage.setItem('caretakerPermissions',  JSON.stringify(data.permissions || {}));
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
    if (password.length < 6) { showToast('Password must be at least 6 characters.', 'error'); return; }
    if (password !== confirm) { showToast('Passwords do not match.',      'error'); return; }
    if (!document.getElementById('regTerms')?.checked) {
        showToast('Please agree to the Terms of Service and Privacy Policy.', 'error'); return;
    }

    setLoading('registerBtn', true, 'Create Landlord Account');

    // Referral attribution — carried through from ?ref=<code> on the link
    // that brought them here (see auth.html's inline capture-on-load script,
    // just below). Silently omitted if absent; the backend already treats a
    // missing/invalid code as "no referral" without blocking signup.
    const ref = sessionStorage.getItem('referralCode') || '';

    try {
        const res  = await fetch(`${API}/landlord/register`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                name, email, phone, propertyName, propertyLocation, password,
                ...(ref && { ref }),
                termsAccepted: document.getElementById('regTerms')?.checked === true
            }),
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.message || 'Registration failed. Please try again.', 'error');
            setLoading('registerBtn', false, 'Create Landlord Account'); return;
        }

        const token = data.token;
        if (!token) {
            showToast('No token received from server.', 'error');
            setLoading('registerBtn', false, 'Create Landlord Account'); return;
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

        sessionStorage.removeItem('referralCode');

        showToast('Account created! Setting up your dashboard…', 'success');
        setTimeout(() => { window.location.href = dashboardFor(user.role); }, 1000);

    } catch (err) {
        console.error('Register error:', err);
        showToast('Cannot reach server. Is your backend running?', 'error');
        setLoading('registerBtn', false, 'Create Landlord Account');
    }
}


// ═══════════════════════════════════════════════════════
// EXPLORE STRIP — rotating property grid + location search
// ═══════════════════════════════════════════════════════

let _properties     = [];
let _locationIndex  = [];
let _exploreOffset  = 0;
let _exploreTimer   = null;
const EXPLORE_SLOTS = 4;
const EXPLORE_INTERVAL = 6000;

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
}

async function initExplore() {
    const grid = document.getElementById('exploreGrid');
    if (!grid || !window.API) { renderExploreEmpty(); _loaderExploreDone = true; _tryHidePageLoader(); return; }
    try {
        const res = await fetch(`${window.API}/public/listings`);
        if (!res.ok) throw new Error(res.status);
        _properties = await res.json();
    } catch (err) {
        console.warn('Explore fetch failed:', err.message);
        _properties = [];
    }

    _loaderExploreDone = true;
    _tryHidePageLoader();

    if (!_properties.length) { renderExploreEmpty(); return; }

    renderExploreGrid();
    buildLocationIndex();

    if (_properties.length > EXPLORE_SLOTS) {
        _exploreTimer = setInterval(() => {
            _exploreOffset = (_exploreOffset + EXPLORE_SLOTS) % _properties.length;
            renderExploreGrid();
        }, EXPLORE_INTERVAL);
    }

    // Refresh data quietly every 30s (vacancy counts / new listings)
    setInterval(async () => {
        try {
            const res = await fetch(`${window.API}/public/listings`);
            if (!res.ok) return;
            _properties = await res.json();
            buildLocationIndex();
        } catch {}
    }, 30000);
}

function renderExploreEmpty() {
    const grid = document.getElementById('exploreGrid');
    if (grid) grid.innerHTML = `<div class="explore-empty">${ICON('properties', 22)}No properties listed yet. Check back soon.</div>`;
}

function renderExploreGrid() {
    const grid = document.getElementById('exploreGrid');
    if (!grid) return;
    const count = Math.min(EXPLORE_SLOTS, _properties.length);
    const slice = [];
    for (let i = 0; i < count; i++) {
        slice.push(_properties[(_exploreOffset + i) % _properties.length]);
    }
    grid.innerHTML = slice.map(p => {
        const hasPhoto = Array.isArray(p.photos) && p.photos.length > 0;
        const style = hasPhoto ? ` style="background-image:url('${p.photos[0]}')"` : '';
        const cls   = hasPhoto ? '' : ' no-photo';
        return `
          <a class="explore-card" href="listings.html">
            <div class="explore-card-photo${cls}"${style}></div>
            <div class="explore-card-overlay">
              <div class="explore-card-name">${escapeHtml(p.name || '—')}</div>
              <div class="explore-card-loc">${ICON('pin', 9)} ${escapeHtml(p.location || '—')}</div>
            </div>
          </a>`;
    }).join('');
}

// ── Location search ──
function buildLocationIndex() {
    const counts = {};
    _properties.forEach(p => {
        const loc = (p.location || '').trim();
        if (!loc) return;
        counts[loc] = (counts[loc] || 0) + 1;
    });
    _locationIndex = Object.entries(counts)
        .map(([location, count]) => ({ location, count }))
        .sort((a, b) => b.count - a.count);
}

function renderLocationDropdown(items) {
    const dd = document.getElementById('locationDropdown');
    if (!dd) return;
    if (!items.length) {
        dd.innerHTML = '<div class="location-dropdown-empty">No matching locations.</div>';
        return;
    }
    dd.innerHTML = items.slice(0, 8).map(it => `
        <div class="location-dropdown-item" role="button" tabindex="0"
             onclick="goToLocation('${encodeURIComponent(it.location)}')"
             onkeydown="if(event.key==='Enter')goToLocation('${encodeURIComponent(it.location)}')">
          <span>${escapeHtml(it.location)}</span>
          <span class="location-dropdown-count">${it.count} ${it.count === 1 ? 'property' : 'properties'}</span>
        </div>`).join('');
}

function goToLocation(encodedLoc) {
    window.location.href = `listings.html?location=${encodedLoc}`;
}

function setupLocationSearch() {
    const input = document.getElementById('locationSearch');
    const dd    = document.getElementById('locationDropdown');
    if (!input || !dd) return;

    input.addEventListener('focus', () => {
        renderLocationDropdown(_locationIndex);
        dd.classList.add('show');
    });
    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const filtered = q
            ? _locationIndex.filter(it => it.location.toLowerCase().includes(q))
            : _locationIndex;
        renderLocationDropdown(filtered);
        dd.classList.add('show');
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { dd.classList.remove('show'); input.blur(); }
    });
    document.addEventListener('click', (e) => {
        if (!dd.contains(e.target) && e.target !== input) dd.classList.remove('show');
    });
}


// ═══════════════════════════════════════
// GLOBAL KEYDOWN — Enter submits the active form
// ═══════════════════════════════════════

function setupEnterToSubmit() {
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        // Don't hijack Enter when the user is inside the location search box
        if (e.target && e.target.id === 'locationSearch') return;
        if (document.getElementById('panelLogin')?.classList.contains('active')) submitLogin();
        else submitRegister();
    });
}


// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

document.addEventListener('DOMContentLoaded', function () {
    const params = new URLSearchParams(window.location.search);
    const tab    = params.get('tab');
    const ref    = params.get('ref');

    // A referral code only ever applies to landlord self-registration, so
    // treat it the same as ?tab=register — jump straight to Create Account
    // instead of making a referred landlord click through manually.
    if (tab === 'register' || ref) pickRole('landlord');
});

window.addEventListener('load', () => {
    initPageLoader();
    checkAuthOnLoad();
    initBgSlideshow();
    initHeroTypewriter();
    initExplore();
    setupLocationSearch();
    setupEnterToSubmit();
    showReferralBanner();
});