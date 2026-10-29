import Foundation

/// Settings for starting private conversations: after a quiet spell the bot may send one message
/// that follows up on something it remembers, or a light greeting. Off by default.
public struct QQOutreachConfig: Codable, Equatable, Sendable {
    public var enabled = false
    /// Quiet time with this friend before the bot considers writing first.
    public var idleMinutes = 24 * 60
    /// Minimum time between two messages the bot starts with the same friend.
    public var cooldownMinutes = 48 * 60
    /// No outreach from quietStartHour until quietEndHour (local time in `timeZone`).
    public var quietStartHour = 23
    public var quietEndHour = 9
    public var timeZone = "Asia/Shanghai"
    /// Private chats (target keys) left out even when outreach is on.
    public var excluded: [String] = []
    public init() {}
    public func validate() throws {
        guard (1...43200).contains(idleMinutes), (1...43200).contains(cooldownMinutes),
              (0...23).contains(quietStartHour), (0...23).contains(quietEndHour),
              TimeZone(identifier: timeZone) != nil, excluded.count <= 50 else {
            throw CoreError.invalid("主动聊天：间隔 1 分钟到 30 天，免打扰时段 0–23 点，时区必须有效")
        }
    }
    public func quiet(at date: Date) -> Bool {
        QQQuietHours.within(date, start: quietStartHour, end: quietEndHour, timeZone: timeZone)
    }
}

/// Hours in which the bot keeps to itself in groups: no joining conversations and no emoji reactions
/// unprompted. Direct @ mentions, replies to it and commands are answered as usual.
public struct QQQuietHours: Codable, Equatable, Sendable {
    /// Off until the owner turns it on, so behaviour (and the test suite) does not depend on the clock.
    public var enabled = false
    public var startHour = 2
    public var endHour = 8
    public var timeZone = "Asia/Shanghai"
    public init() {}
    public func validate() throws {
        guard (0...23).contains(startHour), (0...23).contains(endHour), TimeZone(identifier: timeZone) != nil else {
            throw CoreError.invalid("安静时段的小时数或时区无效")
        }
    }
    public func quiet(at date: Date) -> Bool { enabled && Self.within(date, start: startHour, end: endHour, timeZone: timeZone) }
    static func within(_ date: Date, start: Int, end: Int, timeZone: String) -> Bool {
        guard start != end, let zone = TimeZone(identifier: timeZone) else { return false }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        let hour = calendar.component(.hour, from: date)
        return start < end ? (start..<end).contains(hour) : hour >= start || hour < end
    }
}

/// What the bot remembers about each private chat's rhythm. Persisted with the engine state.
public struct QQOutreachLedger: Codable, Equatable, Sendable {
    /// Last time the friend wrote (or the first time the chat was observed, which starts the clock).
    public var lastIncoming: [String: Double] = [:]
    public var lastSent: [String: Double] = [:]
    /// Chats where the bot wrote first and the friend has not answered yet.
    public var awaitingReply: [String] = []
    /// Last time the model was asked; a decision not to write is respected for a while.
    public var lastConsidered: [String: Double] = [:]
    public init() {}
    public mutating func considered(_ key: String, at time: Double) { lastConsidered[key] = time }
    public mutating func observe(_ key: String, now: Double) { if lastIncoming[key] == nil { lastIncoming[key] = now } }
    public mutating func incoming(_ key: String, at time: Double) {
        lastIncoming[key] = max(lastIncoming[key] ?? 0, time)
        awaitingReply.removeAll { $0 == key }
    }
    public mutating func sent(_ key: String, at time: Double) {
        lastSent[key] = time
        if !awaitingReply.contains(key) { awaitingReply.append(key) }
    }
    /// Due when the chat has been quiet long enough, the cooldown has passed, it is not quiet hours,
    /// and the last message the bot started was answered. One unanswered message is the limit.
    public func due(_ key: String, now: Double, config: QQOutreachConfig) -> Bool {
        guard config.enabled, !config.excluded.contains(key), !awaitingReply.contains(key),
              let incoming = lastIncoming[key] else { return false }
        let lastActivity = max(incoming, lastSent[key] ?? 0)
        // After a "not now" the chat is reconsidered at most every six hours (or the cooldown, if shorter).
        let retry = Double(min(config.cooldownMinutes, 360) * 60)
        guard now - lastActivity >= Double(config.idleMinutes * 60),
              now - (lastSent[key] ?? 0) >= Double(config.cooldownMinutes * 60),
              now - (lastConsidered[key] ?? 0) >= retry else { return false }
        return !config.quiet(at: Date(timeIntervalSince1970: now))
    }

    /// Instructions for the model when it considers writing first. It may decline.
    public static func prompt(idleHours: Int) -> String {
        """
        现在不是在回复消息：你在考虑要不要主动给这位好友发一条私聊。你们已经大约 \(idleHours) 小时没聊了。
        下面是你记得的关于 TA 的事和你们最近的聊天。如果有自然的由头就发，比如之前提到的考试、面试、答辩、生病、出行、搬家、在追的番或游戏、说过要做的事，可以问问后来怎么样了；也可以是轻松的问候，结合当前时间（早上、饭点、周末、节假日）。没有合适的由头，或者对方上次明显想结束聊天、心情很差需要空间，就不发。
        像熟人随手发来的消息：一两句，最多问一个问题。不要说“好久不见我是 AI”，不要客服腔，不要一次问一串问题，不要编造你们没聊过的事。
        只输出一个 JSON 对象：{"send":true,"text":"要发的内容","emotion":"neutral","intensity":1}。不发就输出 {"send":false,"text":"","emotion":"neutral","intensity":0}。
        """
    }
}
