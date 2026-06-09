// models/Property.js
const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema({

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    name: {
        type:     String,
        required: true,
        trim:     true   // e.g. "GreenView Apartments"
    },

    location: {
        type:    String,
        trim:    true,
        default: null    // e.g. "Nairobi, Westlands"
    },

    phone: {
        type:    String,
        trim:    true,
        default: null
    },

    // ── M-Pesa config per property (each property has its own paybill) ──
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

    // ── Public listing fields ──
    // Landlord opts in explicitly — false by default so no property
    // is publicly visible until the landlord enables it.
    isListed: {
        type:    Boolean,
        default: false
    },

    // Short pitch shown on the discovery page and auth slideshow.
    description: {
        type:    String,
        trim:    true,
        default: ''
    },

    // Array of Cloudinary (or any CDN) image URLs uploaded by the landlord.
    // Capped at 5 to keep document size reasonable.
    photos: {
        type:     [String],
        default:  [],
        validate: {
            validator: function (arr) { return arr.length <= 5; },
            message:   'A property can have at most 5 photos'
        }
    },

    isApproved: {
        type:    Boolean,
        default: false
    }

}, { timestamps: true });

// ── Indexes ──
propertySchema.index({ landlord: 1 });
propertySchema.index({ landlord: 1, name: 1 }, { unique: true }); // no duplicate names per landlord
propertySchema.index({ isListed: 1 , isApproved: 1 });             // fast public listing queries
propertySchema.index({ isListed: 1,isApproved: 1, location: 1 });                // fast location-filtered queries

module.exports = mongoose.model('Property', propertySchema);