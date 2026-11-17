import SwiftUI

/// Design tokens: the light glass theme (owner-approved mockup `images/light-glass-mockup-20261109-100709`, Nov 9 2026).
/// A near-white violet-tinted background with soft violet and ice light; white glass for chrome and cards; the existing
/// violet kept for buttons, selection, badges and links only. Content sits on calm plates; glass is reserved for chrome
/// (sidebar, toolbar, tab bar, composer, sticky bars).
///
/// State colours come in two strengths: `CE.live`, `CE.attention`, … are the TEXT strength (≥ 4.5:1 on the clear white
/// glass, white 24% at its bottom, over the aurora's violet peak),
/// safe for labels and icons; `CE.liveDot`, `CE.attentionDot`, … are the bright DOT strength for dots, glows and bars
/// only (never text). `Tone.color` is text strength, `Tone.dot` dot strength.
enum CE {
    /// Ink base for hairlines and quiet neutral washes on the light background (`CE.wash`).
    static let inkBase = Color(hex: 0x17132B)
    static let bg = Color(hex: 0xF7F5FD)
    /// A well inside a card (input fields, inset boxes): white, used at 50–90%.
    static let bgDeep = Color.white
    /// Reduce Transparency surfaces.
    static let plateSolid = Color.white
    static let plateRaisedSolid = Color(hex: 0xF3F0FC)
    static let plate = Color.white.opacity(0.6)
    static let plateRaised = Color.white.opacity(0.82)
    static let line = Color(hex: 0x17132B).opacity(0.08)
    static let lineStrong = Color(hex: 0x17132B).opacity(0.14)
    /// Body text #17132B, secondary #4A4566, faint #5F5983 (all ≥ 4.5:1 on the background and on white glass).
    static let ink = Color(hex: 0x17132B)
    static let ink2 = Color(hex: 0x4A4566)
    static let ink3 = Color(hex: 0x5F5983)
    /// Links, the active tab label and selected text (6.7:1 on white). Replaces the dark theme's #B9A8FF.
    static let accent = Color(hex: 0x5B3FD9)
    /// Selection rings, focus rings and violet light (#7A5BFF). Not for text.
    static let focus = Color(hex: 0x7A5BFF)
    /// Fills under white text: buttons, badges, the owner's own bubble (5.3:1 with white).
    static let accentFill = Color(hex: 0x6D4DF2)
    static let violet = Color(hex: 0x7A5BFF)
    static let orchid = Color(hex: 0xB35CFF)
    static let indigo = Color(hex: 0x3D45FF)
    static let rose = Color(hex: 0xFF6FB8)
    static let ice = Color(hex: 0xA8ECFF)
    // Member states and semantic colours, TEXT strength (web --tx-*).
    static let live = Color(hex: 0x5B3FD9)         // 일하는 중
    // 2026-11-09 clearer glass: over the stronger aurora (×1.5) through white 24% the old #A8530A / #C2372E / #8A5A00
    // fell to 3.7–4.1:1 at the violet peak, so they take the web's --warn / --danger (≥ 4.8:1 there).
    static let attention = Color(hex: 0x8F4508)    // 내 답 기다림 (web --warn)
    static let approval = Color(hex: 0xA82A22)     // 승인 창 앞 (web --danger)
    static let danger = Color(hex: 0xA82A22)       // 오류 · 실패 (text, web --danger)
    static let success = Color(hex: 0x065A3B)      // 받음 · 완료 (web --ok, ≥ 4.5:1 over the stronger aurora)
    static let warn = Color(hex: 0x7A4E00)         // 보류 (same hue, ≥ 5:1 on the clearer glass)
    static let idle = Color(hex: 0x5F5983)         // 대기
    static let dim = Color(hex: 0x5F5983)          // 잠듦 · 안 보임
    // The same states, DOT strength (web --st-*): dots, glows, meters. Never text.
    static let liveDot = Color(hex: 0x7A5BFF)
    static let attentionDot = Color(hex: 0xFF9A4D)
    static let approvalDot = Color(hex: 0xFF6B60)
    static let error = Color(hex: 0xD9363E)        // 오류 dot / danger fill under white text (4:1 with white)
    static let successDot = Color(hex: 0x20B97C)
    static let warnDot = Color(hex: 0xF5B33D)
    static let idleDot = Color(hex: 0xA6A6AE)
    static let dimDot = Color(hex: 0x8F88B2)       // hollow ring
    /// Primary button gradient (mockup .btn--p).
    static let primaryGradient = LinearGradient(colors: [Color(red: 134/255, green: 104/255, blue: 252/255).opacity(0.95), Color(red: 104/255, green: 68/255, blue: 246/255).opacity(0.95), Color(red: 92/255, green: 54/255, blue: 234/255).opacity(0.97)], startPoint: .top, endPoint: .bottom)
    /// Glass tint: white.
    static let glassTint = Color.white
    /// The light glass fill, white top → bottom (web tokens `--glass-a1` / `--glass-a2`). 2026-11-09 owner request
    /// "더 맑게": 74% → 52% became 50% → 24%; blur 24 / saturation 200% on the web.
    static let glassA1 = 0.5
    static let glassA2 = 0.24
    /// Bars and pills that must not show what passes beneath (web `--opaque-bar`: top bar, tab bar, segment pill,
    /// save bar, dialogs): white 97% → 94%.
    static let opaqueBar = 0.97
    /// Aurora strength (web `--aurora-k`, 1 → 1.5 with the clearer glass: the light behind must carry colour for a
    /// clear plate to read as glass, not as white paper) and local light strength (web `--light-k`, .55 → .75).
    static let auroraK = 1.5
    static let localLightK = 0.75 / 0.55
    /// Violet `alpha` laid on opaque white (web `linear-gradient(rgb(violet / a), …), #fff`): the opaque fill of
    /// everything pressable (options, chips, link buttons), so the light behind a plate never shows through it.
    static func violetOnWhite(_ alpha: Double) -> Color { tintOnWhite(0x7A5BFF, alpha) }
    /// Any colour `hex` at `alpha` laid on opaque white, as one opaque colour.
    static func tintOnWhite(_ hex: UInt32, _ alpha: Double) -> Color {
        func channel(_ shift: UInt32) -> Double { 1 - alpha * (1 - Double((hex >> shift) & 255) / 255) }
        return Color(.sRGB, red: channel(16), green: channel(8), blue: channel(0), opacity: 1)
    }
    /// Opaque `soft` / `soft-hover` (web `--btn-soft` / `--btn-soft-hover`).
    static let softSolid = violetOnWhite(0.07)
    static let softHoverSolid = violetOnWhite(0.12)
    /// Opaque selected / recommended option (web `--btn-sel`).
    static let selectedSolid = LinearGradient(colors: [violetOnWhite(0.16), violetOnWhite(0.10)], startPoint: .top, endPoint: .bottom)
    /// Opaque pressed option (web `--btn-press`).
    static let pressedSolid = LinearGradient(colors: [violetOnWhite(0.22), violetOnWhite(0.14)], startPoint: .top, endPoint: .bottom)
    /// Card tint: white (cards are white glass; text-heavy cards white 86%).
    static let cardTint = Color.white
    /// Soft violet surface for chips, option tiles and jump buttons (mockup --soft) and its ring (--soft-ring).
    static let soft = Color(hex: 0x7A5BFF).opacity(0.07)
    static let softRing = Color(hex: 0x7A5BFF).opacity(0.16)
    /// Selected row / recommended option (mockup --sel-bg / --sel-ring).
    static let selectedTop = Color(hex: 0x7A5BFF).opacity(0.16)
    static let selectedBottom = Color(hex: 0x7A5BFF).opacity(0.10)
    static let selectedRing = Color(hex: 0x7A5BFF).opacity(0.3)
    /// Violet-ink shadow colours of the light glass (mockup --g-shadow, --card-shadow).
    static let shadowNear = Color(red: 40/255, green: 24/255, blue: 110/255)
    static let shadowFar = Color(red: 70/255, green: 46/255, blue: 180/255)
    /// The neutral wash that replaces the dark theme's `white.opacity(a)` fills (hover, pressed, chips, tracks):
    /// ink at the same small opacity reads the same on the light background.
    static func wash(_ opacity: Double) -> Color { inkBase.opacity(opacity) }
    /// The owner's violet bubble, top to bottom (web --mine #7152F5 → #6D4DF2): white text is 4.97:1 or more on it.
    /// The mockup's #7A5BFF top left white at 4.4:1.
    static let mineHex: [UInt32] = [0x7152F5, 0x6D4DF2]
    /// Subline on the owner's violet bubble (web --mine-to #F7F5FF, 4.6:1 or more). The mockup's #E6DFFF read 3.4–4.1.
    static let onAccentSubHex: UInt32 = 0xF7F5FF
    static let onAccentSub = Color(hex: onAccentSubHex)
}

