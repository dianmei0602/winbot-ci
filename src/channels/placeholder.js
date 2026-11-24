// 飞书 / 微信：这一期只留接口位与说明。
// 飞书需要企业自建应用（长连接要 App ID/Secret + 事件订阅 + 卡片权限），
// 微信个人号需要 iLink 扫码桥接或手机自动化，两者都不是纯代码能一次落地的。
// 适配器实现里只要调用 channels/core.js 的 handleIncoming，接入面已经齐了。
import { log } from '../util.js';

export class FeishuChannel {
  constructor() {
    this.name = 'feishu';
    this.running = false;
    this.lastError = '';
  }
  configured() {
    return false;
  }
  async start() {
    this.lastError = '未接入：需要在飞书开放平台建自建应用并填 App ID / Secret，再接长连接与卡片回调';
    log('feishu', this.lastError);
    return false;
  }
  async stop() {}
}

export class WeChatChannel {
  constructor() {
    this.name = 'wechat';
    this.running = false;
    this.lastError = '';
  }
  configured() {
    return false;
  }
  async start() {
    this.lastError =
      '未接入：个人微信没有官方机器人接口。可选路线是 iLink/微信小号扫码桥接，或本机微信 Windows 客户端的 UI 自动化（有风控风险，需单独授权）';
    log('wechat', this.lastError);
    return false;
  }
  async stop() {}
}
