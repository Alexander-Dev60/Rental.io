// A small in-memory stand-in for the parts of Mongoose the new modules use. It exists only so the route
// logic (ownership checks, atomic claims, rules) can be exercised without a MongoDB server.
let idCounter = 0, clock = 1700000000000;
const newId = () => (++idCounter).toString(16).padStart(24, '0');
const S = v => (v && v._id && typeof v === 'object' && !(v instanceof Date)) ? String(v._id) : String(v);

class ObjectId { constructor(v) { this.v = String(v); } toString() { return this.v; } }
const mongoose = { Types: { ObjectId } };

const isOp = o => o && typeof o === 'object' && !(o instanceof Date) && !Array.isArray(o) && Object.keys(o).some(k => k.startsWith('$'));

function matchValue(actual, cond) {
    if (isOp(cond)) {
        return Object.entries(cond).every(([op, val]) => {
            if (op === '$in')  return val.map(S).includes(actual == null ? 'null' : S(actual)) || (val.includes(null) && actual == null);
            if (op === '$nin') return !val.map(S).includes(actual == null ? 'null' : S(actual));
            if (op === '$ne')  return S(actual == null ? 'null' : actual) !== S(val == null ? 'null' : val);
            if (op === '$gte') return actual >= val;
            throw new Error('fake: unsupported operator ' + op);
        });
    }
    if (cond === null) return actual == null;
    if (actual == null) return false;
    return S(actual) === S(cond);
}
function matches(doc, filter) {
    return Object.entries(filter || {}).every(([k, v]) => {
        if (k === '$or') return v.some(f => matches(doc, f));
        return matchValue(doc[k], v);
    });
}
const plain = d => JSON.parse(JSON.stringify(d, (k, v) => (v instanceof ObjectId ? v.toString() : v)));
const project = (d, sel) => {
    if (!sel) return d;
    const keep = new Set(String(sel).split(/\s+/).filter(Boolean)); keep.add('_id');
    const o = {}; for (const k of Object.keys(d)) if (keep.has(k)) o[k] = d[k]; return o;
};

function makeModel(name, { refs = {}, unique = [], defaults = {} } = {}) {
    const store = new Map();
    const registry = makeModel.registry = makeModel.registry || {};

    class Doc {
        constructor(data) {
            Object.assign(this, data);
            Object.defineProperty(this, '__snap', { value: plain(data), writable: true, enumerable: false });
        }
        async save() {
            const now = plain(this), changes = {};
            for (const k of Object.keys(now)) if (JSON.stringify(now[k]) !== JSON.stringify(this.__snap[k])) changes[k] = now[k];
            store.set(this._id, { ...store.get(this._id), ...changes });
            this.__snap = plain(store.get(this._id));
            return this;
        }
        toObject() { return plain(this); }
    }

    function check(doc) {
        for (const fn of unique) if (fn(doc, [...store.values()])) { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
    }

    class Query {
        constructor(filter, one) { this.f = filter; this.one = one; this.sel = null; this.pop = []; this.srt = null; this.lim = null; this.isLean = false; }
        select(s) { this.sel = s; return this; }
        populate(path, sel) { this.pop.push([path, sel]); return this; }
        sort(s) { this.srt = s; return this; }
        limit(n) { this.lim = n; return this; }
        lean() { this.isLean = true; return this; }
        then(res, rej) { return this.exec().then(res, rej); }
        async exec() {
            let rows = [...store.values()].filter(d => matches(d, this.f));
            if (this.srt) { const [k, dir] = Object.entries(this.srt)[0]; rows.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); }
            if (this.lim) rows = rows.slice(0, this.lim);
            if (this.one) rows = rows.slice(0, 1);
            rows = rows.map(d => plain(d));
            const hasPop = this.pop.length > 0;
            rows = rows.map(d => {
                let o = project(d, this.sel);
                if (this.sel || hasPop) { /* projection applied */ }
                for (const [path, sel] of this.pop) {
                    const target = registry[refs[path]];
                    if (o[path] && target) { const ref = target.__store.get(S(o[path])); o[path] = ref ? project(plain(ref), sel) : null; }
                }
                return o;
            });
            const out = this.isLean ? rows : rows.map(d => new Doc(d));
            return this.one ? (out[0] || null) : out;
        }
    }

    const Model = {
        modelName: name, __store: store,
        find: f => new Query(f, false),
        findOne: f => new Query(f, true),
        findById: id => new Query({ _id: id }, true),
        async create(data) {
            const now = new Date(clock += 1000).toISOString();
            const d = { ...plain(defaults), ...plain(data), _id: newId(), createdAt: now, updatedAt: now };
            check(d); store.set(d._id, d); return new Doc(d);
        },
        async countDocuments(f) { return [...store.values()].filter(d => matches(d, f)).length; },
        async updateOne(f, u) { const d = [...store.values()].find(x => matches(x, f)); if (d) Object.assign(d, u.$set || u); return { matchedCount: d ? 1 : 0 }; },
        async updateMany(f, u) { let n = 0; for (const d of store.values()) if (matches(d, f)) { Object.assign(d, u.$set || u); n++; } return { matchedCount: n }; },
        async deleteOne(f) { const d = [...store.values()].find(x => matches(x, f)); if (d) store.delete(d._id); },
        async deleteMany(f) { for (const d of [...store.values()]) if (matches(d, f)) store.delete(d._id); },
        // Atomic: the filter and the write happen in the same synchronous step, like MongoDB.
        findOneAndUpdate(f, u, opts = {}) {
            return { then: (res, rej) => Promise.resolve().then(() => {
                const d = [...store.values()].find(x => matches(x, f));
                if (!d) return null;
                const before = plain(d);
                Object.assign(d, u.$set || u);
                return new Doc(opts.returnDocument === 'after' || opts.new ? plain(d) : before);
            }).then(res, rej) };
        },
        async aggregate(pipeline) {
            const [m, g] = pipeline; let rows = [...store.values()].filter(d => matches(d, m.$match));
            const keyOf = d => { const id = g.$group._id; if (typeof id === 'string') return { v: d[id.slice(1)] ?? null, k: String(d[id.slice(1)] ?? null) };
                const o = {}; for (const [a, b] of Object.entries(id)) o[a] = d[b.slice(1)] ?? null; return { v: o, k: JSON.stringify(o) }; };
            const groups = new Map();
            for (const d of rows) { const { v, k } = keyOf(d); const e = groups.get(k) || { _id: v, n: 0 }; e.n += 1; groups.set(k, e); }
            return [...groups.values()];
        }
    };
    registry[name] = Model;
    return Model;
}

// ── tiny express stand-in ──
function makeApp() {
    const routes = [];
    const add = method => (path, ...handlers) => {
        const keys = []; const rx = new RegExp('^' + path.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
        routes.push({ method, rx, keys, handlers });
    };
    const app = { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'), routes };
    app.call = async (method, url, { user = null, body = {}, query = {} } = {}) => {
        const route = routes.find(r => r.method === method && r.rx.test(url));
        if (!route) throw new Error(`No route ${method} ${url}`);
        const params = {}; url.match(route.rx).slice(1).forEach((v, i) => { params[route.keys[i]] = v; });
        const req = { method, path: url, user, body, query, params };
        const out = { code: 200, body: undefined, sent: false };
        const res = { status(c) { out.code = c; return res; }, json(b) { out.body = b; out.sent = true; return res; } };
        for (const h of route.handlers) {
            let advanced = false;
            await h(req, res, () => { advanced = true; });
            if (out.sent || !advanced) break;
        }
        return out;
    };
    return app;
}

module.exports = { makeModel, makeApp, mongoose, newId, matches };
