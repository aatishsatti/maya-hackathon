// Minimal WebSocket server side (RFC 6455), no dependencies. Used only for the
// browser <-> Maya call socket. Supports text, binary, ping/pong, close, and
// fragmented messages. Server frames are never masked; client frames must be.
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024;

function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const hash = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`);
  socket.setNoDelay(true);

  const ws = { onmessage: null, onclose: null, closed: false };
  let buf = Buffer.alloc(0);
  let frag = null; // { opcode, parts, size }

  function frame(opcode, payload) {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n])
      : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    return Buffer.concat([head, payload]);
  }
  ws.send = (data) => {
    if (ws.closed) return;
    const isText = typeof data === 'string';
    const body = isText ? Buffer.from(data) : Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    socket.write(frame(isText ? 1 : 2, body));
  };
  ws.close = (code = 1000) => {
    if (ws.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    try { socket.write(frame(8, p)); } catch { /* socket gone */ }
    finish();
    socket.end();
  };
  function finish() {
    if (ws.closed) return;
    ws.closed = true;
    if (ws.onclose) ws.onclose();
  }

  function onFrame(fin, opcode, payload) {
    if (opcode === 8) { ws.close(1000); return; }
    if (opcode === 9) { socket.write(frame(10, payload)); return; }
    if (opcode === 10) return;
    if (opcode === 0) {
      if (!frag) return;
      frag.parts.push(payload); frag.size += payload.length;
      if (frag.size > MAX_MESSAGE) { ws.close(1009); return; }
      if (!fin) return;
      payload = Buffer.concat(frag.parts); opcode = frag.opcode; frag = null;
    } else if (!fin) {
      frag = { opcode, parts: [payload], size: payload.length };
      return;
    }
    if (ws.onmessage) ws.onmessage(opcode === 1 ? payload.toString('utf8') : payload, opcode === 2);
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > MAX_MESSAGE) { ws.close(1002); return; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      onFrame(fin, opcode, payload);
      if (ws.closed) return;
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  return ws;
}

module.exports = { accept };
