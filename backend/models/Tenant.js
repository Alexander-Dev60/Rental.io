const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },

    phone: {
        type: String,
        required: true,
        trim: true
    },

    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },

    dueDate: {
        type: Number, // day of month (e.g. 5 = 5th)
        default: 5
    },

    house: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'House',
        default: null
    }

}, { timestamps: true });

module.exports = mongoose.model('Tenant', tenantSchema);