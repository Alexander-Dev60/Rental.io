// services/buildingHelpers.js — shared building/house helpers (no Express here).

const HttpError = require('./httpError');

function createBuildingHelpers({ mongoose, HouseGroup }) {

    // A real 24-hex ObjectId string (rejects things like "12" or "none" that would throw a CastError).
    const isObjectId = v => /^[a-f0-9]{24}$/i.test(String(v == null ? '' : v));

    // "A101" + prefix "A" → 101 ; anything that isn't prefix + digits → null.
    // Lets "Extend building" keep counting after houses were moved in by hand.
    function seqFromName(name, prefix) {
        const p = typeof prefix === 'string' ? prefix : '';
        const n = String(name || '');
        if (!n.startsWith(p)) return null;
        const rest = n.slice(p.length);
        return /^\d+$/.test(rest) ? Number(rest) : null;
    }

    // Where should a new/moved house live?
    //   buildingId → { group, groupSeq, building }   (throws HttpError if it isn't THIS landlord's building
    //                                                 in THIS property)
    //   nothing    → { group: null, groupSeq: null } (Unassigned)
    async function resolvePlacement({ landlord, property, buildingId, houseName }) {
        if (!buildingId) return { group: null, groupSeq: null, building: null };
        if (!isObjectId(buildingId)) throw new HttpError(400, 'Invalid building');

        const building = await HouseGroup.findOne({ _id: buildingId, landlord, property });
        if (!building) throw new HttpError(404, 'Building not found');

        return { group: building._id, groupSeq: seqFromName(houseName, building.prefix), building };
    }

    return { isObjectId, seqFromName, resolvePlacement };
}

module.exports = createBuildingHelpers;