/// Semantic tone: color carries meaning, never decoration. `color` is text strength, `dot` is dot strength.
enum Tone: Sendable, Equatable {
    case neutral, accent, live, attention, approval, danger, success, dim
    var color: Color {
        switch self {
        case .neutral: CE.idle
        case .accent: CE.accent
        case .live: CE.live
        case .attention: CE.attention
        case .approval: CE.approval
        case .danger: CE.danger
        case .success: CE.success
        case .dim: CE.dim
        }
    }
    /// Bright variant for dots, glows and bars (never text).
    var dot: Color {
        switch self {
        case .neutral: CE.idleDot
        case .accent: CE.focus
        case .live: CE.liveDot
        case .attention: CE.attentionDot
        case .approval: CE.approvalDot
        case .danger: CE.error
        case .success: CE.successDot
        case .dim: CE.dimDot
        }
    }
}

extension Color {
    init(hex: UInt32) { self.init(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1) }
}

/// macOS uses fixed compact sizes for a dense desk; iOS uses Dynamic Type styles.
/// Web type scale (base 15px). macOS uses the same point sizes; iOS maps to Dynamic Type styles of the same size.
enum CEFont {
    #if os(macOS)
    static let pageTitle: Font = .system(size: 17, weight: .semibold)
    static let title: Font = .system(size: 16.5, weight: .semibold)
    static let section: Font = .system(size: 14, weight: .semibold)
    static let rowTitle: Font = .system(size: 14.5, weight: .semibold)
    static let body: Font = .system(size: 14.5)
    /// Notes, hints, errors and status lines (web 13.5px: .tm-note, .form__error, .offline-band).
    static let note: Font = .system(size: 13.5)
    /// Row sub-lines (web 13px: .hm-row__sub, .fl-row__summary).
    static let secondary: Font = .system(size: 13)
    /// Meta, times, hints (web 12.5px, the most common small size).
    static let meta: Font = .system(size: 12.5)
    /// Counts and rail sub-lines, the few places the web really uses 12px.
    static let caption: Font = .system(size: 12)
    static let micro: Font = .system(size: 11.5, weight: .bold)
    static let mono: Font = .system(size: 12.5, design: .monospaced)
    static let number: Font = .system(size: 20, weight: .semibold, design: .rounded)
    #else
    static let pageTitle: Font = .headline
    static let title: Font = .headline
    static let section: Font = .subheadline.weight(.semibold)
    static let rowTitle: Font = .subheadline.weight(.semibold)
    static let body: Font = .subheadline
    static let note: Font = .footnote
    static let secondary: Font = .footnote
    static let meta: Font = .caption
    static let caption: Font = .caption
    static let micro: Font = .caption2.weight(.bold)
    static let mono: Font = .system(.caption, design: .monospaced)
    static let number: Font = .system(.title2, design: .rounded, weight: .semibold)
    #endif

