"use strict";

const RETRY_AFTER = 5000;

// A server that cannot take its port (the run before an update is still shutting down, or another app holds it
// for a moment) used to end the whole service with an uncaught error. This waits and tries again on the same
// server, so the handlers already attached to it stay in place.
function keepListening(label, server, listen) {
    let listening = false;

    server.on('listening', () => {
        listening = true;
        console.log(`${label}: listening`);
    });

    server.on('error', (error) => {
        // An error once the port is ours is not a reason to start listening a second time.
        if (listening) return;

        console.error(`${label}: cannot listen (${error.code || error.message}); trying again in ${RETRY_AFTER / 1000}s`);
        setTimeout(() => listen(server), RETRY_AFTER);
    });

    listen(server);
    return server;
}

module.exports = keepListening;
