import SwiftUI

// Shared building blocks. Screens must compose these instead of inventing new card styles.
//
// Plate(padding:raised:) { }                    content card: dark see-through web card (cardGlass), no Liquid Glass
// .cardGlass(shape, raised:) / .glassPanel(shape) the card surface for custom shapes / for a box floating over content
// .cardPill(tint:) + TabDrop()                   the card surface for a pill of tabs/segments, and its selected drop
// SectionHeader(title:count:countTone:action:onAction:)
// Tag(_ text, tone:, icon:)                       small typed label (결재, 할 일, 승인 필요, 진행…)
// StatusDot(tone:, pulsing:, size:)               live state dot
// StatusBadge(status:)                            member CLI status dot + label (MemberStatusInfo)
// ProviderTag(cli:, model:, requested:)           "Claude · sonnet" (+ requested override in amber)
// CountBadge(count:, tone:)                       numeric capsule for nav/tabs
// MetaText(_ parts: [String?])                    "a · b · c" in meta style, empty parts dropped
// InlineNotice(tone:, icon:, title:, detail:, actionTitle:, action:)
// CompactEmpty(icon:, title:, detail:)
// CESheet(title, subtitle:, icon:, width:) { body } footer: { buttons }   every popup (no NavigationStack/toolbar)
// CECloseButton { }                               round quiet ×, Esc
// Avatar(name:, cli:, size:)                      neutral session glyph (no person initials)
// ContextMeter(pct:)                              tiny bar + "문맥 n%"
// MarkdownText(text:size:)                        the web board's markdown: tables, quotes, lists, code
// relativeTime(_ iso:) / clockTime(_ iso:)        "방금", "3분 전", "14:20", "어제 14:20", "11월 4일"

private struct InsideGlassKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// True inside a glass panel: nested panels become quiet fills (glass on glass is never used).
    var ceInsideGlass: Bool {
        get { self[InsideGlassKey.self] }
        set { self[InsideGlassKey.self] = newValue }
    }
}

/// A content card in the light glass style (web `.glass` + `.glass-tint`, the web's content cards): clear white glass
/// (white 50% → 24% plus the text-heavy +16%) over the light aurora, radius 22, a 1.75pt rim lit white at the top left
/// and bending violet/ice at the bottom right, corner glints, an edge bevel and a soft violet shadow. Cards nested inside
/// a card become quiet fills.
struct Plate<Content: View>: View {
    @Environment(\.ceInsideGlass) private var insideGlass
    var padding: CGFloat = CESpace.l
    var raised = false
    /// Top-level corner radius (22, the web .glass--regular; 18 for the web's inner cards).
    var radius: CGFloat = CERadius.plate
    @ViewBuilder var content: Content
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: insideGlass ? 14 : radius, style: .continuous)
        let inner = content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.ceInsideGlass, true)
        if insideGlass {
            inner
                .background(raised ? CE.violet.opacity(0.1) : Color.white.opacity(0.55), in: shape)
                .overlay { shape.strokeBorder(raised ? CE.selectedRing : CE.line) }
        } else {
            // Same surface on every OS version: no Liquid Glass and no material under a card (see `cardGlass`);
            // Reduce Transparency gets the solid plate there.
            inner.cardGlass(shape, raised: raised)
        }
    }
}

extension View {
    /// The one content column every screen uses (web .page: 880 wide including its 24pt gutters, so cards line up
    /// with the docked composer and do not jump when switching tabs).
    func ceContentColumn(top: CGFloat = 12) -> some View {
        self.padding(.horizontal, isMac ? 24 : 16)
            .padding(.top, top)
            .padding(.bottom, isMac ? 44 : 28)
            .frame(maxWidth: 880)
            .frame(maxWidth: .infinity)
    }
}

// MARK: - Card glass (web `.glass` in the 2026-11-09 clearer glass, A안: thick edges, opaque on hover)

/// How much white a glass surface carries (web `--g-a1` / `--g-a2` plus its `--g-tint`, composited).
enum GlassLevel: Sendable, Equatable {
    /// `.glass` alone: white 50% → 24%.
    case clear
    /// `.glass-tint` (+16%, `--tint-text`): text-heavy content cards (home, inbox, files, team, settings panels).
    case text
    /// `--tint-strong` (+42%): approval originals, the reader, long documents.
    case strong
    /// `.glass--thick` (+8%) with `--tint-text`: the large setup card.
    case thick
    /// `--opaque-bar`: tab bar, segment pill, save bar, dialogs (97% → 94%).
    case opaque
    /// The composer panel: opaque (100% → 98%).
    case solid

    /// Top and bottom white alpha (top at 0, bottom from 62% down).
    var alphas: (top: Double, bottom: Double) {
        func over(_ a: Double, tint t: Double) -> Double { 1 - (1 - a) * (1 - t) }
        switch self {
        case .clear: return (CE.glassA1, CE.glassA2)
        case .text: return (over(CE.glassA1, tint: 0.16), over(CE.glassA2, tint: 0.16))
        case .strong: return (over(CE.glassA1, tint: 0.42), over(CE.glassA2, tint: 0.42))
        case .thick: return (over(CE.glassA1 + 0.08, tint: 0.16), over(CE.glassA2 + 0.08, tint: 0.16))
        case .opaque: return (CE.opaqueBar, CE.opaqueBar - 0.03)
        case .solid: return (1, 0.98)
        }
    }
    /// Corner glints sit on see-through plates only (web `--g-glint: 0` on the opaque bars and the tab drop).
    var glints: Bool {
        switch self {
        case .opaque, .solid: false
        default: true
        }
    }
}

extension View {
    /// The light card surface for a box of content: clear white glass (`level`, the text-heavy tint by default), the
    /// corner glints and edge bevel of `--g-depth`, the 1.75pt rim and a soft violet shadow outside the card only.
    /// `lifted` (hover on a pressable card, web `.tm-card:hover`) fades the plate to opaque white 97% → 94% over 220ms.
    /// No Liquid Glass and no material: the static aurora behind a card needs no blur. Reduce Transparency: the solid
    /// plate.
    func cardGlass<S: InsettableShape>(_ shape: S, raised: Bool = false, level: GlassLevel = .text, lifted: Bool = false) -> some View {
        modifier(CardGlass(shape: shape, raised: raised, level: level, lifted: lifted))
    }

    /// The surface for a box that floats over scrolling content (the composer, web `.cmp__panel`): opaque white
    /// (100% → 98%) so what passes beneath never shows through; the glass rim, bevel and shadow stay.
    func glassPanel<S: InsettableShape>(_ shape: S) -> some View {
        modifier(GlassPanel(shape: shape))
    }

    /// The surface in a capsule, for a pill of controls (the Mac destination tabs, the inbox segment pill, web `.gtabs`
    /// / `.ibx-seg`): opaque white 97% → 94% (they are the way around the app), the thin glass bevel and the rim. No card
    /// shadow under a pill. Put `TabDrop` behind the selected item. Reduce Transparency: the solid plate. `tint` is kept
    /// for callers; the light glass ignores it.
    func cardPill(tint: Double = 0.55) -> some View {
        modifier(CardPill(tint: tint))
    }
}

