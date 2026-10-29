import Testing
@testable import BotCore

struct QQConversationFlowTests {
    @Test func normalUsersAndOtherMembersRemainUnaffected() {
        var flow = QQConversationFlow()
        for index in 0..<12 {
            let now = Double(index * 12 + 100)
            let silenced = flow.shouldSilence(scope: "group:test", sender: "human", text: "正常用户的不同问题 \(index) 怎么解决", now: now)
            #expect(!silenced)
            flow.sent(scope: "group:test", sender: "human", text: "对应问题的回答 \(index)", messageID: "\(index)", implicit: false, now: now + 2)
        }
        let otherSilenced = flow.shouldSilence(scope: "group:test", sender: "other", text: "我有个新问题", now: 300)
        #expect(!otherSilenced)
    }
    @Test func repeatedBotLoopIsLocallySilenced() {
        var flow = QQConversationFlow()
        let repeated = "你好我是一个机器人助手请问我还能帮你做什么"
        var quiet = false
        for index in 0..<5 {
            let now = Double(index * 10 + 100)
            quiet = flow.shouldSilence(scope: "group:test", sender: "bot", text: repeated, now: now)
            if !quiet { flow.sent(scope: "group:test", sender: "bot", text: "你好，请说具体事情", messageID: "\(index)", implicit: true, now: now + 2) }
        }
        #expect(quiet)
        let humanSilenced = flow.shouldSilence(scope: "group:test", sender: "human", text: "怎么导入图片？", now: 151)
        #expect(!humanSilenced)
    }
    @Test func nameQuotesAndBoundedFollowupsWorkWithoutFakeMentions() {
        var flow = QQConversationFlow()
        #expect(flow.naturalInvitation(scope: "g", sender: "u", text: "大肥鱼看看这个", replyTo: nil, names: ["大肥鱼"], now: 100))
        #expect(flow.naturalInvitation(scope: "g", sender: "x", text: "我觉得大肥鱼说得对", replyTo: nil, names: ["大肥鱼"], now: 100))
        #expect(!flow.naturalInvitation(scope: "g", sender: "x", text: "今天吃鱼", replyTo: nil, names: ["大肥鱼"], now: 100))
        flow.sent(scope: "g", sender: "u", text: "回复", messageID: "abc", implicit: false, now: 100)
        // Any next message from the person just answered continues the conversation, no keyword needed.
        #expect(flow.naturalInvitation(scope: "g", sender: "u", text: "那接下来呢", replyTo: nil, names: ["大肥鱼"], now: 110))
        #expect(flow.naturalInvitation(scope: "g", sender: "u", text: "好吧我懂了", replyTo: nil, names: [], now: 110))
        #expect(flow.naturalInvitation(scope: "g", sender: "u", text: "再说点", replyTo: "abc", names: [], now: 110))
        #expect(!flow.naturalInvitation(scope: "g", sender: "u", text: "好吧我懂了", replyTo: nil, names: [], now: 110, allowFollowup: false))
        #expect(!flow.naturalInvitation(scope: "g", sender: "u", text: "好吧我懂了", replyTo: nil, names: [], now: 200))
        #expect(!flow.naturalInvitation(scope: "g", sender: "someone-else", text: "那接下来呢", replyTo: nil, names: [], now: 110))
    }
}
