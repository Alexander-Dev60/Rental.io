// ═══════════════════════════════════════════════════════
//  auth.js — Authentication Logic
//  Used by the login page (index.html / auth.html)
// ═══════════════════════════════════════════════════════

const API = 'https://affordable-rental-systems.onrender.com';

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
  return role === 'admin' ? 'index.html' : 'tenant.html';
}

// ── Auto-redirect if already logged in ──
function checkAuthOnLoad() {
  const token = localStorage.getItem('token');
  const user  = getUserFromToken(token);
  if (user) {
    window.location.href = dashboardFor(user.role);
  }
}

// ── Loading state ──
function setLoading(on) {
  const btn = document.getElementById('submitBtn');
  if (!btn) return;
  btn.disabled    = on;
  btn.textContent = on ? 'Signing in…' : 'Sign In';
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

// ── Main login handler ──
// Called by onclick="submitLogin()" in the page
async function submitLogin() {
  const email    = (document.getElementById('email')?.value    || '').trim();
  const password = (document.getElementById('password')?.value || '');

  // ── Validation ──
  if (!email) {
    showToast('Email is required.', 'error'); return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Please enter a valid email address.', 'error'); return;
  }
  if (!password) {
    showToast('Password is required.', 'error'); return;
  }

  setLoading(true);

  try {
    const res = await fetch(`${API}/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(data.message || 'Login failed. Please try again.', 'error');
      setLoading(false);
      return;
    }

    const token = data.token;
    if (!token) {
      showToast('No token received from server.', 'error');
      setLoading(false);
      return;
    }

    const user = getUserFromToken(token);
    if (!user) {
      showToast('Invalid token received.', 'error');
      setLoading(false);
      return;
    }

    // Persist session
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));

    showToast('Welcome back! Redirecting…', 'success');

    // Only redirect after success — do NOT use finally for setLoading here
    setTimeout(() => {
      window.location.href = dashboardFor(user.role);
    }, 900);

  } catch (err) {
    console.error('Login error:', err);
    showToast('Cannot reach server. Is your backend running?', 'error');
    setLoading(false);
  }
}

// ── Enter key support ──
document.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') submitLogin();
});

// ── Run on page load ──
window.addEventListener('load', checkAuthOnLoad);