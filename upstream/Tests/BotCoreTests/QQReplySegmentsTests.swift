import Testing
@testable import BotCore

struct QQReplySegmentsTests {
    @Test func blankLinesBecomeSeparateMessages() {
        var persona = QQPersona(); persona.maxCharacters = 800
        let reply = persona.decode(#"{"text":"在呢\n\n刚看了下，那家店周三休息\n要不换周四？","emotion":"joy","intensity":1}"#, input: "")
        #expect(!reply.isFallback)
        #expect(reply.segments == ["在呢", "刚看了下，那家店周三休息\n要不换周四？"])
        let many = persona.decode(#"{"text":"1\n\n2\n\n3\n\n4\n\n5\n\n6\n\n7","emotion":"neutral","intensity":0}"#, input: "")
        #expect(many.segments == ["1", "2", "3\n4\n5\n6\n7"])
    }
    @Test func pagesBehindAReplyAreKeptButNeverSent() {
        var persona = QQPersona(); persona.maxCharacters = 800
        let reply = persona.decode(#"{"text":"测评里排第十，7 分","emotion":"neutral","intensity":1,"sources":["https://example.com/rank","javascript:alert(1)","https://example.com/rank","https://b.example/x y"]}"#, input: "")
        #expect(reply.text == "测评里排第十，7 分"); #expect(reply.segments == ["测评里排第十，7 分"])
        #expect(reply.sources == ["https://example.com/rank"])
        #expect(reply.remembered.contains("https://example.com/rank")); #expect(!reply.text.contains("http"))
        let plain = persona.decode(#"{"text":"在呢","emotion":"joy","intensity":1}"#, input: "")
        #expect(plain.sources.isEmpty); #expect(plain.remembered == "在呢")
    }
    @Test func lenientDecodingKeepsUsableReplies() {
        var persona = QQPersona(); persona.maxCharacters = 800
        let extra = persona.decode(#"{"text":"好","emotion":"happy","intensity":9,"sticker_id":null}"#, input: "")
        #expect(!extra.isFallback && extra.text == "好" && extra.emotion == .neutral && extra.intensity == 1)
        let link = persona.decode(#"{"text":"在这 https://example.org/a","emotion":"neutral","intensity":1}"#, input: "")
        #expect(!link.isFallback)
        let fenced = persona.decode("```json\n{\"text\":\"嗯\"}\n```", input: "")
        #expect(!fenced.isFallback && fenced.text == "嗯")
        #expect(persona.decode(#"{"text":"[CQ:image,file=x]"}"#, input: "").isFallback)
        #expect(persona.decode("not json", input: "").isFallback)
        // An object wrapped in a sentence is still the reply; plain words can stand in for one.
        let wrapped = persona.decode("好的，回复如下：{\"text\":\"在呢\",\"emotion\":\"joy\",\"intensity\":1} 以上", input: "")
        #expect(!wrapped.isFallback && wrapped.text == "在呢")
        #expect(persona.prose("Deepseek 才不会委屈,它连情绪都没有")?.text == "Deepseek 才不会委屈，它连情绪都没有")
        #expect(persona.prose("{\"text\":") == nil); #expect(persona.prose("   ") == nil); #expect(persona.prose("[CQ:image,file=x]") == nil)
    }
    @Test func asciiPunctuationInChineseBecomesFullWidth() {
        var persona = QQPersona(); persona.maxCharacters = 800
        let reply = persona.decode(#"{"text":"艾斯比是吧,听懂了。骂人这么大声,是想吸引本鱼注意?","emotion":"neutral","intensity":1}"#, input: "")
        #expect(reply.text == "艾斯比是吧，听懂了。骂人这么大声，是想吸引本鱼注意？")
        #expect(QQPersona.chinesePunctuation("群主是lss,刚才?!") == "群主是lss，刚才？！")
        #expect(QQPersona.chinesePunctuation("价格 1,000 元, OK! 看 https://a.cn/x?y=1,2 好的:)") == "价格 1,000 元， OK! 看 https://a.cn/x?y=1,2 好的:)")
        #expect(QQPersona.chinesePunctuation("注意:\n第一,别急") == "注意：\n第一，别急")
    }
    @Test func followUpPartsArriveAtTypingPace() {
        #expect(QQReply.typingPause(for: "嗯", jitter: 1) == 1.5)                         // short parts still wait a moment
        #expect(abs(QQReply.typingPause(for: String(repeating: "字", count: 30), jitter: 1) - 5.8) < 0.001)
        #expect(QQReply.typingPause(for: String(repeating: "字", count: 300), jitter: 1) == 8) // never a long silence
        let jittered = (0..<20).map { _ in QQReply.typingPause(for: String(repeating: "字", count: 18)) }
        #expect(jittered.allSatisfy { (3.23...4.37).contains($0) })
    }
    @Test func longRepliesAreAllowedUpToTheSetting() {
        var persona = QQPersona(); persona.maxCharacters = 800
        let long = String(repeating: "很长的一句话。", count: 80)
        let reply = persona.decode(#"{"text":""# + long + #"","emotion":"neutral","intensity":0}"#, input: "")
        #expect(reply.text.count <= 800 && reply.text.count > 400)
    }
}
