import Testing
@testable import WeChatAIBot

struct QQBilibiliLiveTests {
    @Test func liveToolRequiresOnlineAndUsesReadOnlyScheduling() throws {
        func names(_ online: Bool) -> [String] {
            DeepSeekClient.agentTools(online: online).compactMap { ($0["function"] as? [String: Any])?["name"] as? String }
        }
        #expect(!names(false).contains("watch_bilibili_live"))
        #expect(names(true).filter { $0 == "watch_bilibili_live" }.count == 1)
        #expect(DeepSeekClient.agentLookups.contains("watch_bilibili_live"))
        #expect(QQCompanionTools.names.contains("watch_bilibili_live"))
        let tool = try #require(DeepSeekClient.agentTools(online: true).first {
            ($0["function"] as? [String: Any])?["name"] as? String == "watch_bilibili_live"
        }?["function"] as? [String: Any])
        let parameters = try #require(tool["parameters"] as? [String: Any])
        #expect(parameters["required"] as? [String] == ["query"])
    }
}
