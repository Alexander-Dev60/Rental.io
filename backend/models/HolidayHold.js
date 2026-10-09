// A tenant who is away on holiday but keeps the room reserved. The tenant
// stays status:'active' and the house stays 'occupied' — this record is what
// pauses semester rent and starts the (much smaller) holding fee.
const mongoose = require('mongoose');

const holidayHoldSchema = new mongoose.Schema({
    landlord: { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    tenant:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant',   required: true },
    house:    { type: mongoose.Schema.Types.ObjectId, ref: 'House',    default: null },

    // active   = away, room reserved
    // returned = tenant came back (actualReturnDate set)
    // ended    = landlord converted it to a move-out (endedAt set)
    status: { type: String, enum: ['active', 'returned', 'ended'], default: 'active' },

    startDate:          { type: Date, required: true },
    expectedReturnDate: { type: Date, required: true },
    actualReturnDate:   { type: Date, default: null },
    endedAt:            { type: Date, default: null },

    // Fee per 30 days, snapshotted at creation so a later property-level
    // change can never reprice a hold already in progress. 0 = the landlord chose "no fee".
    feeAmount: { type: Number, min: 0, default: 0 },
    note:      { type: String, default: '' },

    // Which billing cycle the tenant was on when the hold started. Holds recorded before monthly
    // tenants could go on holiday have no value here and are semester holds.
    billingCycle: { type: String, enum: ['monthly', 'semester'], default: 'semester' },

    // 'holiday'          = the landlord recorded that the tenant is away.
    // 'between_semesters'= created from the "between semesters" decision (or the property's gap policy);
    //                      it covers exactly the days between two semesters and ends by itself on
    //                      autoEndDate (the day the next semester starts) — no "Mark Returned" click.
    kind:        { type: String, enum: ['holiday', 'between_semesters'], default: 'holiday' },
    autoEndDate: { type: Date, default: null },
    autoEnded:   { type: Boolean, default: false }   // true once the system closed it on autoEndDate
}, { timestamps: true });

holidayHoldSchema.index({ landlord: 1, property: 1, status: 1 });
// At most ONE active hold per tenant — enforced by the database, not just the route.
holidayHoldSchema.index({ tenant: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });

module.exports = mongoose.model('HolidayHold', holidayHoldSchema);