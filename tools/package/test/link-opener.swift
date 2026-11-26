// A window-less app that opens one link with one app through NSWorkspace, as Slack or Ghostty
// open a link, so the receiver gets a kAEGetURL Apple Event whose sender is this app (spec
// app-routes, "macOS smoke"). tools/e2e/macos-app-routes.ts builds it into a bundle with the
// identifier dev.vimma.test.link-opener and starts it through LaunchServices:
//   link-opener APP URL OUT [ARG...]
// ARG are the arguments of the app if this starts it (a cold start). OUT gets one line: `opened
// <pid>` or `error <message>`. The app then stays running for STAY seconds, so the receiver can
// still look this sender up while it handles the event.
import AppKit

let stay = 20.0
let args = CommandLine.arguments
guard args.count >= 4, let url = URL(string: args[2]) else {
  FileHandle.standardError.write("usage: link-opener APP URL OUT [ARG...]\n".data(using: .utf8)!)
  exit(64)
}
let app = URL(fileURLWithPath: args[1])
let out = args[3]
let config = NSWorkspace.OpenConfiguration()
config.arguments = Array(args.dropFirst(4))
config.activates = true

NSApplication.shared.setActivationPolicy(.accessory)
NSWorkspace.shared.open([url], withApplicationAt: app, configuration: config) { running, error in
  let line = error.map { "error \($0.localizedDescription)" }
    ?? "opened \(running?.processIdentifier ?? 0)"
  try? (line + "\n").write(toFile: out, atomically: true, encoding: .utf8)
  DispatchQueue.main.asyncAfter(deadline: .now() + stay) { exit(error == nil ? 0 : 1) }
}
NSApplication.shared.run()
