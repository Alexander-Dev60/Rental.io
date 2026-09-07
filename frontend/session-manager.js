/* ═══════════════════════════════════════════════════════
   session-manager.js
   Sliding-session idle timeout with an "Extend Session" popup.

   Include on any authenticated page (landlord dashboard, tenant
   portal) AFTER the token is stored in localStorage. Then call:

       SessionManager.init({
           apiBase:     'https://your-backend.onrender.com', // no trailing slash
           tokenKey:    'token',        // localStorage key holding the JWT
           loginUrl:    'auth.html',    // where to redirect on logout/expiry
           idleMinutes: 20,             // inactivity before the warning fires
           warningSeconds: 60           // countdown length on the warning modal
       });

   That's it — the widget handles activity listening, the modal,
   the countdown, calling /auth/refresh-token, and redirecting on
   timeout. No other wiring needed.
   ═══════════════════════════════════════════════════════ */

(function (window) {
    'use strict';

    const SessionManager = {
        _config: null,
        _idleTimer: null,
        _warningTimer: null,
        _countdownInterval: null,
        _silentRefreshInterval: null,
        _silentRetryTimer: null,
        _modalEl: null,
        _remainingSeconds: 0,
        _lastActivityAt: 0,
        _activityEvents: ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'],

        init(userConfig) {
            this._config = Object.assign({
                apiBase:        '',
                tokenKey:       'token',
                loginUrl:       'auth.html',
                idleMinutes:    20,
                warningSeconds: 60,
                // How often to silently refresh in the background for a user who
                // is continuously active and therefore NEVER triggers the idle
                // warning. Without this, an always-active user still hits the
                // JWT's hard expiry mid-session with no warning at all — the
                // idle-modal alone only protects against inactivity, not against
                // the token's natural clock running out on an active user.
                // Keep this comfortably under the backend's token lifetime (2h);
                // 45 min gives 3 silent refresh attempts before expiry as a margin.
                silentRefreshMinutes: 45
            }, userConfig || {});

            if (!this._getToken()) {
                return;
            }

            this._lastActivityAt = Date.now();
            this._buildModal();
            this._bindActivityListeners();
            this._resetIdleTimer();
            this._startSilentRefreshLoop();

            window.addEventListener('storage', (e) => {
                if (e.key === this._config.tokenKey) {
                    if (!e.newValue) {
                        this._hideModal();
                        this._goToLogin();
                    } else {
                        this._resetIdleTimer();
                    }
                }
            });
        },

        _getToken() {
            return localStorage.getItem(this._config.tokenKey);
        },

        _setToken(token) {
            localStorage.setItem(this._config.tokenKey, token);
        },

        _clearToken() {
            localStorage.removeItem(this._config.tokenKey);
        },

        _bindActivityListeners() {
            const handler = () => {
                this._lastActivityAt = Date.now();
                // Only reset the idle timer from real activity —
                // if the warning modal is already showing, activity
                // should NOT silently dismiss it (that would defeat
                // the point of the confirmation step). The user must
                // explicitly click Extend or Log Out.
                if (this._modalEl && this._modalEl.classList.contains('sm-visible')) return;
                this._resetIdleTimer();
            };
            this._activityEvents.forEach(evt =>
                window.addEventListener(evt, handler, { passive: true })
            );
        },

                _startSilentRefreshLoop() {
            clearInterval(this._silentRefreshInterval);
            clearTimeout(this._silentRetryTimer);
            const intervalMs = this._config.silentRefreshMinutes * 60 * 1000;

            this._silentRefreshInterval = setInterval(() => {
                this._attemptSilentRefresh();
            }, intervalMs);
        },

        // Returns true on a successful refresh, false otherwise (including
        // skipped attempts — idle user, modal already up, no token). Split
        // out from the interval so a failed attempt can schedule a single
        // short retry without disturbing the regular 45-min cadence.
        async _attemptSilentRefresh() {
            const token = this._getToken();
            if (!token) { clearInterval(this._silentRefreshInterval); return false; }

            // Don't silently refresh someone who has actually gone idle —
            // that case is already owned by the warning-modal/logout flow.
            // This loop exists purely for users who never go idle.
            const idleMs = this._config.idleMinutes * 60 * 1000;
            const sinceActivity = Date.now() - this._lastActivityAt;
            if (sinceActivity >= idleMs) return false;

            // Don't fight the warning modal if it's already up.
            if (this._modalEl && this._modalEl.classList.contains('sm-visible')) return false;

            try {
                const res = await fetch(`${this._config.apiBase}/auth/refresh-token`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (!res.ok) { this._scheduleSilentRetry(); return false; }
                const data = await res.json();
                this._setToken(data.token);
                return true;
            } catch (err) {
                console.error('Silent session refresh failed:', err);
                this._scheduleSilentRetry();
                return false;
            }
        },

        // One-off retry, 2 minutes after a failed attempt — narrows the
        // window where two unlucky failures in a row could leave an active
        // user unrefreshed all the way to hard token expiry, without
        // resetting the main 45-min interval's timing.
        _scheduleSilentRetry() {
            clearTimeout(this._silentRetryTimer);
            this._silentRetryTimer = setTimeout(() => {
                if (this._getToken()) this._attemptSilentRefresh();
            }, 2 * 60 * 1000);
        },

        _resetIdleTimer() {
            clearTimeout(this._idleTimer);
            const idleMs = this._config.idleMinutes * 60 * 1000;
            this._idleTimer = setTimeout(() => this._showWarning(), idleMs);
        },

        _showWarning() {
            if (!this._getToken()) return;
            this._remainingSeconds = this._config.warningSeconds;
            this._updateCountdownText();
            this._modalEl.classList.add('sm-visible');

            this._countdownInterval = setInterval(() => {
                this._remainingSeconds--;
                this._updateCountdownText();
                if (this._remainingSeconds <= 0) {
                    clearInterval(this._countdownInterval);
                    this._logout();
                }
            }, 1000);
        },

        _updateCountdownText() {
            const el = this._modalEl.querySelector('.sm-countdown-number');
            if (el) el.textContent = this._remainingSeconds;
        },

        _hideModal() {
            clearInterval(this._countdownInterval);
            if (this._modalEl) this._modalEl.classList.remove('sm-visible');
        },

        async _extendSession() {
            const token = this._getToken();
            if (!token) { this._logout(); return; }

            const extendBtn = this._modalEl.querySelector('.sm-extend-btn');
            extendBtn.disabled = true;
            extendBtn.textContent = 'Extending…';

            try {
                const res = await fetch(`${this._config.apiBase}/auth/refresh-token`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` }
                });

                if (!res.ok) {
                    // Token was already dead, or account got suspended mid-session — can't extend.
                    this._logout();
                    return;
                }

                const data = await res.json();
                this._setToken(data.token);
                this._hideModal();
                this._resetIdleTimer();

            } catch (err) {
                console.error('Session extend failed:', err);
                // Network hiccup — don't force-logout on a transient error,
                // let the countdown keep running; if it hits 0 we log out anyway.
            } finally {
                extendBtn.disabled = false;
                extendBtn.textContent = 'Extend Session';
            }
        },

       _logout() {
            this._hideModal();
            clearInterval(this._silentRefreshInterval);
            clearTimeout(this._silentRetryTimer);
            this._clearToken();
            this._goToLogin();
        },

        _goToLogin() {
            window.location.href = this._config.loginUrl;
        },

        _buildModal() {
            const wrap = document.createElement('div');
            wrap.className = 'sm-overlay';
            wrap.innerHTML = `
                <div class="sm-modal" role="dialog" aria-modal="true" aria-labelledby="sm-title">
                    <div class="sm-icon">⏳</div>
                    <h2 id="sm-title" class="sm-title">Your Session Is About to Expire</h2>
                    <p class="sm-body">You've been inactive for a while. For your security, you'll be logged out in
                        <span class="sm-countdown-number">60</span> seconds.
                    </p>
                    <div class="sm-actions">
                        <button type="button" class="sm-btn sm-logout-btn">Log Out Now</button>
                        <button type="button" class="sm-btn sm-extend-btn">Extend Session</button>
                    </div>
                </div>
            `;
            document.body.appendChild(wrap);
            this._modalEl = wrap;

            wrap.querySelector('.sm-extend-btn').addEventListener('click', () => this._extendSession());
            wrap.querySelector('.sm-logout-btn').addEventListener('click', () => this._logout());

            this._injectStyles();
        },

        _injectStyles() {
            if (document.getElementById('sm-styles')) return;
            const style = document.createElement('style');
            style.id = 'sm-styles';
            // Uses the HOST PAGE's own CSS custom properties (--panel, --accent,
            // --border2, --text, --text-muted, --bg) rather than hardcoded colors
            // or a specific font name. Both the landlord dashboard and tenant
            // dashboard already define these variables (each with their own
            // theme/accent), so this modal automatically matches whichever
            // page it's dropped into — no per-page styling needed, and no
            // dependency on a font that may not actually be loaded there.
            style.textContent = `
                .sm-overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.65);
                    backdrop-filter: blur(3px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 99999;
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.2s ease;
                }
                .sm-overlay.sm-visible {
                    opacity: 1;
                    pointer-events: all;
                }
                .sm-modal {
                    background: var(--panel, #1e222c);
                    border: 1px solid var(--border2, rgba(255,255,255,0.15));
                    border-radius: 14px;
                    padding: 32px 36px;
                    max-width: 380px;
                    width: 90%;
                    text-align: center;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
                    font-family: inherit;
                    transform: translateY(10px);
                    transition: transform 0.2s ease;
                }
                .sm-overlay.sm-visible .sm-modal {
                    transform: translateY(0);
                }
                .sm-icon {
                    font-size: 34px;
                    margin-bottom: 8px;
                }
                .sm-title {
                    font-family: Georgia, 'Times New Roman', serif;
                    font-style: italic;
                    color: var(--text, #e2e8f0);
                    font-size: 20px;
                    margin: 0 0 12px;
                }
                .sm-body {
                    color: var(--text-muted, #94a3b8);
                    font-size: 14px;
                    line-height: 1.6;
                    margin: 0 0 24px;
                }
                .sm-countdown-number {
                    display: inline-block;
                    min-width: 28px;
                    color: var(--accent, #a78bfa);
                    font-weight: 700;
                    font-family: monospace;
                }
                .sm-actions {
                    display: flex;
                    gap: 10px;
                    justify-content: center;
                }
                .sm-btn {
                    flex: 1;
                    padding: 10px 16px;
                    border-radius: 8px;
                    font-size: 13px;
                    font-weight: 600;
                    font-family: inherit;
                    cursor: pointer;
                    border: 1px solid transparent;
                    transition: opacity 0.15s ease;
                }
                .sm-btn:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }
                .sm-extend-btn {
                    background: var(--accent, #a78bfa);
                    color: var(--bg, #111318);
                }
                .sm-extend-btn:hover:not(:disabled) {
                    opacity: 0.9;
                }
                .sm-logout-btn {
                    background: transparent;
                    color: var(--text-muted, #94a3b8);
                    border-color: var(--border2, rgba(255,255,255,0.15));
                }
                .sm-logout-btn:hover {
                    border-color: var(--accent, #a78bfa);
                    color: var(--text, #e2e8f0);
                }
            `;
            document.head.appendChild(style);
        }
    };

    window.SessionManager = SessionManager;

})(window);