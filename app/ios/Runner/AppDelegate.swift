import Flutter
import UIKit
import PushKit
import CallKit
import AVFoundation

// Maya ringing a CLOSED iPhone: an Apple VoIP push (PushKit) wakes the app, which MUST show CallKit's incoming call screen at once (iOS rule).
// Accept tells Dart, which joins the same live call socket as an in-app Accept. Decline tells the server straight from here, so it works with the app not running.
// The server needs APNs keys and the app needs the Push Notifications capability + the "Voice over IP" background mode in Xcode: none of that is in this repository.
// Without them no push token is issued and the server falls back (WhatsApp under its rules).
final class NativeCall: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  static let shared = NativeCall()
  private var channel: FlutterMethodChannel?
  private var registry: PKPushRegistry?
  private let provider: CXProvider
  private let controller = CXCallController()
  private var ringing: [UUID: String] = [:]   // call -> outreach id, until answered
  private var active: [UUID: String] = [:]    // answered
  private var queue: [(String, [String: Any])] = []
  private var lastToken: String?

  override init() {
    let c = CXProviderConfiguration()
    c.supportsVideo = false
    c.maximumCallsPerCallGroup = 1
    c.supportedHandleTypes = [.generic]
    c.includesCallsInRecents = false
    provider = CXProvider(configuration: c)
    super.init()
    provider.setDelegate(self, queue: nil)
  }

  // At launch, always: a push that wakes a killed app is delivered to the registry created here.
  func startPush() {
    guard registry == nil else { return }
    let r = PKPushRegistry(queue: .main)
    r.delegate = self
    r.desiredPushTypes = [.voIP]
    registry = r
  }

  func bind(_ messenger: FlutterBinaryMessenger) {
    let ch = FlutterMethodChannel(name: "maya/native_call", binaryMessenger: messenger)
    ch.setMethodCallHandler { [weak self] call, result in
      guard let self = self else { return }
      let a = call.arguments as? [String: Any] ?? [:]
      switch call.method {
      case "configure":   // the server address and the profile, kept so a Decline can reach the server even when Dart is not running
        UserDefaults.standard.set(a["base"] as? String ?? "", forKey: "maya_base")
        UserDefaults.standard.set(a["profile"] as? String ?? "", forKey: "maya_profile")
        self.startPush()
        result(nil)
      case "ready":
        self.channel = ch
        if let t = self.lastToken { self.emit("token", ["platform": "ios", "token": t]) }
        let q = self.queue; self.queue.removeAll()
        for (n, d) in q { self.emit(n, d) }
        result(nil)
      case "dismiss":   // the app is open and rings in its own screen: take the system call screen down
        if let oid = a["outreachId"] as? String { self.end(outreach: oid, reason: .answeredElsewhere) }
        result(nil)
      case "callEnded":   // the live call finished inside the app: end the system call too
        if let oid = a["outreachId"] as? String { self.requestEnd(outreach: oid) }
        result(nil)
      default: result(FlutterMethodNotImplemented)
      }
    }
  }

  private func emit(_ name: String, _ data: [String: Any]) {
    if let c = channel { c.invokeMethod(name, arguments: data) } else { queue.append((name, data)) }
  }

  private func uuid(for oid: String) -> UUID? {
    return ringing.first(where: { $0.value == oid })?.key ?? active.first(where: { $0.value == oid })?.key
  }
  private func end(outreach oid: String, reason: CXCallEndedReason) {
    guard let u = uuid(for: oid) else { return }
    ringing[u] = nil; active[u] = nil
    provider.reportCall(with: u, endedAt: nil, reason: reason)
  }
  private func requestEnd(outreach oid: String) {
    guard let u = uuid(for: oid) else { return }
    controller.request(CXTransaction(action: CXEndCallAction(call: u)), completion: { _ in })
  }

  // Decline, straight to the server: POST /api/care/<profile>/outreach/<id>/decline (the same call the in-app Decline makes).
  private func declineToServer(_ oid: String) {
    let d = UserDefaults.standard
    guard let base = d.string(forKey: "maya_base"), let pid = d.string(forKey: "maya_profile"), !base.isEmpty, !pid.isEmpty,
          let url = URL(string: "\(base)/api/care/\(pid)/outreach/\(oid)/decline") else { return }
    var req = URLRequest(url: url, timeoutInterval: 8)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = "{}".data(using: .utf8)
    URLSession.shared.dataTask(with: req).resume()
  }

  // MARK: PushKit
  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    let t = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    lastToken = t
    if channel != nil { emit("token", ["platform": "ios", "token": t]) }
  }

  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    let d = payload.dictionaryPayload
    let oid = d["outreachId"] as? String
    let ringMs = (d["ringMs"] as? Double) ?? Double(d["ringMs"] as? Int ?? 30000)
    let u = UUID()
    let upd = CXCallUpdate()
    upd.remoteHandle = CXHandle(type: .generic, value: "Maya")
    upd.localizedCallerName = "Maya"
    upd.hasVideo = false
    provider.reportNewIncomingCall(with: u, update: upd) { [weak self] err in
      if err != nil || oid == nil || (d["type"] as? String) != "incoming" {
        // iOS requires every VoIP push to show a call; one we cannot use is shown and ended at once
        self?.provider.reportCall(with: u, endedAt: nil, reason: .failed)
      } else if let oid = oid {
        self?.ringing[u] = oid
        // no answer in the ring time: the call screen goes away by itself
        DispatchQueue.main.asyncAfter(deadline: .now() + ringMs / 1000.0) { [weak self] in
          if self?.ringing[u] != nil { self?.ringing[u] = nil; self?.provider.reportCall(with: u, endedAt: nil, reason: .unanswered) }
        }
      }
      completion()
    }
  }

  // MARK: CallKit
  func providerDidReset(_ provider: CXProvider) { ringing.removeAll(); active.removeAll() }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    if let oid = ringing[action.callUUID] {
      ringing[action.callUUID] = nil; active[action.callUUID] = oid
      emit("accepted", ["outreachId": oid])
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    if let oid = ringing[action.callUUID] {          // Decline
      ringing[action.callUUID] = nil
      declineToServer(oid)
      emit("declined", ["outreachId": oid])
    } else if let oid = active[action.callUUID] {    // hung up from the system screen
      active[action.callUUID] = nil
      emit("ended", ["outreachId": oid])
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {}
  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
}

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    NativeCall.shared.startPush()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let r = engineBridge.pluginRegistry.registrar(forPlugin: "MayaNativeCall") { NativeCall.shared.bind(r.messenger()) }
  }
}
