import Foundation
import Testing
@testable import BotCore

struct QQReactionsTests {
    @Test func savedPreferencesFillTheCatalogueAndBadSettingsAreRejected() throws {
        var config = QQReactionConfig()
        try config.validate()
        // An older saved list (nine faces) still gets the rest of the catalogue, with its own weights kept.
        config.emojis = [QQReactionEmoji(id: "128051", name: "鲸鱼", weight: 9), QQReactionEmoji(id: "999", name: "自定义", weight: 3)]
        let effective = config.effectiveEmojis
        #expect(effective.count == QQReactionConfig.catalog.count + 1)
        #expect(effective.first { $0.id == "128051" }?.weight == 9)
        #expect(effective.first { $0.id == "128051" }?.hint?.isEmpty == false)
        #expect(effective.last?.id == "999")
        config.emojis[0].weight = 11
        #expect(throws: (any Error).self) { try config.validate() }
        config = QQReactionConfig(); config.emojis[0].id = "abc"
        #expect(throws: (any Error).self) { try config.validate() }
        // Settings saved by the old small-moves version still decode; only the favourites are kept.
        let old = try JSONDecoder().decode(QQReactionConfig.self, from: Data(#"{"enabled":true,"chance":20,"cooldownSeconds":45,"emojis":[{"id":"147","name":"棒棒糖","weight":5}]}"#.utf8))
        #expect(old.emojis.map(\.id) == ["147"])
    }

    @Test func olderLinesGiveWayToTheRollingSummary() throws {
        let start = Date().addingTimeInterval(-600)
        let events = (0..<30).map { QQMemoryEvent(id: "m\($0)", subject: $0 % 3 == 0 ? "BOT" : "MEMBER_a", text: "第\($0)句", at: start.addingTimeInterval(Double($0) * 10)) }
        // Nothing is due until ten lines have left the last dozen.
        #expect(QQTimelineDigest.due(Array(events.prefix(21)), summary: nil) == nil)
        let batch = try #require(QQTimelineDigest.due(events, summary: nil))
        #expect(batch.count == 18 && batch.last?.id == "m17")
        let summary = QQTimelineSummary(text: "MEMBER_a 在数数", throughID: "m17", at: Date())
        #expect(QQTimelineDigest.due(events, summary: summary) == nil)
        #expect(QQTimelineDigest.carried(QQTimelineSummary(text: "旧", throughID: "m1", at: Date().addingTimeInterval(-3 * 3600))) == "")
        #expect(QQTimelineDigest.decode(#"{"summary":"  大家在聊考试  "}"#) == "大家在聊考试")
        #expect(QQTimelineDigest.decode(#"{"summary":""}"#) == nil)
        #expect(QQTimelineDigest.lines([events[1]], names: ["m1": "小王"]).contains("MEMBER_a（小王）：第1句"))

        let context = try #require(QQGroupContext(events: events, through: "m29"))
        let full = context.context(characters: 20000)
        let short = context.context(characters: 20000, summary: summary)
        #expect(full.contains("第3句") && full.contains("第29句"))
        #expect(short.hasPrefix("[前情摘要]") && short.contains("MEMBER_a 在数数"))
        #expect(!short.contains("\"第3句\"") && !short.contains("第17句") && short.contains("第18句") && short.contains("第29句"))
        #expect(short.count < full.count)
        // A summary that ends outside this timeline is not used.
        #expect(!context.context(characters: 20000, summary: QQTimelineSummary(text: "别处", throughID: "gone", at: Date())).contains("前情摘要"))
    }

    /// The agent reacts with any QQ face or emoji, written by name; favourites come first and a 0 keeps one out.
    @Test func everyFaceAndEmojiCanBeNamed() {
        let saved = QQPolicy.faceNames
        defer { QQPolicy.faceNames = saved }
        QQPolicy.faceNames = ["271": "吃瓜", "264": "捂脸", "356": "666", "179": "doge", "8": "睡"]
        let favourites = [QQReactionEmoji(id: "128051", name: "鲸鱼", weight: 5, hint: "打招呼"), QQReactionEmoji(id: "8", name: "睡", weight: 0)]
        let items = QQReactionCatalog.all(favourites: favourites)
        #expect(items.first?.id == "128051" && !items.contains { $0.id == "8" })
        #expect(items.filter { $0.id == "128051" }.count == 1) // the emoji list has it too, under another name
        #expect(QQReactionCatalog.resolve("吃瓜", among: items)?.id == "271")
        #expect(QQReactionCatalog.resolve("[捂脸]", among: items)?.id == "264")
        #expect(QQReactionCatalog.resolve("🔥", among: items)?.id == "128293")
        #expect(QQReactionCatalog.resolve("火", among: items)?.id == "128293")
        #expect(QQReactionCatalog.resolve("DOGE", among: items)?.id == "179")
        #expect(QQReactionCatalog.resolve("356", among: items)?.id == "356")
        #expect(QQReactionCatalog.resolve("睡", among: items) == nil)
        #expect(QQReactionCatalog.resolve("不存在的表情", among: items) == nil)
        #expect(QQReactionCatalog.search("吃瓜", among: items).first?.id == "271")
        #expect(QQReactionCatalog.search("打招呼", among: items).first?.id == "128051")
    }
}
