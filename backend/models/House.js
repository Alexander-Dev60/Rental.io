// ═══════════════════════════════════════════════════════
//  models/House.js — SaaS Multi-tenant version
//  Added: landlord ref for data isolation
// ═══════════════════════════════════════════════════════

const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════
//  models/House.js
// ═══════════════════════════════════════════════════════
const houseSchema = new mongoose.Schema({

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    // ── Which property this house belongs to ──
    property: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Property',
        required: true
    },

    name: {
        type:     String,
        required: true,
        trim:     true
    },

    rent: {
        type:     Number,
        required: true
    },

    status: {
        type:    String,
        enum:    ['available', 'occupied'],
        default: 'available'
    }

}, { timestamps: true });

// House name unique per property
houseSchema.index({ property: 1, name: 1 }, { unique: true });
houseSchema.index({ landlord: 1, property: 1 });

module.exports = mongoose.model('House', houseSchema);

