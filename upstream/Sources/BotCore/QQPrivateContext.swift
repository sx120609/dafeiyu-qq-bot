import Foundation

/// A scoped server snapshot, bounded at the current incoming message (never future replies).
public struct QQPrivateContext: Sendable {
    public let text: String
    public let memoryText: String
    public let messageIDs: Set<String>
    public let memoryEvents: [QQMemoryEvent]
    public let earlierImages: [(label: String, images: [QQIncomingImage])]
    /// Rows that do not belong to this private conversation are skipped rather than voiding the whole
    /// snapshot; `since` drops everything before a /new or /clear.
    public static func read(_ rows: [[String: Any]], for message: QQIncoming, selfID: String, excluding: Set<String> = [], botMessageIDs: Set<String> = [], ownershipSince: Double = .infinity, since: Double = 0) -> QQPrivateContext? {
        guard !message.group, rows.count <= 50,
              let anchor = rows.firstIndex(where: { QQPolicy.identifier($0["message_id"]) == message.id }),
              QQPolicy.identifier((rows[anchor]["sender"] as? [String: Any])?["user_id"]) == message.sender else { return nil }
        var entries: [(id: String, line: String)] = []
        var ids: Set<String> = []
        var memoryEvents: [QQMemoryEvent] = []
        // The friend's pictures from the last 15 minutes go along with the request again, so the bot can
        // still look at what it already talked about.
        var earlier: [(label: String, images: [QQIncomingImage])] = [], earlierCount = 0
        for row in rows.prefix(upTo: anchor).suffix(40).reversed() where earlierCount < 2 {
            guard row["message_type"] as? String == "private", QQPolicy.identifier(row["self_id"]) == selfID,
                  let id = QQPolicy.identifier(row["message_id"]), id != message.id,
                  QQPolicy.identifier((row["sender"] as? [String: Any])?["user_id"]) == message.target,
                  let time = row["time"] as? Double, time >= since, message.time - time <= 15 * 60,
                  let segments = row["message"] as? [[String: Any]] else { continue }
            let images = segments.compactMap { segment -> QQIncomingImage? in
                guard segment["type"] as? String == "image", let data = segment["data"] as? [String: Any],
                      let file = data["file"] as? String, !file.isEmpty, file.count <= 2048 else { return nil }
                return QQIncomingImage(file: file, url: data["url"] as? String)
            }.prefix(2 - earlierCount)
            guard !images.isEmpty else { continue }
            earlier.append(("消息 " + id, Array(images))); earlierCount += images.count
        }
        earlier.reverse()
        let shown = Set(earlier.map { String($0.label.dropFirst(3)) })
        for row in rows.prefix(through: anchor).suffix(40) {
            guard row["message_type"] as? String == "private", row["sub_type"] as? String == "friend",
                  QQPolicy.identifier(row["self_id"]) == selfID,
                  let id = QQPolicy.identifier(row["message_id"]), Int64(id) != nil,
                  let author = QQPolicy.identifier((row["sender"] as? [String: Any])?["user_id"]),
                  author == selfID || author == message.target,
                  let segments = row["message"] as? [[String: Any]] else { continue }
            if let user = QQPolicy.identifier(row["user_id"]), user != author { continue }
            if id != message.id, let time = row["time"] as? Double, time < since { continue }
            guard ids.insert(id).inserted else { continue }
            if id == message.id { continue } // Current text and actual images are supplied separately.
            var text = ""
            for segment in segments {
                let data = segment["data"] as? [String: Any] ?? [:]
                switch segment["type"] as? String {
                case "text": text += String((data["text"] as? String ?? "").prefix(max(0, 800 - text.count)))
                case "image":
                    text += QQPolicy.stickerText(data)
                    text += author == selfID ? "[本账号发出的图片/表情]"
                        : shown.contains(id) ? "[图片：画面随本轮附上，标注为消息 \(id)]"
                        : "[图片：这次没重新附上画面。你之前回复里要是描述过它，那是你当时看着图说的，不是编的]"
                case "reply": text += "[引用此前消息]"
                case "face": text += QQPolicy.faceText(data)
                case let kind?: text += QQPolicy.placeholder(kind, data)
                default: text += "[其他消息]"
                }
            }
            let speaker: String
            if author != selfID { speaker = "[PEER] 当前好友" }
            else if botMessageIDs.contains(id) { speaker = "[BOT] 大肥鱼此前自动回复" }
            else if let time = row["time"] as? Double, time >= ownershipSince { speaker = "[OWNER] 本账号主人/开发者的人工发言" }
            else { speaker = "[SELF_UNKNOWN] 本账号旧发言，无法区分主人或机器人，勿强行归属" }
            let role = author != selfID ? "PEER" : botMessageIDs.contains(id) ? "BOT" : speaker.hasPrefix("[OWNER]") ? "OWNER" : "SELF_UNKNOWN"
            memoryEvents.append(QQMemoryEvent(id: id, subject: role, text: text, at: Date(timeIntervalSince1970: row["time"] as? Double ?? message.time)))
            let item = ["speaker": speaker, "recipient": author == selfID ? "[PEER] 当前好友" : "[SELF] 本账号（大肥鱼与主人共用）", "text": String(text.prefix(1000))]
            guard let data = try? JSONSerialization.data(withJSONObject: item, options: [.sortedKeys]) else { continue }
            entries.append((id, String(decoding: data, as: UTF8.self)))
        }
        while entries.reduce(0, { $0 + $1.line.count }) > 10000 { entries.removeFirst() }
        return QQPrivateContext(text: entries.map(\.line).joined(separator: "\n"),
            memoryText: entries.filter { !excluding.contains($0.id) }.map(\.line).joined(separator: "\n"), messageIDs: ids, memoryEvents: memoryEvents, earlierImages: earlier)
    }
}
