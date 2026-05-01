// ═══════════════════════════════════════════════════════
//  auth.js — Authentication Logic
//  Works with the auth.html tab system (setMode/showToast
//  are defined in auth.html inline script)
// ═══════════════════════════════════════════════════════

 const API= 'https://affordable-rental-systems.onrender.com'; 

// ── Decode JWT safely ──
function getUserFromToken(token) {
    try {
        if (!token) return null;
        return JSON.parse(atob(token.split('.')[1]));
    } catch {
        return null;
    }
}

// ── Auto-redirect if already logged in ──
function checkAuthOnLoad() {
    const token = localStorage.getItem('token');
    const user  = getUserFromToken(token);
    if (user) {
        window.location.href = user.role === 'admin' ? 'index.html' : 'tenant.html';
    }
}

// ── Main submit handler ──
// Called by onclick="submitAuth()" on the button in auth.html
async function submitAuth() {
    const name     = document.getElementById('name').value.trim();
    const email    = document.getElementById('email').value.trim();
    const phone    = document.getElementById('phone').value.trim();
    const password = document.getElementById('password').value;

    // currentMode is set by setMode() in auth.html inline script
    const isLogin = currentMode === 'login';

    // ── Validation ──
    if (!email) {
        showToast('Email is required', 'error'); return;
    }
    if (!password) {
        showToast('Password is required', 'error'); return;
    }
    if (!isLogin && !name) {
        showToast('Full name is required', 'error'); return;
    }
    if (!isLogin && !phone) {
        showToast('Phone number is required', 'error'); return;
    }

    setLoading(true);

    try {
        const url  = isLogin ? `${API}/login` : `${API}/register`;
        const body = isLogin
            ? { email, password }
            : { name, email, password, phone };

        const res  = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body)
        });

        const data = await res.json();

        if (!res.ok) {
            showToast(data.message || 'Authentication failed', 'error');
            return;
        }

        // ── REGISTER success ──
        if (!isLogin) {
            showToast('Account created! Please sign in.', 'success');
            // Clear fields
            document.getElementById('name').value     = '';
            document.getElementById('phone').value    = '';
            document.getElementById('password').value = '';
            // Switch to login tab
            setTimeout(() => setMode('login'), 1200);
            return;
        }

        // ── LOGIN success ──
        localStorage.setItem('token', data.token);

        const user = getUserFromToken(data.token);
        if (!user) {
            showToast('Invalid token received', 'error');
            return;
        }

        showToast('Welcome back! Redirecting...', 'success');

        setTimeout(() => {
            window.location.href = user.role === 'admin' ? 'index.html' : 'tenant.html';
        }, 800);

    } catch (err) {
        console.error(err);
        showToast('Network error — is the server running?', 'error');
    } finally {
        setLoading(false);
    }
}

// ── Run on page load ──
window.onload = checkAuthOnLoad;