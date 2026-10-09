// models/TenantNotification.js
//
// A short message shown on the tenant's own dashboard (and, for the ones that matter, also emailed).
// Created by the system when something happens to the tenant's account — e.g. the landlord set a
// holiday holding fee. Tenants only ever read their own.
const mongoose = require('mongoose');

const tenantNotificationSchema = new mongoose.Schema({
    landlord: { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    tenant:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant',   required: true },

    type:  { type: String, enum: ['holiday_fee', 'general'], default: 'general' },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    body:  { type: String, required: true, trim: true, maxlength: 1000 },
    meta:  { type: mongoose.Schema.Types.Mixed, default: {} },

    readAt: { type: Date, default: null }
}, { timestamps: true });

tenantNotificationSchema.index({ tenant: 1, createdAt: -1 });
tenantNotificationSchema.index({ tenant: 1, readAt: 1 });

module.exports = mongoose.model('TenantNotification', tenantNotificationSchema);
