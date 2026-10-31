import Foundation

/// Monotonic scheduling: AX events coalesce; missing events are covered by bounded idle probes.
public struct ReadSchedule {
    private var lastRead: TimeInterval?
    private var nextProbe: TimeInterval = 0
    private var idleSeconds: TimeInterval = 1
    private var pendingEvent = false
    public init() {}
    public mutating func isDue(now: TimeInterval, event: Bool) -> Bool {
        pendingEvent = pendingEvent || event
        guard let lastRead else { return true }
        return now >= nextProbe || (pendingEvent && now - lastRead >= 1)
    }
    public mutating func didRead(now: TimeInterval, changed: Bool) {
        lastRead = now; pendingEvent = false
        idleSeconds = changed ? 1 : min(8, idleSeconds * 2)
        nextProbe = now + idleSeconds
    }
}

public struct SendLimits: Codable, Equatable, Sendable {
    public var daily = 100
    public var perChatDaily = 30
    public var globalIntervalSeconds = 3
    /// Most messages in any one hour, across all chats (a person does not keep up a steady stream for hours).
    public var hourly: Int?
    public var effectiveHourly: Int { hourly ?? 90 }
    public init() {}
    public func validate() throws {
        guard (1...10000).contains(daily), (1...10000).contains(perChatDaily),
              (1...300).contains(globalIntervalSeconds), (1...1000).contains(effectiveHourly) else { throw CoreError.invalid("发送限额或间隔超出范围") }
    }
}
public enum SendAllowance: Equatable, Sendable { case allowed, globalLimit, chatLimit, cooldown, hourlyLimit }

/// Counts reserved send attempts, including uncertain submissions; never refunds an unknown result.
public struct SendUsage: Codable, Sendable {
    public private(set) var day = ""
    public private(set) var attempts = 0
    public private(set) var confirmed = 0
    public private(set) var uncertain = 0
    public private(set) var byChat: [String: Int] = [:]
    private var pending: Set<UUID> = []
    private var lastGlobal: Date?
    private var lastByChat: [String: Date] = [:]
    /// Sends of the last hour (seconds since 1970) and the jitter drawn for the next gap.
    private var recent: [Double]?
    private var jitter: Double?
    public init() {}
    /// Sends in the last `seconds`.
    public func sent(within seconds: Double, now: Date = Date()) -> Int { (recent ?? []).filter { now.timeIntervalSince1970 - $0 < seconds }.count }
    /// The gap before the next message: the configured interval, longer when the last ten minutes were busy, up to
    /// half a minute. QQ's risk control watches for a steady machine rhythm (11-01: kicked again after a busy night).
    public static func pacedGap(base: Int, lastTenMinutes: Int) -> Double { min(30, Double(base) * (1 + Double(max(0, lastTenMinutes - 8)) / 4)) }
    public mutating func rollover(now: Date = Date(), calendar: Calendar = .current) {
        let c = calendar.dateComponents([.year, .month, .day], from: now)
        let today = "\(c.year!)-\(c.month!)-\(c.day!)"
        if day != today { day = today; attempts = 0; confirmed = 0; uncertain = 0; byChat = [:]; pending = [] }
    }
    public mutating func allowance(chat: UUID, limits: SendLimits, chatCooldown: Int, now: Date = Date()) -> SendAllowance {
        rollover(now: now)
        if attempts >= limits.daily { return .globalLimit }
        if byChat[chat.uuidString, default: 0] >= limits.perChatDaily { return .chatLimit }
        if sent(within: 3600, now: now) >= limits.effectiveHourly { return .hourlyLimit }
        let gap = Self.pacedGap(base: limits.globalIntervalSeconds, lastTenMinutes: sent(within: 600, now: now)) + (jitter ?? 0)
        if let lastGlobal, now.timeIntervalSince(lastGlobal) < gap { return .cooldown }
        if let last = lastByChat[chat.uuidString], now.timeIntervalSince(last) < Double(chatCooldown) { return .cooldown }
        return .allowed
    }
    public mutating func reserve(chat: UUID, limits: SendLimits, chatCooldown: Int, now: Date = Date()) throws -> UUID {
        guard allowance(chat: chat, limits: limits, chatCooldown: chatCooldown, now: now) == .allowed else {
            throw CoreError.invalid("发送额度或冷却条件不满足，未提交发送")
        }
        let ticket = UUID(); attempts += 1; byChat[chat.uuidString, default: 0] += 1
        lastGlobal = now; lastByChat[chat.uuidString] = now; pending.insert(ticket)
        recent = (recent ?? []).filter { now.timeIntervalSince1970 - $0 < 3600 } + [now.timeIntervalSince1970]
        // A one-second interval is a burst or test setting; human-scale intervals get a little randomness.
        jitter = limits.globalIntervalSeconds >= 2 ? Double.random(in: 0...2) : 0
        return ticket
    }
    public mutating func finish(_ ticket: UUID, confirmed: Bool, now: Date = Date()) {
        rollover(now: now)
        guard pending.remove(ticket) != nil else { return }
        if confirmed { self.confirmed += 1 } else { uncertain += 1 }
    }
    /// QQ refused the message (muted, for example): nothing went out, so it is neither confirmed nor
    /// uncertain. The attempt still counts toward the limits.
    public mutating func refused(_ ticket: UUID, now: Date = Date()) {
        rollover(now: now); pending.remove(ticket)
    }
    public mutating func recoverInterrupted(now: Date = Date()) {
        rollover(now: now); uncertain += pending.count; pending = []
    }
}
