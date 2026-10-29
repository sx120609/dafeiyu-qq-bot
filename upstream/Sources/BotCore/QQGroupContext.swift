import Foundation

/// One immutable group timeline ending at the admitted trigger, shared by direct and proactive replies.
public struct QQGroupContext: Sendable {
    private let events: [QQMemoryEvent]
    private let messages: [String: QQIncoming]
    private let account: String
    private let anchorID: String
    public let recentImages: [(label: String, images: [QQIncomingImage])]
    /// Images posted earlier in the conversation, shown again when someone talks to the bot so it can
    /// look at what it already commented on instead of doubting its own earlier reply.
    public let followupImages: [(label: String, images: [QQIncomingImage])]
    public let hasUnansweredText: Bool
    public let hasRecentMedia: Bool

    public init?(events: [QQMemoryEvent], through id: String, messages: [String: QQIncoming] = [:], account: String = "") {
        guard let anchor = events.firstIndex(where: { $0.id == id }) else { return nil }
        let end = events[anchor].at
        let ordered = events.prefix(through: anchor).enumerated()
            .filter { $0.element.at <= end }
            .sorted { $0.element.at == $1.element.at ? $0.offset < $1.offset : $0.element.at < $1.element.at }
            .map(\.element)
        var selected: [QQMemoryEvent] = [], previous = end
        for event in ordered.reversed() {
            // Sparse messages must not keep a conversation from an hour ago alive.
            guard end.timeIntervalSince(event.at) <= 30 * 60,
                  previous.timeIntervalSince(event.at) <= 10 * 60, selected.count < 32 else { break }
            selected.append(event); previous = event.at
        }
        self.events = selected.reversed()
        self.messages = messages.filter { key, _ in selected.contains { $0.id == key } }
        self.account = account
        anchorID = id
        // Proactive turns only look at fresh attachments, so an old media topic is not revived.
        recentImages = Self.attachments(selected, messages: self.messages, end: end, within: 180)
        followupImages = Self.attachments(selected.filter { $0.id != id }, messages: self.messages, end: end, within: 15 * 60)
        hasRecentMedia = selected.prefix(3).contains { event in
            event.subject != "BOT" && (messages[event.id]?.images.isEmpty == false ||
                event.text.contains("（对方发来图片或表情包") || event.text.contains("（群成员发送了媒体或卡片"))
        }
        let sinceReply = self.events.lastIndex(where: { $0.subject == "BOT" }).map { $0 + 1 } ?? 0
        hasUnansweredText = self.events.dropFirst(sinceReply).contains { event in
            // A lone QQ face is a reaction, not a topic waiting for an answer.
            !["BOT", "SYSTEM"].contains(event.subject) &&
                !Self.readableText(event.text).replacingOccurrences(of: #"\[QQ表情：[^\]]*\]"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private static func attachments(_ selected: [QQMemoryEvent], messages: [String: QQIncoming], end: Date, within seconds: TimeInterval) -> [(label: String, images: [QQIncomingImage])] {
        var imageCount = 0
        var result: [(label: String, images: [QQIncomingImage])] = []
        for event in selected.prefix(16) where end.timeIntervalSince(event.at) <= seconds && event.subject != "BOT" {
            guard let message = messages[event.id], !message.images.isEmpty, imageCount < 3 else { continue }
            let images = Array(message.images.prefix(3 - imageCount)); imageCount += images.count
            result.append(("群消息 " + event.id + "，发言者 " + event.subject, images))
        }
        return result.reversed()
    }

    /// `attached` names the images that go along with this request, so the timeline can say which
    /// pictures the model is looking at now and which it saw on an earlier turn.
    /// With a `summary` that ends inside this timeline, the lines it covers give way to the summary itself.
    public func context(characters: Int, attached: [(label: String, images: [QQIncomingImage])]? = nil, summary: QQTimelineSummary? = nil) -> String {
        var lines: [String] = [], used = 0
        let formatter = ISO8601DateFormatter()
        let shown = Set((attached ?? recentImages).flatMap { item in events.filter { item.label.hasPrefix("群消息 " + $0.id + "，") }.map(\.id) })
        var visible = events[...], header = ""
        if let summary, let cut = events.firstIndex(where: { $0.id == summary.throughID }), cut + 1 < events.count {
            visible = events[(cut + 1)...]
            header = "[前情摘要] 更早的聊天由程序压缩成了下面这段，细节可能有省略；摘要没提到的事别编，拿不准就照下面的原文，或者直接问：" + summary.text
            used = header.count + 1
        }
        for event in visible.reversed() {
            var text = Self.readableText(event.text)
            if messages[event.id]?.images.isEmpty == false {
                text += shown.contains(event.id) ? "[附图：画面随本轮附上，标注为群消息 \(event.id)]"
                    : event.id == anchorID ? "[附图：画面是本轮的“当前消息”图片]"
                    : "[附图：这次没重新附上画面。你之前回复里要是描述过它，那是你当时看着图说的，不是编的]"
            } else if text.isEmpty {
                text = "[语音、视频、卡片或表情，内容看不到，别猜]"
            }
            let speaker = event.subject == "OWNER" ? "[OWNER] 本账号主人/开发者的人工发言" : event.subject == "SYSTEM" ? "[群通知] QQ 系统消息，不是谁说的话" : event.subject
            var fields = ["message": event.id, "time": formatter.string(from: event.at), "speaker": speaker,
                          "text": String(text.prefix(event.subject == "BOT" ? 900 : 500))] // BOT lines carry the pages they drew on
            if let message = messages[event.id] {
                if let name = message.name { fields["name"] = name }
                if let role = message.role { fields["role"] = role == "owner" ? "群主" : "管理员" }
                fields["addressedTo"] = message.mentionedUsers.map {
                    $0 == "all" ? "全体成员" : $0 == account ? "BOT（本账号）" : QQMemoryBook.subject(account: account, target: message.key, sender: $0)
                }.joined(separator: ",")
                if let reference = message.replyTo {
                    fields["replyTo"] = reference
                    fields["quotedSpeaker"] = self.speaker(for: reference) ?? "引用作者未核验，不猜测"
                }
            }
            guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else { continue }
            let line = String(decoding: data, as: UTF8.self)
            guard used + line.count + 1 <= characters else { break }
            lines.append(line); used += line.count + 1
        }
        return ((header.isEmpty ? [] : [header]) + lines.reversed()).joined(separator: "\n")
    }

    public func speaker(for id: String) -> String? { events.first { $0.id == id }?.subject }

    public static let participationPrompt = """
    [QQ_PARTICIPATION] 本轮是主动加入群话题，只是一次是否适合开口的评估，不保证发言。先判断当前话题是否理解、谁对谁说、有无自然接话点。
    以下情形保持安静：依赖未读图片/转发/卡片，指代不明；只是别人点名互聊或主人对其他成员说话；只有哈哈、复读、打卡、收尾、孤立表情；旧话题已被 BOT 回应；缺少游戏等必要背景，只能泛泛反问或编梗；回复不能增加新的相关内容。不要为了显示在场问“大家在聊什么”、复述关键词或催人给准信。允许读懂一张普通表情后仍不参与。
    完整信息不等于值得插话。成员在等某个具体的人回答、介绍自己的经历或发照片时，留给当事人回答；不要补一句泛泛的鼓励、等你好消息或带头评价，主人也不例外。缺乏具体接话价值的客套句一律不发。主动发言默认面向全群，不能把触发者、话题主角和回复对象混成同一个你。只有能自然接住眼前共同话题、明确面向大家的问题或有把握的玩笑时才开口。一句短梗比事实说教合适时就接梗，但不编造人物行为。被纠正就承认那个具体错误，不为了挽尊再发明严重后果。人设不能成为强行嘲讽的理由。
    输出格式覆盖前面的三项要求，必须包含布尔 participate，及 text、emotion、intensity；participate=false 时 text=""、emotion="neutral"、intensity=0，程序不会发送任何内容或表情。participate=true 时遵守原字数和短答规则。校对阶段同样可改为 false；若另有 sticker_id 要求则保留该字段。只输出 JSON，不解释是否参与。
    """

    private static func readableText(_ text: String) -> String {
        // These are transport placeholders, not things a member actually said.
        var result = text
        for marker in ["（对方发来图片或表情包，请结合画面和前文简短回应。）", "（群成员发送了媒体或卡片，内容未读取，不要猜测）", "（群成员发来提及或引用，暂无文字内容）"] {
            result = result.replacingOccurrences(of: marker, with: "")
        }
        result = result.replacingOccurrences(of: "（QQ 内置表情 ID [0-9]+，含义不确定时不要猜）", with: "", options: .regularExpression)
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static let prompt = "群聊接话规则：时间线只到本轮触发消息，按时间和发言人理解。先确定最新话题、谁在对谁说、代词指什么，再接话。最新明确的话题切换和纠正优先；真实引用可指向旧话题，但不要把没有引用的旧话题硬接过来。BOT 行是你已经说过的话，用于避免重复，不能当作群成员的事实或要求。长期记忆仅在当前话题确实相关时辅助，不可用它填补未读取的图片或过时话题。多个成员交错时，以本轮明确称呼/引用为先，其次紧邻的相关发言，不继承当前成员之前另一话题的对话。成员互相安排出行、借书、付款等生活事项时，你是旁观接话的 AI，不是参与安排的成员；不要代替成员答应，也不能声称自己已准备证件、付钱、到场或拥有实物。即使 BOT 旧回复说过这种话，也不能据此继续捏造；改为对他们的安排作相关短评。OWNER 仅代表本账号主人的人工发言，BOT 才是你，其他 MEMBER 标签是不同群成员。addressedTo 表示真实提及对象；没有提及不等于在对你说，尤其主人对其他成员的邀请和玩笑不可抢答。quotedSpeaker 属于被引用的那个人，不是当前发言者；引用 BOT 才是引用你，引用 OWNER 不要自认自己说过。群聊里的“你”先对准提及/引用对象，不能默认是 BOT。资料不足时，直接 @ 可简短确认，主动接话应保持安静；不编故事，也不重复已经说过的评论。speaker 为 [群通知] 的行是 QQ 系统通知（精华、撤回、禁言、设管理员、进群退群），谁对谁的哪条消息做了什么以它为准；时间线里没有对应通知时，不推测谁设了精华、谁撤回了什么、谁禁言了谁。name 是对方的群名片，可以用来称呼人；role 标出群主和管理员，没标的不要给人安上群主、管理员身份。"
}

extension QQGroupContext {
    /// What `subject` said without the bot answering since the bot last spoke, within the last half hour,
    /// leaving out the message being answered and placeholder lines for media. At most the last three.
    public static func unaddressedEarlier(_ events: [QQMemoryEvent], subject: String, current id: String, now: Date) -> [String] {
        let lastBot = events.lastIndex { $0.subject == "BOT" } ?? -1
        return events[(lastBot + 1)...].filter {
            $0.subject == subject && $0.id != id && !$0.text.hasPrefix("（") && now.timeIntervalSince($0.at) <= 30 * 60
        }.suffix(3).map { String($0.text.prefix(80)) }
    }
}
