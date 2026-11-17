import SwiftUI
#if os(macOS)
import AppKit
#endif

/// App frame, after the web shell the owner likes: Mac = glass rail (projects) + title + centred glass tabs + docked
/// composer; iPhone = project title menu + tab bar with badges + compose access. On Mac the member detail is a glass
/// drawer inside the window (a sibling of the rail), not a system sheet.
struct AppShell: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @State private var showArchive = false
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    #if DEBUG
    /// `--sheet localfile:md|code|image|other`: the chat file-path preview with sample content (review hook).
    @State private var localFileSample: LocalFileSample?
    #endif
    #if DEBUG && os(iOS)
    /// `--sheet keybar`: the terminal key bar over the keyboard (review hook, sample data only).
    @State private var keyBarPreview = false
    #endif
    #if os(macOS)
    @State private var attachmentIntake = MacAttachmentIntake()
    @Environment(\.openSettings) private var openSettings
    /// Window width, for the member drawer's width (40% of the window, 440…560).
    @State private var windowWidth: CGFloat = 1440
    /// The whole window (under the toolbar too), so the detail column can redraw the window's aurora in place.
    @State private var windowSize: CGSize = .zero
    /// The detail column's width, for the headline's share of the toolbar.
    @State private var detailWidth: CGFloat = 1176
    #endif
    private var needsConnection: Bool { store.bootstrap == nil && !store.isDemo }

    var body: some View {
        @Bindable var router = router
        ZStack {
            AmbientBackground()
            #if os(macOS)
            GeometryReader { geo in
                Color.clear.onChange(of: geo.size, initial: true) { _, size in windowSize = size }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            if !needsConnection { StageLights() }
            #endif
            if needsConnection {
                ConnectionView()
            } else {
                #if os(macOS)
                desk
                #else
                phone.environment(\.ceWide, sizeClass == .regular)
                #endif
            }
        }
        .foregroundStyle(CE.ink)
        .projectManagementSheets(enabled: !router.showSettings && !showArchive)
        .sheet(isPresented: $showArchive) { ArchiveLibraryView() }
        #if DEBUG && os(iOS)
        .sheet(isPresented: $keyBarPreview) { TerminalKeyBarPreview() }
        #endif
        #if DEBUG
        .sheet(item: $localFileSample) { sample in
            LocalFileView(path: sample.path, projectID: store.selectedProjectID ?? "", sample: sample.preview)
        }
        #endif
        .sheet(isPresented: $router.showNewProject) { NewProjectView() }
        .sheet(isPresented: $router.showNewMember) { NewMemberView() }
        .sheet(item: rootTerminal) { TerminalView(member: $0) }
        #if os(macOS)
        // Settings is its own window on Mac.
        .onChange(of: router.showSettings) { _, show in
            guard show else { return }
            router.showSettings = false
            openSettings()
        }
        .sheet(isPresented: $router.showPairing) { MacPairingSheet() }
        // "지시" from the member drawer: close it so the docked composer can take focus.
        .onChange(of: router.focusComposer) { _, _ in router.memberID = nil }
        // The tabs and ⌘1…⌘5 stay usable while the drawer is open: going to another screen closes it. (`--open` sets
        // both values at launch, so this never fires for it; on Mac `openMember` never changes the destination.)
        .onChange(of: router.destination) { _, _ in router.memberID = nil }
        #else
        .sheet(isPresented: $router.showSettings) { SettingsView() }
        #endif
        #if DEBUG && os(iOS)
        // Development hook (simulator has no camera and cannot tap the system "open in IAMCEO?" prompt):
        // `--pair <iamceo://pair?…>` runs the same pairing path as a scanned QR.
        .task {
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "--pair"), args.indices.contains(i + 1),
                  let url = URL(string: args[i + 1]), let link = PairingLink(url: url) else { return }
            await store.pair(with: link, device: UIDevice.current.name)
        }
        #endif
        // A pairing QR read by the system camera opens iamceo://pair?… — trade it for a connection right away.
        .onOpenURL { url in
            guard !store.isDemo else { return }
            if let notification = NotificationLink(url: url) {
                NotificationInbox.shared.receive(notification, tapped: true)
                return
            }
            guard let link = PairingLink(url: url) else { return }
            #if os(iOS)
            Task { await store.pair(with: link, device: UIDevice.current.name) }
            #else
            store.errorMessage = "이 링크는 iPhone에서 여는 연결 QR입니다."
            _ = link
            #endif
        }
        .onChange(of: "\(scenePhase == .active):\(store.connectionStatus.rawValue):\(store.isRevalidating):\(store.serverID ?? ""):\(NotificationInbox.shared.refreshRevision):\(NotificationInbox.shared.pending.count)", initial: true) { _, _ in
            store.registerRouter(router)
            guard scenePhase == .active else { router.cancelPendingNavigation(); return }
            // Consuming a tap changes the mailbox. It must not cancel its own validation request.
            Task { await store.processNotifications(router: router) }
        }
        // Foreground/background polling is driven by the App's aggregate scene phase (IAMCEOApp).
        .onChange(of: "\(store.selectedProjectID ?? ""):\(store.isArchive)") { _, _ in router.resetForProjectChange() }
        // The store is shared by every window: a window that appears later (second iPad window, Mac window reopened
        // after ⌘W) must not tear down a live or in-progress connection.
        .task {
            guard !store.isDemo, store.bootstrap == nil, store.connectionStatus != .connecting,
                  !store.endpoint.isEmpty, !store.accessCode.isEmpty else { return }
            await store.connect()
        }
        #if DEBUG
        // Review hook for the read-only sample workspace: `--sheet archive|pairing|new-project|new-member|settings|
        // rename|terminal:<memberID>` opens that popup at launch (screenshots of sheets).
        .task {
            guard store.isDemo, let sheet = LaunchOptions.value(after: "--sheet") else { return }
            try? await Task.sleep(for: .milliseconds(400))
            switch sheet {
            case "archive": showArchive = true
            case "pairing": router.showPairing = true
            case "new-project", "folder-picker", "github-clone": router.showNewProject = true
            case "new-member": router.showNewMember = true
            case "settings": router.showSettings = true
            case "compose": router.focusComposer &+= 1
            case "rename": if let id = store.selectedProjectID { router.manageProject(id: id, mode: .rename) }
            #if os(iOS)
            case "keybar": keyBarPreview = true
            #endif
            default:
                if sheet.hasPrefix("localfile:") { localFileSample = LocalFileSample(kind: String(sheet.dropFirst("localfile:".count))); return }
                if sheet.hasPrefix("terminal:") { router.terminalMemberID = String(sheet.dropFirst("terminal:".count)) }
            }
        }
        #endif
        #if DEBUG && os(macOS)
        // Review hook: `--peek` keeps every window of the sample app on the current Space (also over a full-screen app)
        // with all but its last 2pt column left of the display, so `screencapture -l` can read it without showing it
        // to the person at the Mac.
        .task {
            guard store.isDemo, LaunchOptions.arguments.contains("--peek") else { return }
            for _ in 0..<160 {
                for window in NSApp.windows where window.sheetParent == nil && window.isVisible {
                    window.collectionBehavior.insert([.canJoinAllSpaces, .fullScreenAuxiliary])
                    let target = NSPoint(x: -(window.frame.width - 2), y: 0)
                    if window.frame.origin != target { window.setFrameOrigin(target); window.orderFrontRegardless() }
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        // Review hook: `--snapshot <dir>` draws every window of the sample app into <dir>/window-<n>.png after the
        // screen settles, then quits (AppKit cacheDisplay: layout is right, materials draw grey).
        .task {
            guard store.isDemo, let dir = LaunchOptions.value(after: "--snapshot") else { return }
            let delay = Double(LaunchOptions.value(after: "--snapshot-delay") ?? "") ?? 3
            try? await Task.sleep(for: .seconds(delay))
            var index = 0
            for window in NSApp.windows where window.isVisible && window.frame.width >= 200 {
                guard let view = window.contentView?.superview ?? window.contentView,
                      let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
                view.cacheDisplay(in: view.bounds, to: rep)
                index += 1
                let kind = window.sheetParent != nil ? "sheet" : (window.identifier?.rawValue.contains("Settings") == true ? "settings" : "window")
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(kind)-\(index).png"))
            }
            exit(0)
        }
        #endif
    }

    /// Terminal sheet from the window root, on both platforms. The Mac member drawer lives inside the window, so the
    /// terminal it opens is presented here too and stays open if the drawer closes.
    private var rootTerminal: Binding<Member?> {
        Binding(get: { terminalMember }, set: { router.terminalMemberID = $0?.id })
    }

    private var terminalMember: Member? {
        guard !store.isArchive else { return nil }
        return router.terminalMemberID.flatMap { id in store.members.first { $0.id == id } }
    }

    // MARK: Mac desk

    #if os(macOS)
    private var desk: some View {
        NavigationSplitView {
            ProjectSidebar()
                // Every split column gets fixed minimums: wrapped text must never make a column's minimum size
                // depend on its own width (AppKit re-enters constraint updates and terminates the app).
                .frame(minWidth: 220, maxWidth: .infinity, minHeight: 300, maxHeight: .infinity)
                .navigationSplitViewColumnWidth(min: 220, ideal: 264, max: 320)
        } detail: {
            destinationView(router.destination)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // One look under the toolbar on every tab. macOS shows the window's aurora under the toolbar only
                // where a scroll view reaches it (홈, 결재함, 팀); over a fixed layout (대화, 자료) it paints a solid band,
                // which in full screen runs across the whole top of the screen.
                .modifier(ScrollPocketUnderToolbar(enabled: router.destination == .chat || router.destination == .files))
                .ceStatusStrips()
                .ceBar(.bottom) { dockedComposer }
                // The window's aurora and stage lights, redrawn at the window's size and position: a copy laid out in
                // this column's own frame put its blobs elsewhere and left a seam at the rail's edge.
                .background { WindowAnchoredBackdrop(windowSize: windowSize) }
                // Sidebar max 320 + detail 560 stays inside the window minimum (1040).
                .frame(minWidth: 560, maxWidth: .infinity, minHeight: 420, maxHeight: .infinity)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { detailWidth = $0 }
                // Member detail: a glass drawer over this column on every destination; the rail stays undimmed.
                .overlay { if !store.isArchive { MemberDrawerHost(windowWidth: windowWidth) } }
                // Kept for the Window menu and Mission Control; the toolbar shows `headline` instead (macOS 15+).
                .navigationTitle(store.state?.project.name ?? "IAMCEO")
                .modifier(DeskTitle(subtitle: ""))
                .toolbar {
                    if #available(macOS 26.0, *) {
                        ToolbarItem(placement: .navigation) { headline }
                            .sharedBackgroundVisibility(.hidden)
                        ToolbarItem(placement: .principal) { DestinationSwitcher(compact: compactTabs) }
                            .sharedBackgroundVisibility(.hidden)
                    } else if #available(macOS 15.0, *) {
                        ToolbarItem(placement: .navigation) { headline }
                        ToolbarItem(placement: .principal) { DestinationSwitcher(compact: compactTabs) }
                    } else {
                        ToolbarItem(placement: .principal) { DestinationSwitcher(compact: compactTabs) }
                    }
                }
                .background { shortcuts }
                .overlay { MacAttachmentDropSurface(intake: attachmentIntake, policy: attachmentPolicy) }
                .overlay {
                    if attachmentIntake.targeted {
                        let shape = RoundedRectangle(cornerRadius: 22)
                        VStack(spacing: 12) {
                            Image(systemName: attachmentPolicy.canAccept ? "paperclip.circle" : "lock.circle")
                                .font(.system(size: 32))
                            Text(attachmentPolicy.reason ?? (attachmentIntake.receive == nil
                                ? "입력칸을 준비 중입니다. 잠시 뒤 다시 놓아 주세요"
                                : "여기에 놓으면 \(attachmentRecipient)에게 보낼 첨부로 올립니다"))
                                .font(.system(size: 15, weight: .semibold))
                                .multilineTextAlignment(.center)
                        }
                        .foregroundStyle(CE.accent)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(CE.violet.opacity(0.14), in: shape)
                        .overlay { shape.strokeBorder(CE.focus, style: StrokeStyle(lineWidth: 2, dash: [6, 4])) }
                        .padding(8)
                        .allowsHitTesting(false)
                    }
                }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { windowWidth = $0 }
    }

    private var attachmentRecipient: String {
        router.chatTarget.flatMap { id in store.members.first { $0.id == id }?.name } ?? store.leadRankName
    }

    private var attachmentPolicy: MacAttachmentPolicy {
        MacAttachmentPolicy(archived: store.isArchive || store.state?.project.archived == true,
                            demo: store.isDemo, connected: store.connectionStatus == .connected,
                            writable: store.uiCanWrite && store.selectedProjectID != nil,
                            missingTarget: router.chatTarget != nil && !store.members.contains { $0.id == router.chatTarget },
                            composerCovered: router.memberID != nil)
    }

    /// Web: 108pt tab cells from a 1280pt window up, 92 below (the headline keeps its room).
    private var compactTabs: Bool { windowWidth < 1280 }

    /// Room left of the centred tab pill: half of what the pill leaves, less the toolbar's edge and a gap.
    private var headlineWidth: CGFloat {
        let pill = CGFloat(Destination.allCases.count) * DestinationSwitcher.tabWidth(compact: compactTabs) + 8
        return min(440, max(96, (detailWidth - pill) / 2 - 56))
    }

    /// The project name alone (17/650). The owner asked for no summary line under it on any tab: the current
    /// situation lives on 홈.
    private var headline: some View {
        let name = store.state?.project.name ?? "IAMCEO"
        return Text(name).font(.system(size: 17, weight: .semibold)).tracking(-0.25)
            .foregroundStyle(CE.ink).lineLimit(1).truncationMode(.tail)
        .frame(width: headlineWidth, alignment: .leading)
        .help(name)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// Web composer: centred under the content column (832 = 880 column − 2×24 padding).
    /// While the member drawer is open the composer gives up keyboard focus (disabled; the draft stays in DraftStore),
    /// so keystrokes and Return never reach a field the drawer covers. 지시 closes the drawer first, then focuses it.
    @ViewBuilder private var dockedComposer: some View {
        @Bindable var router = router
        // On 대화 the composer belongs to the thread it sends to, not under the recipients column
        // (ChatView wide layout: 230pt column + 1pt divider).
        let leading: CGFloat = router.destination == .chat && store.state != nil ? 231 : 0
        if !store.isArchive {
            ComposerBar(target: $router.chatTarget, onOpenChat: router.destination == .chat ? nil : { router.go(.chat) })
            .environment(attachmentIntake)
            .disabled(router.memberID != nil)
            .frame(maxWidth: 832)
            .padding(.horizontal, 24).padding(.top, 6).padding(.bottom, 14)
            .frame(maxWidth: .infinity)
            .padding(.leading, leading)
            .background {
                // Violet light behind the glass (web .shell__bottom::after): an ellipse min(760, 110%) wide from the
                // bar's top to 30pt below the window, violet .16 → .06 at 55% → 0, brightest behind the panel's middle.
                GeometryReader { geo in
                    let width = geo.size.width - leading
                    EllipticalGradient(stops: [
                        .init(color: CE.violet.opacity(0.16), location: 0),
                        .init(color: CE.violet.opacity(0.06), location: 0.55),
                        .init(color: CE.violet.opacity(0), location: 1),
                    ])
                    .frame(width: min(760, width * 1.1), height: geo.size.height + 30)
                    .position(x: leading + width / 2, y: (geo.size.height + 30) / 2)
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            // Under the light (web ::before under ::after): a fade to the light background before macOS 26, where
            // there is no scroll-edge effect under the bar.
            .background(alignment: .bottom) {
                if #available(macOS 26.0, *) {} else {
                    LinearGradient(colors: [CE.bg.opacity(0), CE.bg.opacity(0.85)], startPoint: .top, endPoint: .bottom)
                        .allowsHitTesting(false)
                }
            }
        }
    }

    /// ⌘1…⌘5 switch destinations, ⌘R syncs now.
    private var shortcuts: some View {
        ZStack {
            ForEach(Array(Destination.allCases.enumerated()), id: \.element) { index, tab in
                Button(tab.title) { router.go(tab) }.keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
            }
            Button("지금 동기화") { Task { await store.refresh() } }.keyboardShortcut("r", modifiers: .command)
        }
        .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
    }
    #endif

    // MARK: iPhone / iPad

    #if os(iOS)
    private var phone: some View {
        @Bindable var router = router
        return TabView(selection: $router.destination) {
            ForEach(Destination.allCases) { tab in
                NavigationStack {
                    destinationView(tab)
                        .ceStatusStrips()
                        .background { AmbientBackground() }
                        .navigationTitle(store.state?.project.name ?? "IAMCEO")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button { router.showSettings = true } label: { Image(systemName: "gearshape") }
                                    .accessibilityLabel("설정, \(connectionLabel)")
                            }
                            projectSwitcher(tab)
                        }
                }
                // The same composer sits above the tab bar on every tab and rises with the keyboard where it is
                // (대화 has its own, under the recipient chips).
                .modifier(PhoneComposerDock(tab: tab))
                .tabItem { Label(tab.title, systemImage: tab.icon) }
                .badge(store.navBadge(for: tab))
                .tag(tab)
            }
        }
    }

    private var connectionLabel: String {
        if store.isDemo { return "샘플 데이터 · 읽기 전용" }
        return store.connectionStatus == .connected ? "서버 연결됨" : "서버 끊김"
    }

    /// Title = project switcher (web phone header). The badge counts what waits in the *other* projects, which the
    /// tab badges (selected project only) cannot show: Σ inboxCount + blockedCount, danger when someone is blocked.
    @ToolbarContentBuilder private func projectSwitcher(_ tab: Destination) -> some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: .principal) { projectSwitcherLabel(tab) }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .principal) { projectSwitcherLabel(tab) }
        }
    }

    private var otherProjectsNeeds: (count: Int, blocked: Bool) {
        let others = store.projects.filter { $0.id != store.selectedProjectID }
        return (others.map { $0.inboxCount + $0.blockedCount }.reduce(0, +), others.contains { $0.blockedCount > 0 })
    }

    private func projectSwitcherLabel(_ tab: Destination) -> some View {
        let name = store.state?.project.name ?? "IAMCEO"
        let others = otherProjectsNeeds
        return Menu { projectMenuItems } label: {
            HStack(spacing: 7) {
                Text(name).font(.headline).foregroundStyle(CE.ink).lineLimit(1)
                CountBadge(count: others.count, tone: others.blocked ? .danger : .accent)
                Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(CE.ink2)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("프로젝트 \(name)\(others.count > 0 ? ", 다른 프로젝트에서 \(others.count)건이 기다립니다" : ""). 바꾸기")
    }

    @ViewBuilder private var projectMenuItems: some View {
        ForEach(store.projects.filter(\.isHq) + store.projects.filter { !$0.isHq }) { project in
            Button { Task { await store.selectProject(id: project.id) } } label: {
                Label {
                    Text(project.name)
                    Text(projectMenuLine(project))
                } icon: {
                    if project.id == store.selectedProjectID { Image(systemName: "checkmark") }
                }
            }
            .disabled(store.isDemo && project.id != store.selectedProjectID)
        }
        Divider()
        if let id = store.selectedProjectID {
            Button("이름 바꾸기…") { router.manageProject(id: id, mode: .rename) }
                .disabled(store.isDemo || store.connectionStatus != .connected)
            if store.isArchive {
                Button("꺼내기…") { router.manageProject(id: id, mode: .restore) }
                    .disabled(store.isDemo || store.connectionStatus != .connected)
            } else if id != "hq", store.state?.project.isHq != true {
                Button("보관…") { router.manageProject(id: id, mode: .archive) }.disabled(!store.canWrite)
            }
        }
        Button { showArchive = true } label: { Label("보관함", systemImage: "archivebox") }
        Button { router.showNewProject = true } label: { Label("새 프로젝트", systemImage: "plus") }
            .disabled(!store.canWrite)
        Button { router.showSettings = true } label: { Label("설정", systemImage: "gearshape") }
    }

    /// Web projectLine plus what waits on the CEO (the rail's badge, spelled out because a menu has no badge).
    private func projectMenuLine(_ project: ProjectSummary) -> String {
        var parts = [projectRailLine(project)]
        if project.decisionCount > 0 { parts.append("결재 \(project.decisionCount)") }
        if project.todoCount > 0 { parts.append("할 일 \(project.todoCount)") }
        return parts.joined(separator: " · ")
    }
    #endif

    @ViewBuilder private func destinationView(_ tab: Destination) -> some View {
        if store.isArchive { ArchiveView(destination: tab) } else {
            switch tab {
            case .home: HomeView()
            case .inbox: InboxView()
            case .team: TeamView()
            case .chat: ChatView()
            case .files: FilesView()
            }
        }
    }
}

/// Web `projectLine`: one sub-line per project, the state the CEO has to resolve first.
func projectRailLine(_ project: ProjectSummary) -> String {
    if project.blockedCount > 0 { return "승인 창 앞 \(project.blockedCount)명" }
    if project.errorCount > 0 { return "오류 \(project.errorCount)명" }
    if project.workingCount > 0 { return "\(project.workingCount)명 일하는 중" }
    if !project.isHq && !project.runnerEnabled { return "총괄 시작 전" }
    if project.memberCount > 0 { return "\(project.memberCount)명 대기" }
    return "대기"
}

// MARK: - Mac rail

#if os(macOS)
/// Web left rail: brand, 본사, "프로젝트", project rows (name / state line / count badge), 새 프로젝트, then 설정 and the
/// connection mark. The split view's sidebar column supplies the floating glass on macOS 26.
struct ProjectSidebar: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var showArchive = false
    private var hq: [ProjectSummary] { store.projects.filter(\.isHq) }
    private var others: [ProjectSummary] { store.projects.filter { !$0.isHq } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                brand
                ForEach(hq) { row($0) }
                if store.isArchive, let project = store.state?.project {
                    // Same type and insets as a project row (name 14.5/600, sub 12 ink-2, 3pt apart, 7/12).
                    VStack(alignment: .leading, spacing: 3) {
                        Label(project.name, systemImage: "archivebox").font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                        Text("보관함 · 읽기 전용").font(CEFont.caption).foregroundStyle(CE.ink2).lineLimit(1)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .contextMenu {
                        Button("이름 바꾸기…") { router.manageProject(id: project.id, mode: .rename) }
                            .disabled(store.isDemo || store.connectionStatus != .connected)
                        Button("꺼내기…") { router.manageProject(id: project.id, mode: .restore) }
                            .disabled(store.isDemo || store.connectionStatus != .connected)
                    }
                }
                if !others.isEmpty {
                    Text("프로젝트")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(CE.ink3)
                        .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 6)
                        .accessibilityAddTraits(.isHeader)
                }
                ForEach(others) { row($0) }
                // web .pj--add: 42 tall, 14/500 ink-2, ink-1 on hover.
                Button { router.showNewProject = true } label: { quietRow("새 프로젝트", icon: "plus", minHeight: 42) }
                    .buttonStyle(RailRowStyle(quiet: true))
                    .padding(.top, 6)
                    .disabled(!store.canWrite)
            }
            .padding(.horizontal, 8).padding(.bottom, 8)
        }
        .scrollIndicators(.never)
        .ceBar(.bottom) { footer }
        .sheet(isPresented: $showArchive) { ArchiveLibraryView() }
    }

    private var brand: some View {
        HStack(spacing: 9) {
            BrandMark(size: 22)
            Text("IAMCEO").font(.system(size: 13.5, weight: .bold)).tracking(0.8).foregroundStyle(CE.ink)
        }
        .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 12)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private func row(_ project: ProjectSummary) -> some View {
        let selected = project.id == store.selectedProjectID
        let count = project.inboxCount + project.blockedCount
        let line = projectRailLine(project)
        return Button {
            guard !selected else { return }
            Task { await store.selectProject(id: project.id) }
        } label: {
            HStack(spacing: 10) {
                // web .pj__main: name 14.5/600 and sub 12, both at line-height 1.3, 1px apart (≈ 3pt here).
                VStack(alignment: .leading, spacing: 3) {
                    Text(project.name).font(.system(size: 14.5, weight: .semibold)).tracking(-0.15)
                        .foregroundStyle(CE.ink).lineLimit(1)
                    Text(line).font(CEFont.caption).foregroundStyle(CE.ink2).lineLimit(1)
                }
                Spacer(minLength: 4)
                RailBadge(count: count, danger: project.blockedCount > 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .frame(minHeight: 48)
        }
        .buttonStyle(RailRowStyle(selected: selected))
        .disabled(store.isDemo && !selected)
        .contextMenu {
            Button("이름 바꾸기…") { router.manageProject(id: project.id, mode: .rename) }
                .disabled(store.isDemo || store.connectionStatus != .connected)
            if !project.isHq && project.id != "hq" {
                Button("보관…") { router.manageProject(id: project.id, mode: .archive) }.disabled(!store.canWrite)
            }
        }
        .help(projectStatusLine(project))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(project.name), \(line)\(count > 0 ? ", 확인할 일 \(count)건" : "")")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    /// web .pj--foot / .pj--add: icon column 16, label 14/500; ink-2, ink-1 on hover (RailRowStyle quiet).
    private func quietRow(_ title: String, icon: String, minHeight: CGFloat = 40) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 13, weight: .medium)).frame(width: 16)
            Text(title).font(.system(size: 14, weight: .medium)).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).frame(minHeight: minHeight)
        .contentShape(Rectangle())
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 2) {
            Rectangle().fill(CE.line).frame(height: 1).padding(.horizontal, 4).padding(.bottom, 4)
            Button { showArchive = true } label: { quietRow("보관함", icon: "archivebox") }
                .buttonStyle(RailRowStyle(quiet: true))
            SettingsLink { quietRow("설정", icon: "gearshape") }
                .buttonStyle(RailRowStyle(quiet: true))
                .help("설정 (⌘,)")
            Button { router.showPairing = true } label: { quietRow("iPhone 연결", icon: "iphone") }
                .buttonStyle(RailRowStyle(quiet: true))
                .help("QR로 iPhone을 이 Mac에 연결합니다")
            connectionMark
        }
        .padding(.horizontal, 8).padding(.bottom, 8)
    }

    /// Web ConnectionMark. Clicking it syncs now (or reconnects); the last sync time is in the tooltip.
    private var connectionMark: some View {
        let state = connectionState
        return Button {
            Task { if store.connectionStatus == .connected { await store.refresh() } else { await store.connect() } }
        } label: {
            HStack(spacing: 7) {
                Circle().fill(state.color).frame(width: 7, height: 7)
                    .shadow(color: state.glow ? state.color.opacity(0.6) : .clear, radius: 4)
                Text(state.text).font(.system(size: 12.5)).foregroundStyle(state.danger ? CE.danger : CE.ink2).lineLimit(1)
                Spacer(minLength: 4)
                if store.isLoading { ProgressView().controlSize(.mini) }
            }
            // web .rail__foot .conn: padding 6 12 8.
            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(store.isDemo)
        .help(connectionHelp)
        .accessibilityLabel(state.text)
        .accessibilityHint(store.isDemo ? "" : store.connectionStatus == .connected ? "지금 동기화" : "다시 연결")
    }

    /// `color` is the dot (dot strength); the text is ink-2, or `CE.danger` when `danger`.
    private var connectionState: (text: String, color: Color, glow: Bool, danger: Bool) {
        if store.isDemo { return ("샘플 데이터 · 읽기 전용", CE.focus, true, false) }
        switch store.connectionStatus {
        case .connected: return (store.localizedSyncDescription, store.realtimeStatus == .fallback ? CE.attentionDot : CE.successDot, store.realtimeStatus == .live, false)
        case .connecting: return ("서버 연결 중", CE.warnDot, false, false)
        default: return ("서버 끊김", CE.error, false, true)
        }
    }

    private var connectionHelp: String {
        if store.isDemo { return "샘플 데이터는 실제 서버에 연결되지 않습니다." }
        guard store.connectionStatus == .connected else { return "눌러서 다시 연결" + (store.connectionIssue.map { " · \($0)" } ?? "") }
        return "눌러서 지금 동기화 (⌘R)" + (store.lastUpdated.map { " · 마지막 \(koTime($0, seconds: true))" } ?? "")
    }
}

