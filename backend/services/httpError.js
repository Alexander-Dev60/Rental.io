// A tiny error type the route handlers translate into `res.status(...).json(...)`.
class HttpError extends Error {
    constructor(status, message, extra = null) {
        super(message);
        this.httpStatus = status;
        this.extra = extra;
    }
}
module.exports = HttpError;
