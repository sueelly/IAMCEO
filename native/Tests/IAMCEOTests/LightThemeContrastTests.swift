import XCTest
@testable import IAMCEO

/// Light theme leftovers: the subline on the owner's violet bubble must read at WCAG AA (4.5:1) everywhere on the
/// bubble, and the office furniture must be drawn in light colours (no dark desk, chair, monitor or keyboard).
final class LightThemeContrastTests: XCTestCase {
    private func channel(_ value: UInt32) -> Double {
        let c = Double(value & 255) / 255
        return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }

    private func luminance(_ hex: UInt32) -> Double {
        0.2126 * channel(hex >> 16) + 0.7152 * channel(hex >> 8) + 0.0722 * channel(hex)
    }

    private func contrast(_ a: UInt32, _ b: UInt32) -> Double {
        let (la, lb) = (luminance(a), luminance(b))
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    func testBubbleSublineReadsAtAAOnEveryBubbleStop() {
        for stop in CE.mineHex {
            let ratio = contrast(CE.onAccentSubHex, stop)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, String(format: "subline on %06X: %.2f", stop, ratio))
        }
    }

    func testBubbleTextIsWhiteAtAAOnEveryBubbleStop() {
        for stop in CE.mineHex { XCTAssertGreaterThanOrEqual(contrast(0xFFFFFF, stop), 4.5) }
    }

    func testOfficeFurnitureIsLight() {
        let pieces: [(String, OfficeArt.Piece)] = [
            ("desk", OfficeArt.desk), ("deskLead", OfficeArt.deskLead), ("lid", OfficeArt.lid),
            ("lidClosed", OfficeArt.lidClosed), ("monitor", OfficeArt.monitor), ("monitorBack", OfficeArt.monitorBack),
            ("keyboard", OfficeArt.keyboard), ("chairFront", OfficeArt.chairFront), ("chairBack", OfficeArt.chairBack),
            ("chairLead", OfficeArt.chairLead), ("chairFrontLip", OfficeArt.chairFrontLip),
        ]
        for (name, piece) in pieces {
            for (key, hex) in piece.palette where key != "@" {
                // The outline may be a mid violet; every fill is light.
                let floor = key == "K" ? 0.15 : 0.35
                XCTAssertGreaterThanOrEqual(luminance(hex), floor, String(format: "%@ '%@' %06X is dark", name, String(key), hex))
            }
        }
        XCTAssertGreaterThanOrEqual(luminance(OfficePalette.screenOnHex), 0.35, "a lit screen is light")
        XCTAssertGreaterThanOrEqual(luminance(OfficePalette.led(.off)), 0.35, "an off light is not a dark dot")
    }
}