/// Web rail badge: violet with white digits, or danger digits on a light red tint when someone is at an approval prompt.
private struct RailBadge: View {
    let count: Int
    let danger: Bool
    var body: some View {
        if count > 0 {
            Text("\(count)").font(.system(size: 12, weight: .semibold)).monospacedDigit()
                .foregroundStyle(danger ? CE.danger : Color.white)
                .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20)
                .background {
                    if danger {
                        Capsule().fill(Color.white.opacity(0.8)).overlay { Capsule().fill(CE.error.opacity(0.12)) }
                    } else {
                        Capsule().fill(CE.accentFill)
                    }
                }
                .fixedSize()
        }
    }
}

/// Web `.pj` row: hover lifts it onto an opaque white plate, violet gradient when current, dimmed when disabled. `quiet` rows (web .pj--add,
/// .pj--foot) draw their label in ink-2 and brighten it to ink-1 on hover or press.
private struct RailRowStyle: ButtonStyle {
    var selected = false
    var quiet = false
    func makeBody(configuration: Configuration) -> some View { RailRowBody(configuration: configuration, selected: selected, quiet: quiet) }
    private struct RailRowBody: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        let quiet: Bool
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
            let lit = isEnabled && (hovering || configuration.isPressed)
            configuration.label
                .foregroundStyle(quiet && !lit && !selected ? CE.ink2 : CE.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(shape)
                .background {
                    if selected {
                        // mockup .pj.on (--sel-bg / --sel-ring): violet .16 → .10 inside a 1px violet .3 ring.
                        shape.fill(LinearGradient(colors: [CE.selectedTop, CE.selectedBottom], startPoint: .top, endPoint: .bottom))
                            .overlay { shape.strokeBorder(CE.selectedRing) }
                    } else if configuration.isPressed {
                        shape.fill(CE.wash(0.08))
                    } else {
                        // web .pj:hover: lifts onto an opaque white plate (--row-hover / --row-lift)
                        RowLift(shape: shape, lifted: hovering && isEnabled)
                    }
                }
                .animation(.linear(duration: 0.12), value: lit)
                .opacity(isEnabled ? 1 : 0.5)
                .onHover { hovering = $0 }
        }
    }
}

