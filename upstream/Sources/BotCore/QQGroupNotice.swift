import Foundation

/// QQ group notices (精华, 撤回, 禁言, 管理员, 进群退群) as one line of the group timeline, so the model
/// knows who did what instead of guessing it from the messages around it.
public enum QQGroupNotice {
    /// `name` gives a member's group card when it is known; `quote` the text of a recent message by ID.
    public static func describe(_ object: [String: Any], selfID: String, key: String,
                                name: (String) -> String? = { _ in nil }, quote: (String) -> String? = { _ in nil }) -> String? {
        guard object["post_type"] as? String == "notice" else { return nil }
        func who(_ value: Any?) -> String? {
            guard let id = QQPolicy.identifier(value), id != "0", QQConfig.validID(id) else { return nil }
            if id == selfID { return "本账号（大肥鱼）" }
            let label = QQMemoryBook.subject(account: selfID, target: key, sender: id)
            return name(id).map { "\(label)（\($0)）" } ?? label
        }
        func message(_ value: Any?) -> String {
            guard let id = QQPolicy.identifier(value), let text = quote(id)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return "一条消息" }
            return "消息「" + String(text.prefix(40)) + (text.count > 40 ? "…" : "") + "」"
        }
        let sub = object["sub_type"] as? String
        switch object["notice_type"] as? String {
        case "essence":
            guard let sender = who(object["sender_id"]) else { return nil }
            let operatorName = who(object["operator_id"]) ?? "管理员"
            return sub == "delete" ? "\(operatorName) 取消了 \(sender) 的\(message(object["message_id"]))的精华"
                : "\(operatorName) 把 \(sender) 的\(message(object["message_id"]))设为了精华"
        case "group_recall":
            // What was recalled is not repeated: the sender chose to take it back.
            guard let sender = who(object["user_id"]) else { return nil }
            let operatorName = who(object["operator_id"])
            return operatorName == nil || operatorName == sender ? "\(sender) 撤回了一条消息" : "\(operatorName!) 撤回了 \(sender) 的一条消息"
        case "group_admin":
            guard let user = who(object["user_id"]) else { return nil }
            return sub == "unset" ? "\(user) 被取消了管理员" : "\(user) 被设为管理员"
        case "group_ban":
            let operatorName = who(object["operator_id"]) ?? "管理员"
            guard let user = who(object["user_id"]) else { return sub == "lift_ban" ? "\(operatorName) 解除了全员禁言" : "\(operatorName) 开启了全员禁言" }
            if sub == "lift_ban" { return "\(operatorName) 解除了 \(user) 的禁言" }
            let seconds = (object["duration"] as? NSNumber)?.doubleValue ?? 0
            let span = seconds >= 86400 ? "\(Int((seconds / 86400).rounded())) 天" : seconds >= 3600 ? "\(Int((seconds / 3600).rounded())) 小时" : seconds > 0 ? "\(max(1, Int((seconds / 60).rounded()))) 分钟" : ""
            return "\(operatorName) 禁言了 \(user)" + (span.isEmpty ? "" : " " + span)
        case "group_increase":
            guard let user = who(object["user_id"]) else { return nil }
            return "\(user) 进群了"
        case "group_decrease":
            guard sub != "kick_me", let user = who(object["user_id"]) else { return nil }
            return sub == "kick" ? "\(user) 被移出了群" : "\(user) 退群了"
        default:
            return nil
        }
    }
}
