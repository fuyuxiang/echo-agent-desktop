import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { MAIN_MENU_BAR } from '@theia/core/lib/common/menu';
import { CorePreferences } from '@theia/core/lib/common/core-preferences';
import { CommonCommands } from '@theia/core/lib/browser/common-commands';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { Saveable } from '@theia/core/lib/browser/saveable';
import { Disposable } from '@theia/core/lib/common/disposable';
import { echoHostBridge } from './echo-host-bridge';

const AGENT_DOCK_WIDTH_KEY = 'echo-agent-dock-width';

class EchoAgentDock extends Widget {
    protected override onActivateRequest(): void {
        this.node.focus();
    }
}

@injectable()
export class EchoFrontendContribution implements FrontendApplicationContribution {
    protected emptyState?: HTMLElement;
    protected agentDock?: Widget;
    protected agentDockObserver?: ResizeObserver;
    protected agentDockMutationObserver?: MutationObserver;
    protected agentBoundsFrame = 0;
    protected lastAgentBounds = '';
    protected shell?: FrontendApplication['shell'];
    protected readonly dirtySubscriptions = new Map<Widget, Disposable>();
    @inject(EditorManager)
    protected readonly editors: EditorManager;
    @inject(CommandRegistry)
    protected readonly commands: CommandRegistry;
    @inject(FrontendApplicationStateService)
    protected readonly applicationState: FrontendApplicationStateService;
    @inject(WorkspaceService)
    protected readonly workspace: WorkspaceService;
    @inject(ThemeService)
    protected readonly themes: ThemeService;
    @inject(CorePreferences)
    protected readonly corePreferences: CorePreferences;
    onStart(): void {
        if (echoHostBridge.enabled) {
            document.body.classList.add('echo-embedded');
        }
        window.addEventListener('message', event => {
            if (!echoHostBridge.isTrusted(event)) {
                return;
            }
            const message = event.data as Record<string, unknown>;
            if (message.type === 'echo/open-file' && typeof message.path === 'string') {
                const line = typeof message.line === 'number' && Number.isSafeInteger(message.line) && message.line > 0
                    ? message.line - 1 : undefined;
                void this.editors.open(FileUri.create(message.path), line === undefined ? undefined : {
                    selection: { start: { line, character: 0 }, end: { line, character: 0 } },
                });
            } else if (message.type === 'echo/open-preview' && typeof message.url === 'string') {
                void this.commands.executeCommand('mini-browser.openUrl', message.url);
            } else if (message.type === 'echo/set-theme' && (message.theme === 'light' || message.theme === 'dark')) {
                this.themes.setCurrentTheme(message.theme, false);
            } else if (message.type === 'echo/set-agent-visible' && typeof message.visible === 'boolean' && this.shell) {
                if (message.visible) {
                    this.shell.expandPanel('right');
                } else {
                    this.shell.collapsePanel('right');
                }
                this.scheduleAgentBounds();
            } else if (message.type === 'echo/request-agent-bounds') {
                this.scheduleAgentBounds();
            } else if (message.type === 'echo/save-all' && typeof message.id === 'string' && this.shell) {
                void this.shell.saveAll().then(() => {
                    this.reportDirtyState();
                    echoHostBridge.notify('echo/response', { id: message.id, ok: true, value: this.dirtyCount() });
                }).catch(error => {
                    echoHostBridge.notify('echo/response', { id: message.id, ok: false, error: String(error) });
                });
            } else if (message.type === 'echo/get-dirty' && typeof message.id === 'string') {
                echoHostBridge.notify('echo/response', { id: message.id, ok: true, value: this.dirtyCount() });
            }
        });
        this.editors.onActiveEditorChanged(editor => {
            echoHostBridge.notify('echo/active-file', {
                path: editor?.editor.uri.path.fsPath() ?? null,
            });
            window.requestAnimationFrame(() => this.updateEmptyState());
        });
        void this.applicationState.reachedState('ready').then(async () => {
            echoHostBridge.notify('echo/ready');
            this.reportDirtyState();
            const reportWorkspace = async () => {
                const roots = await this.workspace.roots;
                echoHostBridge.notify('echo/workspace', {
                    path: roots.length === 1 ? roots[0].resource.path.fsPath() : null,
                });
            };
            this.workspace.onWorkspaceChanged(() => void reportWorkspace());
            await reportWorkspace();
        });
    }

