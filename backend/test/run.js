const { makeModel, makeApp, mongoose } = require('./fake');
const createAssigner = require('../services/assignment');
const registerBuildingRoutes = require('../routes/buildings');
const registerApplicationRoutes = require('../routes/applications');

const BUILDING_ICONS = ['properties', 'houses', 'home', 'layers', 'wall', 'box'];

let pass = 0, fail = 0; const failures = [];
function ok(cond, label, extra) { if (cond) pass++; else { fail++; failures.push(label + (extra ? '  → ' + JSON.stringify(extra) : '')); } }
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, { got: a, want: b });

async function world() {
    const refsApp = { tenant: 'Tenant', house: 'House' };
    const User = makeModel('User'), Property = makeModel('Property');
    const HouseGroup = makeModel('HouseGroup', { defaults: { icon: 'properties', description: '', prefix: '', padWidth: 0, colorIndex: 0 } }); HouseGroup.BUILDING_ICONS = BUILDING_ICONS;
    const House = makeModel('House', { defaults: { status: 'available', billingCycle: 'monthly', group: null, groupSeq: null }, refs: { group: 'HouseGroup' }, unique: [(d, all) => all.some(x => x.property === d.property && x.name === d.name)] });
    const Tenant = makeModel('Tenant', { defaults: { house: null, status: 'active', depositStatus: 'none', depositAmount: 0, assignedAt: null }, refs: { house: 'House' } });
    const TenantMembership = makeModel('TenantMembership');
    const HouseApplication = makeModel('HouseApplication', { defaults: { status: 'pending', note: '', decisionNote: '', decidedAt: null, decidedBy: null, building: null }, refs: refsApp, unique: [(d, all) => d.status === 'pending' && all.some(x => x.tenant === d.tenant && x.status === 'pending')] });

    const L1 = await User.create({ role: 'landlord', name: 'Lana' }), L2 = await User.create({ role: 'landlord', name: 'Other' });
    const CT = await User.create({ role: 'caretaker', landlordId: L1._id, properties: [], caretakerPermissions: { canManageTenants: true } });
    const CT2 = await User.create({ role: 'caretaker', landlordId: L1._id, properties: [], caretakerPermissions: { canManageTenants: false } });
    const P1 = await Property.create({ landlord: L1._id, name: 'Sunrise', depositPolicy: { requireDepositBeforeAssignment: true, depositAmount: 8000 } });
    const P1b = await Property.create({ landlord: L1._id, name: 'Second', depositPolicy: { requireDepositBeforeAssignment: false, depositAmount: 0 } });
    const P2 = await Property.create({ landlord: L2._id, name: 'Foreign' });
    await User.updateOne({ _id: CT._id }, { properties: [P1._id] }); await User.updateOne({ _id: CT2._id }, { properties: [P1._id] });

    const F1 = await HouseGroup.create({ landlord: L1._id, property: P1._id, label: 'Flat 1', colorIndex: 0, prefix: 'A' });
    const F2 = await HouseGroup.create({ landlord: L1._id, property: P1._id, label: 'Flat 2', colorIndex: 1 });
    const FX = await HouseGroup.create({ landlord: L2._id, property: P2._id, label: 'Foreign Flat', colorIndex: 0 });
    const mk = (g, name, status = 'available', rent = 8000) => House.create({ landlord: L1._id, property: P1._id, group: g ? g._id : null, name, rent, status });
    const h101 = await mk(F1, 'A101'), h102 = await mk(F1, 'A102', 'occupied'), h103 = await mk(F1, 'A103');
    const hB01 = await mk(F2, 'B01'), hLoose = await mk(null, 'Loose-1');
    const hForeign = await House.create({ landlord: L2._id, property: P2._id, group: FX._id, name: 'F-1', rent: 5000, status: 'available' });

    const mkTenant = (name, extra = {}) => Tenant.create({ landlord: L1._id, property: P1._id, name, email: name.toLowerCase() + '@x.com', phone: '0700', status: 'active', house: null, ...extra });
    const tJane = await mkTenant('Jane'), tPeter = await mkTenant('Peter'), tSam = await mkTenant('Sam');
    const tOcc = await mkTenant('Occupant', { house: h102._id });
    await House.updateOne({ _id: h102._id }, { status: 'occupied' });
    const tOut = await mkTenant('Gone', { status: 'moved_out' });
    const tForeign = await Tenant.create({ landlord: L2._id, property: P2._id, name: 'Foreign', email: 'f@x.com', phone: '1', status: 'active', house: null });
    const uOut = await User.create({ role: 'tenant', tenantId: tOut._id, landlordId: null });

    const logs = [];
    const helpers = {
        resolveLandlordScope: async req => req.user.role === 'landlord' ? req.user.id : req.user.role === 'caretaker' ? req.user.landlordId : null,
        getActorName: async req => req.user.role === 'caretaker' ? 'Caretaker' : null,
        logActivity: l => logs.push(l),
        sanitize: (v, n = 500) => typeof v === 'string' ? v.trim().slice(0, n) : '',
        tenantHasValidDeposit: (t, p) => t.depositStatus === 'paid' && t.depositPaidForProperty && String(t.depositPaidForProperty) === String(p._id),
        getRequiredDepositAmount: p => Number(p?.depositPolicy?.depositAmount || 0),
        normalizeSemesterRule: r => ({ rentAmount: Number(r?.rentAmount || 0) })
    };
    const notified = [];
    const assigner = createAssigner({ Tenant, House, Property, User, TenantMembership, HouseApplication, ...helpers,
        notifyApplicationDecision: n => notified.push(n) });

    const app = makeApp();
    const mw = {
        authMiddleware: (q, s, n) => n(),
        landlordOnly: (q, s, n) => q.user.role === 'landlord' ? n() : s.status(403).json({ message: 'Landlords only' }),
        landlordOrCaretaker: (q, s, n) => ['landlord', 'caretaker'].includes(q.user.role) ? n() : s.status(403).json({ message: 'Access denied' }),
        checkAccountStatus: (q, s, n) => n(), checkPropertySuspension: (q, s, n) => n()
    };
    const deps = { mongoose, House, HouseGroup, Property, Tenant, User, HouseApplication, ...mw, ...helpers,
        ...assigner, notifyApplicationReceived: () => {}, notifyApplicationDecision: n => notified.push(n) };
    registerBuildingRoutes(app, deps); registerApplicationRoutes(app, deps);

    const as = {
        L1: { id: L1._id, role: 'landlord' }, L2: { id: L2._id, role: 'landlord' },
        CT: { id: CT._id, role: 'caretaker', landlordId: L1._id }, CT2: { id: CT2._id, role: 'caretaker', landlordId: L1._id },
        tenant: t => ({ id: 'u' + t._id, role: 'tenant', tenantId: t._id })
    };
    return { app, as, logs, notified, assigner, models: { User, Property, HouseGroup, House, Tenant, TenantMembership, HouseApplication },
        ids: { L1, L2, P1, P1b, P2, F1, F2, FX, h101, h102, h103, hB01, hLoose, hForeign, tJane, tPeter, tSam, tOcc, tOut, tForeign, uOut } };
}

