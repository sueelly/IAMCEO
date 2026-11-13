// D5 호환 게이트의 해석 쪽. scripts/compat-decoders/run.ts 가 출시 태그의 앱 모델 파일(git show)과 이 파일을
// 한 실행 파일로 묶어 빌드한다. 지금 서버가 낸 실제 응답(tests/compat-dump.test.ts 의 덤프)을 그 옛 모델로 풀고,
// 출시 앱이 해석 뒤에 따로 거는 조건도 본다. 하나라도 어긋나면 종료 코드 1.
//
// 실패로 치는 것
// - 해석 실패: 옛 앱이 그 응답 전체를 버린다(동기화가 멈추거나 '연결 중'에 머문다).
// - 알 수 없는 값으로 바뀐 열거값: 옛 앱의 SafeStringEnum 이 모르는 값을 unknown 으로 읽는다(화면이 조용히 비거나 기능이 꺼진다).
// - 건너뛴 부가 정보: 0.2.3 부터의 lenient 해석이 형이 어긋난 칸을 '없음'으로 읽고 넘어간다.
// - 출시 앱의 조건: contractVersion 2, 전달 안내 version 2, hello 의 고정 간격 등. 어긋나면 기능이 조용히 꺼진다.
// - 0.2.4 부터(COMPAT_SINCE_0_2_4): 버전 머리글을 보낸 앱이 받는 server 칸과 어긋남 안내, 연결된 기기 목록,
//   다른 기기 끊기 거절(403)이 그 앱 화면에 어떻게 보이는지.
// - 0.2.5 부터(COMPAT_SINCE_0_2_5): server.id 와 home 으로 읽는 서버 신원이 서버의 실제 신원과 같은 서버인지(연결되면 보낼 글을
//   쓴 서버에 묶는다. 다르면 이 서버에 쓴 글을 보내지 않고 '다른 서버에 보내려던 글'로 둔다), 연결된 기기의 끊기 단추
//   (canRevokeOthers: 서버가 도는 Mac 은 모든 줄, 다른 기기는 자기 줄만), 끊기 거절을 코드(device_revoke_local_only)로 알아보는지.
// 의도한 변경이면 allow.json 에 이유와 함께 적는다.
import Foundation

/// run.ts 가 옛 소스의 두 곳에 이 호출을 끼워 넣는다(값은 그대로 두고 기록만 한다).
enum CompatProbe {
    nonisolated(unsafe) static var records: [String] = []
    static func fallback<T: SafeStringEnum>(_ type: T.Type, _ decoder: Decoder) -> T {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? "?"
        records.append("알 수 없는 값: \(T.self) '\(raw)' 위치 \(path(decoder.codingPath))")
        return T.unknown
    }
    static func skipped(_ type: Any.Type, _ error: any Error, _ fallback: [any CodingKey]) {
        records.append("건너뛴 칸: \(type) \(describe(error, fallback: fallback))")
    }
    static func path(_ keys: [any CodingKey]) -> String {
        keys.isEmpty ? "(맨 위)" : keys.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
    }
    static func describe(_ error: any Error, fallback: [any CodingKey] = []) -> String {
        guard let decoding = error as? DecodingError else { return "\(error) 위치 \(path(fallback))" }
        switch decoding {
        case .typeMismatch(let type, let context): return "형이 다름(\(type)) 위치 \(path(context.codingPath)) — \(context.debugDescription)"
        case .valueNotFound(let type, let context): return "값이 없음(\(type)) 위치 \(path(context.codingPath)) — \(context.debugDescription)"
        case .keyNotFound(let key, let context): return "필수 칸 없음 '\(key.stringValue)' 위치 \(path(context.codingPath))"
        case .dataCorrupted(let context): return "값이 어긋남 위치 \(path(context.codingPath)) — \(context.debugDescription)"
        @unknown default: return "\(decoding)"
        }
    }
}

/// 덤프가 남긴 서버의 실제 신원(manifest.serverIdentity: 알림 저장소의 서버 ID 와 데이터 폴더). 버전 머리글을 보낸 앱의 덤프에만 있다.
/// 0.2.5 부터의 검사가 응답의 신원과 견준다(앞서 이 서버에서 받아 글에 남긴 신원과 같은 값).
enum DumpReference {
    nonisolated(unsafe) static var serverID: String?
    nonisolated(unsafe) static var serverHome: String?
}

