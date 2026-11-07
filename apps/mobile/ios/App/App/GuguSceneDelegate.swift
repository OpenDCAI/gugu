import Capacitor
import UIKit

/** UIKit requires scene lifecycle adoption for apps built with the iOS 27 SDK. */
final class GuguSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        open(connectionOptions.urlContexts)
        for activity in connectionOptions.userActivities { continueActivity(activity) }
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) { open(contexts) }
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) { continueActivity(userActivity) }

    private func open(_ contexts: Set<UIOpenURLContext>) {
        for context in contexts {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: [:])
        }
    }

    private func continueActivity(_ activity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
}
