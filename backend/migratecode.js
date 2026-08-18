// scripts/migrateGeocode.js
//
// One-time, best-effort backfill: for every existing property that has a
// typed `location` string but no `geo` yet, forward-geocode that text and
// save coordinates. Landlords can still correct the pin later via the
// map-picker — this just means old properties aren't invisible on the map
// on day one.
//
// Run manually, once, after deploying the geo schema change:
//   node scripts/migrateGeocode.js
//
// Safe to re-run: it only touches properties where `geo` is still unset,
// so anything already geocoded (migrated or landlord-set) is skipped.

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./db');
const Property = require('./models/Property');
const { geocodeAndSaveProperty } = require('./utils/geocode');

async function run() {
    await connectDB();

    const targets = await Property.find({
        geo:      { $exists: false },
        location: { $exists: true, $ne: null, $ne: '' }
    }).select('_id name location');

    console.log(`Found ${targets.length} propert${targets.length === 1 ? 'y' : 'ies'} to geocode.`);

    let ok = 0, failed = 0;

    // geocodeAndSaveProperty is already rate-limited internally (Nominatim
    // usage policy: max 1 req/sec), so we can just await in sequence here
    // without adding a second layer of throttling.
    for (const prop of targets) {
        process.stdout.write(`  ${prop.name} (${prop.location}) ... `);
        const updated = await geocodeAndSaveProperty(prop._id, { addressOnly: prop.location });
        if (updated) {
            ok++;
            console.log(`✅ [${updated.geo.coordinates[1]}, ${updated.geo.coordinates[0]}]`);
        } else {
            failed++;
            console.log('❌ no match — landlord can set the pin manually later');
        }
    }

    console.log(`\nDone. ${ok} geocoded, ${failed} skipped/failed.`);
    await mongoose.connection.close();
    process.exit(0);
}

run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});