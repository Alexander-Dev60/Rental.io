// How many semesters a tenant is expected to stay this academic year.
// "Completed" is DERIVED from dates at read time — never stored — so it can't drift.
const mongoose = require('mongoose');

const tenantStaySchema = new mongoose.Schema({
    landlord: { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    tenant:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant',   required: true, unique: true },
    expectedSemesterCount: { type: Number, min: 1, max: 3, required: true },
    academicYear: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('TenantStay', tenantStaySchema);