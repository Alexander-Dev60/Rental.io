// models/TenantMembership.js
const mongoose = require('mongoose');


// ═══════════════════════════════════════════════════════
//  models/TenantMembership.js
// ═══════════════════════════════════════════════════════
const tenantMembershipSchema = new mongoose.Schema({

    user: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    // ── Which property they were a member of ──
    property: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Property',
        required: true
    },

    tenant: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Tenant',
        required: true
    },

    house: {
        type:    mongoose.Schema.Types.ObjectId,
        ref:     'House',
        default: null
    },

    status: {
        type:    String,
        enum:    ['active', 'moved_out'],
        default: 'active'
    },

    joinedAt: {
        type:    Date,
        default: Date.now
    },

    leftAt: {
        type:    Date,
        default: null
    }

}, { timestamps: true });

tenantMembershipSchema.index({ user: 1, status: 1 });
tenantMembershipSchema.index({ property: 1, status: 1 });
tenantMembershipSchema.index({ landlord: 1, property: 1 });

module.exports = mongoose.model('TenantMembership', tenantMembershipSchema);