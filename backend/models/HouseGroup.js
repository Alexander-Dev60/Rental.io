// models/HouseGroup.js  — REPLACES the existing file.
//
// A HouseGroup is one "naming batch" of houses, and it now also plays the part of a BUILDING:
// each group is one building card in the landlord and tenant dashboards. Every group that already
// exists simply becomes a building — no house or group data has to be rewritten.
// (The Per-Floor generator still creates one group per floor, e.g. "Sunrise Tower -- Floor 1";
//  those show up as separate building cards and can be renamed.)

const mongoose = require('mongoose');

// Icons a landlord may pick for a building (names exist in the frontend icons.js).
const BUILDING_ICONS = ['properties', 'houses', 'home', 'layers', 'wall', 'box'];

const houseGroupSchema = new mongoose.Schema({
    landlord:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
    property:   { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    label: {
        type:      String,
        trim:      true,
        required:  [true, 'A group label is required'],
        minlength: [1, 'A group label is required']
    },  // e.g. "Flat 1", "Block A" — shown as the building name
    prefix:     { type: String, default: '' },    // naming hint, e.g. "A", "1" — optional
    padWidth:   { type: Number, default: 0 },     // zero-padding width used for this group's numbers
    colorIndex: { type: Number, default: 0 },     // cycles through the frontend's color palette

    // ── NEW ──
    icon:        { type: String, enum: BUILDING_ICONS, default: 'properties' },
    description: { type: String, trim: true, maxlength: 200, default: '' }
}, { timestamps: true });

houseGroupSchema.index({ property: 1, createdAt: 1 });
houseGroupSchema.index({ landlord: 1, property: 1 });

module.exports = mongoose.model('HouseGroup', houseGroupSchema);
module.exports.BUILDING_ICONS = BUILDING_ICONS;