private struct CardPill: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let tint: Double
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(CE.plateSolid, in: Capsule()).overlay { Capsule().strokeBorder(CE.lineStrong) }
        } else {
            content
                .background { CardGlassFill(shape: Capsule(), level: .opaque, depth: .thin) }
                .overlay { CardRim(shape: Capsule()) }
        }
    }
}

/// Web `.gtabs__drop`: the selected tab of a `cardPill`. A white drop (white → white .86) over a violet .07 tint, with a
/// violet glow under it (`0 6px 16px -6px violet .55`) and a violet .22 ring; the label on it is `CE.accent`. The glow
/// is cut out of the drop, so it lights the pill around it. Draw it behind the label; with `matchedGeometryEffect` it
/// slides.
struct TabDrop: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        let shape = Capsule()
        Group {
            if reduceTransparency {
                shape.fill(Color.white).overlay { shape.strokeBorder(CE.selectedRing) }
            } else {
                shape.fill(LinearGradient(colors: [Color.white, Color.white.opacity(0.86)], startPoint: .top, endPoint: .bottom))
                    .background { shape.fill(CE.violet.opacity(0.07)) }
                    .overlay { shape.strokeBorder(CE.violet.opacity(0.22)) }
                    .background {
                        shape.inset(by: 6).fill(CE.violet.opacity(0.55)).offset(y: 6).blur(radius: 8)
                            .overlay { shape.fill(Color.black).blendMode(.destinationOut) }
                            .compositingGroup()
                    }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct CardGlass<S: InsettableShape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let shape: S
    let raised: Bool
    let level: GlassLevel
    let lifted: Bool
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(raised ? CE.plateRaisedSolid : CE.plateSolid, in: shape).overlay { shape.strokeBorder(CE.lineStrong) }
        } else {
            content
                .background { CardGlassFill(shape: shape, raised: raised, level: level, lifted: lifted) }
                .overlay { CardRim(shape: shape) }
                .background { CardShadow(shape: shape, raised: raised) }
        }
    }
}

private struct GlassPanel<S: InsettableShape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let shape: S
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(CE.plateSolid, in: shape).overlay { shape.strokeBorder(CE.lineStrong) }
        } else {
            content
                .background { CardGlassFill(shape: shape, level: .solid) }
                .overlay { CardRim(shape: shape) }
                .background { CardShadow(shape: shape) }
        }
    }
}

/// One CSS inset box-shadow (`inset x y blur spread color`) inside `shape`: the shape's inverse, moved by (x, y) and
/// shrunk by `spread`, blurred (CSS blur radius = 2σ) and clipped to the shape. Blur 0 gives the crisp 1px edges.
struct InsetShadow<S: InsettableShape>: View {
    let shape: S
    let color: Color
    var x: CGFloat = 0
    var y: CGFloat = 0
    var blur: CGFloat = 0
    var spread: CGFloat = 0
    var body: some View {
        let sigma = blur / 2
        // A band from the hole's edge outwards, wide enough that its far edge never reaches the shape after the move
        // and the blur.
        let band = 3 * sigma + max(abs(x), abs(y)) + max(spread, 0) + 4
        shape.inset(by: spread - band / 2)
            .stroke(color, lineWidth: band)
            .offset(x: x, y: y)
            .blur(radius: sigma)
            .clipShape(shape)
            .allowsHitTesting(false)
    }
}

