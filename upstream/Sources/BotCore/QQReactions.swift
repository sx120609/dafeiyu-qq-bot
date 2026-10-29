import Foundation

/// Emoji reactions on group members' messages ("贴表情"). IDs are QQ's own: a system face ID
/// (e.g. 147 棒棒糖) or, for emoji-type reactions, the Unicode code point in decimal (128051 🐳).
public struct QQReactionEmoji: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    /// The owner's preference, 0 (never) to 10 (a favourite). The model reads it as a hint, not a dice weight.
    public var weight: Int
    /// When it fits, in a few words, for the model.
    public var hint: String?
    public init(id: String, name: String, weight: Int, hint: String? = nil) { self.id = id; self.name = name; self.weight = weight; self.hint = hint }
}

/// When someone pokes the bot (QQ 戳一戳): poke back, and sometimes say something short.
public struct QQPokeConfig: Codable, Equatable, Sendable {
    public var enabled = false
    /// Chance, in percent, of also saying something after poking back.
    public var replyChance = 50
    /// Pokes from the same person within this many seconds are ignored.
    public var cooldownSeconds = 30
    public init() {}
    public func validate() throws {
        guard (0...100).contains(replyChance), (0...3600).contains(cooldownSeconds) else {
            throw CoreError.invalid("戳一戳：说话概率 0–100%，间隔 0–3600 秒")
        }
    }
    public static let prompt = """
        刚才有人在 QQ 里戳了戳你（双击头像的那种“戳一戳”）。你已经戳回去了，现在顺口回一句很短的话，像被戳时的小反应：可以俏皮、可以假装嫌弃、可以问问对方找你干嘛，结合你们最近聊的事更好。一句话，别长。
        只输出一个 JSON 对象：{"text":"要说的话","emotion":"neutral","intensity":1}
        """
}

/// The bot's small moves in a group ("小动作"): reacting to messages, poking someone, joining a repeat chain.
/// The model decides all of them after reading the recent timeline; nothing here is random.
public struct QQReactionConfig: Codable, Equatable, Sendable {
    public var enabled = false
    /// How lively the bot is, 0–100: the guidance the model gets and how often it looks at a group.
    public var chance = 30
    /// Minimum seconds between two looks at the same group.
    public var cooldownSeconds = 45
    /// The owner's saved preferences; `effectiveEmojis` fills in the rest of the catalogue.
    public var emojis: [QQReactionEmoji] = QQReactionConfig.catalog
    public var pokeEnabled: Bool?
    public var repeatEnabled: Bool?
    public var effectivePokeEnabled: Bool { pokeEnabled ?? true }
    public var effectiveRepeatEnabled: Bool { repeatEnabled ?? true }
    public init() {}

