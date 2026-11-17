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

    /// `base` with `color` laid over it at `alpha`, per channel (sRGB, as the screen composites it).
    private func blend(_ base: UInt32, _ color: UInt32, _ alpha: Double) -> UInt32 {
        [16, 8, 0].reduce(UInt32(0)) { out, shift in
            let b = Double((base >> UInt32(shift)) & 255), c = Double((color >> UInt32(shift)) & 255)
            return out | (UInt32((b * (1 - alpha) + c * alpha).rounded()) << UInt32(shift))
        }
    }

    /// The file chip on my bubble is a darker ink wash in a white ring with white text (web .th-mine .atv-file), and
    /// every text on it reads at 4.5:1 or more on both bubble stops, at rest and on hover.
    func testFileChipOnMyBubbleMatchesWebAndReadsAtAA() {
        XCTAssertEqual(ChatFileChip.mineShadeHex, 0x17132B)
        XCTAssertEqual(ChatFileChip.mineShade.rest, 0.14)
        XCTAssertEqual(ChatFileChip.mineShade.hover, 0.22)
        XCTAssertEqual(ChatFileChip.mineRing, 0.28)
        for stop in CE.mineHex {
            for alpha in [ChatFileChip.mineShade.rest, ChatFileChip.mineShade.hover] {
                let chip = blend(stop, ChatFileChip.mineShadeHex, alpha)
                for ink in [ChatFileChip.nameInk(onBubble: true), ChatFileChip.subInk(onBubble: true)] {
                    let ratio = contrast(ink, chip)
                    XCTAssertGreaterThanOrEqual(ratio, 4.5, String(format: "%06X on chip %06X: %.2f", ink, chip, ratio))
                }
            }
        }
    }

    /// On the light cards the chip is --soft (violet .07, hover .12) in --soft-ring (.16), name ink-1, size ink-2; it
    /// reads at 4.5:1 or more over the card (white .6) even on a violet-tinted backdrop.
    func testFileChipOnCardsMatchesWebAndReadsAtAA() {
        XCTAssertEqual(ChatFileChip.violetHex, 0x7A5BFF)
        XCTAssertEqual(ChatFileChip.cardWash.rest, 0.07)
        XCTAssertEqual(ChatFileChip.cardWash.hover, 0.12)
        XCTAssertEqual(ChatFileChip.cardRing, 0.16)
        XCTAssertEqual(ChatFileChip.nameInk(onBubble: false), 0x17132B)
        XCTAssertEqual(ChatFileChip.subInk(onBubble: false), 0x4A4566)
        for backdrop: UInt32 in [0xF7F5FD, 0xEFEBFA, blend(0xF7F5FD, 0x7A5BFF, 0.25)] {
            let card = blend(backdrop, 0xFFFFFF, 0.6)
            for alpha in [ChatFileChip.cardWash.rest, ChatFileChip.cardWash.hover] {
                let chip = blend(card, ChatFileChip.violetHex, alpha)
                for ink in [ChatFileChip.nameInk(onBubble: false), ChatFileChip.subInk(onBubble: false)] {
                    XCTAssertGreaterThanOrEqual(contrast(ink, chip), 4.5, String(format: "%06X on chip %06X", ink, chip))
                }
            }
        }
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