/// status 는 그 응답의 HTTP 상태(덤프 목록에 없으면 200). 오류 답(APIError)을 읽을 때만 쓴다.
struct Entry { let file: String; let type: String; let checks: [String]; let note: String; let status: Int }
struct Allow { let release: String?; let file: String?; let contains: String; let reason: String }

func decode<T: Decodable>(_ type: T.Type) -> (Data, Entry) throws -> Any { { data, _ in try JSONDecoder().decode(T.self, from: data) } }

/// 출시 앱이 받는 형. 이름은 tests/compat-dump.test.ts 의 CompatType 과 같다.
func makeDecoders() -> [String: (Data, Entry) throws -> Any] {
    var table: [String: (Data, Entry) throws -> Any] = [
        "ServerCapabilities": decode(ServerCapabilities.self),
        "Bootstrap": decode(Bootstrap.self),
        "SyncSnapshot": decode(SyncSnapshot.self),
        "ProjectState": decode(ProjectState.self),
        "[Project]": decode([Project].self),
        "MessagePage": decode(MessagePage.self),
        "Message": decode(Message.self),
        "[Message]": decode([Message].self),
        "Decision": decode(Decision.self),
        "[Activity]": decode([Activity].self),
        "DeliveryNoticePage": decode(DeliveryNoticePage.self),
        "DeliveryNotices": decode(DeliveryNotices.self),
        "ModelCatalog": decode(ModelCatalog.self),
        "PushStatus": decode(PushStatus.self),
        "PushDeviceList": decode(PushDeviceList.self),
        "[FileSearchResult]": decode([FileSearchResult].self),
        "SettingsWriteResult": decode(SettingsWriteResult.self),
        "RealtimeEvent": decode(RealtimeEvent.self),
    ]
    #if COMPAT_SINCE_0_2_4
    // 0.2.4: 설정 → 연결의 '연결된 기기'(ConnectedDevicesView.swift 에서 꺼낸 해석부)와 2xx 가 아닌 답.
    table["DeviceAccessList"] = decode(DeviceAccessList.self)
    table["APIError"] = { data, entry in apiError(data, status: entry.status) }
    #endif
    return table
}
let decoders = makeDecoders()

#if COMPAT_SINCE_0_2_4
/// 0.2.4 APIClient 가 2xx 가 아닌 답에서 APIError 를 만드는 세 줄을 그대로 옮겼다(원문은 요청 함수 한가운데라 꺼낼 수 없다).
/// run.ts 가 이 세 줄이 태그의 APIClient.swift 에 그대로 있는지 본다(releases.json 의 mirrored). APIError 형 자체는 태그에서 꺼낸 원문이다.
func apiError(_ data: Data, status: Int) -> APIError {
    let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let message = object?["error"] as? String ?? object?["message"] as? String ?? "Request failed (\(status))."
    return APIError(status: status, message: message, code: object?["code"] as? String, reason: object?["reason"] as? String)
}

/// 버전 머리글을 보낸 0.2.4 앱이 Bootstrap 을 받고 하는 일(AppStore → CompatNotice, 태그의 AppVersion.swift 원문).
func checkServerInfo(_ value: Any) -> String? {
    let bootstrap: Bootstrap
    if let direct = value as? Bootstrap { bootstrap = direct }
    else if let snapshot = value as? SyncSnapshot { bootstrap = snapshot.bootstrap }
    else { return "형이 맞지 않음" }
    guard bootstrap.server != nil else { return "server 칸을 읽지 못했다(버전 머리글을 보낸 앱이 서버 버전과 API 단계를 모른다)" }
    for onThisMac in [false, true] {
        if let notice = CompatNotice(bootstrap, onThisMac: onThisMac) { return "단계가 맞는데 어긋남 안내가 뜬다: \(notice.text)" }
    }
    #if COMPAT_SINCE_0_2_5
    if let problem = checkServerIdentity(bootstrap) { return problem }
    #endif
    return nil
}

/// 실제로 어긋났을 때(compat 칸이 실린 응답) 0.2.4 가 안내를 띄우는가. 칸을 못 읽거나 모르는 종류에 문장이 없으면 조용히 사라진다.
func checkCompatShown(_ value: Any) -> String? {
    let bootstrap: Bootstrap
    if let direct = value as? Bootstrap { bootstrap = direct }
    else if let snapshot = value as? SyncSnapshot { bootstrap = snapshot.bootstrap }
    else { return "형이 맞지 않음" }
    guard bootstrap.compat != nil else { return "compat 칸을 읽지 못했다" }
    guard CompatNotice(bootstrap, onThisMac: false) != nil else { return "compat 칸을 읽었지만 안내가 뜨지 않는다(모르는 종류에 문장이 없다)" }
    #if COMPAT_SINCE_0_2_5
    if let problem = checkServerIdentity(bootstrap) { return problem }
    #endif
    return nil
}

