// Same-origin rules for anything that changes state or opens a stream (chat posts, care posts, the /ws call socket).
// A browser sends the Origin of the page that made the request, and a page on another site cannot fake it. The request is accepted only
// if that Origin is exactly this server's own host over http (local use) or https (hosting, where the page is served over TLS and the
// browser's Origin is https://host). Same host only: no wildcard, no other site, no other port, no other scheme.
const exact = (origin, host) => typeof origin === 'string' && typeof host === 'string' && host.length > 0 && (origin === `http://${host}` || origin === `https://${host}`);

// Normal requests: a request with no Origin at all is not a browser page driving us (a plain tool such as curl), as before.
const sameOrigin = (headers) => !headers.origin || exact(headers.origin, headers.host);
// The call socket: a browser always sends Origin on a WebSocket, so it is required and must match.
const wsOriginOk = (headers) => exact(headers.origin, headers.host);

module.exports = { sameOrigin, wsOriginOk };
