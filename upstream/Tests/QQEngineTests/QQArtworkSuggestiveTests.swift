import Testing
@testable import WeChatAIBot

struct QQArtworkSuggestiveTests {
    @Test @MainActor func borderlineWorksAreSkippedInEveryMode() {
        for tags in [["オリジナル", "水着"], ["女の子", "R-15"], ["swimsuit"], ["原神", "巨乳"], ["涩图合集"], ["夏日福利"]] {
            #expect(QQArtworkLibrary.suggestive(tags), "\(tags)")
        }
        for tags in [["オリジナル", "女の子", "風景"], ["初音ミク", "VOCALOID"], ["猫", "ねこ"], []] {
            #expect(!QQArtworkLibrary.suggestive(tags), "\(tags)")
        }
    }
}
