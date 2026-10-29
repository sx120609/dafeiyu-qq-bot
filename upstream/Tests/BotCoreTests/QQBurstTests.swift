import Testing
@testable import BotCore

struct QQBurstTests {
    @Test func messagesSentInARowBecomeOneTurn() {
        let first = QQIncoming(id: "1", sender: "54321", target: "54321", group: false, text: "帮我找个p站的4", time: 100, replyTo: nil, images: [])
        var second = QQIncoming(id: "2", sender: "54321", target: "54321", group: false, text: "r18", time: 103, replyTo: nil, images: [])
        second.mentionedUsers = ["12345"]
        let merged = second.merging(earlier: [first])
        #expect(merged.text == "帮我找个p站的4\nr18")
        #expect(merged.id == "2" && merged.time == 103)
        #expect(merged.mentionedUsers == ["12345"])
        #expect(second.merging(earlier: []) == second)
    }
    @Test func unfinishedMessagesWaitLonger() {
        #expect(QQIncoming.settleDelay(after: "帮我找个", base: 5) == 5)
        #expect(QQIncoming.settleDelay(after: "帮我找个p站的图吧", base: 5) == 2.5)
        #expect(QQIncoming.settleDelay(after: "今天天气怎么样？", base: 5) == 2.5)
        #expect(QQIncoming.settleDelay(after: String(repeating: "长", count: 40), base: 5) == 2.5)
        #expect(QQIncoming.settleDelay(after: "好", base: 2) == 2)
        #expect(QQIncoming.settleDelay(after: "好的。", base: 2) == 1.5)
    }
    @Test func pokeSettingsValidate() throws {
        #expect(!QQPokeConfig().enabled)
        try QQPokeConfig().validate()
        var bad = QQPokeConfig(); bad.replyChance = 120
        #expect(throws: (any Error).self) { try bad.validate() }
    }
}
