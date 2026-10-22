'use strict';
/*
 * پیاده‌سازی بسیار سبک و بدون وابستگی خارجی از WebSocket (RFC 6455)
 * فقط برای فریم‌های متنی کوچک (پیام‌های JSON کوتاه push لایسنس) کافی است.
 * دلیل اینکه از پکیج npm استفاده نشده: اسکریپت‌های نصب فعلی هیچ‌وقت
 * npm install اجرا نمی‌کنند (فقط فایل‌ها را کپی و node server.js را اجرا
 * می‌کنند)، پس اضافه کردن وابستگی باعث شکستن نصب می‌شود.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class LiteSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this._buf = Buffer.alloc(0);
    this._closed = false;
    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => { this._closed = true; this.emit('close'); });
    socket.on('error', err => this.emit('error', err));
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    // حلقه برای پردازش چند فریم پشت‌سرهم در یک chunk
    while (true) {
      if (this._buf.length < 2) return;
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this._buf.length < offset + 2) return;
        len = this._buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this._buf.length < offset + 8) return;
        // طول‌های خیلی بزرگ اینجا لازم نیست (پیام‌های ما کوچک‌اند)
        len = Number(this._buf.readBigUInt64BE(offset));
        offset += 8;
      }
      let maskKey = null;
      if (masked) {
        if (this._buf.length < offset + 4) return;
        maskKey = this._buf.slice(offset, offset + 4);
        offset += 4;
      }
      if (this._buf.length < offset + len) return; // منتظر داده‌ی بیشتر
      let payload = this._buf.slice(offset, offset + len);
      if (masked && maskKey) {
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i % 4];
        payload = out;
      }
      this._buf = this._buf.slice(offset + len);

      if (opcode === 0x8) { // close
        try { this.socket.end(); } catch (e) {}
        this._closed = true;
        this.emit('close');
        return;
      } else if (opcode === 0x9) { // ping -> pong
        this._writeFrame(payload, 0xA);
      } else if (opcode === 0x1 || opcode === 0x2) { // text/binary
        this.emit('message', payload);
      }
      // اگر هنوز داده‌ی باقی‌مانده باشد، حلقه ادامه پیدا می‌کند
      if (this._buf.length === 0) return;
    }
  }

  _writeFrame(payload, opcode) {
    if (this._closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) {}
  }

  send(str) {
    this._writeFrame(Buffer.from(String(str), 'utf8'), 0x1);
  }
  close() {
    this._writeFrame(Buffer.alloc(0), 0x8);
    try { this.socket.end(); } catch (e) {}
    this._closed = true;
  }
}

class WebSocketServer extends EventEmitter {
  constructor({ server, path: wsPath }) {
    super();
    this.path = wsPath || '/ws';
    server.on('upgrade', (req, socket, head) => {
      try {
        const u = new URL(req.url, 'http://x');
        if (u.pathname !== this.path) { socket.destroy(); return; }
        const key = req.headers['sec-websocket-key'];
        if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
        const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
        const headers = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '', '',
        ].join('\r\n');
        socket.write(headers);
        if (head && head.length) socket._pendingHead = head;
        const ws = new LiteSocket(socket);
        if (head && head.length) ws._onData(head);
        this.emit('connection', ws, req);
      } catch (e) {
        try { socket.destroy(); } catch (e2) {}
      }
    });
  }
}

module.exports = { WebSocketServer, LiteSocket };
