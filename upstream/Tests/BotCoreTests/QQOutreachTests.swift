import Foundation
import Testing
@testable import BotCore

struct QQOutreachTests {
    // 2026-10-28 12:00 Asia/Shanghai, outside the default 23:00–09:00 quiet hours.
    let noon = 1793160000.0

    func config(_ change: (inout QQOutreachConfig) -> Void = { _ in }) -> QQOutreachConfig {
        var value = QQOutreachConfig(); value.enabled = true; value.idleMinutes = 60; value.cooldownMinutes = 120
        change(&value); return value
    }
    @Test func offByDefaultAndValidated() throws {
        #expect(!QQOutreachConfig().enabled)
        try QQOutreachConfig().validate()
        var bad = QQOutreachConfig(); bad.idleMinutes = 0
        #expect(throws: (any Error).self) { try bad.validate() }
        bad = QQOutreachConfig(); bad.timeZone = "Mars/Base"
        #expect(throws: (any Error).self) { try bad.validate() }
        var ledger = QQOutreachLedger(); ledger.incoming("private:1", at: noon - 86400)
        #expect(!ledger.due("private:1", now: noon, config: QQOutreachConfig()))
    }
    @Test func waitsForQuietTimeCooldownAndAReply() {
        var ledger = QQOutreachLedger()
        #expect(!ledger.due("private:1", now: noon, config: config()))       // never observed
        ledger.observe("private:1", now: noon)
        #expect(!ledger.due("private:1", now: noon + 1800, config: config())) // only 30 quiet minutes
        #expect(ledger.due("private:1", now: noon + 3600, config: config()))
        ledger.sent("private:1", at: noon + 3600)
        // One unanswered first message is the limit, however long the silence.
        #expect(!ledger.due("private:1", now: noon + 86400, config: config()))
        ledger.incoming("private:1", at: noon + 4000)
        #expect(!ledger.due("private:1", now: noon + 4000 + 3600, config: config())) // cooldown from the last send
        #expect(ledger.due("private:1", now: noon + 3600 + 7200 + 60, config: config()))
        #expect(!ledger.due("private:1", now: noon + 3600 + 7200 + 60, config: config { $0.excluded = ["private:1"] }))
    }
    @Test func respectsQuietHoursAndANotNowDecision() {
        var ledger = QQOutreachLedger(); ledger.observe("private:1", now: noon - 86400)
        let midnight = noon + 12 * 3600 // 00:00 the next day
        #expect(!ledger.due("private:1", now: midnight, config: config()))
        #expect(ledger.due("private:1", now: midnight, config: config { $0.quietStartHour = 0; $0.quietEndHour = 0 }))
        ledger.considered("private:1", at: noon)
        #expect(!ledger.due("private:1", now: noon + 3600, config: config()))      // the model said not now
        #expect(ledger.due("private:1", now: noon + 7200 + 1, config: config()))    // retry after min(cooldown, 6 h)
    }
    @Test func quietHoursWrapAroundMidnight() {
        var value = QQOutreachConfig(); value.quietStartHour = 23; value.quietEndHour = 9
        #expect(value.quiet(at: Date(timeIntervalSince1970: noon + 12 * 3600)))  // 00:00
        #expect(value.quiet(at: Date(timeIntervalSince1970: noon - 4 * 3600)))   // 08:00
        #expect(!value.quiet(at: Date(timeIntervalSince1970: noon)))             // 12:00
        value.quietStartHour = 13; value.quietEndHour = 15
        #expect(value.quiet(at: Date(timeIntervalSince1970: noon + 3600)))       // 13:00
        #expect(!value.quiet(at: Date(timeIntervalSince1970: noon)))
    }
}
