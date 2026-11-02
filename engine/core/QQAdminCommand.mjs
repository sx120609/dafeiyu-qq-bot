import {count, graphemes} from '../swift.mjs';
import {deepEqual, isASCII, isNumber, isWhitespace, trimmed, trimmedSpaces} from './_support.mjs';
import {QQConfig} from './QQPolicy.mjs';

const heads = ['help', '帮助', '菜单', '命令', 'new', '新话题', '重置', 'reset', 'clear', '清空', '清除记忆',
  'blocklist', '黑名单', 'block', '拉黑', 'unblock', '解除拉黑', '取消拉黑', '解封',
  'memory', '记忆', '你记得什么', 'forget', '忘记', '忘掉']
  .sort((a, b) => count(b) - count(a));

/**
 * Chat commands handled by the program without calling a model. Associated-value enum, as {case, _0?}:
 * help, newTopic (forget the short-term context of this conversation), clear (newTopic plus this conversation's
 * long-term memory), block(_0), unblock(_0), blocklist, memories (what the bot remembers about the sender in this
 * conversation, with dates), forget(_0) (forget the sender's memories in this conversation that contain the
 * keyword), invalid(_0).
 * Swift has both `case help` and `static func help(admin:group:)`: QQAdminCommand.help() is the case and
 * QQAdminCommand.help(admin, group) the help text.
 */
export class QQAdminCommand {
  static help(admin, group) {
    if (admin === undefined && group === undefined) return {case: 'help'};
    const lines = ['可用命令（不调用模型）：', '/new 开个新话题，忘掉刚才聊的', '/clear 新话题，并清空这个会话的长期记忆', '/model 问我现在用的模型', '/persona 查看或切换性格',
      '/记忆 看看我记得你什么', '/忘记 关键词 删掉我记的关于你的某件事'];
    if (group && !admin) { lines[1] += '（群里仅管理员）'; lines[2] += '（群里仅管理员）'; }
    if (admin) lines.push('/拉黑 QQ号 拉黑后完全不回复此人', '/解除拉黑 QQ号', '/黑名单 查看已拉黑的 QQ');
    return lines.join('\n');
  }
  static newTopic() { return {case: 'newTopic'}; }
  static clear() { return {case: 'clear'}; }
  static block(id) { return {case: 'block', _0: id}; }
  static unblock(id) { return {case: 'unblock', _0: id}; }
  static blocklist() { return {case: 'blocklist'}; }
  static memories() { return {case: 'memories'}; }
  static forget(keyword) { return {case: 'forget', _0: keyword}; }
  static invalid(message) { return {case: 'invalid', _0: message}; }
  static equals(a, b) { return deepEqual(a, b); }

  static parse(text, mentioned = []) {
    const value = trimmed(text);
    if (!value.startsWith('/') || value.includes('\n') || !(count(value) <= 60)) return undefined;
    const body = graphemes(value).slice(1).join(''), lowered = body.toLowerCase();
    // Chinese commands may run straight into their argument ("/拉黑123456"); English ones need a space.
    const head = heads.find(head => {
      if (!lowered.startsWith(head)) return false;
      const next = graphemes(lowered).slice(count(head))[0];
      if (next === undefined) return true;
      // "/忘记生日" reads naturally without a space.
      return isWhitespace(next) || (!isASCII(graphemes(head)[0]) && (isNumber(next) || next === '@' || ['忘记', '忘掉'].includes(head)));
    });
    if (head === undefined) return undefined;
    const argument = trimmedSpaces(graphemes(body).slice(count(head)).join(''));
    switch (head) {
      case 'help': case '帮助': case '菜单': case '命令': return QQAdminCommand.help();
      case 'new': case '新话题': case '重置': case 'reset': return argument === '' ? QQAdminCommand.newTopic() : QQAdminCommand.invalid('/new 不需要参数');
      case 'clear': case '清空': case '清除记忆': return argument === '' ? QQAdminCommand.clear() : QQAdminCommand.invalid('/clear 不需要参数');
      case 'blocklist': case '黑名单': return QQAdminCommand.blocklist();
      case 'memory': case '记忆': case '你记得什么': return QQAdminCommand.memories();
      case 'forget': case '忘记': case '忘掉':
        if (argument === '' || !(count(argument) <= 30)) return QQAdminCommand.invalid('用法：/忘记 关键词（先用 /记忆 看看记了什么）');
        return QQAdminCommand.forget(argument);
      case 'block': case '拉黑': case 'unblock': case '解除拉黑': case '取消拉黑': case '解封': {
        const unblock = ['unblock', '解除拉黑', '取消拉黑', '解封'].includes(head);
        const characters = graphemes(argument), digits = characters.filter(isNumber).join('');
        // In a group, "/拉黑 @someone" carries the number as a mention instead of text.
        const number = digits !== '' && count(digits) === characters.length ? digits
          : (argument === '' || argument.startsWith('@') ? mentioned[0] ?? '' : '');
        if (!QQConfig.validID(number)) {
          const word = unblock ? '解除拉黑' : '拉黑';
          return QQAdminCommand.invalid(`用法：/${word} QQ号，或在群里 /${word} @某人`);
        }
        return unblock ? QQAdminCommand.unblock(number) : QQAdminCommand.block(number);
      }
      default: return undefined;
    }
  }

  /**
   * Group chats share context, so resetting it there is an admin action.
   * In private chats the friend may reset their own conversation.
   */
  static requiresAdmin(command, group) {
    switch (command.case) {
      // Anyone may see and remove what is remembered about themselves.
      case 'help': case 'invalid': case 'memories': case 'forget': return false;
      case 'newTopic': case 'clear': return group;
      case 'block': case 'unblock': case 'blocklist': return true;
    }
  }
}