/// Inside of a glass surface (web `.glass` background + `--g-depth`). From the bottom: `raised` violet wash, the white
/// fill (`level`, top → bottom at 62%), `lifted` opaque white (hover), the corner glints (white at the top left, ice →
/// violet at the bottom right, fixed 180×120 / 170×110 ellipses like the web), then the depth: crisp 1px edges (white
/// top/left, violet bottom, ice right), a 3px bevel at top and bottom, a white .34 ring, white light bleeding in from
/// every edge (thickness) and a violet shade rising from the bottom.
struct CardGlassFill<S: InsettableShape>: View {
    enum Depth: Sendable { case regular, thick, thin }
    let shape: S
    var raised = false
    /// Kept for callers: ≥ 0.66 means a dense panel (`.strong`); nil = the `level` given.
    var tint: Double? = nil
    var level: GlassLevel = .text
    var depth: Depth = .regular
    var lifted = false
    private var effectiveLevel: GlassLevel {
        if let tint, tint >= 0.66 { return .strong }
        return level
    }
    var body: some View {
        let alphas = effectiveLevel.alphas
        ZStack {
            if raised { shape.fill(CE.violet.opacity(0.08)) }
            shape.fill(LinearGradient(stops: [.init(color: .white.opacity(alphas.top), location: 0),
                                              .init(color: .white.opacity(alphas.bottom), location: 0.62)],
                                      startPoint: .top, endPoint: .bottom))
            // web `.tm-card:hover { --g-a1:.97; --g-a2:.94 }`, eased like the registered-property transition
            shape.fill(LinearGradient(stops: [.init(color: .white.opacity(0.97), location: 0), .init(color: .white.opacity(0.94), location: 0.62)],
                                      startPoint: .top, endPoint: .bottom))
                .opacity(lifted ? 1 : 0)
                .animation(.easeOut(duration: 0.22), value: lifted)
            if effectiveLevel.glints { CornerGlints(shape: shape) }
            depthLayers
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder private var depthLayers: some View {
        switch depth {
        case .regular:
            InsetShadow(shape: shape, color: .white, y: 1)
            InsetShadow(shape: shape, color: .white.opacity(0.85), x: 1)
            InsetShadow(shape: shape, color: CE.violet.opacity(0.28), y: -1)
            InsetShadow(shape: shape, color: CE.ice.opacity(0.6), x: -1)
            InsetShadow(shape: shape, color: .white, y: 3, blur: 5, spread: -3)
            InsetShadow(shape: shape, color: CE.violet.opacity(0.22), y: -3, blur: 6, spread: -4)
            shape.strokeBorder(Color.white.opacity(0.34), lineWidth: 1)
            InsetShadow(shape: shape, color: .white.opacity(0.95), blur: 22, spread: -6)
            InsetShadow(shape: shape, color: CE.violet.opacity(0.3), y: -16, blur: 28, spread: -18)
        case .thick:
            InsetShadow(shape: shape, color: .white, y: 1)
            InsetShadow(shape: shape, color: .white.opacity(0.75), x: 1)
            InsetShadow(shape: shape, color: CE.violet.opacity(0.22), y: -1)
            InsetShadow(shape: shape, color: CE.ice.opacity(0.5), x: -1)
            shape.strokeBorder(Color.white.opacity(0.35), lineWidth: 1)
            InsetShadow(shape: shape, color: .white.opacity(0.9), blur: 24, spread: -8)
            InsetShadow(shape: shape, color: CE.violet.opacity(0.26), y: -18, blur: 30, spread: -20)
        case .thin:
            InsetShadow(shape: shape, color: .white, y: 1)
            shape.strokeBorder(Color.white.opacity(0.5), lineWidth: 1)
            InsetShadow(shape: shape, color: CE.violet.opacity(0.12), y: -6, blur: 12, spread: -10)
        }
    }
}

/// The glints of a see-through plate, under its content (web `.glass` background layers, `--g-glint`): white .78 from
/// the top left corner and ice .3 → violet .06 into the bottom right corner, fixed-size ellipses clipped to the plate.
private struct CornerGlints<S: InsettableShape>: View {
    let shape: S
    var body: some View {
        ZStack {
            // radial-gradient(180px 120px at 0% 0%, white .78, white 0 70%)
            Ellipse()
                .fill(EllipticalGradient(stops: [.init(color: .white.opacity(0.78), location: 0), .init(color: .white.opacity(0), location: 0.7)]))
                .frame(width: 360, height: 240)
                .position(x: 0, y: 0)
            // radial-gradient(170px 110px at 100% 100%, ice .3, violet .06 45%, ice 0 72%)
            GeometryReader { geo in
                Ellipse()
                    .fill(EllipticalGradient(stops: [.init(color: CE.ice.opacity(0.3), location: 0),
                                                     .init(color: CE.violet.opacity(0.06), location: 0.45),
                                                     .init(color: CE.ice.opacity(0), location: 0.72)]))
                    .frame(width: 340, height: 220)
                    .position(x: geo.size.width, y: geo.size.height)
            }
        }
        .clipShape(shape)
        .allowsHitTesting(false)
    }
}

/// Web `.glass::before`, the refracting rim: 1.75pt (2pt on thick plates), white light pooling at the top left (white
/// 1 → .9 → 0 from the corner, and white 1 → .65 → 0 along the top at 34%), violet .72 → ice .62 bending into the bottom
/// right, a little ice at the bottom left, over a violet .2 base ring. `EllipticalGradient` radii are fractions of the
/// size, so each end radius is the CSS radius × its last stop (e.g. 62% × 74% ≈ .47) and the stops are rescaled to it.
struct CardRim<S: InsettableShape>: View {
    let shape: S
    var width: CGFloat = 1.75
    var body: some View {
        ZStack {
            shape.strokeBorder(CE.violet.opacity(0.2), lineWidth: width)
            // radial-gradient(40% 50% at 0% 100%, ice .45, white 0 72%)
            shape.strokeBorder(EllipticalGradient(stops: [
                .init(color: CE.ice.opacity(0.45), location: 0),
                .init(color: CE.ice.opacity(0), location: 1),
            ], center: .bottomLeading, startRadiusFraction: 0, endRadiusFraction: 0.32), lineWidth: width)
            // radial-gradient(62% 64% at 100% 100%, violet .72, ice .62 42%, white 0 74%)
            shape.strokeBorder(EllipticalGradient(stops: [
                .init(color: CE.violet.opacity(0.72), location: 0),
                .init(color: CE.ice.opacity(0.62), location: 0.42 / 0.74),
                .init(color: CE.ice.opacity(0), location: 1),
            ], center: .bottomTrailing, startRadiusFraction: 0, endRadiusFraction: 0.47), lineWidth: width)
            // radial-gradient(62% 58% at 34% 0%, white 1, white .65 34%, white 0 68%)
            shape.strokeBorder(EllipticalGradient(stops: [
                .init(color: .white, location: 0),
                .init(color: .white.opacity(0.65), location: 0.5),
                .init(color: .white.opacity(0), location: 1),
            ], center: UnitPoint(x: 0.34, y: 0), startRadiusFraction: 0, endRadiusFraction: 0.41), lineWidth: width)
            // radial-gradient(52% 64% at 0% 0%, white 1, white .9 42%, white 0 78%)
            shape.strokeBorder(EllipticalGradient(stops: [
                .init(color: .white, location: 0),
                .init(color: .white.opacity(0.9), location: 0.42 / 0.78),
                .init(color: .white.opacity(0), location: 1),
            ], center: .topLeading, startRadiusFraction: 0, endRadiusFraction: 0.45), lineWidth: width)
        }
        .allowsHitTesting(false)
    }
}

/// Web `--g-shadow`: `0 1px 2px rgb(40 24 110 / .06), 0 18px 44px -22px rgb(70 46 180 / .32)`. Drawn from a caster
/// inset by the (negative) spread and cut out of the card's own area, so it never tints the see-through inside.
struct CardShadow<S: InsettableShape>: View {
    let shape: S
    var raised = false
    var body: some View {
        ZStack {
            shape.fill(CE.shadowNear.opacity(0.06)).offset(y: 1).blur(radius: 1)
            shape.inset(by: 22).fill(CE.shadowFar.opacity(raised ? 0.38 : 0.32)).offset(y: 18).blur(radius: 22)
        }
        .overlay { shape.fill(Color.black).blendMode(.destinationOut) }
        .compositingGroup()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct SectionHeader: View {
    let title: String
    var count: Int? = nil
    var countTone: Tone = .neutral
    var action: String? = nil
    var onAction: (() -> Void)? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).font(CEFont.section).foregroundStyle(CE.ink2)
            if let count {
                Text("\(count)").font(CEFont.micro).monospacedDigit()
                    .foregroundStyle(count > 0 && countTone != .neutral ? countTone.color : CE.ink3)
            }
            Spacer(minLength: 8)
            if let action, let onAction {
                Button(action: onAction) {
                    HStack(spacing: 3) { Text(action); Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)) }
                        .frame(minHeight: isMac ? nil : 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).font(CEFont.meta).foregroundStyle(CE.accent)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Web badge (.badge: 20 tall, 12px/650, padding 0 7): a small tinted capsule (완료 = ok, 질문 = accent,
/// 막힘 = danger, others neutral).
struct Tag: View {
    let text: String
    var tone: Tone = .neutral
    var icon: String? = nil
    init(_ text: String, tone: Tone = .neutral, icon: String? = nil) { self.text = text; self.tone = tone; self.icon = icon }
    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 9.5, weight: .bold)) }
            Text(text).lineLimit(1)
        }
        #if os(macOS)
        .font(.system(size: 12, weight: .semibold))
        #else
        .font(CEFont.caption.weight(.semibold))
        #endif
        .foregroundStyle(tone == .neutral ? CE.ink2 : tone.color)
        .padding(.horizontal, 7)
        .frame(minWidth: 20, minHeight: 20)
        .background(tone == .neutral ? CE.wash(0.06) : tone.dot.opacity(0.13), in: Capsule())
        .fixedSize()
    }
}

/// Web status dot: working pulses, waiting/blocked glow, asleep/offline are hollow rings.
struct StatusDot: View {
    var tone: Tone
    var pulsing = false
    var size: CGFloat = 8
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    var body: some View {
        Group {
            if tone == .dim {
                Circle().strokeBorder(tone.dot, lineWidth: 1.4).frame(width: size, height: size)
            } else {
                Circle().fill(tone.dot).frame(width: size, height: size)
                    .shadow(color: [.attention, .approval, .live].contains(tone) ? tone.dot.opacity(0.7) : .clear, radius: 4)
            }
        }
        .background {
            if pulsing && !reduceMotion {
                Circle().fill(tone.dot.opacity(0.45)).frame(width: size, height: size)
                    .scaleEffect(expanded ? 2.4 : 1).opacity(expanded ? 0 : 0.9)
                    .animation(.easeOut(duration: 1.8).repeatForever(autoreverses: false), value: expanded)
            }
        }
        .onAppear { if pulsing { expanded = true } }
        .accessibilityHidden(true)
    }
}

