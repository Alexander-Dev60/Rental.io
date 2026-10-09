// services/assignment.js
//
// The body of the existing PUT /assign-house/:tenantId/:houseId route, extracted so the route and
// "approve application" run EXACTLY the same rules. Behaviour, messages and response are unchanged, with
// three deliberate hardening fixes (called out below).
//
//   FIX 1  The deposit gate now runs BEFORE anything is written. Before, a moved-out tenant without a
//          deposit had their User.landlordId / TenantMembership updated first and then got a 400,
//          leaving half-applied state behind.
//   FIX 2  The house is claimed with one atomic update (status 'available' → 'occupied'), so two
//          simultaneous assignments/approvals can never both win the same house.
//   FIX 3  If saving the tenant fails after the house was claimed, the house is released again.

const HttpError = require('./httpError');

function createAssigner(deps) {
    const {
        Tenant, House, Property, User, TenantMembership, HouseApplication,
        resolveLandlordScope, getActorName, logActivity,
        tenantHasValidDeposit, getRequiredDepositAmount,
        notifyApplicationDecision            // optional: ({ application, approved, note }) => void
    } = deps;

    // After a tenant is assigned to a house (by ANY route), tidy up their applications.
    async function settleApplicationsAfterAssignment({ tenant, house, decidedBy }) {
        const out = { approved: [], rejected: [] };
        if (!HouseApplication) return out;
        try {
            const now = new Date();

            const mine = await HouseApplication.find({ tenant: tenant._id, house: house._id, status: 'pending' });
            if (mine.length) {
                await HouseApplication.updateMany(
                    { tenant: tenant._id, house: house._id, status: 'pending' },
                    { status: 'approved', decidedAt: now, decidedBy: decidedBy || null }
                );
                out.approved = mine;
            }

            // Their other pending applications no longer apply.
            await HouseApplication.updateMany(
                { tenant: tenant._id, status: 'pending' },
                { status: 'cancelled', decisionNote: 'You have been assigned a house', decidedAt: now, decidedBy: decidedBy || null }
            );

            // Anyone else who applied for this same house lost it.
            const others = await HouseApplication.find({ house: house._id, status: 'pending' });
            if (others.length) {
                await HouseApplication.updateMany(
                    { house: house._id, status: 'pending' },
                    { status: 'rejected', decisionNote: 'This house was allocated to another applicant', decidedAt: now, decidedBy: decidedBy || null }
                );
                out.rejected = others;
            }

            if (typeof notifyApplicationDecision === 'function') {
                out.approved.forEach(a => notifyApplicationDecision({ application: a, approved: true, note: '' }));
                out.rejected.forEach(a => notifyApplicationDecision({ application: a, approved: false, note: 'This house was allocated to another applicant' }));
            }
        } catch (err) {
            // Never let bookkeeping fail the assignment itself.
            console.error('settleApplicationsAfterAssignment error:', err.message);
        }
        return out;
    }

    async function assignTenantToHouse(req, { tenantId, houseId }) {
        const landlordScope = await resolveLandlordScope(req);
        if (!landlordScope) throw new HttpError(403, 'Access denied');

        const tenant = await Tenant.findOne({ _id: tenantId, landlord: landlordScope });
        const house  = await House.findOne({ _id: houseId, landlord: landlordScope });

        if (!tenant || !house) throw new HttpError(404, 'Tenant or House not found');

        const property = await Property.findOne({ _id: house.property, landlord: landlordScope });
        if (!property) throw new HttpError(404, 'Property not found');

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties caretakerPermissions');
            if (!caretaker?.caretakerPermissions?.canManageTenants) {
                throw new HttpError(403, 'You do not have permission to assign or reactivate tenants');
            }
            const assignedIds = (caretaker.properties || []).map(String);
            const houseOk  = assignedIds.includes(String(house.property));
            const tenantOk = !tenant.property || assignedIds.includes(String(tenant.property));
            if (!houseOk || !tenantOk) throw new HttpError(403, 'You are not assigned to this property');
        }

        const actorName = await getActorName(req);

        if (house.status === 'occupied') throw new HttpError(400, 'This house is already occupied ❌');

        const wasReactivation = tenant.status === 'moved_out';

        if (tenant.status === 'active') {
            if (String(tenant.property) !== String(house.property)) {
                throw new HttpError(400, 'House and tenant must belong to the same property');
            }
            if (tenant.house) throw new HttpError(400, 'Tenant already has a house assigned ❌');
        }

        if (wasReactivation) {
            const activeTenantElsewhere = await Tenant.findOne({
                email: tenant.email, status: 'active', _id: { $ne: tenant._id }
            });
            if (activeTenantElsewhere) {
                const activeProp = await Property.findById(activeTenantElsewhere.property).select('name');
                throw new HttpError(400,
                    `This tenant is currently active at ${activeProp?.name || 'another property'} and cannot be reactivated here.`);
            }
        }

        // FIX 1 — the deposit rule is checked before any write.
        if (property.depositPolicy?.requireDepositBeforeAssignment) {
            if (!tenantHasValidDeposit(tenant, property)) {
                const required = getRequiredDepositAmount(property);
                throw new HttpError(400,
                    `Deposit required before assignment — this property requires a Ksh ${required.toLocaleString()} deposit to be recorded for this tenant first.`,
                    { code: 'DEPOSIT_REQUIRED', requiredAmount: required });
            }
        }

        // FIX 2 — atomic claim of the house.
        const claimed = await House.findOneAndUpdate(
            { _id: house._id, landlord: landlordScope, status: 'available' },
            { status: 'occupied' },
            { returnDocument: 'after' }
        );
        if (!claimed) throw new HttpError(400, 'This house is already occupied ❌');

        try {
            if (wasReactivation) {
                tenant.status       = 'active';
                tenant.movedOutAt   = null;
                tenant.lastHouse    = null;
                tenant.lastProperty = null;
                tenant.lastLandlord = null;
                tenant.property     = house.property;

                await User.findOneAndUpdate({ tenantId: tenant._id }, { landlordId: landlordScope });

                const existingMembership = await TenantMembership.findOne({
                    tenant: tenant._id, landlord: landlordScope
                }).sort({ createdAt: -1 });

                if (existingMembership) {
                    existingMembership.property = house.property;
                    existingMembership.house    = house._id;
                    existingMembership.status   = 'active';
                    existingMembership.joinedAt = new Date();
                    existingMembership.leftAt   = null;
                    await existingMembership.save();
                } else {
                    await TenantMembership.create({
                        user:     (await User.findOne({ tenantId: tenant._id }).select('_id'))?._id,
                        landlord: landlordScope,
                        property: house.property,
                        tenant:   tenant._id,
                        house:    house._id,
                        status:   'active',
                        joinedAt: new Date(),
                        leftAt:   null
                    });
                }
            }

            tenant.house      = house._id;
            tenant.assignedAt = new Date();

            // The monthly rent cycle starts the day the tenant is housed (10 Oct → 10 Nov → …).
            // A fresh assignment also discards any end date a landlord adjusted for a PREVIOUS stay.
            tenant.cycleAnchor      = tenant.assignedAt;
            tenant.cycleEndOverride = { date: null, cycleStart: null, originalEnd: null, setAt: null, setBy: null };

            await tenant.save();
        } catch (err) {
            // FIX 3 — never leave a house locked to nobody.
            await House.updateOne({ _id: house._id, status: 'occupied' }, { status: 'available' }).catch(() => {});
            throw err;
        }

        logActivity({
            landlord: landlordScope,
            property: house.property,
            action:   wasReactivation ? 'tenant.reactivated' : 'tenant.assigned',
            message:  `${tenant.name} assigned to ${house.name}${actorName ? ` — by ${actorName}` : ''}`,
            meta:     { tenantId: tenant._id, houseId: house._id },
            actor:    actorName ? 'caretaker' : 'landlord'
        });

        await settleApplicationsAfterAssignment({ tenant, house: claimed, decidedBy: req.user.id });

        return { tenant, house: claimed };
    }

    return { assignTenantToHouse, settleApplicationsAfterAssignment };
}

module.exports = createAssigner;
