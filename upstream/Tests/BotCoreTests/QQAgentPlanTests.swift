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
        // Everything offered is kept; only what was not offered (an unknown message or member) is left out.
        #expect(plan.bubbles == [.text("第一句"), .text("第二句"), .text("第三句"), .text("第四句"), .sticker("得意叉腰"), .sticker("第二张"), .reaction(message: "11", emoji: "76"), .image("一只猫")])
        // Past five messages, the rest joins the fifth instead of being lost.
        let chatty = try #require(QQAgentPlan.decode(#"{"action":"reply","bubbles":[{"kind":"text","text":"1"},{"kind":"text","text":"2"},{"kind":"text","text":"3"},{"kind":"text","text":"4"},{"kind":"text","text":"5"},{"kind":"text","text":"6"}]}"#, messages: messages, members: members, emojis: emojis, kinds: everything))
        #expect(chatty.bubbles.last == .text("5\n6"))
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

    /// Mentions, taking back its own messages, reminders and likes: each only with what the program offered.
    @Test func mentionsRecallsRemindersAndLikes() throws {
        let raw = #"{"action":"reply","bubbles":[{"kind":"text","text":"好","at":"MEMBER_a"},{"kind":"text","text":"嗯","at":"MEMBER_zz"},{"kind":"recall","message":"501"},{"kind":"recall","message":"11"},{"kind":"later","minutes":5000,"about":"提醒 MEMBER_a 取快递","say":"快递！"},{"kind":"later","cancel":"r1"},{"kind":"later","cancel":"r9"},{"kind":"like","member":"MEMBER_a","times":30}]}"#
        let plan = try #require(QQAgentPlan.decode(raw, messages: messages, members: members, emojis: emojis, kinds: everything, own: ["501"], reminders: ["r1"]))
        #expect(plan.bubbles == [.text("好", at: "MEMBER_a"), .text("嗯"), .recall(message: "501"), .later(minutes: 1440, about: "提醒 MEMBER_a 取快递", say: "快递！"), .cancelLater("r1"), .like(member: "MEMBER_a", times: 10)])
        #expect(!plan.wordless)
        // At the basic level there are no reminders or likes; recall stays.
        let basic = try #require(QQAgentPlan.decode(raw, messages: messages, members: members, emojis: emojis, kinds: QQAgentLevel.basic.bubbleKinds, own: ["501"], reminders: ["r1"]))
        #expect(basic.bubbles == [.text("好", at: "MEMBER_a"), .text("嗯"), .recall(message: "501")])
        // Silence, or only a reaction or a poke, is wordless: nobody can read anything.
        let react = try #require(QQAgentPlan.decode(#"{"action":"reply","bubbles":[{"kind":"reaction","message":"11","emoji":"76"},{"kind":"poke","member":"MEMBER_a"}]}"#, messages: messages, members: members, emojis: emojis, kinds: everything))
        #expect(react.wordless && QQAgentPlan(action: .silence).wordless && !QQAgentPlan(action: .wait).wordless)
        // Action tools map onto the same checked bubbles.
        let sent = try #require(QQAgentPlan.toolBubble("send_message", #"{"text":"好","at":"MEMBER_a","quote":"11"}"#))
        #expect(sent.quote == "11" && sent.bubble["kind"] as? String == "text" && sent.bubble["at"] as? String == "MEMBER_a")
        #expect(QQAgentPlan.toolBubble("send_sticker", #"{"id":"local-abc"}"#)?.bubble["describe"] as? String == "local-abc")
        #expect(QQAgentPlan.toolBubble("cancel_reminder", #"{"id":"r1"}"#)?.bubble["cancel"] as? String == "r1")
        #expect(QQAgentPlan.toolBubble("search_chat_history", "{}") == nil)
        #expect(QQAgentPlan.nudge.contains("send_message"))
        #expect(QQAgentLevel.standard.tools.isSuperset(of: ["group_info", "remember", "member_info"]) && QQAgentLevel.basic.tools.contains("member_info"))
        #expect(QQAgentLevel.full.groupAdmin && !QQAgentLevel.standard.groupAdmin)
        // A voice message counts as saying something; the basic level has none.
        let voice = #"{"action":"reply","bubbles":[{"kind":"voice","text":"哼，叫我干嘛"}]}"#
        #expect(try #require(QQAgentPlan.decode(voice, messages: messages, members: members, emojis: emojis, kinds: everything)).bubbles == [.voice("哼，叫我干嘛")])
        #expect(!(try #require(QQAgentPlan.decode(voice, messages: messages, members: members, emojis: emojis, kinds: everything))).wordless)
        #expect(try #require(QQAgentPlan.decode(voice, messages: messages, members: members, emojis: emojis, kinds: QQAgentLevel.basic.bubbleKinds)).action == .silence)
    }

    @Test func permissionLevelsPerChat() throws {
        var config = QQConfig()
        config.expectedSelfID = "12345"
        config.agentLevels = ["group:99999": "basic", "group:88888": "standard"]
        try config.validate()
        #expect(config.agentLevel("group:99999") == .basic && config.agentLevel("group:88888") == .standard && config.agentLevel("private:77777") == .full)
        config.agentLevels = ["group:99999": "god"]
        #expect(throws: (any Error).self) { try config.validate() }
        config.agentLevels = ["channel:1": "basic"]
        #expect(throws: (any Error).self) { try config.validate() }
    }
}
