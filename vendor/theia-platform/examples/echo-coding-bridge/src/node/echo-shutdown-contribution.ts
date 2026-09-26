import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import * as express from '@theia/core/shared/express';

/** Host-only shutdown: browsers cannot authorize it with a cookie or a form. */
@injectable()
export class EchoShutdownContribution implements BackendApplicationContribution {
    configure(app: express.Application): void {
        app.post('/__echo_shutdown', (request, response) => {
            const expected = process.env.ECHO_THEIA_EMBED_TOKEN;
            if (!expected || request.headers['x-echo-shutdown-token'] !== expected) {
                response.sendStatus(403);
                return;
            }
            response.sendStatus(202);
            setImmediate(() => process.emit('SIGTERM', 'SIGTERM'));
        });
    }
}
