import SwiftUI
import WebKit

struct SmartClockWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let content = WKUserContentController()
        content.add(context.coordinator, name: "smartClock")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = content
        configuration.allowsInlineMediaPlayback = true
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.load(URLRequest(url: URL(string: "https://alarm-lemon-omega.vercel.app")!))
        context.coordinator.webView = web
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == "smartClock",
                  let body = message.body as? [String: Any],
                  let action = body["action"] as? String,
                  action == "syncState",
                  let payload = body["payload"] as? [String: Any] else { return }
            Task { @MainActor in
                do {
                    try await IOSAlarmKitBridge.shared.sync(payload: payload)
                } catch {
                    print("SmartClock AlarmKit sync error: \(error)")
                }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("window.syncAlarmsToNativeForIOS && window.syncAlarmsToNativeForIOS();")
        }
    }
}