    /// What the bot can react with. The owner's favourites (棒棒糖, 鲸鱼, 问号, 拳头) weigh most.
    public static let catalog = [
        QQReactionEmoji(id: "147", name: "棒棒糖", weight: 5, hint: "夸可爱、给奖励、甜"),
        QQReactionEmoji(id: "128051", name: "鲸鱼", weight: 5, hint: "你自己的招牌：打招呼、认同、卖萌、提到你"),
        QQReactionEmoji(id: "10068", name: "问号", weight: 5, hint: "没看懂、离谱、你在说什么"),
        QQReactionEmoji(id: "120", name: "拳头", weight: 5, hint: "加油、冲、放狠话、开玩笑要揍人"),
        QQReactionEmoji(id: "182", name: "笑哭", weight: 2, hint: "真的好笑"),
        QQReactionEmoji(id: "76", name: "赞", weight: 2, hint: "认同、干得好"),
        QQReactionEmoji(id: "271", name: "吃瓜", weight: 1, hint: "围观八卦、看戏"),
        QQReactionEmoji(id: "124", name: "OK", weight: 1, hint: "收到、可以、没问题"),
        QQReactionEmoji(id: "319", name: "比心", weight: 1, hint: "感谢、示好"),
        QQReactionEmoji(id: "264", name: "捂脸", weight: 2, hint: "尴尬、社死、没眼看"),
        QQReactionEmoji(id: "269", name: "暗中观察", weight: 2, hint: "潜水围观、有人提到你但没叫你"),
        QQReactionEmoji(id: "299", name: "牛啊", weight: 2, hint: "很强、佩服"),
        QQReactionEmoji(id: "320", name: "庆祝", weight: 2, hint: "好消息、成功了、过生日"),
        QQReactionEmoji(id: "285", name: "摸鱼", weight: 2, hint: "上班上课摸鱼、偷懒"),
        QQReactionEmoji(id: "179", name: "doge", weight: 2, hint: "调侃、坏笑、阴阳怪气的玩笑"),
        QQReactionEmoji(id: "106", name: "委屈", weight: 1, hint: "被欺负、可怜巴巴"),
        QQReactionEmoji(id: "8", name: "睡", weight: 1, hint: "困了、晚安、熬夜"),
        QQReactionEmoji(id: "273", name: "我酸了", weight: 1, hint: "羡慕、晒东西"),
        QQReactionEmoji(id: "267", name: "头秃", weight: 1, hint: "作业考试加班太难"),
        QQReactionEmoji(id: "262", name: "脑阔疼", weight: 1, hint: "头疼、麻烦事"),
        QQReactionEmoji(id: "66", name: "爱心", weight: 1, hint: "温暖、喜欢、安慰"),
        QQReactionEmoji(id: "63", name: "玫瑰", weight: 1, hint: "祝福、道歉、送花"),
        QQReactionEmoji(id: "128293", name: "火", weight: 1, hint: "燃、太强了、火了"),
        QQReactionEmoji(id: "128170", name: "肌肉", weight: 1, hint: "加油、练、硬气")
    ]