    /// Markdown headings inside reports, decisions and documents: each level clearly above the reading size.
    #if os(macOS)
    static let heading1: Font = .system(size: 16, weight: .semibold)
    static let heading2: Font = .system(size: 14.5, weight: .semibold)
    static let heading3: Font = .system(size: 13.5, weight: .semibold)
    #else
    static let heading1: Font = .title3.weight(.semibold)
    static let heading2: Font = .headline
    static let heading3: Font = .callout.weight(.semibold)
    #endif
}

/// Line height. SwiftUI's `lineSpacing` is extra space on top of the system font's own line (~1.2), so a web
/// `line-height: L` on `size`-point text becomes `size * (L - 1.2)`. Every Text that can wrap gets one of these:
/// without it multi-line text renders at ~1.2, 2.5-5pt per line tighter than the web.
enum CELeading {
    static func spacing(_ size: CGFloat, _ lineHeight: CGFloat) -> CGFloat {
        max(0, ((size * (lineHeight - 1.2)) * 2).rounded() / 2)
    }
    /// 14.5 at 1.5 (body paragraphs, row text).
    static let body = spacing(14.5, 1.5)
    /// 13.5 at 1.45 (notes, errors, hints).
    static let note = spacing(13.5, 1.45)
    /// 13 at 1.45 (row sub-lines).
    static let secondary = spacing(13, 1.45)
    /// 12.5 at 1.4 (meta lines that wrap).
    static let meta = spacing(12.5, 1.4)
    /// 16 at 1.35 (titles that wrap).
    static let title = spacing(16, 1.35)
}

