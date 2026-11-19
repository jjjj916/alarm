import SwiftUI

@main
struct SmartClockIOSApp: App {
    var body: some Scene {
        WindowGroup {
            SmartClockWebView()
                .ignoresSafeArea()
        }
    }
}