/// Web GlassTabs: one white glass capsule with count bubbles (홈 = open todos, 결재함 = open decisions + blocked
/// members); the selected tab is a white drop with a violet glow that slides. Card surface, not Liquid Glass (see `cardPill`).
struct DestinationSwitcher: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Narrow window: 92pt cells instead of 104 (web: 108 incl. pill padding from 1280 up, 92 below).
    var compact = false
    @State private var hovered: Destination?
    @State private var slide = Slide()

    /// web --tab-h is 40 (pill 48); 36 keeps the 44pt pill inside the 52pt unified toolbar.
    static let tabHeight: CGFloat = 36
    static func tabWidth(compact: Bool) -> CGFloat { compact ? 92 : 104 }

    private struct Slide: Equatable { var count = 0; var distance = 1 }
    private struct Squash { var x: CGFloat = 1; var y: CGFloat = 1 }

    private var tabs: [Destination] { Destination.allCases }
    private var tabWidth: CGFloat { Self.tabWidth(compact: compact) }
    private var index: Int { tabs.firstIndex(of: router.destination) ?? 0 }

    var body: some View {
        segments
            // The selected tab's white drop with its violet glow, behind the labels; it slides from tab to tab.
            .background(alignment: .leading) { drop }
            .padding(4)
            // The card's white glass (mockup .tabs.g; the light glass ignores the tint value).
            .cardPill(tint: 0.62)
            // web .gtabs-glow: a violet light behind the pill that follows the selected tab.
            .background(alignment: .leading) { glow }
            .animation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.78), value: router.destination)
            .fixedSize()
            .onChange(of: router.destination) { old, new in
                let from = tabs.firstIndex(of: old) ?? 0, to = tabs.firstIndex(of: new) ?? 0
                slide = Slide(count: slide.count + 1, distance: max(1, min(abs(to - from), 3)))
            }
    }

    private var segments: some View {
        HStack(spacing: 0) {
            ForEach(Array(tabs.enumerated()), id: \.element) { position, tab in segment(tab, position: position) }
        }
    }

    private func segment(_ tab: Destination, position: Int) -> some View {
        let selected = router.destination == tab
        let count = store.navBadge(for: tab)
        let detail = store.navBadgeHelp(for: tab)
        // web .gtabs__link: 14.5/600 on every tab (selection changes only the colour, so labels never shift);
        // ink-2, ink-1 on hover; the selected label is the accent on its white drop.
        return Button { router.go(tab) } label: {
            HStack(spacing: 6) {
                Text(tab.title).font(.system(size: 14.5, weight: .semibold)).tracking(-0.15)
                CountBadge(count: count, tone: .accent)
            }
            .foregroundStyle(selected ? CE.accent : hovered == tab ? CE.ink : CE.ink2)
            .animation(.linear(duration: 0.2), value: hovered)
            .frame(width: tabWidth, height: Self.tabHeight)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { inside in
            if inside { hovered = tab } else if hovered == tab { hovered = nil }
        }
        .help("\(tab.title)\(detail.map { " · \($0)" } ?? "") (⌘\(position + 1))")
        .accessibilityLabel(count > 0 ? "\(tab.title), \(detail ?? "\(count)건")" : tab.title)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    /// One drop for the whole pill, moved by offset: it slides with the spring and, like the web drop, stretches
    /// sideways and flattens while it travels (more for a longer jump). Reduce Motion: no stretch, no slide.
    private var drop: some View {
        let stretch: CGFloat = reduceMotion ? 1 : 1 + 0.16 * CGFloat(slide.distance)
        let flatten: CGFloat = reduceMotion ? 1 : 0.84
        return TabDrop()
            .frame(width: tabWidth, height: Self.tabHeight)
            .keyframeAnimator(initialValue: Squash(), trigger: slide) { content, value in
                content.scaleEffect(x: value.x, y: value.y)
            } keyframes: { _ in
                KeyframeTrack(\.x) {
                    CubicKeyframe(stretch, duration: 0.22)
                    CubicKeyframe(reduceMotion ? 1 : 1.02, duration: 0.21)
                    CubicKeyframe(1, duration: 0.19)
                }
                KeyframeTrack(\.y) {
                    CubicKeyframe(flatten, duration: 0.22)
                    CubicKeyframe(reduceMotion ? 1 : 0.98, duration: 0.21)
                    CubicKeyframe(1, duration: 0.19)
                }
            }
            .offset(x: CGFloat(index) * tabWidth)
    }

    /// web: radial violet .2 → .08 at 48% → 0, 2/n of the pill + 90 wide, 3.1 tab heights tall, centred on the tab.
    /// The toolbar may cut it at its edge; it is faint there.
    private var glow: some View {
        let pill = CGFloat(tabs.count) * tabWidth + 8
        let width = 2 * pill / CGFloat(tabs.count) + 90
        return EllipticalGradient(stops: [
            .init(color: CE.violet.opacity(0.2), location: 0),
            .init(color: CE.violet.opacity(0.08), location: 0.48),
            .init(color: CE.violet.opacity(0), location: 1),
        ])
        .frame(width: width, height: Self.tabHeight * 3.1)
        .offset(x: 4 + (CGFloat(index) + 0.5) * tabWidth - width / 2)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Mac member drawer

/// Member detail on Mac: a drawer floating at the trailing edge of the content column, inset like the rail and in the
/// rail's light glass colour, over a light scrim. Driven by `router.memberID` (home rows, office desks, chat, files, inbox,
/// `--open`). The scrim, Esc, the close button and switching screens all clear it.
private struct MemberDrawerHost: View {
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let windowWidth: CGFloat

    private var width: CGFloat { min(max(windowWidth * 0.4, 440), 560) }

    var body: some View {
        let open = router.memberID != nil
        ZStack(alignment: .trailing) {
            if open {
                // Stops at the toolbar: the tabs stay live (switching screens closes the drawer), so they stay undimmed.
                CE.inkBase.opacity(0.15)
                    .contentShape(Rectangle())
                    .onTapGesture { close() }
                    .transition(.opacity)
                    .accessibilityHidden(true)
            }
            if let id = router.memberID {
                MemberDrawer(memberID: id, width: width, onClose: close)
                    .transition(reduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.25), value: open)
    }

    private func close() { router.memberID = nil }
}

private struct MemberDrawer: View {
    let memberID: String
    let width: CGFloat
    let onClose: () -> Void

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        // Fresh state per member: switching member in place must not show the previous one's activity.
        MemberDetailView(memberID: memberID, onClose: onClose)
            .id(memberID)
            .environment(\.ceInsideGlass, true)
            .frame(width: width)
            .frame(maxHeight: .infinity)
            .clipShape(shape)
            .modifier(DrawerSurface(shape: shape))
            .contentShape(shape)
            .onExitCommand(perform: onClose)
            // Esc also works while the focus sits outside the drawer (the docked composer, nothing at all).
            .background {
                Button("닫기", action: onClose)
                    .keyboardShortcut(.cancelAction)
                    .opacity(0).frame(width: 0, height: 0)
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isModal)
            .padding(10)
    }
}

/// The drawer's surface: the rail's light glass colour, the light glass rim and a soft, wide violet-ink shadow, so it
/// reads as the rail's sibling in the same window. It is a reading panel, so it is opaque on every path: nothing behind
/// it (office cards, the work list, the content column's edge) ever shows through its text. On macOS 26 a white-tinted
/// clear glass sits on the opaque backing only for the glass edge light the rail has; it shades the colour, never reveals.
private struct DrawerSurface<S: InsettableShape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let shape: S

    /// What the empty drawer shows: near-white with a breath of violet (the aurora's top, #FBFAFF), close to the rail's
    /// white glass over the light background. Used as is when there is no glass (before macOS 26, Reduce Transparency).
    static var surface: Color { Color(hex: 0xFBFAFF) }
    /// macOS 26 backing under the glass: a step darker (the background #F7F5FD), since the white-tinted clear glass
    /// lifts what it sits on a little. `.regular` glass is not used: it greys the backing.
    static var glassBacking: Color { CE.bg }

    func body(content: Content) -> some View {
        if #available(macOS 26.0, *), !reduceTransparency {
            content
                .glassEffect(.clear.tint(CE.glassTint.opacity(0.4)), in: shape)
                .background { backing(Self.glassBacking) }
                .overlay { rim }
        } else {
            content
                .background { backing(Self.surface) }
                .overlay { rim }
        }
    }

    /// The shadow belongs to the panel outline only: on the whole drawer every line of text and every button would
    /// cast its own smudge onto the surface.
    private func backing(_ color: Color) -> some View {
        shape.fill(color)
            .shadow(color: CE.shadowNear.opacity(0.06), radius: 1, y: 1)
            .shadow(color: CE.shadowFar.opacity(0.24), radius: 30, y: 12)
    }

    private var rim: some View {
        CardRim(shape: shape)
    }
}

// MARK: - Mac window title and backdrop

/// macOS 15+: the system title leaves the toolbar (the window keeps it for the Window menu), and the custom headline
/// takes its place. macOS 14 keeps the system title and shows the now line as its subtitle.
private struct DeskTitle: ViewModifier {
    let subtitle: String
    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.toolbar(removing: .title)
        } else {
            content.navigationSubtitle(subtitle)
        }
    }
}