extension View {
    /// The web line height `lineHeight` for `size`-point text (see `CELeading`).
    func ceLineHeight(_ size: CGFloat, _ lineHeight: CGFloat) -> some View {
        lineSpacing(CELeading.spacing(size, lineHeight))
    }
}

enum CESpace {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 28
}

enum CERadius {
    static let plate: CGFloat = 22     // web .glass--regular
    static let card: CGFloat = 18      // web inner cards (.tm-card, .ibx-card)
    static let control: CGFloat = 12   // inputs, option tiles
    static let row: CGFloat = 10       // list rows
}

#if os(macOS)
let isMac = true
#else
let isMac = false
#endif

/// Light aurora (mockup `.lt --aurora`): #FBFAFF → #F3F0FC with soft light bleeding in: violet upper right, orchid
/// in the top corner, ice at the bottom left, a faint violet at the left and a hint of rose low right. Static. Every
/// alpha below is the mockup value; `CE.auroraK` (web `--aurora-k` 1.5) scales them.
struct AmbientBackground: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    /// A radial light: colour, centre (x, y), diameter as a fraction of the longer side (w, h), and its stops as
    /// (alpha, location) pairs ending transparent.
    private struct Blob { let r, g, b: Double; let x, y, w, h: Double; let stops: [(Double, Double)] }
    private let blobs: [Blob] = [
        // radial-gradient(46% 34% at 70% 30%, violet .20, violet .08 45%, transparent 72%)
        Blob(r: 122, g: 91, b: 255, x: 0.70, y: 0.30, w: 0.92, h: 0.68, stops: [(0.20, 0), (0.08, 0.45 / 0.72), (0, 1)]),
        // radial-gradient(30% 24% at 94% 6%, orchid .16, transparent 70%)
        Blob(r: 179, g: 92, b: 255, x: 0.94, y: 0.06, w: 0.60, h: 0.48, stops: [(0.16, 0), (0.07, 0.45), (0, 1)]),
        // radial-gradient(44% 30% at 18% 98%, ice .45, transparent 70%)
        Blob(r: 168, g: 236, b: 255, x: 0.18, y: 0.98, w: 0.88, h: 0.60, stops: [(0.45, 0), (0.2, 0.45), (0, 1)]),
        // radial-gradient(28% 26% at 2% 28%, violet .10, transparent 70%)
        Blob(r: 122, g: 91, b: 255, x: 0.02, y: 0.28, w: 0.56, h: 0.52, stops: [(0.10, 0), (0.045, 0.45), (0, 1)]),
        // radial-gradient(18% 14% at 82% 86%, rose .12, transparent 70%)
        Blob(r: 255, g: 111, b: 184, x: 0.82, y: 0.86, w: 0.36, h: 0.28, stops: [(0.12, 0), (0.05, 0.45), (0, 1)]),
    ]
    var body: some View {
        GeometryReader { geo in
            let vmax = max(geo.size.width, geo.size.height)
            ZStack {
                LinearGradient(colors: [Color(hex: 0xFBFAFF), Color(hex: 0xF3F0FC)], startPoint: .top, endPoint: .bottom)
                if !reduceTransparency {
                    ForEach(blobs.indices, id: \.self) { index in
                        let blob = blobs[index]
                        let color = Color(red: blob.r / 255, green: blob.g / 255, blue: blob.b / 255)
                        Ellipse()
                            .fill(EllipticalGradient(stops: blob.stops.map { .init(color: color.opacity(min(1, $0.0 * CE.auroraK)), location: $0.1) }))
                            .frame(width: vmax * blob.w, height: vmax * blob.h)
                            .position(x: geo.size.width * blob.x, y: geo.size.height * blob.y)
                    }
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The light glass rim (web `.glass::before`): white light from the top left, violet → ice glow at the bottom right,
/// over a faint violet base ring. Same drawing as the card rim: 1.75pt, 2pt when `strong` (web `.glass--thick`).
struct GlassRim<S: InsettableShape>: View {
    let shape: S
    var strong = false
    var body: some View {
        CardRim(shape: shape, width: strong ? 2 : 1.75)
    }
}

// MARK: - Glass chrome

/// Chrome that floats over content (the settings save bar): opaque white 97% → 94% on every OS version (web
/// `--opaque-bar`), so text scrolling beneath never shows through; the glass rim, depth and shadow stay. `tint` is laid
/// under the white. Reduce Transparency: the solid plate.
private struct GlassChrome<S: InsettableShape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let shape: S
    let tint: Color?
    let interactive: Bool
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(CE.plateSolid, in: shape).overlay { shape.strokeBorder(CE.lineStrong) }
        } else {
            content
                .background { CardGlassFill(shape: shape, level: .opaque) }
                .background { if let tint { shape.fill(tint) } }
                .overlay { GlassRim(shape: shape) }
                .background { CardShadow(shape: shape) }
        }
    }
}

/// A bar pinned to the top or bottom of a scrolling area. On 26+ it is a `safeAreaBar`, so the system scroll-edge
/// effect sits under the bar and content scrolls beneath it; a plain safe-area inset otherwise. Using a plain VStack
/// row instead makes the 26 edge effect blur the first rows of the content at rest.
private struct CEBar<Bar: View>: ViewModifier {
    let edge: VerticalEdge
    let bar: Bar
    func body(content: Content) -> some View {
        if #available(macOS 26.0, iOS 26.0, *) {
            content.safeAreaBar(edge: edge, spacing: 0) { bar }
        } else {
            content.safeAreaInset(edge: edge, spacing: 0) { bar }
        }
    }
}

