import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { injectable } from '@theia/core/shared/inversify';
import { Localization } from '@theia/core/lib/common/i18n/localization';
import { LocalizationContribution, LocalizationRegistry } from '@theia/core/lib/node/i18n/localization-contribution';

interface LanguagePack {
    contents: Record<string, Record<string, string>>;
}

/** Ship the open-source VS Code translations with the IDE so Chinese works offline. */
@injectable()
export class EchoChineseLocalizationContribution implements LocalizationContribution {
    registerLocalizations(registry: LocalizationRegistry): Promise<void> {
        // Theia bundles this backend module into the browser application's
        // lib/backend/main.js, so __dirname resolves there at runtime.
        const path = join(__dirname, '../../examples/echo-coding-bridge/i18n/main.i18n.json');
        const pack = JSON.parse(readFileSync(path, 'utf8')) as LanguagePack;
        const translations: Record<string, string> = {};
        for (const [scope, entries] of Object.entries(pack.contents)) {
            for (const [key, value] of Object.entries(entries)) {
                translations[`vscode/${Localization.transformKey(scope)}/${key}`] = value;
            }
        }
        registry.registerLocalization({
            languageId: 'zh-cn',
            languageName: 'Chinese Simplified',
            localizedLanguageName: '简体中文',
            languagePack: true,
            translations,
        });
        return Promise.resolve();
    }
}
