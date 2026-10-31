import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
import BotCore
@testable import WeChatAIBot

/// A scripted model: `respond` gets the purpose and the request's messages and returns the assistant message
/// (content, or tool_calls). Every call is kept with its purpose and input text.
private final class AgentModelProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var respond: (String, [[String: Any]]) -> [String: Any] = { _, _ in ["content": #"{"action":"silence"}"#] }
    nonisolated(unsafe) private static var seen: [(purpose: String, input: String)] = []
    static func reset(_ script: @escaping (String, [[String: Any]]) -> [String: Any]) { lock.lock(); respond = script; seen = []; lock.unlock() }
    static var calls: [(purpose: String, input: String)] { lock.lock(); defer { lock.unlock() }; return seen }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }; var bytes = [UInt8](repeating: 0, count: 8192)
            while stream.hasBytesAvailable { let n = stream.read(&bytes, maxLength: bytes.count); if n <= 0 { break }; data.append(contentsOf: bytes.prefix(n)) }
        }
        let object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let purpose = ((object["metadata"] as? [String: Any])?["dafeiyu_purpose"] as? String) ?? "chat"
        let messages = object["messages"] as! [[String: Any]]
        let input = messages.dropFirst().compactMap { $0["content"] as? String }.joined(separator: "\n")
        Self.lock.lock(); Self.seen.append((purpose, input)); let script = Self.respond; Self.lock.unlock()
        let message = script(purpose, messages)
        let result: [String: Any] = ["choices": [["message": message, "finish_reason": message["tool_calls"] == nil ? "stop" : "tool_calls"]], "usage": ["total_tokens": 10]]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: result)); client?.urlProtocolDidFinishLoading(self)
    }
}

