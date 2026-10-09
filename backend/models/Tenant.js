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
    assignedAt: { type: Date, default: null },

    // LEGACY day of month rent is due (e.g. 5 = 5th of each month). Only used by tenants whose rent
    // cycle has no anchor yet (cycleAnchor === null). New tenants get NO default: their rent cycle
    // starts on the day they are assigned a house (see cycleAnchor below).
    dueDate: {
        type:    Number,
        default: null
    },

    // ── Monthly rent cycle ──
    // cycleAnchor: the date the monthly rent cycle starts from — set when the tenant is assigned a
    // house. Cycle k runs from (anchor + k months) to (anchor + k+1 months), so a tenant assigned
    // on 10 Oct is billed 10 Oct → 10 Nov → 10 Dec … null = legacy calendar-month tenant
    // (created before this change), whose behaviour is untouched.
    cycleAnchor: { type: Date, default: null },

    // Landlord-adjusted end/due date of ONE cycle. It moves only the date (no extra charge); the
    // next cycle then starts from `date`. Never overwritten by automatic calculation — the
    // automatic dates are derived on read and are never stored.
    cycleEndOverride: {
        date:        { type: Date, default: null },   // the new end / due date
        cycleStart:  { type: Date, default: null },   // start of the cycle being extended
        originalEnd: { type: Date, default: null },   // the automatic end date it replaced
        setAt:       { type: Date, default: null },
        setBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
    },

    // Houses this tenant lived in before a transfer. Lets closed periods keep the rent of the house
    // the tenant actually lived in, so a transfer can never reprice history.
    houseHistory: [{
        _id:             false,
        house:           { type: mongoose.Schema.Types.ObjectId, ref: 'House' },
        houseName:       { type: String, default: '' },
        rent:            { type: Number, default: 0 },
        billingCycle:    { type: String, enum: ['monthly', 'semester'], default: 'monthly' },
        from:            { type: Date, default: null },
        to:              { type: Date, default: null },     // when the transfer happened
        lastPeriodStart: { type: Date, default: null }      // start of the cycle the old rent still applies to (monthly)
    }],

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

    // ── Deposit tracking (moved off House — deposit must survive move-out
    //    and reactivation, which a house-scoped field can't do since the
    //    house gets freed up / reused by a different tenant) ──
    depositStatus: {
        type: String,
        enum: ['none', 'partial', 'paid', 'refunded'],
        default: 'none'
    },
    depositAmount: {
        type: Number,
        default: 0
    },
    depositPaidAt: {
        type: Date,
        default: null
    },
    // Which property this deposit was paid against. tenant.property itself
    // gets overwritten on cross-property reactivation (see assign-house),
    // so this is the only reliable way to tell "was this deposit for THIS
    // property" after a reactivation into a different property.
    depositPaidForProperty: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Property',
        default: null
    },

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