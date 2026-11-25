// 最小 WebSocket 客户端：Discord Gateway / Slack Socket Mode 用，零依赖。
// 只实现文本帧、分片消息、ping/pong、close；不做扩展协商。
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class MiniWebSocket extends EventEmitter {
  constructor(url, { headers = {}, maxPayload = 64 * 1024 * 1024 } = {}) {
    super();
    this.url = new URL(url);
    this.headers = headers;
    this.maxPayload = maxPayload;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.fragments = [];
    this.fragmentOpcode = 0;
  }

  connect() {
    const isTls = this.url.protocol === 'wss:';
    const lib = isTls ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const req = lib.request({
      hostname: this.url.hostname,
      port: this.url.port || (isTls ? 443 : 80),
      path: `${this.url.pathname}${this.url.search}`,
      method: 'GET',
      // 用数字 IP 作 hostname 时，Node 会把 Host 写成 IP；部分服务端（Chrome CDP）只接受
      // localhost 或 域名。这里统一显式给 Host，避免握手被 403。
      headers: {
        Host: this.url.host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...this.headers,
      },
    });
    req.on('upgrade', (res, socket, head) => {
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        this.emit('error', new Error('WebSocket 握手校验失败'));
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('close', () => this.onClose());
      socket.on('error', (e) => this.emit('error', e));
      if (head?.length) this.onData(head);
      this.emit('open');
    });
    req.on('response', (res) => {
      this.emit('error', new Error(`WebSocket 升级失败：HTTP ${res.statusCode}`));
      req.destroy();
    });
    req.on('error', (e) => this.emit('error', e));
    req.end();
    this.req = req;
    return this;
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(this.maxPayload)) {
          this.emit('error', new Error('WebSocket 帧过大'));
          this.close();
          return;
        }
        len = Number(big);
        offset += 8;
      }
      if (len > this.maxPayload) {
        this.emit('error', new Error('WebSocket 帧过大'));
        this.close();
        return;
      }
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      if (maskKey) {
        const copy = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i += 1) copy[i] = payload[i] ^ maskKey[i % 4];
        payload = copy;
      }
      this.buffer = this.buffer.subarray(offset + len);
      this.handleFrame(fin, opcode, payload);
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this.sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) {
      this.emit('pong');
      return;
    }
    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (!fin) return;
      const full = Buffer.concat(this.fragments);
      const op = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = 0;
      if (op === 0x1) this.emit('message', full.toString('utf8'));
      return;
    }
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      return;
    }
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
  }

  sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return false;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    header[1] |= 0x80;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ mask[i % 4];
    try {
      this.socket.write(Buffer.concat([header, mask, masked]));
      return true;
    } catch {
      return false;
    }
  }

  send(text) {
    return this.sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sendFrame(0x8, Buffer.alloc(0));
      this.socket?.end();
    } catch {
      /* ignore */
    }
    this.emit('close');
  }
}
