import { ContainerModule } from '@theia/core/shared/inversify';
import { LocalizationContribution } from '@theia/core/lib/node/i18n/localization-contribution';
import { EchoChineseLocalizationContribution } from './echo-chinese-localization-contribution';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { EchoShutdownContribution } from './echo-shutdown-contribution';

export default new ContainerModule(bind => {
    bind(EchoShutdownContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(EchoShutdownContribution);
    bind(EchoChineseLocalizationContribution).toSelf().inSingletonScope();
    bind(LocalizationContribution).toService(EchoChineseLocalizationContribution);
});
