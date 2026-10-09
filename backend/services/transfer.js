// services/transfer.js
//
// Moves an ACTIVE tenant from their current house to another house of the SAME property.
//
// What a transfer is — and is not:
//   • It is the SAME tenant moving: the Tenant document, the login (User), every Payment/receipt,
//     deposit, assignedAt and the rent cycle (cycleAnchor) are left exactly as they are. Nothing is
//     duplicated, reset or re-created, so paid amounts and arrears simply carry on.
//   • Arrears are never stored — they are derived from (rent − payments) per period. The only thing a
//     transfer could corrupt is the rent used to price PAST periods, so the old house's rent is
//     recorded in Tenant.houseHistory and getEffectiveRentForTenant keeps using it for every period up
//     to and including the cycle the transfer happened in. The new house's rent applies from the next
//     cycle.
//   • Semester billing rows (Billing) are keyed by house, so they are re-pointed to the new house with
//     their amounts untouched — otherwise a prorated / extended amount would silently be lost.
//
// Same security shape as services/assignment.js: landlord / caretaker scope, atomic claim of the new
// house, and explicit rollback (the app has no DB transactions).

const HttpError = require('./httpError');

const isObjectId = v => /^[a-f0-9]{24}$/i.test(String(v == null ? '' : v));
const isoDate    = d => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