    async onDidInitializeLayout(app: FrontendApplication): Promise<void> {
        if (echoHostBridge.enabled) {
            this.shell = app.shell;
            for (const widget of app.shell.widgets) {
                this.watchDirtyWidget(widget);
            }
            app.shell.onDidAddWidget(widget => {
                this.watchDirtyWidget(widget);
                this.reportDirtyState();
            });
            app.shell.onDidRemoveWidget(widget => {
                this.dirtySubscriptions.get(widget)?.dispose();
                this.dirtySubscriptions.delete(widget);
                this.reportDirtyState();
            });
            const agentDock = new EchoAgentDock();
            agentDock.id = 'echo-agent-dock';
            agentDock.title.label = 'Echo Agent';
            agentDock.title.caption = 'Echo Agent';
            agentDock.title.iconClass = 'codicon codicon-sparkle';
            agentDock.node.classList.add('echo-agent-dock');
            agentDock.node.tabIndex = -1;
            this.agentDock = agentDock;
            await app.shell.addWidget(agentDock, { area: 'right' });
            app.shell.expandPanel('right');
            let savedWidth = 410;
            try {
                const value = Number(window.localStorage.getItem(AGENT_DOCK_WIDTH_KEY));
                if (value >= 300 && value <= 800) {
                    savedWidth = value;
                }
            } catch {
                // The panel remains usable when browser storage is unavailable.
            }
            app.shell.resize(savedWidth, 'right');
            const rightPanel = app.shell.rightPanelHandler.container.node;
            this.agentDockObserver = new ResizeObserver(() => this.scheduleAgentBounds());
            this.agentDockObserver.observe(agentDock.node);
            this.agentDockObserver.observe(rightPanel);
            this.agentDockMutationObserver = new MutationObserver(() => this.scheduleAgentBounds());
            this.agentDockMutationObserver.observe(rightPanel, {
                attributes: true, attributeFilter: ['class', 'style'], subtree: true,
            });
            window.addEventListener('resize', () => this.scheduleAgentBounds());
            this.scheduleAgentBounds();
            await this.commands.executeCommand('workbench.files.action.focusFilesExplorer');
            await this.corePreferences.ready;
            if (this.corePreferences['window.menuBarVisibility'] === 'compact') {
                app.shell.leftPanelHandler.addTopMenu({
                    id: 'main-menu',
                    iconClass: 'theia-compact-menu codicon codicon-menu',
                    title: '应用菜单',
                    menuPath: MAIN_MENU_BAR,
                    order: 0,
                });
            }
            // The editor's empty hint lives behind the document area. It does
            // not create a second Welcome tab or compete with the Agent pane.
            for (const widget of app.shell.getWidgets('main')) {
                if (widget.id === 'getting.started.widget' || widget.id === 'echo-code-start') {
                    widget.close();
                }
            }
            const emptyState = document.createElement('div');
            emptyState.className = 'echo-editor-empty';
            emptyState.innerHTML = `<div class="echo-editor-empty__content">
                <span class="codicon codicon-file-code" aria-hidden="true"></span>
                <strong>打开文件开始编辑</strong>
                <span>从资源管理器选择文件，或使用 Ctrl/⌘ + P 快速打开</span>
                <button type="button">新建文件</button>
            </div>`;
            emptyState.querySelector('button')?.addEventListener('click', () => {
                void this.commands.executeCommand(CommonCommands.NEW_UNTITLED_TEXT_FILE.id);
            });
            app.shell.mainPanel.node.appendChild(emptyState);
            this.emptyState = emptyState;
            app.shell.onDidAddWidget(() => window.requestAnimationFrame(() => this.updateEmptyState()));
            app.shell.onDidRemoveWidget(() => window.requestAnimationFrame(() => this.updateEmptyState()));
            this.updateEmptyState();
            await app.shell.revealWidget(agentDock.id);
            this.scheduleAgentBounds();
        }
    }

    protected updateEmptyState(): void {
        if (this.emptyState && this.shell) {
            this.emptyState.hidden = this.shell.getWidgets('main').length > 0;
        }
    }

    protected watchDirtyWidget(widget: Widget): void {
        if (this.dirtySubscriptions.has(widget)) {
            return;
        }
        const saveable = Saveable.get(widget);
        if (saveable) {
            this.dirtySubscriptions.set(widget, saveable.onDirtyChanged(() => this.reportDirtyState()));
        }
    }

    protected dirtyCount(): number {
        return this.shell?.widgets.filter(widget => Saveable.isDirty(widget)).length ?? 0;
    }

    protected reportDirtyState(): void {
        echoHostBridge.notify('echo/dirty-state', { count: this.dirtyCount() });
    }

    protected scheduleAgentBounds(): void {
        if (this.agentBoundsFrame) {
            return;
        }
        this.agentBoundsFrame = window.requestAnimationFrame(() => {
            this.agentBoundsFrame = 0;
            const dock = this.agentDock;
            const rect = dock?.node.getBoundingClientRect();
            const bounds = dock?.isVisible && rect && rect.width > 40 && rect.height > 40
                ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
                : null;
            const serialized = JSON.stringify(bounds);
            if (serialized !== this.lastAgentBounds) {
                this.lastAgentBounds = serialized;
                echoHostBridge.notify('echo/agent-bounds', { bounds });
                if (bounds && bounds.width >= 300 && bounds.width <= 800) {
                    try {
                        window.localStorage.setItem(AGENT_DOCK_WIDTH_KEY, String(Math.round(bounds.width)));
                    } catch {
                        // Keep resizing available even if layout storage is disabled.
                    }
                }
            }
        });
    }
}
