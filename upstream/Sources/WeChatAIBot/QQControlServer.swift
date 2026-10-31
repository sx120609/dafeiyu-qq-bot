import Foundation
import BotCore

/// An opt-in, loopback-only control surface for the same engine as the native panel.
@MainActor final class QQControlServer {
    private let engine: QQEngine
    private var social: SocialPlatforms?
    private let listener: LoopbackListener
    private let token = UUID().uuidString + UUID().uuidString
    private var origin = ""
    private var clients: [UUID: LoopbackConnection] = [:]
    private var started = false
    private(set) var isRunning = false
    var controlURL: URL { URL(string: "http://127.0.0.1:\(listener.port)/#\(token)")! }
    private var observedConfiguration: QQConfig?
    private var configurationRevision = UUID().uuidString
    private func currentConfigurationRevision() -> String {
        if observedConfiguration != engine.config {
            observedConfiguration = engine.config
            configurationRevision = UUID().uuidString
        }
        return configurationRevision
    }
    init(engine: QQEngine, social: SocialPlatforms? = nil) throws {
        self.engine = engine; self.social = social
        listener = try LoopbackListener()
    }
    func start(announce: Bool = true) {
        guard !started else { return }; started = true; isRunning = true
        origin = "http://127.0.0.1:\(listener.port)"
        if announce {
            print("QQ_CONTROL_URL=\(controlURL.absoluteString)")
            print("本机控制页已就绪；打开控制页不会改变 QQ 的连接或运行状态")
        }
        listener.start { [weak self] connection in
            Task { @MainActor in
                guard let self, self.isRunning, self.clients.count < 32 else { connection.cancel(); return }
                let id = UUID(); self.clients[id] = connection
                self.receive(connection, id: id, buffer: Data())
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 15_000_000_000)
                    self?.clients.removeValue(forKey: id)?.cancel()
                }
            }
        }
    }
    /// Revoke this control surface without pausing or disconnecting the shared engine.
    /// Actions already accepted by the engine may still finish there.
    func stop() {
        started = true; isRunning = false; listener.stop()
        clients.values.forEach { $0.cancel() }; clients.removeAll()
    }
    deinit { listener.stop(); clients.values.forEach { $0.cancel() } }
    private func receive(_ connection: LoopbackConnection, id: UUID, buffer: Data) {
        connection.read { [weak self] data, ended, error in
            Task { @MainActor in
                guard let self, self.clients[id] != nil else { return }
                var buffer = buffer; if let data { buffer.append(data) }
                guard error == nil, buffer.count <= 4_220_000 else { self.reply(connection, id: id, code: 400); return }
                guard let separator = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                    if ended || buffer.count > 16384 { self.reply(connection, id: id, code: 400) }
                    else { self.receive(connection, id: id, buffer: buffer) }
                    return
                }
                let lines = String(decoding: buffer[..<separator.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
                let request = (lines.first ?? "").split(separator: " ").map(String.init)
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":") else { self.reply(connection, id: id, code: 400); return }
                    let name = line[..<colon].lowercased()
                    guard headers[name] == nil else { self.reply(connection, id: id, code: 400); return }
                    headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                }
                let importing = request.count == 3 && request[0] == "POST" && request[1] == "/api/import-sticker"
                let bodyLimit = importing ? 4_200_000 : 65536
                guard !importing || (headers["x-qq-control"] == self.token && headers["origin"] == self.origin) else { self.reply(connection, id: id, code: 403); return }
                guard request.count == 3, request[2] == "HTTP/1.1", headers["transfer-encoding"] == nil,
                      let count = Int(headers["content-length"] ?? "0"), (0...bodyLimit).contains(count),
                      headers["host"] == self.origin.replacingOccurrences(of: "http://", with: "") else {
                    self.reply(connection, id: id, code: 400); return
                }
                let body = Data(buffer[separator.upperBound...])
                if body.count < count && !ended { self.receive(connection, id: id, buffer: buffer); return }
                guard body.count == count else { self.reply(connection, id: id, code: 400); return }
                await self.handle(connection, id: id, method: request[0], path: request[1], headers: headers, body: body)
            }
        }
    }
    private func handle(_ connection: LoopbackConnection, id: UUID, method: String, path: String, headers: [String: String], body: Data) async {
        if method == "GET", ["/", "/app.js", "/sticker-pack.js", "/style.css", "/logo.png"].contains(path) {
            let name: String, ext: String, type: String
            switch path {
            case "/app.js": (name, ext, type) = ("app", "js", "text/javascript")
            case "/sticker-pack.js": (name, ext, type) = ("sticker-pack", "js", "text/javascript")
            case "/style.css": (name, ext, type) = ("style", "css", "text/css")
            case "/logo.png": (name, ext, type) = ("logo", "png", "image/png")
            default: (name, ext, type) = ("index", "html", "text/html")
            }
            guard let url = RuntimeResources.directory?.appendingPathComponent("QQControl/\(name).\(ext)"),
                  let data = try? Data(contentsOf: url) else { reply(connection, id: id, code: 404); return }
            var served = data
            if name == "index", ProcessInfo.processInfo.environment["DAFEIYU_CODEX_URL"] != nil,
               let html = String(data: data, encoding: .utf8) {
                served = Data(html.replacingOccurrences(of: "DeepSeek API Key", with: "本机模型网关凭证（已自动加载）")
                    .replacingOccurrences(of: "DeepSeek Key", with: "本机模型网关凭证")
                    .replacingOccurrences(of: "DeepSeek 原有识图", with: "当前模型直接识图")
                    .replacingOccurrences(of: "id=\"imageGenPrimary\">", with: "id=\"imageGenPrimary\"><option value=\"codex\">模型网关生图（云端 API 或本机 Codex，独立于聊天模型）</option>")
                    .replacingOccurrences(of: "value=\"deepseek-flash\"", with: "value=\"dafeiyu-active\"")
                    .replacingOccurrences(of: "<footer>持续更新完善中</footer>", with: "<footer>连接方式和模型请在模型控制台选择；凭证自动加载，QQ 扫码后自动核对账号。</footer>").utf8)
            }
            reply(connection, id: id, code: 200, data: served, type: type); return
        }
        guard headers["x-qq-control"] == token,
              headers["origin"] == nil || headers["origin"] == origin else { reply(connection, id: id, code: 403); return }
        if method == "POST", path == "/api/social-panel" {
            guard headers["origin"] == origin, headers["content-type"]?.hasPrefix("application/json") == true,
                  let value = try? JSONSerialization.jsonObject(with: body) as? [String: String],
                  let platform = value["platform"].flatMap(SocialPlatform.init(rawValue:)) else { reply(connection, id: id, code: 400); return }
            do {
                if social == nil { social = SocialPlatforms() }
                let panel = try social!.panel()
                var url = URLComponents(url: panel.controlURL, resolvingAgainstBaseURL: false)!
                url.queryItems = [URLQueryItem(name: "platform", value: platform.rawValue)]
                reply(connection, id: id, code: 200, data: try JSONSerialization.data(withJSONObject: ["url": url.url!.absoluteString]))
            } catch { reply(connection, id: id, code: 503) }
            return
        }
        if method == "GET", path.hasPrefix("/api/sticker/") {
            let stickerID = String(path.dropFirst("/api/sticker/".count))
            guard let item = engine.stickerLibrary.items.first(where: { $0.id == stickerID }),
                  let data = engine.stickerLibrary.data(for: item) else { reply(connection, id: id, code: 404); return }
            reply(connection, id: id, code: 200, data: data, type: item.file.hasSuffix(".png") ? "image/png" : item.file.hasSuffix(".webp") ? "image/webp" : "image/jpeg"); return
        }
        var configurationSaved = false
        if method == "POST", path == "/api/action" || path == "/api/import-sticker" {
            guard headers["origin"] == origin, headers["content-type"]?.hasPrefix("application/json") == true else {
                reply(connection, id: id, code: 403); return
            }
            do {
                let request = try JSONDecoder().decode(Action.self, from: body)
                guard (path == "/api/import-sticker") == (request.action == "importSticker") else { throw AppFailure.message("操作路径不匹配") }
                engine.error = nil
                // Pause/takeover must remain available even from an old page. Editing
                // and starting require the exact configuration the editor observed.
                let writesConfiguration = ["saveConnection", "connect", "save", "start", "add", "remove", "setPersona", "saveArtwork", "addArtworkArtist", "removeArtworkArtist", "saveImageGeneration", "saveVisualTools"]
                if writesConfiguration.contains(request.action) {
                    guard request.configurationRevision == currentConfigurationRevision() else {
                        throw AppFailure.message("配置已更新或页面版本过旧。草稿未提交，请载入最新配置后再操作。")
                    }
                }
                switch request.action {
                case "importSticker":
                    guard let image = request.stickerImage, let data = Data(base64Encoded: image), let item = request.sticker else { throw AppFailure.message("缺少图片或表情信息") }
                    try engine.importSticker(data: data, title: item.title, emotion: item.emotion, context: item.context,
                        source: item.source, author: item.author, license: item.license, publicSharing: item.publicSharing)
                case "saveConnection":
                    configurationSaved = engine.save(endpoint: request.endpoint, expectedSelfID: request.expectedSelfID)
                case "addArtworkArtist":
                    guard let input = request.artistInput else { throw AppFailure.message("缺少画师主页或 ID") }
                    await engine.addArtworkArtist(input)
                case "removeArtworkArtist":
                    guard let id = request.artistInput, engine.config.effectiveArtwork.pixivArtistIDs.contains(id) else { throw AppFailure.message("画师不在列表中") }
                    var settings = engine.config.effectiveArtwork
                    settings.pixivArtistIDs.removeAll { $0 == id }; settings.artistNames?.removeValue(forKey: id)
                    settings.imagePermissions.removeValue(forKey: id); engine.saveArtwork(settings)
                case "saveArtwork":
                    guard let settings = request.artwork else { throw AppFailure.message("缺少插画设置") }
                    engine.saveArtwork(settings)
                case "saveVisualTools":
                    guard let settings = request.visualTools else { throw AppFailure.message("缺少识图设置") }
                    configurationSaved = engine.saveVisualTools(settings, googleKey: request.googleVisionKey ?? "", persistCredentials: request.persistVisualCredentials ?? true)
                case "saveImageGeneration":
                    guard let settings = request.imageGeneration else { throw AppFailure.message("缺少生图设置") }
                    configurationSaved = engine.saveImageGeneration(settings, zhipuKey: request.zhipuKey ?? "", cloudflareToken: request.cloudflareToken ?? "", persistCredentials: request.persistImageCredentials ?? true)
                case "saveOutreach":
                    guard let settings = request.outreach else { throw AppFailure.message("缺少主动聊天设置") }
                    try engine.saveOutreach(settings)
                    configurationSaved = true
                case "saveReplyMode":
                    guard let forAll = request.agentForAll else { throw AppFailure.message("缺少回复方式设置") }
                    try engine.saveReplyMode(forAll: forAll, agent: request.agentTargets ?? [], classic: request.classicTargets ?? [], levels: request.agentLevels ?? [:])
                    configurationSaved = true
                case "savePoke":
                    guard let settings = request.poke else { throw AppFailure.message("缺少戳一戳设置") }
                    try engine.savePoke(settings)
                    configurationSaved = true
                case "saveQuietHours":
                    guard let settings = request.quietHours else { throw AppFailure.message("缺少安静时段设置") }
                    try engine.saveQuietHours(settings)
                    configurationSaved = true
                case "saveSettle":
                    guard let seconds = request.settleSeconds else { throw AppFailure.message("缺少等待时长") }
                    try engine.saveSettle(seconds: seconds)
                    configurationSaved = true
                case "saveReactions":
                    guard let settings = request.reactions else { throw AppFailure.message("缺少贴表情设置") }
                    try engine.saveReactions(settings)
                    configurationSaved = true
                case "previewOutreach":
                    guard let target = request.target else { throw AppFailure.message("缺少会话") }
                    try await engine.previewOutreach(target)
                case "saveModeration":
                    try engine.saveModeration(admins: request.adminIDs ?? engine.config.effectiveAdminIDs, blocked: request.blockedIDs ?? engine.config.effectiveBlockedIDs)
                    configurationSaved = true
                case "pause": engine.pause()
                case "disconnect": engine.disconnect()
                case "clear": engine.clearTemporaryCredentials()
                case "takeOver":
                    guard let target = engine.config.targets.first(where: { $0.key == request.target }) else { throw AppFailure.message("会话不存在") }
                    engine.takeOver(target.id)
                case "clearMemory":
                    guard let target = engine.config.targets.first(where: { $0.key == request.target }) else { throw AppFailure.message("会话不存在") }
                    engine.clearMemory(target.id)
                case "resetMemory":
                    guard let key = request.target else { throw AppFailure.message("缺少会话") }
                    try engine.resetMemory(key)
                case "connect":
                    guard !engine.connected, !engine.busy, !engine.runtimeBusy else { throw AppFailure.message("请先断开并等待当前操作完成") }
                    guard request.expectedSelfID == nil || request.expectedSelfID == engine.config.expectedSelfID,
                          request.endpoint == nil || request.endpoint == engine.config.endpoint else {
                        throw AppFailure.message("连接只使用已保存地址与账号，请先保存连接配置")
                    }
                    let token = (request.token ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let key = (request.key ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !token.isEmpty || !key.isEmpty {
                        guard engine.useTemporaryCredentials(token: token, key: key) else { throw AppFailure.message(engine.error ?? "临时凭证无效") }
                    }
                    await engine.connect()
                case "add":
                    guard let contact = engine.contacts.first(where: { $0.id == request.target }) else { throw AppFailure.message("请从已核对联系人中选择") }
                    engine.add(contact)
                case "remove":
                    guard let target = engine.config.targets.first(where: { $0.key == request.target }) else { throw AppFailure.message("会话不存在") }
                    engine.remove(target.id)
                case "setPersona":
                    guard let target = request.target, let style = request.personaStyle else { throw AppFailure.message("缺少会话或性格") }
                    engine.setPersonaStyle(style, target: target)
                case "save":
                    guard !engine.busy, !engine.runtimeBusy else { throw AppFailure.message("请等待当前操作完成") }
                    var updated = engine.config
                    if let ai = request.ai { updated.ai = ai }
                    if let persona = request.persona { updated.persona = persona }
                    if let onlineEnabled = request.onlineEnabled { updated.onlineEnabled = onlineEnabled }
                    if let visionEnabled = request.visionEnabled { updated.visionEnabled = visionEnabled }
                    if let memoryEnabled = request.memoryEnabled { updated.memoryEnabled = memoryEnabled }
                    if let options = request.memoryOptions { updated.memoryOptions = options }
                    if let value = request.groupParticipationEnabled { updated.groupParticipationEnabled = value }
                    if let value = request.groupParticipationEvery { updated.groupParticipationEvery = value }
                    if let value = request.fastReplyEnabled { updated.fastReplyEnabled = value }
                    if let value = request.naturalRepliesEnabled { updated.naturalRepliesEnabled = value }
                    if let value = request.loopProtectionEnabled { updated.loopProtectionEnabled = value }
                    try updated.validate(); engine.saveReplySettings(ai: updated.ai, persona: updated.effectivePersona, onlineEnabled: updated.effectiveOnlineEnabled, visionEnabled: updated.effectiveVisionEnabled, memoryEnabled: updated.effectiveMemoryEnabled, groupParticipationEnabled: updated.effectiveGroupParticipationEnabled, groupParticipationEvery: updated.effectiveGroupParticipationEvery, memoryOptions: updated.effectiveMemoryOptions, enabledTargets: request.enabled.map { Set($0) }, fastReplyEnabled: updated.effectiveFastReplyEnabled, naturalRepliesEnabled: updated.effectiveNaturalRepliesEnabled, loopProtectionEnabled: updated.effectiveLoopProtectionEnabled)
                case "start":
                    guard engine.connected, !engine.running, !engine.busy, !engine.runtimeBusy else { throw AppFailure.message("请先连接或暂停") }
                    let duration = request.singleReply == true ? 15 : (request.durationMinutes ?? 120)
                    guard (0...4320).contains(duration) else { throw AppFailure.message("运行时长必须为 0 至 4320 分钟") }
                    guard request.ai == nil, request.persona == nil, request.enabled == nil,
                          request.onlineEnabled == nil, request.visionEnabled == nil, request.memoryEnabled == nil,
                          request.memoryOptions == nil, request.groupParticipationEnabled == nil, request.groupParticipationEvery == nil else {
                        throw AppFailure.message("开始回复只使用已保存配置，请先单独保存范围与回复设置")
                    }
                    engine.start(singleReply: request.singleReply ?? false, duration: duration == 0 ? nil : Double(duration * 60))
                default: throw AppFailure.message("不支持的操作")
                }
            } catch { engine.error = error.localizedDescription }
        } else if !(method == "GET" && path == "/api/status") { reply(connection, id: id, code: 404); return }
        do {
            let config = try JSONSerialization.jsonObject(with: JSONEncoder().encode(engine.config))
            let object: [String: Any] = ["config": config, "configurationSaved": configurationSaved, "configurationRevision": currentConfigurationRevision(), "connected": engine.connected, "running": engine.running,
                "busy": engine.busy || engine.runtimeBusy, "status": engine.status, "error": engine.error ?? "",
                "kickedAt": engine.kickedAt.map { $0.timeIntervalSince1970 as Any } ?? NSNull(),
                "temporaryCredentials": engine.usesTemporaryCredentials,
                "supportsKeychain": RuntimeResources.supportsKeychain,
                "configurationHints": engine.configurationHints,
                "runtimeRecords": try JSONSerialization.jsonObject(with: JSONEncoder().encode(engine.runtimeRecords)),
                "imageGeneration": try JSONSerialization.jsonObject(with: JSONEncoder().encode(engine.config.effectiveImageGeneration)),
                "imageCredentials": ["zhipu": engine.hasZhipuImageKey, "cloudflare": engine.hasCloudflareImageToken, "codex": engine.hasCodexImageKey],
                "visualTools": try JSONSerialization.jsonObject(with: JSONEncoder().encode(engine.config.effectiveVisualTools)),
                "googleVisionCredential": engine.hasGoogleVisionKey, "visualStatus": engine.visualStatus,
                "imageGenerationStatus": engine.imageGenerationStatus,
                "artwork": try JSONSerialization.jsonObject(with: JSONEncoder().encode(engine.config.effectiveArtwork)),
                "artworkStatus": engine.artworkStatus,
                "artworkArtists": engine.config.effectiveArtwork.pixivArtistIDs.map { ["id": $0, "name": QQArtworkLibrary.artistName($0, config: engine.config.effectiveArtwork), "deliveryStatus": "公开取图，逐作检查可用性"] },
                "artworkNetworkCalls": engine.artworkLedger.networkCalls,
                "artworkConfirmed": engine.artworkLedger.deliveries.filter { $0.state == "confirmed" }.count,
                "memoryOptions": try JSONSerialization.jsonObject(with: JSONEncoder().encode(engine.config.effectiveMemoryOptions)),
                "memoryStatus": engine.memoryStatus, "memoryBusy": engine.memoryBusy,
                "memories": engine.memoryBooks.filter { $0.key.hasPrefix(engine.config.expectedSelfID + ":") }.sorted { $0.key < $1.key }.map { key, book in
                    ["key": key, "summary": book.items.filter { $0.current(Date()) }.suffix(32).map { "[\($0.subject)·\($0.kind)] \($0.text)" }.joined(separator: "\n"), "updatedAt": (book.lastCompactedAt ?? book.recent.last?.at ?? Date.distantPast).timeIntervalSince1970, "pending": book.pending.count, "items": book.items.filter { $0.current(Date()) }.count, "dropped": book.droppedEvents] as [String: Any]
                },
                "personalities": QQPersonality.allCases.map { ["id": $0.rawValue, "name": $0.name, "description": $0.description] },
                "persona": try JSONSerialization.jsonObject(with: JSONEncoder().encode(engine.config.effectivePersona)),
                "stickers": engine.stickerLibrary.items.map { ["id": $0.id, "title": $0.title, "source": $0.source, "context": $0.context ?? "", "emotion": $0.emotion.rawValue, "author": $0.author ?? "", "license": $0.license ?? "", "local": $0.id.hasPrefix("local-"), "publicSharing": $0.publicSharing ?? false] as [String: Any] },
                "runDeadline": engine.runDeadline.map { $0.timeIntervalSince1970 as Any } ?? NSNull(),
                "calls": engine.usage.calls, "attempts": engine.sends.attempts, "confirmed": engine.sends.confirmed,
                "groupMessageCounts": engine.groupMessageCounts,
                "queued": engine.queuedCount, "queueCapacity": QQEngine.queueCapacity,
                "uncertain": engine.sends.uncertain, "rejected": engine.rejectedScopedEvents,
                "contacts": engine.contacts.map { ["key": $0.id, "name": $0.name, "number": $0.number, "group": $0.group] as [String: Any] },
                "outreach": try JSONSerialization.jsonObject(with: JSONEncoder().encode(engine.config.effectiveOutreach)),
                "outreachChats": engine.outreachChats,
                "reactions": try JSONSerialization.jsonObject(with: JSONEncoder().encode({ () -> QQReactionConfig in
                    var view = engine.config.effectiveReactions; view.emojis = view.effectiveEmojis; return view }())),
                "reactionsSent": engine.reactionsSent,
                "agentStates": engine.agentStates,
                "agentReminders": engine.agentReminders.sorted { $0.due < $1.due }.map { ["id": $0.id, "chat": $0.chat, "due": $0.due.timeIntervalSince1970, "setAt": $0.setAt.timeIntervalSince1970, "about": $0.about] as [String: Any] },
                "agentTurns": try engine.agentTurns.suffix(QQEngine.agentTurnsKept).reversed().map { try JSONSerialization.jsonObject(with: { let e = JSONEncoder(); e.dateEncodingStrategy = .secondsSince1970; return e }().encode($0)) },
                "interactions": engine.interactions.suffix(40).reversed().map { ["at": $0.at.timeIntervalSince1970, "chat": $0.chat, "what": $0.what, "why": $0.why] as [String: Any] },
                "poke": try JSONSerialization.jsonObject(with: JSONEncoder().encode(engine.config.effectivePoke)),
                "settleSeconds": engine.config.effectiveSettleSeconds,
                "quietHours": try JSONSerialization.jsonObject(with: JSONEncoder().encode(engine.config.effectiveQuietHours)),
                "decisions": engine.decisions.suffix(60).reversed().map { ["at": $0.at.timeIntervalSince1970, "chat": $0.chat, "speaker": $0.speaker, "text": $0.text, "outcome": $0.outcome] as [String: Any] },
                "removedTargets": engine.removedTargets.reversed().map { ["number": $0.number, "name": $0.name, "group": $0.group, "reason": $0.reason, "removedAt": $0.removedAt.timeIntervalSince1970] as [String: Any] },
                "outreachPreview": engine.outreachPreview.map { ["target": $0.target, "send": $0.send, "text": $0.text, "at": $0.at] as [String: Any] } ?? NSNull()]
            reply(connection, id: id, code: 200, data: try JSONSerialization.data(withJSONObject: object))
        } catch { reply(connection, id: id, code: 500) }
    }
    private struct Action: Decodable {
        struct Sticker: Decodable {
            var title: String
            var emotion: QQEmotion
            var context: String
            var source: String
            var author: String
            var license: String
            var publicSharing: Bool
        }
        var sticker: Sticker?
        var stickerImage: String?
        var configurationRevision: String?
        var endpoint: String?
        var groupParticipationEnabled: Bool?
        var groupParticipationEvery: Int?
        var visualTools: QQVisualConfig?
        var googleVisionKey: String?
        var persistVisualCredentials: Bool?
        var action: String
        var artwork: QQArtworkConfig?
        var artistInput: String?
        var imageGeneration: QQImageGenerationConfig?
        var zhipuKey: String?
        var cloudflareToken: String?
        var persistImageCredentials: Bool?
        var expectedSelfID: String?
        var token: String?
        var key: String?
        var target: String?
        var enabled: [String]?
        var ai: BotConfig?
        var persona: QQPersona?
        var personaStyle: String?
        var onlineEnabled: Bool?
        var visionEnabled: Bool?
        var memoryEnabled: Bool?
        var memoryOptions: QQMemoryOptions?
        var fastReplyEnabled: Bool?
        var naturalRepliesEnabled: Bool?
        var loopProtectionEnabled: Bool?
        var durationMinutes: Int?
        var singleReply: Bool?
        var adminIDs: [String]?
        var blockedIDs: [String]?
        var outreach: QQOutreachConfig?
        var reactions: QQReactionConfig?
        var agentTargets: [String]?
        var agentForAll: Bool?
        var classicTargets: [String]?
        var agentLevels: [String: String]?
        var poke: QQPokeConfig?
        var settleSeconds: Int?
        var quietHours: QQQuietHours?
    }
    private func reply(_ connection: LoopbackConnection, id: UUID, code: Int, data: Data = Data(), type: String = "application/json") {
        let header = "HTTP/1.1 \(code) Response\r\nContent-Type: \(type); charset=utf-8\r\nContent-Length: \(data.count)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; form-action 'none'\r\n\r\n"
        connection.send(Data(header.utf8) + data) { [weak self] in
            connection.cancel()
            Task { @MainActor in self?.clients.removeValue(forKey: id) }
        }
    }
}
