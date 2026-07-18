'use strict';

// A self-contained stub for Node's `https.request` so tests never touch the
// network. `lib/slack.js` does `const https = require('https')` and later calls
// `https.request(...)` on that same module object, so replacing `.request` on
// the shared module (via node:test's `mock.method`) is enough to intercept every
// outbound call. This helper builds a drop-in replacement that:
//   - records the request options + the form/JSON body written to it, and
//   - replays a canned HTTP response (status + body) back through the callback,
//     or emits a connection error, exactly like the real client would.

const { EventEmitter } = require('events');

// Build a fake `https.request`. `responder(options, body)` returns either
//   { statusCode, body }        -> replayed as an HTTP response, or
//   { error: new Error('...') } -> emitted as a request 'error' event.
// `calls` accumulates { options, body } for assertions.
function makeFakeHttps(responder) {
  const calls = [];

  function request(options, cb) {
    const req = new EventEmitter();
    let body = '';

    req.write = (chunk) => { body += chunk == null ? '' : String(chunk); return true; };
    req.setHeader = () => {};
    req.end = () => {
      // Resolve on a later tick so callers can attach their 'error' handler and
      // response listeners first — matching real async I/O ordering.
      setImmediate(() => {
        const record = { options, body };
        calls.push(record);
        let result;
        try {
          result = responder(options, body);
        } catch (e) {
          req.emit('error', e);
          return;
        }
        if (result && result.error) {
          req.emit('error', result.error);
          return;
        }
        const res = new EventEmitter();
        res.statusCode = (result && result.statusCode) || 200;
        cb(res);
        setImmediate(() => {
          const payload = result && result.body != null ? String(result.body) : '';
          if (payload) res.emit('data', Buffer.from(payload, 'utf8'));
          res.emit('end');
        });
      });
      return req;
    };

    return req;
  }

  return { request, calls };
}

module.exports = { makeFakeHttps };
