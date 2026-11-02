import {count} from '../swift.mjs';
import {ICU_DOT, trimmed} from './_support.mjs';

const dot = ICU_DOT;
const notAboutSelf = /推荐|比较|对比|训练|微调|部署|recommend|compare/u;
const english = new RegExp(`(what|which)${dot}{0,20}model${dot}{0,20}(you|using)|your${dot}{0,10}model`, 'u');
const selfReference = /你|您|大肥鱼|机器人|当前|现在|底层|用的/u;
const modelQuestion = new RegExp(`(什么|哪个|哪款|啥|具体|底层|型号|版本)${dot}{0,12}(模型|model)|(模型|model)${dot}{0,12}(什么|哪个|哪款|啥|型号|版本)`, 'u');

export class QQModelIdentity {
  static isQuestion(text) {
    const value = trimmed(text).toLowerCase();
    if (value === '/model' || value === '/模型') return true;
    if (!(count(value) <= 180)) return false;
    if (notAboutSelf.test(value)) return false;
    if (english.test(value)) return true;
    return selfReference.test(value) && modelQuestion.test(value);
  }
}
