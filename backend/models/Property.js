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

    paymentLastUpdated: { type: Date, default: null }

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