function createTransferService(deps) {
    const {
        Tenant, House, Billing, TenantMembership, HolidayHold, Property, User,
        resolveLandlordScope, getActorName, logActivity, computeMonthlyCycle
    } = deps;

    async function transferTenantToHouse(req, { tenantId, toHouseId }) {
        if (!isObjectId(tenantId))  throw new HttpError(404, 'Tenant not found');
        if (!isObjectId(toHouseId)) throw new HttpError(400, 'Choose the house to move the tenant to');

        const landlordScope = await resolveLandlordScope(req);
        if (!landlordScope) throw new HttpError(403, 'Access denied');

        const tenant = await Tenant.findOne({ _id: tenantId, landlord: landlordScope });
        if (!tenant) throw new HttpError(404, 'Tenant not found');

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties caretakerPermissions');
            if (!caretaker?.caretakerPermissions?.canManageTenants) {
                throw new HttpError(403, 'You do not have permission to transfer tenants');
            }
            const assigned = (caretaker.properties || []).map(String).includes(String(tenant.property));
            if (!assigned) throw new HttpError(403, 'You are not assigned to this property');
        }

        if (tenant.status !== 'active') throw new HttpError(400, 'Only active tenants can be transferred');
        if (!tenant.house)              throw new HttpError(400, 'This tenant has no house yet — use Assign House instead');

        const fromHouse = await House.findOne({ _id: tenant.house, landlord: landlordScope });
        if (!fromHouse) throw new HttpError(404, "The tenant's current house was not found");

        const toHouse = await House.findOne({ _id: toHouseId, landlord: landlordScope });
        if (!toHouse) throw new HttpError(404, 'House not found');

        if (String(toHouse._id) === String(fromHouse._id)) {
            throw new HttpError(400, 'The tenant is already in this house');
        }

        // ── SAME PROPERTY — enforced here on the server, never only in the UI. A transfer can never
        //    attach a house (or a tenant) of one property to another. ──
        if (String(toHouse.property) !== String(fromHouse.property) ||
            String(toHouse.property) !== String(tenant.property)) {
            throw new HttpError(400, 'A tenant can only be transferred to a house in the same property');
        }
        const property = await Property.findOne({ _id: toHouse.property, landlord: landlordScope }).select('_id name');
        if (!property) throw new HttpError(404, 'Property not found');

        const fromCycle = fromHouse.billingCycle || 'monthly';
        const toCycle   = toHouse.billingCycle   || 'monthly';
        if (fromCycle !== toCycle) {
            throw new HttpError(400, `This tenant is on ${fromCycle} billing and that house is billed ${toCycle}. Transfers are only allowed between houses with the same billing cycle.`);
        }

        // A real holiday reserves the old room, so it must be resolved first. A between-semesters hold only
        // records the break between two semesters, so it simply moves with the tenant (below).
        if (await HolidayHold.exists({ tenant: tenant._id, status: 'active', kind: { $ne: 'between_semesters' } })) {
            throw new HttpError(409, 'This tenant has an active holiday hold. Resolve the hold before transferring them.');
        }

        if (toHouse.status === 'occupied') throw new HttpError(400, 'This house is already occupied ❌');

        // ── Atomically claim the new house (same race protection as assignment) ──
        const claimed = await House.findOneAndUpdate(
            { _id: toHouse._id, landlord: landlordScope, property: fromHouse.property, status: 'available' },
            { status: 'occupied' },
            { returnDocument: 'after' }
        );
        if (!claimed) throw new HttpError(400, 'This house is already occupied ❌');

        const now        = new Date();
        const isSemester = fromCycle === 'semester';
        const last       = tenant.houseHistory && tenant.houseHistory.length
            ? tenant.houseHistory[tenant.houseHistory.length - 1] : null;

        // Closed-period pricing: the old rent keeps applying up to and including the cycle the
        // transfer happens in (see getEffectiveRentForTenant).
        const lastPeriodStart = isSemester ? null : computeMonthlyCycle(tenant, now).start;

        let repointedIds = [];
        try {
            if (isSemester) {
                const rows = await Billing.find({ tenant: tenant._id, house: fromHouse._id }).select('_id').lean();
                repointedIds = rows.map(r => r._id);
                if (repointedIds.length) {
                    await Billing.updateMany({ _id: { $in: repointedIds } }, { house: toHouse._id });
                }
            }

            tenant.houseHistory.push({
                house:        fromHouse._id,
                houseName:    fromHouse.name,
                rent:         Number(fromHouse.rent || 0),
                billingCycle: fromCycle,
                from:         (last && last.to) || tenant.assignedAt || tenant.createdAt || null,
                to:           now,
                lastPeriodStart
            });
            tenant.house = toHouse._id;
            await tenant.save();
        } catch (err) {
            // Undo in reverse order so nothing is left half-moved.
            if (repointedIds.length) {
                await Billing.updateMany({ _id: { $in: repointedIds } }, { house: fromHouse._id })
                    .catch(e => console.error('transfer rollback (billing) failed:', e.message));
            }
            await House.updateOne({ _id: toHouse._id, status: 'occupied' }, { status: 'available' })
                .catch(e => console.error('transfer rollback (house) failed:', e.message));
            throw err;
        }

        // The tenant is now in the new house. Free the old one; failures here are logged, never fatal.
        await House.updateOne({ _id: fromHouse._id, landlord: landlordScope, status: 'occupied' }, { status: 'available' })
            .catch(e => console.error('transfer: failed to free old house:', e.message));

        await HolidayHold.updateMany({ tenant: tenant._id, status: 'active', kind: 'between_semesters' }, { house: toHouse._id })
            .catch(e => console.error('transfer: gap hold update failed:', e.message));

        await TenantMembership.findOneAndUpdate({ tenant: tenant._id, status: 'active' }, { house: toHouse._id })
            .catch(e => console.error('transfer: membership update failed:', e.message));

        const actor = await getActorName(req);
        logActivity({
            landlord: landlordScope, property: property._id,
            action:   'tenant.transferred',
            message:  `${tenant.name} moved from ${fromHouse.name} to ${claimed.name}${actor ? ` — by ${actor}` : ''}`,
            meta:     {
                tenantId: tenant._id, fromHouse: fromHouse._id, toHouse: claimed._id,
                oldRent: Number(fromHouse.rent || 0), newRent: Number(claimed.rent || 0)
            },
            actor:    actor ? 'caretaker' : 'landlord'
        });

        return {
            tenant,
            fromHouse: { _id: fromHouse._id, name: fromHouse.name, rent: Number(fromHouse.rent || 0) },
            toHouse:   { _id: claimed._id,   name: claimed.name,   rent: Number(claimed.rent || 0) },
            billingCycle: fromCycle,
            // monthly: the new rent starts with the next cycle; semester rent is not house-specific
            newRentAppliesFrom: isSemester ? null : isoDate(computeMonthlyCycle(tenant, now).end)
        };
    }

    return { transferTenantToHouse };
}

module.exports = createTransferService;
