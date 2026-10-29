import Testing
@testable import BotCore

struct QQModelIdentityTests {
    @Test func recognizesPublicModelQuestions() {
        for value in ["/model", "你用的什么模型？", "你的具体模型是什么", "大肥鱼，你底层是什么模型", "what model are you using?"] {
            #expect(QQModelIdentity.isQuestion(value))
        }
        for value in ["你推荐什么模型？", "对比两个模型", "今天吃什么", "我在训练模型"] {
            #expect(!QQModelIdentity.isQuestion(value))
        }
    }
}
