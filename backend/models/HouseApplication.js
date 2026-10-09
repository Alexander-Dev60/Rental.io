// models/HouseApplication.js  — NEW
//
// A tenant's request for one specific available house. It is only a REQUEST: approving it runs the
// existing assign-house logic (deposit gate, reactivation rules, occupancy, activity log), so rent and
// deposit rules stay the single source of truth. Nothing here changes a house or a tenant by itself.

const mongoose = require('mongoose');

const houseApplicationSchema = new mongoose.Schema({
    landlord: { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    tenant:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant',   required: true },
    house:    { type: mongoose.Schema.Types.ObjectId, ref: 'House',    required: true },

    // Top-level building the house sat in when the tenant applied (null = "unassigned" house).
    // Kept for display/filtering; the house itself is always the source of truth.
    building: { type: mongoose.Schema.Types.ObjectId, ref: 'HouseGroup', default: null },

    status: {
        type:    String,
        enum:    ['pending', 'approved', 'rejected', 'withdrawn', 'cancelled'],
        default: 'pending'
    },
    // pending   → waiting for the landlord
    // approved  → the tenant was assigned this house (via the existing assignment logic)
    // rejected  → landlord said no, or the house went to someone else
    // withdrawn → the tenant took it back
    // cancelled → no longer relevant (tenant got another house, house deleted…)

    note:         { type: String, trim: true, maxlength: 300, default: '' },   // from the tenant
    decisionNote: { type: String, trim: true, maxlength: 300, default: '' },   // from the landlord / system
    decidedAt:    { type: Date, default: null },
    decidedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

// A tenant may have only ONE pending application at a time (partial unique index).
houseApplicationSchema.index(
    { tenant: 1 },
    { unique: true, partialFilterExpression: { status: 'pending' } }
);
houseApplicationSchema.index({ landlord: 1, property: 1, status: 1, createdAt: -1 });
houseApplicationSchema.index({ house: 1, status: 1 });

module.exports = mongoose.model('HouseApplication', houseApplicationSchema);