@Suite(.serialized) @MainActor struct QQAgentTests {
    @MainActor private struct Rig {
        let directory: URL, server: Process, session: URLSession, engine: QQEngine
        func batch(_ rows: [[String: Any]]) throws {
            try JSONSerialization.data(withJSONObject: rows).write(to: directory.appendingPathComponent("event-batch"), options: .atomic)
        }
        /// Each payload's message segments, as "type:text-or-id".
        func payloads() -> [[String]] {
            ((try? String(contentsOf: directory.appendingPathComponent("payloads"), encoding: .utf8)) ?? "").split(separator: "\n").map { line in
                let message = (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])?["message"] as? [[String: Any]] ?? []
                return message.map { segment -> String in
                    let data = segment["data"] as? [String: Any] ?? [:]
                    return (segment["type"] as? String ?? "") + ":" + ((data["text"] as? String) ?? QQPolicy.identifier(data["id"]) ?? "")
                }
            }
        }
        func stop() { engine.pause(); engine.disconnect(); session.invalidateAndCancel(); if server.isRunning { server.terminate(); server.waitUntilExit() }; try? FileManager.default.removeItem(at: directory) }
    }
    private func rig() async throws -> Rig {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("group".utf8).write(to: directory.appendingPathComponent("message-shape"))
        let server = Process(), output = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("onebot_fixture.py").path, directory.path]
        server.standardOutput = output; try server.run()
        let port = try #require(Int(String(decoding: output.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        let cfg = URLSessionConfiguration.ephemeral; cfg.protocolClasses = [AgentModelProtocol.self]
        let session = URLSession(configuration: cfg)
        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory, modelClient: DeepSeekClient(session: session))
        engine.config.endpoint = "ws://127.0.0.1:\(port)"; engine.config.expectedSelfID = "12345"
        engine.config.effectiveVisionEnabled = false; engine.config.effectivePersona.stickersEnabled = false
        engine.config.ai.cooldownSeconds = 1; engine.config.ai.effectiveSendLimits.globalIntervalSeconds = 1
        engine.agentQuietSeconds = 0.4; engine.agentCollectSeconds = 2
        #expect(engine.useTemporaryCredentials(token: "synthetic-test-token", key: "synthetic-key"))
        await engine.connect(); try #require(engine.connected, "\(engine.error ?? engine.status)")
        return Rig(directory: directory, server: server, session: session, engine: engine)
    }
    private func group(_ id: Int, _ sender: Int, _ text: String) -> [String: Any] {
        ["post_type": "message", "self_id": 12345, "user_id": sender, "sender": ["user_id": sender, "card": "群友\(sender)"], "message_type": "group",
         "sub_type": "normal", "group_id": 99999, "message_id": id, "message": [["type": "text", "data": ["text": text]]]]
    }
    private func friend(_ id: Int, _ text: String) -> [String: Any] {
        ["post_type": "message", "self_id": 12345, "user_id": 54321, "sender": ["user_id": 54321], "message_type": "private",
         "sub_type": "friend", "message_id": id, "message": [["type": "text", "data": ["text": text]]]]
    }
    private func wait(_ condition: () -> Bool, seconds: Double = 8) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() && Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
    }

    /// Agent mode is a loop: the director acts through tools, each done at once and reported back, and decides the
    /// next step from what happened. A batch goes to it once; when it stays quiet nothing is sent and it says why.
    @Test func theAgentActsStepByStepAndSeesWhatHappened() async throws {
        AgentModelProtocol.reset { purpose, messages in
            guard purpose == "director" else { return ["content": "不用"] }
            guard opening(messages).contains("这一批新消息（从旧到新）：1、2") else { return ["content": "他们在互相聊"] }
            switch results(messages).count {
            case 0: return call("send_message", ["text": "第一句", "quote": "2"])
            case 1: return call("send_message", ["text": "第二句"])
            case 2: return call("react", ["message": "1", "emoji": "76"])
            default: return ["content": "接住两个人"]
            }
        }
        let rig = try await rig(); defer { rig.stop() }
        let engine = rig.engine
        engine.add(try #require(engine.contacts.first { $0.number == "99999" }))
        engine.config.targets[0].enabled = true
        try engine.saveReplyMode(forAll: false, agent: ["group:99999", "group:12121"], classic: [], levels: [:]) // a chat not on the list is dropped
        #expect(engine.config.agentTargets == ["group:99999"])
        engine.start()
        // Neither message mentions the bot; in agent mode that is the director's call, not the program's.
        try rig.batch([group(1, 54321, "今天食堂的红烧肉绝了"), group(2, 54322, "真的假的，明天去试试")])
        try await wait { engine.agentTurns.first?.note == "接住两个人" }
        #expect(rig.payloads() == [["reply:2", "text:第一句"], ["text:第二句"]])
        let directed = AgentModelProtocol.calls.filter { $0.purpose == "director" }
        #expect(directed.first?.input.contains("这一批新消息（从旧到新）：1、2") == true)
        #expect(directed.first?.input.contains("完全权限") == true) // the default level
        // Each step saw the result of the one before.
        #expect(directed.count == 4 && directed[1].input.contains("说「第一句」") && directed[3].input.contains("贴了"))
        try await wait({ FileManager.default.fileExists(atPath: rig.directory.appendingPathComponent("reactions").path) }, seconds: 3)
        let reactions = (try? String(contentsOf: rig.directory.appendingPathComponent("reactions"), encoding: .utf8)) ?? ""
        #expect(reactions.contains("\"76\"") && reactions.contains("\"1\""))
        #expect(engine.decisions.contains { $0.text.contains("红烧肉") && $0.outcome.hasPrefix("交给代理") })
        let turn = try #require(engine.agentTurns.first)
        #expect(turn.decision == "reply" && turn.batch.count == 2 && turn.sent.first == "说「第一句」" && turn.errands.map(\.tool) == ["send_message", "send_message", "react"])
        // Something it was not offered is refused, not carried out.
        #expect(engine.agentTurns.count == 1)
        // The next batch: it stays quiet (it had just spoken, so it is reminded once, and still keeps out of it).
        try rig.batch([group(3, 54321, "你去哪个食堂"), group(4, 54322, "二食堂")])
        try await wait { engine.agentTurns.count == 2 && engine.agentTurns.last?.decision == "silence" }
        #expect(engine.agentTurns.last?.note == "他们在互相聊")
        #expect(engine.sends.confirmed == 2)
        #expect(AgentModelProtocol.calls.filter { $0.purpose == "director" }.last?.input.contains("程序提醒") == true)
    }

    /// Someone talks to it and it is about to leave without a word: it is reminded once and then answers (with an @
    /// and a reminder for later). Sticker sends go out as 动画表情.
    @Test func spokenToButSilentIsRemindedOnce() async throws {
        AgentModelProtocol.reset { purpose, messages in
            guard purpose == "director" else { return ["content": "不用"] }
            let reminded = messages.contains { ($0["content"] as? String)?.hasPrefix("程序提醒") == true }
            guard reminded else { return ["content": "刚回过了"] }
            let input = opening(messages)
            let member = input.range(of: "MEMBER_[0-9a-f]{12}", options: .regularExpression).map { String(input[$0]) } ?? "MEMBER_x"
            switch results(messages).count {
            case 0: return call("send_message", ["text": "在呢在呢", "at": member])
            case 1: return call("set_reminder", ["minutes": 30, "about": "问问他饭吃了没", "say": "饭吃了没"])
            default: return ["content": "被点名了"]
            }
        }
        let rig = try await rig(); defer { rig.stop() }
        let engine = rig.engine
        engine.add(try #require(engine.contacts.first { $0.number == "99999" }))
        engine.config.targets[0].enabled = true
        try engine.saveReplyMode(forAll: true, agent: [], classic: [], levels: [:])
        engine.start()
        var called = group(31, 54321, " 你怎么不说话")
        called["message"] = [["type": "at", "data": ["qq": "12345"]], ["type": "text", "data": ["text": " 你怎么不说话"]]]
        try rig.batch([called])
        try await wait { engine.agentTurns.last?.note.hasSuffix("被点名了") == true }
        #expect(rig.payloads().first?.first == "at:")
        #expect(rig.payloads().first?.last == "text: 在呢在呢")
        #expect(engine.agentTurns.last?.note == "提醒后出声：被点名了")
        #expect(engine.agentReminders.count == 1 && engine.agentReminders.first?.about == "问问他饭吃了没")
        #expect(QQPolicy.stickerSegment(Data([1])).description.contains("动画表情"))
    }

    /// Someone reacts to the bot's own message: the agent gets a turn about it and answers.
    @Test func aReactionToItsMessageGetsAnAnswer() async throws {
        AgentModelProtocol.reset { purpose, messages in
            guard purpose == "director" else { return ["content": "不用"] }
            let input = opening(messages)
            if input.contains("贴了 😍") { return results(messages).isEmpty ? call("send_message", ["text": "被夸了，得意"]) : ["content": "回应了表情"] }
            return results(messages).isEmpty ? call("send_message", ["text": "第一句"]) : ["content": "回了"]
        }
        let rig = try await rig(); defer { rig.stop() }
        let engine = rig.engine
        engine.add(try #require(engine.contacts.first { $0.number == "99999" }))
        engine.config.targets[0].enabled = true
        try engine.saveReplyMode(forAll: true, agent: [], classic: [], levels: [:])
        engine.start()
        var called = group(51, 54321, " 在吗")
        called["message"] = [["type": "at", "data": ["qq": "12345"]], ["type": "text", "data": ["text": " 在吗"]]]
        try rig.batch([called])
        try await wait { engine.agentTurns.last?.note == "回了" }
        // The fixture gives every sent message id 99.
        try rig.batch([["post_type": "notice", "notice_type": "group_msg_emoji_like", "self_id": 12345, "group_id": 99999, "user_id": 54321,
                        "message_id": 99, "is_add": true, "likes": [["emoji_id": "128525", "count": 1]], "time": Date().timeIntervalSince1970]])
        try await wait({ engine.agentTurns.last?.note == "回应了表情" }, seconds: 12)
        #expect(engine.agentTurns.last?.batch.first?.hasPrefix("[表情]") == true)
        #expect(rig.payloads().last == ["text:被夸了，得意"])
    }

    /// A turn that fails before anything went out is tried again by itself with the same batch, and the records
    /// survive a restart.
    @Test func aFailedTurnIsRetriedAndTurnsAreKept() async throws {
        var failures = 1
        AgentModelProtocol.reset { purpose, messages in
            guard purpose == "director" else { return ["content": "不用"] }
            if failures > 0 { failures -= 1; return ["content": "", "tool_calls": "broken"] } // an unreadable reply: the turn throws
            return results(messages).isEmpty ? call("send_message", ["text": "刚才卡了下，在呢"]) : ["content": "重试成功"]
        }
        let rig = try await rig(); defer { rig.stop() }
        let engine = rig.engine
        engine.add(try #require(engine.contacts.first { $0.number == "99999" }))
        engine.config.targets[0].enabled = true
        try engine.saveReplyMode(forAll: true, agent: [], classic: [], levels: [:])
        engine.start()
        try rig.batch([group(41, 54321, "有人吗")])
        try await wait({ engine.agentTurns.last?.note == "重试成功" }, seconds: 12)
        #expect(rig.payloads().first == ["text:刚才卡了下，在呢"])
        #expect(engine.agentTurns.first?.note.contains("自动重试") == true)
        #expect(engine.agentTurns.last?.batch.first?.hasSuffix("有人吗") == true)
        // Saved with the state: a new engine on the same directory reads them back.
        let reread = QQEngine(allowAuthenticationUI: false, storageDirectory: rig.directory)
        #expect(reread.agentTurns.count == engine.agentTurns.count)
    }

    /// Private chats run in agent mode too, slash commands become requests the agent handles, and the program
    /// checks the asker's rights: a member cannot get someone blocked, an admin can. At the basic level the
    /// agent only looks when it is called.
    @Test func privateChatsCommandsAndPermissionLevels() async throws {
        // The agent asks manage_chat to block 77777 on behalf of the message, then tells the person what the tool said.
        AgentModelProtocol.reset { purpose, messages in
            guard purpose == "director" else { return ["content": "不用"] }
            let seen = results(messages)
            switch seen.count {
            case 0:
                let asked = opening(messages).contains("\"message\":\"22\"") ? "22" : "21"
                return call("manage_chat", ["action": "block", "argument": "77777", "requested_by": asked])
            case 1:
                let said = seen[0].components(separatedBy: "\n").dropFirst().joined(separator: " ")
                return call("send_message", ["text": said])
            default: return ["content": "照实转告"]
            }
        }
        let rig = try await rig(); defer { rig.stop() }
        let engine = rig.engine
        engine.add(try #require(engine.contacts.first { $0.number == "54321" && !$0.group }))
        engine.add(try #require(engine.contacts.first { $0.number == "99999" }))
        for index in engine.config.targets.indices { engine.config.targets[index].enabled = true }
        try engine.saveReplyMode(forAll: true, agent: [], classic: [], levels: ["group:99999": "basic"])
        engine.start()
        try rig.batch([friend(21, "/拉黑 77777")])
        try await wait { engine.sends.confirmed >= 1 }
        #expect(!engine.config.isBlocked("77777"))
        #expect(rig.payloads().last?.contains { $0.contains("只有管理员") } == true)
        try await wait { engine.agentTurns.last?.note == "照实转告" }
        #expect(engine.agentTurns.last?.errands.first?.tool == "manage_chat")
        // The same request from an admin goes through.
        engine.config.adminIDs = ["54321"]
        try rig.batch([friend(22, "帮我把 77777 拉黑")])
        try await wait { engine.sends.confirmed >= 2 }
        #expect(engine.config.isBlocked("77777"))
        #expect(rig.payloads().last?.contains { $0.contains("已拉黑 77777") } == true)
        // Basic level in the group: a message that does not call the bot never reaches the director. Counted once
        // the private chat's turn has fully finished.
        try await wait { engine.agentStates.allSatisfy { $0["thinkingSince"] == nil } && engine.agentTurns.last?.note == "照实转告" }
        try await Task.sleep(nanoseconds: 300_000_000)
        let before = AgentModelProtocol.calls.filter { $0.purpose == "director" }.count
        try rig.batch([group(31, 54322, "随便聊聊天气")])
        try await wait({ engine.decisions.contains { $0.text == "随便聊聊天气" } }, seconds: 3)
        #expect(engine.decisions.contains { $0.text == "随便聊聊天气" && $0.outcome.contains("基础权限") })
        try await Task.sleep(nanoseconds: 1_000_000_000)
        #expect(AgentModelProtocol.calls.filter { $0.purpose == "director" }.count == before)
    }
}

    /// One tool call as the scripted model's reply.
fileprivate func call(_ name: String, _ arguments: [String: Any]) -> [String: Any] {
    ["content": "", "tool_calls": [["id": "call-" + UUID().uuidString, "type": "function",
        "function": ["name": name, "arguments": String(decoding: try! JSONSerialization.data(withJSONObject: arguments), as: UTF8.self)]]]]
    }
    /// The tool results the model has seen so far in this turn, and the turn's first input.
fileprivate func results(_ messages: [[String: Any]]) -> [String] { messages.filter { $0["role"] as? String == "tool" }.compactMap { $0["content"] as? String } }
fileprivate func opening(_ messages: [[String: Any]]) -> String { messages.dropFirst().first?["content"] as? String ?? "" }

