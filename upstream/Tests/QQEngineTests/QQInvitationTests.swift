import Foundation
import Testing
@testable import WeChatAIBot

@MainActor struct QQInvitationTests {
    /// Only an admin's invitation is accepted and puts the group on the managed list; a group someone else
    /// pulled the bot into stays off it, unless an admin is a member there.
    @Test func onlyAdminInvitationsJoinAndManageTheGroup() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("group".utf8).write(to: directory.appendingPathComponent("message-shape"))
        let server = Process(), output = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("onebot_fixture.py").path, directory.path]
        server.standardOutput = output; try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try #require(Int(String(decoding: output.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))

        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        defer { engine.disconnect() }
        engine.config.endpoint = "ws://127.0.0.1:\(port)"; engine.config.expectedSelfID = "12345"
        engine.config.adminIDs = ["77777"]
        #expect(engine.useTemporaryCredentials(token: "synthetic-test-token", key: "synthetic-key"))
        await engine.connect(); try #require(engine.connected, "\(engine.error ?? engine.status)")

        func invite(_ group: Int, from user: Int, flag: String) -> [String: Any] {
            ["post_type": "request", "request_type": "group", "sub_type": "invite", "self_id": 12345, "user_id": user, "group_id": group, "flag": flag]
        }
        func joined(_ group: Int, by user: Int) -> [String: Any] {
            ["post_type": "notice", "notice_type": "group_increase", "sub_type": "invite", "self_id": 12345, "user_id": 12345, "operator_id": user, "group_id": group]
        }
        let events = [invite(70001, from: 66666, flag: "stranger"), invite(70002, from: 77777, flag: "admin"),
                      joined(70002, by: 66666), joined(70003, by: 66666), joined(70004, by: 77777),
                      // The group owner pulled the bot in, at the admin's request; the admin is a member there.
                      joined(70005, by: 66666)]
        try JSONSerialization.data(withJSONObject: events).write(to: directory.appendingPathComponent("event-batch"), options: .atomic)

        let managed: (String) -> Bool = { number in engine.config.targets.contains { $0.group && $0.number == number } }
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline && !(managed("70002") && managed("70004") && managed("70005")) { try await Task.sleep(nanoseconds: 20_000_000) }

        let approvals = (try? String(contentsOf: directory.appendingPathComponent("invite-approvals"), encoding: .utf8)) ?? ""
        #expect(approvals.contains("\"admin\"")); #expect(!approvals.contains("stranger"))
        #expect(approvals.contains("\"approve\":true") || approvals.contains("\"approve\": true"))
        #expect(managed("70002")); #expect(managed("70004")); #expect(managed("70005"))
        #expect(!managed("70001")); #expect(!managed("70003"))
        // The admin's group joins once even though its join notice names someone else as the operator.
        #expect(engine.config.targets.filter { $0.number == "70002" }.count == 1)
        #expect(engine.config.targets.filter { ["70002", "70004"].contains($0.number) }.allSatisfy { $0.enabled && $0.name == "invited group" })
        #expect(engine.logs.contains { $0.detail.contains("66666") && $0.detail.contains("不是管理员") })
        #expect(!engine.running)
    }

    /// QQ forcing the account offline stops the engine with a clear reason, instead of staying "connected".
    @Test func kickedOfflineDisconnectsAndSaysWhatToDo() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("group".utf8).write(to: directory.appendingPathComponent("message-shape"))
        let server = Process(), output = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("onebot_fixture.py").path, directory.path]
        server.standardOutput = output; try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try #require(Int(String(decoding: output.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        defer { engine.disconnect() }
        engine.config.endpoint = "ws://127.0.0.1:\(port)"; engine.config.expectedSelfID = "12345"
        #expect(engine.useTemporaryCredentials(token: "synthetic-test-token", key: "synthetic-key"))
        await engine.connect(); try #require(engine.connected, "\(engine.error ?? engine.status)")
        let offline: [String: Any] = ["post_type": "notice", "notice_type": "bot_offline", "self_id": 12345, "user_id": 12345, "tag": "BotOfflineEvent", "message": "你的用户身份已失效"]
        try JSONSerialization.data(withJSONObject: [offline]).write(to: directory.appendingPathComponent("event-batch"), options: .atomic)
        let deadline = Date().addingTimeInterval(4)
        while engine.connected && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        #expect(!engine.connected)
        #expect(engine.status.contains("踢下线") && engine.status.contains("扫码"))
        #expect(engine.kickedAt != nil)
        #expect(engine.logs.contains { $0.detail.contains("用户身份已失效") })
    }
}
