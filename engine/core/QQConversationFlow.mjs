import {count, graphemes} from '../swift.mjs';
import {deepClone, ICU_DOT, isLetter, isNumber} from './_support.mjs';

class Peer {
  constructor() {
    this.lastIncoming = ''; this.lastOutgoing = ''; this.sentAt = 0; this.sentID = '';
    this.repeated = 0; this.automated = 0; this.implicitReplies = 0; this.quietUntil = 0;
  }
}

const aiMarker = new RegExp(`(作为${ICU_DOT}{0,8}(AI|人工智能)|我是${ICU_DOT}{0,12}(机器人|AI助手)|as an ai|how can i assist)`, 'iu');
// Swift calls range(of:options: .caseInsensitive) without .regularExpression here, so this is a plain,
// case-insensitive search for the whole string, alternation bars included.
const question = '为什么|怎么|如何|哪里|what|why|how';

/** Local per-peer loop detection. Ordinary bursts and other members are not globally throttled. */
export class QQConversationFlow {
  static Peer = Peer;
  constructor() { /** "scope|sender" -> Peer. */ this.peers = new Map(); }
  key(scope, sender) { return scope + '|' + sender; }
  normalized(value) { return graphemes(value.toLowerCase()).filter(c => isLetter(c) || isNumber(c)).join(''); }
  shouldSilence(scope, sender, text, now) {
    const id = this.key(scope, sender);
    const peer = this.peers.get(id) ?? new Peer();
    const value = this.normalized(text);
    const echo = count(value) >= 6 && (value === this.normalized(peer.lastIncoming) || value === this.normalized(peer.lastOutgoing));
    const automatedText = aiMarker.test(text);
    const rapidLongReply = peer.sentAt > 0 && now - peer.sentAt < 3 && count(value) >= 35;
    if (now - peer.sentAt > 180) { peer.repeated = 0; peer.automated = 0; peer.implicitReplies = 0; }
    peer.repeated = echo ? peer.repeated + 1 : Math.max(0, peer.repeated - 1);
    peer.automated = automatedText || rapidLongReply ? peer.automated + 1 : Math.max(0, peer.automated - 1);
    peer.lastIncoming = text;
    if (peer.repeated >= 3 || peer.automated >= 4) { peer.quietUntil = now + 120; peer.repeated = 0; peer.automated = 0; }
    // A distinctly new, non-automated question ends a false positive early.
    if (peer.quietUntil > now && !echo && !automatedText && !rapidLongReply && text.toLowerCase().includes(question)) peer.quietUntil = 0;
    this.peers.set(id, peer);
    return peer.quietUntil > now;
  }
  /**
   * Calling the bot by name anywhere in the message invites a reply, and so does the next message
   * from someone the bot just answered, without needing particular opening words. The cap on
   * consecutive implicit replies keeps a back-and-forth from running forever.
   */
  reset(scope) {
    for (const key of [...this.peers.keys()]) if (key.startsWith(scope + '|')) this.peers.delete(key);
  }
  sent(scope, sender, text, messageID, implicit, now) {
    const id = this.key(scope, sender);
    const peer = this.peers.get(id) ?? new Peer();
    peer.lastOutgoing = text; peer.sentAt = now; peer.sentID = messageID;
    peer.implicitReplies = implicit ? peer.implicitReplies + 1 : 0;
    this.peers.set(id, peer);
    if (this.peers.size > 500) {
      for (const [key, value] of [...this.peers]) if (!(now - value.sentAt < 3600)) this.peers.delete(key);
    }
  }
  clone() { return deepClone(this); }
}
