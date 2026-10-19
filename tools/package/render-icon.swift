// Renders the icon macOS shows for a file or app bundle into a 512 px PNG, as Finder and the Dock
// draw it (spec macos-homebrew, "Tests"): `swift tools/package/render-icon.swift PATH OUT.png`.
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("usage: render-icon.swift PATH OUT.png\n".data(using: .utf8)!)
  exit(2)
}
let icon = NSWorkspace.shared.icon(forFile: args[1])
let size = 512
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
  bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
