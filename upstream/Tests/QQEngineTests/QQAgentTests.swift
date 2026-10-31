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

    /// A batch of group messages goes to the director once; its plan is sent bubble by bubble (the first text
    /// quoting the target), reactions land, and a silent plan sends nothing. No counter or keyword is involved.
    @Test func directorDecidesEachBatchAndThePlanIsCarriedOut() async throws {
        var plans = [#"{"action":"reply","target":"2","quote":true,"bubbles":[{"kind":"text","text":"第一句"},{"kind":"text","text":"第二句"},{"kind":"reaction","message":"1","emoji":"76"}],"note":"接住两个人"}"#,
                     #"{"action":"silence","note":"他们在互相聊"}"#]
        AgentModelProtocol.reset { purpose, _ in ["content": purpose == "director" && !plans.isEmpty ? plans.removeFirst() : #"{"action":"silence"}"#] }
        let rig = try await rig(); defer { rig.stop() }
        let engine = rig.engine
        engine.add(try #require(engine.contacts.first { $0.number == "99999" }))
        engine.config.targets[0].enabled = true
        try engine.saveReplyMode(forAll: false, agent: ["group:99999", "group:12121"], classic: [], levels: [:]) // a chat not on the list is dropped
        #expect(engine.config.agentTargets == ["group:99999"])
        engine.start()
        // Neither message mentions the bot; in agent mode that is the director's call, not the program's.
        try rig.batch([group(1, 54321, "今天食堂的红烧肉绝了"), group(2, 54322, "真的假的，明天去试试")])
        try await wait { engine.sends.confirmed >= 2 }
        try #require(engine.sends.confirmed == 2)
        let directed = AgentModelProtocol.calls.filter { $0.purpose == "director" }
        #expect(directed.count == 1) // both messages in one batch
        #expect(directed.first?.input.contains("这一批新消息（从旧到新）：1、2") == true)
        #expect(directed.first?.input.contains("标准权限") == true)
        #expect(rig.payloads() == [["reply:2", "text:第一句"], ["text:第二句"]])
        try await wait({ FileManager.default.fileExists(atPath: rig.directory.appendingPathComponent("reactions").path) }, seconds: 3)
        let reactions = (try? String(contentsOf: rig.directory.appendingPathComponent("reactions"), encoding: .utf8)) ?? ""
        #expect(reactions.contains("\"76\"") && reactions.contains("\"1\""))
        #expect(engine.decisions.contains { $0.text.contains("红烧肉") && $0.outcome.hasPrefix("交给代理") })
        // The agent page sees the turn: what came in, what it decided, what was sent.
        let turn = try #require(engine.agentTurns.first)
        #expect(turn.decision == "reply" && turn.note == "接住两个人" && turn.batch.count == 2 && turn.sent.first == "说「第一句」")
        // The next batch: the director stays quiet, nothing is sent, and it says why.
        try rig.batch([group(3, 54321, "你去哪个食堂"), group(4, 54322, "二食堂")])
        try await wait { engine.agentTurns.count == 2 && engine.agentTurns.last?.decision == "silence" }
        #expect(engine.agentTurns.last?.note == "他们在互相聊")
        #expect(engine.sends.confirmed == 2)
        #expect(AgentModelProtocol.calls.filter { $0.purpose == "director" }.last?.input.contains("你最近在这里做过的事") == true)
    }

    /// Private chats run in agent mode too, slash commands become requests the agent handles, and the program
    /// checks the asker's rights: a member cannot get someone blocked, an admin can. At the basic level the
    /// agent only looks when it is called.
    @Test func privateChatsCommandsAndPermissionLevels() async throws {
        // The director asks manage_chat to block 77777 on behalf of message 21, then repeats what the tool said.
        AgentModelProtocol.reset { purpose, messages in
            guard purpose == "director" else { return ["content": #"{"action":"silence"}"#] }
            if let tool = messages.last(where: { $0["role"] as? String == "tool" })?["content"] as? String {
                let said = tool.components(separatedBy: "\n").dropFirst().joined(separator: " ")
                return ["content": String(decoding: try! JSONSerialization.data(withJSONObject: ["action": "reply", "bubbles": [["kind": "text", "text": said]], "note": "照实转告"]), as: UTF8.self)]
            }
            let input = messages.dropFirst().compactMap { $0["content"] as? String }.joined()
            let asked = input.contains("\"message\":\"22\"") ? "22" : "21"
            return ["content": "", "tool_calls": [["id": "call-\(asked)", "type": "function",
                    "function": ["name": "manage_chat", "arguments": #"{"action":"block","argument":"77777","requested_by":"\#(asked)"}"#]]]]
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
        #expect(engine.agentTurns.last?.errands.first?.tool == "manage_chat")
        // The same request from an admin goes through.
        engine.config.adminIDs = ["54321"]
        try rig.batch([friend(22, "帮我把 77777 拉黑")])
        try await wait { engine.sends.confirmed >= 2 }
        #expect(engine.config.isBlocked("77777"))
        #expect(rig.payloads().last?.contains { $0.contains("已拉黑 77777") } == true)
        // Basic level in the group: a message that does not call the bot never reaches the director.
        let before = AgentModelProtocol.calls.filter { $0.purpose == "director" }.count
        try rig.batch([group(31, 54322, "随便聊聊天气")])
        try await wait({ engine.decisions.contains { $0.text == "随便聊聊天气" } }, seconds: 3)
        #expect(engine.decisions.contains { $0.text == "随便聊聊天气" && $0.outcome.contains("基础权限") })
        try await Task.sleep(nanoseconds: 1_000_000_000)
        #expect(AgentModelProtocol.calls.filter { $0.purpose == "director" }.count == before)
    }
}