/// Web status pill: tinted capsule with dot and label in the status colour.
struct StatusBadge: View {
    let status: String
    var compact = false
    var body: some View {
        let info = MemberStatusInfo(status)
        Group {
            if compact {
                StatusDot(tone: info.tone, pulsing: info.live)
            } else {
                // web .tm-status: 24 tall, padding 0 9 0 8, 12.5px/600, a background per state.
                HStack(spacing: 6) {
                    StatusDot(tone: info.tone, pulsing: info.live, size: 8)
                    Text(info.label).font(CEFont.meta.weight(.semibold)).foregroundStyle(info.tone == .neutral || info.tone == .dim ? CE.ink2 : info.tone.color)
                }
                .padding(.leading, 8).padding(.trailing, 9).frame(minHeight: 24)
                .background(Self.fill(info.tone), in: Capsule())
            }
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("CLI 상태 \(info.label)")
    }

    private static func fill(_ tone: Tone) -> Color {
        switch tone {
        // mockup .st--*: the dot colour at 13%
        case .live, .accent: CE.violet.opacity(0.13)
        case .attention: CE.attentionDot.opacity(0.13)
        case .approval: CE.approvalDot.opacity(0.13)
        case .danger: CE.error.opacity(0.12)
        case .success: CE.successDot.opacity(0.13)
        case .neutral: Color(red: 140 / 255, green: 140 / 255, blue: 160 / 255).opacity(0.13)
        case .dim: Color.clear
        }
    }
}

/// Quiet provider/model text; shown in details, not in every row.
struct ProviderTag: View {
    let cli: String
    var model: String? = nil
    var requested: String? = nil
    var body: some View {
        HStack(spacing: 4) {
            Text(providerName(cli)).foregroundStyle(CE.ink2)
            if let model, !model.isEmpty { Text(model).foregroundStyle(CE.ink3) }
            if let requested, !requested.isEmpty, requested != model { Text("→ \(requested)").foregroundStyle(CE.attention) }
        }
        .font(CEFont.micro)
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

/// Web count bubble: violet fill with white digits (danger fill when something is blocked).
struct CountBadge: View {
    let count: Int
    var tone: Tone = .accent
    var body: some View {
        if count > 0 {
            Text("\(count)").font(CEFont.caption.weight(.semibold)).monospacedDigit()
                .foregroundStyle(tone == .neutral ? CE.ink : .white)
                .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 20)
                .background(tone == .neutral ? CE.wash(0.08) : (tone == .danger || tone == .approval ? CE.error : CE.accentFill), in: Capsule())
                .fixedSize()
        }
    }
}

struct MetaText: View {
    let parts: [String?]
    init(_ parts: [String?]) { self.parts = parts }
    var body: some View {
        Text(parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
            .font(CEFont.meta).foregroundStyle(CE.ink2).lineLimit(1)
    }
}

struct InlineNotice: View {
    var tone: Tone = .attention
    var icon: String = "exclamationmark.circle"
    let title: String
    var detail: String? = nil
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var actionDisabled = false
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).font(CEFont.rowTitle).foregroundStyle(tone.color).padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineSpacing(CELeading.title)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail, !detail.isEmpty {
                    Text(detail).font(CEFont.note).foregroundStyle(CE.ink2).lineSpacing(CELeading.note)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 6)
            if let actionTitle, let action { Button(actionTitle, action: action).ceSecondaryButton().controlSize(.small).disabled(actionDisabled) }
        }
        .padding(.vertical, 12).padding(.leading, 14).padding(.trailing, actionTitle != nil ? 10 : 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.dot.opacity(0.1), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(tone.dot.opacity(0.3)) }
    }
}

// MARK: - Brand

/// The app icon as a small tile next to the IAMCEO wordmark (sidebar, connection screen). `BrandMark` is an image set
/// made from the app icon; app icon sets themselves cannot be loaded by name on iOS.
struct BrandMark: View {
    var size: CGFloat = 22
    var body: some View {
        let tile = RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
        Image("BrandMark")
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .clipShape(tile)
            .overlay { tile.strokeBorder(Color.white.opacity(0.5), lineWidth: 0.5) }
            .shadow(color: CE.violet.opacity(0.3), radius: 4, y: 1)
            .accessibilityHidden(true)
    }
}

// MARK: - Sheet (popup) frame

/// The one quiet round close button (×) of drawers and sheets: 26pt faint ink-tint circle, no focus ring, Esc closes.
/// iPhone keeps a 44pt hit target around the visible circle.
struct CECloseButton: View {
    var label = "닫기"
    var escapeCloses = true
    /// The tooltip; nil = the label with its shortcut.
    var help: String? = nil
    let action: () -> Void
    var body: some View {
        let button = Button(action: action) { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)) }
            .buttonStyle(CECloseButtonStyle())
            .focusEffectDisabled()
            #if os(macOS)
            .help(help ?? (escapeCloses ? "\(label) (esc)" : "\(label) (⌘W)"))
            #else
            .help(help ?? (escapeCloses ? "\(label) (esc)" : label))
            #endif
            .accessibilityLabel(label)
        if escapeCloses { button.keyboardShortcut(.cancelAction) } else { button }
    }
}

