'use strict';

const express = require('express');

function asyncHandler(handler) {
    if (Array.isArray(handler)) return handler.map(asyncHandler);
    if (typeof handler !== 'function') return handler;
    if (handler.length === 4) {
        return function handleError(error, req, res, next) {
            try { return Promise.resolve(handler(error, req, res, next)).catch(next); }
            catch (err) { return next(err); }
        };
    }
    return function handleRequest(req, res, next) {
        try { return Promise.resolve(handler(req, res, next)).catch(next); }
        catch (err) { return next(err); }
    };
}

// Express 4 observes synchronous throws but not rejected handler promises.
// Wrap registrations explicitly instead of patching Express internals.
function createAsyncRouter(options) {
    const router = express.Router(options);
    for (const method of ['use', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']) {
        const register = router[method];
        router[method] = function registerHandlers(...args) {
            return register.apply(this, args.map(asyncHandler));
        };
    }
    return router;
}

function apiErrorHandler(error, _req, res, next) {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.parse.failed') {
        return res.status(400).json({ status: 'error', code: 'INVALID_JSON', error: 'Request body must contain valid JSON' });
    }
    if (error?.type === 'entity.too.large') {
        return res.status(413).json({ status: 'error', code: 'BODY_TOO_LARGE', error: 'Request body is too large' });
    }
    if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
        return res.status(503).json({ status: 'error', code: 'DATABASE_BUSY', error: 'Data is temporarily busy. Please retry shortly.' });
    }
    // Provider errors may contain keys, request payloads, or local file paths.
    return res.status(500).json({ status: 'error', code: 'INTERNAL_ERROR', error: 'The request could not be completed. Please try again.' });
}

module.exports = { asyncHandler, createAsyncRouter, apiErrorHandler };