/// 0.2.4 DevicesPanel.revoke 의 갈래: 2xx 는 끊김, code device_not_found 는 '이미 끊김'으로 줄을 조용히 지움, 그 밖은 빨간 한 줄.
/// 빨간 한 줄은 message 가 비지 않았으면 localizedDescription(ServerErrorText.display) 이다. 영어 화면이면 영어 문장이어야 한다.
func checkRevokeRefused(_ value: Any, language: AppLanguage) -> String? {
    guard let error = value as? APIError else { return "형이 맞지 않음" }
    guard !(200..<300).contains(error.status) else { return "성공(\(error.status))으로 답해 0.2.4 부터의 앱이 끊은 것으로 안다" }
    guard error.code != "device_not_found" else { return "code device_not_found: 0.2.4 부터의 앱이 '이미 끊김'으로 읽고 그 줄을 조용히 지운다" }
    #if COMPAT_SINCE_0_2_5
    // 0.2.5 DevicesPanel.revoke: 이 코드면 까닭('서버가 도는 Mac 에서만')을 보이고 목록을 다시 읽어 단추를 맞춘다. 다른 코드면 실패 한 줄만 남고 단추는 그대로다.
    guard error.code == "device_revoke_local_only" else {
        return "code \(error.code ?? "없음"): 0.2.5 가 '서버가 도는 Mac 에서만' 거절로 알아보지 못해 목록을 다시 읽지 않는다"
    }
    #endif
    guard !error.message.isEmpty, error.message != "Request failed (\(error.status))." else { return "거절 문장(error)을 읽지 못했다" }
    let shown = AppLanguage.withOverride(language) { error.localizedDescription }
    let korean = shown.range(of: #"\p{Hangul}"#, options: .regularExpression) != nil
    if language == .en, korean { return "영어 화면에 한국어 문장이 보인다: \(shown)" }
    if language == .ko, !korean { return "한국어 화면에 한국어가 아닌 문장이 보인다: \(shown)" }
    return nil
}

/// 연결된 기기 목록이 실제로 실렸는가(원소를 모두 버리거나 빈 목록이면 이 덤프가 아무것도 지키지 않는다).
func checkDevices(_ value: Any) -> String? {
    guard let list = value as? DeviceAccessList else { return "형이 맞지 않음" }
    guard !list.devices.isEmpty else { return "연결된 기기 목록이 비었다" }
    return nil
}
#endif

#if COMPAT_SINCE_0_2_5
/// 0.2.5 AppStore+Offline 의 currentServerID·currentServerHome 두 줄을 그대로 옮겼다(원문은 AppStore 의 확장이라 따로 빌드할 수 없다.
/// releases.json 의 mirrorOnly 가 이 두 줄과 ServerIdentity 를 부르는 두 줄이 태그 원문에 그대로 있는지 본다).
/// ServerVersionInfo(id 를 비교할 모양으로 읽는다)와 ServerIdentity 는 태그에서 꺼낸 원문이다.
func currentServer(_ bootstrap: Bootstrap?) -> (id: String?, home: String?) {
    let currentServerID: String? = ServerVersionInfo.normalizedID(bootstrap?.server?.id)
    let currentServerHome: String? = bootstrap.flatMap { $0.home.isEmpty ? nil : $0.home }
    return (currentServerID, currentServerHome)
}

/// 0.2.5 는 연결되면 보낼 글과 결과를 모르는 보낸 글을 쓴 서버의 신원(server.id + home)에 묶는다(AppStore.splitOutbox·sentToCurrentServer:
/// ServerIdentity.same(글의 신원, 지금 응답의 신원)). 글의 신원은 앞서 이 서버에서 받은 응답의 것이라 서버의 실제 신원과 같다.
/// - id 를 못 읽으면 주소로만 가린다(같은 주소에 다른 서버가 떠도 그 서버로 보낸다).
/// - home 이 비면 ID 가 같은 사본(다른 폴더에 복원한 서버, DB 를 복사한 시험 서버)을 가리지 못한다.
/// - 같은 서버로 읽히지 않으면 이 서버에 쓴 글을 '다른 서버에 보내려던 글'로 두고 보내지 않는다.
func checkServerIdentity(_ bootstrap: Bootstrap) -> String? {
    let (id, home) = currentServer(bootstrap)
    guard let id else { return "server.id 를 읽지 못했다(0.2.5 가 연결되면 보낼 글을 주소로만 가린다)" }
    guard let home else { return "home 이 비었다(0.2.5 가 ID 가 같은 다른 폴더의 서버를 가리지 못한다)" }
    guard let savedID = ServerVersionInfo.normalizedID(DumpReference.serverID), let savedHome = DumpReference.serverHome, !savedHome.isEmpty else {
        return "덤프에 서버의 실제 신원(manifest.serverIdentity)이 없다"
    }
    guard ServerIdentity.same(id: savedID, home: savedHome, as: id, home: home) == true else {
        return "응답의 서버 신원(\(id), \(home))이 서버의 실제 신원(\(savedID), \(savedHome))과 같은 서버로 읽히지 않는다: 0.2.5 가 이 서버에 쓴 글을 보내지 않는다"
    }
    return nil
}

/// 0.2.5 연결된 기기의 끊기 단추(DeviceAccessList.canRevoke, 태그 원문): 서버가 도는 Mac 의 앱은 모든 줄, 다른 기기(iPhone)는 자기 줄만.
/// 다른 기기의 남의 줄에 단추가 있으면 누를 때마다 서버가 거절하고, 서버가 도는 Mac 에 단추가 없으면 어디서도 그 기기를 끊을 수 없다.
func checkRevokeButtons(_ value: Any, onServerMac: Bool) -> String? {
    guard let list = value as? DeviceAccessList else { return "형이 맞지 않음" }
    guard list.devices.contains(where: { !$0.current }) else { return "남의 줄이 없어 끊기 단추를 볼 수 없다" }
    if !onServerMac, !list.devices.contains(where: \.current) { return "이 기기 줄(current)이 없다(자기 연결을 끊을 수 없다)" }
    for device in list.devices {
        let shown = list.canRevoke(device), expected = device.current || onServerMac
        guard shown != expected else { continue }
        let flag = list.canRevokeOthers.map { String($0) } ?? "없음"
        return "'\(device.name)' 줄에 끊기 단추가 \(shown ? "있다" : "없다")(canRevokeOthers \(flag)): "
            + (onServerMac ? "서버가 도는 Mac 에서 다른 기기를 끊지 못한다" : "다른 기기에서 남의 줄을 누르면 서버가 거절한다")
    }
    return nil
}
#endif

/// 해석은 되지만 출시 앱이 따로 거는 조건. 어긋나면 그 기능이 조용히 꺼진다(AppStore 의 같은 판정을 옮겨 왔다).
func check(_ name: String, _ value: Any) -> String? {
    switch name {
    #if COMPAT_SINCE_0_2_4
    case "server-info": return checkServerInfo(value)
    case "compat-shown": return checkCompatShown(value)
    case "devices": return checkDevices(value)
    case "revoke-refused-ko": return checkRevokeRefused(value, language: .ko)
    case "revoke-refused-en": return checkRevokeRefused(value, language: .en)
    #endif
    #if COMPAT_SINCE_0_2_5
    case "revoke-buttons-mac": return checkRevokeButtons(value, onServerMac: true)
    case "revoke-buttons-remote": return checkRevokeButtons(value, onServerMac: false)
    #endif
    case "contract-v2":
        // AppStore: contractVersion == 2 && operations/realtime == true 가 아니면 v1 쓰기와 3초 조회로 내려간다.
        guard let caps = value as? ServerCapabilities else { return "형이 맞지 않음" }
        guard caps.contractVersion == 2, caps.capabilities?.realtime == true, caps.capabilities?.operations == true else {
            return "contractVersion 2·realtime·operations 가 아니다(옛 앱이 v1 쓰기와 3초 조회로 내려간다)"
        }
    case "sync-ok":
        guard let snapshot = value as? SyncSnapshot else { return "형이 맞지 않음" }
        guard snapshot.projectStatus == .ok, snapshot.state != nil else { return "프로젝트 상태가 ok 가 아니다" }
    case "notices-v2":
        // AppStore.deliveryNotices: version == 2 가 아니면 전달 안내가 조용히 사라진다.
        let version: Int?
        if let snapshot = value as? SyncSnapshot { version = snapshot.state?.deliveryNotices?.version }
        else if let state = value as? ProjectState { version = state.deliveryNotices?.version }
        else if let notices = value as? DeliveryNotices { version = notices.version }
        else { return "형이 맞지 않음" }
        guard version == 2 else { return "전달 안내 version 이 2 가 아니다(\(version.map(String.init) ?? "없음")): 옛 앱에서 전달 안내가 사라진다" }
    case "hello-v2":
        guard let event = value as? RealtimeEvent else { return "형이 맞지 않음" }
        guard event.type == "hello", event.protocolVersion == 2, event.cursor != nil else { return "v2 hello 가 아니다" }
    case "event-payload":
        guard let event = value as? RealtimeEvent else { return "형이 맞지 않음" }
        let present: Bool
        switch event.type {
        case "projects": present = event.projects != nil
        case "project": present = event.project != nil
        case "member": present = event.member != nil
        case "member_removed": present = event.projectId != nil && event.memberId != nil
        case "decision": present = event.decision != nil
        case "todo": present = event.todo != nil
        case "work": present = event.work != nil && event.projectId != nil
        case "message": present = event.message != nil
        case "file": present = event.file != nil
        case "activity": present = event.activity != nil && event.projectId != nil
        case "settings": present = event.settings != nil
        default: return "옛 앱이 모르는 사건 종류 '\(event.type)'"
        }
        guard present, event.cursor != nil else { return "사건 '\(event.type)' 의 본문이나 순번을 읽지 못했다" }
    default:
        return "알 수 없는 검사 '\(name)'"
    }
    return nil
}

@MainActor func run() -> Int32 {
    let arguments = CommandLine.arguments
    guard arguments.count == 4 else {
        print("쓰는 법: CompatCheck <덤프 폴더> <allow.json> <릴리스 이름>")
        return 2
    }
    let folder = URL(fileURLWithPath: arguments[1], isDirectory: true)
    let release = arguments[3]
    guard let manifestData = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")),
          let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
          let rawEntries = manifest["entries"] as? [[String: Any]], !rawEntries.isEmpty else {
        print("[\(release)] 덤프 목록(manifest.json)을 읽지 못했습니다: \(folder.path)")
        return 2
    }
    let entries = rawEntries.compactMap { raw -> Entry? in
        guard let file = raw["file"] as? String, let type = raw["type"] as? String else { return nil }
        return Entry(file: file, type: type, checks: raw["checks"] as? [String] ?? [], note: raw["note"] as? String ?? "", status: raw["status"] as? Int ?? 200)
    }
    if let identity = manifest["serverIdentity"] as? [String: Any] {
        DumpReference.serverID = identity["id"] as? String
        DumpReference.serverHome = identity["home"] as? String
    }
    var allows: [Allow] = []
    if let data = try? Data(contentsOf: URL(fileURLWithPath: arguments[2])),
       let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
        allows = list.compactMap { raw in
            guard let contains = raw["contains"] as? String, !contains.isEmpty, let reason = raw["reason"] as? String, !reason.isEmpty else { return nil }
            return Allow(release: raw["release"] as? String, file: raw["file"] as? String, contains: contains, reason: reason)
        }
    }
    var failures = 0, allowed = 0
    for entry in entries {
        guard let decoder = decoders[entry.type] else {
            print("실패 [\(release)] \(entry.file): 이 해석기가 모르는 형 \(entry.type)")
            failures += 1; continue
        }
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(entry.file)) else {
            print("실패 [\(release)] \(entry.file): 덤프 파일이 없습니다")
            failures += 1; continue
        }
        CompatProbe.records.removeAll()
        let value: Any
        do { value = try decoder(data, entry) }
        catch {
            print("실패 [\(release)] \(entry.file) (\(entry.note)): \(entry.type) 해석 실패 — \(CompatProbe.describe(error))")
            failures += 1; continue
        }
        var problems = entry.checks.compactMap { check($0, value) }
        for record in CompatProbe.records {
            if let allow = allows.first(where: { ($0.release ?? release) == release && ($0.file ?? entry.file) == entry.file && record.contains($0.contains) }) {
                allowed += 1
                print("허용 [\(release)] \(entry.file): \(record) — \(allow.reason)")
            } else { problems.append(record) }
        }
        if problems.isEmpty { continue }
        failures += 1
        for problem in problems { print("실패 [\(release)] \(entry.file) (\(entry.note)): \(problem)") }
    }
    print("[\(release)] 응답 \(entries.count)개 가운데 실패 \(failures)개" + (allowed > 0 ? ", 허용 \(allowed)건" : ""))
    return failures == 0 ? 0 : 1
}

exit(run())
