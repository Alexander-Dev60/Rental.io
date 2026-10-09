// ═══════════════════════════════════════════════════════
//  buildings.js — landlord / caretaker side of the Building → House hierarchy
//
//  • Houses + Assign House pages show BUILDING CARDS first, then the houses of the chosen building
//    (the existing house grid, menu and actions are reused unchanged).
//  • Create / rename / recolor / delete buildings, move houses between buildings, organize old data.
//  • Applications inbox (tenants applying for an available house) — approval runs the existing
//    assignment rules on the server.
//
//  Loaded after script.js and dashboard.js. Uses their globals: API, authHeaders, getPropertyId,
//  getPropertyName, showToast, ICON, openModal, closeModal, IS_CARETAKER, renderHouseGrid, loadHouses.
// ═══════════════════════════════════════════════════════

(function () {
    'use strict';

    const SCOPES = {
        houses: { key: 'houses', grid: 'houseGrid',       legend: 'houseGroupLegend',       section: 'sec-houses' },
        assign: { key: 'assign', grid: 'assignHouseGrid', legend: 'assignHouseGroupLegend', section: 'sec-assign' }
    };
    const ICON_CHOICES = ['properties', 'houses', 'home', 'layers', 'wall', 'box'];
    const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const color = i => (typeof _groupColor === 'function' ? _groupColor(i) : '#60a5fa');

    const state = { houses: { view: 'buildings', id: null }, assign: { view: 'buildings', id: null } };
    let data = { propertyId: null, buildings: [], unassigned: null, loaded: false };
    const houseCache = { houses: [], assign: [] };
    let refreshTimer = null, inflight = 0;
    const animateGrid = { houses: false, assign: false };
    const animateCards = { houses: false, assign: false };
    const lastSig = { houses: '', assign: '' };
    let rendering = false;                                    // true while WE call renderHouseGrid   // entrance animation only on a real navigation, never on a background refresh

    const scopeOfGrid = gridId => Object.values(SCOPES).find(s => s.grid === gridId) || null;
    const mayEdit = () => !(typeof IS_CARETAKER !== 'undefined' && IS_CARETAKER);

    // ── which houses belong to the open building ──
    function belongs(h, id) {
        const gid = h.group ? String(h.group._id || h.group) : null;
        if (id === 'unassigned') return !gid || !data.buildings.some(b => String(b._id) === gid);
        return gid === String(id);
    }

    // ═════════ data ═════════
    // Safety net: if /buildings can't be reached (older backend, network hiccup) the houses must NEVER
    // become unreachable. Build the cards from the houses themselves (each carries its group) instead.
    function deriveFromHouses(propertyId) {
        const houses = houseCache.houses.length ? houseCache.houses : houseCache.assign;
        const by = new Map(); const loose = { occupied: 0, vacant: 0 };
        houses.forEach(h => {
            const g = h.group && (h.group._id || h.group) ? h.group : null;
            let bucket = loose;
            if (g) { const k = String(g._id); if (!by.has(k)) by.set(k, { g, occupied: 0, vacant: 0 }); bucket = by.get(k); }
            if (h.status === 'occupied') bucket.occupied++; else bucket.vacant++;
        });
        const stats = o => { const t = o.occupied + o.vacant; return { totalHouses: t, occupied: o.occupied, vacant: o.vacant, occupancyPercent: pct(o.occupied, t) }; };
        const buildings = [...by.values()].sort((a, b) => new Date(a.g.createdAt || 0) - new Date(b.g.createdAt || 0)).map(o => ({
            _id: o.g._id, label: o.g.label || 'Building', prefix: o.g.prefix || '', padWidth: o.g.padWidth || 0, colorIndex: o.g.colorIndex || 0,
            icon: o.g.icon || 'properties', description: o.g.description || '', ...stats(o)
        }));
        const looseTotal = loose.occupied + loose.vacant;
        return { propertyId, buildings, unassigned: looseTotal ? stats(loose) : null, loaded: true, derived: true };
    }

    async function refresh() {
        const propertyId = typeof getPropertyId === 'function' ? getPropertyId() : null;
        if (!propertyId) { data = { propertyId: null, buildings: [], unassigned: null, loaded: true }; renderAll(); return; }

        if (data.propertyId && data.propertyId !== propertyId) {          // property switched → back to the cards
            Object.values(state).forEach(s => { s.view = 'buildings'; s.id = null; });
        }
        const my = ++inflight;
        try {
            const res = await fetch(`${API}/buildings?propertyId=${encodeURIComponent(propertyId)}`, { headers: authHeaders() });
            const json = await res.json();
            if (my !== inflight) return;                                    // a newer refresh superseded this one
            if (!res.ok) { data = deriveFromHouses(propertyId); renderAll(); return; }
            const firstLoad = !data.loaded || data.propertyId !== propertyId;
            data = { propertyId, buildings: json.buildings || [], unassigned: json.unassigned || null, loaded: true };
            if (firstLoad) Object.keys(animateGrid).forEach(k => { animateCards[k] = true; });
            // an open building that no longer exists → back to the cards
            Object.values(state).forEach(s => {
                if (s.view === 'building' && s.id !== 'unassigned' && !data.buildings.some(b => String(b._id) === String(s.id))) { s.view = 'buildings'; s.id = null; }
                if (s.view === 'building' && s.id === 'unassigned' && !data.unassigned) { s.view = 'buildings'; s.id = null; }
            });
        } catch (e) { console.error('buildings refresh failed', e); data = deriveFromHouses(propertyId); }
        renderAll();
    }
    function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); }

    // ═════════ DOM ═════════
    function rootFor(scope) {
        let root = document.getElementById(`bb-root-${scope.key}`);
        if (root) return root;
        const anchor = document.getElementById(scope.legend) || document.getElementById(scope.grid);
        if (!anchor) return null;
        root = document.createElement('div');
        root.id = `bb-root-${scope.key}`;
        root.className = 'bb-root';
        anchor.parentNode.insertBefore(root, anchor);
        return root;
    }

    function pct(o, t) { return t ? Math.round((o / t) * 100) : 0; }

    function cardHtml(b, isUnassigned) {
        const c = isUnassigned ? 'var(--text-dim)' : color(b.colorIndex);
        const id = isUnassigned ? 'unassigned' : b._id;
        const label = isUnassigned ? 'Unassigned houses' : esc(b.label);
        const icon = isUnassigned ? 'box' : (b.icon || 'properties');
        return `
        <button type="button" class="bb-card${isUnassigned ? ' bb-unassigned' : ''}" style="--bb:${c}" data-bb-open="${esc(id)}" aria-label="Open ${label}">
            <span class="bb-card-top">
                <span class="bb-card-icon">${ICON(icon, 22)}</span>
                <span class="bb-card-title">${label}</span>
            </span>
            ${b.description ? `<span class="bb-card-desc">${esc(b.description)}</span>` : ''}
            <span class="bb-card-stats">
                <span><b>${b.totalHouses}</b> house${b.totalHouses === 1 ? '' : 's'}</span>
                <span class="bb-st-occ"><b>${b.occupied}</b> occupied</span>
                <span class="bb-st-vac"><b>${b.vacant}</b> vacant</span>
            </span>
            <span class="bb-bar" role="img" aria-label="${b.occupancyPercent}% occupied"><span style="width:${b.occupancyPercent}%"></span></span>
            <span class="bb-card-cta">${isUnassigned ? 'View houses' : 'View Building'} ${ICON('chevron', 14)}</span>
        </button>`;
    }

    function cardsView(scope) {
        const parts = data.buildings.map(b => cardHtml(b, false));
        if (data.unassigned) parts.push(cardHtml({ ...data.unassigned, label: '', description: '' }, true));
        if (mayEdit() && scope.key === 'houses' && !data.derived) {
            parts.push(`<button type="button" class="bb-card bb-new" data-bb-new="1" aria-label="Add a building">
                <span class="bb-card-top"><span class="bb-card-icon">${ICON('plus', 22)}</span><span class="bb-card-title">New building</span></span>
                <span class="bb-card-desc">Group houses by flat, block or floor.</span></button>`);
        }
        const organize = (data.unassigned && mayEdit() && data.buildings.length === 0 && scope.key === 'houses') ? `
            <div class="bb-hint">Your houses are not in a building yet. <button type="button" class="btn btn-secondary btn-sm" data-bb-organize="1">Put them in “Main Building”</button>
            <span class="bb-hint-sub">You can create more buildings and move houses between them any time.</span></div>` : '';

        if (!data.loaded) return `<div class="empty-state">Loading buildings…</div>`;
        if (!parts.length) return `<div class="empty-state"><span class="icon">${ICON('properties', 26)}</span>No buildings or houses yet${mayEdit() ? ' — add a house or create a building to begin' : ''}</div>`;
        return `${organize}<div class="bb-cards" role="list">${parts.join('')}</div>`;
    }

    function crumbsHtml(scope, st) {
        const b = st.id === 'unassigned' ? { label: 'Unassigned houses' } : data.buildings.find(x => String(x._id) === String(st.id));
        const prop = typeof getPropertyName === 'function' ? getPropertyName() : 'Property';
        const tools = (st.id !== 'unassigned' && mayEdit() && scope.key === 'houses' && !data.derived) ? `
            <span class="bb-tools">
                <button type="button" class="btn btn-secondary btn-sm" data-bb-edit="${esc(st.id)}">${ICON('edit', 13)} Edit</button>
                <button type="button" class="btn btn-secondary btn-sm" data-bb-addhouse="${esc(st.id)}">${ICON('plus', 13)} Add houses</button>
                <button type="button" class="btn btn-secondary btn-sm bb-del" data-bb-delete="${esc(st.id)}">${ICON('trash', 13)}</button>
            </span>` : '';
        return `
        <nav class="bb-crumbs" aria-label="Where you are">
            <button type="button" class="bb-back" data-bb-back="1" aria-label="Back to all buildings">${ICON('chevron', 14)} All buildings</button>
            <span class="bb-sep">/</span><span class="bb-crumb-prop">${esc(prop)}</span>
            <span class="bb-sep">/</span><span class="bb-crumb-cur" style="--bb:${st.id === 'unassigned' ? 'var(--text-dim)' : color((b || {}).colorIndex)}">${esc(b ? b.label : '…')}</span>
            ${tools}
        </nav>`;
    }

    function applyView(scope, animate) {
        const root = rootFor(scope);
        if (!root) return;
        const grid = document.getElementById(scope.grid), legend = document.getElementById(scope.legend);
        const st = state[scope.key];

        const html = st.view === 'building' ? crumbsHtml(scope, st) : cardsView(scope);
        const changed = root.__html !== html || root.__view !== st.view;
        if (changed) {                       // a background refresh with nothing new leaves the DOM (and focus) alone
            root.innerHTML = html; root.__html = html; root.__view = st.view;
        }
        if (st.view === 'building') {
            if (grid) grid.style.display = '';
        } else {
            if (grid) grid.style.display = 'none';
            if (animate && changed && !reduced()) stagger(root.querySelectorAll('.bb-card'), 0);
        }
        if (legend) legend.style.display = 'none';
        // keep the Add-house form's building list current
        fillAddSelect();
    }

    // Re-draws ONLY the building cards / breadcrumb. It never touches the house grid: houses are redrawn
    // by loadHouses() (which calls renderHouseGrid), so a /buildings refresh can never swap house cards
    // out from under a click.
    function renderAll() {
        Object.values(SCOPES).forEach(scope => {
            applyView(scope, animateCards[scope.key]); animateCards[scope.key] = false;
        });
    }

    function stagger(nodes, base) {
        if (reduced() || !nodes || !nodes.length || !nodes[0].animate) return;
        Array.from(nodes).slice(0, 16).forEach((n, i) => {
            n.animate(
                [{ opacity: 0, transform: 'translateY(8px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
                { duration: 260, delay: base + i * 28, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' }
            );
        });
    }

    // ── called by renderHouseGrid() every time houses are (re)rendered ──
    function intercept(gridId, legendId, houses) {
        const scope = scopeOfGrid(gridId);
        if (!scope) return { houses, skip: false };

        const sig = houses.map(h => `${h._id}:${h.status}:${h.group ? (h.group._id || h.group) : ''}`).join('|');
        houseCache[scope.key] = houses;
        const st = state[scope.key];
        // Counts follow whatever changed the houses — but only when the list really changed, and never
        // as a reaction to our own renders.
        if (!rendering && sig !== lastSig[scope.key]) { lastSig[scope.key] = sig; scheduleRefresh(); }

        if (st.view !== 'building') return { houses, skip: true };

        const filtered = houses.filter(h => belongs(h, st.id));
        return { houses: filtered, skip: false, emptyText: 'No houses in this building yet',
                 afterRender: grid => { if (animateGrid[scope.key]) { animateGrid[scope.key] = false; stagger(grid.querySelectorAll('.house-card'), 40); } } };
    }

    // ═════════ navigation ═════════
    function openBuilding(scopeKey, id) {
        const st = state[scopeKey]; st.view = 'building'; st.id = id;
        const scope = SCOPES[scopeKey];
        animateGrid[scopeKey] = true;
        applyView(scope);
        rendering = true;
        try { renderHouseGrid(houseCache[scopeKey], scope.grid, scope.legend); } finally { rendering = false; }
        const root = rootFor(scope); if (root && root.scrollIntoView) root.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
        const back = root && root.querySelector('[data-bb-back]'); if (back) back.focus({ preventScroll: true });
    }
    function backToCards(scopeKey) {
        const st = state[scopeKey]; st.view = 'buildings'; st.id = null;
        applyView(SCOPES[scopeKey], true);
        const first = rootFor(SCOPES[scopeKey]).querySelector('.bb-card'); if (first) first.focus({ preventScroll: true });
    }

    function onClick(e) {
        const root = e.target.closest('.bb-root'); if (!root) return;
        const scopeKey = root.id.replace('bb-root-', '');
        const t = e.target.closest('[data-bb-open],[data-bb-back],[data-bb-new],[data-bb-edit],[data-bb-delete],[data-bb-addhouse],[data-bb-organize]');
        if (!t) return;
        if (t.hasAttribute('data-bb-open'))     return openBuilding(scopeKey, t.getAttribute('data-bb-open'));
        if (t.hasAttribute('data-bb-back'))     return backToCards(scopeKey);
        if (t.hasAttribute('data-bb-new'))      return openBuildingModal(null);
        if (t.hasAttribute('data-bb-edit'))     return openBuildingModal(t.getAttribute('data-bb-edit'));
        if (t.hasAttribute('data-bb-delete'))   return deleteBuilding(t.getAttribute('data-bb-delete'));
        if (t.hasAttribute('data-bb-addhouse')) return addHouseHere(t.getAttribute('data-bb-addhouse'));
        if (t.hasAttribute('data-bb-organize')) return organize();
    }

    // ═════════ create / edit building modal ═════════
    function modalShell() {
        let m = document.getElementById('modal-building');
        if (m) return m;
        m = document.createElement('div');
        m.id = 'modal-building'; m.className = 'modal-overlay';
        m.innerHTML = `
            <div class="modal" style="max-width:420px" role="dialog" aria-modal="true" aria-labelledby="bbModalTitle">
                <div class="modal-header">
                    <div class="modal-title" id="bbModalTitle"></div>
                    <button class="modal-close" type="button" onclick="closeModal('modal-building')" aria-label="Close">${ICON('close', 16)}</button>
                </div>
                <input type="hidden" id="bbEditId">
                <label class="pay-setup-label" for="bbLabel" style="display:block;margin-bottom:0.35rem">Building name</label>
                <input type="text" id="bbLabel" maxlength="60" placeholder="e.g. Flat 1, Block A" style="margin-bottom:0.75rem">
                <label class="pay-setup-label" for="bbDesc" style="display:block;margin-bottom:0.35rem">Short note (optional)</label>
                <input type="text" id="bbDesc" maxlength="200" placeholder="e.g. Near the gate, ground floor" style="margin-bottom:0.75rem">
                <div class="pay-setup-label" style="margin-bottom:0.35rem">Icon</div>
                <div class="bb-pick" id="bbIcons" role="radiogroup" aria-label="Icon"></div>
                <div class="pay-setup-label" style="margin:0.75rem 0 0.35rem">Color</div>
                <div class="bb-pick" id="bbColors" role="radiogroup" aria-label="Color"></div>
                <button class="btn btn-primary btn-full" type="button" id="bbSave" style="margin-top:1.1rem" onclick="BuildingBrowser.saveBuilding()"></button>
            </div>`;
        document.body.appendChild(m);
        m.addEventListener('click', e => {
            const i = e.target.closest('[data-bb-icon]'), c = e.target.closest('[data-bb-color]');
            if (i) { m.dataset.icon = i.dataset.bbIcon; paintPickers(); }
            if (c) { m.dataset.color = c.dataset.bbColor; paintPickers(); }
        });
        return m;
    }
    function paintPickers() {
        const m = document.getElementById('modal-building');
        document.getElementById('bbIcons').innerHTML = ICON_CHOICES.map(n =>
            `<button type="button" role="radio" aria-checked="${m.dataset.icon === n}" class="bb-chip${m.dataset.icon === n ? ' on' : ''}" data-bb-icon="${n}" aria-label="${n}">${ICON(n, 18)}</button>`).join('');
        document.getElementById('bbColors').innerHTML = Array.from({ length: 8 }, (_, i) =>
            `<button type="button" role="radio" aria-checked="${String(m.dataset.color) === String(i)}" class="bb-chip bb-swatch${String(m.dataset.color) === String(i) ? ' on' : ''}" style="--bb:${color(i)}" data-bb-color="${i}" aria-label="Color ${i + 1}"></button>`).join('');
    }
    function openBuildingModal(id) {
        if (!mayEdit()) return;
        const m = modalShell();
        const b = id ? data.buildings.find(x => String(x._id) === String(id)) : null;
        document.getElementById('bbModalTitle').innerHTML = `${ICON('properties', 18)} ${b ? 'Edit building' : 'New building'}`;
        document.getElementById('bbEditId').value = b ? b._id : '';
        document.getElementById('bbLabel').value = b ? b.label : '';
        document.getElementById('bbDesc').value = b ? (b.description || '') : '';
        document.getElementById('bbSave').innerHTML = `${ICON('check', 14)} ${b ? 'Save changes' : 'Create building'}`;
        const used = new Set(data.buildings.map(x => x.colorIndex));
        let free = 0; while (free < 8 && used.has(free)) free++;
        m.dataset.icon = b ? (b.icon || 'properties') : 'properties';
        m.dataset.color = b ? String(b.colorIndex || 0) : String(free < 8 ? free : data.buildings.length % 8);
        paintPickers();
        m.classList.add('open');
        setTimeout(() => document.getElementById('bbLabel').focus(), 30);
    }
    async function saveBuilding() {
        const m = document.getElementById('modal-building');
        const id = document.getElementById('bbEditId').value;
        const label = document.getElementById('bbLabel').value.trim();
        if (!label) { showToast('Give the building a name', 'warn'); return; }
        const body = { label, description: document.getElementById('bbDesc').value.trim(), icon: m.dataset.icon, colorIndex: Number(m.dataset.color) };
        if (!id) body.propertyId = getPropertyId();
        const btn = document.getElementById('bbSave'); btn.disabled = true;
        try {
            const res = await fetch(id ? `${API}/buildings/${id}` : `${API}/buildings`, { method: id ? 'PUT' : 'POST', headers: authHeaders(), body: JSON.stringify(body) });
            const json = await res.json();
            if (!res.ok) { showToast(json.message || 'Could not save the building', 'error'); return; }
            showToast(id ? 'Building updated' : `Building “${label}” created`, 'success');
            closeModal('modal-building');
            await refresh();
        } catch (e) { showToast('Network error', 'error'); }
        finally { btn.disabled = false; }
    }

    async function deleteBuilding(id) {
        const b = data.buildings.find(x => String(x._id) === String(id)); if (!b) return;
        const run = async () => {
            try {
                const res = await fetch(`${API}/buildings/${id}`, { method: 'DELETE', headers: authHeaders() });
                const json = await res.json();
                if (!res.ok) { showToast(json.message || 'Could not delete', 'error'); return; }
                showToast('Building deleted', 'success');
                Object.values(state).forEach(s => { if (String(s.id) === String(id)) { s.view = 'buildings'; s.id = null; } });
                await refresh();
            } catch { showToast('Network error', 'error'); }
        };
        if (typeof openDangerModal === 'function') {
            openDangerModal({ icon: ICON('trash', 28), title: 'Delete building', message: `Delete <strong>${esc(b.label)}</strong>? This only works when it has no houses.`, label: 'Delete building', onConfirm: run });
        } else if (window.confirm(`Delete “${b.label}”?`)) run();
    }

    async function organize() {
        try {
            const res = await fetch(`${API}/buildings/organize`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ propertyId: getPropertyId() }) });
            const json = await res.json();
            if (!res.ok) { showToast(json.message || 'Could not organize', 'error'); return; }
            showToast(json.message, 'success');
            await loadHouses(); await refresh();
        } catch { showToast('Network error', 'error'); }
    }

    // ═════════ add-house form: pick the building ═════════
    function fillAddSelect() {
        const nameInput = document.getElementById('houseName'); if (!nameInput) return;
        let sel = document.getElementById('houseBuilding');
        if (!sel) {
            sel = document.createElement('select'); sel.id = 'houseBuilding'; sel.setAttribute('aria-label', 'Building');
            nameInput.insertAdjacentElement('afterend', sel);
        }
        const keep = sel.value;
        sel.innerHTML = `<option value="">Building: none (unassigned)</option>` +
            data.buildings.map(b => `<option value="${esc(b._id)}">${esc(b.label)}</option>`).join('');
        if (keep && data.buildings.some(b => String(b._id) === keep)) sel.value = keep;
    }
    function addHouseHere(id) {
        // Open the house generator already attached to THIS building (single / multiple / extend) — the
        // landlord never has to pick the building again. The inline form below stays as a fallback.
        if (typeof window.openGenerateHousesForBuilding === 'function') { window.openGenerateHousesForBuilding(id); return; }
        const sel = document.getElementById('houseBuilding'); if (sel) sel.value = id;
        const input = document.getElementById('houseName');
        if (input) { input.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); input.focus({ preventScroll: true }); }
    }

    // ═════════ move houses ═════════
    async function moveHouses(houseIds, buildingId) {
        try {
            const res = await fetch(`${API}/buildings/move-houses`, { method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ propertyId: getPropertyId(), houseIds, buildingId: buildingId || null }) });
            const json = await res.json();
            if (!res.ok) { showToast(json.message || 'Could not move the house', 'error'); return false; }
            showToast(json.message, 'success');
            await loadHouses(); await refresh();
            return true;
        } catch { showToast('Network error', 'error'); return false; }
    }
    function openMoveModal(houseId, houseName, currentGroupId) {
        document.querySelectorAll('.house-ctx-menu').forEach(m => m.remove());
        if (!mayEdit()) return;
        let m = document.getElementById('modal-move-house');
        if (!m) {
            m = document.createElement('div'); m.id = 'modal-move-house'; m.className = 'modal-overlay';
            m.innerHTML = `<div class="modal" style="max-width:380px" role="dialog" aria-modal="true" aria-labelledby="bbMoveTitle">
                <div class="modal-header"><div class="modal-title" id="bbMoveTitle"></div>
                <button class="modal-close" type="button" onclick="closeModal('modal-move-house')" aria-label="Close">${ICON('close', 16)}</button></div>
                <input type="hidden" id="bbMoveHouseId">
                <label class="pay-setup-label" for="bbMoveSelect" style="display:block;margin-bottom:0.35rem">Building</label>
                <select id="bbMoveSelect" style="margin-bottom:0.5rem"></select>
                <div class="field-hint" style="margin-bottom:1rem">Only the grouping changes — the tenant, rent, deposit and payments stay exactly as they are.</div>
                <button class="btn btn-primary btn-full" type="button" id="bbMoveBtn"></button></div>`;
            document.body.appendChild(m);
            m.querySelector('#bbMoveBtn').addEventListener('click', async () => {
                const ok = await moveHouses([document.getElementById('bbMoveHouseId').value], document.getElementById('bbMoveSelect').value || null);
                if (ok) closeModal('modal-move-house');
            });
        }
        document.getElementById('bbMoveTitle').innerHTML = `${ICON('properties', 18)} Move ${esc(houseName)}`;
        document.getElementById('bbMoveHouseId').value = houseId;
        document.getElementById('bbMoveBtn').innerHTML = `${ICON('check', 14)} Move house`;
        const sel = document.getElementById('bbMoveSelect');
        sel.innerHTML = `<option value="">Unassigned</option>` + data.buildings.map(b => `<option value="${esc(b._id)}">${esc(b.label)}</option>`).join('');
        sel.value = currentGroupId && data.buildings.some(b => String(b._id) === String(currentGroupId)) ? currentGroupId : '';
        m.classList.add('open');
    }

    // used by the Edit House modal
    function fillEditSelect(house) {
        const wrap = document.getElementById('editHouseBuildingWrap'); if (!wrap) return;
        if (!mayEdit()) { wrap.innerHTML = ''; return; }
        const cur = house.group ? String(house.group._id || house.group) : '';
        const known = data.buildings.some(b => String(b._id) === cur) ? cur : '';
        wrap.innerHTML = `<label class="pay-setup-label" for="editHouseBuilding" style="display:block;margin-bottom:0.35rem">Building</label>
            <select id="editHouseBuilding" data-initial="${esc(known)}" style="margin-bottom:0.75rem">
            <option value="">Unassigned</option>${data.buildings.map(b => `<option value="${esc(b._id)}">${esc(b.label)}</option>`).join('')}</select>`;
        document.getElementById('editHouseBuilding').value = known;
    }

    // <optgroup>s for the Assign-Tenant dropdown, so houses stay grouped by building
    function groupedHouseOptions(houses, optionFn) {
        const by = new Map();
        houses.forEach(h => {
            const gid = h.group ? String(h.group._id || h.group) : '';
            const label = h.group && h.group.label ? h.group.label : 'Unassigned';
            if (!by.has(gid)) by.set(gid, { label, items: [] });
            by.get(gid).items.push(h);
        });
        if (by.size <= 1) return houses.map(optionFn).join('');
        return [...by.values()].map(g => `<optgroup label="${esc(g.label)}">${g.items.map(optionFn).join('')}</optgroup>`).join('');
    }

    // ═════════ APPLICATIONS INBOX ═════════
    let appFilter = 'pending';
    const money = n => 'Ksh ' + Number(n || 0).toLocaleString();
    const when = d => { try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); } catch { return ''; } };

    async function loadApplications() {
        const box = document.getElementById('applicationsList'); if (!box) return;
        box.innerHTML = `<div class="empty-state">Loading applications…</div>`;
        document.querySelectorAll('[data-app-filter]').forEach(b => b.classList.toggle('on', b.dataset.appFilter === appFilter));
        try {
            const pid = getPropertyId();
            const res = await fetch(`${API}/applications?status=${appFilter}${pid ? `&propertyId=${encodeURIComponent(pid)}` : ''}`, { headers: authHeaders() });
            const json = await res.json();
            if (!res.ok) { box.innerHTML = `<div class="empty-state">${esc(json.message || 'Could not load applications')}</div>`; return; }
            renderApplications(json.applications || []);
        } catch { box.innerHTML = `<div class="empty-state">Network error</div>`; }
        loadApplicationBadge();
    }

    function renderApplications(list) {
        const box = document.getElementById('applicationsList');
        if (!list.length) {
            box.innerHTML = `<div class="empty-state"><span class="icon">${ICON('houses', 26)}</span>${appFilter === 'pending' ? 'No applications waiting' : 'No applications yet'}</div>`;
            return;
        }
        const canManage = !IS_CARETAKER || (typeof getCaretakerPermissions === 'function' && getCaretakerPermissions().canManageTenants);
        box.innerHTML = list.map(a => {
            const dep = a.deposit, bc = a.building ? color(a.building.colorIndex) : 'var(--text-dim)';
            const stat = { pending: 'pill-yellow', approved: 'pill-green', rejected: 'pill-red', withdrawn: '', cancelled: '' }[a.status] || '';
            let why = '';
            if (a.status === 'pending') {
                if (a.house && a.house.status !== 'available') why = 'This house is no longer available.';
                else if (dep && dep.requiredBeforeAssignment && !dep.recorded) why = `Deposit of ${money(dep.required)} must be recorded for this tenant before approving.`;
                else if (a.tenant && a.canApprove === false) why = 'This tenant can’t be assigned right now.';
            }
            return `
            <article class="bb-app" style="--bb:${bc}" data-app="${esc(a._id)}">
                <div class="bb-app-main">
                    <div class="bb-app-title">${esc(a.tenant ? a.tenant.name : 'Tenant')} <span class="bb-arrow">→</span> <b>${esc(a.house ? a.house.name : 'House')}</b>
                        <span class="pill ${stat}" style="margin-left:0.4rem">${esc(a.status)}</span></div>
                    <div class="bb-app-meta">
                        ${a.building ? `<span class="bb-pillb">${esc(a.building.label)}</span>` : ''}
                        <span>${a.house ? money(a.house.rent) + (a.house.billingCycle === 'semester' ? ' / semester' : ' / mo') : ''}</span>
                        <span>${esc(a.tenant ? a.tenant.phone || '' : '')}</span><span>${when(a.createdAt)}</span>
                    </div>
                    ${a.note ? `<div class="bb-app-note">“${esc(a.note)}”</div>` : ''}
                    ${a.decisionNote ? `<div class="bb-app-note">${esc(a.decisionNote)}</div>` : ''}
                    ${why ? `<div class="bb-app-why">${esc(why)}</div>` : ''}
                </div>
                ${a.status === 'pending' && canManage ? `<div class="bb-app-actions">
                    <button type="button" class="btn btn-primary btn-sm" data-app-approve="${esc(a._id)}" ${a.canApprove ? '' : 'disabled'}>${ICON('check', 13)} Approve</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-app-reject="${esc(a._id)}">Decline</button></div>` : ''}
            </article>`;
        }).join('');
        stagger(box.querySelectorAll('.bb-app'), 0);
    }

    async function decide(id, kind, note) {
        try {
            const res = await fetch(`${API}/applications/${id}/${kind}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(kind === 'reject' ? { note } : {}) });
            const json = await res.json();
            if (!res.ok) { showToast(json.message || 'Could not update the application', 'error'); await loadApplications(); return; }
            showToast(json.message, 'success');
            await loadApplications();
            if (kind === 'approve') { if (typeof loadHouses === 'function') loadHouses(); if (typeof loadTenants === 'function') loadTenants(); }
        } catch { showToast('Network error', 'error'); }
    }

    function onAppClick(e) {
        const f = e.target.closest('[data-app-filter]');
        if (f) { appFilter = f.dataset.appFilter; return loadApplications(); }
        const a = e.target.closest('[data-app-approve]');
        if (a) { a.disabled = true; return decide(a.dataset.appApprove, 'approve'); }
        const r = e.target.closest('[data-app-reject]');
        if (r) return openDeclineModal(r.dataset.appReject);
    }

    function openDeclineModal(id) {
        let m = document.getElementById('modal-decline-app');
        if (!m) {
            m = document.createElement('div'); m.id = 'modal-decline-app'; m.className = 'modal-overlay';
            m.innerHTML = `<div class="modal" style="max-width:400px" role="dialog" aria-modal="true" aria-labelledby="bbDeclineTitle">
                <div class="modal-header"><div class="modal-title" id="bbDeclineTitle">${ICON('houses', 18)} Decline application</div>
                <button class="modal-close" type="button" onclick="closeModal('modal-decline-app')" aria-label="Close">${ICON('close', 16)}</button></div>
                <input type="hidden" id="bbDeclineId">
                <label class="pay-setup-label" for="bbDeclineNote" style="display:block;margin-bottom:0.35rem">Message to the tenant (optional)</label>
                <textarea id="bbDeclineNote" maxlength="300" rows="3" placeholder="e.g. That house was promised to someone else — please try Flat 2" style="margin-bottom:1rem"></textarea>
                <button class="btn btn-danger btn-full" type="button" id="bbDeclineBtn">Decline application</button></div>`;
            document.body.appendChild(m);
            m.querySelector('#bbDeclineBtn').addEventListener('click', async () => {
                const btn = document.getElementById('bbDeclineBtn'); btn.disabled = true;
                await decide(document.getElementById('bbDeclineId').value, 'reject', document.getElementById('bbDeclineNote').value.trim());
                btn.disabled = false; closeModal('modal-decline-app');
            });
        }
        document.getElementById('bbDeclineId').value = id;
        document.getElementById('bbDeclineNote').value = '';
        m.classList.add('open');
        setTimeout(() => document.getElementById('bbDeclineNote').focus(), 30);
    }

    function updateApplicationBadge(n) {
        const b = document.getElementById('applicationBadge'); if (!b) return;
        b.textContent = n; b.style.display = n > 0 ? 'inline-block' : 'none';
    }
    async function loadApplicationBadge() {
        try {
            const pid = typeof getPropertyId === 'function' ? getPropertyId() : null;
            const res = await fetch(`${API}/applications/pending-count${pid ? `?propertyId=${encodeURIComponent(pid)}` : ''}`, { headers: authHeaders() });
            const json = await res.json();
            if (res.ok) updateApplicationBadge(json.count || 0);
        } catch { /* badge is best-effort */ }
    }

    // ═════════ boot ═════════
    function init() {
        document.addEventListener('click', onClick);
        const sec = document.getElementById('sec-applications');
        if (sec) sec.addEventListener('click', onAppClick);
        if (localStorage.getItem('token')) { refresh(); loadApplicationBadge(); }
        setInterval(() => { if (localStorage.getItem('token')) loadApplicationBadge(); }, 30000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    window.BuildingBrowser = {
        intercept, refresh, openBuilding, backToCards, openMoveModal, moveHouses, fillEditSelect, groupedHouseOptions,
        saveBuilding, loadApplications, loadApplicationBadge,
        onSectionShown: name => { if (name === 'houses' || name === 'assign') refresh(); if (name === 'applications') loadApplications(); },
        _state: state, _data: () => data
    };
})();