private struct CECloseButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { CloseBody(configuration: configuration) }
    private struct CloseBody: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false
        var body: some View {
            configuration.label
                .foregroundStyle(hovering ? CE.ink : CE.ink2)
                .frame(width: 26, height: 26)
                .background(CE.wash(configuration.isPressed ? 0.12 : hovering ? 0.08 : 0.05), in: Circle())
                .overlay { Circle().strokeBorder(CE.line) }
                .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

/// Surface of every popup: the light background, a little whiter at the top, one faint violet light at the top left.
/// No aurora blobs (they read as stains in a small window) and no material.
struct CESheetBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0xFDFCFF), CE.bg], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [CE.violet.opacity(0.08), .clear], center: UnitPoint(x: 0.12, y: 0), startRadius: 0, endRadius: 380)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Every popup (sheet) uses this frame instead of NavigationStack + a system toolbar.
/// - Header: optional icon tile, title, optional one-line subtitle, `CECloseButton` (Esc).
/// - Body: on Mac the sheet's height follows the content and scrolls only past `maxBodyHeight`; `scrolls: false`
///   hands the body the space as is (a terminal, a reader) and the caller sizes it.
/// - Footer (optional): right-aligned buttons on a slightly tinted band. `ceSecondaryButton` for 닫기/취소/다시 확인,
///   one `ceProminentButton` (with `.keyboardShortcut(.defaultAction)`) for the main action. Never system-tinted buttons.
/// iPhone: the same body and footer in a NavigationStack with an inline title and a trailing close button.
struct CESheet<Content: View, Footer: View>: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    var subtitle: String?
    var icon: String?
    var width: CGFloat
    var maxBodyHeight: CGFloat
    var scrolls: Bool
    var flexibleWidth: Bool
    var escapeCloses: Bool
    var onClose: (() -> Void)?
    private let content: Content
    private let footer: Footer
    @State private var bodyHeight: CGFloat = 0

    init(_ title: String, subtitle: String? = nil, icon: String? = nil, width: CGFloat = 520, maxBodyHeight: CGFloat = 620,
         scrolls: Bool = true, flexibleWidth: Bool = false, escapeCloses: Bool = true, onClose: (() -> Void)? = nil,
         @ViewBuilder content: () -> Content, @ViewBuilder footer: () -> Footer) {
        self.title = title; self.subtitle = subtitle; self.icon = icon; self.width = width
        self.maxBodyHeight = maxBodyHeight; self.scrolls = scrolls; self.flexibleWidth = flexibleWidth; self.escapeCloses = escapeCloses; self.onClose = onClose
        self.content = content(); self.footer = footer()
    }

    private var hasFooter: Bool { Footer.self != EmptyView.self }
    private func close() { if let onClose { onClose() } else { dismiss() } }

    var body: some View {
        #if os(macOS)
        VStack(spacing: 0) {
            header
                .padding(.leading, 22).padding(.trailing, 16)
                .padding(.top, 18).padding(.bottom, 14)
            if scrolls {
                ScrollView {
                    content
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 22)
                        .padding(.top, 2)
                        .padding(.bottom, hasFooter ? 16 : 22)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { bodyHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollIndicators(.automatic)
                .frame(height: bodyHeight > 0 ? min(bodyHeight, maxBodyHeight) : nil)
            } else {
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(.horizontal, 22)
                    .padding(.bottom, hasFooter ? 16 : 22)
            }
            if hasFooter { footerBar }
        }
        .frame(width: flexibleWidth ? nil : width)
        .frame(maxWidth: flexibleWidth ? .infinity : nil)
        .foregroundStyle(CE.ink)
        .background { CESheetBackground() }
        #else
        NavigationStack {
            Group {
                if scrolls {
                    ScrollView {
                        VStack(alignment: .leading, spacing: CESpace.m) {
                            if let subtitle { Text(subtitle).font(CEFont.secondary).foregroundStyle(CE.ink2) }
                            content
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                } else {
                    content.padding(.horizontal, 16).padding(.top, 8)
                }
            }
            .foregroundStyle(CE.ink)
            .background { CESheetBackground() }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { close() } label: { Image(systemName: "xmark") }.accessibilityLabel("닫기")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { if hasFooter { footerBar } }
        }
        #endif
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            if let icon {
                let tile = RoundedRectangle(cornerRadius: 9, style: .continuous)
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(CE.accent)
                    .frame(width: 32, height: 32)
                    .background(CE.violet.opacity(0.16), in: tile)
                    .overlay { tile.strokeBorder(CE.violet.opacity(0.3)) }
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(CEFont.title).foregroundStyle(CE.ink).lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle {
                    Text(subtitle).font(CEFont.meta).foregroundStyle(CE.ink2).lineSpacing(CELeading.meta).lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 12)
            CECloseButton(escapeCloses: escapeCloses) { close() }
        }
    }

    private var footerBar: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            footer
        }
        .padding(.horizontal, isMac ? 22 : 16)
        .padding(.vertical, isMac ? 14 : 10)
        .background(CE.violet.opacity(0.035))
        .overlay(alignment: .top) { Rectangle().fill(CE.line).frame(height: 1) }
    }
}

extension CESheet where Footer == EmptyView {
    init(_ title: String, subtitle: String? = nil, icon: String? = nil, width: CGFloat = 520, maxBodyHeight: CGFloat = 620,
         scrolls: Bool = true, escapeCloses: Bool = true, onClose: (() -> Void)? = nil, @ViewBuilder content: () -> Content) {
        self.init(title, subtitle: subtitle, icon: icon, width: width, maxBodyHeight: maxBodyHeight, scrolls: scrolls, escapeCloses: escapeCloses,
                  onClose: onClose, content: content, footer: { EmptyView() })
    }
}

struct CompactEmpty: View {
    let icon: String
    let title: String
    var detail: String? = nil
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).font(CEFont.rowTitle).foregroundStyle(CE.ink3).frame(width: 18)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                if let detail {
                    Text(detail).font(CEFont.secondary).foregroundStyle(CE.ink2).lineSpacing(CELeading.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, CESpace.s)
    }
}

