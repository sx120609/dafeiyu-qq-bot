import Foundation
import Testing
@testable import BotCore

struct QQAgentPlanTests {
    let messages: Set<String> = ["11", "12", "13"], members: Set<String> = ["MEMBER_a"], emojis: Set<String> = ["76", "147"]
    let everything = QQAgentLevel.full.bubbleKinds

    @Test func aReplyKeepsOnlyWhatWasOffered() throws {
        let raw = #"""
        好的，我的决定：```json
        {"action":"reply","target":12,"quote":true,"bubbles":[
          {"kind":"text","text":"  第一句  "},{"kind":"text","text":""},{"kind":"text","text":"第二句"},{"kind":"text","text":"第三句"},{"kind":"text","text":"第四句"},
          {"kind":"sticker","describe":"得意叉腰"},{"kind":"sticker","describe":"第二张"},
          {"kind":"reaction","message":"11","emoji":"76"},{"kind":"reaction","message":"11","emoji":"147"},{"kind":"reaction","message":"99","emoji":"76"},
          {"kind":"poke","member":"MEMBER_x"},{"kind":"image","prompt":"一只猫"}],
         "note":"接住玩笑"}
        ```
        """#
        let plan = try #require(QQAgentPlan.decode(raw, messages: messages, members: members, emojis: emojis, kinds: everything))
        #expect(plan.action == .reply && plan.target == "12" && plan.quote && plan.note == "接住玩笑")
        // Only the first eight bubbles are read; three texts at most, one sticker, one reaction per message.
        #expect(plan.bubbles == [.text("第一句"), .text("第二句"), .text("第三句"), .sticker("得意叉腰"), .reaction(message: "11", emoji: "76")])
    }

    @Test func silenceWaitAndEmptyReplies() throws {
        #expect(QQAgentPlan.decode(#"{"action":"silence","note":"别人在聊"}"#, messages: messages, members: members, emojis: emojis, kinds: everything) == QQAgentPlan(action: .silence, note: "别人在聊"))
        let wait = try #require(QQAgentPlan.decode(#"{"action":"wait","wait_seconds":900}"#, messages: messages, members: members, emojis: emojis, kinds: everything))
        #expect(wait.action == .wait && wait.waitSeconds == 120)
        // Nothing sendable left: that is silence, not an empty reply.
        let empty = try #require(QQAgentPlan.decode(#"{"action":"reply","bubbles":[{"kind":"poke","member":"MEMBER_zz"}],"note":"x"}"#, messages: messages, members: members, emojis: emojis, kinds: everything))
        #expect(empty.action == .silence)
        // A target outside the batch is dropped, and with it the quote.
        let loose = try #require(QQAgentPlan.decode(#"{"action":"reply","target":"404","quote":true,"bubbles":[{"kind":"text","text":"在"},{"kind":"poke","member":"MEMBER_a"},{"kind":"image","prompt":"猫"},{"kind":"artwork"}]}"#, messages: messages, members: members, emojis: emojis, kinds: everything))
        #expect(loose.target == nil && !loose.quote && loose.bubbles == [.text("在"), .poke(member: "MEMBER_a"), .image("猫"), .artwork])
        #expect(QQAgentPlan.decode("不是 JSON", messages: messages, members: members, emojis: emojis, kinds: everything) == nil)
        #expect(QQAgentPlan.decode(#"{"action":"dance"}"#, messages: messages, members: members, emojis: emojis, kinds: everything) == nil)
        #expect(QQAgentPlan.pause(after: "") == 1.2 && QQAgentPlan.pause(after: String(repeating: "字", count: 500)) == 4)
    }

    /// The level decides what may be done: bubbles above it are dropped whatever the model writes.
    @Test func permissionLevelsBoundWhatTheAgentMayDo() throws {
        let raw = #"{"action":"reply","bubbles":[{"kind":"text","text":"好"},{"kind":"poke","member":"MEMBER_a"},{"kind":"image","prompt":"猫"},{"kind":"artwork"},{"kind":"reaction","message":"11","emoji":"76"}]}"#
        let basic = try #require(QQAgentPlan.decode(raw, messages: messages, members: members, emojis: emojis, kinds: QQAgentLevel.basic.bubbleKinds))
        #expect(basic.bubbles == [.text("好"), .reaction(message: "11", emoji: "76")])
        let standard = try #require(QQAgentPlan.decode(raw, messages: messages, members: members, emojis: emojis, kinds: QQAgentLevel.standard.bubbleKinds))
        #expect(standard.bubbles == [.text("好"), .poke(member: "MEMBER_a"), .reaction(message: "11", emoji: "76")])
        #expect(QQAgentLevel.basic.answersOnlyWhenCalled && !QQAgentLevel.standard.answersOnlyWhenCalled)
        #expect(!QQAgentLevel.basic.tools.contains("ask_helper") && QQAgentLevel.standard.tools.contains("browse_bilibili"))
        #expect(!QQAgentLevel.standard.tools.contains("save_sticker") && QQAgentLevel.full.tools.isSuperset(of: QQAgentLevel.standard.tools))
        // Management is offered at every level; who may do what is checked against the person asking.
        #expect(QQAgentLevel.allCases.allSatisfy { $0.tools.contains("manage_chat") && $0.tools.contains("model_info") })
    }

    @Test func replyModeForEveryChatOrChosenOnes() throws {
        var config = QQConfig()
        config.expectedSelfID = "12345"
        config.agentTargets = ["group:99999"]
        try config.validate()
        #expect(config.isAgent("group:99999") && !config.isAgent("group:88888") && !config.isAgent("private:54321"))
        config.agentForAll = true; config.classicTargets = ["private:54321"]
        config.agentLevels = ["group:99999": "basic", "group:88888": "full"]
        try config.validate()
        #expect(config.isAgent("group:88888") && config.isAgent("private:77777") && !config.isAgent("private:54321"))
        #expect(config.agentLevel("group:99999") == .basic && config.agentLevel("group:88888") == .full && config.agentLevel("private:77777") == .standard)
        config.agentLevels = ["group:99999": "god"]
        #expect(throws: (any Error).self) { try config.validate() }
        config.agentLevels = nil; config.classicTargets = ["channel:1"]
        #expect(throws: (any Error).self) { try config.validate() }
    }
}
