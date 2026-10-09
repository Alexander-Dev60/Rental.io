// routes/applications.js — tenant house browsing + applications, and the landlord review inbox.
//
// An application is only a REQUEST. Approval calls the shared assignTenantToHouse() — the same code the
// existing "Assign House" button uses — so deposit, rent, reactivation and occupancy rules cannot drift.

const HttpError = require('../services/httpError');
const createBuildingHelpers = require('../services/buildingHelpers');

module.exports = function registerApplicationRoutes(app, deps) {
    const {
        mongoose, House, HouseGroup, Property, Tenant, User, HouseApplication,
        authMiddleware, landlordOrCaretaker, checkAccountStatus,
        resolveLandlordScope, sanitize, logActivity, getActorName,
        tenantHasValidDeposit, getRequiredDepositAmount, normalizeSemesterRule,
        assignTenantToHouse, settleApplicationsAfterAssignment,
        notifyApplicationReceived, notifyApplicationDecision
    } = deps;

    const { isObjectId } = createBuildingHelpers({ mongoose, HouseGroup });

    const handle = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (err) {
            if (err && err.httpStatus) return res.status(err.httpStatus).json({ message: err.message, ...(err.extra || {}) });
            console.error(`${req.method} ${req.path} error:`, err && err.message);
            res.status(500).json({ message: err && err.message ? err.message : 'Server error' });
        }
    };
    const natural = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true });

    // ═════════════════════════════════════════════
    //  TENANT SIDE
    // ═════════════════════════════════════════════

    // Who may browse/apply: a tenant whose tenancy is active and who has no house yet. The property comes
    // from THEIR tenant record (set by their landlord) — never from anything the client sends.
    async function browsingTenant(req) {
        if (req.user.role !== 'tenant' || !req.user.tenantId) throw new HttpError(403, 'Tenants only');
        const tenant = await Tenant.findById(req.user.tenantId);
        if (!tenant) throw new HttpError(404, 'Tenant not found');
        if (tenant.status !== 'active') throw new HttpError(403, 'Your tenancy has ended — house applications are closed.', { code: 'TENANCY_ENDED' });
        if (tenant.house) throw new HttpError(403, 'You already have a house assigned.', { code: 'HAS_HOUSE' });

        const property = await Property.findById(tenant.property)
            .select('name location landlord isSuspended depositPolicy semesterRule');
        if (!property) throw new HttpError(404, 'Property not found');
        return { tenant, property };
    }

    function depositInfo(tenant, property) {
        return {
            required:                 getRequiredDepositAmount(property),
            requiredBeforeAssignment: property.depositPolicy?.requireDepositBeforeAssignment !== false,
            recorded:                 tenantHasValidDeposit(tenant, property)
        };
    }

    // What the tenant is shown as the price of a house (same sources the rest of the system uses).
    function rentFor(house, property) {
        if ((house.billingCycle || 'monthly') === 'semester') {
            const rule = normalizeSemesterRule(property.semesterRule || {});
            return { amount: Number(rule.rentAmount || house.rent || 0), cycleLabel: 'per semester' };
        }
        return { amount: Number(house.rent || 0), cycleLabel: 'per month' };
    }

    app.get('/tenant/me/buildings', authMiddleware, handle(async (req, res) => {
        const { tenant, property } = await browsingTenant(req);

        const [groups, rows, pending] = await Promise.all([
            HouseGroup.find({ property: property._id, landlord: property.landlord }).sort({ createdAt: 1 }).select('label colorIndex icon description').lean(),
            House.aggregate([
                { $match: {
                    property: new mongoose.Types.ObjectId(String(property._id)),
                    landlord: new mongoose.Types.ObjectId(String(property.landlord)),
                    status:   'available'
                } },
                { $group: { _id: '$group', n: { $sum: 1 } } }
            ]),
            HouseApplication.findOne({ tenant: tenant._id, status: 'pending' }).lean()
        ]);

        const known = new Set(groups.map(g => String(g._id)));
        const avail = {}; let other = 0;
        for (const r of rows) {
            const k = r._id ? String(r._id) : null;
            if (k && known.has(k)) avail[k] = (avail[k] || 0) + r.n; else other += r.n;
        }

        res.json({
            property: { name: property.name, location: property.location || null },
            acceptingApplications: !property.isSuspended,
            deposit: depositInfo(tenant, property),
            // Only what a tenant is allowed to see: available counts — never occupancy or other tenants.
            buildings: groups.map(g => ({
                _id: g._id, label: g.label, colorIndex: g.colorIndex || 0, icon: g.icon || 'properties',
                description: g.description || '', availableCount: avail[String(g._id)] || 0
            })),
            unassigned: other ? { availableCount: other } : null,
            pendingApplication: pending ? { _id: pending._id, house: pending.house } : null
        });
    }));

    app.get('/tenant/me/buildings/:id/houses', authMiddleware, handle(async (req, res) => {
        const { tenant, property } = await browsingTenant(req);

        let query = { property: property._id, landlord: property.landlord, status: 'available' };
        let buildingLabel = 'Other houses';

        if (req.params.id === 'unassigned') {
            const groups = await HouseGroup.find({ property: property._id, landlord: property.landlord }).select('_id').lean();
            query.$or = [{ group: null }, { group: { $nin: groups.map(g => g._id) } }];
        } else {
            if (!isObjectId(req.params.id)) throw new HttpError(404, 'Building not found');
            const building = await HouseGroup.findOne({ _id: req.params.id, property: property._id, landlord: property.landlord }).select('label').lean();
            if (!building) throw new HttpError(404, 'Building not found');
            query.group = building._id; buildingLabel = building.label;
        }

        const [houses, pending] = await Promise.all([
            House.find(query).select('name rent billingCycle').lean(),
            HouseApplication.findOne({ tenant: tenant._id, status: 'pending' }).lean()
        ]);
        const dep = depositInfo(tenant, property);

        res.json({
            building: { _id: req.params.id, label: buildingLabel },
            acceptingApplications: !property.isSuspended,
            deposit: dep,
            houses: houses.sort(natural).map(h => {
                const r = rentFor(h, property);
                return {
                    _id: h._id, name: h.name, billingCycle: h.billingCycle || 'monthly',
                    rent: r.amount, rentLabel: r.cycleLabel, depositRequired: dep.required,
                    applied: !!(pending && String(pending.house) === String(h._id))
                };
            })
        });
    }));

    app.post('/tenant/me/applications', authMiddleware, handle(async (req, res) => {
        const { tenant, property } = await browsingTenant(req);
        if (property.isSuspended) throw new HttpError(403, `${property.name} is not accepting new applications right now.`, { code: 'PROPERTY_SUSPENDED' });

        const houseId = req.body.houseId;
        if (!isObjectId(houseId)) throw new HttpError(400, 'houseId is required');
        const note = sanitize(req.body.note || '', 300);

        const house = await House.findOne({ _id: houseId, property: property._id, landlord: property.landlord });
        if (!house) throw new HttpError(404, 'House not found');
        if (house.status !== 'available') throw new HttpError(400, 'This house is no longer available', { code: 'HOUSE_TAKEN' });

        let application;
        try {
            application = await HouseApplication.create({
                landlord: property.landlord, property: property._id, tenant: tenant._id, house: house._id,
                building: house.group || null, note
            });
        } catch (err) {
            if (err && err.code === 11000) {
                throw new HttpError(409, 'You already have a pending application — withdraw it before applying for another house.', { code: 'ALREADY_PENDING' });
            }
            throw err;
        }

        logActivity({
            landlord: property.landlord, property: property._id, action: 'application.submitted',
            message: `${tenant.name} applied for ${house.name}`, meta: { applicationId: application._id, houseId: house._id, tenantId: tenant._id },
            actor: 'system'      // AuditLog only knows landlord / caretaker / system
        });
        if (typeof notifyApplicationReceived === 'function') notifyApplicationReceived({ application });

        res.status(201).json({ message: `Application sent for ${house.name} ✅ — your landlord will review it.`, application });
    }));

    app.get('/tenant/me/applications', authMiddleware, handle(async (req, res) => {
        if (req.user.role !== 'tenant' || !req.user.tenantId) throw new HttpError(403, 'Tenants only');

        const apps = await HouseApplication.find({ tenant: req.user.tenantId })
            .populate('house', 'name').sort({ createdAt: -1 }).limit(10).lean();
        const buildingIds = [...new Set(apps.map(a => a.building).filter(Boolean).map(String))];
        const buildings = buildingIds.length ? await HouseGroup.find({ _id: { $in: buildingIds } }).select('label').lean() : [];
        const label = {}; buildings.forEach(b => { label[String(b._id)] = b.label; });

        res.json(apps.map(a => ({
            _id: a._id, status: a.status, note: a.note || '', decisionNote: a.decisionNote || '',
            houseName: a.house?.name || '—', buildingLabel: a.building ? (label[String(a.building)] || null) : null,
            createdAt: a.createdAt, decidedAt: a.decidedAt || null
        })));
    }));

    app.put('/tenant/me/applications/:id/withdraw', authMiddleware, handle(async (req, res) => {
        if (req.user.role !== 'tenant' || !req.user.tenantId) throw new HttpError(403, 'Tenants only');
        if (!isObjectId(req.params.id)) throw new HttpError(404, 'Application not found');

        const done = await HouseApplication.findOneAndUpdate(
            { _id: req.params.id, tenant: req.user.tenantId, status: 'pending' },
            { status: 'withdrawn', decidedAt: new Date() },
            { returnDocument: 'after' }
        );
        if (!done) throw new HttpError(404, 'No pending application to withdraw');
        res.json({ message: 'Application withdrawn' });
    }));

    // ═════════════════════════════════════════════
    //  LANDLORD / CARETAKER SIDE
    // ═════════════════════════════════════════════

    // Properties this caller may see applications for.
    async function visibleScope(req) {
        const landlordScope = await resolveLandlordScope(req);
        if (!landlordScope) throw new HttpError(403, 'Access denied');
        const query = { landlord: landlordScope };

        let assigned = null;
        if (req.user.role === 'caretaker') {
            const c = await User.findById(req.user.id).select('properties');
            assigned = (c?.properties || []).map(String);
        }
        if (req.query.propertyId) {
            if (!isObjectId(req.query.propertyId)) throw new HttpError(400, 'Invalid propertyId');
            if (assigned && !assigned.includes(String(req.query.propertyId))) throw new HttpError(403, 'You are not assigned to this property');
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope }).select('_id');
            if (!property) throw new HttpError(404, 'Property not found');
            query.property = req.query.propertyId;
        } else if (assigned) {
            query.property = { $in: assigned };
        }
        return { landlordScope, query };
    }

    async function caretakerMayManage(req, propertyId) {
        if (req.user.role !== 'caretaker') return;
        const c = await User.findById(req.user.id).select('properties caretakerPermissions');
        if (!c?.caretakerPermissions?.canManageTenants) throw new HttpError(403, 'You do not have permission to review house applications');
        if (!(c.properties || []).map(String).includes(String(propertyId))) throw new HttpError(403, 'You are not assigned to this property');
    }

    app.get('/applications/pending-count', authMiddleware, landlordOrCaretaker, handle(async (req, res) => {
        const { query } = await visibleScope(req);
        res.json({ count: await HouseApplication.countDocuments({ ...query, status: 'pending' }) });
    }));

    app.get('/applications', authMiddleware, landlordOrCaretaker, handle(async (req, res) => {
        const { query } = await visibleScope(req);
        const status = req.query.status || 'pending';
        if (status !== 'all') {
            if (!['pending', 'approved', 'rejected', 'withdrawn', 'cancelled'].includes(status)) throw new HttpError(400, 'Invalid status');
            query.status = status;
        }

        const apps = await HouseApplication.find(query)
            .populate('tenant', 'name phone email status house depositStatus depositPaidForProperty')
            .populate('house', 'name rent billingCycle status group')
            .sort({ createdAt: -1 }).limit(200).lean();

        const propIds = [...new Set(apps.map(a => String(a.property)))];
        const props   = propIds.length ? await Property.find({ _id: { $in: propIds } }).select('name depositPolicy semesterRule').lean() : [];
        const propMap = {}; props.forEach(p => { propMap[String(p._id)] = p; });

        const bIds = [...new Set(apps.map(a => a.building).filter(Boolean).map(String))];
        const bs   = bIds.length ? await HouseGroup.find({ _id: { $in: bIds } }).select('label colorIndex').lean() : [];
        const bMap = {}; bs.forEach(b => { bMap[String(b._id)] = b; });

        res.json({
            applications: apps.map(a => {
                const p = propMap[String(a.property)] || {};
                const dep = a.tenant ? {
                    required:                 getRequiredDepositAmount(p),
                    requiredBeforeAssignment: p.depositPolicy?.requireDepositBeforeAssignment !== false,
                    recorded:                 tenantHasValidDeposit(a.tenant, { ...p, _id: a.property })
                } : null;
                const houseTaken = !!(a.house && a.house.status !== 'available');
                return {
                    _id: a._id, status: a.status, note: a.note || '', decisionNote: a.decisionNote || '',
                    createdAt: a.createdAt, decidedAt: a.decidedAt || null,
                    propertyId: a.property, propertyName: p.name || '—',
                    tenant: a.tenant ? { _id: a.tenant._id, name: a.tenant.name, phone: a.tenant.phone, email: a.tenant.email } : null,
                    house:  a.house  ? { _id: a.house._id, name: a.house.name, rent: a.house.rent, billingCycle: a.house.billingCycle || 'monthly', status: a.house.status } : null,
                    building: a.building && bMap[String(a.building)] ? { _id: a.building, label: bMap[String(a.building)].label, colorIndex: bMap[String(a.building)].colorIndex || 0 } : null,
                    deposit: dep,
                    // Approving is only possible when the existing assignment rules would allow it.
                    canApprove: a.status === 'pending' && !houseTaken && !!a.tenant && a.tenant.status === 'active' && !a.tenant.house &&
                                (!dep || !dep.requiredBeforeAssignment || dep.recorded)
                };
            })
        });
    }));

    app.put('/applications/:id/approve', authMiddleware, landlordOrCaretaker, checkAccountStatus, handle(async (req, res) => {
        if (!isObjectId(req.params.id)) throw new HttpError(404, 'Application not found');
        const landlordScope = await resolveLandlordScope(req);

        const application = await HouseApplication.findOne({ _id: req.params.id, landlord: landlordScope });
        if (!application) throw new HttpError(404, 'Application not found');
        await caretakerMayManage(req, application.property);
        if (application.status !== 'pending') throw new HttpError(409, `This application is already ${application.status}.`);

        const tenant = await Tenant.findOne({ _id: application.tenant, landlord: landlordScope });
        if (!tenant) throw new HttpError(404, 'Tenant not found');

        // Already assigned to exactly this house (e.g. a previous approval was interrupted) → just settle.
        if (tenant.house && String(tenant.house) === String(application.house)) {
            await settleApplicationsAfterAssignment({ tenant, house: { _id: application.house }, decidedBy: req.user.id });
        } else {
            // Exactly the existing "Assign House" rules. Any refusal (deposit missing, house taken,
            // tenant already housed…) surfaces to the landlord unchanged.
            await assignTenantToHouse(req, { tenantId: String(application.tenant), houseId: String(application.house) });
        }

        const after = await HouseApplication.findById(application._id).lean();
        res.json({ message: 'Application approved — tenant assigned to the house ✅', application: after });
    }));

    app.put('/applications/:id/reject', authMiddleware, landlordOrCaretaker, checkAccountStatus, handle(async (req, res) => {
        if (!isObjectId(req.params.id)) throw new HttpError(404, 'Application not found');
        const landlordScope = await resolveLandlordScope(req);

        const application = await HouseApplication.findOne({ _id: req.params.id, landlord: landlordScope });
        if (!application) throw new HttpError(404, 'Application not found');
        await caretakerMayManage(req, application.property);

        const note = sanitize(req.body.note || '', 300);
        const done = await HouseApplication.findOneAndUpdate(
            { _id: application._id, landlord: landlordScope, status: 'pending' },
            { status: 'rejected', decisionNote: note, decidedAt: new Date(), decidedBy: req.user.id },
            { returnDocument: 'after' }
        );
        if (!done) throw new HttpError(409, `This application is already ${application.status}.`);

        const actorName = await getActorName(req);
        logActivity({
            landlord: landlordScope, property: application.property, action: 'application.rejected',
            message: `An application for a house was declined${actorName ? ` — by ${actorName}` : ''}`,
            meta: { applicationId: application._id, actorName }, actor: actorName ? 'caretaker' : 'landlord'
        });
        if (typeof notifyApplicationDecision === 'function') notifyApplicationDecision({ application: done, approved: false, note });

        res.json({ message: 'Application declined', application: done });
    }));
};
