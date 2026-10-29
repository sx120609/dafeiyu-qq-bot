import Foundation
import Testing
@testable import BotCore

struct QQGroupNoticeTests {
    private let key = "group:99999"
    private func notice(_ type: String, _ sub: String? = nil, _ fields: [String: Any]) -> [String: Any] {
        var object: [String: Any] = ["post_type": "notice", "notice_type": type, "group_id": 99999, "self_id": 12345]
        if let sub { object["sub_type"] = sub }
        return object.merging(fields) { $1 }
    }
    private func member(_ id: String) -> String { QQMemoryBook.subject(account: "12345", target: key, sender: id) }

    @Test func essenceSaysWhoMarkedWhoseMessage() {
        let line = QQGroupNotice.describe(notice("essence", "add", ["sender_id": 54321, "operator_id": 77777, "message_id": 501]),
            selfID: "12345", key: key, name: { ["54321": "小张", "77777": "小李"][$0] }, quote: { $0 == "501" ? "我还能设精" : nil })
        #expect(line == "\(member("77777"))（小李） 把 \(member("54321"))（小张） 的消息「我还能设精」设为了精华")
        let removed = QQGroupNotice.describe(notice("essence", "delete", ["sender_id": 54321, "operator_id": 77777, "message_id": 9]), selfID: "12345", key: key)
        #expect(removed?.contains("取消了") == true); #expect(removed?.contains("一条消息") == true)
    }
    @Test func recallsBansAndMembershipAreDescribedWithoutRepeatingRecalledText() {
        let recall = QQGroupNotice.describe(notice("group_recall", nil, ["user_id": 54321, "operator_id": 54321, "message_id": 501]),
            selfID: "12345", key: key, quote: { _ in "不该发的东西" })
        #expect(recall == "\(member("54321")) 撤回了一条消息")
        #expect(QQGroupNotice.describe(notice("group_ban", "ban", ["user_id": 12345, "operator_id": 77777, "duration": 600]), selfID: "12345", key: key)
            == "\(member("77777")) 禁言了 本账号（大肥鱼） 10 分钟")
        #expect(QQGroupNotice.describe(notice("group_ban", "ban", ["user_id": 0, "operator_id": 77777, "duration": 0]), selfID: "12345", key: key)?.contains("全员禁言") == true)
        #expect(QQGroupNotice.describe(notice("group_admin", "set", ["user_id": 54321]), selfID: "12345", key: key)?.hasSuffix("被设为管理员") == true)
        #expect(QQGroupNotice.describe(notice("group_decrease", "kick", ["user_id": 54321, "operator_id": 77777]), selfID: "12345", key: key)?.hasSuffix("被移出了群") == true)
        #expect(QQGroupNotice.describe(notice("notify", "poke", ["user_id": 54321, "target_id": 12345]), selfID: "12345", key: key) == nil)
    }
    @Test func timelineShowsNoticesNamesAndRolesWithoutTreatingNoticesAsTalk() throws {
        let base = Date(timeIntervalSince1970: 1_790_000_000)
        let rows = [QQMemoryEvent(id: "1", subject: member("54321"), text: "我还能设精", at: base),
                    QQMemoryEvent(id: "notice-1", subject: "SYSTEM", text: "管理员 把 X 的消息设为了精华", at: base.addingTimeInterval(5)),
                    QQMemoryEvent(id: "2", subject: "BOT", text: "好家伙", at: base.addingTimeInterval(8)),
                    QQMemoryEvent(id: "notice-2", subject: "SYSTEM", text: "Y 进群了", at: base.addingTimeInterval(9))]
        let now = base.timeIntervalSince1970
        let event: [String: Any] = ["post_type": "message", "message_type": "group", "sub_type": "normal", "self_id": 12345, "user_id": 54321, "group_id": 99999,
                                    "message_id": 1, "time": now, "sender": ["user_id": 54321, "card": "小张", "nickname": "zrf", "role": "admin"],
                                    "message": [["type": "text", "data": ["text": "我还能设精"]]]]
        let incoming = try #require(QQPolicy.incoming(event, selfID: "12345", since: 0, now: now, allowUnmentionedGroup: true))
        #expect(incoming.name == "小张"); #expect(incoming.role == "admin")
        let context = try #require(QQGroupContext(events: rows, through: "notice-2", messages: ["1": incoming], account: "12345"))
        #expect(!context.hasUnansweredText)
        let lines = try context.context(characters: 5000).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: String] }
        #expect(lines.first { $0["message"] == "1" }?["name"] == "小张"); #expect(lines.first { $0["message"] == "1" }?["role"] == "管理员")
        #expect(lines.first { $0["message"] == "notice-1" }?["speaker"]?.hasPrefix("[群通知]") == true)
    }
}
