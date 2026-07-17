// Sentry initialization. This file is imported FIRST in server.mjs (before
// express/http) because Sentry v8+ relies on OpenTelemetry auto-instrumentation
// that must be set up before the instrumented modules load. Dormant (no-op)
// until SENTRY_DSN is set.
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: 0,
        sendDefaultPii: false,
        beforeSend(event) {
            if (event.request) {
                delete event.request.cookies;
                delete event.request.data;
                delete event.request.headers?.authorization;
                delete event.request.headers?.cookie;
                delete event.request.headers?.['set-cookie'];
            }
            delete event.user;
            return event;
        },
    });
}
