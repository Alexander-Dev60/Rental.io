// ═══════════════════════════════════════════════════════
//  models/Tenant.js — SaaS Multi-tenant version
//  Added: status field ('active' | 'moved_out')
// ═══════════════════════════════════════════════════════

const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({

    // ── Which landlord owns this tenant ──
    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    // ── Which property this tenant belongs to ──
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

    phone: {
        type:     String,
        required: true,
        trim:     true
    },

    email: {
        type:      String,
        required:  true,
        lowercase: true,
        trim:      true
    },

    // Day of month rent is due (e.g. 5 = 5th of each month)
    dueDate: {
        type:    Number,
        default: 5
    },

    house: {
        type:    mongoose.Schema.Types.ObjectId,
        ref:     'House',
        default: null
    },

    // ── Tenancy status ──
    // 'active'   = currently living here, appears in landlord's active list
    // 'moved_out'= has left, hidden from active list but record kept for history
    //              User account stays linked (tenantId NOT cleared) so they
    //              can still log in and view payment history
    status: {
        type:    String,
        enum:    ['active', 'moved_out'],
        default: 'active'
    },

        // Snapshot of last residence for the dashboard banner
    lastHouse:    { type: mongoose.Schema.Types.ObjectId, ref: 'House',    default: null },
    lastProperty: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', default: null },
    lastLandlord: { type: mongoose.Schema.Types.ObjectId, ref: 'User',     default: null },

    // When the tenant moved out (null if still active)
    movedOutAt: {
        type:    Date,
        default: null
    }
    

}, { timestamps: true });

// ── Compound index: landlord + email unique together per property ──
// Same email can exist under different properties (SaaS isolation)
tenantSchema.index({ property: 1, email: 1 }, { unique: true });
tenantSchema.index({ landlord: 1, property: 1 });
tenantSchema.index({ property: 1, house: 1 });

// ── Fast lookup of active tenants per landlord/property ──
tenantSchema.index({ landlord: 1, status: 1 });
tenantSchema.index({ property: 1, status: 1 });

module.exports = mongoose.model('Tenant', tenantSchema);