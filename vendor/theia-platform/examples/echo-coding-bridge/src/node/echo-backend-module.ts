import { ContainerModule } from '@theia/core/shared/inversify';
import { LocalizationContribution } from '@theia/core/lib/node/i18n/localization-contribution';
import { EchoChineseLocalizationContribution } from './echo-chinese-localization-contribution';

export default new ContainerModule(bind => {
    bind(EchoChineseLocalizationContribution).toSelf().inSingletonScope();
    bind(LocalizationContribution).toService(EchoChineseLocalizationContribution);
});
