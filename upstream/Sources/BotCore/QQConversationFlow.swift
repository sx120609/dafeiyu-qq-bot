import Foundation

/// Local per-peer loop detection. Ordinary bursts and other members are not globally throttled.
public struct QQConversationFlow {
    struct Peer {
        var lastIncoming = ""
        var lastOutgoing = ""
        var sentAt: TimeInterval = 0
        var sentID = ""
        var repeated = 0
        var automated = 0
        var implicitReplies = 0
        var quietUntil: TimeInterval = 0
    }
    private var peers: [String: Peer] = [:]
    public init() {}
    private func key(_ scope: String, _ sender: String) -> String { scope + "|" + sender }
    private func normalized(_ value: String) -> String {
        value.lowercased().filter { $0.isLetter || $0.isNumber }
    }
    public mutating func shouldSilence(scope: String, sender: String, text: String, now: TimeInterval) -> Bool {
        let id = key(scope, sender)
        var peer = peers[id] ?? Peer()
        let value = normalized(text)
        let echo = value.count >= 6 && (value == normalized(peer.lastIncoming) || value == normalized(peer.lastOutgoing))
        let aiMarker = text.range(of: #"(?i)(作为.{0,8}(AI|人工智能)|我是.{0,12}(机器人|AI助手)|as an ai|how can i assist)"#, options: .regularExpression) != nil
        let rapidLongReply = peer.sentAt > 0 && now - peer.sentAt < 3 && value.count >= 35
        if now - peer.sentAt > 180 { peer.repeated = 0; peer.automated = 0; peer.implicitReplies = 0 }
        peer.repeated = echo ? peer.repeated + 1 : max(0, peer.repeated - 1)
        peer.automated = aiMarker || rapidLongReply ? peer.automated + 1 : max(0, peer.automated - 1)
        peer.lastIncoming = text
        if peer.repeated >= 3 || peer.automated >= 4 { peer.quietUntil = now + 120; peer.repeated = 0; peer.automated = 0 }
        // A distinctly new, non-automated question ends a false positive early.
        if peer.quietUntil > now && !echo && !aiMarker && !rapidLongReply && text.range(of: "为什么|怎么|如何|哪里|what|why|how", options: .caseInsensitive) != nil { peer.quietUntil = 0 }
        peers[id] = peer
        return peer.quietUntil > now
    }
    /// Calling the bot by name anywhere in the message invites a reply, and so does the next message
    /// from someone the bot just answered, without needing particular opening words. The cap on
    /// consecutive implicit replies keeps a back-and-forth from running forever.
    public func naturalInvitation(scope: String, sender: String, text: String, replyTo: String?, names: [String], now: TimeInterval, allowFollowup: Bool = true) -> Bool {
        let named = names.contains { !$0.isEmpty && text.range(of: $0, options: .caseInsensitive) != nil }
        if named || text.trimmingCharacters(in: .whitespacesAndNewlines) == "/model" { return true }
        guard let peer = peers[key(scope, sender)], now - peer.sentAt < 90 else { return false }
        if let replyTo, replyTo == peer.sentID { return true }
        return allowFollowup && peer.implicitReplies < 6
    }
    public mutating func reset(scope: String) {
        peers = peers.filter { !$0.key.hasPrefix(scope + "|") }
    }
    public mutating func sent(scope: String, sender: String, text: String, messageID: String, implicit: Bool, now: TimeInterval) {
        let id = key(scope, sender)
        var peer = peers[id] ?? Peer()
        peer.lastOutgoing = text; peer.sentAt = now; peer.sentID = messageID
        peer.implicitReplies = implicit ? peer.implicitReplies + 1 : 0
        peers[id] = peer
        if peers.count > 500 { peers = peers.filter { now - $0.value.sentAt < 3600 } }
    }
}