extension View {
    func ceBar<Bar: View>(_ edge: VerticalEdge, @ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(CEBar(edge: edge, bar: bar()))
    }

    /// Use only for controls and chrome that float above content.
    func glassChrome<S: InsettableShape>(_ shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(GlassChrome(shape: shape, tint: tint, interactive: interactive))
    }

    /// Prominent action (e.g. submit). Explicit colours on every OS version: content buttons are not chrome, and the
    /// system glass styles fade enabled buttons to look disabled whenever the Mac window is not key.
    func ceProminentButton() -> some View {
        self.buttonStyle(CEFilledButtonStyle())
    }

    /// Secondary action next to content. Same reasoning as `ceProminentButton`.
    func ceSecondaryButton() -> some View {
        self.buttonStyle(CEQuietButtonStyle())
    }

    /// Compact controls: small on Mac, regular on iPhone so touch targets stay at 44pt.
    /// (`ceProminentButton` / `ceSecondaryButton` already keep 44pt on iOS whatever control size is set.)
    @ViewBuilder func ceCompactControl() -> some View {
        #if os(macOS)
        self.controlSize(.small)
        #else
        self.controlSize(.regular)
        #endif
    }

    @ViewBuilder func ceSheetSize(width: CGFloat, height: CGFloat) -> some View {
        #if os(macOS)
        // A Mac sheet opens at its minimum width, so the intended width is the minimum.
        self.frame(minWidth: width, idealWidth: width, minHeight: min(420, height), idealHeight: height)
        #else
        self
        #endif
    }

    /// Text input surface used inside forms and composers (web --field: min-height 44, padding 10/13, 15px text,
    /// opaque white well, ink .12 ring; the focus ring is #7A5BFF). A font set on the field itself still wins.
    func ceField(focused: Bool = false) -> some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        return self.textFieldStyle(.plain)
            #if os(macOS)
            .font(.system(size: 15))
            #else
            .font(CEFont.body)
            #endif
            .padding(.horizontal, 13).padding(.vertical, 10)
            .frame(minHeight: 44)
            .foregroundStyle(CE.ink)
            .background(Color.white, in: shape)
            .overlay {
                shape.strokeBorder(focused ? CE.focus.opacity(0.85) : CE.wash(0.12), lineWidth: focused ? 1.5 : 1)
            }
    }

    /// Text-only action (취소, 더 불러오기, 다시 읽기): no fill until hovered (web .gbtn--ghost).
    func ceGhostButton() -> some View {
        self.buttonStyle(CEGhostButtonStyle())
    }
}