    /// The catalogue with the owner's saved preferences, followed by any extra IDs the owner added.
    public var effectiveEmojis: [QQReactionEmoji] {
        let saved = Dictionary(emojis.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let listed = Self.catalog.map { item -> QQReactionEmoji in
            var item = item; if let own = saved[item.id] { item.weight = own.weight }; return item
        }
        let known = Set(Self.catalog.map(\.id))
        return listed + emojis.filter { !known.contains($0.id) }
    }

    /// How many times an hour the bot may look at one group.
    public var looksPerHour: Int { chance <= 15 ? 3 : chance <= 40 ? 6 : 12 }
    public var liveliness: String {
        chance <= 15 ? "安静：大多数时候什么都不做，只给特别好笑、特别值得的消息贴一个"
            : chance <= 40 ? "适中：像一个常在线但不刷屏的群友，看到有意思的才贴"
            : "活跃：可以多贴一些，但还是要贴在点上，别每条都贴"
    }

    public func validate() throws {
        guard (0...100).contains(chance), (0...3600).contains(cooldownSeconds), emojis.count <= 60,
              emojis.allSatisfy({ (0...10).contains($0.weight) && (1...7).contains($0.id.count) && $0.id.allSatisfy(\.isNumber) && $0.name.count <= 20 && ($0.hint?.count ?? 0) <= 40 }) else {
            throw CoreError.invalid("群里的小动作：活跃度 0–100，间隔 0–3600 秒，最多 60 个表情，偏好 0–10")
        }
    }
}

/// What the model decided to do in a group this time. Anything it names that the program did not offer is dropped.
public struct QQInteractionPlan: Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case react(message: String, emoji: String)
        case poke(member: String)
        case repeatMessage(message: String)
    }
    public var actions: [Action]
    public var why: String

    public static func decode(_ text: String, candidates: Set<String>, repeatable: Set<String>, members: Set<String>, emojis: Set<String>) -> QQInteractionPlan {
        guard let data = text.data(using: .utf8), data.count <= 8000,
              let fields = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return QQInteractionPlan(actions: [], why: "") }
        let why = String(((fields["why"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        var actions: [Action] = [], reacted = Set<String>(), poked = false, repeated = false
        for item in (fields["actions"] as? [[String: Any]] ?? []).prefix(8) {
            let message = (item["message"] as? String) ?? (item["message"] as? NSNumber)?.stringValue ?? ""
            switch item["type"] as? String {
            case "react":
                let emoji = (item["emoji"] as? String) ?? (item["emoji"] as? NSNumber)?.stringValue ?? ""
                guard reacted.count < 3, candidates.contains(message), emojis.contains(emoji), !reacted.contains(message) else { continue }
                reacted.insert(message); actions.append(.react(message: message, emoji: emoji))
            case "poke":
                guard !poked, let member = item["member"] as? String, members.contains(member) else { continue }
                poked = true; actions.append(.poke(member: member))
            case "repeat":
                guard !repeated, repeatable.contains(message) else { continue }
                repeated = true; actions.append(.repeatMessage(message: message))
            default: continue
            }
        }
        return QQInteractionPlan(actions: actions, why: why)
    }

    /// The latest message, when it ends a run of the same short line from at least two different members the bot
    /// has not joined: the classic QQ 复读 chain.
    public static func repeatable(_ events: [QQMemoryEvent]) -> String? {
        guard let last = events.last, !["BOT", "OWNER", "SYSTEM"].contains(last.subject) else { return nil }
        let text = last.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...20).contains(text.count), !text.contains("（"), !text.contains("["), !text.lowercased().contains("http"), !text.hasPrefix("/") else { return nil }
        var speakers = Set<String>()
        for event in events.reversed() {
            guard event.text.trimmingCharacters(in: .whitespacesAndNewlines) == text else { break }
            if ["BOT", "OWNER"].contains(event.subject) { return nil }
            speakers.insert(event.subject)
        }
        return speakers.count >= 2 ? last.id : nil
    }

    public static let prompt = """
        [QQ_INTERACTIONS] 现在不是让你说话，是决定你在群里顺手做的小动作：像真人刷群时给消息点个表情回应、戳一戳某个人、偶尔跟着大家复读。你只决定做不做、对哪条做什么，不写聊天内容。
        输入是 JSON：群名、当前时间、活跃度、最近的群时间线（每行有 message 编号；new=true 的是这次可以回应的新消息；reactions 是别人已经贴上的表情和人数；botReacted 是你已经贴过的；toBot 表示在跟你说话或提到你；repeatable=true 表示大家正在复读这句）、相关记忆、你最近做过的小动作、可用的表情（id、名字、什么时候用、主人设的偏好 1–10，越高越常用）、这次允许的动作类型。
        怎么做：
        - 先看懂每条新消息在说什么、谁对谁说、群里气氛如何，再决定。贴表情要贴在点上、贴得有意思：好笑的、在说你或叫你的、有人分享好消息成果或图片、别人都在贴的（跟着贴同一个最自然）、在跟你斗嘴的，都可以贴。平淡的打卡、长段严肃讨论、别人吵架、伤心求助（安慰类的爱心之类除外）一般不贴。
        - 一条消息最多一个表情，一次最多贴 3 条，按活跃度来，经常一条都不贴才正常。不要老用同一个表情，也不要盯着同一个人贴；偏好高的表情合适时优先，但不合适就别硬用。
        - 戳一戳：只有真有由头才戳，比如有人提到你却没 @、有人说要去睡了或说要走、有人在念叨你或跟你斗嘴。一次最多戳一个人；你最近戳过的人别再戳。
        - 复读：只能对 repeatable=true 的那条，跟着复读一次；内容不合适（涉政、色情、骂人、广告、刷屏）就不复读。
        - 涉及政治、色情、违法、人身攻击的消息不贴表情、不互动。
        - 什么都不做完全可以，actions 给空数组。
        只输出 JSON：{"actions":[{"type":"react","message":"消息编号","emoji":"表情id"},{"type":"poke","member":"MEMBER_xxx"},{"type":"repeat","message":"消息编号"}],"why":"一句话，告诉主人你为什么这么做或为什么没做"}
        """
}