/// Web shell stage lights (LocalLight): violet at (60%, 0) min(980, 80%) wide, aspect .42, strength .34; orchid at
/// (66%, 100%) min(860, 70%) wide, aspect .38, strength .28; each a, a × .42 at 45%, 0. On the light background every
/// strength is scaled by .55 (web --light-k). Laid out in window coordinates like the web stage, which spans under the rail.
private struct StageLights: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    /// web --light-k: local lights at 55% on the light background.
    private static let lightK = 0.55
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            if !reduceTransparency {
                ZStack {
                    light(CE.violet, strength: 0.34, width: min(980, w * 0.8), aspect: 0.42)
                        .position(x: w * 0.6, y: 0)
                    light(CE.orchid, strength: 0.28, width: min(860, w * 0.7), aspect: 0.38)
                        .position(x: w * 0.66, y: h)
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func light(_ color: Color, strength: Double, width: CGFloat, aspect: CGFloat) -> some View {
        let a = strength * Self.lightK
        return EllipticalGradient(stops: [
            .init(color: color.opacity(a), location: 0),
            .init(color: color.opacity(a * 0.42), location: 0.45),
            .init(color: color.opacity(0), location: 1),
        ])
        .frame(width: width, height: width * aspect)
    }
}

/// The window's backdrop (aurora + stage lights) drawn at the window's size, shifted so it lines up with the copy
/// behind the rail: the detail column is the window's trailing, bottom-aligned part, so the shift is the size
/// difference. Clipped to the column. Until the window has been measured it falls back to the column's own frame.
private struct WindowAnchoredBackdrop: View {
    let windowSize: CGSize
    var body: some View {
        GeometryReader { geo in
            if windowSize.width > 0, windowSize.height > 0 {
                backdrop
                    .frame(width: windowSize.width, height: windowSize.height)
                    .offset(x: geo.size.width - windowSize.width, y: geo.size.height - windowSize.height)
            } else {
                backdrop
            }
        }
        .ignoresSafeArea()
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var backdrop: some View {
        ZStack {
            AmbientBackground()
            StageLights()
        }
    }
}
#endif

// MARK: - Status strips shared by both platforms

extension View {
    /// Global strips (lost connection, last error; sample mode on iPhone). Attach to every destination root and to
    /// every screen pushed on iPhone, so read-only mode, a lost connection and a failed write stay visible everywhere.
    func ceStatusStrips() -> some View { ceBar(.top) { StatusStrips() } }
}

/// Thin rounded strips inside the content column (web OfflineBand / notice band). On Mac the text stays on one line
/// (full text in the tooltip): wrapped text in a bar outside a scroll view must not size the split view.
struct StatusStrips: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dismissedNotice: String?
    /// Web OfflineBand waits 1.5 s before it shows: a short blip (window back in front, server restart) never
    /// flashes the strip. The composer says at once that it cannot send.
    @State private var offlineShown = false

    private var offline: Bool { store.connectionStatus != .connected && !store.isDemo && store.bootstrap != nil }

    private struct Strip: Identifiable {
        let id: String
        let tone: Tone
        let icon: String
        let text: String
        var detail: String? = nil
        var actionTitle: String? = nil
        var action: (() -> Void)? = nil
    }

    private var strips: [Strip] {
        var items: [Strip] = []
        // Mac shows sample mode in the rail's connection mark and on the composer, so no strip there.
        if store.isDemo && !isMac {
            items.append(Strip(id: "demo", tone: .accent, icon: "eye", text: "샘플 데이터 · 읽기 전용"))
        }
        if offline && offlineShown {
            items.append(Strip(id: "offline", tone: .attention, icon: "wifi.slash", text: "서버와 연결이 끊겼습니다. 다시 잇는 중입니다.",
                               detail: store.connectionIssue, actionTitle: "지금 다시 연결", action: { Task { await store.connect() } }))
        }
        if store.isArchive {
            items.append(Strip(id: "archive", tone: .neutral, icon: "archivebox", text: "보관한 프로젝트 · 읽기 전용",
                               actionTitle: "관리", action: {
                if let id = store.selectedProjectID { router.manageProject(id: id, mode: .restore) }
            }))
        }
        if store.connectionStatus == .connected && !store.isDemo && store.realtimeStatus == .fallback {
            items.append(Strip(id: "fallback", tone: .attention, icon: "arrow.triangle.2.circlepath", text: store.localizedSyncDescription,
                               actionTitle: "지금 다시 연결", action: { Task { await store.connect() } }))
        }
        if let notice = router.navigationNotice ?? store.notificationNotice ?? store.projectNotice, notice != dismissedNotice {
            items.append(Strip(id: "notice", tone: .neutral, icon: "info.circle", text: notice,
                               actionTitle: "닫기", action: { dismissedNotice = notice; router.navigationNotice = nil }))
        }
        if let error = store.errorMessage {
            items.append(Strip(id: "error", tone: .danger, icon: "exclamationmark.circle", text: error,
                               actionTitle: "닫기", action: { store.errorMessage = nil }))
        }
        return items
    }

    var body: some View {
        let items = strips
        // Always present (zero height when empty), so strips slide in and out instead of making the content jump.
        // Padding before the cap: the strips are as wide as the 832pt content column and the docked composer.
        VStack(spacing: 6) {
            ForEach(items) { item in
                strip(item).transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.horizontal, isMac ? 24 : 14)
        .padding(.top, items.isEmpty ? 0 : 4).padding(.bottom, items.isEmpty ? 0 : 6)
        .frame(maxWidth: 880)
        .frame(maxWidth: .infinity)
        .animation(.easeOut(duration: 0.2), value: items.map(\.id))
        .task(id: offline) {
            guard offline else { offlineShown = false; return }
            try? await Task.sleep(for: .milliseconds(1500))
            if !Task.isCancelled { offlineShown = true }
        }
    }

    /// web .offline-band: an opaque white plate (white .92, not glass) tinted by its tone (dot strength .12–.14), readable
    /// over anything passing under it. The connection strips use the web's warm plate (web --warn = CE.attention text
    /// #A8530A on attention-dot .14, an attention-dot .4 ring); the others ink text on their tone's tint.
    private struct Palette {
        let warm: Bool
        let tone: Tone
        var text: Color { warm ? CE.attention : CE.ink }
        var action: Color { warm ? CE.attention : CE.ink }
        var tint: Color { tone.dot.opacity(warm ? 0.14 : 0.12) }
        var ring: Color { tone.dot.opacity(warm ? 0.4 : 0.34) }
        var actionRing: Color { warm ? tone.dot.opacity(0.45) : CE.wash(0.12) }
    }

    private func strip(_ item: Strip) -> some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        let full = item.detail.map { "\(item.text) (\($0))" } ?? item.text
        let palette = Palette(warm: item.tone == .attention, tone: item.tone)
        let hasAction = item.actionTitle != nil && item.action != nil
        return HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: item.icon).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(item.tone.color)
                // web 13.5px at line-height 1.35.
                Text(item.text).font(CEFont.note).foregroundStyle(palette.text)
                    .lineSpacing(CELeading.spacing(13.5, 1.35))
                    .lineLimit(isMac ? 1 : 2).truncationMode(.tail)
            }
            Spacer(minLength: 6)
            if let title = item.actionTitle, let action = item.action {
                Button(title, action: action)
                    .buttonStyle(StripActionStyle(color: palette.action, ring: palette.actionRing))
                    .fixedSize()
            }
        }
        // web: padding 8 8 8 14 around a 32pt button. iPhone: the button's 44pt hit area sets the height.
        .padding(.leading, 14).padding(.trailing, hasAction ? 8 : 14)
        .padding(.vertical, hasAction && !isMac ? 2 : 8)
        .background {
            ZStack {
                shape.fill(Color.white.opacity(0.92))
                shape.fill(palette.tint)
            }
            // web 0 8px 24px −14px rgb(70 46 180 / .25): lifts the plate off the content passing under it.
            .shadow(color: CE.shadowFar.opacity(0.18), radius: 10, y: 8)
        }
        .overlay { shape.strokeBorder(palette.ring) }
        .help(full)
        .accessibilityElement(children: .combine)
    }
}