/// Size of the explicit button styles, the web's .gbtn sizes (every variant 600 weight): small = .gbtn--s 32 / 13.5px,
/// regular = .gbtn--m 44 / 15px, large = .gbtn--l 52 / 16px; mini is a 26pt step for the densest rows. Mac follows
/// `controlSize`; iOS keeps one readable size with a 44pt hit area. A fixed height, not vertical padding, so Korean
/// and Latin labels give the same capsule.
private struct CEButtonMetrics {
    let font: Font
    let horizontal: CGFloat
    let height: CGFloat
    init(_ size: ControlSize, prominent: Bool) {
        #if os(macOS)
        switch size {
        case .mini: font = .system(size: 12.5, weight: .semibold); horizontal = 11; height = 26
        case .small: font = .system(size: 13.5, weight: .semibold); horizontal = 14; height = 32
        case .large, .extraLarge: font = .system(size: 16, weight: .semibold); horizontal = 26; height = 52
        default: font = .system(size: 15, weight: .semibold); horizontal = 20; height = 44
        }
        #else
        font = CEFont.rowTitle.weight(.semibold)
        horizontal = 16; height = 38
        #endif
    }
}

private extension View {
    /// iPhone: at least a 44pt hit target around the visible capsule. Mac: the capsule itself.
    @ViewBuilder func ceButtonHitArea() -> some View {
        #if os(macOS)
        self.contentShape(Capsule())
        #else
        self.frame(minHeight: 44).contentShape(Rectangle())
        #endif
    }
}

/// Filled accent capsule. Disabled is drawn explicitly (hairline, dim label) instead of fading, and nothing here
/// depends on whether the window is key.
struct CEFilledButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { FilledBody(configuration: configuration) }
    private struct FilledBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false
        var body: some View {
            let metrics = CEButtonMetrics(controlSize, prominent: true)
            // mockup .btn--p: violet gradient, a lit top edge, a soft lilac glow along the bottom, a violet shadow
            // and a dark text shadow; press shrinks to .97; disabled keeps its colour at 40%. Hover darkens a touch
            // (web `.gbtn--primary:hover` brightness .94 saturate 1.04): brightening on white costs white-text contrast.
            configuration.label
                .font(metrics.font)
                .tracking(-0.15)
                .lineLimit(1)
                .padding(.horizontal, metrics.horizontal)
                .frame(minHeight: metrics.height)
                .foregroundStyle(Color.white)
                .shadow(color: Color(red: 28 / 255, green: 8 / 255, blue: 92 / 255).opacity(0.45), radius: 0.5, y: 1)
                .background {
                    Capsule().fill(CE.primaryGradient)
                        .overlay {
                            // inset 0 -8px 14px -10px rgb(222 208 255 / .7)
                            Capsule().fill(LinearGradient(colors: [.clear, Color(red: 222 / 255, green: 208 / 255, blue: 1).opacity(0.35)],
                                                          startPoint: .center, endPoint: .bottom))
                        }
                        .overlay {
                            // inset 0 1px .5px white .55: the lit top edge
                            Capsule().strokeBorder(Color.white.opacity(0.55), lineWidth: 1)
                                .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .clear, location: 0.3)],
                                                     startPoint: .top, endPoint: .bottom))
                        }
                        // 0 8px 18px -8px violet .6, 0 2px 4px -1px rgb(40 16 120 / .3)
                        .shadow(color: CE.violet.opacity(isEnabled ? 0.45 : 0), radius: 8, y: 7)
                        .shadow(color: Color(red: 40 / 255, green: 16 / 255, blue: 120 / 255).opacity(isEnabled ? 0.25 : 0), radius: 2, y: 2)
                }
                .brightness(isEnabled && hovering && !configuration.isPressed ? -0.06 : 0)
                .saturation(isEnabled && hovering && !configuration.isPressed ? 1.04 : 1)
                .opacity(isEnabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.55), value: configuration.isPressed)
                .ceButtonHitArea()
                .onHover { hovering = $0 }
        }
    }
}

