import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { EchoFileService } from './echo-file-service';
import { EchoFrontendContribution } from './echo-frontend-contribution';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    rebind(FileService).to(EchoFileService).inSingletonScope();
    bind(EchoFrontendContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(EchoFrontendContribution);
});