/// web .offline-band__retry: 32pt capsule, 13/600, white with a thin ring and a small lift; its colour at .06 over the
/// white on hover.
private struct StripActionStyle: ButtonStyle {
    let color: Color
    let ring: Color
    func makeBody(configuration: Configuration) -> some View { StripActionBody(configuration: configuration, color: color, ring: ring) }
    private struct StripActionBody: View {
        let configuration: ButtonStyleConfiguration
        let color: Color
        let ring: Color
        @State private var hovering = false
        var body: some View {
            configuration.label
                .font(isMac ? .system(size: 13, weight: .semibold) : CEFont.secondary.weight(.semibold))
                .foregroundStyle(color)
                .lineLimit(1)
                .padding(.horizontal, 12).frame(height: 32)
                .background {
                    Capsule().fill(Color.white)
                        .overlay { Capsule().fill(color.opacity(configuration.isPressed ? 0.1 : hovering ? 0.06 : 0)) }
                        // web --lift: 0 6px 14px −8px rgb(40 24 110 / .3)
                        .shadow(color: CE.shadowNear.opacity(0.14), radius: 4, y: 3)
                }
                .overlay { Capsule().strokeBorder(ring) }
                .animation(.linear(duration: 0.12), value: hovering)
                .frame(minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

// MARK: - iPhone composer dock

#if os(iOS)
/// iPhone: one composer above the tab bar on 홈 · 결재함 · 팀 · 자료, the same panel 대화 shows under its chips. Tapping it
/// types in place: the keyboard comes up and the panel rides on top of it (no separate sheet).
private struct PhoneComposerDock: ViewModifier {
    @Environment(AppStore.self) private var store
    let tab: Destination
    func body(content: Content) -> some View {
        if tab == .chat || store.isArchive {
            content
        } else {
            content.ceBar(.bottom) { PhoneDockedComposer(tab: tab) }
        }
    }
}

private struct PhoneDockedComposer: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    let tab: Destination

    /// A worker's page on 팀 addresses that worker (the lead's page, the lead); elsewhere the shared chat target.
    private var pinned: String?? {
        guard tab == .team, let id = router.memberID, let member = store.members.first(where: { $0.id == id }) else { return nil }
        return .some(member.kind == "worker" ? member.id : nil)
    }

    var body: some View {
        let pinned = pinned
        let target = Binding<String?>(get: { pinned ?? router.chatTarget }, set: { router.chatTarget = $0 })
        ComposerBar(target: target, showsTargetPicker: false, targetPickerOnFocus: pinned == nil, namesLead: true,
                    respondsToFocusRequests: router.destination == tab,
                    onOpenChat: { router.go(.chat) })
            .padding(.horizontal, CESpace.m).padding(.top, 6).padding(.bottom, CESpace.s)
            .background { ComposerFloor() }
    }
}

/// The light floor under the phone composer (web --band, the background at .9): content fades out above the panel
/// and the floor runs on under the tab bar to the bottom edge, so the composer and the tab bar sit on one surface
/// (no band that stops at the panel's edge).
struct ComposerFloor: View {
    var body: some View {
        LinearGradient(stops: [
            .init(color: CE.bg.opacity(0), location: 0),
            .init(color: CE.bg.opacity(0.82), location: 0.42),
            .init(color: CE.bg.opacity(0.9), location: 1),
        ], startPoint: .top, endPoint: .bottom)
        .padding(.top, -18)
        .ignoresSafeArea(edges: .bottom)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
#endif

extension AppStore {
    /// Writes need a live connection and a healthy project runner connection. In-flight requests are not a global
    /// lock: each control checks its own `pendingActions` key (mutate() already de-duplicates per key), so a
    /// 150 s member respawn never blocks instructions to everyone else.
    var uiCanWrite: Bool { canWrite && state?.project.connection.ok == true }

    var localizedSyncDescription: String {
        if isDemo { return "샘플 데이터 · 읽기 전용" }
        switch realtimeStatus {
        case .paused: return "앱이 비활성 상태여서 동기화를 쉬고 있습니다"
        case .connecting: return "실시간 연결 중…"
        case .syncing: return "최신 상태를 불러오는 중…"
        case .live: return "실시간으로 연결됨"
        case .legacy: return "연결됨 · 이전 방식으로 변경 확인"
        case .fallback: return "실시간 연결이 끊겨 주기적으로 확인하고 있습니다"
        case .blocked: return "서버 주소나 접근 허용 설정을 확인해 주세요"
        }
    }

    /// Rank name of the member who receives messages with no explicit target (총괄, or 본사 AI on HQ).
    var leadRankName: String { members.first { $0.kind == "conductor" || $0.kind == "root" }.map { rankName($0.kind) } ?? "총괄" }

    /// Destination badges always equal a number visible on that destination (same rule as the web tabs):
    /// 결재함 = open decisions + members at an approval prompt (both listed there); 홈 = open todos (its 할 일 counter).
    func navBadge(for tab: Destination) -> Int {
        if isArchive { return 0 }
        return switch tab {
        case .inbox: decisions.filter { $0.status == "open" }.count + members.filter { $0.status == "blocked" }.count
        case .home: todos.filter { !$0.done }.count
        default: 0
        }
    }

    func navBadgeHelp(for tab: Destination) -> String? {
        switch tab {
        case .inbox:
            let open = decisions.filter { $0.status == "open" }.count
            let blocked = members.filter { $0.status == "blocked" }.count
            guard open + blocked > 0 else { return nil }
            return [open > 0 ? "결재 \(open)건" : nil, blocked > 0 ? "승인 창 앞 \(blocked)명" : nil].compactMap { $0 }.joined(separator: " · ")
        case .home:
            let todos = todos.filter { !$0.done }.count
            return todos > 0 ? "내 할 일 \(todos)건" : nil
        default: return nil
        }
    }
}

/// Puts a fixed layout (대화, 자료) inside a scroll view that exactly fits, so the toolbar treats it like a scrolled
/// page (홈): no solid toolbar band. Nothing scrolls; the panes keep their own scroll views.
private struct ScrollPocketUnderToolbar: ViewModifier {
    let enabled: Bool
    func body(content: Content) -> some View {
        #if os(macOS)
        if enabled {
            GeometryReader { geo in
                ScrollView(.vertical) {
                    content.frame(width: geo.size.width, height: geo.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollIndicators(.never)
            }
        } else {
            content
        }
        #else
        content
        #endif
    }
}