/// Session mark. Sessions are named by their work, never given a person's initial, so this is a neutral terminal glyph.
struct Avatar: View {
    let name: String
    var cli = "claude"
    var size: CGFloat = 28
    var body: some View {
        Image(systemName: "terminal")
            .font(.system(size: size * 0.42, weight: .medium))
            .foregroundStyle(CE.ink2)
            .frame(width: size, height: size)
            .background(CE.soft, in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct ContextMeter: View {
    let pct: Double
    var body: some View {
        let value = min(max(pct, 0), 100)
        HStack(spacing: 5) {
            Capsule().fill(CE.wash(0.1)).frame(width: 34, height: 4)
                .overlay(alignment: .leading) { Capsule().fill(value >= 80 ? CE.attentionDot : CE.ink3).frame(width: 34 * value / 100, height: 4) }
            Text("문맥 \(Int(value))%").font(CEFont.meta).foregroundStyle(CE.ink3).monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("문맥 사용 \(Int(value))퍼센트")
    }
}

/// Markdown as the old web board drew it (GitHub style), with its typography: body text at `size` (15 by default)
/// with a 1.65 line height, 0.7em between blocks, headings at 1.3 / 1.18 / 1.06em with room above them. Blocks:
/// headings, paragraphs, nested and numbered lists with task boxes, block quotes, rules, fenced code, and pipe tables
/// drawn as a real grid. Inline: bold, italic, `code` (a faint chip), links and ~~strikethrough~~; a single `~` stays a
/// tilde ("0.0~3.9" is a range, never a strike). Sizes follow Dynamic Type on iPhone.
extension EnvironmentValues {
    /// Markdown drawn on the violet "mine" bubble (mockup .th-mine): white text, dark code chips and boxes, a white
    /// quote bar, lilac quote text and list markers, since the page's dark ink would vanish on violet.
    @Entry var markdownOnAccent = false
}

struct MarkdownText: View {
    @Environment(\.markdownOnAccent) private var onAccent
    let text: String
    /// When the body opens with `# <this title>` (documents repeat their own title), that heading is not drawn again.
    var omitTitle: String?
    @ScaledMetric private var size: CGFloat

    /// The web line height (1.65 for documents and chat; inbox and home details use 1.6 / 1.55).
    private let lineHeight: CGFloat

    init(text: String, size: CGFloat = 15, lineHeight: CGFloat = 1.65, omitTitle: String? = nil) {
        self.text = text
        self.omitTitle = omitTitle
        self.lineHeight = lineHeight
        _size = ScaledMetric(wrappedValue: size, relativeTo: .subheadline)
    }

    /// Extra space between two lines of one paragraph: the web line height over the system font's own ~1.2.
    private var leading: CGFloat { CELeading.spacing(size, lineHeight) }
    /// Text colours: the page inks, or white / lilac on the violet bubble.
    private var ink: Color { onAccent ? .white : CE.ink }
    private var ink2: Color { onAccent ? CE.onAccentSub : CE.ink2 }
    private var ink3: Color { onAccent ? CE.onAccentSub : CE.ink3 }

    var body: some View {
        VStack(alignment: .leading, spacing: (size * 0.7).rounded()) {
            ForEach(Array(visibleBlocks.enumerated()), id: \.offset) { index, block in
                switch block {
                case .heading(let level, let value):
                    Text(inline(value))
                        .font(.system(size: headingSize(level), weight: .semibold))
                        .tracking(-0.15)
                        .lineSpacing((size * 0.2).rounded())
                        .foregroundStyle(level >= 4 ? ink2 : ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, index == 0 ? 0 : (size * (level <= 2 ? 0.55 : 0.4)).rounded())
                        .accessibilityAddTraits(.isHeader)
                case .code(let value):
                    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(value).font(.system(size: (size * 0.87).rounded(), design: .monospaced))
                            .lineSpacing((size * 0.3).rounded())
                            .foregroundStyle(onAccent ? Color.white : CE.ink)
                            .padding(.horizontal, 14).padding(.vertical, 12)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(onAccent ? Color(red: 28 / 255, green: 12 / 255, blue: 96 / 255).opacity(0.4)
                                         : CE.violet.opacity(0.05), in: shape)
                    .overlay { shape.strokeBorder(onAccent ? Color.white.opacity(0.18) : CE.line) }
                case .list(let items):
                    VStack(alignment: .leading, spacing: (size * 0.25).rounded()) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in listRow(item) }
                    }
                case .quote(let value):
                    HStack(alignment: .top, spacing: 12) {
                        RoundedRectangle(cornerRadius: 1).fill(onAccent ? Color.white.opacity(0.5) : CE.accent.opacity(0.7)).frame(width: 2)
                        MarkdownText(text: value, size: size, lineHeight: lineHeight)
                            .foregroundStyle(ink2)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                case .rule:
                    Rectangle().fill(onAccent ? Color.white.opacity(0.3) : CE.line).frame(height: 1).padding(.vertical, (size * 0.2).rounded())
                case .table(let table):
                    MarkdownTableView(table: table, size: (size * 0.93).rounded())
                case .paragraph(let value):
                    Text(inline(value)).font(.system(size: size)).lineSpacing(leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(LocalFilePresentation())
    }

    /// One item: the marker in a gutter (1.35em, like the web list padding), the text wrapping beside it.
    @ViewBuilder private func listRow(_ item: ListItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Group {
                if let done = item.task {
                    Image(systemName: done ? "checkmark.square.fill" : "square")
                        .font(.system(size: size * 0.9)).foregroundStyle(onAccent ? ink2 : done ? CE.accent : CE.ink3)
                } else {
                    Text(item.marker).font(.system(size: item.marker.count > 1 ? size * 0.93 : size))
                        .foregroundStyle(ink3)
                        .monospacedDigit()
                }
            }
            .frame(minWidth: (size * 1.35).rounded(), alignment: .leading)
            .padding(.trailing, item.marker.count > 2 ? 4 : 0)
            Text(inline(item.text)).font(.system(size: size)).lineSpacing(leading)
                .foregroundStyle(item.task == true ? ink2 : ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, CGFloat(item.level) * (size * 1.35).rounded())
    }

    /// Inline markdown; on the violet bubble `code` sits on a dark violet chip in white.
    private func inline(_ value: String) -> AttributedString {
        var result = markdownInline(value)
        guard onAccent else { return result }
        for run in result.runs where run.inlinePresentationIntent?.contains(.code) == true {
            result[run.range].backgroundColor = Color(red: 28 / 255, green: 12 / 255, blue: 96 / 255).opacity(0.35)
            if run.link == nil { result[run.range].foregroundColor = Color.white }
        }
        return result
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level { case 1: (size * 1.3).rounded(); case 2: (size * 1.18).rounded(); case 3: (size * 1.06).rounded(); default: size }
    }

    private var visibleBlocks: [MarkdownBlock] {
        let all = MarkdownBlock.parse(text)
        guard let title = omitTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty,
              case .heading(1, let first)? = all.first,
              first.trimmingCharacters(in: .whitespacesAndNewlines) == title else { return all }
        return Array(all.dropFirst())
    }
}

struct MarkdownListItem: Equatable {
    let marker: String
    let text: String
    /// Nesting depth (two spaces or a tab per level).
    var level = 0
    /// A task box: nil for a plain item, else whether it is ticked.
    var task: Bool? = nil
}
private typealias ListItem = MarkdownListItem

struct MarkdownTable: Equatable {
    enum Align: Equatable { case leading, center, trailing }
    var header: [String]
    var align: [Align]
    var rows: [[String]]
}

enum MarkdownBlock: Equatable {
    case heading(Int, String), code(String), list([MarkdownListItem]), quote(String), rule, table(MarkdownTable), paragraph(String)

    static func parse(_ text: String) -> [MarkdownBlock] {
        var result: [MarkdownBlock] = []
        var paragraph: [String] = []
        var list: [MarkdownListItem] = []
        var quote: [String] = []
        var code: [String]? = nil
        func flush() {
            if !paragraph.isEmpty { result.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !list.isEmpty { result.append(.list(list)); list = [] }
            if !quote.isEmpty { result.append(.quote(quote.joined(separator: "\n"))); quote = [] }
        }
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let raw = lines[i]
            let line = raw.trimmingCharacters(in: .whitespaces)
            defer { i += 1 }
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                if let current = code { result.append(.code(current.joined(separator: "\n"))); code = nil }
                else { flush(); code = [] }
                continue
            }
            if code != nil { code?.append(raw); continue }
            if line.isEmpty { flush(); continue }
            // A pipe table: a row of cells, then a separator row of dashes.
            if line.contains("|"), i + 1 < lines.count, let align = separator(lines[i + 1]) {
                let header = cells(line)
                if header.count == align.count || (header.count > 0 && align.count > 0) {
                    flush()
                    let width = max(header.count, align.count)
                    var rows: [[String]] = []
                    var j = i + 2
                    while j < lines.count {
                        let next = lines[j].trimmingCharacters(in: .whitespaces)
                        guard !next.isEmpty, next.contains("|") else { break }
                        rows.append(pad(cells(next), to: width))
                        j += 1
                    }
                    result.append(.table(MarkdownTable(header: pad(header, to: width), align: pad(align, to: width, with: .leading), rows: rows)))
                    i = j - 1
                    continue
                }
            }
            if line.hasPrefix(">") {
                if !paragraph.isEmpty || !list.isEmpty { flush() }
                var inner = String(line.dropFirst())
                if inner.hasPrefix(" ") { inner.removeFirst() }
                quote.append(inner)
                continue
            }
            if !quote.isEmpty { flush() }
            if isRule(line) { flush(); result.append(.rule); continue }
            if let heading = heading(line) { flush(); result.append(heading); continue }
            if let item = listItem(raw) {
                if !paragraph.isEmpty { result.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
                list.append(item)
                continue
            }
            if !list.isEmpty {
                // An indented line under a list item continues that item.
                if raw.hasPrefix("  ") || raw.hasPrefix("\t"), var last = list.popLast() {
                    last = MarkdownListItem(marker: last.marker, text: last.text + "\n" + line, level: last.level, task: last.task)
                    list.append(last)
                    continue
                }
                result.append(.list(list)); list = []
            }
            paragraph.append(line)
        }
        if let code { result.append(.code(code.joined(separator: "\n"))) }
        flush()
        return result
    }

    private static func heading(_ line: String) -> MarkdownBlock? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.dropFirst(hashes).hasPrefix(" ") else { return nil }
        var title = line.dropFirst(hashes + 1).trimmingCharacters(in: .whitespaces)
        // Closing hashes ("## Title ##") are not part of the title.
        while title.hasSuffix("#") { title.removeLast() }
        return .heading(hashes, title.trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ line: String) -> Bool {
        let compact = line.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    private static func listItem(_ raw: String) -> MarkdownListItem? {
        let indent = raw.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) }
        let line = raw.trimmingCharacters(in: .whitespaces)
        let level = min(indent / 2, 4)
        var marker: String
        var rest: Substring
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") || line.hasPrefix("• ") {
            marker = ["•", "◦", "▪"][min(level, 2)]
            rest = line.dropFirst(2)
        } else if let dot = line.firstIndex(where: { $0 == "." || $0 == ")" }), !line[..<dot].isEmpty, line[..<dot].count <= 3,
                  line[..<dot].allSatisfy(\.isNumber), line[line.index(after: dot)...].hasPrefix(" ") {
            marker = String(line[..<dot]) + "."
            rest = line[line.index(dot, offsetBy: 2)...]
        } else {
            return nil
        }
        var task: Bool?
        let lower = rest.lowercased()
        if lower.hasPrefix("[ ] ") || lower.hasPrefix("[x] ") {
            task = lower.hasPrefix("[x]")
            rest = rest.dropFirst(4)
            marker = ""
        }
        return MarkdownListItem(marker: marker, text: String(rest), level: level, task: task)
    }

    /// The alignment row of a pipe table ("|---|:-:|--:|"), or nil when the line is not one.
    private static func separator(_ raw: String) -> [MarkdownTable.Align]? {
        let line = raw.trimmingCharacters(in: .whitespaces)
        guard line.contains("-"), line.allSatisfy({ "|-: \t".contains($0) }) else { return nil }
        let parts = cells(line)
        guard !parts.isEmpty, parts.allSatisfy({ $0.contains("-") }) else { return nil }
        if !line.contains("|") && parts.count < 2 { return nil }
        return parts.map { part in
            let left = part.hasPrefix(":"), right = part.hasSuffix(":")
            return left && right ? .center : right ? .trailing : .leading
        }
    }

    /// The cells of a table row: split on `|` outside `code` and not escaped (`\|`), outer pipes dropped.
    private static func cells(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") && !trimmed.hasSuffix("\\|") { trimmed.removeLast() }
        var result: [String] = []
        var current = ""
        var inCode = false
        var escaped = false
        for ch in trimmed {
            if escaped { current.append(ch == "|" ? "|" : "\\\(ch)"); escaped = false; continue }
            if ch == "\\" { escaped = true; continue }
            if ch == "`" { inCode.toggle() }
            if ch == "|" && !inCode { result.append(current.trimmingCharacters(in: .whitespaces)); current = ""; continue }
            current.append(ch)
        }
        if escaped { current.append("\\") }
        result.append(current.trimmingCharacters(in: .whitespaces))
        return result
    }

    private static func pad<T>(_ values: [T], to count: Int, with filler: T) -> [T] {
        values.count >= count ? Array(values.prefix(count)) : values + Array(repeating: filler, count: count - values.count)
    }
    private static func pad(_ values: [String], to count: Int) -> [String] { pad(values, to: count, with: "") }
}

/// Inline markdown for Text: bold, italic, `code` (monospaced on a faint chip), links and ~~strikethrough~~. A single
/// `~` is kept as a tilde: Apple's parser would strike out everything between two of them ("0.0~3.9 ... 3.9~7.3").
func markdownInline(_ value: String) -> AttributedString {
    let source = markdownEscapingSingleTildes(value)
    var result = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(value)
    for run in result.runs where run.inlinePresentationIntent?.contains(.code) == true {
        result[run.range].backgroundColor = CE.violet.opacity(0.08)
        result[run.range].foregroundColor = CE.ink
    }
    return LocalFileLinks.applying(to: result)
}

/// `\~` for every tilde that is not part of a `~~` pair, outside `code` spans (where a backslash would show).
func markdownEscapingSingleTildes(_ value: String) -> String {
    guard value.contains("~") else { return value }
    let chars = Array(value)
    var out = ""
    out.reserveCapacity(chars.count + 8)
    var codeFence = 0
    var i = 0
    while i < chars.count {
        let ch = chars[i]
        if ch == "`" {
            var run = 0
            while i < chars.count, chars[i] == "`" { run += 1; i += 1 }
            out.append(String(repeating: "`", count: run))
            if codeFence == 0 { codeFence = run } else if codeFence == run { codeFence = 0 }
            continue
        }
        if ch == "\\", i + 1 < chars.count {
            out.append(ch); out.append(chars[i + 1]); i += 2
            continue
        }
        if ch == "~" && codeFence == 0 {
            let paired = (i + 1 < chars.count && chars[i + 1] == "~") || (i > 0 && chars[i - 1] == "~")
            out.append(paired ? "~" : "\\~")
            i += 1
            continue
        }
        out.append(ch)
        i += 1
    }
    return out
}

/// A pipe table as a grid: a tinted header row, hairlines between rows and columns, cells wrapping inside columns sized
/// to their content (shrunk in proportion when the table is wider than the space, stretched to fill it otherwise).
private struct MarkdownTableView: View {
    let table: MarkdownTable
    /// Cell text size (the web's .93em).
    let size: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        let columns = table.header.count
        MarkdownTableLayout(columns: columns, floor: (size * 4).rounded()) {
            ForEach(0..<columns, id: \.self) { c in
                cell(table.header[c], row: 0, column: c, header: true)
            }
            ForEach(Array(table.rows.enumerated()), id: \.offset) { r, row in
                ForEach(0..<columns, id: \.self) { c in
                    cell(row[c], row: r + 1, column: c, header: false)
                }
            }
        }
        .background(Color.white.opacity(0.5))
        .clipShape(shape)
        .overlay { shape.strokeBorder(CE.line) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("표, \(table.rows.count)행 \(columns)열")
    }

    private func cell(_ value: String, row: Int, column: Int, header: Bool) -> some View {
        let align = table.align.indices.contains(column) ? table.align[column] : .leading
        let frameAlign: Alignment = align == .center ? .top : align == .trailing ? .topTrailing : .topLeading
        let textAlign: TextAlignment = align == .center ? .center : align == .trailing ? .trailing : .leading
        return Text(markdownInline(value))
            .font(.system(size: size, weight: header ? .semibold : .regular))
            .foregroundStyle(CE.ink)
            .multilineTextAlignment(textAlign)
            .lineSpacing((size * 0.35).rounded())
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: frameAlign)
            .background(header ? CE.violet.opacity(0.05) : Color.clear)
            .overlay(alignment: .top) { if row > 0 { Rectangle().fill(CE.line).frame(height: 1) } }
            .overlay(alignment: .leading) { if column > 0 { Rectangle().fill(CE.line).frame(width: 1) } }
    }
}

/// Column widths for a markdown table, like a browser's auto table layout. The result never adds up to more than the
/// space offered: a table wider than the phone would push the whole page sideways and clip both edges.
enum MarkdownTableColumns {
    static func widths(ideal natural: [CGFloat], floor: CGFloat, available: CGFloat?) -> [CGFloat] {
        let ideal = natural.map { max($0, floor) }
        guard let available, available.isFinite, available > 0, !ideal.isEmpty else { return ideal }
        let total = ideal.reduce(0, +)
        if total <= available {
            // Stretch to fill the width, in proportion to each column's natural size.
            return ideal.map { $0 * available / max(total, 1) }
        }
        // Not even the floors fit: equal columns that add up to the space.
        guard available > CGFloat(ideal.count) * floor else { return ideal.map { _ in available / CGFloat(ideal.count) } }
        var result = Array(repeating: CGFloat(0), count: ideal.count)
        var open = Set(ideal.indices)
        var remaining = available
        // A column that fits within an even share keeps its natural width (a short "15.6~18.0" never wraps).
        var settled = true
        while settled && !open.isEmpty {
            settled = false
            let share = remaining / CGFloat(open.count)
            for i in open.sorted() where ideal[i] <= share {
                result[i] = ideal[i]
                remaining -= ideal[i]
                open.remove(i)
                settled = true
            }
        }
        // The wide ones split what is left in proportion to their natural widths. A column whose share falls under the
        // floor is held at the floor, and the others share what remains after it, so the total stays exact.
        while !open.isEmpty {
            let openIdeal = max(open.reduce(CGFloat(0)) { $0 + ideal[$1] }, 1)
            let pinned = open.filter { remaining * ideal[$0] / openIdeal < floor }
            if pinned.isEmpty {
                for i in open { result[i] = remaining * ideal[i] / openIdeal }
                break
            }
            for i in pinned {
                result[i] = floor
                remaining -= floor
                open.remove(i)
            }
        }
        return result
    }
}

/// Lays out table cells (row-major, `columns` per row). Column widths follow the widest cell of each column (capped),
/// stretched to fill the width or shrunk in proportion down to a floor; each row is as tall as its tallest cell.
private struct MarkdownTableLayout: Layout {
    let columns: Int
    /// The narrowest a column gets (the web's min-width 4em), and the widest its natural size counts as.
    var floor: CGFloat = 56
    private let cap: CGFloat = 460

    struct Cache { var ideal: [CGFloat] = [] }

    func makeCache(subviews: Subviews) -> Cache {
        var ideal = Array(repeating: CGFloat(0), count: max(columns, 1))
        for (i, subview) in subviews.enumerated() where columns > 0 {
            let w = subview.sizeThatFits(.unspecified).width
            ideal[i % columns] = max(ideal[i % columns], min(w, cap))
        }
        return Cache(ideal: ideal)
    }

    private func widths(_ available: CGFloat?, cache: Cache) -> [CGFloat] {
        MarkdownTableColumns.widths(ideal: cache.ideal, floor: floor, available: available)
    }

    private func rowHeights(_ widths: [CGFloat], subviews: Subviews) -> [CGFloat] {
        guard columns > 0 else { return [] }
        let rows = (subviews.count + columns - 1) / columns
        var heights = Array(repeating: CGFloat(0), count: rows)
        for (i, subview) in subviews.enumerated() {
            let h = subview.sizeThatFits(ProposedViewSize(width: widths[i % columns], height: nil)).height
            heights[i / columns] = max(heights[i / columns], h)
        }
        return heights
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let w = widths(proposal.width, cache: cache)
        return CGSize(width: w.reduce(0, +), height: rowHeights(w, subviews: subviews).reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let w = widths(bounds.width, cache: cache)
        let h = rowHeights(w, subviews: subviews)
        var y = bounds.minY
        for row in h.indices {
            var x = bounds.minX
            for column in 0..<columns {
                let i = row * columns + column
                guard i < subviews.count else { break }
                subviews[i].place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                                  proposal: ProposedViewSize(width: w[column], height: h[row]))
                x += w[column]
            }
            y += h[row]
        }
    }
}

// MARK: - Time

func parseISODate(_ value: String?) -> Date? {
    guard let value, !value.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

private func koreanFormatter(_ format: String) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "ko_KR")
    formatter.dateFormat = format
    return formatter
}

/// 24-hour Korean clock ("14:20"), independent of the system locale so the UI never mixes "PM" into Korean text.
func koTime(_ date: Date, seconds: Bool = false) -> String { koreanFormatter(seconds ? "HH:mm:ss" : "HH:mm").string(from: date) }
func koDateTime(_ date: Date) -> String { koreanFormatter("yyyy년 M월 d일 HH:mm").string(from: date) }

func clockTime(_ value: String?) -> String {
    guard let date = parseISODate(value) else { return "" }
    return koTime(date)
}

/// Short Korean relative time for meta lines: 방금 · N분 전 · N시간 전 · 어제 14:20 · 11월 4일 · 2025년 3월 2일.
func relativeTime(_ value: String?, now: Date = Date()) -> String {
    guard let date = parseISODate(value) else { return "" }
    let seconds = now.timeIntervalSince(date)
    if seconds < 60 { return "방금" }
    if seconds < 3600 { return "\(Int(seconds / 60))분 전" }
    if seconds < 6 * 3600 { return "\(Int(seconds / 3600))시간 전" }
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return koTime(date) }
    if calendar.isDateInYesterday(date) { return "어제 \(koTime(date))" }
    if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
        return koreanFormatter("M월 d일").string(from: date)
    }
    return koreanFormatter("yyyy년 M월 d일").string(from: date)
}

// MARK: - Lean list helpers (iteration 2)

/// Inset hairline between rows inside a glass panel.
struct RowDivider: View {
    var inset: CGFloat = 14
    var body: some View { Rectangle().fill(CE.line).frame(height: 1).padding(.leading, inset) }
}

/// Small state dot followed by quiet text ("● 승인 창 앞"). Colour lives in the dot only.
struct DotLabel: View {
    let text: String
    var tone: Tone = .neutral
    var emphasized = false
    init(_ text: String, tone: Tone = .neutral, emphasized: Bool = false) { self.text = text; self.tone = tone; self.emphasized = emphasized }
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(tone.dot).frame(width: 6, height: 6)
            Text(text).font(CEFont.meta.weight(emphasized ? .semibold : .regular)).foregroundStyle(emphasized ? tone.color : CE.ink2).lineLimit(1)
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

/// Caption above a group of rows inside a panel.
struct PanelCaption: View {
    let title: String
    var count: Int? = nil
    var body: some View {
        HStack(spacing: 5) {
            Text(title)
            if let count { Text("\(count)").monospacedDigit() }
            Spacer(minLength: 0)
        }
        .font(CEFont.micro).foregroundStyle(CE.ink3)
        .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 4)
        .accessibilityAddTraits(.isHeader)
    }
}
