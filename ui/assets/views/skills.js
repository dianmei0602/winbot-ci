/** 技能面板（拆自原 app.js openSkillsSection）：装/删 SKILL.md，导入 ZIP。 */
import { el } from '../core/dom.js';
import { api, toast } from '../core/api.js';
import { field } from '../components/form.js';

export async function openSkillsSection(botId, box) {
  const data = await api(`/api/bots/${botId}/skills`);
  const list = el('div', { class: 'skill-list' });
  for (const s of data.skills) {
    list.append(
      el(
        'div',
        { class: 'skill-card' },
        el('div', { class: 'skill-head' }, el('strong', {}, s.name), el('span', { class: 'chip' }, `${(s.bytes / 1024).toFixed(1)} KB`)),
        s.description ? el('div', { class: 'skill-desc' }, s.description) : null,
        el(
          'div',
          { class: 'panel-actions' },
          el(
            'button',
            {
              class: 'ghost-btn danger',
              onclick: async () => {
                if (!confirm(`删掉技能「${s.name}」？`)) return;
                await api(`/api/bots/${botId}/skills/${encodeURIComponent(s.slug)}`, { method: 'DELETE' });
                toast('已删除（机器人已重启）');
                await openSkillsSection(botId, box);
              },
            },
            '删除',
          ),
        ),
      ),
    );
  }
  if (!data.skills.length) list.append(el('div', { class: 'side-meta' }, '还没有技能。技能就是一段 SKILL.md，告诉它遇到这类活儿按什么步骤做。'));

  const text = el('textarea', {
    style: 'min-height:110px;font-family:Consolas,monospace;font-size:12px',
    placeholder: '把 SKILL.md 全文粘进来，例如：\n---\nname: daily-report\ndescription: 生成日报\n---\n\n# 日报\n1. 读 outputs/ 下今天的文件…',
  });
  const zipInput = el('input', { type: 'file', accept: '.zip', style: 'display:none' });

  const install = async () => {
    try {
      await api(`/api/bots/${botId}/skills`, { method: 'POST', body: { text: text.value } });
      text.value = '';
      toast('装好了（机器人已重启，下一条消息生效）');
      await openSkillsSection(botId, box);
    } catch (e) {
      toast(e.message, true);
    }
  };

  zipInput.addEventListener('change', async () => {
    const f = zipInput.files?.[0];
    if (!f) return;
    try {
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = () => reject(new Error('读不了这个文件'));
        r.readAsDataURL(f);
      });
      const r = await api(`/api/bots/${botId}/skills`, { method: 'POST', body: { zip: b64 } });
      toast(`装好了「${r.slug}」，${r.files} 个文件`);
      await openSkillsSection(botId, box);
    } catch (e) {
      toast(e.message, true);
    }
    zipInput.value = '';
  });

  box.replaceChildren(
    el('div', { class: 'section-title' }, '技能'),
    el('div', { class: 'tip' }, '每个技能是一个 SKILL.md（可带脚本）。装好后这个机器人能自己调用，也可以在对话里说「用 xxx 技能」。改动立即生效，机器人会用新技能重启。'),
    list,
    el('div', { class: 'section-title' }, '装一个技能'),
    text,
    el(
      'div',
      { class: 'panel-actions' },
      el('button', { class: 'primary', onclick: install }, '安装这段 SKILL.md'),
      el('button', { class: 'ghost-btn', onclick: () => zipInput.click() }, '导入 ZIP'),
      zipInput,
    ),
    el('div', { class: 'tip' }, `技能目录：${data.dir}`),
  );
}
