// 密钥加密存储：Windows 上用 DPAPI（当前用户），其他平台退化为本机 AES-256-GCM。
// 敏感项只放 data/secrets.bin，不放 config.json。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, ensureDirs, log } from './util.js';

const SECRETS_FILE = path.join(DATA_DIR, 'secrets.bin');
const KEY_FILE = path.join(DATA_DIR, '.secret-key');

function ps(script, input) {
  const wrapped = "Add-Type -AssemblyName System.Security; " + script;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wrapped], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'powershell 失败').slice(0, 200));
  return String(r.stdout || '').trim();
}

function dpapiAvailable() {
  if (process.platform !== 'win32') return false;
  try {
    ps("Add-Type -AssemblyName System.Security; [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('x'),$null,'CurrentUser') | Out-Null; 'ok'");
    return true;
  } catch {
    return false;
  }
}

const DPAPI = dpapiAvailable();

function fallbackKey() {
  ensureDirs();
  if (fs.existsSync(KEY_FILE)) return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  return key;
}

function encrypt(text) {
  if (DPAPI) {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    return (
      'dpapi:' +
      ps(
        `$in=[Convert]::FromBase64String('${b64}'); $out=[Security.Cryptography.ProtectedData]::Protect($in,$null,'CurrentUser'); [Convert]::ToBase64String($out)`,
      )
    );
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fallbackKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `aes:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(blob) {
  if (blob.startsWith('dpapi:')) {
    const b64 = blob.slice(6);
    const out = ps(
      `$in=[Convert]::FromBase64String('${b64}'); $out=[Security.Cryptography.ProtectedData]::Unprotect($in,$null,'CurrentUser'); [Text.Encoding]::UTF8.GetString($out)`,
    );
    return out;
  }
  const [, iv, tag, data] = blob.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', fallbackKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

let cache = null;

/** 读全部密钥：{ providers: {id: key}, updateToken, channels: {} } */
export function readSecrets() {
  if (cache) return cache;
  try {
    if (!fs.existsSync(SECRETS_FILE)) return (cache = { providers: {}, updateToken: '', channels: {} });
    const blob = fs.readFileSync(SECRETS_FILE, 'utf8').trim();
    if (!blob) return (cache = { providers: {}, updateToken: '', channels: {} });
    const obj = JSON.parse(decrypt(blob));
    cache = { providers: obj.providers || {}, updateToken: obj.updateToken || '', channels: obj.channels || {} };
    return cache;
  } catch (e) {
    log('secrets', '读取密钥失败：' + (e?.message || e));
    return (cache = { providers: {}, updateToken: '', channels: {} });
  }
}

export function writeSecrets(obj) {
  ensureDirs();
  cache = { providers: obj.providers || {}, updateToken: obj.updateToken || '', channels: obj.channels || {} };
  const blob = encrypt(JSON.stringify(cache));
  fs.writeFileSync(SECRETS_FILE, blob, { mode: 0o600 });
  return cache;
}

export function secretsMode() {
  return DPAPI ? 'dpapi' : 'aes';
}


