// models/Property.js
const mongoose = require('mongoose');

const geoSchema = new mongoose.Schema({
    type: {
        type:    String,
        enum:    ['Point'],
        default: 'Point'
    },
    coordinates: {
        type:     [Number], // [longitude, latitude]
        required: true,
        validate: {
            validator: function (coords) {
                if (!Array.isArray(coords) || coords.length !== 2) return false;
                const [lng, lat] = coords;
                return Number.isFinite(lng) && Number.isFinite(lat) &&
                       lng >= -180 && lng <= 180 &&
                       lat >= -90  && lat <= 90;
            },
            message: 'coordinates must be exactly [longitude, latitude] within valid ranges'
        }
    }
}, { _id: false });


// One entry per semester in the academic year (2–3). Day fields give the
// landlord real-calendar control; endDay null = "last day of the end month".
const semesterEntrySchema = new mongoose.Schema({
    label:      { type: String, trim: true, default: '' },
    startMonth: { type: Number, min: 1, max: 12, required: true },
    startDay:   { type: Number, min: 1, max: 31, default: 1 },
    endMonth:   { type: Number, min: 1, max: 12, required: true },
    endDay:     { type: Number, min: 1, max: 31, default: null },
    rentAmount: { type: Number, min: 0, default: null },   // null = use the property's default semester rent
    dueDay:     { type: Number, min: 1, max: 28, default: null } // null = use the property default
}, { _id: false });


const propertySchema = new mongoose.Schema({

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    name: {
        type:     String,
        required: true,
        trim:     true
    },
    semesterRule: {
        enabled: { type: Boolean, default: false },
        // startMonth/endMonth mirror Semester 1 (legacy readers keep working)
        startMonth: { type: Number, min: 1, max: 12, default: 1 },
        endMonth: { type: Number, min: 1, max: 12, default: 6 },
        // DEFAULT rent per semester; any semester may override it
        rentAmount: { type: Number, min: 0, default: 0 },
        dueDay: { type: Number, min: 1, max: 28, default: 5 },
        // Holiday holding fee per month (pro-rated per day while a tenant is away)
        holdingFee: { type: Number, min: 0, default: 0 },
        // What happens when a semester ends and the next one has not started yet:
        //   ask  = the landlord is asked to pick a holding-fee option for every tenant (default)
        //   auto = the default holding fee is applied automatically
        //   none = no holding fee is charged during the gap
        gapPolicy: { type: String, enum: ['ask', 'auto', 'none'], default: 'ask' },
        semesters: {
            type: [semesterEntrySchema],
            default: [],
            validate: { validator: arr => arr.length <= 3, message: 'An academic year can have at most 3 semesters' }
        },
        expiryDate: { type: Date, default: null }
    },
    // Default holiday holding fee for MONTHLY tenants (Ksh per month, pro-rated per day while away).
    // Semester tenants use semesterRule.holdingFee.
    monthlyHoldingFee: { type: Number, min: 0, default: 0 },
    depositPolicy: {
        requireDepositBeforeAssignment: { type: Boolean, default: true },
        depositAmount: { type: Number, min: 0, default: 0 }
        // landlordOverrideAllowed REMOVED — no override, ever.
        // minimumDepositPercent REMOVED — deposit is now a fixed Ksh amount
        // the landlord sets, exactly like semesterRule.rentAmount.
    },

    location: {
        type:    String,
        trim:    true,
        default: null
    },

    geo: {
        type:    geoSchema,
        default: undefined
    },

    formattedAddress: {
        type:    String,
        trim:    true,
        default: null
    },

    geocodedAt: {
        type:    Date,
        default: null
    },

    phone: {
        type:    String,
        trim:    true,
        default: null
    },
    // models/Property.js
    mpesaAccountType: {
        type: String,
        enum: ['paybill', 'till'],
        default: 'paybill'
    },

    paybillNumber: {
        type:    String,
        trim:    true,
        default: null
    },

    mpesaConsumerKey: {
        type:    String,
        default: null
    },

    mpesaConsumerSecret: {
        type:    String,
        default: null
    },

    mpesaPasskey: {
        type:    String,
        default: null
    },

    paymentConfigured: {
        type:    Boolean,
        default: false
    },

    isActive: {
        type:    Boolean,
        default: true
    },

    isListed: {
        type:    Boolean,
        default: false
    },

    description: {
        type:    String,
        trim:    true,
        default: ''
    },

    photos: {
        type:     [String],
        default:  [],
        validate: {
            validator: function (arr) { return arr.length <= 5; },
            message:   'A property can have at most 5 photos'
        }
    },
    isSuspended:     { type: Boolean, default: false },
    suspendedReason: { type: String,  default: null },
    suspendedAt:     { type: Date,    default: null },
    suspendedBy:     { type: String,  enum: ['system', 'stacklord', null], default: null },

    isApproved: {
        type:    Boolean,
        default: false
    },

    paymentLastUpdated: { type: Date, default: null },

    // Running credit from commission that turns out to have been overpaid
    // because a rent refund landed after that month's commission was
    // already settled. Applied as a discount the next time commission for
    // ANY month on this property is computed — see
    // computeCommissionForProperty() and reconcileCommissionOverpayment().
    commissionCreditBalance: { type: Number, default: 0, min: 0 }

}, { timestamps: true });

propertySchema.virtual('hasLocation').get(function () {
    return !!(this.geo && Array.isArray(this.geo.coordinates) && this.geo.coordinates.length === 2);
});

propertySchema.index({ landlord: 1 });
propertySchema.index({ landlord: 1, name: 1 }, { unique: true });
propertySchema.index({ isListed: 1, isApproved: 1 });
propertySchema.index({ isListed: 1, isApproved: 1, location: 1 });

propertySchema.index({ geo: '2dsphere' });
propertySchema.index({ isListed: 1, isApproved: 1, geo: '2dsphere' });

propertySchema.set('toJSON',   { virtuals: true });
propertySchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Property', propertySchema);