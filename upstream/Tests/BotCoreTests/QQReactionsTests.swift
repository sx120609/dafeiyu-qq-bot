import Foundation
import Testing
@testable import BotCore

struct QQReactionsTests {
    @Test func savedPreferencesFillTheCatalogueAndBadSettingsAreRejected() throws {
        var config = QQReactionConfig()
        #expect(!config.enabled)
        try config.validate()
        #expect(config.effectivePokeEnabled && config.effectiveRepeatEnabled)
        // An older saved list (nine faces) still gets the rest of the catalogue, with its own weights kept.
        config.emojis = [QQReactionEmoji(id: "128051", name: "鲸鱼", weight: 9), QQReactionEmoji(id: "999", name: "自定义", weight: 3)]
        let effective = config.effectiveEmojis
        #expect(effective.count == QQReactionConfig.catalog.count + 1)
        #expect(effective.first { $0.id == "128051" }?.weight == 9)
        #expect(effective.first { $0.id == "128051" }?.hint?.isEmpty == false)
        #expect(effective.last?.id == "999")
        config.chance = 101
        #expect(throws: (any Error).self) { try config.validate() }
        config = QQReactionConfig(); config.emojis[0].id = "abc"
        #expect(throws: (any Error).self) { try config.validate() }
        // Settings saved before the model-driven version decode, and liveliness sets how often groups are looked at.
        let old = try JSONDecoder().decode(QQReactionConfig.self, from: Data(#"{"enabled":true,"chance":20,"cooldownSeconds":45,"emojis":[{"id":"147","name":"棒棒糖","weight":5}]}"#.utf8))
        #expect(old.enabled && old.pokeEnabled == nil && old.looksPerHour == 6)
        config.chance = 10; #expect(config.looksPerHour < QQReactionConfig().looksPerHour)
    }

    @Test func onlyOfferedMessagesEmojisAndMembersSurviveThePlan() {
        let text = #"{"actions":[{"type":"react","message":"m1","emoji":"147"},{"type":"react","message":"m1","emoji":"76"},{"type":"react","message":"old","emoji":"147"},{"type":"react","message":"m2","emoji":"666"},{"type":"react","message":"m3","emoji":76},{"type":"poke","member":"MEMBER_a"},{"type":"poke","member":"MEMBER_b"},{"type":"repeat","message":"m3"},{"type":"run","message":"m1"}],"why":"好笑"}"#
        let plan = QQInteractionPlan.decode(text, candidates: ["m1", "m2", "m3"], repeatable: [], members: ["MEMBER_a", "MEMBER_b"], emojis: ["147", "76"])
        #expect(plan.actions == [.react(message: "m1", emoji: "147"), .react(message: "m3", emoji: "76"), .poke(member: "MEMBER_a")])
        #expect(plan.why == "好笑")
        #expect(QQInteractionPlan.decode("不是 JSON", candidates: ["m1"], repeatable: [], members: [], emojis: ["147"]).actions.isEmpty)
        let repeated = QQInteractionPlan.decode(#"{"actions":[{"type":"repeat","message":"m3"}],"why":""}"#, candidates: [], repeatable: ["m3"], members: [], emojis: [])
        #expect(repeated.actions == [.repeatMessage(message: "m3")])
    }

    @Test func aRepeatChainNeedsTwoPeopleAndNoBot() {
        let now = Date()
        func event(_ id: String, _ subject: String, _ text: String) -> QQMemoryEvent { QQMemoryEvent(id: id, subject: subject, text: text, at: now) }
        #expect(QQInteractionPlan.repeatable([event("1", "MEMBER_a", "聊点别的"), event("2", "MEMBER_b", "zdjd"), event("3", "MEMBER_c", "zdjd")]) == "3")
        #expect(QQInteractionPlan.repeatable([event("2", "MEMBER_b", "zdjd"), event("3", "MEMBER_b", "zdjd")]) == nil)
        #expect(QQInteractionPlan.repeatable([event("1", "BOT", "zdjd"), event("2", "MEMBER_b", "zdjd"), event("3", "MEMBER_c", "zdjd")]) == nil)
        #expect(QQInteractionPlan.repeatable([event("2", "MEMBER_b", "看 https://x.cn"), event("3", "MEMBER_c", "看 https://x.cn")]) == nil)
        #expect(QQInteractionPlan.repeatable([event("2", "MEMBER_b", "这是一句非常非常非常非常非常非常非常长的话呀"), event("3", "MEMBER_c", "这是一句非常非常非常非常非常非常非常长的话呀")]) == nil)
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
}
