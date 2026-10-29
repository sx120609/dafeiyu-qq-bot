import Foundation
import Testing
@testable import BotCore

struct QQAdminCommandTests {
    @Test func parsesCommandsAndArguments() {
        #expect(QQAdminCommand.parse("/new") == .newTopic)
        #expect(QQAdminCommand.parse(" /重置 ") == .newTopic)
        #expect(QQAdminCommand.parse("/clear") == .clear)
        #expect(QQAdminCommand.parse("/help") == .help)
        #expect(QQAdminCommand.parse("/黑名单") == .blocklist)
        #expect(QQAdminCommand.parse("/blocklist") == .blocklist)
        #expect(QQAdminCommand.parse("/拉黑 123456") == .block("123456"))
        #expect(QQAdminCommand.parse("/拉黑123456") == .block("123456"))
        #expect(QQAdminCommand.parse("/block 123456") == .block("123456"))
        #expect(QQAdminCommand.parse("/解除拉黑 123456") == .unblock("123456"))
        #expect(QQAdminCommand.parse("/unblock 123456") == .unblock("123456"))
        #expect(QQAdminCommand.parse("/拉黑 @某人", mentioned: ["654321"]) == .block("654321"))
        #expect(QQAdminCommand.parse("/拉黑", mentioned: ["654321"]) == .block("654321"))
        #expect(QQAdminCommand.parse("/记忆") == .memories); #expect(QQAdminCommand.parse("/memory") == .memories)
        #expect(QQAdminCommand.parse("/忘记 生日") == .forget("生日")); #expect(QQAdminCommand.parse("/忘记生日") == .forget("生日"))
        if case .invalid = QQAdminCommand.parse("/忘记") {} else { Issue.record("expected invalid") }
        #expect(QQAdminCommand.parse("/记忆力怎么练") == nil)
        #expect(!QQAdminCommand.memories.requiresAdmin(group: true)); #expect(!QQAdminCommand.forget("x").requiresAdmin(group: true))
    }
    @Test func peopleCanSeeAndRemoveWhatIsRememberedAboutThem() {
        var book = QQMemoryBook()
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let event = QQMemoryEvent(id: "1", subject: "PEER", text: "我生日是三月五号，喜欢吃辣", at: now)
        book.append(event)
        try? book.apply(try! .decode(#"{"summary":"","changes":[{"operation":"upsert","replaces":[],"subject":"PEER","kind":"fact","text":"生日是三月五号","keywords":["生日"],"importance":2,"sourceID":"1","evidence":"我生日是三月五号","days":365},{"operation":"upsert","replaces":[],"subject":"PEER","kind":"preference","text":"喜欢吃辣","keywords":["口味"],"importance":2,"sourceID":"1","evidence":"喜欢吃辣","days":365}]}"#), batch: [event], candidateIDs: [], now: now)
        #expect(book.remembered(about: "PEER", now: now).count == 2)
        #expect(book.forget(about: "PEER", containing: "生日", now: now) == ["生日是三月五号"])
        #expect(book.remembered(about: "PEER", now: now).map(\.text) == ["喜欢吃辣"])
        #expect(book.forget(about: "OWNER", containing: "辣", now: now).isEmpty)
    }
    @Test func ignoresOrdinaryTextAndRejectsBadArguments() {
        for value in ["新的一天", "/newspaper", "/blockchain 是什么", "/persona", "/model", "我想 /new 一下", "/new\n/clear"] {
            #expect(QQAdminCommand.parse(value) == nil)
        }
        if case .invalid = QQAdminCommand.parse("/拉黑 abc") {} else { Issue.record("expected invalid") }
        if case .invalid = QQAdminCommand.parse("/拉黑 0123") {} else { Issue.record("expected invalid") }
        if case .invalid = QQAdminCommand.parse("/new 123") {} else { Issue.record("expected invalid") }
    }
    @Test func groupResetsNeedAdmins() {
        #expect(!QQAdminCommand.newTopic.requiresAdmin(group: false))
        #expect(QQAdminCommand.newTopic.requiresAdmin(group: true))
        #expect(QQAdminCommand.block("123456").requiresAdmin(group: false))
        #expect(!QQAdminCommand.help.requiresAdmin(group: true))
    }
    @Test func configRejectsOverlappingLists() throws {
        var config = QQConfig()
        config.expectedSelfID = "20002"
        config.adminIDs = ["123456"]; config.blockedIDs = ["654321"]
        try config.validate()
        #expect(config.isAdmin("123456") && config.isBlocked("654321") && !config.isBlocked("123456"))
        config.blockedIDs = ["123456"]
        #expect(throws: (any Error).self) { try config.validate() }
        config.blockedIDs = ["abc"]
        #expect(throws: (any Error).self) { try config.validate() }
    }
}
