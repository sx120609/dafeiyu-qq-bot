import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
import BotCore
@testable import WeChatAIBot
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// A private URLSession intercepts every model request; no real API or credentials are used.
private final class DelayedModelProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var pending: [DelayedModelProtocol] = []
    private static var cancellations = 0
    private var stopped = false
    private var completed = false
    private var capturedBody = ""
    static var counts: (started: Int, cancelled: Int, bodies: [String]) {
        lock.lock(); defer { lock.unlock() }
        return (pending.count, cancellations, pending.map(\.capturedBody))
    }
    static func reset() {
        lock.lock(); defer { lock.unlock() }
        pending = []; cancellations = 0
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); defer { Self.lock.unlock() }
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }; body.append(contentsOf: bytes.prefix(count))
            }
        }
        capturedBody = String(decoding: body, as: UTF8.self)
        Self.pending.append(self)
    }
    override func stopLoading() {
        Self.lock.lock(); defer { Self.lock.unlock() }
        if !stopped { stopped = true; Self.cancellations += 1 }
    }
    static func requireCancellation() async throws {
        // URLSession cancellation is asynchronous. Emitting URLProtocol callbacks
        // while Corelibs removes a cancelled task violates the mock's lifecycle.
        let deadline = Date().addingTimeInterval(2)
        while counts.cancelled == 0 && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        try #require(counts.cancelled > 0)
    }
    static func completePending(intensity: Int = 3, summary: Bool = false, participate: Bool? = true) {
        lock.lock()
        let active = pending.filter { !$0.stopped && !$0.completed }
        active.forEach { $0.completed = true }
        lock.unlock()
        for item in active {
            let response = HTTPURLResponse(url: item.request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            item.client?.urlProtocol(item, didReceive: response, cacheStoragePolicy: .notAllowed)
            if item.capturedBody.contains("[QQ_MEMORY_V2]") {
                let request = try! JSONSerialization.jsonObject(with: Data(item.capturedBody.utf8)) as! [String: Any]
                let messages = request["messages"] as! [[String: Any]]
                let input = try! JSONSerialization.jsonObject(with: Data((messages.last!["content"] as! String).utf8)) as! [String: Any]
                let source = (input["events"] as! [[String: Any]]).first!
                let delta: [String: Any] = ["summary": "当前会话中的合成资料", "changes": [["operation": "upsert", "replaces": [], "subject": source["subject"]!, "kind": "fact", "text": "当前会话的合成测试事实", "keywords": ["合成", "synthetic"], "importance": 2, "sourceID": source["id"]!, "evidence": String((source["text"] as! String).prefix(100)), "days": 90]]]
                let content = String(decoding: try! JSONSerialization.data(withJSONObject: delta), as: UTF8.self)
                let result: [String: Any] = ["choices": [["message": ["content": content], "finish_reason": "stop"]], "usage": ["total_tokens": 1]]
                item.client?.urlProtocol(item, didLoad: try! JSONSerialization.data(withJSONObject: result))
            } else if summary {
                item.client?.urlProtocol(item, didLoad: Data(#"{"choices":[{"message":{"content":"{\"summary\":\"用户喜欢蓝色，正在聊天。\"}"},"finish_reason":"stop"}],"usage":{"total_tokens":1}}"#.utf8))
            } else {
                var answer: [String: Any] = ["text": "好耶，给本鱼加饭！", "emotion": "joy", "intensity": intensity]
                if item.capturedBody.contains("[QQ_PARTICIPATION]"), let participate { answer["participate"] = participate }
                if let request = try? JSONSerialization.jsonObject(with: Data(item.capturedBody.utf8)) as? [String: Any],
                   let messages = request["messages"] as? [[String: Any]],
                   let prompt = messages.compactMap({ $0["content"] as? String }).first(where: { $0.contains("本轮可选表情 JSON：\n") }),
                   let raw = prompt.components(separatedBy: "本轮可选表情 JSON：\n").dropFirst().first,
                   let options = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [[String: String]] {
                    answer["sticker_id"] = options.first?["id"]
                }
                let content = String(decoding: try! JSONSerialization.data(withJSONObject: answer), as: UTF8.self)
                let result: [String: Any] = ["choices": [["message": ["content": content], "finish_reason": "stop"]], "usage": ["total_tokens": 1]]
                item.client?.urlProtocol(item, didLoad: try! JSONSerialization.data(withJSONObject: result))
            }
            item.client?.urlProtocolDidFinishLoading(item)
        }
    }
}

@Suite(.serialized) @MainActor struct QQEngineTests {
    @Test func disconnectReleasesRuntimeLockEvenWhenDescriptorWasDuplicated() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let server = Process(), output = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("onebot_fixture.py").path, directory.path]
        server.standardOutput = output; try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try #require(Int(String(decoding: output.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        defer { engine.disconnect() }
        engine.save(endpoint: "ws://127.0.0.1:\(port)", expectedSelfID: "12345")
        try #require(engine.useTemporaryCredentials(token: "synthetic-test-token", key: "synthetic-key"))
        await engine.connect(); try #require(engine.connected, "\(engine.error ?? engine.status)")
        let other = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        other.save(endpoint: "ws://127.0.0.1:3102")
        #expect(other.error != nil) // An active owner must still exclude other writers.

        let attributes = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("qq-engine.lock").path)
        let inode = try #require(attributes[.systemFileNumber] as? NSNumber)
        let device = try #require(attributes[.systemNumber] as? NSNumber)
        var lockDescriptor: Int32?
        for descriptor in try FileManager.default.contentsOfDirectory(atPath: "/dev/fd").compactMap(Int32.init) {
            var info = stat()
            if fstat(descriptor, &info) == 0 && UInt64(info.st_ino) == inode.uint64Value && UInt64(info.st_dev) == device.uint64Value {
                lockDescriptor = descriptor; break
            }
        }
        let descriptor = try #require(lockDescriptor)
        #expect(fcntl(descriptor, F_GETFD) & FD_CLOEXEC != 0)
        // dup models the shared open-file description inherited during fork,
        // without forking a multithreaded Swift test process.
        let inherited = dup(descriptor); try #require(inherited >= 0)
        defer { close(inherited) }
        engine.disconnect()
        let reopened = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        reopened.save(endpoint: "ws://127.0.0.1:3102")
        #expect(reopened.error == nil)
        #expect(QQEngine(allowAuthenticationUI: false, storageDirectory: directory).config.endpoint == "ws://127.0.0.1:3102")
        #expect(!engine.running && engine.usage.calls == 0 && engine.sends.attempts == 0)
    }

    @Test func savedReplyScopeAndWorkHoursSurviveReopeningWithoutStarting() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        engine.config.expectedSelfID = "12345"
        engine.config.targets = [QQTarget(number: "54321", name: "合成好友", group: false), QQTarget(number: "99999", name: "合成群", group: true)]
        var ai = engine.config.ai
        ai.workHoursEnabled = true; ai.workStart = 22; ai.workEnd = 7
        engine.saveReplySettings(ai: ai, persona: engine.config.effectivePersona, enabledTargets: ["group:99999"])
        try #require(engine.error == nil)
        let reopened = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        #expect(reopened.config.targets.filter(\.enabled).map(\.key) == ["group:99999"])
        #expect(reopened.config.ai.workHoursEnabled && reopened.config.ai.workStart == 22 && reopened.config.ai.workEnd == 7)
        #expect(!engine.running && !reopened.running && engine.sends.attempts == 0)
        let saved = engine.config
        engine.saveReplySettings(ai: ai, persona: engine.config.effectivePersona, enabledTargets: ["group:11111"])
        #expect(engine.error != nil); #expect(engine.config == saved)
        engine.saveReplySettings(ai: ai, persona: engine.config.effectivePersona, enabledTargets: [])
        #expect(engine.error == nil); #expect(engine.config.targets.allSatisfy { !$0.enabled })
    }

    @Test func rejectedConnectionAndStaleReplySaveRestoreInMemoryConfiguration() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        engine.save(endpoint: "ws://127.0.0.1:3101", expectedSelfID: "12345")
        try #require(engine.error == nil)
        let saved = engine.config
        engine.save(endpoint: "ws://example.invalid:3101", expectedSelfID: "54321")
        #expect(engine.error != nil); #expect(engine.config == saved)
        let other = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        other.save(endpoint: "ws://127.0.0.1:3102")
        try #require(other.error == nil)
        var ai = saved.ai; ai.dailyLimit = 17
        engine.saveReplySettings(ai: ai, persona: saved.effectivePersona)
        #expect(engine.error != nil); #expect(engine.config == saved)
        let reopened = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        #expect(reopened.config.endpoint == "ws://127.0.0.1:3102")
        #expect(reopened.config.ai.dailyLimit == saved.ai.dailyLimit)
    }

    @Test(arguments: ["add", "remove"])
    func staleRosterEditDoesNotChangeDisplayedOrSavedTargets(_ operation: String) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        engine.save(expectedSelfID: "12345")
        engine.add(QQContact(number: "54321", name: "合成好友", group: false))
        try #require(engine.error == nil)
        let targets = engine.config.targets
        let other = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        other.save(endpoint: "ws://127.0.0.1:3102")
        try #require(other.error == nil)
        if operation == "add" { engine.add(QQContact(number: "99999", name: "合成群", group: true)) }
        else { engine.remove(targets[0].id) }
        #expect(engine.error != nil)
        #expect(engine.config.targets == targets)
        let reopened = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        #expect(reopened.config.targets == targets)
        #expect(reopened.config.endpoint == "ws://127.0.0.1:3102")
    }

    @Test(arguments: ["capture", "pause", "clear", "timed"])
    func structuredMemoryLearnsWithoutSendingAndSurvivesPause(mode: String) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("groupParticipation".utf8).write(to: directory.appendingPathComponent("message-shape"))
        if mode == "timed" {
            let seed = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
            seed.config.expectedSelfID = "12345"; seed.save()
            let file = directory.appendingPathComponent("qq-state.json")
            var stored = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
            var book = QQMemoryBook()
            book.append(QQMemoryEvent(id: "-10", subject: "OWNER", text: "合成的昨日约定", at: Date().addingTimeInterval(-601)))
            stored["memoryBooks"] = ["12345:group:99999": try JSONSerialization.jsonObject(with: JSONEncoder().encode(book))]
            try JSONSerialization.data(withJSONObject: stored).write(to: file)
        }
        let server = Process(), output = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("onebot_fixture.py").path, directory.path]
        server.standardOutput = output; try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try #require(Int(String(decoding: output.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        DelayedModelProtocol.reset()
        let cfg = URLSessionConfiguration.ephemeral; cfg.protocolClasses = [DelayedModelProtocol.self]
        let session = URLSession(configuration: cfg)
        defer { session.invalidateAndCancel(); DelayedModelProtocol.reset() }
        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory, modelClient: DeepSeekClient(session: session))
        defer { engine.disconnect() }
        engine.config.endpoint = "ws://127.0.0.1:\(port)"; engine.config.expectedSelfID = "12345"
        engine.config.memoryEnabled = true; engine.config.effectiveMemoryOptions.messageThreshold = 4
        engine.config.agentLevels = ["group:99999": "basic"]
        #expect(engine.useTemporaryCredentials(token: "synthetic-test-token", key: "synthetic-key"))
        await engine.connect(); try #require(engine.connected, "\(engine.error ?? engine.status)")
        engine.add(try #require(engine.contacts.first { $0.number == "99999" && $0.group }))
        engine.config.targets[0].enabled = true; engine.start(); try #require(engine.running)
        if mode != "timed" {
            let events: [[String: Any]] = (1...4).map { id in
                let sender = id == 2 ? 12345 : 54321
                return ["post_type": id == 2 ? "message_sent" : "message", "self_id": 12345, "user_id": sender, "sender": ["user_id": sender], "message_type": "group", "sub_type": "normal", "group_id": 99999, "message_id": id, "message": [["type": "text", "data": ["text": "合成测试资料 \(id)"]]]]
            }
            try JSONSerialization.data(withJSONObject: events).write(to: directory.appendingPathComponent("event-batch"), options: .atomic)
        }
        let deadline = Date().addingTimeInterval(4)
        while DelayedModelProtocol.counts.started == 0 && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        try #require(DelayedModelProtocol.counts.started == 1)
        #expect(DelayedModelProtocol.counts.bodies.first?.contains("QQ_MEMORY_V2") == true)
        #expect(DelayedModelProtocol.counts.bodies.first?.contains("OWNER") == true)
        if mode == "pause" { engine.pause() }
        if mode == "clear" { engine.clearMemory(engine.config.targets[0].id) }
        if ["pause", "clear"].contains(mode) { try await DelayedModelProtocol.requireCancellation() }
        DelayedModelProtocol.completePending()
        let completed = Date().addingTimeInterval(3)
        while ["capture", "timed"].contains(mode), engine.memoryBooks["12345:group:99999"]?.pending.isEmpty != true, Date() < completed { try await Task.sleep(nanoseconds: 20_000_000) }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(engine.sends.attempts == 0); #expect(engine.usage.calls == 1)
        engine.disconnect()
        let reloaded = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        if mode == "pause" { #expect(reloaded.memoryBooks["12345:group:99999"]?.pending.count == 4) }
        else if mode == "clear" { #expect(reloaded.memoryBooks.isEmpty) }
        else { #expect(reloaded.memoryBooks["12345:group:99999"]?.items.count == 2); #expect(reloaded.memoryBooks["12345:group:99999"]?.pending.isEmpty == true) }
    }
    @Test func learningPayloadIsCompleteAndCandidateAuthorityMatchesSuppliedBudget() async throws {
        DelayedModelProtocol.reset()
        let cfg = URLSessionConfiguration.ephemeral; cfg.protocolClasses = [DelayedModelProtocol.self]
        let session = URLSession(configuration: cfg)
        defer { session.invalidateAndCancel(); DelayedModelProtocol.reset() }
        var book = QQMemoryBook()
        for i in 0..<32 { book.append(QQMemoryEvent(id: "\(i)", subject: "PEER", text: String(repeating: "\"", count: 1200), at: Date())) }
        for _ in 0..<48 { book.importLegacy(text: String(repeating: "旧记忆", count: 200), subject: "PEER", at: Date()) }
        let batch = book.batch(), candidates = book.items
        #expect(batch.count < 32)
        let task = Task { try await DeepSeekClient(session: session).learnQQMemory(key: "synthetic", config: QQConfig().ai, events: batch, candidates: candidates, reserve: {}) }
        let until = Date().addingTimeInterval(3)
        while DelayedModelProtocol.counts.started == 0 && Date() < until { try await Task.sleep(nanoseconds: 20_000_000) }
        let raw = try #require(DelayedModelProtocol.counts.bodies.first)
        let request = try #require(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        let messages = try #require(request["messages"] as? [[String: Any]])
        let payload = try #require(messages.last?["content"] as? String)
        #expect(payload.count <= 11500)
        let fields = try #require(JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        #expect((fields["events"] as? [Any])?.count == batch.count)
        let supplied = try #require(fields["existing"] as? [[String: Any]])
        #expect(supplied.count < candidates.count)
        DelayedModelProtocol.completePending()
        let (_, _, ids) = try await task.value
        #expect(ids == Set(supplied.compactMap { $0["id"] as? String }))
    }
    @Test func removingTargetPersistsWithoutStarting() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        engine.config.expectedSelfID = "12345"
        engine.add(QQContact(number: "54321", name: "fixture", group: false))
        let target = try #require(engine.config.targets.first)
        engine.remove(target.id)
        try #require(engine.error == nil)
        let reloaded = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        #expect(reloaded.config.targets.isEmpty)
        #expect(reloaded.sends.attempts == 0)
    }
    @Test func stalePanelCannotOverwriteNewerConfiguration() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let owner = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        owner.config.expectedSelfID = "12345"; owner.save()
        try #require(owner.error == nil)
        let stale = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        owner.config.ai.prompt = "newer configuration"; owner.save()
        try #require(owner.error == nil)
        let file = directory.appendingPathComponent("qq-state.json"), before = try Data(contentsOf: directory.appendingPathComponent("qq-state.json"))
        stale.save()
        #expect(stale.error != nil)
        #expect(try Data(contentsOf: file) == before)
    }
}
