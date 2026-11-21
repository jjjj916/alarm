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
                var ready = false
                do {
                    ready = try await IOSAlarmKitBridge.shared.sync(payload: payload)
                } catch {
                    print("SmartClock AlarmKit sync error: \(error)")
                }
                // AlarmKit이 울리면 웹 화면은 알람음을 따로 재생하지 않음 (영상 시청 중에도 시스템 알람이 울림)
                self.webView?.evaluateJavaScript("window.__onIOSAlarmKitReady && window.__onIOSAlarmKitReady(\(ready ? "true" : "false"));")
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("window.syncAlarmsToNativeForIOS && window.syncAlarmsToNativeForIOS();")
        }
    }
}
