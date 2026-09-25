import { injectable } from '@theia/core/shared/inversify';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { echoHostBridge } from './echo-host-bridge';

/**
 * Keep Theia's file tree and editor, while letting EchoAgent's task orchestrator
 * approve a mutation before it reaches disk and reconcile its change set after.
 */
@injectable()
export class EchoFileService extends FileService {
    private async mutate<T>(operation: string, paths: string[], run: () => Promise<T>): Promise<T> {
        if (!echoHostBridge.enabled || !paths.some(Boolean)) {
            return run();
        }
        const ticket = await echoHostBridge.request('echo/before-mutation', { operation, paths });
        let result: T;
        try {
            result = await run();
        } catch (error) {
            await echoHostBridge.request('echo/after-mutation', {
                ticket,
                success: false,
                error: String(error),
            }).catch(() => undefined);
            throw error;
        }
        // The disk write already succeeded. Reporting a sync failure as a save
        // failure makes Resource.save retry the same edit through writeFile.
        await echoHostBridge.request('echo/after-mutation', { ticket, success: true })
            .catch(error => console.warn('EchoAgent could not reconcile the saved file:', error));
        return result;
    }

    override async writeFile(...args: Parameters<FileService['writeFile']>): Promise<Awaited<ReturnType<FileService['writeFile']>>> {
        return this.mutate('write', [args[0].path.fsPath()], () => super.writeFile(...args));
    }

    // Monaco normally saves small edits through FileService.update, which goes
    // straight to provider.updateFile instead of calling writeFile.
    override async update(...args: Parameters<FileService['update']>): Promise<Awaited<ReturnType<FileService['update']>>> {
        return this.mutate('write', [args[0].path.fsPath()], () => super.update(...args));
    }

    override async createFolder(...args: Parameters<FileService['createFolder']>): Promise<Awaited<ReturnType<FileService['createFolder']>>> {
        return this.mutate('createFolder', [args[0].path.fsPath()], () => super.createFolder(...args));
    }

    override async move(...args: Parameters<FileService['move']>): Promise<Awaited<ReturnType<FileService['move']>>> {
        return this.mutate('move', [args[0].path.fsPath(), args[1].path.fsPath()], () => super.move(...args));
    }

    override async copy(...args: Parameters<FileService['copy']>): Promise<Awaited<ReturnType<FileService['copy']>>> {
        return this.mutate('copy', [args[0].path.fsPath(), args[1].path.fsPath()], () => super.copy(...args));
    }

    override async delete(...args: Parameters<FileService['delete']>): Promise<Awaited<ReturnType<FileService['delete']>>> {
        return this.mutate('delete', [args[0].path.fsPath()], () => super.delete(...args));
    }
}
