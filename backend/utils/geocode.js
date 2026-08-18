// utils/geocode.js
const Property = require('../models/Property');

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT = process.env.NOMINATIM_USER_AGENT
    || 'AffordableRentals/1.0 (support@affordablerentals.site)';

let _queue = Promise.resolve();
const MIN_INTERVAL_MS = 1100;
let _lastCallAt = 0;

function _throttled(fn) {
    _queue = _queue.then(async () => {
        const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - _lastCallAt));
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        _lastCallAt = Date.now();
        return fn();
    });
    return _queue;
}

async function _fetchJson(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept':     'application/json'
        }
    });
    if (!res.ok) {
        throw new Error(`Nominatim request failed: HTTP ${res.status}`);
    }
    return res.json();
}

async function geocodeAddress(text) {
    if (!text || !text.trim()) return null;

    try {
        const data = await _throttled(() => {
            const url = `${NOMINATIM_BASE}/search?` + new URLSearchParams({
                q:              text.trim(),
                format:         'jsonv2',
                limit:          '1',
                countrycodes:   'ke',
                addressdetails: '1'
            });
            return _fetchJson(url);
        });

        if (!Array.isArray(data) || !data.length) return null;

        const hit = data[0];
        return {
            lat:              parseFloat(hit.lat),
            lng:              parseFloat(hit.lon),
            formattedAddress: hit.display_name || text.trim()
        };
    } catch (err) {
        console.error('geocodeAddress error:', err.message);
        return null;
    }
}

async function reverseGeocode(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    try {
        const data = await _throttled(() => {
            const url = `${NOMINATIM_BASE}/reverse?` + new URLSearchParams({
                lat:    String(lat),
                lon:    String(lng),
                format: 'jsonv2'
            });
            return _fetchJson(url);
        });

        if (!data || !data.display_name) return null;

        return { formattedAddress: data.display_name };
    } catch (err) {
        console.error('reverseGeocode error:', err.message);
        return null;
    }
}

async function geocodeAndSaveProperty(propertyId, opts = {}) {
    if (!propertyId) return null;

    let lat, lng, formattedAddress;

    if (opts.addressOnly) {
        const result = await geocodeAddress(opts.addressOnly);
        if (!result) return null;
        ({ lat, lng, formattedAddress } = result);

    } else if (Number.isFinite(opts.lat) && Number.isFinite(opts.lng)) {
        lat = opts.lat;
        lng = opts.lng;

        if (opts.address && opts.address.trim()) {
            formattedAddress = opts.address.trim();
        } else {
            const rev = await reverseGeocode(lat, lng);
            formattedAddress = rev ? rev.formattedAddress : null;
        }

    } else {
        return null;
    }

    const now = new Date();

    const updated = await Property.findByIdAndUpdate(
        propertyId,
        {
            $set: {
                geo: {
                    type:        'Point',
                    coordinates: [lng, lat]
                },
                formattedAddress: formattedAddress || null,
                geocodedAt:       now
            }
        },
        { new: true, runValidators: true }
    );

    return updated;
}

module.exports = {
    geocodeAddress,
    reverseGeocode,
    geocodeAndSaveProperty
};