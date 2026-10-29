import Foundation

public enum QQModelIdentity {
    public static func isQuestion(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value == "/model" || value == "/模型" { return true }
        guard value.count <= 180 else { return false }
        if value.range(of: "推荐|比较|对比|训练|微调|部署|recommend|compare", options: .regularExpression) != nil { return false }
        if value.range(of: #"(what|which).{0,20}model.{0,20}(you|using)|your.{0,10}model"#, options: .regularExpression) != nil { return true }
        let selfReference = value.range(of: "你|您|大肥鱼|机器人|当前|现在|底层|用的", options: .regularExpression) != nil
        let modelQuestion = value.range(of: #"(什么|哪个|哪款|啥|具体|底层|型号|版本).{0,12}(模型|model)|(模型|model).{0,12}(什么|哪个|哪款|啥|型号|版本)"#, options: .regularExpression) != nil
        return selfReference && modelQuestion
    }
}
