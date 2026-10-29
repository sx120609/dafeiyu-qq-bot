import Foundation

/// Chat commands handled by the program without calling a model.
public enum QQAdminCommand: Equatable, Sendable {
    case help
    /// Forget the short-term context of this conversation.
    case newTopic
    /// `newTopic` plus this conversation's long-term memory.
    case clear
    case block(String)
    case unblock(String)
    case blocklist
    /// What the bot remembers about the sender in this conversation, with dates.
    case memories
    /// Forget the sender's memories in this conversation that contain the keyword.
    case forget(String)
    case invalid(String)

    private static let heads = ["help", "帮助", "菜单", "命令", "new", "新话题", "重置", "reset", "clear", "清空", "清除记忆",
                                "blocklist", "黑名单", "block", "拉黑", "unblock", "解除拉黑", "取消拉黑", "解封",
                                "memory", "记忆", "你记得什么", "forget", "忘记", "忘掉"]
        .sorted { $0.count > $1.count }

    public static func parse(_ text: String, mentioned: [String] = []) -> Self? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.hasPrefix("/"), !value.contains("\n"), value.count <= 60 else { return nil }
        let body = String(value.dropFirst()), lowered = body.lowercased()
        // Chinese commands may run straight into their argument ("/拉黑123456"); English ones need a space.
        guard let head = heads.first(where: { head in
            guard lowered.hasPrefix(head) else { return false }
            guard let next = lowered.dropFirst(head.count).first else { return true }
            // "/忘记生日" reads naturally without a space.
            return next.isWhitespace || (head.first?.isASCII == false && (next.isNumber || next == "@" || ["忘记", "忘掉"].contains(head)))
        }) else { return nil }
        let argument = String(body.dropFirst(head.count)).trimmingCharacters(in: .whitespaces)
        switch head {
        case "help", "帮助", "菜单", "命令": return .help
        case "new", "新话题", "重置", "reset": return argument.isEmpty ? .newTopic : .invalid("/new 不需要参数")
        case "clear", "清空", "清除记忆": return argument.isEmpty ? .clear : .invalid("/clear 不需要参数")
        case "blocklist", "黑名单": return .blocklist
        case "memory", "记忆", "你记得什么": return .memories
        case "forget", "忘记", "忘掉":
            guard !argument.isEmpty, argument.count <= 30 else { return .invalid("用法：/忘记 关键词（先用 /记忆 看看记了什么）") }
            return .forget(argument)
        case "block", "拉黑", "unblock", "解除拉黑", "取消拉黑", "解封":
            let unblock = ["unblock", "解除拉黑", "取消拉黑", "解封"].contains(head)
            let digits = argument.filter(\.isNumber)
            // In a group, "/拉黑 @someone" carries the number as a mention instead of text.
            let number = !digits.isEmpty && digits.count == argument.count ? digits : (argument.isEmpty || argument.hasPrefix("@") ? mentioned.first ?? "" : "")
            guard QQConfig.validID(number) else { return .invalid("用法：/\(unblock ? "解除拉黑" : "拉黑") QQ号，或在群里 /\(unblock ? "解除拉黑" : "拉黑") @某人") }
            return unblock ? .unblock(number) : .block(number)
        default: return nil
        }
    }

    /// Group chats share context, so resetting it there is an admin action.
    /// In private chats the friend may reset their own conversation.
    public func requiresAdmin(group: Bool) -> Bool {
        switch self {
        // Anyone may see and remove what is remembered about themselves.
        case .help, .invalid, .memories, .forget: return false
        case .newTopic, .clear: return group
        case .block, .unblock, .blocklist: return true
        }
    }

    public static func help(admin: Bool, group: Bool) -> String {
        var lines = ["可用命令（不调用模型）：", "/new 开个新话题，忘掉刚才聊的", "/clear 新话题，并清空这个会话的长期记忆", "/model 问我现在用的模型", "/persona 查看或切换性格",
                     "/记忆 看看我记得你什么", "/忘记 关键词 删掉我记的关于你的某件事"]
        if group && !admin { lines[1] += "（群里仅管理员）"; lines[2] += "（群里仅管理员）" }
        if admin { lines += ["/拉黑 QQ号 拉黑后完全不回复此人", "/解除拉黑 QQ号", "/黑名单 查看已拉黑的 QQ"] }
        return lines.joined(separator: "\n")
    }
}
