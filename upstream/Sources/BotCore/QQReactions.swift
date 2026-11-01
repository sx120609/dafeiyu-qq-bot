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

/// Everything the agent can react with: QQ's own faces (faces.json, loaded into `QQPolicy.faceNames`) and the
/// emoji QQ offers as reactions, picked by name. The owner's favourites come first and keep their hints.
public enum QQReactionCatalog {
    /// QQ's emoji-type reactions, with names to search by.
    public static let emoji: [(id: String, name: String)] = [
        ("9728", "晴天☀"), ("9749", "咖啡☕"), ("9786", "可爱☺"), ("10024", "闪光✨"), ("10060", "错误❌"), ("10068", "问号❓"),
        ("127801", "玫瑰🌹"), ("127817", "西瓜🍉"), ("127822", "苹果🍎"), ("127827", "草莓🍓"), ("127836", "拉面🍜"), ("127838", "面包🍞"),
        ("127847", "刨冰🍧"), ("127866", "啤酒🍺"), ("127867", "干杯🍻"), ("127881", "庆祝🎉"), ("128027", "虫🐛"), ("128046", "牛🐮"),
        ("128051", "鲸鱼🐳"), ("128053", "猴🐵"), ("128074", "拳头👊"), ("128076", "好的👌"), ("128077", "厉害👍"), ("128079", "鼓掌👏"),
        ("128147", "爱心💓"), ("128157", "礼物💝"), ("128164", "睡觉💤"), ("128166", "水💦"), ("128168", "吹气💨"), ("128170", "肌肉💪"),
        ("128293", "火🔥"), ("128513", "呲牙😁"), ("128514", "笑哭😂"), ("128516", "高兴😄"), ("128522", "嘿嘿😊"), ("128524", "羞涩😌"),
        ("128527", "哼哼😏"), ("128530", "不屑😒"), ("128531", "汗😓"), ("128532", "失落😔"), ("128536", "飞吻😘"), ("128538", "亲亲😚"),
        ("128540", "淘气😜"), ("128541", "吐舌😝"), ("128557", "大哭😭"), ("128560", "紧张😰"), ("128563", "瞪眼😳")
    ]

    /// The favourites (weight above 0), then every other face and emoji; ones the owner set to 0 are left out.
    public static func all(favourites: [QQReactionEmoji]) -> [QQReactionEmoji] {
        let never = Set(favourites.filter { $0.weight <= 0 }.map(\.id))
        var seen = never, items: [QQReactionEmoji] = []
        for item in favourites where item.weight > 0 && seen.insert(item.id).inserted { items.append(item) }
        for (id, name) in QQPolicy.faceNames.sorted(by: { (Int($0.key) ?? 0) < (Int($1.key) ?? 0) }) where seen.insert(id).inserted {
            items.append(QQReactionEmoji(id: id, name: name, weight: 0))
        }
        for (id, name) in emoji where seen.insert(id).inserted { items.append(QQReactionEmoji(id: id, name: name, weight: 0)) }
        return items
    }

    /// What the agent wrote (a name, an emoji, or an id) as one of `items`.
    public static func resolve(_ written: String, among items: [QQReactionEmoji]) -> QQReactionEmoji? {
        var text = written.trimmingCharacters(in: .whitespacesAndNewlines)
        for wrapper in ["[", "]", "【", "】", "/", "QQ表情：", "表情："] { text = text.replacingOccurrences(of: wrapper, with: "") }
        text = text.replacingOccurrences(of: "\u{FE0F}", with: "").trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        if let item = items.first(where: { $0.id == text }) { return item }
        let lowered = text.lowercased()
        if let item = items.first(where: { $0.name.lowercased() == lowered }) { return item }
        // An emoji typed as itself: by its code point, or by the name it carries in the list (鲸鱼🐳).
        if text.unicodeScalars.count == 1, let scalar = text.unicodeScalars.first, scalar.value > 1000 {
            if let item = items.first(where: { $0.id == String(scalar.value) || $0.name.hasSuffix(text) }) { return item }
        }
        // The name without the emoji the list adds to it.
        return items.first { item in
            let bare = item.name.unicodeScalars.filter { $0.value < 0x2000 || (0x4E00...0x9FFF).contains($0.value) }
            return String(String.UnicodeScalarView(bare)).lowercased() == lowered
        }
    }

    /// Names that match `query`: whole word first, then those sharing the most characters with it.
    public static func search(_ query: String, among items: [QQReactionEmoji], limit: Int = 20) -> [QQReactionEmoji] {
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace || $0 == "，" || $0 == "," }).map(String.init).filter { !$0.isEmpty }
        guard !words.isEmpty else { return Array(items.prefix(limit)) }
        let scored = items.compactMap { item -> (QQReactionEmoji, Int)? in
            let name = item.name.lowercased(), hint = (item.hint ?? "").lowercased()
            var score = 0
            for word in words {
                if name == word { score += 100 } else if name.contains(word) || word.contains(name) { score += 40 }
                if hint.contains(word) { score += 30 }
                score += Set(word).intersection(Set(name)).count * 5
            }
            return score > 0 ? (item, score + min(item.weight, 10)) : nil
        }
        return scored.sorted { $0.1 > $1.1 }.prefix(limit).map(\.0)
    }
}

/// The owner's favourite reactions ("常用表情"): the agent may react with any QQ face or emoji
/// (QQReactionCatalog), and these come first, with the owner's preference and a hint for when they fit.
public struct QQReactionConfig: Codable, Equatable, Sendable {
    /// The owner's saved preferences; `effectiveEmojis` fills in the rest of the catalogue.
    public var emojis: [QQReactionEmoji] = QQReactionConfig.catalog
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

    public func validate() throws {
        guard emojis.count <= 60,
              emojis.allSatisfy({ (0...10).contains($0.weight) && (1...7).contains($0.id.count) && $0.id.allSatisfy(\.isNumber) && $0.name.count <= 20 && ($0.hint?.count ?? 0) <= 40 }) else {
            throw CoreError.invalid("常用表情：最多 60 个，偏好 0–10")
        }
    }
}
