// models/HouseGroup.js
//
// NEW FILE — add this alongside your other models (models/House.js etc).
// A "group" represents one naming batch (one row in Simple/Advanced
// generate mode — e.g. "Block A" or "Ground Floor"). Houses reference
// their group so we can:
//   1. Know the next number to continue from when extending a group
//      (e.g. landlord adds A24, A25 to an existing A1..A23 block)
//   2. Sort the house grid by group, then by position within the group
//   3. Give each group a consistent color in the UI

const mongoose = require('mongoose');

const houseGroupSchema = new mongoose.Schema({
    landlord:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
    property:   { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    label:      { type: String, default: '' },   // e.g. "Ground Floor", "Block A" — shown in UI
    prefix:     { type: String, default: '' },    // e.g. "A", "1"
    padWidth:   { type: Number, default: 0 },     // zero-padding width used for this group's numbers
    colorIndex: { type: Number, default: 0 }      // cycles through the frontend's color palette
}, { timestamps: true });

module.exports = mongoose.model('HouseGroup', houseGroupSchema);