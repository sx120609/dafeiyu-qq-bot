import {count, prefix} from '../swift.mjs';
import {asNSNumber, asObject, asString, trimmed} from './_support.mjs';
import {QQMemoryBook} from './QQMemoryBook.mjs';
import {QQConfig, QQPolicy} from './QQPolicy.mjs';

/**
 * QQ group notices (精华, 撤回, 禁言, 管理员, 进群退群) as one line of the group timeline, so the model
 * knows who did what instead of guessing it from the messages around it.
 */
export class QQGroupNotice {
  /** `name` gives a member's group card when it is known; `quote` the text of a recent message by ID. */
  static describe(object, selfID, key, name = () => undefined, quote = () => undefined) {
    if (asString(object.post_type) !== 'notice') return undefined;
    const who = value => {
      const id = QQPolicy.identifier(value);
      if (id === undefined || id === '0' || !QQConfig.validID(id)) return undefined;
      if (id === selfID) return '本账号（大肥鱼）';
      const label = QQMemoryBook.subject(selfID, key, id);
      const card = name(id);
      return card === undefined || card === null ? label : `${label}（${card}）`;
    };
    const message = value => {
      const id = QQPolicy.identifier(value);
      const quoted = id === undefined ? undefined : quote(id);
      const text = typeof quoted === 'string' ? trimmed(quoted) : undefined;
      if (text === undefined || text === '') return '一条消息';
      return '消息「' + prefix(text, 40) + (count(text) > 40 ? '…' : '') + '」';
    };
    const sub = asString(object.sub_type);
    switch (asString(object.notice_type)) {
      case 'essence': {
        const sender = who(object.sender_id);
        if (sender === undefined) return undefined;
        const operatorName = who(object.operator_id) ?? '管理员';
        return sub === 'delete' ? `${operatorName} 取消了 ${sender} 的${message(object.message_id)}的精华`
          : `${operatorName} 把 ${sender} 的${message(object.message_id)}设为了精华`;
      }
      case 'group_recall': {
        // What was recalled is not repeated: the sender chose to take it back.
        const sender = who(object.user_id);
        if (sender === undefined) return undefined;
        const operatorName = who(object.operator_id);
        return operatorName === undefined || operatorName === sender ? `${sender} 撤回了一条消息` : `${operatorName} 撤回了 ${sender} 的一条消息`;
      }
      case 'group_admin': {
        const user = who(object.user_id);
        if (user === undefined) return undefined;
        return sub === 'unset' ? `${user} 被取消了管理员` : `${user} 被设为管理员`;
      }
      case 'group_ban': {
        const operatorName = who(object.operator_id) ?? '管理员';
        const user = who(object.user_id);
        if (user === undefined) return sub === 'lift_ban' ? `${operatorName} 解除了全员禁言` : `${operatorName} 开启了全员禁言`;
        if (sub === 'lift_ban') return `${operatorName} 解除了 ${user} 的禁言`;
        const seconds = asNSNumber(object.duration) ?? 0;
        const span = seconds >= 86400 ? `${Math.round(seconds / 86400)} 天` : seconds >= 3600 ? `${Math.round(seconds / 3600)} 小时`
          : seconds > 0 ? `${Math.max(1, Math.round(seconds / 60))} 分钟` : '';
        return `${operatorName} 禁言了 ${user}` + (span === '' ? '' : ' ' + span);
      }
      case 'group_increase': {
        const user = who(object.user_id);
        if (user === undefined) return undefined;
        return `${user} 进群了`;
      }
      case 'group_decrease': {
        if (sub === 'kick_me') return undefined;
        const user = who(object.user_id);
        if (user === undefined) return undefined;
        return sub === 'kick' ? `${user} 被移出了群` : `${user} 退群了`;
      }
      case 'group_upload': {
        // A file put into the group: read_file opens it by its file id.
        const user = who(object.user_id) ?? '有人';
        const file = asObject(object.file) ?? {};
        const name = asString(file.name), id = QQPolicy.identifier(file.id);
        const size = QQPolicy.size(file.size);
        return `${user} 上传了群文件「${prefix(name ?? '文件', 60)}」` + (size === undefined ? '' : `（${size}）`) +
          (id === undefined ? '' : `，要读用 read_file，file_id 填 ${id}`);
      }
      case 'group_card': {
        const user = who(object.user_id);
        const card = asString(object.card_new);
        if (user === undefined || card === undefined) return undefined;
        return trimmed(card) === '' ? `${user} 清空了群名片` : `${user} 把群名片改成了「${prefix(card, 30)}」`;
      }
      case 'notify': {
        if (sub === 'title') {
          const user = who(object.user_id), title = asString(object.title);
          return user === undefined || title === undefined ? undefined : `${user} 获得了头衔「${prefix(title, 30)}」`;
        }
        if (sub === 'group_name') {
          const name = asString(object.name_new);
          return name === undefined ? undefined : `${who(object.user_id) ?? '有人'} 把群名改成了「${prefix(name, 40)}」`;
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }
}
