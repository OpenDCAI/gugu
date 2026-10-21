// 咕咕的 Mac 原生助手:一行一个 JSON 收(stdin)发(stdout),协议见 apps/desktop/electron/device-actions/native/mac-helper-client.ts。
//   → {"id":1,"method":"calendar.events.list","params":{…}}
//   ← {"id":1,"ok":true,"result":…} | {"id":1,"ok":false,"error":{"code":"…","message":"…","details":…}}
// stdout 只写协议;日志一律写 stderr。stdin 关掉(咕咕退出)就退出。
import Foundation

let router = Router()
registerPermissions(router)
registerCalendar(router)
registerReminders(router)
registerContacts(router)
registerLocation(router)
registerVision(router)
registerSystem(router)

let output = OutputWriter()
/// 在途的请求:stdin 关了也要等它们回完再退(❌ 读到 EOF 就退,把刚收到的请求丢掉)。
let inFlight = DispatchGroup()

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        guard let data = line.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = message["id"] as? Int,
              let method = message["method"] as? String
        else {
            FileHandle.standardError.write("gugu-mac-helper: unreadable request\n".data(using: .utf8)!)
            continue
        }
        let params = message["params"] as? [String: Any] ?? [:]
        inFlight.enter()
        Task {
            defer { inFlight.leave() }
            do {
                let result = try await router.handle(method, Params(params))
                output.reply(["id": id, "ok": true, "result": jsonSafe(result)])
            } catch let error as HelperError {
                var body: [String: Any] = ["code": error.code, "message": error.message]
                if let details = error.details { body["details"] = jsonSafe(details) }
                output.reply(["id": id, "ok": false, "error": body])
            } catch {
                output.reply(["id": id, "ok": false, "error": ["code": "execution_failed", "message": "\(error.localizedDescription)"]])
            }
        }
    }
    inFlight.wait()
    exit(0)
}
reader.start()

// 主线程跑 run loop:定位、授权回调要它。
RunLoop.main.run()
