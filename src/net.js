// 手机 / 局域网访问：给出可用的地址列表（带 token）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './util.js';
import { loadConfig } from './config.js';

function readToken() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'ui-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

export function netInfo() {
  const cfg = loadConfig();
  const port = Number(process.env.WINBOT_PORT || cfg.server?.port || 5178);
  const host = cfg.server?.host || '127.0.0.1';
  const lan = host === '0.0.0.0';
  const token = readToken();
  const urls = [{ label: '这台电脑', url: `http://127.0.0.1:${port}/?token=${token}` }];
  if (lan) {
    for (const a of lanAddresses()) {
      urls.push({ label: `${a.name} · ${a.address}`, url: `http://${a.address}:${port}/?token=${token}` });
    }
  }
  return { host, port, lan, token, urls, interfaces: lanAddresses() };
}
