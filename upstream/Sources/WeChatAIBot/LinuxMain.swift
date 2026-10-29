#if os(Linux)
import Foundation
import Glibc
import BotCore

@main struct LinuxMain {
    @MainActor static func main() async {
        setbuf(stdout, nil)
        umask(0o077)
        do {
            if CommandLine.arguments.contains("--xiaohongshu-panel") || CommandLine.arguments.contains("--social-panel") {
                let workspace = SocialPlatforms()
                let server = try workspace.panel(); print("SOCIAL_CONTROL_URL=\(server.controlURL.absoluteString)"); print("XHS_CONTROL_URL=\(server.controlURL.absoluteString)")
                defer { withExtendedLifetime(server) {} }
                while !Task.isCancelled { try await Task.sleep(nanoseconds: 60_000_000_000) }
                return
            }
            if let index = CommandLine.arguments.firstIndex(of: "--qq-check") {
                guard CommandLine.arguments.indices.contains(index + 2) else {
                    throw AppFailure.message("用法：--qq-check 本机端点 预期账号；令牌由标准输入提供")
                }
                var config = QQConfig()
                config.endpoint = CommandLine.arguments[index + 1]
                config.expectedSelfID = CommandLine.arguments[index + 2]
                try config.validate()
                let connection = OneBotConnection()
                defer { connection.close() }
                try await connection.connect(endpoint: config.endpoint, token: readLine() ?? "")
                async let login = connection.action("get_login_info")
                async let health = connection.action("get_status")
                let (a, b) = try await (login, health)
                guard let account = a["data"] as? [String: Any], QQPolicy.identifier(account["user_id"]) == config.expectedSelfID,
                      let status = b["data"] as? [String: Any], status["online"] as? Bool == true, status["good"] as? Bool == true else {
                    throw AppFailure.message("QQ 账号或在线状态未通过核对")
                }
                print("QQ 账号与在线状态核对成功；未读取聊天或发送消息")
                return
            }
            let engine = QQEngine(allowAuthenticationUI: false)
            if ProcessInfo.processInfo.environment["DAFEIYU_CODEX_URL"] != nil {
                engine.config.ai.model = "dafeiyu-active"
                if engine.config.fastReplyEnabled == nil { engine.config.fastReplyEnabled = true }
                if engine.config.naturalRepliesEnabled == nil { engine.config.naturalRepliesEnabled = true }
                if engine.config.loopProtectionEnabled == nil { engine.config.loopProtectionEnabled = true }
                if engine.config.visionEnabled == nil { engine.config.effectiveVisionEnabled = true }
                if engine.config.memoryEnabled == nil { engine.config.effectiveMemoryEnabled = true }
                if engine.config.onlineEnabled == nil { engine.config.effectiveOnlineEnabled = true }
                // Let people finish typing before answering, and answer pokes, unless set otherwise.
                if engine.config.settleSeconds == nil { engine.config.settleSeconds = 5 }
                if engine.config.poke == nil { var poke = QQPokeConfig(); poke.enabled = true; engine.config.poke = poke }
                if let path = ProcessInfo.processInfo.environment["DAFEIYU_CREDENTIALS_FILE"] {
                    struct Credentials: Decodable { let token: String; let key: String }
                    let values = try JSONDecoder().decode(Credentials.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
                    guard engine.useTemporaryCredentials(token: values.token, key: values.key) else {
                        throw AppFailure.message("本机 Codex 凭证加载失败")
                    }
                }
            }
            let server = try QQControlServer(engine: engine)
            server.start()
            print("Windows / Linux 本机面板：凭证仅保存在内存，退出后需重新填写。")
            // Keep the engine and listener alive without blocking MainActor.
            defer { withExtendedLifetime(server) {} }
            while !Task.isCancelled { try await Task.sleep(nanoseconds: 60_000_000_000) }
        } catch { print("启动失败：\(error.localizedDescription)"); exit(1) }
    }
}
#endif