(async () => {
    // ───────── buildings: listing, stats, isolation ─────────
    {
        const w = await world(); const { app, as, ids } = w;
        let r = await app.call('GET', '/buildings', { user: as.L1, query: { propertyId: ids.P1._id } });
        eq(r.code, 200, 'GET /buildings 200');
        const f1 = r.body.buildings.find(b => b.label === 'Flat 1'), f2 = r.body.buildings.find(b => b.label === 'Flat 2');
        eq([f1.totalHouses, f1.occupied, f1.vacant, f1.occupancyPercent], [3, 1, 2, 33], 'Flat 1 counts');
        eq([f2.totalHouses, f2.occupied, f2.vacant], [1, 0, 1], 'Flat 2 counts');
        eq(r.body.unassigned.totalHouses, 1, 'unassigned bucket counted');
        ok(!JSON.stringify(r.body).includes('Foreign'), 'no foreign data in listing');
        ok(f1.icon === 'properties', 'default icon');

        r = await app.call('GET', '/buildings', { user: as.L2, query: { propertyId: ids.P1._id } });
        eq(r.code, 404, 'other landlord cannot list my property buildings');
        r = await app.call('GET', '/buildings', { user: as.L1, query: { propertyId: ids.P2._id } });
        eq(r.code, 404, 'landlord cannot list another landlord property');
        r = await app.call('GET', '/buildings', { user: as.L1, query: { propertyId: 'nope' } });
        eq(r.code, 400, 'bad propertyId → 400 not 500');
        r = await app.call('GET', '/buildings', { user: as.CT, query: { propertyId: ids.P1._id } });
        eq(r.code, 200, 'assigned caretaker can list');
        r = await app.call('GET', '/buildings', { user: as.CT, query: { propertyId: ids.P1b._id } });
        eq(r.code, 403, 'caretaker blocked on unassigned property');
        r = await app.call('GET', '/buildings', { user: as.tenant(ids.tJane), query: { propertyId: ids.P1._id } });
        eq(r.code, 403, 'tenant blocked from landlord listing');

        // create
        r = await app.call('POST', '/buildings', { user: as.L1, body: { propertyId: ids.P1._id, label: '  Flat 3 ', icon: 'houses' } });
        eq(r.code, 201, 'create building'); eq(r.body.building.label, 'Flat 3', 'label trimmed'); eq(r.body.building.colorIndex, 2, 'first unused color picked');
        r = await app.call('POST', '/buildings', { user: as.L1, body: { propertyId: ids.P1._id, label: 'flat 1' } });
        eq(r.code, 400, 'duplicate label (case-insensitive) rejected');
        r = await app.call('POST', '/buildings', { user: as.L1, body: { propertyId: ids.P1._id, label: 'X', icon: 'skull' } });
        eq(r.code, 400, 'icon outside allow-list rejected');
        r = await app.call('POST', '/buildings', { user: as.L1, body: { propertyId: ids.P1._id, label: 'X', colorIndex: 9 } });
        eq(r.code, 400, 'colorIndex out of range rejected');
        r = await app.call('POST', '/buildings', { user: as.L1, body: { propertyId: ids.P2._id, label: 'Hack' } });
        eq(r.code, 404, 'cannot create building in someone else’s property');
        r = await app.call('POST', '/buildings', { user: as.CT, body: { propertyId: ids.P1._id, label: 'Hack' } });
        eq(r.code, 403, 'caretaker cannot create buildings');
        r = await app.call('POST', '/buildings', { user: as.L1, body: { propertyId: ids.P1b._id, label: 'Flat 1' } });
        eq(r.code, 201, 'same label allowed in a different property');

        // update / delete
        r = await app.call('PUT', `/buildings/${ids.F1._id}`, { user: as.L2, body: { label: 'Stolen' } });
        eq(r.code, 404, 'other landlord cannot rename my building');
        r = await app.call('PUT', `/buildings/${ids.F1._id}`, { user: as.L1, body: { label: 'Flat 2' } });
        eq(r.code, 400, 'rename to an existing name rejected');
        r = await app.call('PUT', `/buildings/${ids.F1._id}`, { user: as.L1, body: { label: 'Flat One', colorIndex: 5, icon: 'home' } });
        eq([r.code, r.body.building.label, r.body.building.colorIndex, r.body.building.icon], [200, 'Flat One', 5, 'home'], 'rename/recolor/icon');
        r = await app.call('DELETE', `/buildings/${ids.F1._id}`, { user: as.L1 });
        eq(r.code, 400, 'cannot delete a building that has houses'); ok(/3 houses/.test(r.body.message), 'delete message counts houses', r.body);
        r = await app.call('DELETE', `/buildings/${ids.FX._id}`, { user: as.L1 });
        eq(r.code, 404, 'cannot delete a foreign building');
        const empty = (await app.call('POST', '/buildings', { user: as.L1, body: { propertyId: ids.P1._id, label: 'Empty' } })).body.building;
        r = await app.call('DELETE', `/buildings/${empty._id}`, { user: as.L1 });
        eq(r.code, 200, 'empty building can be deleted');

        // move houses
        r = await app.call('POST', '/buildings/move-houses', { user: as.L1, body: { propertyId: ids.P1._id, houseIds: [ids.hLoose._id], buildingId: ids.F2._id } });
        eq([r.code, r.body.moved], [200, 1], 'move unassigned house into building');
        eq(String((await w.models.House.findById(ids.hLoose._id)).group), String(ids.F2._id), 'house group updated');
        r = await app.call('POST', '/buildings/move-houses', { user: as.L1, body: { propertyId: ids.P1._id, houseIds: [ids.hForeign._id], buildingId: ids.F2._id } });
        eq(r.code, 404, 'cannot move a foreign house');
        r = await app.call('POST', '/buildings/move-houses', { user: as.L1, body: { propertyId: ids.P1._id, houseIds: [ids.h101._id], buildingId: ids.FX._id } });
        eq(r.code, 404, 'cannot move into a foreign building');
        r = await app.call('POST', '/buildings/move-houses', { user: as.L1, body: { propertyId: ids.P1._id, houseIds: [ids.h101._id], buildingId: '12' } });
        eq(r.code, 400, 'malformed building id → 400');
        r = await app.call('POST', '/buildings/move-houses', { user: as.L1, body: { propertyId: ids.P1._id, houseIds: [ids.h101._id], buildingId: ids.F2._id } });
        const moved = await w.models.House.findById(ids.h101._id);
        eq(moved.groupSeq, null, 'groupSeq is null when the name does not match the building prefix');
        r = await app.call('POST', '/buildings/move-houses', { user: as.L1, body: { propertyId: ids.P1._id, houseIds: [ids.h101._id], buildingId: ids.F1._id } });
        eq((await w.models.House.findById(ids.h101._id)).groupSeq, 101, 'groupSeq recovered from name + prefix');
        r = await app.call('POST', '/buildings/move-houses', { user: as.L1, body: { propertyId: ids.P1._id, houseIds: [ids.h101._id], buildingId: null } });
        eq(String((await w.models.House.findById(ids.h101._id)).group), 'null', 'move back to Unassigned');

        // organize
        r = await app.call('POST', '/buildings/organize', { user: as.L1, body: { propertyId: ids.P1._id, dryRun: true } });
        eq([r.code, r.body.count], [200, 1], 'organize dry run counts loose houses');
        r = await app.call('POST', '/buildings/organize', { user: as.L1, body: { propertyId: ids.P1._id } });
        eq(r.body.count, 1, 'organize moves them');
        r = await app.call('POST', '/buildings/organize', { user: as.L1, body: { propertyId: ids.P1._id } });
        eq(r.body.count, 0, 'organize is idempotent');
        const mains = (await w.models.HouseGroup.find({ property: ids.P1._id, label: 'Main Building' })).length;
        eq(mains, 1, 'only one Main Building ever created');
    }

    // ───────── tenant browsing + applying ─────────
    {
        const w = await world(); const { app, as, ids, models } = w;
        let r = await app.call('GET', '/tenant/me/buildings', { user: as.tenant(ids.tJane) });
        eq(r.code, 200, 'tenant lists buildings');
        const flat1 = r.body.buildings.find(b => b.label === 'Flat 1');
        eq(flat1.availableCount, 2, 'Flat 1 shows 2 available (occupied one not counted)');
        eq(r.body.unassigned.availableCount, 1, 'unassigned available');
        ok(!('occupied' in flat1) && !('totalHouses' in flat1), 'tenant sees no occupancy numbers');
        ok(!JSON.stringify(r.body).includes('Foreign'), 'tenant sees nothing from other landlords');
        eq(r.body.deposit, { required: 8000, requiredBeforeAssignment: true, recorded: false }, 'deposit comes from property policy');

        r = await app.call('GET', `/tenant/me/buildings/${ids.F1._id}/houses`, { user: as.tenant(ids.tJane) });
        eq(r.body.houses.map(h => h.name), ['A101', 'A103'], 'only available houses, natural order');
        eq(r.body.houses[0].rent, 8000, 'rent shown'); ok(!JSON.stringify(r.body).includes('Occupant'), 'no tenant names leaked');
        r = await app.call('GET', `/tenant/me/buildings/${ids.FX._id}/houses`, { user: as.tenant(ids.tJane) });
        eq(r.code, 404, 'cannot browse a building of another property');
        r = await app.call('GET', `/tenant/me/buildings/unassigned/houses`, { user: as.tenant(ids.tJane) });
        eq(r.body.houses.map(h => h.name), ['Loose-1'], 'unassigned bucket lists loose houses');
        r = await app.call('GET', '/tenant/me/buildings', { user: as.tenant(ids.tOcc) });
        eq([r.code, r.body.code], [403, 'HAS_HOUSE'], 'tenant with a house cannot browse');
        r = await app.call('GET', '/tenant/me/buildings', { user: as.tenant(ids.tOut) });
        eq([r.code, r.body.code], [403, 'TENANCY_ENDED'], 'moved-out tenant cannot browse');
        r = await app.call('GET', '/tenant/me/buildings', { user: as.L1 });
        eq(r.code, 403, 'landlord cannot use tenant endpoint');

        // apply
        r = await app.call('POST', '/tenant/me/applications', { user: as.tenant(ids.tJane), body: { houseId: ids.h102._id } });
        eq([r.code, r.body.code], [400, 'HOUSE_TAKEN'], 'cannot apply for an occupied house');
        r = await app.call('POST', '/tenant/me/applications', { user: as.tenant(ids.tJane), body: { houseId: ids.hForeign._id } });
        eq(r.code, 404, 'cannot apply for a house in another property');
        r = await app.call('POST', '/tenant/me/applications', { user: as.tenant(ids.tJane), body: { houseId: 'zzz' } });
        eq(r.code, 400, 'bad house id → 400');
        r = await app.call('POST', '/tenant/me/applications', { user: as.tenant(ids.tJane), body: { houseId: ids.h101._id, note: ' Hi ' } });
        eq([r.code, r.body.application.status, r.body.application.note], [201, 'pending', 'Hi'], 'apply OK');
        eq(String(r.body.application.building), String(ids.F1._id), 'building recorded');
        r = await app.call('POST', '/tenant/me/applications', { user: as.tenant(ids.tJane), body: { houseId: ids.h103._id } });
        eq([r.code, r.body.code], [409, 'ALREADY_PENDING'], 'second pending application blocked');
        r = await app.call('GET', `/tenant/me/buildings/${ids.F1._id}/houses`, { user: as.tenant(ids.tJane) });
        ok(r.body.houses.find(h => h.name === 'A101').applied, 'applied flag set for my pending house');
        r = await app.call('PUT', `/tenant/me/applications/${(await models.HouseApplication.find({}))[0]._id}/withdraw`, { user: as.tenant(ids.tPeter) });
        eq(r.code, 404, 'another tenant cannot withdraw my application');
        r = await app.call('PUT', `/tenant/me/applications/${(await models.HouseApplication.find({}))[0]._id}/withdraw`, { user: as.tenant(ids.tJane) });
        eq(r.code, 200, 'withdraw own application');
        r = await app.call('POST', '/tenant/me/applications', { user: as.tenant(ids.tJane), body: { houseId: ids.h103._id } });
        eq(r.code, 201, 'can apply again after withdrawing');
    }

    // ───────── landlord review + approval uses the existing rules ─────────
    {
        const w = await world(); const { app, as, ids, models, notified } = w;
        const apply = async (t, h) => (await app.call('POST', '/tenant/me/applications', { user: as.tenant(t), body: { houseId: h._id } })).body.application;
        const aJane = await apply(ids.tJane, ids.h101), aPeter = await apply(ids.tPeter, ids.h101), aSam = await apply(ids.tSam, ids.h103);

        let r = await app.call('GET', '/applications', { user: as.L1, query: { propertyId: ids.P1._id } });
        eq(r.body.applications.length, 3, 'landlord sees pending applications');
        if (process.env.DBG) console.log(JSON.stringify(r.body).slice(0,800), r.code);
        const jane = r.body.applications.find(a => a.tenant.name === 'Jane');
        eq([jane.house.name, jane.building.label, jane.canApprove, jane.deposit.recorded], ['A101', 'Flat 1', false, false], 'deposit missing → cannot approve yet');
        r = await app.call('GET', '/applications', { user: as.L2, query: { propertyId: ids.P1._id } });
        eq(r.code, 404, 'other landlord cannot read my applications via my property id');
        r = await app.call('GET', '/applications', { user: as.L2 });
        eq(r.body.applications.length, 0, 'other landlord sees none of mine');
        r = await app.call('GET', '/applications/pending-count', { user: as.L1 }); eq(r.body.count, 3, 'pending count');

        // approval blocked by the deposit rule — and NOTHING changes
        r = await app.call('PUT', `/applications/${aJane._id}/approve`, { user: as.L1 });
        eq([r.code, r.body.code], [400, 'DEPOSIT_REQUIRED'], 'approve blocked by deposit rule');
        eq((await models.HouseApplication.findById(aJane._id)).status, 'pending', 'application still pending');
        eq((await models.House.findById(ids.h101._id)).status, 'available', 'house still available');
        eq(String((await models.Tenant.findById(ids.tJane._id)).house), 'null', 'tenant unchanged');

        // landlord records the deposit (existing flow) then approves
        await models.Tenant.updateOne({ _id: ids.tJane._id }, { depositStatus: 'paid', depositPaidForProperty: ids.P1._id });
        r = await app.call('GET', '/applications', { user: as.L1, query: { propertyId: ids.P1._id } });
        ok(r.body.applications.find(a => a.tenant.name === 'Jane').canApprove, 'canApprove true once deposit is recorded');

        r = await app.call('PUT', `/applications/${aJane._id}/approve`, { user: as.CT2 });
        eq(r.code, 403, 'caretaker without canManageTenants cannot approve');
        r = await app.call('PUT', `/applications/${aJane._id}/approve`, { user: as.L2 });
        eq(r.code, 404, 'other landlord cannot approve my application');

        r = await app.call('PUT', `/applications/${aJane._id}/approve`, { user: as.CT });
        eq(r.code, 200, 'caretaker with permission approves', r.body);
        const janeNow = await models.Tenant.findById(ids.tJane._id);
        eq(String(janeNow.house), String(ids.h101._id), 'tenant assigned to the house');
        ok(janeNow.assignedAt, 'assignedAt set (proration rules keep working)');
        eq((await models.House.findById(ids.h101._id)).status, 'occupied', 'house occupied');
        eq((await models.HouseApplication.findById(aJane._id)).status, 'approved', 'application approved');
        eq((await models.HouseApplication.findById(aPeter._id)).status, 'rejected', 'competing application for the same house rejected');
        eq((await models.HouseApplication.findById(aSam._id)).status, 'pending', 'unrelated application untouched');
        ok(w.logs.some(l => l.action === 'tenant.assigned' && /by Caretaker/.test(l.message)), 'assignment logged through the existing activity message');
        ok(notified.some(n => n.approved === true) && notified.some(n => n.approved === false), 'decision notifications queued');

        r = await app.call('PUT', `/applications/${aJane._id}/approve`, { user: as.L1 });
        eq(r.code, 409, 'approving twice is refused');
        r = await app.call('PUT', `/applications/${aPeter._id}/approve`, { user: as.L1 });
        eq(r.code, 409, 'cannot approve an already-rejected application');

        // reject flow
        r = await app.call('PUT', `/applications/${aSam._id}/reject`, { user: as.L1, body: { note: 'Try Flat 2' } });
        eq([r.code, r.body.application.status, r.body.application.decisionNote], [200, 'rejected', 'Try Flat 2'], 'reject with a note');
        r = await app.call('PUT', `/applications/${aSam._id}/reject`, { user: as.L2 });
        eq(r.code, 404, 'other landlord cannot reject my application');
        r = await app.call('GET', '/tenant/me/applications', { user: as.tenant(ids.tSam) });
        eq([r.body[0].status, r.body[0].houseName], ['rejected', 'A103'], 'tenant sees the decision');
    }

    // ───────── race + hardening of the shared assignment ─────────
    {
        const w = await world(); const { app, as, ids, models } = w;
        await models.Tenant.updateOne({ _id: ids.tJane._id }, { depositStatus: 'paid', depositPaidForProperty: ids.P1._id });
        await models.Tenant.updateOne({ _id: ids.tPeter._id }, { depositStatus: 'paid', depositPaidForProperty: ids.P1._id });
        const req = { user: as.L1 };
        const results = await Promise.allSettled([
            w.assigner.assignTenantToHouse(req, { tenantId: String(ids.tJane._id), houseId: String(ids.h103._id) }),
            w.assigner.assignTenantToHouse(req, { tenantId: String(ids.tPeter._id), houseId: String(ids.h103._id) })
        ]);
        eq(results.filter(x => x.status === 'fulfilled').length, 1, 'two simultaneous assignments: exactly one wins the house');
        const loser = results.find(x => x.status === 'rejected');
        eq(loser.reason.message, 'This house is already occupied ❌', 'loser gets the usual message');

        // FIX 1: moved-out tenant without deposit → refused and NOTHING half-applied
        const t = ids.tOut;
        await models.TenantMembership.create({ tenant: t._id, landlord: ids.L1._id, property: ids.P1._id, status: 'moved_out', leftAt: 'x' });
        let threw = null;
        try { await w.assigner.assignTenantToHouse(req, { tenantId: String(t._id), houseId: String(ids.hB01._id) }); } catch (e) { threw = e; }
        eq(threw && threw.extra && threw.extra.code, 'DEPOSIT_REQUIRED', 'reactivation without deposit refused');
        eq((await models.User.findById(ids.uOut._id)).landlordId, null, 'User.landlordId NOT changed (old code changed it before refusing)');
        eq((await models.TenantMembership.findOne({ tenant: t._id })).status, 'moved_out', 'membership NOT reactivated');
        eq((await models.House.findById(ids.hB01._id)).status, 'available', 'house NOT claimed');
        eq((await models.Tenant.findById(t._id)).status, 'moved_out', 'tenant still moved out');

        // with deposit → reactivates as before
        await models.Tenant.updateOne({ _id: t._id }, { depositStatus: 'paid', depositPaidForProperty: ids.P1._id });
        await w.assigner.assignTenantToHouse(req, { tenantId: String(t._id), houseId: String(ids.hB01._id) });
        const back = await models.Tenant.findById(t._id);
        eq([back.status, String(back.house)], ['active', String(ids.hB01._id)], 'reactivation still works with a deposit');
        eq((await models.User.findById(ids.uOut._id)).landlordId, String(ids.L1._id), 'User relinked on success');

        // failure after the claim releases the house (FIX 3)
        const t2 = await models.Tenant.create({ landlord: ids.L1._id, property: ids.P1._id, name: 'Boom', email: 'b@x.com', phone: '1', status: 'active', house: null, depositStatus: 'paid', depositPaidForProperty: ids.P1._id });
        const orig = models.Tenant.findOne; let first = true;
        models.Tenant.findOne = f => { const q = orig(f); if (first) { first = false; return q.then ? (async () => { const d = await q; if (d) d.save = async () => { throw new Error('disk full'); }; return d; })() : q; } return q; };
        let err2 = null;
        try { await w.assigner.assignTenantToHouse(req, { tenantId: String(t2._id), houseId: String(ids.hLoose._id) }); } catch (e) { err2 = e; }
        models.Tenant.findOne = orig;
        eq(err2 && err2.message, 'disk full', 'save failure surfaces');
        eq((await models.House.findById(ids.hLoose._id)).status, 'available', 'house released after a failed assignment');

        // plain existing-route behaviours unchanged
        let e3 = null;
        try { await w.assigner.assignTenantToHouse(req, { tenantId: String(ids.tOcc._id), houseId: String(ids.hLoose._id) }); } catch (e) { e3 = e; }
        eq(e3 && e3.message, 'Tenant already has a house assigned ❌', 'already-housed message unchanged');
        let e4 = null;
        try { await w.assigner.assignTenantToHouse({ user: as.L2 }, { tenantId: String(ids.tJane._id), houseId: String(ids.hLoose._id) }); } catch (e) { e4 = e; }
        eq(e4 && e4.httpStatus, 404, 'another landlord cannot assign my tenants');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log(' ✗', f)); process.exit(1); }
})().catch(e => { console.error('TEST CRASH', e.stack.split('\n').slice(0,3).join('\n')); console.log(pass + ' passed before crash, ' + fail + ' failed'); failures.forEach(f => console.log(' ✗', f)); process.exit(2); });
