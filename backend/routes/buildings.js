// routes/buildings.js — landlord-side building management.
//
// A "building" is one HouseGroup. These routes add what was missing (create / rename / recolor /
// delete / stats / move houses in) without touching the existing generator routes.
// Every query is scoped to the caller's landlord (a caretaker's employer) and, for caretakers, to their
// assigned properties. Nothing trusts an id from the client without re-checking ownership.

const HttpError = require('../services/httpError');
const createBuildingHelpers = require('../services/buildingHelpers');

module.exports = function registerBuildingRoutes(app, deps) {
    const {
        mongoose, House, HouseGroup, Property, User,
        authMiddleware, landlordOnly, landlordOrCaretaker, checkAccountStatus, checkPropertySuspension,
        resolveLandlordScope, sanitize, logActivity
    } = deps;

    const { isObjectId, seqFromName, resolvePlacement } = createBuildingHelpers({ mongoose, HouseGroup });
    const ICONS        = HouseGroup.BUILDING_ICONS || ['properties'];
    const PALETTE_SIZE = 8;

    const handle = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (err) {
            if (err && err.httpStatus) return res.status(err.httpStatus).json({ message: err.message, ...(err.extra || {}) });
            console.error(`${req.method} ${req.path} error:`, err && err.message);
            res.status(500).json({ message: err && err.message ? err.message : 'Server error' });
        }
    };

    // The property must belong to the caller's landlord — and, for a caretaker, be one they are assigned to.
    async function propertyFor(req, propertyId) {
        if (!propertyId || !isObjectId(propertyId)) throw new HttpError(400, 'propertyId is required');
        const landlordScope = await resolveLandlordScope(req);
        if (!landlordScope) throw new HttpError(403, 'Access denied');

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker?.properties || []).map(String).includes(String(propertyId));
            if (!assigned) throw new HttpError(403, 'You are not assigned to this property');
        }
        const property = await Property.findOne({ _id: propertyId, landlord: landlordScope });
        if (!property) throw new HttpError(404, 'Property not found');
        return { landlordScope, property };
    }

    function cleanFields(body, { partial }) {
        const out = {};
        if (!partial || body.label !== undefined) {
            out.label = sanitize(body.label || '', 60);
            if (!out.label) throw new HttpError(400, 'A building name is required');
        }
        if (body.icon !== undefined) {
            if (!ICONS.includes(body.icon)) throw new HttpError(400, `icon must be one of: ${ICONS.join(', ')}`);
            out.icon = body.icon;
        }
        if (body.description !== undefined) out.description = sanitize(body.description || '', 200);
        if (body.colorIndex !== undefined && body.colorIndex !== null && body.colorIndex !== '') {
            const c = Number(body.colorIndex);
            if (!Number.isInteger(c) || c < 0 || c >= PALETTE_SIZE) throw new HttpError(400, `colorIndex must be 0–${PALETTE_SIZE - 1}`);
            out.colorIndex = c;
        }
        return out;
    }

    async function assertLabelFree({ landlord, property, label, exceptId = null }) {
        const existing = await HouseGroup.find({ landlord, property }).select('label colorIndex').lean();
        const clash = existing.find(g => String(g._id) !== String(exceptId) &&
            String(g.label || '').trim().toLowerCase() === label.toLowerCase());
        if (clash) throw new HttpError(400, `You already have a building called "${clash.label}" in this property`);
        return existing;
    }

    // ─────────────────────────────────────────────────────────
    //  GET /buildings?propertyId=   — cards with counts (one aggregation, no per-card queries)
    // ─────────────────────────────────────────────────────────
    app.get('/buildings', authMiddleware, landlordOrCaretaker, handle(async (req, res) => {
        const { landlordScope, property } = await propertyFor(req, req.query.propertyId);

        const [groups, rows] = await Promise.all([
            HouseGroup.find({ property: property._id, landlord: landlordScope }).sort({ createdAt: 1 }).lean(),
            House.aggregate([
                { $match: {
                    property: new mongoose.Types.ObjectId(String(property._id)),
                    landlord: new mongoose.Types.ObjectId(String(landlordScope))
                } },
                { $group: { _id: { g: '$group', s: '$status' }, n: { $sum: 1 } } }
            ])
        ]);

        const known  = new Set(groups.map(g => String(g._id)));
        const tally  = {};                                   // groupId → { occupied, vacant }
        const orphan = { occupied: 0, vacant: 0 };           // no group, or a group that no longer exists
        for (const r of rows) {
            const key    = r._id.g ? String(r._id.g) : null;
            const bucket = key && known.has(key) ? (tally[key] = tally[key] || { occupied: 0, vacant: 0 }) : orphan;
            if (r._id.s === 'occupied') bucket.occupied += r.n; else bucket.vacant += r.n;
        }

        const pct = (o, t) => (t ? Math.round((o / t) * 100) : 0);
        const buildings = groups.map(g => {
            const t = tally[String(g._id)] || { occupied: 0, vacant: 0 };
            const total = t.occupied + t.vacant;
            return {
                _id: g._id, label: g.label, prefix: g.prefix || '', padWidth: g.padWidth || 0,
                colorIndex: g.colorIndex || 0, icon: g.icon || 'properties', description: g.description || '',
                createdAt: g.createdAt,
                totalHouses: total, occupied: t.occupied, vacant: t.vacant, occupancyPercent: pct(t.occupied, total)
            };
        });
        const orphanTotal = orphan.occupied + orphan.vacant;

        res.json({
            propertyId: property._id,
            buildings,
            unassigned: orphanTotal
                ? { totalHouses: orphanTotal, occupied: orphan.occupied, vacant: orphan.vacant, occupancyPercent: pct(orphan.occupied, orphanTotal) }
                : null
        });
    }));

    // ─────────────────────────────────────────────────────────
    //  POST /buildings   — create an (empty) building
    // ─────────────────────────────────────────────────────────
    app.post('/buildings', authMiddleware, landlordOnly, checkAccountStatus, checkPropertySuspension, handle(async (req, res) => {
        const { landlordScope, property } = await propertyFor(req, req.body.propertyId);
        const fields   = cleanFields(req.body, { partial: false });
        const existing = await assertLabelFree({ landlord: landlordScope, property: property._id, label: fields.label });

        if (fields.colorIndex === undefined) {
            const used = new Set(existing.map(g => g.colorIndex));
            let pick = 0; while (pick < PALETTE_SIZE && used.has(pick)) pick++;
            fields.colorIndex = pick < PALETTE_SIZE ? pick : existing.length % PALETTE_SIZE;
        }

        const prefix   = sanitize(req.body.prefix || '', 10);
        const padRaw   = Number(req.body.padWidth);
        const padWidth = Number.isInteger(padRaw) && padRaw >= 0 && padRaw <= 6 ? padRaw : 0;

        const building = await HouseGroup.create({
            landlord: landlordScope, property: property._id, prefix, padWidth, ...fields
        });

        logActivity({
            landlord: landlordScope, property: property._id, action: 'building.created',
            message: `Building "${building.label}" created in ${property.name}`, meta: { buildingId: building._id }
        });
        res.status(201).json({ message: 'Building created ✅', building });
    }));

    // ─────────────────────────────────────────────────────────
    //  PUT /buildings/:id   — rename / recolor / icon / description
    // ─────────────────────────────────────────────────────────
    app.put('/buildings/:id', authMiddleware, landlordOnly, checkAccountStatus, handle(async (req, res) => {
        if (!isObjectId(req.params.id)) throw new HttpError(404, 'Building not found');
        const landlordScope = await resolveLandlordScope(req);

        const building = await HouseGroup.findOne({ _id: req.params.id, landlord: landlordScope });
        if (!building) throw new HttpError(404, 'Building not found');

        const fields = cleanFields(req.body, { partial: true });
        if (fields.label) await assertLabelFree({ landlord: landlordScope, property: building.property, label: fields.label, exceptId: building._id });

        Object.assign(building, fields);
        await building.save();
        res.json({ message: 'Building updated ✅', building });
    }));

    // ─────────────────────────────────────────────────────────
    //  DELETE /buildings/:id   — only when it has no houses left
    // ─────────────────────────────────────────────────────────
    app.delete('/buildings/:id', authMiddleware, landlordOnly, checkAccountStatus, handle(async (req, res) => {
        if (!isObjectId(req.params.id)) throw new HttpError(404, 'Building not found');
        const landlordScope = await resolveLandlordScope(req);

        const building = await HouseGroup.findOne({ _id: req.params.id, landlord: landlordScope });
        if (!building) throw new HttpError(404, 'Building not found');

        const houseCount = await House.countDocuments({ group: building._id, landlord: landlordScope });
        if (houseCount > 0) {
            throw new HttpError(400,
                `"${building.label}" still has ${houseCount} house${houseCount === 1 ? '' : 's'} — move or delete them first.`,
                { houseCount });
        }
        await HouseGroup.deleteOne({ _id: building._id, landlord: landlordScope });
        res.json({ message: 'Building deleted ✅' });
    }));

    // ─────────────────────────────────────────────────────────
    //  POST /buildings/move-houses   { propertyId, houseIds[], buildingId|null }
    //  Organisational only: changes House.group. Tenants, rent, deposits and payments reference the
    //  house _id, so none of them are touched.
    // ─────────────────────────────────────────────────────────
    app.post('/buildings/move-houses', authMiddleware, landlordOnly, checkAccountStatus, handle(async (req, res) => {
        const { landlordScope, property } = await propertyFor(req, req.body.propertyId);

        const ids = Array.isArray(req.body.houseIds) ? [...new Set(req.body.houseIds.map(String))] : [];
        if (!ids.length)       throw new HttpError(400, 'houseIds is required');
        if (ids.length > 500)  throw new HttpError(400, 'Cannot move more than 500 houses at once');
        if (ids.some(id => !isObjectId(id))) throw new HttpError(400, 'Invalid house id');

        const { group, building } = await resolvePlacement({
            landlord: landlordScope, property: property._id, buildingId: req.body.buildingId || null
        });

        const houses = await House.find({ _id: { $in: ids }, landlord: landlordScope, property: property._id }).select('name').lean();
        if (houses.length !== ids.length) throw new HttpError(404, 'One or more houses were not found in this property');

        for (const h of houses) {
            await House.updateOne(
                { _id: h._id, landlord: landlordScope, property: property._id },
                { group, groupSeq: building ? seqFromName(h.name, building.prefix) : null }
            );
        }

        logActivity({
            landlord: landlordScope, property: property._id, action: 'houses.moved',
            message: `${houses.length} house${houses.length === 1 ? '' : 's'} moved to ${building ? `"${building.label}"` : 'Unassigned'} in ${property.name}`,
            meta: { count: houses.length, buildingId: building ? building._id : null }
        });
        res.json({ message: `${houses.length} house${houses.length === 1 ? '' : 's'} moved ✅`, moved: houses.length });
    }));

    // ─────────────────────────────────────────────────────────
    //  POST /buildings/organize   { propertyId, dryRun? }
    //  One-click tidy-up for old data: everything with no building goes into "Main Building".
    //  Idempotent. dryRun only counts.
    // ─────────────────────────────────────────────────────────
    app.post('/buildings/organize', authMiddleware, landlordOnly, checkAccountStatus, handle(async (req, res) => {
        const { landlordScope, property } = await propertyFor(req, req.body.propertyId);

        const groups = await HouseGroup.find({ landlord: landlordScope, property: property._id }).select('_id label').lean();
        const known  = new Set(groups.map(g => String(g._id)));
        const houses = await House.find({ landlord: landlordScope, property: property._id }).select('group').lean();
        const loose  = houses.filter(h => !h.group || !known.has(String(h.group)));

        if (req.body.dryRun || !loose.length) {
            return res.json({ message: loose.length ? `${loose.length} house(s) have no building` : 'Nothing to organize', count: loose.length, dryRun: !!req.body.dryRun });
        }

        let main = groups.find(g => String(g.label).trim().toLowerCase() === 'main building');
        if (!main) {
            main = await HouseGroup.create({
                landlord: landlordScope, property: property._id, label: 'Main Building', prefix: '', padWidth: 0,
                colorIndex: groups.length % PALETTE_SIZE, icon: 'properties'
            });
        }
        await House.updateMany(
            { _id: { $in: loose.map(h => h._id) }, landlord: landlordScope, property: property._id },
            { group: main._id }
        );
        logActivity({
            landlord: landlordScope, property: property._id, action: 'houses.organized',
            message: `${loose.length} house(s) organized into "Main Building" in ${property.name}`, meta: { count: loose.length }
        });
        res.json({ message: `${loose.length} house(s) moved into "Main Building" ✅`, count: loose.length, buildingId: main._id });
    }));
};