/// Quiet capsule for secondary actions. Enabled: bright label on a light fill; disabled: dim label, no fill.
struct CEQuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { QuietBody(configuration: configuration) }
    private struct QuietBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false
        var body: some View {
            let metrics = CEButtonMetrics(controlSize, prominent: false)
            // web .gbtn--glass: an opaque white top-down fill (--btn2: #FFF → #FBFAFF), ink label, a soft violet ring and a
            // soft violet-ink shadow under it. Hover/press add a faint violet wash.
            configuration.label
                .font(metrics.font)
                .tracking(-0.15)
                .lineLimit(1)
                .padding(.horizontal, metrics.horizontal)
                .frame(minHeight: metrics.height)
                .foregroundStyle(isEnabled ? CE.ink : CE.ink3)
                .background {
                    if isEnabled {
                        Capsule().fill(LinearGradient(colors: [Color.white, Color(hex: 0xFBFAFF)], startPoint: .top, endPoint: .bottom))
                            .overlay { Capsule().fill(CE.violet.opacity(configuration.isPressed ? 0.09 : hovering ? 0.05 : 0)) }
                    } else {
                        Capsule().fill(Color.white.opacity(0.35))
                    }
                }
                .overlay { Capsule().strokeBorder(isEnabled ? CE.softRing : CE.line) }
                .shadow(color: CE.shadowNear.opacity(isEnabled ? 0.16 : 0), radius: 6, y: 5)
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(.spring(response: 0.3, dampingFraction: 0.55), value: configuration.isPressed)
                .ceButtonHitArea()
                .onHover { hovering = $0 }
        }
    }
}

/// Text-only action: no fill or rim until hovered (web .gbtn--ghost). Same sizes as the other buttons.
struct CEGhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { GhostBody(configuration: configuration) }
    private struct GhostBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false
        var body: some View {
            let metrics = CEButtonMetrics(controlSize, prominent: false)
            configuration.label
                .font(metrics.font)
                .tracking(-0.15)
                .lineLimit(1)
                .padding(.horizontal, metrics.horizontal)
                .frame(minHeight: metrics.height)
                .foregroundStyle(!isEnabled ? CE.ink3 : hovering ? CE.ink : CE.ink2)
                .background(CE.violet.opacity(!isEnabled ? 0 : configuration.isPressed ? 0.11 : hovering ? 0.07 : 0), in: Capsule())
                .ceButtonHitArea()
                .onHover { hovering = $0 }
        }
    }
}

/// Plain list row with hover, press and selection feedback (web `.pj` / `.hm-row` / `.fl-row`): hovering lifts the
/// row onto an opaque white plate with a violet .12 ring and a soft shadow (web `--row-hover` / `--row-lift`, 180ms);
/// the selected row is the light violet gradient, violet .16 → .10, inside a violet .3 ring, and does not lift.
/// Hover only fires with a pointer, so touch never leaves a row lifted (web `@media (hover:hover)`).
struct RowButtonStyle: ButtonStyle {
    var selected = false
    var radius: CGFloat = CERadius.control
    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, selected: selected, radius: radius)
    }
    private struct RowBody: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        let radius: CGFloat
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            configuration.label
                .contentShape(shape)
                .background {
                    if selected {
                        shape.fill(LinearGradient(colors: [CE.selectedTop, CE.selectedBottom], startPoint: .top, endPoint: .bottom))
                            .overlay { shape.strokeBorder(CE.selectedRing) }
                    } else if configuration.isPressed {
                        shape.fill(CE.violet.opacity(0.09))
                    } else {
                        RowLift(shape: shape, lifted: hovering)
                    }
                }
                .onHover { hovering = $0 }
        }
    }
}

/// The hover plate of a pressable row or small card (web `--row-hover: #fff` + `--row-lift: inset 0 0 0 1px
/// violet .12, 0 6px 14px -10px rgb(70 46 180 / .35)`), fading in over 180ms. Draw it behind the row; `lifted: false`
/// draws nothing.
struct RowLift<S: InsettableShape>: View {
    let shape: S
    let lifted: Bool
    var body: some View {
        shape.fill(Color.white)
            .overlay { shape.strokeBorder(CE.violet.opacity(0.12)) }
            .background {
                shape.inset(by: 10).fill(CE.shadowFar.opacity(0.35)).offset(y: 6).blur(radius: 7)
            }
            .opacity(lifted ? 1 : 0)
            .animation(.easeOut(duration: 0.18), value: lifted)
            .allowsHitTesting(false)
    }
}
