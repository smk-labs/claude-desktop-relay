// The tray: a menu bar item over the relay's own local API.
//
// Thin on purpose. It reads one small document from the relay and draws a menu
// from it; it holds no state, decides nothing, and knows nothing about Seats
// beyond the names the relay hands it. Delete this file and the page is
// untouched, which is the test design.md sets for it.
//
// Built with the swiftc that ships with the Command Line Tools, so the project
// still has no runtime dependency of any kind.

import AppKit
import Foundation

// MARK: - what the relay says

struct TrayLine: Decodable {
    let name: String
    let plan: String
    let left: String
    // Both windows, spent, and when each comes back. Optional, so a tray running
    // against an older relay still decodes and falls back to the bare percentage.
    let room: String?

    /// What the row says on its right. The full line when there is one.
    var saying: String { room ?? left }
}

/// One Claude Desktop profile, as the relay describes it.
struct TrayProfile: Decodable {
    let name: String
    let saying: String
    let relayed: Bool
    let running: Bool
}

struct TrayMenu: Decodable {
    let icon: String
    let saying: String
    let paying: TrayLine?
    // Decided by the relay, never by this shell, so the menu and the page cannot
    // disagree about what is paying. Optional, so an older relay still decodes.
    let payingSaying: String?
    // What the paying Seat has spent, in whole words, for the tooltip. Optional,
    // so a payload from an older relay still decodes.
    let payingRoom: String?
    // Which Claude Desktop profile these figures are about. ADR 0014: there are two
    // now and only one is relayed, so a menu that never says which leaves the reader
    // guessing. Optional, so a payload from an older relay still decodes.
    let relaying: String?
    // When the figures were last read, already worded by the relay. Optional, so a
    // payload from an older relay still decodes.
    let refreshed: String?
    let mode: String
    // The profiles on this machine, so the menu bar can open any of them and say
    // which one is relayed. Optional, so a payload from an older relay still decodes.
    let profiles: [TrayProfile]?
    let seats: [TrayLine]
    let open: String
}

// MARK: - the icon, four states, shape as well as colour

/// A patch cord. Two plugs and the cord between them, drawn so that the four
/// states differ in shape: no cord, a cord, a cord with one end run down, and a
/// snapped cord on two heights. Colour is the second signal, never the only one.
func cordImage(_ state: String) -> NSImage {
    let size = NSSize(width: 18, height: 16)
    let image = NSImage(size: size, flipped: false) { rect in
        let ink: NSColor
        switch state {
        case "on", "strained": ink = NSColor.controlAccentColor
        case "broken": ink = NSColor.systemRed
        default: ink = NSColor.tertiaryLabelColor
        }
        ink.setStroke()
        ink.setFill()

        // The near plug: always there, because the relay itself is always there.
        NSBezierPath(roundedRect: NSRect(x: 1, y: rect.height / 2 - 2.5, width: 4, height: 5), xRadius: 1.6, yRadius: 1.6).fill()

        let cord = NSBezierPath()
        cord.lineWidth = 1.8
        cord.lineCapStyle = .round

        switch state {
        case "off":
            // No cord at all, and the far plug stands apart.
            NSBezierPath(roundedRect: NSRect(x: 13, y: rect.height / 2 - 2.5, width: 4, height: 5), xRadius: 1.6, yRadius: 1.6).fill()
        case "broken":
            // Severed, and the two ends spring to different heights.
            cord.move(to: NSPoint(x: 5, y: rect.height / 2 + 2))
            cord.line(to: NSPoint(x: 9, y: rect.height / 2 + 2))
            cord.stroke()
            NSBezierPath(roundedRect: NSRect(x: 13, y: rect.height / 2 - 5, width: 4, height: 5), xRadius: 1.6, yRadius: 1.6).fill()
        case "strained":
            // Connected, but the far plug has run down to a sliver.
            cord.move(to: NSPoint(x: 5, y: rect.height / 2))
            cord.line(to: NSPoint(x: 13, y: rect.height / 2))
            cord.stroke()
            NSBezierPath(roundedRect: NSRect(x: 13, y: rect.height / 2 - 1.1, width: 4, height: 2.2), xRadius: 1.1, yRadius: 1.1).fill()
        default:
            cord.move(to: NSPoint(x: 5, y: rect.height / 2))
            cord.line(to: NSPoint(x: 13, y: rect.height / 2))
            cord.stroke()
            NSBezierPath(roundedRect: NSRect(x: 13, y: rect.height / 2 - 2.5, width: 4, height: 5), xRadius: 1.6, yRadius: 1.6).fill()
        }
        return true
    }
    // Not a template image: the four states are told apart by colour as well, and
    // a template image would flatten all four to the menu bar's own ink.
    image.isTemplate = false
    return image
}

// MARK: - the shell

