import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct QQCompanionTools {
    static let entries: [(String, String, String, Bool)] = [
        ("watch_bilibili_live", "输入直播间号或主播名，读取B站公开直播状态、标题、分区和人气，尝试截取一帧并读取最近弹幕样本。", "query", true),
        ("browse_web", "根据简短关键词搜索并阅读公开内容，可用于找资料、新鲜事和聊天话题。关键词不包含私人聊天或身份资料。", "query", true),
        ("read_webpage", "打开并阅读一个公开网页的正文，比如对方发的链接或搜索结果里的页面。", "url", true),
        ("browse_videos", "浏览公开视频列表，空关键词为热门列表。此操作仅看列表与简介，不等于看过视频内容。", "query", false),
        ("inspect_video", "查看用户提供的 Bilibili BV号、链接或直接公开 MP4/WebM 链接，尝试读取字幕和前35秒抽帧。按实际证据说话，不声称看完整段或听过音轨。", "video", true),
        ("get_weather", "查询指定城市的当前天气和短期预报。城市不明时先问，不推断用户位置。", "city", true),
        ("calculate", "计算数字、括号、四则和幂运算，不能执行代码。", "expression", true),
        ("get_time", "读取当前准确时间，默认北京时间 Asia/Shanghai，也可传入 IANA 时区。", "timezone", false),
        ("get_recent_activity", "读取机器人真实浏览过的公开内容记录，回答最近在看什么或找个话题。不能编造没有记录的经历。", "", false),
        ("get_my_usage", "查你自己（大肥鱼）吃了多少 token、调用了几次模型、折合花了多少钱。有人问你饭量、吃了多少 token、花了多少钱时用。days 填 1（今天）、7 或 30。", "days", false)
    ]
    static var names: Set<String> { Set(entries.map { $0.0 }) }
    static var definitions: [[String: Any]] {
        guard ProcessInfo.processInfo.environment["DAFEIYU_CODEX_URL"] != nil else { return [] }
        return entries.map { name, description, field, required in
            ["type": "function", "function": ["name": name, "description": description,
                "parameters": ["type": "object", "properties": field.isEmpty ? [:] : [field: ["type": "string"]],
                               "required": required ? [field] : [], "additionalProperties": false]]] as [String: Any]
        }
    }
    static func execute(name: String, arguments: String, key: String, scope: String, sourceText: String) async throws -> ModelToolResult {
        guard names.contains(name), arguments.utf8.count <= 8192,
              let args = try? JSONSerialization.jsonObject(with: Data(arguments.utf8)) as? [String: Any],
              let base = ProcessInfo.processInfo.environment["DAFEIYU_CODEX_URL"],
              let url = URL(string: base + "/tools/execute"), url.scheme == "http", url.host == "127.0.0.1" else {
            return ModelToolResult(content: "工具参数或本机接口无效，未执行。")
        }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 600
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["name": name, "arguments": args, "scope": scope, "sourceText": String(sourceText.prefix(12000))])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 100_000,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = object["content"] as? String else {
            return ModelToolResult(content: "本次工具调用未完成，不要声称已查看或已完成。")
        }
        let sources = (object["sources"] as? [String] ?? []).filter { QQOnlineTools.publicLink($0) != nil }
        return ModelToolResult(content: String(content.prefix(8000)), sources: Array(sources.prefix(2)))
    }
}
