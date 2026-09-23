import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { echoHostBridge } from './echo-host-bridge';

@injectable()
export class EchoFrontendContribution implements FrontendApplicationContribution {
    @inject(EditorManager)
    protected readonly editors: EditorManager;
    @inject(CommandRegistry)
    protected readonly commands: CommandRegistry;
    @inject(FrontendApplicationStateService)
    protected readonly applicationState: FrontendApplicationStateService;
    @inject(WorkspaceService)
    protected readonly workspace: WorkspaceService;

    onStart(): void {
        window.addEventListener('message', event => {
            if (!echoHostBridge.isTrusted(event)) {
                return;
            }
            const message = event.data as Record<string, unknown>;
            if (message.type === 'echo/open-file' && typeof message.path === 'string') {
                void this.editors.open(FileUri.create(message.path));
            } else if (message.type === 'echo/open-preview' && typeof message.url === 'string') {
                void this.commands.executeCommand('mini-browser.openUrl', message.url);
            }
        });
        this.editors.onActiveEditorChanged(editor => {
            echoHostBridge.notify('echo/active-file', {
                path: editor?.editor.uri.path.fsPath() ?? null,
            });
        });
        void this.applicationState.reachedState('ready').then(async () => {
            echoHostBridge.notify('echo/ready');
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

    async onDidInitializeLayout(): Promise<void> {
        if (echoHostBridge.enabled) {
            await this.commands.executeCommand('workbench.files.action.focusFilesExplorer');
        }
    }
}