final class Tray: NSObject, NSApplicationDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let relay: URL
    private var timer: Timer?
    private var menu = TrayMenu(icon: "off", saying: "Relay is starting", paying: nil, payingSaying: nil, payingRoom: nil, relaying: nil, refreshed: nil, mode: "off", profiles: nil, seats: [], open: "")

    init(relay: URL) {
        self.relay = relay
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        item.button?.image = cordImage("off")
        /**
         * Said out loud, because "the process is running" is not "you can see it".
         *
         * A menu bar that is already full silently drops a new status item: the app
         * runs, holds its connection, answers everything, and shows nothing. That
         * cost a session of believing the tray was installed when nobody could see
         * it, so the one fact that settles it is printed rather than assumed.
         */
        let visible = item.button?.window != nil && (item.button?.frame.width ?? 0) > 0
        let saying = "tray: status item "
            + (visible ? "is in the menu bar" : "was NOT given a place in the menu bar")
            + ", width \(item.button?.frame.width ?? 0), port \(port)\n"
        FileHandle.standardError.write(saying.data(using: .utf8)!)
        /**
         * Also written to a file, because a bundle launched by the Finder has no
         * terminal and its standard error goes nowhere. Without this the only way to
         * answer "did it actually appear" was to ask the person looking at the
         * screen, and that is the question this is meant to settle.
         */
        let note = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude-relayed/tray/last-launch.log")
        try? saying.data(using: .utf8)?.write(to: note)
        draw()
        // Every few seconds, because the menu is read at a glance and a menu that
        // is wrong at a glance is worse than no menu.
        timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.read() }
        read()
    }

    private func read() {
        var request = URLRequest(url: relay.appendingPathComponent("tray"))
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self else { return }
            guard let data, let read = try? JSONDecoder().decode(TrayMenu.self, from: data) else {
                // The relay is restarting, or is not there. Said plainly rather
                // than left showing the last good answer as if it were current.
                DispatchQueue.main.async {
                    self.menu = TrayMenu(icon: "broken", saying: "Relay is not answering", paying: nil, payingSaying: nil, payingRoom: nil, relaying: self.menu.relaying, refreshed: self.menu.refreshed, mode: self.menu.mode, profiles: self.menu.profiles, seats: [], open: self.menu.open)
                    self.draw()
                }
                return
            }
            DispatchQueue.main.async {
                self.menu = read
                self.draw()
            }
        }.resume()
    }

    private func draw() {
        item.button?.image = cordImage(menu.icon)
        // The whole summary without a click: what state the relay is in, and what
        // the Seat paying has spent on both windows. A tooltip that only said
        // "Relay is on" made the menu the only way to learn anything.
        item.button?.toolTip = [menu.payingSaying, menu.payingRoom, menu.saying]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")

        let drawn = NSMenu()
        drawn.addItem(header("Paying now"))

        if let paying = menu.paying {
            drawn.addItem(row(title: "\(paying.name) · \(paying.plan)", right: paying.saying, ticked: true, action: nil))
        } else {
            // Whatever the relay says it is. Writing "The Window account" here was
            // wrong whenever the relay was on and had simply not chosen yet.
            drawn.addItem(row(title: menu.payingSaying ?? "The Window account", right: "", ticked: false, action: nil))
        }

        drawn.addItem(.separator())
        drawn.addItem(header("Mode"))
        for (name, label) in [("auto", "Auto"), ("manual", "Manual"), ("off", "Off")] {
            let one = NSMenuItem(title: label, action: #selector(pickMode(_:)), keyEquivalent: "")
            one.target = self
            one.representedObject = name
            one.state = menu.mode == name ? .on : .off
            drawn.addItem(one)
        }

        if !menu.seats.isEmpty {
            drawn.addItem(.separator())
            drawn.addItem(header("Switch to", hint: "sets Manual"))
            for seat in menu.seats {
                drawn.addItem(row(title: "\(seat.name) · \(seat.plan)", right: seat.saying, ticked: false, action: #selector(pickSeat(_:)), object: seat.name))
            }
        }

        if let profiles = menu.profiles, !profiles.isEmpty {
            drawn.addItem(.separator())
            drawn.addItem(header("Claude Desktop", hint: "click to open"))
            for profile in profiles {
                // A tick on the profile this relay is behind, so the one fact a
                // person came to the menu for is readable without opening the page.
                let one = row(
                    title: profile.running ? "\(profile.name) ●" : profile.name,
                    right: profile.saying,
                    ticked: profile.relayed,
                    action: #selector(openProfile(_:)),
                    object: profile.name
                )
                drawn.addItem(one)
            }
        }

        drawn.addItem(.separator())
        if let relaying = menu.relaying {
            drawn.addItem(header("Relaying", hint: relaying))
        }
        // When these figures were read. Every number above is a reading taken at
        // some earlier moment, and a menu that never dates itself looks equally
        // current an hour later.
        if let refreshed = menu.refreshed, !refreshed.isEmpty {
            drawn.addItem(header(refreshed))
        }
        let open = NSMenuItem(title: "Open Relay…", action: #selector(openPage), keyEquivalent: "")
        open.target = self
        drawn.addItem(open)
        let quit = NSMenuItem(title: "Quit Relay tray", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        drawn.addItem(quit)

        item.menu = drawn
    }

    private func header(_ title: String, hint: String = "") -> NSMenuItem {
        let one = NSMenuItem(title: hint.isEmpty ? title : "\(title)    \(hint)", action: nil, keyEquivalent: "")
        one.isEnabled = false
        return one
    }

    private func row(title: String, right: String, ticked: Bool, action: Selector?, object: Any? = nil) -> NSMenuItem {
        let one = NSMenuItem(title: right.isEmpty ? title : "\(title)    \(right)", action: action, keyEquivalent: "")
        if action != nil { one.target = self }
        one.representedObject = object
        one.state = ticked ? .on : .off
        return one
    }

    /// Picking a Seat sets the Mode to Manual, because a deliberate choice must
    /// not be overridden by Auto a moment later. The relay does that itself; this
    /// only says which Seat.
    @objc private func pickSeat(_ sender: NSMenuItem) {
        guard let seat = sender.representedObject as? String else { return }
        act(["use": seat])
    }

    /// Open a Claude Desktop profile. Opening only: this menu never closes a Window
    /// and never changes whether a profile is relayed.
    @objc private func openProfile(_ sender: NSMenuItem) {
        guard let profile = sender.representedObject as? String else { return }
        act(["open": profile])
    }

    @objc private func pickMode(_ sender: NSMenuItem) {
        guard let mode = sender.representedObject as? String else { return }
        act(["mode": mode])
    }

    private func act(_ body: [String: String]) {
        var request = URLRequest(url: relay.appendingPathComponent("act"))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.read() }
        }.resume()
    }

    @objc private func openPage() {
        if let url = URL(string: menu.open.isEmpty ? relay.absoluteString : menu.open) { NSWorkspace.shared.open(url) }
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }
}

/// Write the icon the menu bar uses out as an iconset, at the sizes macOS asks for.
///
/// The app's icon is the same drawing as its status item, rendered larger, so there
/// is one piece of artwork and it is the one the design settled on. Called by
/// `relay tray --install` and never at run time.
func writeIconset(into folder: String) -> Int32 {
    let sizes: [(Int, String)] = [
        (16, "icon_16x16"), (32, "icon_16x16@2x"), (32, "icon_32x32"), (64, "icon_32x32@2x"),
        (128, "icon_128x128"), (256, "icon_128x128@2x"), (256, "icon_256x256"),
        (512, "icon_256x256@2x"), (512, "icon_512x512"), (1024, "icon_512x512@2x"),
    ]
    for (pixels, name) in sizes {
        let side = CGFloat(pixels)
        let canvas = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            // The cord is 18x16; centre it with room around it, the way an app icon sits.
            let scale = side / 26.0
            NSColor.clear.setFill()
            rect.fill()
            let context = NSGraphicsContext.current?.cgContext
            context?.saveGState()
            context?.translateBy(x: (side - 18 * scale) / 2, y: (side - 16 * scale) / 2)
            context?.scaleBy(x: scale, y: scale)
            cordImage("on").draw(in: NSRect(x: 0, y: 0, width: 18, height: 16))
            context?.restoreGState()
            return true
        }
        guard let tiff = canvas.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:])
        else { return 1 }
        do {
            try png.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
        } catch {
            FileHandle.standardError.write("could not write \(name): \(error)\n".data(using: .utf8)!)
            return 1
        }
    }
    return 0
}

if let at = CommandLine.arguments.firstIndex(of: "--write-iconset"), CommandLine.arguments.count > at + 1 {
    exit(writeIconset(into: CommandLine.arguments[at + 1]))
}

/// The port, from the argument in a terminal or from the bundle in /Applications.
///
/// A bundle opened from the Finder is given no arguments, so the installer writes
/// the port into `Info.plist` as `RelayPort`. The argument still wins, because
/// `relay tray` runs the same binary from a terminal and passing it there has to
/// keep working. Either way the port is a fact about one relay, ADR 0012, and never
/// a constant compiled in here.
let portFromBundle = Bundle.main.object(forInfoDictionaryKey: "RelayPort") as? String
let port = CommandLine.arguments.count > 1 && !CommandLine.arguments[1].hasPrefix("--")
    ? CommandLine.arguments[1]
    : (portFromBundle ?? "8978")
guard let relay = URL(string: "http://127.0.0.1:\(port)") else { exit(1) }

let application = NSApplication.shared
// No Dock icon and no menu bar of its own: this is one status item and nothing else.
application.setActivationPolicy(.accessory)
let tray = Tray(relay: relay)
application.delegate = tray
application.run()
