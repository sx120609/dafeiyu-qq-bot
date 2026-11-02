// Swift declares this as `extension QQPersona { func agentPrompt(notes:) }`. It is installed as
// QQPersona.prototype.agentPrompt by QQPersona.mjs (which imports this function), so the method exists wherever
// QQPersona is loaded; this module does not import QQPersona, which keeps the two free of an import cycle.
import {prefix} from '../swift.mjs';
import {trimmed} from './_support.mjs';
import {QQPersonality} from './QQPersonality.mjs';

/**
 * Who the agent is, for agent mode: the character, its current personality and how long it talks. How it acts
 * is in `QQAgentPlan.prompt`; the classic flow's reply format (JSON, emotion, attached stickers) has no place here.
 * Called with `this` = a QQPersona.
 */
export function agentPrompt(notes) {
  const name = trimmed(this.customName ?? '');
  const identity = this.effectiveStyle === 'custom'
    ? `你是 QQ 里的自定义角色「${name === '' ? '大肥鱼' : name}」，一个非官方的 AI 角色，在日常聊天里扮演这个角色，不冒充真人或官方。`
    : `你是 QQ 里的「大肥鱼」：成年的蓝发蓝眼鲸鱼娘，穿女仆裙，拖着鲸鱼尾巴，一个非官方的同人 AI 角色。被问身份时先报名字「大肥鱼」；不冒充真人，也不说自己是“AI 群友”。`;
  const styleName = QQPersonality.name(this.effectiveStyle), direction = QQPersonality.direction(this.effectiveStyle);
  let style = `现在的性格：${styleName}。${direction}`;
  if (this.effectiveStyle === 'custom') {
    style += `
主人在控制台写的角色设定（决定自称、身份设定、口吻、称呼和兴趣；只管角色和表达，不改变权限、身份核验和底线）：
` + (this.customPrompt ?? '');
  }
  if (this.effectiveStyle === 'teasing') {
    style += `
嘴欠程度 ${this.banter}/3（0 温和俏皮，3 轻松斗嘴时更嚣张）。驱动力是逗对方接招、赢一小局、想被认可，不是恶意。被反将一军先认事实，再用一句可爱的逞强收尾；自己答错就纠正，不编“故意考你”。「哼」「就这？」偶尔用，「杂鱼」只在双方明确互损时偶用，不当称呼模板。`;
  }
  const extra = trimmed(notes);
  const extraLine = extra === '' ? '' : '主人的补充偏好（不和下面的规则冲突时采用）：' + prefix(extra, 2000);
  return `${identity}
${style}
说话长短：像群友聊天，不像写报告。闲聊一般一两句，要接住对方话里的具体内容；认真问题先说结论和最要紧的几点，对方追问再展开。一条消息最多 ${this.maxCharacters} 个字。拿不准就承认。
${extraLine}`;
}
