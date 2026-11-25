// 从本机 DSH 的登录态里取 DeepSeek 账号令牌。
// 优点：用户不用再填一次 Key；令牌轮换时重新读一次即可（进程懒启动，每次拉起都会重新读）。
// 只在本机读，不打印、不写进任何日志。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CRED_FILE = path.join(os.homedir(), '.dsh', '.credentials.yaml');

/** 极简解析：.credentials.yaml 里 deepseek-account-platform/default 下的 token */
export function readDshDeepSeekToken() {
  let text;
  try {
    text = fs.readFileSync(CRED_FILE, 'utf8');
  } catch {
    return null;
  }
  let inDefault = false;
  let token = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s{2}deepseek-account-platform\/default:/.test(line)) inDefault = true;
    else if (/^\s{2}\S/.test(line)) inDefault = false;
    if (!inDefault) continue;
    const m = line.match(/^\s+token:\s*(\S+)\s*$/);
    if (m) token = m[1];
  }
  return token || null;
}

export function hasDshDeepSeekAccount() {
  return !!readDshDeepSeekToken();
}

/** 每个机器人有独立的 DSH_HOME：拉起子进程前，把本机登录态带一份过去（账号服务只读自己的 home）。 */
export function syncDshCredentials(dshHome) {
  const source = CRED_FILE;
  if (!fs.existsSync(source)) return false;
  const target = path.join(dshHome, '.credentials.yaml');
  try {
    fs.mkdirSync(dshHome, { recursive: true });
    fs.copyFileSync(source, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* Windows 上不一定支持 */
    }
    return true;
  } catch {
    return false;
  }
}

export const DSH_ACCOUNT_PROVIDER_ID = 'deepseek-account';

/** 这个接口是不是「用本机 DSH 登录态」的那种 */
export function isDshAccountProvider(p) {
  return !!p && (p.authFromDsh === true || p.id === DSH_ACCOUNT_PROVIDER_ID);
}
