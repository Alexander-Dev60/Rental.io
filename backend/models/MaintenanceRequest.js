// ═══════════════════════════════════════════════════════
//  models/MaintenanceRequest.js — SaaS Multi-tenant version
//  Tenant-reported issues tracked through a landlord-managed
//  status pipeline: reported → in_progress → completed
// ═══════════════════════════════════════════════════════

const mongoose = require('mongoose');

const maintenanceRequestSchema = new mongoose.Schema({

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

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

    category: {
        type:    String,
        enum:    ['plumbing', 'electrical', 'structural', 'appliance', 'pest', 'other'],
        default: 'other'
    },

    description: {
        type:      String,
        required:  true,
        trim:      true,
        maxlength: 1000
    },

    priority: {
        type:    String,
        enum:    ['low', 'medium', 'high'],
        default: 'medium'
    },

    status: {
        type:    String,
        enum:    ['reported', 'in_progress', 'completed'],
        default: 'reported'
    },

    cost: {
        type:    Number,
        default: null
    },

    resolutionNote: {
        type:    String,
        default: '',
        trim:    true
    },

    completedAt: {
        type:    Date,
        default: null
    }

}, { timestamps: true });

maintenanceRequestSchema.index({ landlord: 1, property: 1, status: 1 });
maintenanceRequestSchema.index({ tenant: 1, createdAt: -1 });

module.exports = mongoose.model('MaintenanceRequest', maintenanceRequestSchema);